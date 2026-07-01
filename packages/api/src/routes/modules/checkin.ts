import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { ClerkAuthService } from '../../auth/clerk.js';
import {
  type Database,
  EventRepository,
  TicketRepository,
  CheckInListRepository,
  ScanLogRepository,
  AttendeeRepository,
  OrderRepository,
  getDriver,
} from '@tixkit/db';
import { sql } from 'kysely';
import { NotFoundError, ValidationError } from '@tixkit/domain';
import type { ScanRequest, SyncScanInput } from '@tixkit/domain';
import { withIdempotency, hashRequest } from '../../services/idempotency.js';
import { ulid } from 'ulid';
import {
  pageEnvelope,
  parseJsonValue,
  parsePagination,
  pickAllowedFields,
  serializeAttendee,
  serializeCheckInList,
  serializeTicket,
  toIso,
} from '../../http/contracts.js';
import {
  createBulkSyncJobSchema,
  bulkSyncChunkSchema,
  MAX_BULK_OFFLINE_SYNC_TOTAL_SCANS,
  OFFLINE_SYNC_JSON_BODY_LIMIT_BYTES,
  scanSchema,
  syncScanSchema,
  updateAttendeeSchema,
  transferTicketSchema,
  parseBody,
} from '../../http/schemas.js';

type Principal = NonNullable<FastifyRequest['principal']>;
type CheckInListRow = NonNullable<Awaited<ReturnType<CheckInListRepository['findById']>>>;
type TicketRow = NonNullable<Awaited<ReturnType<TicketRepository['findById']>>>;
type NormalizedOfflineScan = {
  qrHash: string;
  scannedAt: Date;
  scannedAtIso: string;
  offline?: boolean;
  clockWarning?: 'future_device_clock' | 'stale_device_clock';
  clockDriftMs?: number;
  chunkSequence?: number;
  chunkScanIndex?: number;
};
type OfflineScanResult = {
  qrHash: string;
  outcome: string;
  ticketId?: string;
  metadata?: Record<string, unknown>;
};
type BulkSyncErrorSample = {
  sequence: number;
  scanIndex: number;
  qrHash: string;
  outcome: string;
  metadata?: Record<string, unknown>;
};
type PublicBulkSyncErrorSample = Omit<BulkSyncErrorSample, 'qrHash'>;
type BulkSyncJobRow = {
  id: string;
  tenant_id: string;
  event_id: string;
  check_in_list_id: string;
  device_id: string;
  requested_by_principal_id: string;
  total_chunks: number;
  total_scans: number | null;
  chunks_received: number;
  chunks_processed: number;
  accepted_count: number | string | bigint;
  duplicate_count: number | string | bigint;
  invalid_count: number | string | bigint;
  sample_errors: unknown;
  status: string;
  failure_message: string | null;
  attempt_count?: number | string | bigint;
  lease_owner?: string | null;
  leased_until?: Date | string | null;
  next_attempt_at?: Date | string | null;
  last_attempted_at?: Date | string | null;
  last_heartbeat_at?: Date | string | null;
  processing_started_at?: Date | string | null;
  processing_completed_at?: Date | string | null;
  processing_duration_ms?: number | string | bigint;
  transaction_duration_ms?: number | string | bigint;
  lock_wait_ms?: number | string | bigint;
  scan_log_insert_duration_ms?: number | string | bigint;
  ticket_update_duration_ms?: number | string | bigint;
  attendee_update_duration_ms?: number | string | bigint;
  rows_processed?: number | string | bigint;
  clock_warning_count?: number | string | bigint;
  created_at: Date | string;
  updated_at: Date | string;
  completed_at: Date | string | null;
};
type BulkSyncChunkRow = {
  id: string;
  tenant_id: string;
  job_id: string;
  sequence: number;
  scan_count: number;
  payload_hash: string;
  payload: unknown | null;
  accepted_count: number | string | bigint;
  duplicate_count: number | string | bigint;
  invalid_count: number | string | bigint;
  sample_errors: unknown;
  clock_warning_count?: number | string | bigint;
  status: string;
  attempt_count: number;
  failure_message: string | null;
  locked_at: Date | string | null;
  processed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};
type AcceptedCandidate = {
  ticketId: string;
  attendeeId: string;
  scannedAt: Date;
  resultIndex: number;
};
type OfflineSyncBatchMetrics = {
  rowsProcessed: number;
  clockWarnings: number;
  scanLogInsertDurationMs: number;
  ticketUpdateDurationMs: number;
  attendeeUpdateDurationMs: number;
};
type BulkSyncWorkerOptions = {
  workerId?: string;
  limit?: number;
};

const OFFLINE_SYNC_DB_CHUNK_SIZE = 500;
export const MAX_OFFLINE_MANIFEST_TICKETS = 50_000;
const BULK_SYNC_ERROR_SAMPLE_LIMIT = 25;
const BULK_SYNC_PROCESSING_BATCH_SIZE = 50_000;
const BULK_SYNC_PUBLIC_FAILURE_MESSAGE = 'Bulk sync chunk processing failed';
const BULK_SYNC_WORKER_LEASE_MS = 60 * 60 * 1000;
const BULK_SYNC_RETRY_BASE_MS = 30 * 1000;
const BULK_SYNC_RETRY_MAX_MS = 15 * 60 * 1000;
const BULK_SYNC_MAX_ATTEMPTS = 5;
const DEVICE_CLOCK_WARNING_FUTURE_MS = 5 * 60 * 1000;
const DEVICE_CLOCK_REJECT_FUTURE_MS = 24 * 60 * 60 * 1000;
const DEVICE_CLOCK_STALE_WARNING_MS = 180 * 24 * 60 * 60 * 1000;
const scheduledBulkSyncJobs = new Set<string>();
const pendingBulkSyncJobSchedules = new Set<string>();

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function requireEventAccess(principal: Principal, event: Record<string, unknown>, eventId: string) {
  ClerkAuthService.requireResourceTenant(principal, event, 'Event', eventId);
  ClerkAuthService.requireOrganizationScope(principal, event.organization_id as string | undefined);
  ClerkAuthService.requireBrandScope(principal, event.brand_id as string | undefined);
  ClerkAuthService.requireEventScope(principal, eventId);
}

