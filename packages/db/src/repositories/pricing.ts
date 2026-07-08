import { BaseRepository } from './base.js';
import { ulid } from 'ulid';
import type { ExpressionBuilder } from 'kysely';
import type { DB } from '../types/db.js';

function normalizeDiscountCode(code: string): string {
  return code.trim().toUpperCase();
}

export type DiscountReservationResult =
  | { ok: true; discountCodeId: string; existing: boolean }
  | { ok: false; errorCode: 'DISCOUNT_INVALID' | 'DISCOUNT_EXHAUSTED'; message: string };

export class DiscountCodeRepository extends BaseRepository {
  async create(input: {
    eventId: string;
    code: string;
    type: string;
    value: number;
    currency: string;
    maxUses: number;
    validFrom?: Date;
    validUntil?: Date;
    minOrderCents?: number;
    maxDiscountCents?: number;
    ticketTypeIds?: string[];
  }) {
    const id = `dc_${ulid()}`;
    const now = new Date();
    return this.insertReturning(
      'discount_codes',
      {
        id,
        event_id: input.eventId,
        code: normalizeDiscountCode(input.code),
        type: input.type,
        value: input.value,
        currency: input.currency,
        max_uses: input.maxUses,
        uses_count: 0,
        valid_from: input.validFrom ?? null,
        valid_until: input.validUntil ?? null,
        min_order_cents: input.minOrderCents ?? null,
        max_discount_cents: input.maxDiscountCents ?? null,
        ticket_type_ids: input.ticketTypeIds ? JSON.stringify(input.ticketTypeIds) : null,
        status: 'active',
        created_at: now,
        updated_at: now,
      },
      id,
    );
  }

  async findByEventAndCode(eventId: string, code: string) {
    return this.db
      .selectFrom('discount_codes')
      .selectAll()
      .where('event_id', '=', eventId)
      .where('code', '=', normalizeDiscountCode(code))
      .executeTakeFirst();
  }

  async findByEvent(eventId: string) {
    return this.db
      .selectFrom('discount_codes')
      .selectAll()
      .where('event_id', '=', eventId)
      .execute();
  }

  async incrementUses(id: string) {
    return this.updateReturning(
      'discount_codes',
      id,
      (eb: ExpressionBuilder<DB, 'discount_codes'>) => ({
        uses_count: eb('uses_count', '+', 1),
        updated_at: new Date(),
      }),
    );
  }

  async reserveForCheckout(input: {
    eventId: string;
    tenantId: string;
    checkoutSessionId: string;
    code: string;
    now?: Date;
  }): Promise<DiscountReservationResult> {
    return this.db.transaction().execute(async (trx): Promise<DiscountReservationResult> => {
      const existingRedemption = await trx
        .selectFrom('discount_redemptions')
        .select(['id', 'discount_code_id'])
        .where('checkout_session_id', '=', input.checkoutSessionId)
        .executeTakeFirst();
      if (existingRedemption) {
        return { ok: true, discountCodeId: existingRedemption.discount_code_id, existing: true };
      }

      const canonicalCode = normalizeDiscountCode(input.code);
      const eventDiscounts = await trx
        .selectFrom('discount_codes')
        .selectAll()
        .where('event_id', '=', input.eventId)
        .forUpdate()
        .execute();
      const matchingDiscounts = eventDiscounts.filter(
        (discount) => normalizeDiscountCode(String(discount.code)) === canonicalCode,
      );

      if (matchingDiscounts.length === 0) {
        return {
          ok: false,
          errorCode: 'DISCOUNT_INVALID',
          message: `Discount code ${input.code} not found`,
        };
      }
      if (matchingDiscounts.length > 1) {
        return {
          ok: false,
          errorCode: 'DISCOUNT_INVALID',
          message: `Discount code ${input.code} is not unique`,
        };
      }

      const discount = matchingDiscounts[0]!;
      const now = input.now ?? new Date();
      if (discount.status !== 'active') {
        return {
          ok: false,
          errorCode: 'DISCOUNT_INVALID',
          message: `Discount code ${input.code} status is ${discount.status}`,
        };
      }
      if (discount.valid_from && new Date(discount.valid_from) > now) {
        return {
          ok: false,
          errorCode: 'DISCOUNT_INVALID',
          message: `Discount code ${input.code} not yet valid`,
        };
      }
      if (discount.valid_until && new Date(discount.valid_until) < now) {
        return {
          ok: false,
          errorCode: 'DISCOUNT_INVALID',
          message: `Discount code ${input.code} expired`,
        };
      }
      if (Number(discount.uses_count) >= Number(discount.max_uses)) {
        return {
          ok: false,
          errorCode: 'DISCOUNT_EXHAUSTED',
          message: `Discount code ${input.code} max uses reached`,
        };
      }

      const redemptionId = `dred_${ulid()}`;
      try {
        await trx
          .insertInto('discount_redemptions')
          .values({
            id: redemptionId,
            discount_code_id: discount.id,
            event_id: input.eventId,
            checkout_session_id: input.checkoutSessionId,
            order_id: null,
            tenant_id: input.tenantId,
            created_at: now,
          })
          .execute();
      } catch (err) {
        if (!isUniqueConstraintError(err)) throw err;
        const existing = await trx
          .selectFrom('discount_redemptions')
          .select(['discount_code_id'])
          .where('checkout_session_id', '=', input.checkoutSessionId)
          .executeTakeFirst();
        if (!existing) throw err;
        return { ok: true, discountCodeId: existing.discount_code_id, existing: true };
      }

      const update = await trx
        .updateTable('discount_codes')
        .set((eb) => ({
          uses_count: eb('uses_count', '+', 1),
          updated_at: now,
        }))
        .where('id', '=', discount.id)
        .where('uses_count', '<', Number(discount.max_uses))
        .executeTakeFirst();
      if (Number(update.numUpdatedRows ?? 0) !== 1) {
        await trx.deleteFrom('discount_redemptions').where('id', '=', redemptionId).execute();
        return {
          ok: false,
          errorCode: 'DISCOUNT_EXHAUSTED',
          message: `Discount code ${input.code} max uses reached`,
        };
      }

      return { ok: true, discountCodeId: discount.id, existing: false };
    });
  }

