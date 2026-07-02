import { createHash, randomBytes } from 'node:crypto';
import { createDb, EmailJobRepository } from '@tixkit/db';
import type { WorkflowActivityResult } from '../shared/types.js';
import { okResult, errResult } from '../shared/types.js';

const CHECKOUT_BASE_URL =
  process.env.CHECKOUT_URL ?? process.env.NEXT_PUBLIC_CHECKOUT_URL ?? 'https://checkout.tixkit.com';

function hashWaitlistClaimToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function waitlistClaimUrl(token: string): string {
  const url = new URL('/checkout', CHECKOUT_BASE_URL);
  url.searchParams.set('claimToken', token);
  return url.toString();
}

function parseStoredJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export async function expireStaleHoldsActivity(): Promise<
  WorkflowActivityResult<{ expiredCount: number }>
> {
  const db = createDb();
  try {
    const result = await db
      .updateTable('checkout_holds')
      .set({ status: 'expired', updated_at: new Date() })
      .where('status', '=', 'active')
      .where('expires_at', '<', new Date())
      .execute();
    return okResult({
      expiredCount: Number(
        (result[0] as { numUpdatedRows?: bigint } | undefined)?.numUpdatedRows ?? 0,
      ),
    });
  } catch (err) {
    return errResult(
      'EXPIRE_HOLDS_FAILED',
      err instanceof Error ? err.message : 'Unknown error',
      true,
    );
  } finally {
    await db.destroy();
  }
}

export async function expireStaleSessionsActivity(): Promise<
  WorkflowActivityResult<{ expiredCount: number }>
> {
  const db = createDb();
  try {
    const now = new Date();
    const expiredSessions = await db
      .selectFrom('checkout_sessions')
      .select(['id', 'tenant_id', 'cart'])
      .where('status', '=', 'open')
      .where('expires_at', '<', now)
      .where('payment_intent_id', 'is', null)
      .execute();

    const result = await db.transaction().execute(async (trx) => {
      for (const session of expiredSessions) {
        const cart = parseStoredJson<{ waitlistEntryId?: string }>(session.cart, {});
        if (!cart.waitlistEntryId) continue;
        // eslint-disable-next-line no-await-in-loop -- each reservation release is tied to the expired session row.
        await trx
          .updateTable('waitlist_entries')
          .set({
            status: 'offered',
            reserved_checkout_session_id: null,
            reserved_until: null,
            updated_at: now,
          })
          .where('id', '=', cart.waitlistEntryId)
          .where('tenant_id', '=', session.tenant_id)
          .where('reserved_checkout_session_id', '=', session.id)
          .where('status', '=', 'reserved')
          .execute();
      }

      return trx
        .updateTable('checkout_sessions')
        .set({ status: 'expired', updated_at: now })
        .where('status', '=', 'open')
        .where('expires_at', '<', now)
        .where('payment_intent_id', 'is', null)
        .execute();
    });
    return okResult({
      expiredCount: Number(
        (result[0] as { numUpdatedRows?: bigint } | undefined)?.numUpdatedRows ?? 0,
      ),
    });
  } catch (err) {
    return errResult(
      'EXPIRE_SESSIONS_FAILED',
      err instanceof Error ? err.message : 'Unknown error',
      true,
    );
  } finally {
    await db.destroy();
  }
}

export async function processWaitlistOffersActivity(): Promise<
  WorkflowActivityResult<{
    expiredCount: number;
    offeredCount: number;
    queuedEmailCount: number;
  }>
