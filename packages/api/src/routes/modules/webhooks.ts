import type { FastifyPluginAsync } from 'fastify';
import { ClerkAuthService } from '../../auth/clerk.js';
import { WebhookEndpointRepository, WebhookEventRepository } from '@gatekit/db';
import { NotFoundError } from '@gatekit/domain';
import {
  pageEnvelope,
  parsePagination,
  serializeWebhookEndpoint,
  serializeWebhookEvent,
} from '../../http/contracts.js';
import { createWebhookEndpointSchema, updateWebhookEndpointSchema, parseBody } from '../../http/schemas.js';

export const webhookRoutes: FastifyPluginAsync = async (app) => {
  const db = app.context.db;
  const temporalClient = app.context.temporalClient;

  app.post('/webhook-endpoints', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'developers.write');
    const body = parseBody(createWebhookEndpointSchema, request.body);

    ClerkAuthService.requireOrganizationScope(principal, body.organizationId);

    const repo = new WebhookEndpointRepository(db);
    const endpoint = await repo.create({
      tenantId: principal.tenantId,
      organizationId: body.organizationId,
      url: body.url,
      events: body.events,
      description: body.description,
    });

    // Return with secret (only shown once)
    return reply.status(201).send(serializeWebhookEndpoint(endpoint, true));
  });

  app.patch('/webhook-endpoints/:endpointId', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'developers.write');
    const { endpointId } = request.params as { endpointId: string };
    const body = parseBody(updateWebhookEndpointSchema, request.body);
    const repo = new WebhookEndpointRepository(db);

    const existing = await repo.findById(endpointId);
    if (!existing) throw new NotFoundError('WebhookEndpoint', endpointId);
    ClerkAuthService.requireResourceTenant(principal, existing, 'WebhookEndpoint', endpointId);
    ClerkAuthService.requireOrganizationScope(principal, existing.organization_id);

    const updateData: Record<string, unknown> = {};
    if (body.url) updateData.url = body.url;
    if (body.events) updateData.events = JSON.stringify(body.events);
    if (body.status) updateData.status = body.status;
    if (body.description !== undefined) updateData.description = body.description;
    return serializeWebhookEndpoint(await repo.update(endpointId, updateData));
  });

  app.get('/webhook-endpoints', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'developers.write');
    const pagination = parsePagination(request.query);
    // Query across all principal.organizationIds, not just the first.
    let query = db
      .selectFrom('webhook_endpoints')
      .selectAll()
      .where('tenant_id', '=', principal.tenantId)
      .orderBy('id', 'asc')
      .limit(pagination.limit + 1);
    if (pagination.cursor) query = query.where('id', '>', pagination.cursor);
    if (principal.organizationIds.length > 0) {
      query = query.where('organization_id', 'in', principal.organizationIds);
    } else {
      // Fail-closed: no orgs means no endpoints visible.
      query = query.where('organization_id', 'in', ['__none__']);
    }
    const rows = await query.execute();
    return pageEnvelope(rows.map((row) => serializeWebhookEndpoint(row)), pagination.limit);
  });

  app.get('/webhook-endpoints/:endpointId/events', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'developers.write');
    const { endpointId } = request.params as { endpointId: string };
    const pagination = parsePagination(request.query);

    const endpointRepo = new WebhookEndpointRepository(db);
    const endpoint = await endpointRepo.findById(endpointId);
    if (!endpoint) throw new NotFoundError('WebhookEndpoint', endpointId);
    ClerkAuthService.requireResourceTenant(principal, endpoint, 'WebhookEndpoint', endpointId);
    ClerkAuthService.requireOrganizationScope(principal, endpoint.organization_id);

    let query = db
      .selectFrom('webhook_deliveries')
      .innerJoin('webhook_events', 'webhook_events.id', 'webhook_deliveries.event_id')
      .select([
        'webhook_events.id as id',
        'webhook_deliveries.endpoint_id as endpoint_id',
        'webhook_events.type as event_type',
        'webhook_deliveries.status as status',
        'webhook_deliveries.status_code as status_code',
        'webhook_deliveries.attempt as attempt_count',
        'webhook_deliveries.delivered_at as delivered_at',
        'webhook_deliveries.created_at as created_at',
      ])
      .where('webhook_events.tenant_id', '=', principal.tenantId)
      .where('webhook_events.organization_id', '=', endpoint.organization_id)
      .where('webhook_deliveries.endpoint_id', '=', endpointId)
      .orderBy('webhook_deliveries.created_at', 'desc')
      .limit(pagination.limit + 1);
    if (pagination.cursor) query = query.where('webhook_events.id', '>', pagination.cursor);

    const rows = await query.execute();
    return pageEnvelope(rows.map((row) => serializeWebhookDeliveryEvent(row)), pagination.limit);
  });

  app.post('/webhook-events/:eventId/replay', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'developers.write');
    const { eventId } = request.params as { eventId: string };

    const eventRepo = new WebhookEventRepository(db);
    const event = await eventRepo.findById(eventId);
    if (!event) throw new NotFoundError('WebhookEvent', eventId);
    ClerkAuthService.requireResourceTenant(principal, event, 'WebhookEvent', eventId);
    ClerkAuthService.requireOrganizationScope(principal, event.organization_id);

    const endpointRepo = new WebhookEndpointRepository(db);
    const endpoints = await endpointRepo.findActiveByEvent(event.organization_id, event.type as string);

    const payload = serializeWebhookEvent(event).payload as Record<string, unknown>;
    await Promise.all(
      endpoints.map((endpoint) =>
        temporalClient.startWebhookDelivery({
          endpointId: endpoint.id,
          eventId,
          payload,
          secret: endpoint.secret as string,
          maxAttempts: 5,
        }),
      ),
    );

    return reply.status(202).send({ queued: true, eventId, endpoints: endpoints.length });
  });
};

function serializeWebhookDeliveryEvent(row: Record<string, unknown>) {
  return {
    id: row.id,
    endpointId: row.endpoint_id,
    eventType: row.event_type,
    status: row.status,
    statusCode: row.status_code ?? undefined,
    attemptCount: row.attempt_count,
    deliveredAt: row.delivered_at instanceof Date ? row.delivered_at.toISOString() : row.delivered_at ?? undefined,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}
