import { describe, expect, it } from 'vitest';
import type { Database } from '../../client.js';
import { WebhookDeliveryRepository } from '../../repositories/webhook.js';

type DeliveryRow = {
  id: string;
  endpoint_id: string | null;
  requested_endpoint_id: string;
  delivery_key: string;
  event_id: string;
  attempt: number;
  status_code: number | null;
  response: string | null;
  status: string;
  delivered_at: Date | null;
  next_retry_at: Date | null;
  created_at: Date;
};

function createWebhookDeliveryDb(
  delivery: DeliveryRow,
  shouldUpdate: (delivery: DeliveryRow) => boolean = (row) =>
    (row.status === 'failed' || row.status === 'pending') &&
    (row.next_retry_at === null || row.next_retry_at.getTime() <= Date.now()),
) {
  const setCalls: Array<Record<string, unknown>> = [];
  const whereCalls: unknown[][] = [];
  const selectQuery = {
    selectAll() {
      return selectQuery;
    },
    where() {
      return selectQuery;
    },
    executeTakeFirst() {
      return Promise.resolve(delivery);
    },
  };
  const updateQuery = {
    set(input: Record<string, unknown>) {
      setCalls.push(input);
      return updateQuery;
    },
    where(...args: unknown[]) {
      whereCalls.push(args);
      const input = args[0];
      if (typeof input === 'function') {
        const eb = (() => ({})) as {
          (...args: unknown[]): unknown;
          and: (clauses: unknown[]) => unknown;
          or: (clauses: unknown[]) => unknown;
        };
        eb.and = (clauses) => ({ and: clauses });
        eb.or = (clauses) => ({ or: clauses });
        input(eb);
      }
      return updateQuery;
    },
    async executeTakeFirst() {
      const update = setCalls.at(-1) ?? {};
      if (!shouldUpdate(delivery)) {
        return { numUpdatedRows: 0n };
      }

      Object.assign(delivery, update);
      return { numUpdatedRows: 1n };
    },
  };

  return {
    setCalls,
    whereCalls,
    db: {
      selectFrom(table: string) {
        expect(table).toBe('webhook_deliveries');
        return selectQuery;
      },
      updateTable(table: string) {
        expect(table).toBe('webhook_deliveries');
        return updateQuery;
      },
    } as unknown as Database,
  };
}

