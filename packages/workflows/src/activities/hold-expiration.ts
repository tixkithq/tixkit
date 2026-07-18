import { createHash, randomBytes } from 'node:crypto';
import { EmailJobRepository, sql, type Database } from '@tixkit/db';
import type { TemplateKey } from '@tixkit/domain';
import type { WorkflowActivityResult } from '../shared/types.js';
import { okResult, errResult } from '../shared/types.js';
import {
  getActivityDb,
  restartQueuedNotificationDeliveryWorkflow,
  restartQueuedSmsDeliveryWorkflow,
  startPrivacyRequestWorkflow,
} from './activity-clients.js';
import {
  createMigrationMediaObjectStore,
  processMigrationMediaCleanupJobs,
} from './migration-domain-committers.js';

const CHECKOUT_BASE_URL =
  process.env.CHECKOUT_URL ?? process.env.NEXT_PUBLIC_CHECKOUT_URL ?? 'https://checkout.tixkit.com';
const WAITLIST_INVITE_TEMPLATE_KEY: TemplateKey = 'waitlist-invite';

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

async function releasePendingDiscountReservation(
  db: Database,
  checkoutSessionId: string,
  now: Date,
): Promise<void> {
  const redemption = await db
    .selectFrom('discount_redemptions')
    .select(['id', 'discount_code_id'])
    .where('checkout_session_id', '=', checkoutSessionId)
    .where('order_id', 'is', null)
    .forUpdate()
    .executeTakeFirst();
  if (!redemption) return;

  await db.deleteFrom('discount_redemptions').where('id', '=', redemption.id).execute();
  await db
    .updateTable('discount_codes')
    .set((eb) => ({
      uses_count: eb('uses_count', '-', 1),
      updated_at: now,
    }))
    .where('id', '=', redemption.discount_code_id)
    .where('uses_count', '>', 0)
    .execute();
}

export async function expireStaleHoldsActivity(): Promise<
  WorkflowActivityResult<{ expiredCount: number }>
> {
  const db = getActivityDb();
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
  }
}

const MESSAGE_HANDOFF_RECOVERY_BATCH_SIZE = 100;
const PRIVACY_HANDOFF_RECOVERY_BATCH_SIZE = 100;

function privacyRequestIdForIdempotencyRecord(input: {
  tenantId: string;
  key: string;
  requestHash: string;
}): string {
  const digest = createHash('sha256')
    .update(input.tenantId)
    .update('\0')
    .update(input.key)
    .update('\0')
    .update(input.requestHash)
    .digest('hex')
    .slice(0, 26);
  return `prv_${digest}`;
}

function privacyAcceptanceEnvelope(request: Record<string, unknown>): Record<string, unknown> {
  const iso = (value: unknown) => {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(String(value));
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  };
  return {
    id: request.id,
    tenantId: request.tenant_id,
    organizationId: request.organization_id,
    brandId: request.brand_id ?? null,
    requestType: request.request_type,
    subjectType: request.subject_type,
    subjectId: null,
    subjectEmail: null,
    status: request.status,
    requestedBy: request.requested_by,
    result: null,
    error: request.error ?? null,
    createdAt: iso(request.created_at),
    completedAt: iso(request.completed_at),
  };
}

async function reconcilePrivacyIdempotencyRecord(
  db: Database,
  request: Record<string, unknown>,
): Promise<void> {
  const tenantId = String(request.tenant_id);
  const records = await db
    .selectFrom('idempotency_records')
    .select(['id', 'key', 'request_hash'])
    .where('tenant_id', '=', tenantId)
    .where('status', '=', 'in_progress')
    .execute();
  const matchingRecord = records.find(
    (record) =>
      privacyRequestIdForIdempotencyRecord({
        tenantId,
        key: record.key,
        requestHash: record.request_hash,
      }) === request.id,
  );
  if (!matchingRecord) return;
  await db
    .updateTable('idempotency_records')
    .set({
      response_status: 202,
      response_body: JSON.stringify(privacyAcceptanceEnvelope(request)),
      status: 'completed',
    })
    .where('id', '=', matchingRecord.id)
    .where('status', '=', 'in_progress')
    .execute();
}

