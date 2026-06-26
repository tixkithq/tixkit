import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { createHmac } from 'node:crypto';
import { ClerkAuthService } from '../../auth/clerk.js';
import {
  EventRepository,
  TicketRepository,
  CheckInListRepository,
  ScanLogRepository,
  AttendeeRepository,
} from '@gatekit/db';
import { NotFoundError, ValidationError } from '@gatekit/domain';
import type { ScanRequest, SyncScanInput } from '@gatekit/domain';
import { withIdempotency, hashRequest } from '../../services/idempotency.js';
import {
  pageEnvelope,
  parseJsonValue,
  parsePagination,
  pickAllowedFields,
  serializeAttendee,
  serializeCheckInList,
  serializeTicket,
} from '../../http/contracts.js';
import { scanSchema, syncScanSchema, updateAttendeeSchema, transferTicketSchema, parseBody } from '../../http/schemas.js';

export const checkInRoutes: FastifyPluginAsync = async (app) => {
  const db = app.context.db;

  const loadEvent = async (eventId: string) => {
    const eventRepo = new EventRepository(db);
    const event = await eventRepo.findById(eventId);
    if (!event) throw new NotFoundError('Event', eventId);
    return event;
  };

  const requireEventAccess = (principal: NonNullable<FastifyRequest['principal']>, event: Record<string, unknown>, eventId: string) => {
    ClerkAuthService.requireResourceTenant(principal, event, 'Event', eventId);
    ClerkAuthService.requireOrganizationScope(principal, event.organization_id as string | undefined);
    ClerkAuthService.requireBrandScope(principal, event.brand_id as string | undefined);
    ClerkAuthService.requireEventScope(principal, eventId);
  };

  app.get('/events/:eventId/attendees', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'attendees.read');
    const { eventId } = request.params as { eventId: string };
    const pagination = parsePagination(request.query);
    const event = await loadEvent(eventId);
    requireEventAccess(principal, event, eventId);
    const repo = new AttendeeRepository(db);
    const rows = await repo.findByEvent(eventId, pagination.limit + 1, pagination.cursor, principal.tenantId);
    return pageEnvelope(rows.map((row) => serializeAttendee(row)), pagination.limit);
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
    if (pagination.cursor) query = query.where('id', '>', pagination.cursor);
    const rows = await query.execute();
    return pageEnvelope(rows.map((row) => serializeAttendee(row)), pagination.limit);
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
    const updateData = pickAllowedFields(body, ['firstName', 'lastName', 'email', 'phone', 'status'], {
      firstName: 'first_name',
      lastName: 'last_name',
    });
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
        if (ticket.status !== 'valid') {
          throw new ValidationError(`Ticket status is ${ticket.status}, cannot transfer`);
        }

        const updated = await ticketRepo.update(ticketId, {
          status: 'transferred',
          transferred_to_email: body.toEmail,
          transferred_at: new Date(),
        });

        return { status: 200, body: updated };
      },
    );

    return reply.status(result.status).send(
      result.status === 200 ? serializeTicket(result.body as Record<string, unknown>) : result.body,
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
    return pageEnvelope(rows.map((row) => serializeCheckInList(row)), pagination.limit);
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

    const rows = await ticketQuery.execute();
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
        list,
        qrHash: qrService.hashPayload(body.qrPayload!),
        verification: qrService.getQrPayload(body.qrPayload!),
        deviceId: effectiveDeviceId,
        scannedAt: new Date(body.scannedAt!),
        requireVerifiedTicketId: true,
      });

      await scanRepo.create({
        tenantId: principal.tenantId,
        checkInListId: body.checkInListId!,
        deviceId: effectiveDeviceId,
        ticketId: result.ticketId,
        qrHash: result.qrHash,
        outcome: result.outcome,
        scannedAt: new Date(body.scannedAt!),
        offline: body.offline ?? false,
        metadata: result.metadata,
      });

      return {
        status: 200,
        body: {
          outcome: result.outcome,
          ticketId: result.ticketId,
          message: result.outcome === 'accepted' ? 'Check-in successful' : `Check-in ${result.outcome}`,
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

  app.post('/check-ins/sync', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'checkins.write');
    const body = parseBody(syncScanSchema, request.body) as SyncScanInput;
    const idempotencyKey = request.headers['idempotency-key'];
    if (typeof idempotencyKey !== 'string') {
      throw new ValidationError('Idempotency-Key header is required for offline scan sync');
    }
    if (!body.checkInListId) throw new ValidationError('checkInListId is required');
    if (!Array.isArray(body.scans)) throw new ValidationError('scans must be an array');

    const ticketRepo = new TicketRepository(db);
    const scanRepo = new ScanLogRepository(db);
    const listRepo = new CheckInListRepository(db);

    const list = await listRepo.findById(body.checkInListId);
    if (!list) throw new NotFoundError('CheckInList', body.checkInListId);
    const event = await loadEvent(list.event_id);
    requireEventAccess(principal, event, list.event_id);
    if (list.status !== 'active') throw new ValidationError('Check-in list is not active');
    const effectiveDeviceId = resolveCheckInDeviceId(principal, body.deviceId);

    // Deterministic conflict resolution: sort by scannedAt so the earliest
    // offline scan wins the check-in; later scans for the same ticket become
    // duplicates. The idempotency guard below prevents replayed batches from
    // writing duplicate scan logs.
    const sortedScans = [...body.scans].sort(
      (a, b) => new Date(a.scannedAt).getTime() - new Date(b.scannedAt).getTime(),
    );

    for (const scan of sortedScans) {
      if (!scan.qrHash) throw new ValidationError('scan.qrHash is required');
      if (!scan.scannedAt || Number.isNaN(new Date(scan.scannedAt).getTime())) {
        throw new ValidationError('scan.scannedAt must be a valid ISO8601 date');
      }
    }

    const requestHash = hashRequest({
      checkInListId: body.checkInListId,
      deviceId: effectiveDeviceId,
      scans: sortedScans.map((scan) => ({
        qrHash: scan.qrHash,
        scannedAt: scan.scannedAt,
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
        const results: { qrHash: string; outcome: string }[] = [];
        let accepted = 0;
        let duplicates = 0;
        let invalid = 0;

        for (const scan of sortedScans) {
          const scanResult = await processScan({
            ticketRepo,
            list,
            qrHash: scan.qrHash,
            deviceId: effectiveDeviceId,
            scannedAt: new Date(scan.scannedAt),
            requireVerifiedTicketId: false,
          });

          if (scanResult.outcome === 'accepted') accepted++;
          else if (scanResult.outcome === 'duplicate') duplicates++;
          else invalid++;

          await scanRepo.create({
            tenantId: principal.tenantId,
            checkInListId: body.checkInListId,
            deviceId: effectiveDeviceId,
            ticketId: scanResult.ticketId,
            qrHash: scan.qrHash,
            outcome: scanResult.outcome,
            scannedAt: new Date(scan.scannedAt),
            offline: true,
            metadata: scanResult.metadata,
          });

          results.push({ qrHash: scan.qrHash, outcome: scanResult.outcome });
        }

        return { status: 200, body: { accepted, duplicates, invalid, results } };
      },
    );

    return reply.status(syncResult.status).send(syncResult.body);
  });
};

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
  return requestedDeviceId ?? principal.id;
}

export async function processScan(input: {
  ticketRepo: TicketRepository;
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

  if (input.requireVerifiedTicketId && (!input.verification?.valid || !input.verification.ticketId)) {
    return { outcome: 'invalid', qrHash: input.qrHash, metadata: { reason: 'signature_invalid' } };
  }

  const ticket = input.requireVerifiedTicketId
    ? await input.ticketRepo.findById(input.verification!.ticketId!)
    : await input.ticketRepo.findByQrHash(input.qrHash);

  if (!ticket) {
    return { outcome: 'not_found', qrHash: input.qrHash };
  }
  if (ticket.qr_hash !== input.qrHash) {
    return { outcome: 'invalid', ticketId: ticket.id, qrHash: input.qrHash, metadata: { reason: 'hash_mismatch' } };
  }
  if (ticket.event_id !== input.list.event_id) {
    return { outcome: 'wrong_event', ticketId: ticket.id, qrHash: input.qrHash };
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
    attendeeName: string;
    qrHash: string;
    status: string;
  }[];
};

function getManifestSigningKey(): string {
  return process.env.OFFLINE_MANIFEST_SIGNING_KEY ?? process.env.QR_SIGNING_SECRET ?? 'gatekit-manifest-secret-dev-only';
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
  const expectedSignature = createHmac('sha256', signingKey)
    .update(JSON.stringify(payload))
    .digest('hex');

  const a = Buffer.from(expectedSignature, 'hex');
  const b = Buffer.from(signature, 'hex');
  if (a.length !== b.length) return false;
  return a.equals(b);
}
