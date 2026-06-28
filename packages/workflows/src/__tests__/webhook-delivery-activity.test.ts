import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MockHttpsRequest = {
  body: string;
  connected: boolean;
  lookupAddress?: string;
  lookupFamily?: number;
  options: {
    headers?: Record<string, string>;
    hostname?: string;
    lookup?: (
      hostname: string,
      options: { family?: number },
      callback: (error: Error | null, address: string, family: number) => void,
    ) => void;
    method?: string;
    path?: string;
    port?: number;
    protocol?: string;
  };
};

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

function createMockResponse(statusCode: number, body: string) {
  const listeners = new Map<string, Array<(chunk?: Buffer) => void>>();
  const response = {
    emitBody: () => {
      if (body.length > 0) {
        for (const listener of listeners.get('data') ?? []) {
          listener(Buffer.from(body));
        }
      }
      for (const listener of listeners.get('end') ?? []) {
        listener();
      }
    },
    on: vi.fn((event: string, listener: (chunk?: Buffer) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return response;
    }),
    statusCode,
  };

  return response;
}

const dbState = vi.hoisted(() => ({
  endpoint: {
    id: 'wh_1',
    url: 'https://example.test/webhook',
    secret: 'secret_1',
    status: 'active',
  } as { id: string; url: string; secret: string; status: string } | null,
  deliveries: [] as DeliveryRow[],
  destroy: vi.fn(),
}));

const dnsState = vi.hoisted(() => ({
  lookup: vi.fn(),
}));

