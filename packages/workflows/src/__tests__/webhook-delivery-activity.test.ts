import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type DeliveryRow = {
  id: string;
  endpoint_id: string;
  event_id: string;
  attempt: number;
  status_code: number | null;
  response: string | null;
  status: string;
  delivered_at: Date | null;
  next_retry_at: Date | null;
  created_at: Date;
};

const dbState = vi.hoisted(() => ({
  endpoint: {
    id: 'wh_1',
    url: 'https://example.test/webhook',
    status: 'active',
  } as { id: string; url: string; status: string } | null,
  deliveries: [] as DeliveryRow[],
  destroy: vi.fn(),
}));

vi.mock('@tixkit/db', () => {
  class WebhookEndpointRepository {
    async findById(id: string) {
      return dbState.endpoint?.id === id ? dbState.endpoint : null;
    }
  }

  class WebhookDeliveryRepository {
    async create(input: { endpointId: string; eventId: string; attempt: number }) {
      const delivery: DeliveryRow = {
        id: `whd_${dbState.deliveries.length + 1}`,
        endpoint_id: input.endpointId,
        event_id: input.eventId,
        attempt: input.attempt,
        status_code: null,
        response: null,
        status: 'pending',
        delivered_at: null,
        next_retry_at: new Date(),
        created_at: new Date(),
      };
      dbState.deliveries.push(delivery);
      return delivery;
    }

    async update(id: string, input: Partial<DeliveryRow>) {
      const delivery = dbState.deliveries.find((row) => row.id === id);
      if (!delivery) throw new Error(`Delivery ${id} not found`);
      Object.assign(delivery, input);
      return delivery;
    }
  }

  return {
    createDb: () => ({ destroy: dbState.destroy }),
    WebhookDeliveryRepository,
    WebhookEndpointRepository,
  };
});

const { deliverWebhookActivity } = await import('../activities/webhook-delivery.js');

describe('deliverWebhookActivity', () => {
  beforeEach(() => {
    dbState.endpoint = {
      id: 'wh_1',
      url: 'https://example.test/webhook',
      status: 'active',
    };
    dbState.deliveries = [];
    dbState.destroy.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the documented consumer contract headers and signs the raw body', async () => {
    const fetchMock = vi.fn(async () => ({
      status: 204,
      text: async () => '',
    }));
    vi.stubGlobal('fetch', fetchMock);
    const payload = JSON.stringify({
      id: 'whe_1',
      type: 'order.paid',
      apiVersion: '2026-01-01',
      data: { orderId: 'ord_1' },
    });

    const result = await deliverWebhookActivity({
      apiVersion: '2026-01-01',
      endpointId: 'wh_1',
      eventId: 'whe_1',
      eventType: 'order.paid',
      payload,
      secret: 'secret_1',
      attempt: 1,
      finalAttempt: false,
    });

    expect(result).toMatchObject({ ok: true, value: { statusCode: 204, response: '' } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://example.test/webhook');
    expect(init.body).toBe(payload);
    const headers = init.headers as Record<string, string>;
    expect(headers).toMatchObject({
      'Content-Type': 'application/json',
      'User-Agent': 'Tixkit-Webhook/1.0',
      'X-Tixkit-API-Version': '2026-01-01',
      'X-Tixkit-Delivery': 'whd_1',
      'X-Tixkit-Event-ID': 'whe_1',
      'X-Tixkit-Event-Type': 'order.paid',
    });
    const signature = headers['X-Tixkit-Signature'];
    expect(signature).toMatch(/^t=\d+,v1=[a-f0-9]{64}$/);
    const timestamp = signature.match(/^t=(\d+),/)?.[1];
    expect(timestamp).toBeDefined();
    const expectedSignature = createHmac('sha256', 'secret_1')
      .update(`${timestamp}.${payload}`)
      .digest('hex');
    expect(signature).toBe(`t=${timestamp},v1=${expectedSignature}`);
    expect(dbState.deliveries[0]).toMatchObject({
      id: 'whd_1',
      status: 'delivered',
      status_code: 204,
    });
  });

  it('marks the final failed HTTP response as dead-lettered', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 500,
      text: async () => 'server error',
    })));

    const result = await deliverWebhookActivity({
      endpointId: 'wh_1',
      eventId: 'whe_1',
      payload: JSON.stringify({ orderId: 'ord_1' }),
      secret: 'secret_1',
      attempt: 3,
      finalAttempt: true,
    });

    expect(result).toMatchObject({ ok: true, value: { statusCode: 500, response: 'server error' } });
    expect(dbState.deliveries).toHaveLength(1);
    expect(dbState.deliveries[0]).toMatchObject({
      attempt: 3,
      status: 'dead_lettered',
      status_code: 500,
      response: 'server error',
      delivered_at: null,
      next_retry_at: null,
    });
    expect(dbState.destroy).toHaveBeenCalledTimes(1);
  });

  it('records a retryable failed attempt when the endpoint request throws before the final attempt', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down');
    }));

    const result = await deliverWebhookActivity({
      endpointId: 'wh_1',
      eventId: 'whe_1',
      payload: JSON.stringify({ orderId: 'ord_1' }),
      secret: 'secret_1',
      attempt: 2,
      finalAttempt: false,
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'WEBHOOK_DELIVERY_FAILED',
      retryable: true,
      message: 'network down',
    });
    expect(dbState.deliveries).toHaveLength(1);
    expect(dbState.deliveries[0]).toMatchObject({
      attempt: 2,
      status: 'failed',
      status_code: null,
      response: 'network down',
      delivered_at: null,
    });
    expect(dbState.deliveries[0]?.next_retry_at).toBeInstanceOf(Date);
    expect(dbState.destroy).toHaveBeenCalledTimes(1);
  });

  it('dead-letters the final failed attempt when the endpoint request throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('connection refused');
    }));

    const result = await deliverWebhookActivity({
      endpointId: 'wh_1',
      eventId: 'whe_1',
      payload: JSON.stringify({ orderId: 'ord_1' }),
      secret: 'secret_1',
      attempt: 5,
      finalAttempt: true,
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'WEBHOOK_DELIVERY_FAILED',
      retryable: true,
      message: 'connection refused',
    });
    expect(dbState.deliveries).toHaveLength(1);
    expect(dbState.deliveries[0]).toMatchObject({
      attempt: 5,
      status: 'dead_lettered',
      status_code: null,
      response: 'connection refused',
      delivered_at: null,
      next_retry_at: null,
    });
    expect(dbState.destroy).toHaveBeenCalledTimes(1);
  });
});