describe('WebhookDeliveryRepository', () => {
  it('leases failed retry attempts as pending so concurrent claimers are blocked', async () => {
    const delivery: DeliveryRow = {
      id: 'whd_1',
      endpoint_id: 'wh_1',
      requested_endpoint_id: 'wh_1',
      delivery_key: 'live',
      event_id: 'whe_1',
      attempt: 2,
      status_code: null,
      response: 'network down',
      status: 'failed',
      delivered_at: null,
      next_retry_at: new Date(Date.now() - 1000),
      created_at: new Date(),
    };
    const { db, setCalls } = createWebhookDeliveryDb(delivery);
    const repo = new WebhookDeliveryRepository(db);
    const leaseExpiresAt = new Date(Date.now() + 30_000);

    const firstClaim = await repo.claimAttempt({
      endpointId: 'wh_1',
      eventId: 'whe_1',
      attempt: 2,
      leaseExpiresAt,
    });
    const secondClaim = await repo.claimAttempt({
      endpointId: 'wh_1',
      eventId: 'whe_1',
      attempt: 2,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });

    expect(firstClaim.claimed).toBe(true);
    expect(firstClaim.delivery).toMatchObject({
      id: 'whd_1',
      status: 'pending',
      response: null,
      next_retry_at: leaseExpiresAt,
    });
    expect(secondClaim.claimed).toBe(false);
    expect(setCalls[0]).toMatchObject({
      endpoint_id: 'wh_1',
      status: 'pending',
      status_code: null,
      response: null,
      delivered_at: null,
      next_retry_at: leaseExpiresAt,
    });
  });

  it('does not lease failed attempts before their scheduled retry time', async () => {
    const delivery: DeliveryRow = {
      id: 'whd_1',
      endpoint_id: 'wh_1',
      requested_endpoint_id: 'wh_1',
      delivery_key: 'live',
      event_id: 'whe_1',
      attempt: 2,
      status_code: null,
      response: 'network down',
      status: 'failed',
      delivered_at: null,
      next_retry_at: new Date(Date.now() + 30_000),
      created_at: new Date(),
    };
    const { db } = createWebhookDeliveryDb(delivery);
    const repo = new WebhookDeliveryRepository(db);

    const claim = await repo.claimAttempt({
      endpointId: 'wh_1',
      eventId: 'whe_1',
      attempt: 2,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });

    expect(claim.claimed).toBe(false);
    expect(claim.delivery).toMatchObject({
      id: 'whd_1',
      status: 'failed',
      response: 'network down',
      next_retry_at: delivery.next_retry_at,
    });
  });

  it('does not dead-letter a delivery while an unexpired pending lease is active', async () => {
    const delivery: DeliveryRow = {
      id: 'whd_1',
      endpoint_id: 'wh_1',
      requested_endpoint_id: 'wh_1',
      delivery_key: 'live',
      event_id: 'whe_1',
      attempt: 2,
      status_code: null,
      response: null,
      status: 'pending',
      delivered_at: null,
      next_retry_at: new Date(Date.now() + 30_000),
      created_at: new Date(),
    };
    const { db, setCalls } = createWebhookDeliveryDb(delivery);
    const repo = new WebhookDeliveryRepository(db);

    const result = await repo.deadLetterAttempt('whd_1', {
      status: 'dead_lettered',
      response: 'Webhook endpoint is not active',
      next_retry_at: null,
    });

    expect(result.updated).toBe(false);
    expect(result.delivery).toMatchObject({
      id: 'whd_1',
      status: 'pending',
      response: null,
    });
    expect(setCalls[0]).toMatchObject({
      status: 'dead_lettered',
      response: 'Webhook endpoint is not active',
      next_retry_at: null,
    });
  });

  it('completes only the delivery row that still owns the claimed lease', async () => {
    const leaseExpiresAt = new Date(Date.now() + 30_000);
    const delivery: DeliveryRow = {
      id: 'whd_1',
      endpoint_id: 'wh_1',
      requested_endpoint_id: 'wh_1',
      delivery_key: 'live',
      event_id: 'whe_1',
      attempt: 2,
      status_code: null,
      response: null,
      status: 'pending',
      delivered_at: null,
      next_retry_at: leaseExpiresAt,
      created_at: new Date(),
    };
    const { db, setCalls, whereCalls } = createWebhookDeliveryDb(
      delivery,
      (row) =>
        row.status === 'pending' && row.next_retry_at?.getTime() === leaseExpiresAt.getTime(),
    );
    const repo = new WebhookDeliveryRepository(db);

    const result = await repo.completeClaimedAttempt('whd_1', leaseExpiresAt, {
      status: 'delivered',
      status_code: 204,
      response: '',
      delivered_at: new Date(),
      next_retry_at: null,
    });

    expect(result.updated).toBe(true);
    expect(result.delivery).toMatchObject({
      id: 'whd_1',
      status: 'delivered',
      status_code: 204,
      response: '',
      next_retry_at: null,
    });
    expect(setCalls[0]).toMatchObject({
      status: 'delivered',
      status_code: 204,
      response: '',
      next_retry_at: null,
    });
    expect(whereCalls).toContainEqual(['id', '=', 'whd_1']);
    expect(whereCalls).toContainEqual(['status', '=', 'pending']);
    expect(whereCalls).toContainEqual(['next_retry_at', '=', leaseExpiresAt]);
  });

  it('does not complete a stale lease after another owner changed the delivery', async () => {
    const staleLeaseExpiresAt = new Date(Date.now() - 30_000);
    const currentLeaseExpiresAt = new Date(Date.now() + 30_000);
    const delivery: DeliveryRow = {
      id: 'whd_1',
      endpoint_id: 'wh_1',
      requested_endpoint_id: 'wh_1',
      delivery_key: 'live',
      event_id: 'whe_1',
      attempt: 2,
      status_code: null,
      response: null,
      status: 'pending',
      delivered_at: null,
      next_retry_at: currentLeaseExpiresAt,
      created_at: new Date(),
    };
    const { db } = createWebhookDeliveryDb(
      delivery,
      (row) =>
        row.status === 'pending' && row.next_retry_at?.getTime() === staleLeaseExpiresAt.getTime(),
    );
    const repo = new WebhookDeliveryRepository(db);

    const result = await repo.completeClaimedAttempt('whd_1', staleLeaseExpiresAt, {
      status: 'delivered',
      status_code: 204,
      response: '',
      delivered_at: new Date(),
      next_retry_at: null,
    });

    expect(result.updated).toBe(false);
    expect(result.delivery).toMatchObject({
      id: 'whd_1',
      status: 'pending',
      status_code: null,
      response: null,
      next_retry_at: currentLeaseExpiresAt,
    });
  });
});