export async function recoverPendingPrivacyRequestHandoffsActivity(): Promise<
  WorkflowActivityResult<{ recoveredCount: number; skippedUnauditedCount: number }>
> {
  const db = getActivityDb();
  try {
    const requests = await db
      .selectFrom('privacy_requests')
      .selectAll('privacy_requests')
      .where('status', '=', 'pending')
      .where(({ exists, ref, selectFrom }) =>
        exists(
          selectFrom('audit_logs')
            .select('audit_logs.id')
            .whereRef('audit_logs.tenant_id', '=', 'privacy_requests.tenant_id')
            .whereRef('audit_logs.resource_id', '=', 'privacy_requests.id')
            .where('audit_logs.resource_type', '=', 'PrivacyRequest')
            .where(
              'audit_logs.action',
              '=',
              sql<string>`concat('privacy.', ${ref('privacy_requests.request_type')}, '.requested')`,
            ),
        ),
      )
      .orderBy('created_at', 'asc')
      .limit(PRIVACY_HANDOFF_RECOVERY_BATCH_SIZE)
      .execute();
    let recoveredCount = 0;
    const skippedUnauditedCount = 0;
    let failedCount = 0;
    for (const request of requests) {
      try {
        // eslint-disable-next-line no-await-in-loop -- each audited intent uses a deterministic workflow id before the recovery cursor advances.
        await startPrivacyRequestWorkflow(request.id);
        // eslint-disable-next-line no-await-in-loop -- crash-surviving reservations are completed only after Temporal accepts the deterministic handoff.
        await reconcilePrivacyIdempotencyRecord(db, request);
        recoveredCount += 1;
      } catch {
        failedCount += 1;
      }
    }
    if (failedCount > 0) {
      return errResult(
        'PRIVACY_HANDOFF_RECOVERY_FAILED',
        `${failedCount} audited privacy handoff(s) could not reach Temporal`,
        true,
      );
    }
    return okResult({ recoveredCount, skippedUnauditedCount });
  } catch (error) {
    return errResult(
      'PRIVACY_HANDOFF_RECOVERY_FAILED',
      error instanceof Error ? error.message : 'Unknown error',
      true,
    );
  }
}

export async function recoverQueuedMessageHandoffsActivity(): Promise<
  WorkflowActivityResult<{ recoveredEmailCount: number; recoveredSmsCount: number }>