export const checkInRoutes: FastifyPluginAsync = async (app) => {
  const db = app.context.db;

  const loadEvent = async (eventId: string) => {
    const eventRepo = new EventRepository(db);
    const event = await eventRepo.findById(eventId);
    if (!event) throw new NotFoundError('Event', eventId);
    return event;
  };

  app.get('/events/:eventId/attendees', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'attendees.read');
    const { eventId } = request.params as { eventId: string };
    const {
      eventOccurrenceId,
      query: rawQuery,
      checkInListId,
    } = request.query as {
      eventOccurrenceId?: string;
      query?: string;
      checkInListId?: string;
    };
    const pagination = parsePagination(request.query);
    const searchQuery = typeof rawQuery === 'string' ? rawQuery.trim() : '';
    const event = await loadEvent(eventId);
    requireEventAccess(principal, event, eventId);
    let selectedList: CheckInListRow | undefined;
    if (checkInListId) {
      const listRepo = new CheckInListRepository(db);
      const list = await listRepo.findById(checkInListId);
      if (!list || list.event_id !== eventId) throw new NotFoundError('CheckInList', checkInListId);
      if (list.status !== 'active') throw new ValidationError('Check-in list is not active');
      selectedList = list;
    }
    let query = db
      .selectFrom('attendees')
      .selectAll()
      .where('event_id', '=', eventId)
      .where('tenant_id', '=', principal.tenantId)
      .orderBy('id', 'asc')
      .limit(pagination.limit + 1);
    if (selectedList) {
      const allowedTicketTypeIds = parseJsonValue<string[]>(selectedList.ticket_type_ids, []);
      if (allowedTicketTypeIds.length > 0) {
        query = query.where('ticket_type_id', 'in', allowedTicketTypeIds);
      }
      if (selectedList.event_occurrence_id) {
        query = query.where('event_occurrence_id', '=', selectedList.event_occurrence_id);
      }
    }
    if (eventOccurrenceId) query = query.where('event_occurrence_id', '=', eventOccurrenceId);
    if (searchQuery) {
      const pattern = `%${escapeLikePattern(searchQuery)}%`;
      query = query.where((eb) =>
        eb.or([
          eb('first_name', 'ilike', pattern),
          eb('last_name', 'ilike', pattern),
          eb('email', 'ilike', pattern),
          eb('ticket_id', 'ilike', pattern),
        ]),
      );
    }
    if (pagination.cursor) query = query.where('id', '>', pagination.cursor);
    const rows = await query.execute();
    return pageEnvelope(
      rows.map((row) => serializeAttendee(row)),
      pagination.limit,
    );
  });

  app.get('/attendees', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'attendees.read');
    const pagination = parsePagination(request.query);
    let query = db
      .selectFrom('attendees')
      .innerJoin('events', 'events.id', 'attendees.event_id')
      .selectAll('attendees')
      .where('attendees.tenant_id', '=', principal.tenantId)
      .orderBy('id', 'asc')
      .limit(pagination.limit + 1);
    if (principal.type !== 'system') {
      if (principal.organizationIds.length === 0) {
        return pageEnvelope([], pagination.limit);
      }
      query = query.where('events.organization_id', 'in', principal.organizationIds);
    }
    if (principal.brandIds && principal.brandIds.length > 0) {
      query = query.where('events.brand_id', 'in', principal.brandIds);
    }
    if (principal.eventIds && principal.eventIds.length > 0) {
      query = query.where('attendees.event_id', 'in', principal.eventIds);
    }
    const { eventOccurrenceId } = request.query as { eventOccurrenceId?: string };
    if (eventOccurrenceId)
      query = query.where('attendees.event_occurrence_id', '=', eventOccurrenceId);
    if (pagination.cursor) query = query.where('id', '>', pagination.cursor);
    const rows = await query.execute();
    return pageEnvelope(
      rows.map((row) => serializeAttendee(row)),
      pagination.limit,
    );
  });

  app.patch('/attendees/:attendeeId', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'attendees.write');
    const { attendeeId } = request.params as { attendeeId: string };
    const body = parseBody(updateAttendeeSchema, request.body);
    const repo = new AttendeeRepository(db);
    const existing = await repo.findById(attendeeId);
    if (!existing) throw new NotFoundError('Attendee', attendeeId);
    const event = await loadEvent(existing.event_id);
    ClerkAuthService.requireResourceTenant(principal, existing, 'Attendee', attendeeId);
    requireEventAccess(principal, event, existing.event_id);
    const updateData = pickAllowedFields(
      body,
      ['firstName', 'lastName', 'email', 'phone', 'status'],
      {
        firstName: 'first_name',
        lastName: 'last_name',
      },
    );
    return serializeAttendee(await repo.update(attendeeId, updateData));
  });

  app.post('/tickets/:ticketId/transfer', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'attendees.write');
    const { ticketId } = request.params as { ticketId: string };
    const body = parseBody(transferTicketSchema, request.body);
    const idempotencyKey = request.headers['idempotency-key'];
    if (typeof idempotencyKey !== 'string') {
      throw new ValidationError('Idempotency-Key header is required for ticket transfers');
    }

    const ticketRepo = new TicketRepository(db);
    const ticket = await ticketRepo.findById(ticketId);
    if (!ticket) throw new NotFoundError('Ticket', ticketId);

    const event = await loadEvent(ticket.event_id);
    ClerkAuthService.requireResourceTenant(principal, ticket, 'Ticket', ticketId);
    requireEventAccess(principal, event, ticket.event_id);

    const result = await withIdempotency(
      db,
      {
        key: idempotencyKey,
        tenantId: principal.tenantId,
        requestHash: hashRequest({ ticketId, toEmail: body.toEmail }),
      },
      async () => {
        const reissuedTicket = await db.transaction().execute(async (trx) => {
          const txDb = trx as typeof db;
          const txTicketRepo = new TicketRepository(txDb);
          const txAttendeeRepo = new AttendeeRepository(txDb);
          const txOrderRepo = new OrderRepository(txDb);
          const now = new Date();

          const sourceTicket = await txTicketRepo.findById(ticketId);
          if (
            !sourceTicket ||
            sourceTicket.tenant_id !== principal.tenantId ||
            sourceTicket.event_id !== ticket.event_id
          ) {
            throw new NotFoundError('Ticket', ticketId);
          }
          if (sourceTicket.status !== 'valid') {
            throw new ValidationError(`Ticket status is ${sourceTicket.status}, cannot transfer`);
          }

          const sourceAttendee = await txAttendeeRepo.findById(sourceTicket.attendee_id as string);
          if (
            !sourceAttendee ||
            sourceAttendee.tenant_id !== principal.tenantId ||
            sourceAttendee.event_id !== sourceTicket.event_id
          ) {
            throw new ValidationError(`Ticket ${ticketId} is not attached to a valid attendee`);
          }

          const recipientAttendee = await txAttendeeRepo.create({
            tenantId: principal.tenantId,
            orderId: sourceTicket.order_id as string,
            eventId: sourceTicket.event_id as string,
            ticketTypeId: sourceTicket.ticket_type_id as string,
            eventOccurrenceId: (sourceTicket.event_occurrence_id as string | null) ?? undefined,
            email: body.toEmail,
            customAnswers: {
              transferSourceTicketId: sourceTicket.id,
              transferSourceAttendeeId: sourceAttendee.id,
              transferRecipientEmail: body.toEmail,
            },
          });

          const recipientTicketId = `tkt_${ulid()}`;
          const qr = app.context.qrService.generate(recipientTicketId);
          const recipientTicket = await txTicketRepo.create({
            id: recipientTicketId,
            tenantId: principal.tenantId,
            orderId: sourceTicket.order_id as string,
            attendeeId: recipientAttendee.id as string,
            eventId: sourceTicket.event_id as string,
            ticketTypeId: sourceTicket.ticket_type_id as string,
            eventOccurrenceId: (sourceTicket.event_occurrence_id as string | null) ?? undefined,
            code: qr.code,
            qrPayload: qr.payload,
            qrHash: qr.hash,
          });

          await txAttendeeRepo.update(recipientAttendee.id as string, {
            ticket_id: recipientTicket.id,
            status: 'confirmed',
          });

          const transferred = await txTicketRepo.transferIfValid(ticketId, body.toEmail, now);
          if (!transferred) {
            const currentTicket = await txTicketRepo.findById(ticketId);
            const currentStatus = currentTicket?.status ?? sourceTicket.status;
            throw new ValidationError(`Ticket status is ${currentStatus}, cannot transfer`);
          }

          await txDb
            .updateTable('wallet_passes')
            .set({ status: 'revoked', revoked_at: now, updated_at: now })
            .where('ticket_id', '=', ticketId)
            .where('status', '=', 'active')
            .execute();

          await txOrderRepo.addTimelineEvent(
            sourceTicket.order_id as string,
            'ticket.transferred',
            `Ticket ${sourceTicket.id} transferred to ${body.toEmail}`,
            {
              sourceTicketId: sourceTicket.id,
              sourceAttendeeId: sourceAttendee.id,
              recipientTicketId: recipientTicket.id,
              recipientAttendeeId: recipientAttendee.id,
              recipientEmail: body.toEmail,
            },
            principal.id,
          );

          return recipientTicket;
        });

        return { status: 200, body: reissuedTicket };
      },
    );

    return reply
      .status(result.status)
      .send(
        result.status === 200
          ? serializeTicket(result.body as Record<string, unknown>)
          : result.body,
      );
  });

  app.get('/events/:eventId/check-in-lists', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'checkins.read');
    const { eventId } = request.params as { eventId: string };
    const pagination = parsePagination(request.query);
    const event = await loadEvent(eventId);
    requireEventAccess(principal, event, eventId);
    const repo = new CheckInListRepository(db);
    const rows = await repo.findByEvent(eventId, pagination.limit + 1, pagination.cursor);
    return pageEnvelope(
      rows.map((row) => serializeCheckInList(row)),
      pagination.limit,
    );
  });

  app.get('/events/:eventId/check-in-lists/:checkInListId/manifest', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'checkins.read');
    const { eventId, checkInListId } = request.params as { eventId: string; checkInListId: string };
    const event = await loadEvent(eventId);
    requireEventAccess(principal, event, eventId);

    const listRepo = new CheckInListRepository(db);
    const list = await listRepo.findById(checkInListId);
    if (!list || list.event_id !== eventId) throw new NotFoundError('CheckInList', checkInListId);
    if (list.status !== 'active') throw new ValidationError('Check-in list is not active');

    const allowedTicketTypeIds = parseJsonValue<string[]>(list.ticket_type_ids, []);
    let ticketQuery = db
      .selectFrom('tickets')
      .innerJoin('attendees', 'attendees.id', 'tickets.attendee_id')
      .select([
        'tickets.id as ticket_id',
        'tickets.ticket_type_id as ticket_type_id',
        'tickets.event_occurrence_id as event_occurrence_id',
        'tickets.qr_hash as qr_hash',
        'tickets.status as status',
        'attendees.first_name as first_name',
        'attendees.last_name as last_name',
        'attendees.email as email',
      ])
      .where('tickets.tenant_id', '=', principal.tenantId)
      .where('tickets.event_id', '=', eventId)
      .orderBy('tickets.id', 'asc');
    if (allowedTicketTypeIds.length > 0) {
      ticketQuery = ticketQuery.where('tickets.ticket_type_id', 'in', allowedTicketTypeIds);
    }
    if (list.event_occurrence_id) {
      ticketQuery = ticketQuery.where('tickets.event_occurrence_id', '=', list.event_occurrence_id);
    }

    const rows = await ticketQuery.limit(MAX_OFFLINE_MANIFEST_TICKETS + 1).execute();
    if (rows.length > MAX_OFFLINE_MANIFEST_TICKETS) {
      throw new ValidationError(
        `Offline manifest exceeds maximum ticket count of ${MAX_OFFLINE_MANIFEST_TICKETS}`,
        { maxTickets: MAX_OFFLINE_MANIFEST_TICKETS },
      );
    }
    return buildOfflineManifest({ eventId, checkInListId, rows });
  });

  app.post('/check-ins/scan', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'checkins.write');
    const body = parseBody(scanSchema, request.body) as Partial<ScanRequest>;
    const qrService = app.context.qrService;
    const idempotencyKey = request.headers['idempotency-key'];

    const ticketRepo = new TicketRepository(db);
    const scanRepo = new ScanLogRepository(db);
    const listRepo = new CheckInListRepository(db);

    if (!body.checkInListId) throw new ValidationError('checkInListId is required');
    if (!body.qrPayload) throw new ValidationError('qrPayload is required for online scans');
    if (!body.scannedAt) throw new ValidationError('scannedAt is required');
    const normalizedScannedAt = normalizeScannedAt(body.scannedAt);

    const list = await listRepo.findById(body.checkInListId);
    if (!list) throw new NotFoundError('CheckInList', body.checkInListId);
    const event = await loadEvent(list.event_id);
    requireEventAccess(principal, event, list.event_id);
    if (list.status !== 'active') throw new ValidationError('Check-in list is not active');

    const effectiveDeviceId = resolveCheckInDeviceId(principal, body.deviceId);
    const requestHash = hashRequest({
      checkInListId: body.checkInListId,
      qrPayload: body.qrPayload,
      deviceId: effectiveDeviceId,
      scannedAt: body.scannedAt,
    });

    const handler = async () => {
      const result = await processScan({
        ticketRepo,
        tenantId: principal.tenantId,
        list,
        qrHash: qrService.hashPayload(body.qrPayload!),
        verification: qrService.getQrPayload(body.qrPayload!),
        deviceId: effectiveDeviceId,
        scannedAt: normalizedScannedAt.scannedAt,
        requireVerifiedTicketId: true,
      });

      await scanRepo.create({
        tenantId: principal.tenantId,
        checkInListId: body.checkInListId!,
        deviceId: effectiveDeviceId,
        ticketId: result.ticketId,
        qrHash: result.qrHash,
        outcome: result.outcome,
        scannedAt: normalizedScannedAt.scannedAt,
        offline: body.offline ?? false,
        metadata: metadataWithClockWarning(result.metadata, normalizedScannedAt),
      });

      return {
        status: 200,
        body: {
          outcome: result.outcome,
          ticketId: result.ticketId,
          message:
            result.outcome === 'accepted' ? 'Check-in successful' : `Check-in ${result.outcome}`,
        },
      };
    };

    const result =
      typeof idempotencyKey === 'string'
        ? await withIdempotency(
            db,
            {
              key: idempotencyKey,
              tenantId: principal.tenantId,
              requestHash,
            },
            handler,
          )
        : await handler();

    return reply.status(result.status).send(result.body);
  });

  app.post(
    '/check-ins/sync',
    { bodyLimit: OFFLINE_SYNC_JSON_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const principal = request.principal!;
      ClerkAuthService.requirePermission(principal, 'checkins.write');
      const body = parseBody(syncScanSchema, request.body) as SyncScanInput;
      const idempotencyKey = request.headers['idempotency-key'];
      if (typeof idempotencyKey !== 'string') {
        throw new ValidationError('Idempotency-Key header is required for offline scan sync');
      }
      if (!body.checkInListId) throw new ValidationError('checkInListId is required');
      if (!Array.isArray(body.scans)) throw new ValidationError('scans must be an array');

      const listRepo = new CheckInListRepository(db);

      const list = await listRepo.findById(body.checkInListId);
      if (!list) throw new NotFoundError('CheckInList', body.checkInListId);
      const event = await loadEvent(list.event_id);
      requireEventAccess(principal, event, list.event_id);
      if (list.status !== 'active') throw new ValidationError('Check-in list is not active');
      const effectiveDeviceId = resolveCheckInDeviceId(principal, body.deviceId);

      const normalizedScans = normalizeBulkSyncScans(body.scans);

      // Deterministic conflict resolution: sort by scannedAt so the earliest
      // offline scan wins the check-in; later scans for the same ticket become
      // duplicates. The idempotency guard below prevents replayed batches from
      // writing duplicate scan logs.
      // eslint-disable-next-line unicorn/no-array-sort -- sorting a fresh array preserves deterministic offline conflict ordering.
      const sortedScans = [...normalizedScans].sort(
        (a, b) => a.scannedAt.getTime() - b.scannedAt.getTime(),
      );

      const requestHash = hashRequest({
        checkInListId: body.checkInListId,
        deviceId: effectiveDeviceId,
        scans: sortedScans.map((scan) => ({
          qrHash: scan.qrHash,
          scannedAt: scan.scannedAtIso,
          offline: scan.offline,
        })),
      });

      const syncResult = await withIdempotency(
        db,
        {
          key: idempotencyKey,
          tenantId: principal.tenantId,
          requestHash,
        },
        async () => {
          const result = await db.transaction().execute(async (trx) =>
            processOfflineSyncBatch({
              db: trx as Database,
              tenantId: principal.tenantId,
              list,
              checkInListId: body.checkInListId,
              deviceId: effectiveDeviceId,
              scans: sortedScans,
            }),
          );

          const { errorSamples: _errorSamples, metrics: _metrics, ...syncBody } = result;
          return { status: 200, body: syncBody };
        },
      );

      return reply.status(syncResult.status).send(syncResult.body);
    },
  );

  app.post('/check-ins/bulk-sync-jobs', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'checkins.write');
    const body = parseBody(createBulkSyncJobSchema, request.body) as {
      checkInListId: string;
      deviceId?: string;
      totalChunks: number;
      totalScans?: number;
    };
    const idempotencyKey = request.headers['idempotency-key'];
    if (typeof idempotencyKey !== 'string') {
      throw new ValidationError('Idempotency-Key header is required for bulk offline sync jobs');
    }
    if (body.totalScans !== undefined && body.totalScans < body.totalChunks) {
      throw new ValidationError('totalScans must be greater than or equal to totalChunks');
    }

    const listRepo = new CheckInListRepository(db);
    const list = await listRepo.findById(body.checkInListId);
    if (!list) throw new NotFoundError('CheckInList', body.checkInListId);
    const event = await loadEvent(list.event_id);
    requireEventAccess(principal, event, list.event_id);
    if (list.status !== 'active') throw new ValidationError('Check-in list is not active');
    const effectiveDeviceId = resolveCheckInDeviceId(principal, body.deviceId);

    const result = await withIdempotency(
      db,
      {
        key: idempotencyKey,
        tenantId: principal.tenantId,
        requestHash: hashRequest({
          checkInListId: body.checkInListId,
          deviceId: effectiveDeviceId,
          totalChunks: body.totalChunks,
          totalScans: body.totalScans ?? null,
        }),
      },
      async () => {
        const now = new Date();
        const job = (await db
          .insertInto('offline_check_in_sync_jobs')
          .values({
            id: `bcs_${ulid()}`,
            tenant_id: principal.tenantId,
            event_id: list.event_id,
            check_in_list_id: body.checkInListId,
            device_id: effectiveDeviceId,
            requested_by_principal_id: principal.id,
            total_chunks: body.totalChunks,
            total_scans: body.totalScans ?? null,
            chunks_received: 0,
            chunks_processed: 0,
            accepted_count: 0,
            duplicate_count: 0,
            invalid_count: 0,
            sample_errors: JSON.stringify([]),
            status: 'pending',
            failure_message: null,
            attempt_count: 0,
            lease_owner: null,
            leased_until: null,
            next_attempt_at: null,
            last_attempted_at: null,
            last_heartbeat_at: null,
            processing_started_at: null,
            processing_completed_at: null,
            processing_duration_ms: 0,
            transaction_duration_ms: 0,
            lock_wait_ms: 0,
            scan_log_insert_duration_ms: 0,
            ticket_update_duration_ms: 0,
            attendee_update_duration_ms: 0,
            rows_processed: 0,
            clock_warning_count: 0,
            created_at: now,
            updated_at: now,
            completed_at: null,
          })
          .returningAll()
          .executeTakeFirstOrThrow()) as BulkSyncJobRow;

        return { status: 202, body: serializeBulkSyncJob(job) };
      },
    );

    return reply.status(result.status).send(result.body);
  });

  app.put(
    '/check-ins/bulk-sync-jobs/:jobId/chunks/:sequence',
    { bodyLimit: OFFLINE_SYNC_JSON_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const principal = request.principal!;
      ClerkAuthService.requirePermission(principal, 'checkins.write');
      const { jobId, sequence } = request.params as { jobId: string; sequence: string };
      const body = parseBody(bulkSyncChunkSchema, request.body) as {
        scans: { qrHash: string; scannedAt: string; offline: boolean }[];
      };
      const idempotencyKey = request.headers['idempotency-key'];
      if (typeof idempotencyKey !== 'string') {
        throw new ValidationError('Idempotency-Key header is required for bulk sync chunk upload');
      }

      const chunkSequence = parseChunkSequence(sequence);
      const job = await loadAuthorizedBulkSyncJob(db, principal, jobId, loadEvent, {
        requireOwningDevice: true,
      });
      if (chunkSequence > job.total_chunks) {
        throw new ValidationError('Chunk sequence exceeds job totalChunks');
      }

      const normalizedScans = normalizeBulkSyncScans(body.scans);
      const payloadHash = hashBulkSyncChunkPayload(normalizedScans);
      const requestHash = hashRequest({
        jobId,
        sequence: chunkSequence,
        payloadHash,
      });

      const result = await withIdempotency(
        db,
        {
          key: idempotencyKey,
          tenantId: principal.tenantId,
          requestHash,
        },
        async () => {
          return db.transaction().execute(async (trx) => {
            const lockedJob = (await trx
              .selectFrom('offline_check_in_sync_jobs')
              .selectAll()
              .where('id', '=', jobId)
              .forUpdate()
              .executeTakeFirst()) as BulkSyncJobRow | undefined;
            if (!lockedJob) throw new NotFoundError('BulkSyncJob', jobId);
            ClerkAuthService.requireResourceTenant(principal, lockedJob, 'BulkSyncJob', jobId);
            requireBulkSyncJobDeviceAccess(principal, lockedJob, jobId);
            if (chunkSequence > lockedJob.total_chunks) {
              throw new ValidationError('Chunk sequence exceeds job totalChunks');
            }
            const maxJobScans = lockedJob.total_scans ?? MAX_BULK_OFFLINE_SYNC_TOTAL_SCANS;
            const uploadedScanCount = await sumUploadedBulkSyncScans(
              trx as Database,
              lockedJob.id,
              chunkSequence,
            );
            if (uploadedScanCount + body.scans.length > maxJobScans) {
              throw new ValidationError(
                lockedJob.total_scans === null
                  ? 'Uploaded chunk scans exceed maximum bulk sync scan count'
                  : 'Uploaded chunk scans exceed job totalScans',
              );
            }

            const existing = (await trx
              .selectFrom('offline_check_in_sync_chunks')
              .selectAll()
              .where('job_id', '=', jobId)
              .where('sequence', '=', chunkSequence)
              .executeTakeFirst()) as BulkSyncChunkRow | undefined;

            if (existing) {
              if (existing.payload_hash !== payloadHash) {
                throw new ValidationError(
                  'Chunk sequence was already uploaded with different scans',
                );
              }
              return { status: 202, body: serializeBulkSyncChunk(existing) };
            }

            const now = new Date();
            const chunk = (await trx
              .insertInto('offline_check_in_sync_chunks')
              .values({
                id: `bch_${ulid()}`,
                tenant_id: principal.tenantId,
                job_id: jobId,
                sequence: chunkSequence,
                scan_count: normalizedScans.length,
                payload_hash: payloadHash,
                payload: JSON.stringify(normalizedScans),
                accepted_count: 0,
                duplicate_count: 0,
                invalid_count: 0,
                sample_errors: JSON.stringify([]),
                clock_warning_count: 0,
                status: 'uploaded',
                attempt_count: 0,
                failure_message: null,
                locked_at: null,
                processed_at: null,
                created_at: now,
                updated_at: now,
              })
              .returningAll()
              .executeTakeFirstOrThrow()) as BulkSyncChunkRow;

            await trx
              .updateTable('offline_check_in_sync_jobs')
              .set((eb) => ({
                chunks_received: eb('chunks_received', '+', 1),
                status: lockedJob.status === 'pending' ? 'receiving' : lockedJob.status,
                updated_at: now,
              }))
              .where('id', '=', jobId)
              .execute();

            return { status: 202, body: serializeBulkSyncChunk(chunk) };
          });
        },
      );

      scheduleBulkSyncProcessing(db, jobId);
      return reply.status(result.status).send(result.body);
    },
  );

  app.get('/check-ins/bulk-sync-jobs/:jobId', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'checkins.read');
    const { jobId } = request.params as { jobId: string };
    const job = await loadAuthorizedBulkSyncJob(db, principal, jobId, loadEvent, {
      requireOwningDevice: true,
    });
    if (shouldScheduleBulkSyncJob(job)) {
      scheduleBulkSyncProcessing(db, job.id);
    }
    return serializeBulkSyncJob(job);
  });

  app.get('/check-ins/bulk-sync-jobs/:jobId/chunks', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'checkins.read');
    const { jobId } = request.params as { jobId: string };
    await loadAuthorizedBulkSyncJob(db, principal, jobId, loadEvent, {
      requireOwningDevice: true,
    });
    const rows = (await db
      .selectFrom('offline_check_in_sync_chunks')
      .selectAll()
      .where('job_id', '=', jobId)
      .where('tenant_id', '=', principal.tenantId)
      .orderBy('sequence', 'asc')
      .execute()) as BulkSyncChunkRow[];

    return {
      items: rows.map((row) => serializeBulkSyncChunk(row)),
      total: rows.length,
    };
  });
};