> {
  const db = createDb();
  try {
    const now = new Date();
    const expired = await db
      .updateTable('waitlist_entries')
      .set({ status: 'expired', updated_at: now })
      .where('status', '=', 'offered')
      .where('offer_expires_at', '<=', now)
      .execute();

    const candidates = await db
      .selectFrom('waitlist_entries as entry')
      .innerJoin('ticket_types as ticket_type', 'ticket_type.id', 'entry.ticket_type_id')
      .innerJoin('events as event', 'event.id', 'entry.event_id')
      .select([
        'entry.id as entry_id',
        'entry.tenant_id',
        'entry.brand_id',
        'entry.event_id',
        'entry.ticket_type_id',
        'entry.buyer_email',
        'entry.buyer_first_name',
        'entry.buyer_last_name',
        'entry.quantity',
        'ticket_type.name as ticket_name',
        'ticket_type.inventory_pool_id',
        'event.title as event_title',
        'event.waitlist_auto_offer_enabled',
        'event.waitlist_offer_ttl_minutes',
      ])
      .where('entry.status', '=', 'joined')
      .where('event.waitlist_auto_offer_enabled', '=', true)
      .orderBy('entry.created_at', 'asc')
      .limit(100)
      .execute();

    let offeredCount = 0;
    let queuedEmailCount = 0;
    const reservedByPool = new Map<string, number>();
    const activeOffersByPool = new Map<string, number>();
    for (const candidate of candidates) {
      const inventoryPoolId = candidate.inventory_pool_id;
      // eslint-disable-next-line no-await-in-loop -- waitlist offers must preserve FIFO order and per-pool reserved capacity accounting.
      const pool = await db
        .selectFrom('inventory_pools')
        .select(['total_capacity', 'sold_count'])
        .where('id', '=', inventoryPoolId)
        .executeTakeFirst();
      if (!pool) continue;

      // eslint-disable-next-line no-await-in-loop -- availability must include active holds before this candidate can reserve capacity.
      const activeHolds = await db
        .selectFrom('checkout_holds')
        .select(({ fn }) => fn.sum<number>('quantity').as('quantity'))
        .where('inventory_pool_id', '=', inventoryPoolId)
        .where('status', '=', 'active')
        .where('expires_at', '>', now)
        .executeTakeFirst();
      // Cache active offers per pool to avoid MySQL timestamp precision issues
      // where offered_at < now can match offers made earlier in the same run
      // due to second-level truncation.
      let activeOffersQty = activeOffersByPool.get(inventoryPoolId);
      if (activeOffersQty === undefined) {
        // eslint-disable-next-line no-await-in-loop -- query once per pool before any offers are made for it.
        const activeOffers = await db
          .selectFrom('waitlist_entries as active_entry')
          .innerJoin(
            'ticket_types as active_ticket_type',
            'active_ticket_type.id',
            'active_entry.ticket_type_id',
          )
          .select(({ fn }) => fn.sum<number>('active_entry.quantity').as('quantity'))
          .where('active_ticket_type.inventory_pool_id', '=', inventoryPoolId)
          .where('active_entry.status', '=', 'offered')
          .where('active_entry.offer_expires_at', '>', now)
          .executeTakeFirst();
        activeOffersQty = Number(activeOffers?.quantity ?? 0);
        activeOffersByPool.set(inventoryPoolId, activeOffersQty);
      }
      const alreadyOffered = reservedByPool.get(inventoryPoolId) ?? 0;
      const available =
        Number(pool.total_capacity) -
        Number(pool.sold_count) -
        Number(activeHolds?.quantity ?? 0) -
        activeOffersQty -
        alreadyOffered;
      if (available < Number(candidate.quantity)) continue;

      const claimToken = randomBytes(24).toString('base64url');
      const offerTtlMinutes = Number(candidate.waitlist_offer_ttl_minutes ?? 1440);
      const offerExpiresAt = new Date(now.getTime() + offerTtlMinutes * 60_000);
      // eslint-disable-next-line no-await-in-loop -- each entry is atomically claimed before later candidates consume remaining capacity.
      const update = await db
        .updateTable('waitlist_entries')
        .set({
          status: 'offered',
          claim_token_hash: hashWaitlistClaimToken(claimToken),
          offer_expires_at: offerExpiresAt,
          offered_at: now,
          updated_at: now,
        })
        .where('id', '=', candidate.entry_id)
        .where('status', '=', 'joined')
        .executeTakeFirst();
      const changedRows = Number((update as { numUpdatedRows?: bigint }).numUpdatedRows ?? 0);
      if (changedRows === 0) continue;

      offeredCount += 1;
      reservedByPool.set(inventoryPoolId, alreadyOffered + Number(candidate.quantity));

      // eslint-disable-next-line no-await-in-loop -- email route selection belongs to the entry just offered.
      const route = await db
        .selectFrom('email_provider_routes')
        .select(['id'])
        .where('tenant_id', '=', candidate.tenant_id)
        .where('brand_id', '=', candidate.brand_id)
        .where('status', '=', 'active')
        .where('smoke_send_verified', '=', true)
        .orderBy('priority', 'asc')
        .executeTakeFirst();
      // eslint-disable-next-line no-await-in-loop -- template lookup must match the route and brand for the current offer.
      const templateVersion = await db
        .selectFrom('notification_templates as template')
        .innerJoin(
          'notification_template_versions as version',
          'version.template_id',
          'template.id',
        )
        .select(['version.id'])
        .where('template.tenant_id', '=', candidate.tenant_id)
        .where('template.brand_id', '=', candidate.brand_id)
        .where('template.key', '=', 'waitlist-offer')
        .where('version.is_default', '=', true)
        .executeTakeFirst();
      if (!route || !templateVersion) continue;

      // eslint-disable-next-line no-await-in-loop -- idempotency is checked per entry before queueing its notification job.
      const existingJob = await db
        .selectFrom('email_jobs')
        .select('id')
        .where('tenant_id', '=', candidate.tenant_id)
        .where('idempotency_key', '=', `waitlist-offer:${candidate.entry_id}`)
        .executeTakeFirst();
      if (existingJob) continue;

      // eslint-disable-next-line no-await-in-loop -- notification jobs are queued only after this offer's claim token is persisted.
      await new EmailJobRepository(db).create({
        tenantId: candidate.tenant_id,
        brandId: candidate.brand_id,
        templateKey: 'waitlist-offer',
        templateVersionId: templateVersion.id,
        toEmail: candidate.buyer_email,
        toName:
          [candidate.buyer_first_name, candidate.buyer_last_name].filter(Boolean).join(' ') ||
          undefined,
        variables: {
          eventId: candidate.event_id,
          eventTitle: candidate.event_title,
          ticketTypeId: candidate.ticket_type_id,
          ticketName: candidate.ticket_name,
          quantity: candidate.quantity,
          claimUrl: waitlistClaimUrl(claimToken),
          expiresAt: offerExpiresAt.toISOString(),
          notificationType: 'transactional',
        },
        providerRouteId: route.id,
        priority: 'high',
        idempotencyKey: `waitlist-offer:${candidate.entry_id}`,
      });
      queuedEmailCount += 1;
    }

    return okResult({
      expiredCount: Number(
        (expired[0] as { numUpdatedRows?: bigint } | undefined)?.numUpdatedRows ?? 0,
      ),
      offeredCount,
      queuedEmailCount,
    });
  } catch (err) {
    return errResult(
      'WAITLIST_MAINTENANCE_FAILED',
      err instanceof Error ? err.message : 'Unknown error',
      true,
    );
  } finally {
    await db.destroy();
  }
}
