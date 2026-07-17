import { BaseRepository } from './base.js';
import { ulid } from 'ulid';
import { createHash, randomBytes } from 'node:crypto';
import type { Selectable } from 'kysely';
import type { DB } from '../types/db.js';
import { AuditLogRepository } from './identity.js';

export type WebhookReplayRequest = Selectable<DB['webhook_replay_requests']>;

export class WebhookReplayRequestRepository extends BaseRepository {
  async findByKeyHash(
    tenantId: string,
    keyHash: string,
  ): Promise<WebhookReplayRequest | undefined> {
    return this.db
      .selectFrom('webhook_replay_requests')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('idempotency_key_sha256', '=', keyHash)
      .executeTakeFirst();
  }

  async reserve(input: {
    tenantId: string;
    organizationId: string;
    eventId: string;
    idempotencyKeySha256: string;
    requestSha256: string;
    endpointIds: string[];
    response: Record<string, unknown>;
    audit: {
      actorType: string;
      actorId: string;
      action: string;
      diffSummary: Record<string, unknown>;
      requestId?: string;
      ip?: string;
      userAgent?: string;
    };
  }): Promise<{ request: WebhookReplayRequest; created: boolean }> {
    const existing = await this.findByKeyHash(input.tenantId, input.idempotencyKeySha256);
    if (existing) return { request: existing, created: false };

    const id = `whr_${ulid()}`;
    try {
      const request = await this.db.transaction().execute(async (transaction) => {
        const row = await new WebhookReplayRequestRepository(transaction).insertReturning(
          'webhook_replay_requests',
          {
            id,
            tenant_id: input.tenantId,
            organization_id: input.organizationId,
            event_id: input.eventId,
            idempotency_key_sha256: input.idempotencyKeySha256,
            request_sha256: input.requestSha256,
            endpoint_ids_json: JSON.stringify(input.endpointIds),
            response_json: JSON.stringify(input.response),
            status: 'prepared',
            created_at: new Date(),
            completed_at: null,
          },
          id,
        );
        await new AuditLogRepository(transaction).create({
          tenantId: input.tenantId,
          organizationId: input.organizationId,
          actorType: input.audit.actorType,
          actorId: input.audit.actorId,
          action: input.audit.action,
          resourceType: 'WebhookReplayRequest',
          resourceId: id,
          diffSummary: input.audit.diffSummary,
          requestId: input.audit.requestId,
          ip: input.audit.ip,
          userAgent: input.audit.userAgent,
        });
        return row;
      });
      return { request, created: true };
    } catch (error) {
      const winner = await this.findByKeyHash(input.tenantId, input.idempotencyKeySha256);
      if (winner) return { request: winner, created: false };
      throw error;
    }
  }

  async complete(input: {
    id: string;
    tenantId: string;
    organizationId: string;
    actorType: string;
    actorId: string;
    requestId?: string;
    ip?: string;
    userAgent?: string;
  }): Promise<void> {
    await this.db.transaction().execute(async (transaction) => {
      const replayRequest = await transaction
        .selectFrom('webhook_replay_requests')
        .select(['organization_id'])
        .where('id', '=', input.id)
        .where('tenant_id', '=', input.tenantId)
        .where('organization_id', '=', input.organizationId)
        .where('status', '=', 'prepared')
        .executeTakeFirst();
      if (!replayRequest) return;

      const result = await transaction
        .updateTable('webhook_replay_requests')
        .set({ status: 'completed', completed_at: new Date() })
        .where('id', '=', input.id)
        .where('tenant_id', '=', input.tenantId)
        .where('organization_id', '=', replayRequest.organization_id)
        .where('status', '=', 'prepared')
        .executeTakeFirst();
      if (Number(result.numUpdatedRows ?? 0) === 0) return;

      await new AuditLogRepository(transaction).create({
        tenantId: input.tenantId,
        organizationId: replayRequest.organization_id,
        actorType: input.actorType,
        actorId: input.actorId,
        action: 'webhook_event.replay_queued',
        resourceType: 'WebhookReplayRequest',
        resourceId: input.id,
        requestId: input.requestId,
        ip: input.ip,
        userAgent: input.userAgent,
      });
    });
  }
}

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
    return this.updateReturning('webhook_endpoints', id, {
      ...input,
      updated_at: new Date(),
    });
  }
}