function scheduleBulkSyncProcessing(db: Database, jobId: string): void {
  if (scheduledBulkSyncJobs.has(jobId)) {
    pendingBulkSyncJobSchedules.add(jobId);
    return;
  }
  scheduledBulkSyncJobs.add(jobId);
  setTimeout(() => {
    void processPendingBulkSyncChunks(db, jobId)
      .catch(() => {
        // Processing state is persisted on the job row by the worker path.
      })
      .finally(() => {
        scheduledBulkSyncJobs.delete(jobId);
        if (pendingBulkSyncJobSchedules.delete(jobId)) {
          scheduleBulkSyncProcessing(db, jobId);
        }
      });
  }, 0);
}

function shouldScheduleBulkSyncJob(job: BulkSyncJobRow): boolean {
  if (!['receiving', 'failed', 'processing'].includes(job.status)) return false;
  if (job.chunks_received < job.total_chunks) return false;
  if (countValue(job.attempt_count ?? 0) >= BULK_SYNC_MAX_ATTEMPTS) return false;

  const now = Date.now();
  if (job.next_attempt_at && new Date(job.next_attempt_at).getTime() > now) return false;
  if (job.leased_until && new Date(job.leased_until).getTime() > now) return false;
  return true;
}

async function loadAuthorizedBulkSyncJob(
  db: Database,
  principal: Principal,
  jobId: string,
  loadEvent: (eventId: string) => Promise<Record<string, unknown>>,
  options: { requireOwningDevice?: boolean } = {},
): Promise<BulkSyncJobRow> {
  const job = (await db
    .selectFrom('offline_check_in_sync_jobs')
    .selectAll()
    .where('id', '=', jobId)
    .executeTakeFirst()) as BulkSyncJobRow | undefined;
  if (!job) throw new NotFoundError('BulkSyncJob', jobId);
  ClerkAuthService.requireResourceTenant(principal, job, 'BulkSyncJob', jobId);
  if (options.requireOwningDevice) requireBulkSyncJobDeviceAccess(principal, job, jobId);
  const event = await loadEvent(job.event_id);
  requireEventAccess(principal, event, job.event_id);
  return job;
}