  async releasePendingCheckoutReservation(
    checkoutSessionId: string,
  ): Promise<{ released: boolean }> {
    return this.db.transaction().execute(async (trx) => {
      const redemption = await trx
        .selectFrom('discount_redemptions')
        .select(['id', 'discount_code_id'])
        .where('checkout_session_id', '=', checkoutSessionId)
        .where('order_id', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!redemption) return { released: false };

      await trx.deleteFrom('discount_redemptions').where('id', '=', redemption.id).execute();
      await trx
        .updateTable('discount_codes')
        .set((eb) => ({
          uses_count: eb('uses_count', '-', 1),
          updated_at: new Date(),
        }))
        .where('id', '=', redemption.discount_code_id)
        .where('uses_count', '>', 0)
        .execute();

      return { released: true };
    });
  }
}

function isUniqueConstraintError(err: unknown): boolean {
  const error = err as { code?: unknown; errno?: unknown; number?: unknown };
  return (
    error.code === '23505' ||
    error.code === 'ER_DUP_ENTRY' ||
    error.code === 'SQLITE_CONSTRAINT' ||
    error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
    error.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    error.errno === 1062 ||
    error.number === 2601 ||
    error.number === 2627
  );
}

export class TaxRuleRepository extends BaseRepository {
  async create(input: {
    eventId: string;
    name: string;
    rate: number;
    type: string;
    appliedTo: string;
    countries?: string[];
    regions?: string[];
  }) {
    const id = `tax_${ulid()}`;
    const now = new Date();
    return this.insertReturning(
      'tax_rules',
      {
        id,
        event_id: input.eventId,
        name: input.name,
        rate: input.rate,
        type: input.type,
        applied_to: input.appliedTo,
        countries: input.countries ? JSON.stringify(input.countries) : null,
        regions: input.regions ? JSON.stringify(input.regions) : null,
        created_at: now,
        updated_at: now,
      },
      id,
    );
  }

  async findByEvent(eventId: string) {
    return this.db.selectFrom('tax_rules').selectAll().where('event_id', '=', eventId).execute();
  }
}

export class FeeRuleRepository extends BaseRepository {
  async replaceForEvent(
    eventId: string,
    rules: Array<{
      name: string;
      type: string;
      value: number;
      appliedTo: string;
      absorbIntoPrice?: boolean;
    }>,
  ) {
    await this.db.deleteFrom('fee_rules').where('event_id', '=', eventId).execute();
    if (rules.length === 0) return [];

    const now = new Date();
    await this.db
      .insertInto('fee_rules')
      .values(
        rules.map((rule) => ({
          id: `fee_${ulid()}`,
          event_id: eventId,
          name: rule.name,
          type: rule.type,
          value: rule.value,
          applied_to: rule.appliedTo,
          absorb_into_price: rule.absorbIntoPrice ?? false,
          created_at: now,
          updated_at: now,
        })),
      )
      .execute();

    return this.findByEvent(eventId);
  }

  async create(input: {
    eventId: string;
    name: string;
    type: string;
    value: number;
    appliedTo: string;
    absorbIntoPrice?: boolean;
  }) {
    const id = `fee_${ulid()}`;
    const now = new Date();
    return this.insertReturning(
      'fee_rules',
      {
        id,
        event_id: input.eventId,
        name: input.name,
        type: input.type,
        value: input.value,
        applied_to: input.appliedTo,
        absorb_into_price: input.absorbIntoPrice ?? false,
        created_at: now,
        updated_at: now,
      },
      id,
    );
  }

  async findByEvent(eventId: string) {
    return this.db.selectFrom('fee_rules').selectAll().where('event_id', '=', eventId).execute();
  }
}