export class WebhookEventRepository extends BaseRepository {
  async create(input: {
    tenantId: string;
    organizationId: string;
    type: string;
    payload: Record<string, unknown>;
    idempotencyKey?: string;
  }) {
    const id = input.idempotencyKey
      ? stableWebhookEventId({
          tenantId: input.tenantId,
          organizationId: input.organizationId,
          type: input.type,
          idempotencyKey: input.idempotencyKey,
        })
      : `whe_${ulid()}`;
    if (input.idempotencyKey) {
      const existingEvent = await this.findById(id);
      if (existingEvent) return existingEvent;
    }

    const now = new Date();
    try {
      return await this.insertReturning(
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
    } catch (err) {
      if (!input.idempotencyKey || !isUniqueConstraintError(err)) {
        throw err;
      }

      const existingEvent = await this.findById(id);
      if (!existingEvent) {
        throw err;
      }

      return existingEvent;
    }
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
    deliveryKey?: string;
    eventId: string;
    attempt: number;
    status?: string;
    statusCode?: number | null;
    response?: string | null;
    deliveredAt?: Date | null;
    nextRetryAt?: Date | null;
  }) {
    const requestedEndpointId = input.requestedEndpointId ?? input.endpointId;
    const deliveryKey = input.deliveryKey ?? 'live';
    if (!requestedEndpointId) {
      throw new Error('Webhook delivery requires a requested endpoint id');
    }

    const existingDelivery = await this.findByAttempt({
      eventId: input.eventId,
      requestedEndpointId,
      deliveryKey,
      attempt: input.attempt,
    });
    if (existingDelivery) {
      return existingDelivery;
    }

    const id = `whd_${ulid()}`;
    const now = new Date();
    try {
      return await this.insertReturning(
        'webhook_deliveries',
        {
          id,
          endpoint_id: input.endpointId,
          requested_endpoint_id: requestedEndpointId,
          delivery_key: deliveryKey,
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
    } catch (err) {
      if (!isUniqueConstraintError(err)) {
        throw err;
      }

      const delivery = await this.findByAttempt({
        eventId: input.eventId,
        requestedEndpointId,
        deliveryKey,
        attempt: input.attempt,
      });
      if (!delivery) {
        throw err;
      }

      return delivery;
    }
  }

  async update(id: string, input: Record<string, unknown>) {
    return this.updateReturning('webhook_deliveries', id, input);
  }

  async deadLetterAttempt(id: string, input: Record<string, unknown>) {
    const now = new Date();
    const result = await this.db
      .updateTable('webhook_deliveries')
      .set(input)
      .where('id', '=', id)
      .where('status', 'not in', ['delivered', 'dead_lettered'])
      .where((eb) =>
        eb.or([
          eb('status', '!=', 'pending'),
          eb('next_retry_at', 'is', null),
          eb('next_retry_at', '<=', now),
        ]),
      )
      .executeTakeFirst();
    const delivery = await this.findById(id);
    if (!delivery) {
      throw new Error(`Webhook delivery ${id} not found`);
    }

    return { updated: Number(result.numUpdatedRows ?? 0) === 1, delivery };
  }

  async completeClaimedAttempt(id: string, leaseExpiresAt: Date, input: Record<string, unknown>) {
    const result = await this.db
      .updateTable('webhook_deliveries')
      .set(input)
      .where('id', '=', id)
      .where('status', '=', 'pending')
      .where('next_retry_at', '=', leaseExpiresAt)
      .executeTakeFirst();
    const delivery = await this.findById(id);
    if (!delivery) {
      throw new Error(`Webhook delivery ${id} not found`);
    }

    return { updated: Number(result.numUpdatedRows ?? 0) === 1, delivery };
  }

  async claimAttempt(input: {
    endpointId: string | null;
    requestedEndpointId?: string;
    deliveryKey?: string;
    eventId: string;
    attempt: number;
    leaseExpiresAt: Date;
  }) {
    const requestedEndpointId = input.requestedEndpointId ?? input.endpointId;
    const deliveryKey = input.deliveryKey ?? 'live';
    if (!requestedEndpointId) {
      throw new Error('Webhook delivery claim requires a requested endpoint id');
    }

    const delivery = await this.create({
      endpointId: input.endpointId,
      requestedEndpointId,
      deliveryKey,
      eventId: input.eventId,
      attempt: input.attempt,
    });
    const now = new Date();
    // While an attempt is pending, next_retry_at is the in-flight lease deadline.
    // Once the POST completes, update() rewrites it to the retry schedule or null.
    const result = await this.db
      .updateTable('webhook_deliveries')
      .set({
        endpoint_id: input.endpointId,
        status: 'pending',
        status_code: null,
        response: null,
        delivered_at: null,
        next_retry_at: input.leaseExpiresAt,
      })
      .where('id', '=', delivery.id)
      .where((eb) =>
        eb.and([
          eb('status', 'in', ['pending', 'failed']),
          eb.or([eb('next_retry_at', 'is', null), eb('next_retry_at', '<=', now)]),
        ]),
      )
      .executeTakeFirst();
    const claimed = Number(result.numUpdatedRows ?? 0) === 1;
    const currentDelivery =
      (await this.findByAttempt({
        eventId: input.eventId,
        requestedEndpointId,
        deliveryKey,
        attempt: input.attempt,
      })) ?? delivery;

    return { claimed, delivery: currentDelivery };
  }

  async findByAttempt(input: {
    eventId: string;
    requestedEndpointId: string;
    deliveryKey?: string;
    attempt: number;
  }) {
    return this.db
      .selectFrom('webhook_deliveries')
      .selectAll()
      .where('event_id', '=', input.eventId)
      .where('requested_endpoint_id', '=', input.requestedEndpointId)
      .where('delivery_key', '=', input.deliveryKey ?? 'live')
      .where('attempt', '=', input.attempt)
      .executeTakeFirst();
  }

  async findById(id: string) {
    return this.db
      .selectFrom('webhook_deliveries')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
  }

  async findByEvent(eventId: string) {
    return this.db
      .selectFrom('webhook_deliveries')
      .selectAll()
      .where('event_id', '=', eventId)
      .execute();
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

function stableWebhookEventId(input: {
  tenantId: string;
  organizationId: string;
  type: string;
  idempotencyKey: string;
}): string {
  const digest = createHash('sha256')
    .update(`${input.tenantId}:${input.organizationId}:${input.type}:${input.idempotencyKey}`)
    .digest('base64url')
    .slice(0, 22);
  return `whe_${digest}`;
}