function requireBulkSyncJobDeviceAccess(
  principal: Principal,
  job: BulkSyncJobRow,
  jobId: string,
): void {
  if (principal.type === 'mobile_device' && job.device_id !== principal.id) {
    throw new NotFoundError('BulkSyncJob', jobId);
  }
}

function serializeBulkSyncJob(job: BulkSyncJobRow) {
  return {
    id: job.id,
    tenantId: job.tenant_id,
    eventId: job.event_id,
    checkInListId: job.check_in_list_id,
    deviceId: job.device_id,
    totalChunks: job.total_chunks,
    totalScans: job.total_scans,
    chunksReceived: job.chunks_received,
    chunksProcessed: job.chunks_processed,
    status: job.status,
    attemptCount: countValue(job.attempt_count ?? 0),
    nextAttemptAt: toIso(job.next_attempt_at ?? null),
    leasedUntil: toIso(job.leased_until ?? null),
    lastAttemptedAt: toIso(job.last_attempted_at ?? null),
    processingStartedAt: toIso(job.processing_started_at ?? null),
    processingCompletedAt: toIso(job.processing_completed_at ?? null),
    accepted: countValue(job.accepted_count),
    duplicates: countValue(job.duplicate_count),
    invalid: countValue(job.invalid_count),
    processingMetrics: {
      processingDurationMs: countValue(job.processing_duration_ms ?? 0),
      transactionDurationMs: countValue(job.transaction_duration_ms ?? 0),
      lockWaitMs: countValue(job.lock_wait_ms ?? 0),
      scanLogInsertDurationMs: countValue(job.scan_log_insert_duration_ms ?? 0),
      ticketUpdateDurationMs: countValue(job.ticket_update_duration_ms ?? 0),
      attendeeUpdateDurationMs: countValue(job.attendee_update_duration_ms ?? 0),
      rowsProcessed: countValue(job.rows_processed ?? 0),
      clockWarnings: countValue(job.clock_warning_count ?? 0),
    },
    sampleErrors: publicBulkSyncErrorSamples(job.sample_errors),
    failureMessage: publicBulkSyncFailureMessage(job.failure_message),
    createdAt: toIso(job.created_at),
    updatedAt: toIso(job.updated_at),
    completedAt: toIso(job.completed_at),
  };
}

function serializeBulkSyncChunk(chunk: BulkSyncChunkRow) {
  return {
    id: chunk.id,
    jobId: chunk.job_id,
    sequence: chunk.sequence,
    scanCount: chunk.scan_count,
    status: chunk.status,
    accepted: countValue(chunk.accepted_count),
    duplicates: countValue(chunk.duplicate_count),
    invalid: countValue(chunk.invalid_count),
    clockWarnings: countValue(chunk.clock_warning_count ?? 0),
    sampleErrors: publicBulkSyncErrorSamples(chunk.sample_errors),
    attemptCount: chunk.attempt_count,
    failureMessage: publicBulkSyncFailureMessage(chunk.failure_message),
    createdAt: toIso(chunk.created_at),
    updatedAt: toIso(chunk.updated_at),
    processedAt: toIso(chunk.processed_at),
  };
}