const httpsState = vi.hoisted(() => ({
  nextError: null as Error | null,
  nextResponse: { statusCode: 204, body: '' },
  request: vi.fn(),
  requests: [] as MockHttpsRequest[],
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

vi.mock('node:dns', () => ({
  lookup: dnsState.lookup,
}));

vi.mock('node:https', () => ({
  request: httpsState.request,
}));

const { deliverWebhookActivity } = await import('../activities/webhook-delivery.js');

describe('deliverWebhookActivity', () => {
  beforeEach(() => {
    dbState.endpoint = {
      id: 'wh_1',
      url: 'https://example.test/webhook',
      secret: 'secret_1',
      status: 'active',
    };
    dbState.deliveries = [];
    dbState.destroy.mockClear();
    dnsState.lookup.mockReset();
    dnsState.lookup.mockImplementation(
      (
        _hostname: string,
        _options: { all: true },
        callback: (error: Error | null, addresses: Array<{ address: string; family: number }>) => void,
      ) => {
        callback(null, [{ address: '93.184.216.34', family: 4 }]);
      },
    );
    httpsState.nextError = null;
    httpsState.nextResponse = { statusCode: 204, body: '' };
    httpsState.requests = [];
    httpsState.request.mockReset();
    httpsState.request.mockImplementation(
      (
        options: MockHttpsRequest['options'],
        callback: (response: ReturnType<typeof createMockResponse>) => void,
      ) => {
        const requestRecord: MockHttpsRequest = {
          body: '',
          connected: false,
          options,
        };
        // oxlint-disable-next-line unicorn/consistent-function-scoping -- scoped to each mocked request so tests cannot leak handlers between requests.
        let errorHandler: (error: Error) => void = () => {};
        const request = {
          end: vi.fn(() => {
            const connect = () => {
              if (httpsState.nextError) {
                errorHandler(httpsState.nextError);
                return;
              }
              requestRecord.connected = true;
              const response = createMockResponse(
                httpsState.nextResponse.statusCode,
                httpsState.nextResponse.body,
              );
              callback(response);
              queueMicrotask(() => response.emitBody());
            };

            if (options.lookup && options.hostname) {
              options.lookup(options.hostname, { family: 0 }, (error, address, family) => {
                if (error) {
                  errorHandler(error);
                  return;
                }
                requestRecord.lookupAddress = address;
                requestRecord.lookupFamily = family;
                connect();
              });
              return;
            }

            connect();
          }),
          on: vi.fn((event: string, handler: (error: Error) => void) => {
            if (event === 'error') {
              errorHandler = handler;
            }
            return request;
          }),
          write: vi.fn((chunk: string | Buffer) => {
            requestRecord.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
            return true;
          }),
        };
        httpsState.requests.push(requestRecord);
        return request;
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the documented consumer contract headers and signs the raw body', async () => {
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
      attempt: 1,
      finalAttempt: false,
    });

    expect(result).toMatchObject({ ok: true, value: { statusCode: 204, response: '' } });
    expect(httpsState.request).toHaveBeenCalledTimes(1);
    expect(dnsState.lookup).toHaveBeenCalledWith(
      'example.test',
      expect.objectContaining({ all: true }),
      expect.any(Function),
    );
    const request = httpsState.requests[0];
    expect(request).toMatchObject({
      body: payload,
      connected: true,
      lookupAddress: '93.184.216.34',
      lookupFamily: 4,
      options: {
        hostname: 'example.test',
        method: 'POST',
        path: '/webhook',
        port: 443,
        protocol: 'https:',
      },
    });
    const headers = request.options.headers as Record<string, string>;
    expect(headers).toMatchObject({
      'Content-Length': Buffer.byteLength(payload).toString(),
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
    httpsState.nextResponse = { statusCode: 500, body: 'server error' };

    const result = await deliverWebhookActivity({
      endpointId: 'wh_1',
      eventId: 'whe_1',
      payload: JSON.stringify({ orderId: 'ord_1' }),
      attempt: 3,
      finalAttempt: true,
    });

    expect(result).toMatchObject({
      ok: true,
      value: { statusCode: 500, response: 'server error' },
    });
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

  it('does not follow redirects and dead-letters a final redirect response', async () => {
    httpsState.nextResponse = { statusCode: 302, body: 'redirect' };

    const result = await deliverWebhookActivity({
      endpointId: 'wh_1',
      eventId: 'whe_1',
      payload: JSON.stringify({ orderId: 'ord_1' }),
      attempt: 5,
      finalAttempt: true,
    });

    expect(result).toMatchObject({
      ok: true,
      value: { statusCode: 302, response: 'redirect' },
    });
    expect(httpsState.request).toHaveBeenCalledTimes(1);
    expect(httpsState.requests[0]).toMatchObject({
      connected: true,
      options: {
        hostname: 'example.test',
        method: 'POST',
        path: '/webhook',
        protocol: 'https:',
      },
    });
    expect(dbState.deliveries).toHaveLength(1);
    expect(dbState.deliveries[0]).toMatchObject({
      attempt: 5,
      status: 'dead_lettered',
      status_code: 302,
      response: 'redirect',
      delivered_at: null,
      next_retry_at: null,
    });
    expect(dbState.destroy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['private', '10.0.0.5'],
    ['loopback', '127.0.0.1'],
    ['link-local', '169.254.169.254'],
  ])(
    'rejects a hostname whose request-time DNS lookup returns a %s address before sending',
    async (_name, address) => {
      dnsState.lookup.mockImplementation(
        (
          _hostname: string,
          _options: { all: true },
          callback: (
            error: Error | null,
            addresses: Array<{ address: string; family: number }>,
          ) => void,
        ) => {
          callback(null, [{ address, family: 4 }]);
        },
      );

      const result = await deliverWebhookActivity({
        endpointId: 'wh_1',
        eventId: 'whe_1',
        payload: JSON.stringify({ orderId: 'ord_1' }),
        attempt: 2,
        finalAttempt: false,
      });

      expect(result).toMatchObject({
        ok: false,
        errorCode: 'WEBHOOK_DELIVERY_FAILED',
        retryable: true,
        message: `Webhook URL host resolves to private or internal address ${address}`,
      });
      expect(httpsState.request).toHaveBeenCalledTimes(1);
      expect(httpsState.requests[0]?.connected).toBe(false);
      expect(dbState.deliveries).toHaveLength(1);
      expect(dbState.deliveries[0]).toMatchObject({
        attempt: 2,
        status: 'failed',
        status_code: null,
        response: `Webhook URL host resolves to private or internal address ${address}`,
        delivered_at: null,
      });
      expect(dbState.deliveries[0]?.next_retry_at).toBeInstanceOf(Date);
      expect(dbState.destroy).toHaveBeenCalledTimes(1);
    },
  );

  it('records a retryable failed attempt when the endpoint request throws before the final attempt', async () => {
    httpsState.nextError = new Error('network down');

    const result = await deliverWebhookActivity({
      endpointId: 'wh_1',
      eventId: 'whe_1',
      payload: JSON.stringify({ orderId: 'ord_1' }),
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
    httpsState.nextError = new Error('connection refused');

    const result = await deliverWebhookActivity({
      endpointId: 'wh_1',
      eventId: 'whe_1',
      payload: JSON.stringify({ orderId: 'ord_1' }),
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