> {
  const db = getActivityDb();
  try {
    const [emailJobs, smsJobs] = await Promise.all([
      db
        .selectFrom('email_jobs')
        .select([
          'id',
          'tenant_id',
          'brand_id',
          'template_key',
          'template_version_id',
          'to_email',
          'to_name',
          'variables',
          'provider_route_id',
          'status',
          'workflow_id',
          'scheduled_at',
        ])
        .where('status', 'in', ['queued', 'start_failed'])
        .where('workflow_id', 'is', null)
        .orderBy('created_at', 'asc')
        .limit(MESSAGE_HANDOFF_RECOVERY_BATCH_SIZE)
        .execute(),
      db
        .selectFrom('sms_jobs')
        .select([
          'id',
          'tenant_id',
          'brand_id',
          'variables',
          'provider_route_id',
          'status',
          'workflow_id',
          'scheduled_at',
        ])
        .where('status', 'in', ['queued', 'start_failed'])
        .where('workflow_id', 'is', null)
        .orderBy('created_at', 'asc')
        .limit(MESSAGE_HANDOFF_RECOVERY_BATCH_SIZE)
        .execute(),
    ]);

    let recoveredEmailCount = 0;
    let recoveredSmsCount = 0;
    const failures: unknown[] = [];
    for (const job of emailJobs) {
      try {
        // eslint-disable-next-line no-await-in-loop -- each deterministic workflow id must be durably recorded before advancing the recovery cursor.
        await restartQueuedNotificationDeliveryWorkflow(db, job);
        recoveredEmailCount += 1;
      } catch (error) {
        failures.push(error);
      }
    }
    for (const job of smsJobs) {
      try {
        // eslint-disable-next-line no-await-in-loop -- each deterministic workflow id must be durably recorded before advancing the recovery cursor.
        await restartQueuedSmsDeliveryWorkflow(db, job);
        recoveredSmsCount += 1;
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      return errResult(
        'MESSAGE_HANDOFF_RECOVERY_FAILED',
        `${failures.length} queued message handoff(s) could not reach Temporal`,
        true,
      );
    }
    return okResult({ recoveredEmailCount, recoveredSmsCount });
  } catch (error) {
    return errResult(
      'MESSAGE_HANDOFF_RECOVERY_FAILED',
      error instanceof Error ? error.message : 'Unknown error',
      true,
    );
  }
}

export async function cleanupMigrationMediaObjectsActivity(): Promise<
  WorkflowActivityResult<{ completed: number; retained: number; failed: number }>
> {
  try {
    return okResult(
      await processMigrationMediaCleanupJobs(getActivityDb(), createMigrationMediaObjectStore()),
    );
  } catch (error) {
    return errResult(
      'MIGRATION_MEDIA_CLEANUP_FAILED',
      error instanceof Error ? error.message : 'Unknown error',
      true,
    );
  }
}

export async function expireStaleSessionsActivity(): Promise<
  WorkflowActivityResult<{ expiredCount: number }>
> {
  const db = getActivityDb();
  try {
    const now = new Date();
    const result = await db.transaction().execute(async (trx) => {
      const expiredSessions = await trx
        .selectFrom('checkout_sessions')
        .select(['id', 'tenant_id', 'cart'])
        .where('status', '=', 'open')
        .where('expires_at', '<', now)
        .where('payment_intent_id', 'is', null)
        .forUpdate()
        .execute();

      let expiredCount = 0n;
      for (const session of expiredSessions) {
        // eslint-disable-next-line no-await-in-loop -- the guarded state transition must win before releasing session-owned side effects.
        const transitionResult = await trx
          .updateTable('checkout_sessions')
          .set({ status: 'expired', updated_at: now })
          .where('id', '=', session.id)
          .where('status', '=', 'open')
          .where('expires_at', '<', now)
          .where('payment_intent_id', 'is', null)
          .executeTakeFirst();
        const transitionedRows = BigInt(transitionResult?.numUpdatedRows ?? 0);
        if (transitionedRows === 0n) continue;
        expiredCount += transitionedRows;

        const cart = parseStoredJson<{ waitlistEntryId?: string }>(session.cart, {});
        // eslint-disable-next-line no-await-in-loop -- each discount release is tied to the expired session row.
        await releasePendingDiscountReservation(trx, session.id, now);
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

      return [{ numUpdatedRows: expiredCount }];
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
  }
}

export async function processWaitlistOffersActivity(): Promise<
  WorkflowActivityResult<{
    expiredCount: number;
    offeredCount: number;
    queuedEmailCount: number;
  }>
> {
  const db = getActivityDb();
  try {
    const now = new Date();
    const offerResult = await db.transaction().execute(async (trx) => {
      const expired = await trx
        .updateTable('waitlist_entries')
        .set({ status: 'expired', updated_at: now })
        .where('status', '=', 'offered')
        .where('offer_expires_at', '<=', now)
        .execute();

      const candidates = await trx
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
        .forUpdate()
        .execute();

      let offeredCount = 0;
      const offeredCandidates: Array<{
        candidate: (typeof candidates)[number];
        claimToken: string;
        offerExpiresAt: Date;
        providerRouteId: string;
        templateVersionId: string;
      }> = [];
      const reservedByPool = new Map<string, number>();
      const activeOffersByPool = new Map<string, number>();
      for (const candidate of candidates) {
        const inventoryPoolId = candidate.inventory_pool_id;
        // eslint-disable-next-line no-await-in-loop -- waitlist offers must preserve FIFO order and lock per-pool capacity before accounting.
        const pool = await trx
          .selectFrom('inventory_pools')
          .select(['total_capacity', 'sold_count'])
          .where('id', '=', inventoryPoolId)
          .forUpdate()
          .executeTakeFirst();
        if (!pool) continue;

        // eslint-disable-next-line no-await-in-loop -- availability must include active holds before this candidate can reserve capacity.
        const activeHolds = await trx
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
          // eslint-disable-next-line no-await-in-loop -- query once per pool after locking the pool and before any offers are made for it.
          const activeOffers = await trx
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

        // eslint-disable-next-line no-await-in-loop -- each candidate must have a verified route before it can consume waitlist capacity.
        const route = await trx
          .selectFrom('email_provider_routes')
          .select(['id'])
          .where('tenant_id', '=', candidate.tenant_id)
          .where('brand_id', '=', candidate.brand_id)
          .where('status', '=', 'active')
          .where('smoke_send_verified', '=', true)
          .orderBy('priority', 'asc')
          .executeTakeFirst();
        // eslint-disable-next-line no-await-in-loop -- the invite template must be ready before this entry is marked offered.
        const templateVersion = await trx
          .selectFrom('notification_templates as template')
          .innerJoin(
            'notification_template_versions as version',
            'version.template_id',
            'template.id',
          )
          .select(['version.id'])
          .where('template.tenant_id', '=', candidate.tenant_id)
          .where('template.brand_id', '=', candidate.brand_id)
          .where('template.key', '=', WAITLIST_INVITE_TEMPLATE_KEY)
          .where('version.is_default', '=', true)
          .executeTakeFirst();
        if (!route || !templateVersion) {
          console.warn('WAITLIST_OFFER_EMAIL_SKIPPED', {
            tenantId: candidate.tenant_id,
            brandId: candidate.brand_id,
            waitlistEntryId: candidate.entry_id,
            templateKey: WAITLIST_INVITE_TEMPLATE_KEY,
            missingRoute: !route,
            missingTemplateVersion: !templateVersion,
          });
          continue;
        }

        // eslint-disable-next-line no-await-in-loop -- idempotency is checked per entry before reserving capacity for its notification.
        const existingJob = await trx
          .selectFrom('email_jobs')
          .select('id')
          .where('tenant_id', '=', candidate.tenant_id)
          .where('idempotency_key', '=', `${WAITLIST_INVITE_TEMPLATE_KEY}:${candidate.entry_id}`)
          .executeTakeFirst();
        if (existingJob) continue;

        const claimToken = randomBytes(24).toString('base64url');
        const offerTtlMinutes = Number(candidate.waitlist_offer_ttl_minutes ?? 1440);
        const offerExpiresAt = new Date(now.getTime() + offerTtlMinutes * 60_000);
        // eslint-disable-next-line no-await-in-loop -- each entry is atomically claimed before later candidates consume remaining capacity.
        const update = await trx
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
        offeredCandidates.push({
          candidate,
          claimToken,
          offerExpiresAt,
          providerRouteId: route.id,
          templateVersionId: templateVersion.id,
        });
      }

      return { expired, offeredCount, offeredCandidates };
    });

    let queuedEmailCount = 0;
    for (const {
      candidate,
      claimToken,
      offerExpiresAt,
      providerRouteId,
      templateVersionId,
    } of offerResult.offeredCandidates) {
      // eslint-disable-next-line no-await-in-loop -- notification jobs are queued only after this offer's claim token is persisted.
      await new EmailJobRepository(db).create({
        tenantId: candidate.tenant_id,
        brandId: candidate.brand_id,
        templateKey: WAITLIST_INVITE_TEMPLATE_KEY,
        templateVersionId,
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
        providerRouteId,
        priority: 'high',
        idempotencyKey: `${WAITLIST_INVITE_TEMPLATE_KEY}:${candidate.entry_id}`,
      });
      queuedEmailCount += 1;
    }

    return okResult({
      expiredCount: Number(
        (offerResult.expired[0] as { numUpdatedRows?: bigint } | undefined)?.numUpdatedRows ?? 0,
      ),
      offeredCount: offerResult.offeredCount,
      queuedEmailCount,
    });
  } catch (err) {
    return errResult(
      'WAITLIST_MAINTENANCE_FAILED',
      err instanceof Error ? err.message : 'Unknown error',
      true,
    );
  }
}