function countValue(value: number | string | bigint): number {
  const count = typeof value === 'bigint' ? Number(value) : Number(value);
  return Number.isFinite(count) ? count : 0;
}

function publicBulkSyncErrorSamples(value: unknown): PublicBulkSyncErrorSample[] {
  return parseJsonValue<BulkSyncErrorSample[]>(value, [])
    .slice(0, BULK_SYNC_ERROR_SAMPLE_LIMIT)
    .map((sample) => {
      const publicSample: PublicBulkSyncErrorSample = {
        sequence: sample.sequence,
        scanIndex: sample.scanIndex,
        outcome: sample.outcome,
      };
      if (sample.metadata && typeof sample.metadata === 'object') {
        publicSample.metadata = sample.metadata;
      }
      return publicSample;
    });
}

function publicBulkSyncFailureMessage(message: string | null): string | null {
  return message ? BULK_SYNC_PUBLIC_FAILURE_MESSAGE : null;
}

function parseChunkSequence(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new ValidationError('Chunk sequence must be a positive integer');
  }
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence)) {
    throw new ValidationError('Chunk sequence must be a safe integer');
  }
  return sequence;
}

function normalizeScannedAt(
  value: string,
  now = new Date(),
): Omit<NormalizedOfflineScan, 'qrHash'> {
  const scannedAt = new Date(value);
  if (!value || Number.isNaN(scannedAt.getTime())) {
    throw new ValidationError('scan.scannedAt must be a valid ISO8601 date');
  }

  const clockDriftMs = scannedAt.getTime() - now.getTime();
  if (clockDriftMs > DEVICE_CLOCK_REJECT_FUTURE_MS) {
    throw new ValidationError('scan.scannedAt is too far in the future');
  }

  const normalized: Omit<NormalizedOfflineScan, 'qrHash'> = {
    scannedAt,
    scannedAtIso: value,
  };
  if (clockDriftMs > DEVICE_CLOCK_WARNING_FUTURE_MS) {
    normalized.clockWarning = 'future_device_clock';
    normalized.clockDriftMs = clockDriftMs;
  } else if (Math.abs(clockDriftMs) > DEVICE_CLOCK_STALE_WARNING_MS) {
    normalized.clockWarning = 'stale_device_clock';
    normalized.clockDriftMs = clockDriftMs;
  }
  return normalized;
}

function normalizeBulkSyncScans(
  scans: { qrHash: string; scannedAt: string; offline: boolean }[],
): NormalizedOfflineScan[] {
  const now = new Date();
  return scans.map((scan) => {
    const normalizedScannedAt = normalizeScannedAt(scan.scannedAt, now);
    return {
      qrHash: scan.qrHash,
      offline: scan.offline,
      ...normalizedScannedAt,
    };
  });
}

function hashBulkSyncChunkPayload(scans: NormalizedOfflineScan[]): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        scans.map((scan) => ({
          qrHash: scan.qrHash,
          scannedAt: scan.scannedAtIso,
          offline: scan.offline,
        })),
      ),
    )
    .digest('hex');
}

function metadataWithClockWarning(
  metadata: Record<string, unknown> | undefined,
  scan: Pick<NormalizedOfflineScan, 'clockWarning' | 'clockDriftMs'>,
): Record<string, unknown> | undefined {
  if (!scan.clockWarning) return metadata;
  if (!metadata) {
    return {
      clockWarning: scan.clockWarning,
      clockDriftMs: scan.clockDriftMs ?? null,
    };
  }
  return {
    ...metadata,
    clockWarning: scan.clockWarning,
    clockDriftMs: scan.clockDriftMs ?? null,
  };
}

async function sumUploadedBulkSyncScans(
  db: Database,
  jobId: string,
  excludingSequence: number,
): Promise<number> {
  const rows = (await db
    .selectFrom('offline_check_in_sync_chunks')
    .select('scan_count')
    .where('job_id', '=', jobId)
    .where('sequence', '<>', excludingSequence)
    .execute()) as Array<{ scan_count: number | string | bigint }>;
  return rows.reduce((total, row) => total + countValue(row.scan_count), 0);
}

export async function processPendingBulkSyncJobs(
  db: Database,
  options: BulkSyncWorkerOptions = {},
): Promise<number> {
  const limit = options.limit ?? 25;
  const workerId = options.workerId ?? `api-${process.pid}`;
  const now = new Date();
  const rows = (await db
    .selectFrom('offline_check_in_sync_jobs')
    .selectAll()
    .where('status', 'in', ['receiving', 'failed', 'processing'])
    .whereRef('chunks_received', '>=', 'total_chunks')
    .where('attempt_count', '<', BULK_SYNC_MAX_ATTEMPTS)
    .where((eb) =>
      eb.or([
        eb('leased_until', 'is', null),
        eb('leased_until', '<=', now),
        eb('lease_owner', '=', workerId),
      ]),
    )
    .where((eb) =>
      eb.or([
        eb('status', '<>', 'failed'),
        eb('next_attempt_at', 'is', null),
        eb('next_attempt_at', '<=', now),
      ]),
    )
    .orderBy('updated_at', 'asc')
    .limit(limit)
    .execute()) as BulkSyncJobRow[];

  let processed = 0;
  for (const job of rows) {
    if (job.chunks_received < job.total_chunks) continue;
    if (job.next_attempt_at && new Date(job.next_attempt_at).getTime() > now.getTime()) continue;
    if (
      job.leased_until &&
      new Date(job.leased_until).getTime() > now.getTime() &&
      job.lease_owner !== workerId
    ) {
      continue;
    }
    // eslint-disable-next-line no-await-in-loop -- worker claims are intentionally bounded and sequential.
    await processPendingBulkSyncChunks(db, job.id, { ...options, workerId });
    processed += 1;
  }
  return processed;
}

export async function processPendingBulkSyncChunks(
  db: Database,
  jobId: string,
  options: BulkSyncWorkerOptions = {},
): Promise<void> {
  try {
    await processBulkSyncJob(db, jobId, options);
  } catch (error) {
    await markBulkSyncJobFailed(db, jobId, error);
  }
}

async function claimBulkSyncJobLease(
  db: Database,
  jobId: string,
  options: BulkSyncWorkerOptions,
): Promise<{ job: BulkSyncJobRow; workerId: string; lockWaitMs: number } | null> {
  const workerId = options.workerId ?? `api-${process.pid}`;
  const now = new Date();
  const leasedUntil = new Date(now.getTime() + BULK_SYNC_WORKER_LEASE_MS);
  const lockStartedAt = performance.now();
  const claimed = (await db
    .updateTable('offline_check_in_sync_jobs')
    .set((eb) => ({
      status: 'processing',
      attempt_count: eb('attempt_count', '+', 1),
      lease_owner: workerId,
      leased_until: leasedUntil,
      next_attempt_at: null,
      last_attempted_at: now,
      last_heartbeat_at: now,
      processing_started_at: now,
      processing_completed_at: null,
      failure_message: null,
      updated_at: now,
    }))
    .where('id', '=', jobId)
    .where('status', 'in', ['receiving', 'failed', 'processing'])
    .whereRef('chunks_received', '>=', 'total_chunks')
    .where('attempt_count', '<', BULK_SYNC_MAX_ATTEMPTS)
    .where((eb) =>
      eb.or([
        eb('leased_until', 'is', null),
        eb('leased_until', '<=', now),
        eb('lease_owner', '=', workerId),
      ]),
    )
    .where((eb) =>
      eb.or([
        eb('status', '<>', 'failed'),
        eb('next_attempt_at', 'is', null),
        eb('next_attempt_at', '<=', now),
      ]),
    )
    .returningAll()
    .executeTakeFirst()) as BulkSyncJobRow | undefined;
  const lockWaitMs = Math.round(performance.now() - lockStartedAt);
  if (!claimed) return null;
  if (claimed.status === 'completed') return null;

  return { job: claimed, workerId, lockWaitMs };
}

