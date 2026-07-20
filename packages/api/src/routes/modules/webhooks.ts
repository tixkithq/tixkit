import type { FastifyPluginAsync } from 'fastify';
import type { Principal } from '@tixkit/domain';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { ClerkAuthService } from '../../auth/clerk.js';
import {
  AuditLogRepository,
  WebhookDeliveryRepository,
  WebhookEndpointRepository,
  WebhookEventRepository,
  WebhookReplayRequestRepository,
  type Database,
} from '@tixkit/db';
import {
  ForbiddenError,
  IdempotencyConflictError,
  NotFoundError,
  ValidationError,
} from '@tixkit/domain';
import { writeAuditLog } from '../../auth/audit.js';
import {
  pageEnvelope,
  parsePagination,
  serializeWebhookEndpoint,
  serializeWebhookEvent,
} from '../../http/contracts.js';
import {
  createWebhookEndpointSchema,
  updateWebhookEndpointSchema,
  parseBody,
} from '../../http/schemas.js';
import {
  createWebhookTestPayload,
  isWebhookTestPayload,
  WEBHOOK_TEST_API_VERSION,
  WEBHOOK_TEST_EVENT_TYPE,
} from '../../services/webhook-test.js';
import { hashRequest, withIdempotency } from '../../services/idempotency.js';

const scopedWebhookEndpointManagementMessage =
  'Scoped principals cannot manage organization-wide webhook endpoints';
const expiredWebhookEndpointSecretReplay = Object.freeze({
  status: 409,
  body: Object.freeze({
    error: Object.freeze({
      code: 'WEBHOOK_ENDPOINT_SECRET_REPLAY_EXPIRED',
      message:
        'The one-time webhook signing secret replay window expired. Create or rotate the endpoint to recover a secret.',
    }),
  }),
});

function requireOrganizationWideWebhookEndpointPrincipal(principal: Principal) {
  if (principal.brandIds?.length || principal.eventIds?.length) {
    throw new ForbiddenError(scopedWebhookEndpointManagementMessage);
  }
}

function requireWebhookIdempotencyKey(headers: Record<string, unknown>): string {
  const value = headers['idempotency-key'];
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 128 ||
    value.trim() !== value ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint <= 31 || codePoint === 127;
    })
  ) {
    throw new ValidationError('Idempotency-Key header must be 1-128 printable characters');
  }
  return value;
}

async function loadWebhookOrganization(
  db: Database,
  principal: Principal,
  organizationId: string,
  lock = false,
) {
  let query = db.selectFrom('organizations').selectAll().where('id', '=', organizationId);
  if (lock) query = query.forUpdate();
  const organization = await query.executeTakeFirst();
  if (!organization) throw new NotFoundError('Organization', organizationId);
  ClerkAuthService.requireResourceTenant(principal, organization, 'Organization', organizationId);
  ClerkAuthService.requireOrganizationScope(principal, organizationId);
  return organization;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function webhookEndpointAuditSnapshot(endpoint: {
  description?: string | null;
  events: unknown;
  status: string;
  url: string;
}) {
  return {
    urlSha256: sha256(endpoint.url),
    events: parseWebhookEndpointEvents(endpoint.events),
    status: endpoint.status,
    descriptionSha256:
      endpoint.description === null || endpoint.description === undefined
        ? null
        : sha256(endpoint.description),
  };
}

function parseReplayEndpointIds(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((endpointId) => typeof endpointId === 'string')) {
    throw new Error('Stored webhook replay endpoint snapshot is invalid');
  }
  return parsed;
}

