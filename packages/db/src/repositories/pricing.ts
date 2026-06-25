import { BaseRepository } from './base.js';
import { ulid } from 'ulid';
import type { ExpressionBuilder } from 'kysely';
import type { DB } from '../types/db.js';

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
        code: input.code,
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
      .where('code', '=', code.toUpperCase())
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