async function processBulkSyncJob(
  db: Database,
  jobId: string,
  options: BulkSyncWorkerOptions,
): Promise<boolean> {
  const claim = await claimBulkSyncJobLease(db, jobId, options);
  if (!claim) return false;
  const processingStartedAt = new Date();
  const transactionStartedAt = performance.now();
  return db.transaction().execute(async (trx) => {
    let jobQuery = trx.selectFrom('offline_check_in_sync_jobs').selectAll().where('id', '=', jobId);
    if (getDriver() === 'postgres') {
      jobQuery = jobQuery.forUpdate();
    }
    const job = (await jobQuery.executeTakeFirst()) as BulkSyncJobRow | undefined;
    if (!job || job.status === 'completed') return false;
    if (job.lease_owner && job.lease_owner !== claim.workerId) return false;
    if (job.chunks_received < job.total_chunks) return false;

    const list = await new CheckInListRepository(trx as Database).findById(job.check_in_list_id);
    if (!list) throw new NotFoundError('CheckInList', job.check_in_list_id);
    if (list.status !== 'active') throw new ValidationError('Check-in list is not active');

    const chunks = (await trx
      .selectFrom('offline_check_in_sync_chunks')
      .selectAll()
      .where('job_id', '=', job.id)
      .where('tenant_id', '=', job.tenant_id)
      .orderBy('sequence', 'asc')
      .execute()) as BulkSyncChunkRow[];
    if (chunks.length < job.total_chunks) return false;
    if (job.total_scans !== null) {
      const uploadedScanCount = chunks.reduce(
        (total, chunk) => total + countValue(chunk.scan_count),
        0,
      );
      if (uploadedScanCount !== job.total_scans) {
        throw new ValidationError('Uploaded chunk scans do not match job totalScans');
      }
    }
    if (chunks.some((chunk) => chunk.payload === null)) {
      throw new ValidationError('Bulk sync chunk payload is unavailable for retry');
    }

    const now = new Date();
    await trx
      .updateTable('offline_check_in_sync_chunks')
      .set((eb) => ({
        status: 'processing',
        attempt_count: eb('attempt_count', '+', 1),
        failure_message: null,
        locked_at: now,
        updated_at: now,
      }))
      .where('job_id', '=', job.id)
      .where('tenant_id', '=', job.tenant_id)
      .where('status', 'in', ['uploaded', 'processing', 'failed'])
      .execute();
    await trx
      .updateTable('offline_check_in_sync_jobs')
      .set({
        status: 'processing',
        failure_message: null,
        last_heartbeat_at: now,
        leased_until: new Date(now.getTime() + BULK_SYNC_WORKER_LEASE_MS),
        updated_at: now,
      })
      .where('id', '=', job.id)
      .execute();

    const orderedScans = chunks.flatMap((chunk) =>
      parseJsonValue<NormalizedOfflineScan[]>(chunk.payload, []).map((scan, index) =>
        Object.assign({}, scan, {
          scannedAt: new Date(scan.scannedAtIso),
          chunkSequence: chunk.sequence,
          chunkScanIndex: index,
        }),
      ),
    );
    // eslint-disable-next-line unicorn/no-array-sort -- deterministic global offline conflict resolution requires a full-job sort.
    orderedScans.sort(
      (a, b) =>
        a.scannedAt.getTime() - b.scannedAt.getTime() ||
        (a.chunkSequence ?? 0) - (b.chunkSequence ?? 0) ||
        (a.chunkScanIndex ?? 0) - (b.chunkScanIndex ?? 0),
    );

    const chunkSummaries = new Map<
      number,
      {
        accepted: number;
        duplicates: number;
        invalid: number;
        clockWarnings: number;
        errorSamples: BulkSyncErrorSample[];
      }
    >();
    for (const chunk of chunks) {
      chunkSummaries.set(chunk.sequence, {
        accepted: 0,
        duplicates: 0,
        invalid: 0,
        clockWarnings: 0,
        errorSamples: [],
      });
    }
    let accepted = 0;
    let duplicates = 0;
    let invalid = 0;
    const metrics: OfflineSyncBatchMetrics = {
      rowsProcessed: 0,
      clockWarnings: 0,
      scanLogInsertDurationMs: 0,
      ticketUpdateDurationMs: 0,
      attendeeUpdateDurationMs: 0,
    };
    const sampleErrors: BulkSyncErrorSample[] = [];

    for (let offset = 0; offset < orderedScans.length; offset += BULK_SYNC_PROCESSING_BATCH_SIZE) {
      const scanBatch = orderedScans.slice(offset, offset + BULK_SYNC_PROCESSING_BATCH_SIZE);
      // eslint-disable-next-line no-await-in-loop -- each sorted batch observes claims made earlier in the same transaction.
      const result = await processOfflineSyncBatch({
        db: trx as Database,
        tenantId: job.tenant_id,
        list,
        checkInListId: job.check_in_list_id,
        deviceId: job.device_id,
        scans: scanBatch,
      });
      accepted += result.accepted;
      duplicates += result.duplicates;
      invalid += result.invalid;
      metrics.rowsProcessed += result.metrics.rowsProcessed;
      metrics.clockWarnings += result.metrics.clockWarnings;
      metrics.scanLogInsertDurationMs += result.metrics.scanLogInsertDurationMs;
      metrics.ticketUpdateDurationMs += result.metrics.ticketUpdateDurationMs;
      metrics.attendeeUpdateDurationMs += result.metrics.attendeeUpdateDurationMs;
      sampleErrors.push(...result.errorSamples);

      for (const [index, scanResult] of result.results.entries()) {
        const scan = scanBatch[index];
        const sequence = scan.chunkSequence ?? 1;
        const summary = chunkSummaries.get(sequence);
        if (!summary) continue;
        if (scanResult.outcome === 'accepted') summary.accepted += 1;
        else if (scanResult.outcome === 'duplicate') summary.duplicates += 1;
        else summary.invalid += 1;
        if (scan.clockWarning) summary.clockWarnings += 1;
      }
      for (const errorSample of result.errorSamples) {
        const summary = chunkSummaries.get(errorSample.sequence);
        if (summary && summary.errorSamples.length < BULK_SYNC_ERROR_SAMPLE_LIMIT) {
          summary.errorSamples.push(errorSample);
        }
      }
    }

    const completedAt = new Date();
    for (const chunk of chunks) {
      const summary = chunkSummaries.get(chunk.sequence)!;
      // eslint-disable-next-line no-await-in-loop -- per-chunk summaries are bounded by totalChunks and kept explicit for portability.
      await trx
        .updateTable('offline_check_in_sync_chunks')
        .set({
          status: 'processed',
          accepted_count: summary.accepted,
          duplicate_count: summary.duplicates,
          invalid_count: summary.invalid,
          clock_warning_count: summary.clockWarnings,
          sample_errors: JSON.stringify(
            summary.errorSamples.slice(0, BULK_SYNC_ERROR_SAMPLE_LIMIT),
          ),
          payload: null,
          failure_message: null,
          processed_at: completedAt,
          updated_at: completedAt,
        })
        .where('id', '=', chunk.id)
        .where('tenant_id', '=', job.tenant_id)
        .where('status', '=', 'processing')
        .execute();
    }

    const processingDurationMs = completedAt.getTime() - processingStartedAt.getTime();
    const transactionDurationMs = Math.round(performance.now() - transactionStartedAt);
    await trx
      .updateTable('offline_check_in_sync_jobs')
      .set({
        chunks_processed: job.total_chunks,
        accepted_count: accepted,
        duplicate_count: duplicates,
        invalid_count: invalid,
        clock_warning_count: metrics.clockWarnings,
        sample_errors: JSON.stringify(sampleErrors.slice(0, BULK_SYNC_ERROR_SAMPLE_LIMIT)),
        status: 'completed',
        failure_message: null,
        lease_owner: null,
        leased_until: null,
        next_attempt_at: null,
        last_heartbeat_at: completedAt,
        processing_completed_at: completedAt,
        processing_duration_ms: processingDurationMs,
        transaction_duration_ms: transactionDurationMs,
        lock_wait_ms: claim.lockWaitMs,
        scan_log_insert_duration_ms: metrics.scanLogInsertDurationMs,
        ticket_update_duration_ms: metrics.ticketUpdateDurationMs,
        attendee_update_duration_ms: metrics.attendeeUpdateDurationMs,
        rows_processed: metrics.rowsProcessed,
        updated_at: completedAt,
        completed_at: completedAt,
      })
      .where('id', '=', job.id)
      .execute();

    return true;
  });
}

async function markBulkSyncJobFailed(db: Database, jobId: string, _error?: unknown): Promise<void> {
  const job = (await db
    .selectFrom('offline_check_in_sync_jobs')
    .selectAll()
    .where('id', '=', jobId)
    .executeTakeFirst()) as BulkSyncJobRow | undefined;
  if (!job || job.status === 'completed') return;

  const now = new Date();
  const attemptCount = countValue(job.attempt_count ?? 0);
  const retryDelayMs = Math.min(
    BULK_SYNC_RETRY_BASE_MS * Math.pow(2, Math.max(0, attemptCount - 1)),
    BULK_SYNC_RETRY_MAX_MS,
  );
  const nextAttemptAt =
    attemptCount >= BULK_SYNC_MAX_ATTEMPTS ? null : new Date(now.getTime() + retryDelayMs);
  await db
    .updateTable('offline_check_in_sync_chunks')
    .set({
      status: 'failed',
      failure_message: BULK_SYNC_PUBLIC_FAILURE_MESSAGE,
      updated_at: now,
    })
    .where('job_id', '=', jobId)
    .where('tenant_id', '=', job.tenant_id)
    .where('status', 'in', ['uploaded', 'processing', 'failed'])
    .execute();
  await db
    .updateTable('offline_check_in_sync_jobs')
    .set({
      status: 'failed',
      failure_message: BULK_SYNC_PUBLIC_FAILURE_MESSAGE,
      lease_owner: null,
      leased_until: null,
      next_attempt_at: nextAttemptAt,
      processing_completed_at: now,
      last_heartbeat_at: now,
      updated_at: now,
    })
    .where('id', '=', jobId)
    .execute();
}

function resolveCheckInDeviceId(
  principal: NonNullable<import('fastify').FastifyRequest['principal']>,
  requestedDeviceId?: string,
): string {
  if (principal.type === 'mobile_device') {
    if (requestedDeviceId && requestedDeviceId !== principal.id) {
      throw new ValidationError('Scanner device cannot submit scans for another device');
    }
    return principal.id;
  }
  return principal.id;
}

