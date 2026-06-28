import { BaseRepository } from './base.js';
import { ulid } from 'ulid';
import { randomBytes } from 'node:crypto';

export class WebhookEndpointRepository extends BaseRepository {
  async create(input: {
    tenantId: string;
    organizationId: string;
    url: string;
    events: string[];
    description?: string;
  }) {
    const id = `wh_${ulid()}`;
    const secret = randomBytes(32).toString('hex');
    const now = new Date();
    return this.insertReturning(
      'webhook_endpoints',
      {
        id,
        tenant_id: input.tenantId,
        organization_id: input.organizationId,
        url: input.url,
        secret,
        events: JSON.stringify(input.events),
        status: 'active',
        description: input.description ?? null,
        created_at: now,
        updated_at: now,
      },
      id,
    );
  }

  async findById(id: string) {
    return this.db
      .selectFrom('webhook_endpoints')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
  }

  async findByOrganization(orgId: string) {
    return this.db
      .selectFrom('webhook_endpoints')
      .selectAll()
      .where('organization_id', '=', orgId)
      .execute();
  }

  async findActiveByEvent(orgId: string, eventType: string) {
    const endpoints = await this.findByOrganization(orgId);
    return endpoints.filter((e) => {
      const events = JSON.parse(e.events as string) as string[];
      return e.status === 'active' && events.includes(eventType);
    });
  }

  async update(id: string, input: Record<string, unknown>) {
    return this.updateReturning('webhook_endpoints', id, { ...input, updated_at: new Date() });
  }
}

export class WebhookEventRepository extends BaseRepository {
  async create(input: {
    tenantId: string;
    organizationId: string;
    type: string;
    payload: Record<string, unknown>;
  }) {
    const id = `whe_${ulid()}`;
    const now = new Date();
    return this.insertReturning(
      'webhook_events',
      {
        id,
        tenant_id: input.tenantId,
        organization_id: input.organizationId,
        type: input.type,
        payload: JSON.stringify(input.payload),
        status: 'pending',
        created_at: now,
      },
      id,
    );
  }

  async findById(id: string) {
    return this.db.selectFrom('webhook_events').selectAll().where('id', '=', id).executeTakeFirst();
  }

  async updateStatus(id: string, status: string) {
    return this.updateReturning('webhook_events', id, { status });
  }
}

export class WebhookDeliveryRepository extends BaseRepository {
  async create(input: {
    endpointId: string | null;
    requestedEndpointId?: string;
    eventId: string;
    attempt: number;
    status?: string;
    statusCode?: number | null;
    response?: string | null;
    deliveredAt?: Date | null;
    nextRetryAt?: Date | null;
  }) {
    const requestedEndpointId = input.requestedEndpointId ?? input.endpointId;
    if (!requestedEndpointId) {
      throw new Error('Webhook delivery requires a requested endpoint id');
    }

    const id = `whd_${ulid()}`;
    const now = new Date();
    return this.insertReturning(
      'webhook_deliveries',
      {
        id,
        endpoint_id: input.endpointId,
        requested_endpoint_id: requestedEndpointId,
        event_id: input.eventId,
        attempt: input.attempt,
        status_code: input.statusCode ?? null,
        response: input.response ?? null,
        status: input.status ?? 'pending',
        delivered_at: input.deliveredAt ?? null,
        next_retry_at: input.nextRetryAt === undefined ? now : input.nextRetryAt,
        created_at: now,
      },
      id,
    );
  }

  async update(id: string, input: Record<string, unknown>) {
    return this.updateReturning('webhook_deliveries', id, input);
  }

  async findByEvent(eventId: string) {
    return this.db
      .selectFrom('webhook_deliveries')
      .selectAll()
      .where('event_id', '=', eventId)
      .execute();
  }
}