export const webhookRoutes: FastifyPluginAsync = async (app) => {
  const db = app.context.db;
  const temporalClient = app.context.temporalClient;

  app.post('/webhook-endpoints', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'developers.write');
    requireOrganizationWideWebhookEndpointPrincipal(principal);
    const body = parseBody(createWebhookEndpointSchema, request.body);

    ClerkAuthService.requireOrganizationScope(principal, body.organizationId);
    await loadWebhookOrganization(db, principal, body.organizationId);
    const rawIdempotencyKey = requireWebhookIdempotencyKey(request.headers);
    const idempotencyKey = hashRequest({
      operation: 'webhook_endpoint.create',
      principal: { type: principal.type, id: principal.id },
      key: rawIdempotencyKey,
    });

    const result = await withIdempotency(
      db,
      {
        key: idempotencyKey,
        tenantId: principal.tenantId,
        requestHash: hashRequest({
          operation: 'webhook_endpoint.create',
          principal: { type: principal.type, id: principal.id },
          body,
        }),
        ttlSeconds: 86_400,
        discardErrorCodes: ['FORBIDDEN', 'NOT_FOUND'],
        completedRecordExpiry: { tombstone: expiredWebhookEndpointSecretReplay },
      },
      async ({ completeInTransaction }) => {
        let responseBody: ReturnType<typeof serializeWebhookEndpoint> | undefined;
        await db.transaction().execute(async (transaction) => {
          await loadWebhookOrganization(transaction, principal, body.organizationId, true);
          const created = await new WebhookEndpointRepository(transaction).create({
            tenantId: principal.tenantId,
            organizationId: body.organizationId,
            url: body.url,
            events: body.events,
            description: body.description,
          });
          responseBody = serializeWebhookEndpoint(created, true);
          await writeAuditLog(
            new AuditLogRepository(transaction),
            request,
            principal,
            {
              action: 'webhook_endpoint.created',
              organizationId: body.organizationId,
              resourceType: 'WebhookEndpoint',
              resourceId: created.id as string,
              diffSummary: { after: webhookEndpointAuditSnapshot(created) },
            },
            { failClosed: true },
          );
          await completeInTransaction(transaction, { status: 201, body: responseBody });
        });
        if (!responseBody) throw new Error('Webhook endpoint transaction produced no response');
        return { status: 201, body: responseBody };
      },
    );

    return reply
      .header('cache-control', 'private, no-store')
      .header('pragma', 'no-cache')
      .status(result.status)
      .send(result.body);
  });

  app.patch('/webhook-endpoints/:endpointId', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'developers.write');
    requireOrganizationWideWebhookEndpointPrincipal(principal);
    const { endpointId } = request.params as { endpointId: string };
    const body = parseBody(updateWebhookEndpointSchema, request.body);
    const repo = new WebhookEndpointRepository(db);

    const existing = await repo.findById(endpointId);
    if (!existing) throw new NotFoundError('WebhookEndpoint', endpointId);
    ClerkAuthService.requireResourceTenant(principal, existing, 'WebhookEndpoint', endpointId);
    ClerkAuthService.requireOrganizationScope(principal, existing.organization_id);
    await app.context.webhookEndpointCheckpoint?.({
      stage: 'before_transaction',
      operation: 'update',
      endpointId,
    });

    const updateData: Record<string, unknown> = {};
    if (body.url) updateData.url = body.url;
    if (body.events) updateData.events = JSON.stringify(body.events);
    if (body.status) updateData.status = body.status;
    if (body.description !== undefined) updateData.description = body.description;
    const endpoint = await db.transaction().execute(async (transaction) => {
      const transactionRepo = new WebhookEndpointRepository(transaction);
      const current = await transactionRepo.findByIdForUpdate(endpointId);
      if (!current) throw new NotFoundError('WebhookEndpoint', endpointId);
      ClerkAuthService.requireResourceTenant(principal, current, 'WebhookEndpoint', endpointId);
      ClerkAuthService.requireOrganizationScope(principal, current.organization_id);
      const organization = await loadWebhookOrganization(
        transaction,
        principal,
        current.organization_id,
        true,
      );
      if (organization.tenant_id !== current.tenant_id) {
        throw new NotFoundError('WebhookEndpoint', endpointId);
      }

      const before = webhookEndpointAuditSnapshot(current);
      const updated = await transactionRepo.update(endpointId, updateData);
      await writeAuditLog(
        new AuditLogRepository(transaction),
        request,
        principal,
        {
          action: 'webhook_endpoint.updated',
          organizationId: current.organization_id,
          resourceType: 'WebhookEndpoint',
          resourceId: endpointId,
          diffSummary: {
            changedFields: Object.keys(updateData),
            before,
            after: webhookEndpointAuditSnapshot(updated),
          },
        },
        { failClosed: true },
      );
      return updated;
    });
    return serializeWebhookEndpoint(endpoint);
  });

  app.get('/webhook-endpoints', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'developers.write');
    requireOrganizationWideWebhookEndpointPrincipal(principal);
    const pagination = parsePagination(request.query);
    const { organizationId } = request.query as { organizationId?: string };
    if (organizationId) {
      ClerkAuthService.requireOrganizationScope(principal, organizationId);
      await loadWebhookOrganization(db, principal, organizationId);
    }
    // Query across all principal.organizationIds, not just the first.
    let query = db
      .selectFrom('webhook_endpoints')
      .innerJoin('organizations', (join) =>
        join
          .onRef('organizations.id', '=', 'webhook_endpoints.organization_id')
          .onRef('organizations.tenant_id', '=', 'webhook_endpoints.tenant_id'),
      )
      .select([
        'webhook_endpoints.id as id',
        'webhook_endpoints.tenant_id as tenant_id',
        'webhook_endpoints.organization_id as organization_id',
        'webhook_endpoints.url as url',
        'webhook_endpoints.events as events',
        'webhook_endpoints.status as status',
        'webhook_endpoints.description as description',
        'webhook_endpoints.created_at as created_at',
        'webhook_endpoints.updated_at as updated_at',
      ])
      .where('webhook_endpoints.tenant_id', '=', principal.tenantId)
      .where('organizations.tenant_id', '=', principal.tenantId)
      .orderBy('webhook_endpoints.id', 'asc')
      .limit(pagination.limit + 1);
    if (pagination.cursor) query = query.where('webhook_endpoints.id', '>', pagination.cursor);
    if (principal.type !== 'system') {
      if (principal.organizationIds.length > 0) {
        query = query.where('webhook_endpoints.organization_id', 'in', principal.organizationIds);
      } else {
        // Fail-closed: no orgs means no endpoints visible.
        query = query.where('webhook_endpoints.organization_id', 'in', ['__none__']);
      }
    }
    if (organizationId) {
      query = query.where('webhook_endpoints.organization_id', '=', organizationId);
    }
    const rows = await query.execute();
    return pageEnvelope(
      rows.map((row) => serializeWebhookEndpoint(row)),
      pagination.limit,
    );
  });

  app.get('/webhook-endpoints/:endpointId/events', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'developers.write');
    requireOrganizationWideWebhookEndpointPrincipal(principal);
    const { endpointId } = request.params as { endpointId: string };
    const pagination = parsePagination(request.query);

    const endpointRepo = new WebhookEndpointRepository(db);
    const endpoint = await endpointRepo.findById(endpointId);
    if (endpoint) {
      ClerkAuthService.requireResourceTenant(principal, endpoint, 'WebhookEndpoint', endpointId);
      ClerkAuthService.requireOrganizationScope(principal, endpoint.organization_id);
      const organization = await loadWebhookOrganization(db, principal, endpoint.organization_id);
      if (organization.tenant_id !== endpoint.tenant_id) {
        throw new NotFoundError('WebhookEndpoint', endpointId);
      }
    }
    const cursor = pagination.cursor
      ? parseWebhookDeliveryEventCursor(pagination.cursor)
      : undefined;

    let query = db
      .selectFrom('webhook_deliveries')
      .innerJoin('webhook_events', 'webhook_events.id', 'webhook_deliveries.event_id')
      .innerJoin('organizations', (join) =>
        join
          .onRef('organizations.id', '=', 'webhook_events.organization_id')
          .onRef('organizations.tenant_id', '=', 'webhook_events.tenant_id'),
      )
      .select([
        'webhook_events.id as id',
        'webhook_deliveries.id as delivery_id',
        'webhook_deliveries.endpoint_id as endpoint_id',
        'webhook_deliveries.requested_endpoint_id as requested_endpoint_id',
        'webhook_deliveries.delivery_key as delivery_key',
        'webhook_events.type as event_type',
        'webhook_deliveries.status as status',
        'webhook_deliveries.status_code as status_code',
        'webhook_deliveries.attempt as attempt_count',
        'webhook_deliveries.delivered_at as delivered_at',
        'webhook_deliveries.created_at as created_at',
      ])
      .where('webhook_events.tenant_id', '=', principal.tenantId)
      .where('organizations.tenant_id', '=', principal.tenantId)
      .where('webhook_deliveries.requested_endpoint_id', '=', endpointId)
      .orderBy('webhook_deliveries.created_at', 'desc')
      .orderBy('webhook_deliveries.id', 'desc')
      .limit(pagination.limit + 1);
    if (endpoint) {
      query = query.where('webhook_events.organization_id', '=', endpoint.organization_id);
    } else if (principal.organizationIds.length > 0) {
      query = query.where('webhook_events.organization_id', 'in', principal.organizationIds);
    } else {
      // Fail-closed: without an endpoint row, org scope can only come from the joined event.
      query = query.where('webhook_events.organization_id', 'in', ['__none__']);
    }
    if (cursor) {
      query = query.where((eb) =>
        eb.or([
          eb('webhook_deliveries.created_at', '<', cursor.createdAt),
          eb.and([
            eb('webhook_deliveries.created_at', '=', cursor.createdAt),
            eb('webhook_deliveries.id', '<', cursor.deliveryId),
          ]),
        ]),
      );
    }

    const rows = await query.execute();
    return webhookDeliveryEventPageEnvelope(rows, pagination.limit);
  });

  app.post(
    '/webhook-endpoints/:endpointId/test',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const principal = request.principal!;
      ClerkAuthService.requirePermission(principal, 'developers.write');
      requireOrganizationWideWebhookEndpointPrincipal(principal);
      const { endpointId } = request.params as { endpointId: string };
      const endpointRepo = new WebhookEndpointRepository(db);
      const endpoint = await endpointRepo.findById(endpointId);
      if (!endpoint) throw new NotFoundError('WebhookEndpoint', endpointId);
      ClerkAuthService.requireResourceTenant(principal, endpoint, 'WebhookEndpoint', endpointId);
      ClerkAuthService.requireOrganizationScope(principal, endpoint.organization_id);
      if (endpoint.status !== 'active') {
        throw new ValidationError('Webhook endpoint is not active', {
          endpointId,
        });
      }

      const payload = createWebhookTestPayload(endpointId);
      const event = await new WebhookEventRepository(db).create({
        tenantId: principal.tenantId,
        organizationId: endpoint.organization_id,
        type: WEBHOOK_TEST_EVENT_TYPE,
        payload,
      });
      await new WebhookDeliveryRepository(db).create({
        endpointId,
        eventId: event.id,
        attempt: 1,
        deliveryKey: 'live',
      });
      await writeAuditLog(new AuditLogRepository(db), request, principal, {
        action: 'webhook_endpoint.test_delivery_queued',
        organizationId: endpoint.organization_id,
        resourceType: 'WebhookEndpoint',
        resourceId: endpointId,
        diffSummary: {
          eventId: event.id,
          eventType: WEBHOOK_TEST_EVENT_TYPE,
          test: true,
        },
      });
      try {
        await temporalClient.startWebhookDelivery({
          apiVersion: WEBHOOK_TEST_API_VERSION,
          endpointId,
          eventId: event.id,
          eventType: WEBHOOK_TEST_EVENT_TYPE,
          payload,
          maxAttempts: 5,
        });
      } catch {
        await writeAuditLog(new AuditLogRepository(db), request, principal, {
          action: 'webhook_endpoint.test_delivery_start_failed',
          organizationId: endpoint.organization_id,
          resourceType: 'WebhookEvent',
          resourceId: event.id,
          diffSummary: {
            endpointId,
            eventType: WEBHOOK_TEST_EVENT_TYPE,
            test: true,
          },
        });
        return reply.status(503).send({
          queued: false,
          test: true,
          eventId: event.id,
          endpointId,
          error: {
            code: 'TEMPORAL_UNAVAILABLE',
            message: 'Test delivery is persisted but not queued.',
          },
        });
      }
      return reply.status(202).send({ queued: true, test: true, eventId: event.id, endpointId });
    },
  );

  app.post('/webhook-events/:eventId/replay', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'developers.write');
    requireOrganizationWideWebhookEndpointPrincipal(principal);
    const { eventId } = request.params as { eventId: string };
    const eventRepo = new WebhookEventRepository(db);
    const event = await eventRepo.findById(eventId);
    if (!event) throw new NotFoundError('WebhookEvent', eventId);
    ClerkAuthService.requireResourceTenant(principal, event, 'WebhookEvent', eventId);
    ClerkAuthService.requireOrganizationScope(principal, event.organization_id);
    const idempotencyKey = requireWebhookIdempotencyKey(request.headers);
    const idempotencyKeySha256 = sha256(idempotencyKey);
    const requestSha256 = sha256(JSON.stringify({ scope: 'organization', eventId }));

    const replayRepo = new WebhookReplayRequestRepository(db);
    const existingReplay = await replayRepo.findByKeyHash(principal.tenantId, idempotencyKeySha256);
    if (existingReplay && existingReplay.request_sha256 !== requestSha256) {
      throw new IdempotencyConflictError(idempotencyKey);
    }

    const endpointIds = existingReplay
      ? parseReplayEndpointIds(existingReplay.endpoint_ids_json)
      : (
          await new WebhookEndpointRepository(db).findActiveByEvent(
            event.organization_id,
            event.type as string,
          )
        )
          .map((endpoint) => endpoint.id)
          .sort();
    const response = { queued: true, eventId, endpoints: endpointIds.length };
    const reserved = existingReplay
      ? { request: existingReplay, created: false }
      : await replayRepo.reserve({
          tenantId: principal.tenantId,
          organizationId: event.organization_id,
          eventId,
          idempotencyKeySha256,
          requestSha256,
          endpointIds,
          response,
          audit: {
            actorType: principal.type,
            actorId: principal.id,
            action: 'webhook_event.replay_requested',
            diffSummary: {
              replayScope: 'organization',
              eventType: event.type,
              queuedEndpointCount: endpointIds.length,
            },
            requestId: request.id,
            ip: request.ip,
            userAgent: request.headers['user-agent'],
          },
        });
    if (reserved.request.request_sha256 !== requestSha256) {
      throw new IdempotencyConflictError(idempotencyKey);
    }
    if (reserved.request.status === 'completed') {
      return reply.status(202).send(JSON.parse(reserved.request.response_json));
    }

    const payload = serializeWebhookEvent(event).payload as Record<string, unknown>;
    try {
      for (const endpointId of endpointIds) {
        await temporalClient.startWebhookDelivery({
          apiVersion: WEBHOOK_TEST_API_VERSION,
          endpointId,
          eventId,
          eventType: event.type as string,
          replayNonce: reserved.request.id,
          payload,
          maxAttempts: 5,
        });
      }
    } catch {
      return reply.status(503).send({
        queued: false,
        eventId,
        error: {
          code: 'REPLAY_DISPATCH_INCOMPLETE',
          message: 'Webhook replay dispatch is incomplete; retry with the same Idempotency-Key.',
        },
      });
    }
    try {
      await replayRepo.complete({
        id: reserved.request.id,
        tenantId: principal.tenantId,
        organizationId: event.organization_id,
        actorType: principal.type,
        actorId: principal.id,
        requestId: request.id,
        ip: request.ip,
        userAgent: request.headers['user-agent'],
      });
    } catch {
      return reply.status(503).send({
        queued: false,
        eventId,
        error: {
          code: 'REPLAY_FINALIZATION_UNAVAILABLE',
          message:
            'Webhook replay was dispatched but not finalized; retry with the same Idempotency-Key.',
        },
      });
    }

    return reply.status(202).send(response);
  });

  app.post('/webhook-endpoints/:endpointId/events/:eventId/replay', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'developers.write');
    requireOrganizationWideWebhookEndpointPrincipal(principal);
    const { endpointId, eventId } = request.params as {
      endpointId: string;
      eventId: string;
    };
    const eventRepo = new WebhookEventRepository(db);
    const event = await eventRepo.findById(eventId);
    if (!event) throw new NotFoundError('WebhookEvent', eventId);
    ClerkAuthService.requireResourceTenant(principal, event, 'WebhookEvent', eventId);
    ClerkAuthService.requireOrganizationScope(principal, event.organization_id);
    const idempotencyKey = requireWebhookIdempotencyKey(request.headers);
    const idempotencyKeySha256 = sha256(idempotencyKey);
    const requestSha256 = sha256(JSON.stringify({ scope: 'endpoint', endpointId, eventId }));
    const replayRepo = new WebhookReplayRequestRepository(db);
    const existingReplay = await replayRepo.findByKeyHash(principal.tenantId, idempotencyKeySha256);
    if (existingReplay && existingReplay.request_sha256 !== requestSha256) {
      throw new IdempotencyConflictError(idempotencyKey);
    }
    const storedEndpointIds = existingReplay
      ? parseReplayEndpointIds(existingReplay.endpoint_ids_json)
      : undefined;
    if (
      existingReplay &&
      (existingReplay.event_id !== eventId ||
        existingReplay.organization_id !== event.organization_id ||
        storedEndpointIds?.length !== 1 ||
        storedEndpointIds?.[0] !== endpointId)
    ) {
      throw new Error('Stored endpoint webhook replay scope is invalid');
    }
    if (existingReplay?.status === 'completed') {
      return reply.status(202).send(JSON.parse(existingReplay.response_json));
    }

    const eventType = event.type as string;
    const eventPayload = serializeWebhookEvent(event).payload as Record<string, unknown>;
    const syntheticTest =
      eventType === WEBHOOK_TEST_EVENT_TYPE && isWebhookTestPayload(eventPayload, endpointId);
    if (!existingReplay) {
      const endpoint = await new WebhookEndpointRepository(db).findById(endpointId);
      if (!endpoint) throw new NotFoundError('WebhookEndpoint', endpointId);
      ClerkAuthService.requireResourceTenant(principal, endpoint, 'WebhookEndpoint', endpointId);
      ClerkAuthService.requireOrganizationScope(principal, endpoint.organization_id);
      if (endpoint.organization_id !== event.organization_id) {
        throw new NotFoundError('WebhookEvent', eventId);
      }
      if (endpoint.status !== 'active') {
        throw new ValidationError('Webhook endpoint is not active', { endpointId });
      }
      if (!syntheticTest && !parseWebhookEndpointEvents(endpoint.events).includes(eventType)) {
        throw new ValidationError('Webhook endpoint is not subscribed to this event type', {
          endpointId,
          eventId,
          eventType,
        });
      }
    }

    const payload = syntheticTest ? createWebhookTestPayload(endpointId) : eventPayload;
    const response = { queued: true, eventId, endpointId };
    const reserved = existingReplay
      ? { request: existingReplay, created: false }
      : await replayRepo.reserve({
          tenantId: principal.tenantId,
          organizationId: event.organization_id,
          eventId,
          idempotencyKeySha256,
          requestSha256,
          endpointIds: [endpointId],
          response,
          audit: {
            actorType: principal.type,
            actorId: principal.id,
            action: 'webhook_event.replay_requested',
            diffSummary: {
              replayScope: 'endpoint',
              endpointId,
              eventType,
              queuedEndpointCount: 1,
            },
            requestId: request.id,
            ip: request.ip,
            userAgent: request.headers['user-agent'],
          },
        });
    if (reserved.request.request_sha256 !== requestSha256) {
      throw new IdempotencyConflictError(idempotencyKey);
    }
    try {
      await temporalClient.startWebhookDelivery({
        apiVersion: WEBHOOK_TEST_API_VERSION,
        endpointId,
        eventId,
        eventType,
        replayNonce: reserved.request.id,
        payload,
        maxAttempts: 5,
      });
    } catch {
      return reply.status(503).send({
        queued: false,
        eventId,
        endpointId,
        error: {
          code: 'REPLAY_DISPATCH_INCOMPLETE',
          message: 'Webhook replay dispatch is incomplete; retry with the same Idempotency-Key.',
        },
      });
    }
    try {
      await replayRepo.complete({
        id: reserved.request.id,
        tenantId: principal.tenantId,
        organizationId: event.organization_id,
        actorType: principal.type,
        actorId: principal.id,
        requestId: request.id,
        ip: request.ip,
        userAgent: request.headers['user-agent'],
      });
    } catch {
      return reply.status(503).send({
        queued: false,
        eventId,
        endpointId,
        error: {
          code: 'REPLAY_FINALIZATION_UNAVAILABLE',
          message:
            'Webhook replay was dispatched but not finalized; retry with the same Idempotency-Key.',
        },
      });
    }

    return reply.status(202).send(response);
  });
};