async function processOfflineSyncBatch(input: {
  db: Database;
  tenantId: string;
  list: CheckInListRow;
  checkInListId: string;
  deviceId: string;
  scans: NormalizedOfflineScan[];
  resultSequence?: number;
}): Promise<{
  accepted: number;
  duplicates: number;
  invalid: number;
  results: { qrHash: string; outcome: string }[];
  errorSamples: BulkSyncErrorSample[];
  metrics: OfflineSyncBatchMetrics;
}> {
  const allowedTicketTypeIds = new Set(parseJsonValue<string[]>(input.list.ticket_type_ids, []));
  const ticketsByQrHash = await loadTicketsByQrHash(
    input.db,
    input.tenantId,
    input.list.event_id,
    input.scans.map((scan) => scan.qrHash),
  );
  const results: OfflineScanResult[] = [];
  const acceptedCandidates: AcceptedCandidate[] = [];
  const acceptedTicketIdsInBatch = new Set<string>();

  for (const scan of input.scans) {
    const ticket = ticketsByQrHash.get(scan.qrHash);
    const result = classifyOfflineScan({
      list: input.list,
      allowedTicketTypeIds,
      ticket,
      qrHash: scan.qrHash,
    });

    if (result.outcome === 'accepted') {
      if (result.ticketId && !acceptedTicketIdsInBatch.has(result.ticketId)) {
        acceptedTicketIdsInBatch.add(result.ticketId);
        acceptedCandidates.push({
          ticketId: result.ticketId,
          attendeeId: ticket!.attendee_id,
          scannedAt: scan.scannedAt,
          resultIndex: results.length,
        });
      } else {
        result.outcome = 'duplicate';
      }
    }

    results.push(result);
  }

  const ticketUpdateStartedAt = performance.now();
  const acceptedTicketIds = await bulkCheckInTickets(input.db, acceptedCandidates, input.deviceId);
  const ticketUpdateDurationMs = Math.round(performance.now() - ticketUpdateStartedAt);
  const acceptedCandidatesByTicketId = new Map(
    acceptedCandidates.map((candidate) => [candidate.ticketId, candidate]),
  );
  for (const candidate of acceptedCandidates) {
    if (!acceptedTicketIds.has(candidate.ticketId)) {
      results[candidate.resultIndex] = {
        ...results[candidate.resultIndex],
        outcome: 'duplicate',
      };
    }
  }

  const attendeeUpdateStartedAt = performance.now();
  await bulkCheckInAttendees(
    input.db,
    [...acceptedTicketIds].map((ticketId) => acceptedCandidatesByTicketId.get(ticketId)!),
    input.deviceId,
  );
  const attendeeUpdateDurationMs = Math.round(performance.now() - attendeeUpdateStartedAt);
  const scanLogInsertStartedAt = performance.now();
  await bulkInsertOfflineScanLogs({
    db: input.db,
    tenantId: input.tenantId,
    checkInListId: input.checkInListId,
    deviceId: input.deviceId,
    scans: input.scans,
    results,
  });
  const scanLogInsertDurationMs = Math.round(performance.now() - scanLogInsertStartedAt);

  const counts = results.reduce(
    (accumulator, result) => {
      if (result.outcome === 'accepted') accumulator.accepted += 1;
      else if (result.outcome === 'duplicate') accumulator.duplicates += 1;
      else accumulator.invalid += 1;
      return accumulator;
    },
    { accepted: 0, duplicates: 0, invalid: 0 },
  );
  const errorSamples = results
    .map((result, index) => ({ result, index }))
    .filter(({ result }) => result.outcome !== 'accepted' && result.outcome !== 'duplicate')
    .slice(0, BULK_SYNC_ERROR_SAMPLE_LIMIT)
    .map(({ result, index }) => {
      const scan = input.scans[index];
      const sample: BulkSyncErrorSample = {
        sequence: scan?.chunkSequence ?? input.resultSequence ?? 1,
        scanIndex: scan?.chunkScanIndex ?? index,
        qrHash: result.qrHash ?? scan?.qrHash ?? '',
        outcome: result.outcome,
      };
      if (result.metadata) sample.metadata = result.metadata;
      return sample;
    });

  return {
    ...counts,
    results: results.map((result) => ({ qrHash: result.qrHash, outcome: result.outcome })),
    errorSamples,
    metrics: {
      rowsProcessed: input.scans.length,
      clockWarnings: input.scans.filter((scan) => scan.clockWarning).length,
      scanLogInsertDurationMs,
      ticketUpdateDurationMs,
      attendeeUpdateDurationMs,
    },
  };
}

function classifyOfflineScan(input: {
  list: CheckInListRow;
  allowedTicketTypeIds: Set<string>;
  ticket?: TicketRow;
  qrHash: string;
}): OfflineScanResult {
  const { list, allowedTicketTypeIds, ticket, qrHash } = input;

  if (!ticket) {
    return { outcome: 'not_found', qrHash };
  }
  if (ticket.qr_hash !== qrHash) {
    return {
      outcome: 'invalid',
      ticketId: ticket.id,
      qrHash,
      metadata: { reason: 'hash_mismatch' },
    };
  }
  if (ticket.event_id !== list.event_id) {
    return { outcome: 'wrong_event', ticketId: ticket.id, qrHash };
  }
  if (list.event_occurrence_id && ticket.event_occurrence_id !== list.event_occurrence_id) {
    return {
      outcome: 'wrong_list',
      ticketId: ticket.id,
      qrHash,
      metadata: {
        reason: 'wrong_event_occurrence',
        expectedEventOccurrenceId: list.event_occurrence_id,
        actualEventOccurrenceId: ticket.event_occurrence_id ?? null,
      },
    };
  }
  if (allowedTicketTypeIds.size > 0 && !allowedTicketTypeIds.has(ticket.ticket_type_id)) {
    return { outcome: 'wrong_list', ticketId: ticket.id, qrHash };
  }
  if (ticket.status === 'void' || ticket.status === 'refunded' || ticket.status === 'transferred') {
    return { outcome: 'revoked', ticketId: ticket.id, qrHash };
  }
  if (ticket.status === 'valid') {
    return { outcome: 'accepted', ticketId: ticket.id, qrHash };
  }
  return { outcome: 'duplicate', ticketId: ticket.id, qrHash };
}

async function loadTicketsByQrHash(
  db: Database,
  tenantId: string,
  eventId: string,
  qrHashes: string[],
): Promise<Map<string, TicketRow>> {
  const ticketsByQrHash = new Map<string, TicketRow>();
  const uniqueQrHashes = [...new Set(qrHashes)];

  for (let offset = 0; offset < uniqueQrHashes.length; offset += OFFLINE_SYNC_DB_CHUNK_SIZE) {
    const chunk = uniqueQrHashes.slice(offset, offset + OFFLINE_SYNC_DB_CHUNK_SIZE);
    if (chunk.length === 0) continue;
    // eslint-disable-next-line no-await-in-loop -- chunking avoids oversized `IN` predicates on max-sized offline batches.
    const tickets = await db
      .selectFrom('tickets')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('event_id', '=', eventId)
      .where('qr_hash', 'in', chunk)
      .execute();
    for (const ticket of tickets) {
      if (ticket.tenant_id === tenantId && ticket.event_id === eventId) {
        ticketsByQrHash.set(ticket.qr_hash, ticket as TicketRow);
      }
    }
  }

  return ticketsByQrHash;
}

async function bulkCheckInTickets(
  db: Database,
  candidates: AcceptedCandidate[],
  deviceId: string,
): Promise<Set<string>> {
  const acceptedTicketIds = new Set<string>();
  const isPostgres = getDriver() === 'postgres';

  for (let offset = 0; offset < candidates.length; offset += OFFLINE_SYNC_DB_CHUNK_SIZE) {
    const chunk = candidates.slice(offset, offset + OFFLINE_SYNC_DB_CHUNK_SIZE);
    const ticketIds = chunk.map((candidate) => candidate.ticketId);
    const checkedInAt = chunk[0]?.scannedAt;
    if (!checkedInAt || ticketIds.length === 0) continue;

    const update = db
      .updateTable('tickets')
      .set({
        status: 'checked_in',
        checked_in_at: scannedAtCase('id', chunk, (candidate) => candidate.ticketId),
        checked_in_by_device_id: deviceId,
        updated_at: new Date(),
      })
      .where('id', 'in', ticketIds)
      .where('status', '=', 'valid');

    if (isPostgres) {
      // eslint-disable-next-line no-await-in-loop -- each chunk is a bounded conditional update.
      const rows = await update.returning('id').execute();
      for (const row of rows) acceptedTicketIds.add(row.id);
    } else {
      for (const candidate of chunk) {
        // eslint-disable-next-line no-await-in-loop -- dialects without RETURNING must claim each row from affected-row evidence.
        const result = await db
          .updateTable('tickets')
          .set({
            status: 'checked_in',
            checked_in_at: candidate.scannedAt,
            checked_in_by_device_id: deviceId,
            updated_at: new Date(),
          })
          .where('id', '=', candidate.ticketId)
          .where('status', '=', 'valid')
          .executeTakeFirst();
        if (Number(result.numUpdatedRows ?? 0) === 1) {
          acceptedTicketIds.add(candidate.ticketId);
        }
      }
    }
  }

  return acceptedTicketIds;
}