type WebhookDeliveryEventCursor = {
  createdAt: Date;
  deliveryId: string;
};

function parseWebhookDeliveryEventCursor(cursor: string): WebhookDeliveryEventCursor {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    const deliveryId = typeof parsed.deliveryId === 'string' ? parsed.deliveryId : undefined;
    const createdAtValue = typeof parsed.createdAt === 'string' ? parsed.createdAt : undefined;
    const createdAt = createdAtValue ? new Date(createdAtValue) : undefined;
    if (!deliveryId || !createdAt || Number.isNaN(createdAt.getTime())) {
      throw new Error('Invalid webhook delivery event cursor');
    }
    return { createdAt, deliveryId };
  } catch {
    throw new ValidationError('Invalid pagination cursor');
  }
}

function encodeWebhookDeliveryEventCursor(row: Record<string, unknown>): string {
  const createdAt =
    row.created_at instanceof Date ? row.created_at : new Date(String(row.created_at));
  const deliveryId = typeof row.delivery_id === 'string' ? row.delivery_id : undefined;
  if (!deliveryId || Number.isNaN(createdAt.getTime())) {
    throw new ValidationError('Invalid webhook delivery cursor row');
  }
  return Buffer.from(
    JSON.stringify({ createdAt: createdAt.toISOString(), deliveryId }),
    'utf8',
  ).toString('base64url');
}

function webhookDeliveryEventPageEnvelope(rows: Record<string, unknown>[], limit: number) {
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows.at(-1);
  return {
    items: pageRows.map((row) => serializeWebhookDeliveryEvent(row)),
    nextCursor: hasMore && last ? encodeWebhookDeliveryEventCursor(last) : null,
    hasMore,
  };
}

function serializeWebhookDeliveryEvent(row: Record<string, unknown>) {
  return {
    id: row.id,
    eventId: row.id,
    deliveryId: row.delivery_id,
    endpointId: row.endpoint_id,
    requestedEndpointId: row.requested_endpoint_id,
    deliveryKey: typeof row.delivery_key === 'string' ? row.delivery_key : 'live',
    eventType: row.event_type,
    status: row.status,
    statusCode: row.status_code ?? undefined,
    attemptCount: row.attempt_count,
    deliveredAt:
      row.delivered_at instanceof Date
        ? row.delivered_at.toISOString()
        : (row.delivered_at ?? undefined),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

function parseWebhookEndpointEvents(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((event): event is string => typeof event === 'string');
  }
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((event): event is string => typeof event === 'string')
      : [];
  } catch {
    return [];
  }
}