async function bulkCheckInAttendees(
  db: Database,
  acceptedCandidates: AcceptedCandidate[],
  deviceId: string,
): Promise<void> {
  for (let offset = 0; offset < acceptedCandidates.length; offset += OFFLINE_SYNC_DB_CHUNK_SIZE) {
    const chunk = acceptedCandidates.slice(offset, offset + OFFLINE_SYNC_DB_CHUNK_SIZE);
    const attendeeIds = chunk.map((candidate) => candidate.attendeeId);
    const checkedInAt = chunk[0]?.scannedAt;
    if (!checkedInAt || attendeeIds.length === 0) continue;

    // eslint-disable-next-line no-await-in-loop -- each chunk updates attendees for tickets won by the preceding conditional ticket update.
    await db
      .updateTable('attendees')
      .set({
        status: 'checked_in',
        checked_in_at: scannedAtCase('id', chunk, (candidate) => candidate.attendeeId),
        check_in_device_id: deviceId,
        updated_at: new Date(),
      })
      .where('id', 'in', attendeeIds)
      .execute();
  }
}

function scannedAtCase(
  idColumn: string,
  candidates: AcceptedCandidate[],
  idForCandidate: (candidate: AcceptedCandidate) => string,
) {
  return sql<Date>`case ${sql.ref(idColumn)} ${sql.join(
    candidates.map(
      (candidate) => sql`when ${idForCandidate(candidate)} then ${candidate.scannedAt}`,
    ),
    sql` `,
  )} else ${sql.ref('checked_in_at')} end`;
}

async function bulkInsertOfflineScanLogs(input: {
  db: Database;
  tenantId: string;
  checkInListId: string;
  deviceId: string;
  scans: NormalizedOfflineScan[];
  results: OfflineScanResult[];
}): Promise<void> {
  for (let offset = 0; offset < input.scans.length; offset += OFFLINE_SYNC_DB_CHUNK_SIZE) {
    const scanChunk = input.scans.slice(offset, offset + OFFLINE_SYNC_DB_CHUNK_SIZE);
    const rows = scanChunk.map((scan, index) => {
      const result = input.results[offset + index];
      const metadata = metadataWithClockWarning(result.metadata, scan);
      return {
        id: `scan_${ulid()}`,
        tenant_id: input.tenantId,
        check_in_list_id: input.checkInListId,
        device_id: input.deviceId,
        ticket_id: result.ticketId ?? null,
        qr_hash: scan.qrHash,
        outcome: result.outcome,
        scanned_at: scan.scannedAt,
        synced_at: null,
        offline: true,
        metadata: metadata ? JSON.stringify(metadata) : null,
        created_at: new Date(),
      };
    });
    if (rows.length === 0) continue;

    // eslint-disable-next-line no-await-in-loop -- chunked inserts keep max-sized sync under query parameter limits.
    await input.db.insertInto('scan_logs').values(rows).execute();
  }
}

export async function processScan(input: {
  ticketRepo: TicketRepository;
  tenantId: string;
  list: Awaited<ReturnType<CheckInListRepository['findById']>> & {};
  qrHash: string;
  deviceId: string;
  scannedAt: Date;
  verification?: { valid: boolean; ticketId?: string };
  requireVerifiedTicketId: boolean;
}): Promise<{
  outcome: string;
  ticketId?: string;
  qrHash: string;
  metadata?: Record<string, unknown>;
}> {
  const allowedTicketTypeIds = new Set(parseJsonValue<string[]>(input.list.ticket_type_ids, []));

  if (
    input.requireVerifiedTicketId &&
    (!input.verification?.valid || !input.verification.ticketId)
  ) {
    return { outcome: 'invalid', qrHash: input.qrHash, metadata: { reason: 'signature_invalid' } };
  }

  const ticket = input.requireVerifiedTicketId
    ? await input.ticketRepo.findById(input.verification!.ticketId!)
    : await input.ticketRepo.findByQrHash(input.qrHash);

  if (!ticket) {
    return { outcome: 'not_found', qrHash: input.qrHash };
  }
  if (ticket.tenant_id !== input.tenantId) {
    return { outcome: 'not_found', qrHash: input.qrHash };
  }
  if (ticket.qr_hash !== input.qrHash) {
    return {
      outcome: 'invalid',
      ticketId: ticket.id,
      qrHash: input.qrHash,
      metadata: { reason: 'hash_mismatch' },
    };
  }
  if (ticket.event_id !== input.list.event_id) {
    return { outcome: 'wrong_event', ticketId: ticket.id, qrHash: input.qrHash };
  }
  if (
    input.list.event_occurrence_id &&
    ticket.event_occurrence_id !== input.list.event_occurrence_id
  ) {
    return {
      outcome: 'wrong_list',
      ticketId: ticket.id,
      qrHash: input.qrHash,
      metadata: {
        reason: 'wrong_event_occurrence',
        expectedEventOccurrenceId: input.list.event_occurrence_id,
        actualEventOccurrenceId: ticket.event_occurrence_id ?? null,
      },
    };
  }
  if (allowedTicketTypeIds.size > 0 && !allowedTicketTypeIds.has(ticket.ticket_type_id)) {
    return { outcome: 'wrong_list', ticketId: ticket.id, qrHash: input.qrHash };
  }
  if (ticket.status === 'void' || ticket.status === 'refunded' || ticket.status === 'transferred') {
    return { outcome: 'revoked', ticketId: ticket.id, qrHash: input.qrHash };
  }
  if (ticket.status === 'valid') {
    const won = await input.ticketRepo.checkInIfValid(ticket.id, input.deviceId, input.scannedAt);
    return { outcome: won ? 'accepted' : 'duplicate', ticketId: ticket.id, qrHash: input.qrHash };
  }
  return { outcome: 'duplicate', ticketId: ticket.id, qrHash: input.qrHash };
}

type OfflineManifestTicketRow = {
  ticket_id: string;
  ticket_type_id: string;
  event_occurrence_id?: string | null;
  qr_hash: string;
  status: string;
  first_name: string | null;
  last_name: string | null;
  email: string;
};

type SignedOfflineManifest = {
  eventId: string;
  checkInListId: string;
  generatedAt: string;
  expiresAt: string;
  keyId: string;
  signature: string;
  tickets: {
    ticketId: string;
    ticketTypeId: string;
    eventOccurrenceId?: string;
    attendeeName: string;
    qrHash: string;
    status: string;
  }[];
};

function getManifestSigningKey(): string {
  const configuredKey = process.env.OFFLINE_MANIFEST_SIGNING_KEY ?? process.env.QR_SIGNING_SECRET;
  if (!configuredKey && process.env.NODE_ENV === 'production') {
    throw new Error('OFFLINE_MANIFEST_SIGNING_KEY or QR_SIGNING_SECRET is required in production');
  }
  return configuredKey ?? 'tixkit-manifest-secret-dev-only';
}

function getManifestKeyId(): string {
  return process.env.OFFLINE_MANIFEST_KEY_ID ?? 'manifest:v1';
}

export function buildOfflineManifest(input: {
  eventId: string;
  checkInListId: string;
  rows: OfflineManifestTicketRow[];
  generatedAt?: Date;
  ttlMs?: number;
}): SignedOfflineManifest {
  const generatedAt = input.generatedAt ?? new Date();
  const expiresAt = new Date(generatedAt.getTime() + (input.ttlMs ?? 24 * 60 * 60 * 1000));
  const keyId = getManifestKeyId();
  const signingKey = getManifestSigningKey();

  const tickets = input.rows.map((row) => {
    // Drop plaintext email; use only attendeeName (first + last name, no email fallback)
    // to minimize PII exposure in offline manifests.
    const attendeeName = [row.first_name, row.last_name].filter(Boolean).join(' ').trim() || '';
    return {
      ticketId: row.ticket_id,
      ticketTypeId: row.ticket_type_id,
      eventOccurrenceId: row.event_occurrence_id ?? undefined,
      attendeeName,
      qrHash: row.qr_hash,
      status: row.status,
    };
  });

  // Build the manifest payload for signing (excluding the signature field itself).
  const manifestPayload = {
    eventId: input.eventId,
    checkInListId: input.checkInListId,
    generatedAt: generatedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    keyId,
    tickets,
  };

  const signature = createHmac('sha256', signingKey)
    .update(JSON.stringify(manifestPayload))
    .digest('hex');

  return {
    ...manifestPayload,
    signature,
  };
}

/**
 * Verifies the HMAC signature on a signed offline manifest.
 * Returns true if the signature is valid.
 */
export function verifyOfflineManifestSignature(manifest: {
  eventId: string;
  checkInListId: string;
  generatedAt: string;
  expiresAt: string;
  keyId: string;
  signature: string;
  tickets: unknown[];
}): boolean {
  const signingKey = getManifestSigningKey();
  const { signature, ...payload } = manifest;
  if (!/^[0-9a-f]{64}$/i.test(signature)) {
    return false;
  }
  const expectedSignature = createHmac('sha256', signingKey)
    .update(JSON.stringify(payload))
    .digest('hex');

  return timingSafeEqual(Buffer.from(expectedSignature, 'hex'), Buffer.from(signature, 'hex'));
}
