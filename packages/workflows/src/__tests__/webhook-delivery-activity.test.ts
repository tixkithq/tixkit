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

function createMockResponse(statusCode: number, body: string) {
  const listeners = new Map<string, Array<(chunk?: Buffer) => void>>();
  const response = {
    emitData: (chunk: Buffer | string) => {
      for (const listener of listeners.get('data') ?? []) {
        listener(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
    },
    emitBody: () => {
      if (body.length > 0) {
        response.emitData(body);
      }
      response.emitEnd();
    },
    emitEnd: () => {
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
  updateCalls: 0,
  nextCreateError: null as Error | null,
  nextUpdateError: null as Error | null,
  truncateClaimLeaseToSecond: false,
  destroy: vi.fn(),
}));

const dnsState = vi.hoisted(() => ({
  lookup: vi.fn(),
}));

const httpsState = vi.hoisted(() => ({
  heldResponses: [] as Array<ReturnType<typeof createMockResponse>>,
  holdResponses: false,
  onRequest: null as (() => void) | null,
  nextError: null as Error | null,
  nextRequestError: null as Error | null,
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
    async findByAttempt(input: {
      eventId: string;
      requestedEndpointId: string;
      deliveryKey?: string;
      attempt: number;
    }) {
      return dbState.deliveries.find(
        (delivery) =>
          delivery.event_id === input.eventId &&
          delivery.requested_endpoint_id === input.requestedEndpointId &&
          delivery.delivery_key === (input.deliveryKey ?? 'live') &&
          delivery.attempt === input.attempt,
      );
    }

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
      if (dbState.nextCreateError) {
        const error = dbState.nextCreateError;
        dbState.nextCreateError = null;
        throw error;
      }

      const requestedEndpointId = input.requestedEndpointId ?? input.endpointId;
      const deliveryKey = input.deliveryKey ?? 'live';
      if (!requestedEndpointId)
        throw new Error('Webhook delivery requires a requested endpoint id');

      const existingDelivery = await this.findByAttempt({
        eventId: input.eventId,
        requestedEndpointId,
        deliveryKey,
        attempt: input.attempt,
      });
      if (existingDelivery) return existingDelivery;

      const delivery: DeliveryRow = {
        id: `whd_${dbState.deliveries.length + 1}`,
        endpoint_id: input.endpointId,
        requested_endpoint_id: requestedEndpointId,
        delivery_key: deliveryKey,
        event_id: input.eventId,
        attempt: input.attempt,
        status_code: input.statusCode ?? null,
        response: input.response ?? null,
        status: input.status ?? 'pending',
        delivered_at: input.deliveredAt ?? null,
        next_retry_at: input.nextRetryAt === undefined ? new Date() : input.nextRetryAt,
        created_at: new Date(),
      };
      dbState.deliveries.push(delivery);
      return delivery;
    }

    async update(id: string, input: Partial<DeliveryRow>) {
      dbState.updateCalls += 1;
      if (dbState.nextUpdateError) {
        const error = dbState.nextUpdateError;
        dbState.nextUpdateError = null;
        throw error;
      }
      const delivery = dbState.deliveries.find((row) => row.id === id);
      if (!delivery) throw new Error(`Delivery ${id} not found`);
      Object.assign(delivery, input);
      return delivery;
    }

    async completeClaimedAttempt(id: string, leaseExpiresAt: Date, input: Partial<DeliveryRow>) {
      dbState.updateCalls += 1;
      if (dbState.nextUpdateError) {
        const error = dbState.nextUpdateError;
        dbState.nextUpdateError = null;
        throw error;
      }
      const delivery = dbState.deliveries.find((row) => row.id === id);
      if (!delivery) throw new Error(`Delivery ${id} not found`);
      if (
        delivery.status !== 'pending' ||
        delivery.next_retry_at?.getTime() !== leaseExpiresAt.getTime()
      ) {
        return { updated: false, delivery };
      }

      Object.assign(delivery, input);
      return { updated: true, delivery };
    }

    async deadLetterAttempt(id: string, input: Partial<DeliveryRow>) {
      const delivery = dbState.deliveries.find((row) => row.id === id);
      if (!delivery) throw new Error(`Delivery ${id} not found`);
      if (
        delivery.status === 'delivered' ||
        delivery.status === 'dead_lettered' ||
        (delivery.status === 'pending' &&
          delivery.next_retry_at instanceof Date &&
          delivery.next_retry_at.getTime() > Date.now())
      ) {
        return { updated: false, delivery };
      }

      dbState.updateCalls += 1;
      if (dbState.nextUpdateError) {
        const error = dbState.nextUpdateError;
        dbState.nextUpdateError = null;
        throw error;
      }

      Object.assign(delivery, input);
      return { updated: true, delivery };
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
      if (!requestedEndpointId)
        throw new Error('Webhook delivery claim requires a requested endpoint id');
      const delivery = await this.create({
        endpointId: input.endpointId,
        requestedEndpointId,
        deliveryKey,
        eventId: input.eventId,
        attempt: input.attempt,
      });
      const now = new Date();
      const canClaim =
        (delivery.status === 'failed' || delivery.status === 'pending') &&
        (delivery.next_retry_at === null || delivery.next_retry_at.getTime() <= now.getTime());

      if (!canClaim) {
        return { claimed: false, delivery };
      }

      delivery.endpoint_id = input.endpointId;
      delivery.status = 'pending';
      delivery.status_code = null;
      delivery.response = null;
      delivery.delivered_at = null;
      delivery.next_retry_at = dbState.truncateClaimLeaseToSecond
        ? new Date(Math.floor(input.leaseExpiresAt.getTime() / 1000) * 1000)
        : input.leaseExpiresAt;
      return { claimed: true, delivery };
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
    dbState.updateCalls = 0;
    dbState.nextCreateError = null;
    dbState.nextUpdateError = null;
    dbState.truncateClaimLeaseToSecond = false;
    dbState.destroy.mockClear();
    dnsState.lookup.mockReset();
    dnsState.lookup.mockImplementation(
      (
        _hostname: string,
        _options: { all: true },
        callback: (
          error: Error | null,
          addresses: Array<{ address: string; family: number }>,
        ) => void,
      ) => {
        callback(null, [{ address: '93.184.216.34', family: 4 }]);
      },
    );
    httpsState.nextError = null;
    httpsState.nextRequestError = null;
    httpsState.nextResponse = { statusCode: 204, body: '' };
    httpsState.holdResponses = false;
    httpsState.heldResponses = [];
    httpsState.onRequest = null;
    httpsState.requests = [];
    httpsState.request.mockReset();
    httpsState.request.mockImplementation(
      (
        options: MockHttpsRequest['options'],
        callback: (response: ReturnType<typeof createMockResponse>) => void,
      ) => {
        if (httpsState.nextRequestError) {
          const error = httpsState.nextRequestError;
          httpsState.nextRequestError = null;
          throw error;
        }

        const requestRecord: MockHttpsRequest = {
          body: '',
          connected: false,
          options,
        };
        // oxlint-disable-next-line unicorn/consistent-function-scoping -- scoped to each mocked request so tests cannot leak handlers between requests.
        let errorHandler: (error: Error) => void = () => {};
        const request = {
          destroy: vi.fn((error?: Error) => {
            errorHandler(error ?? new Error('Request destroyed'));
          }),
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
              if (httpsState.holdResponses) {
                httpsState.heldResponses.push(response);
              } else {
                queueMicrotask(() => response.emitBody());
              }
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
          setTimeout: vi.fn(),
          write: vi.fn((chunk: string | Buffer) => {
            requestRecord.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
            return true;
          }),
        };
        httpsState.requests.push(requestRecord);
        httpsState.onRequest?.();
        return request;
      },
    );
  });

  afterEach(() => {
    vi.useRealTimers();
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

  it('persists outcomes with the stored lease timestamp returned by the database', async () => {
    dbState.truncateClaimLeaseToSecond = true;

    const result = await deliverWebhookActivity({
      endpointId: 'wh_1',
      eventId: 'whe_1',
      payload: JSON.stringify({ id: 'whe_1', type: 'order.paid' }),
      attempt: 1,
      finalAttempt: false,
    });

    expect(result).toMatchObject({ ok: true, value: { statusCode: 204, response: '' } });
    expect(dbState.deliveries[0]).toMatchObject({
      status: 'delivered',
      status_code: 204,
      response: '',
      next_retry_at: null,
    });
    expect(dbState.updateCalls).toBe(1);
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

  it('fails and persists a bounded error when the endpoint response is too large', async () => {
    httpsState.nextResponse = { statusCode: 200, body: 'x'.repeat(64 * 1024 + 1) };

    const result = await deliverWebhookActivity({
      endpointId: 'wh_1',
      eventId: 'whe_1',
      payload: JSON.stringify({ orderId: 'ord_1' }),
      attempt: 1,
      finalAttempt: false,
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'WEBHOOK_DELIVERY_FAILED',
      retryable: true,
      message: 'Webhook response exceeded 65536 bytes',
    });
    expect(dbState.deliveries).toHaveLength(1);
    expect(dbState.deliveries[0]).toMatchObject({
      attempt: 1,
      status: 'failed',
      status_code: null,
      response: 'Webhook response exceeded 65536 bytes',
      delivered_at: null,
    });
    expect(dbState.deliveries[0]?.response).not.toContain('x'.repeat(1024));
    expect(dbState.deliveries[0]?.next_retry_at).toBeInstanceOf(Date);
    expect(dbState.updateCalls).toBe(1);
    expect(dbState.destroy).toHaveBeenCalledTimes(1);
  });

  it('accepts endpoint responses at the configured size cap', async () => {
    httpsState.nextResponse = { statusCode: 200, body: 'x'.repeat(64 * 1024) };

    const result = await deliverWebhookActivity({
      endpointId: 'wh_1',
      eventId: 'whe_1',
      payload: JSON.stringify({ orderId: 'ord_1' }),
      attempt: 1,
      finalAttempt: false,
    });

    expect(result).toMatchObject({
      ok: true,
      value: { statusCode: 200, response: 'x'.repeat(64 * 1024) },
    });
    expect(dbState.deliveries[0]).toMatchObject({
      status: 'delivered',
      status_code: 200,
      response: 'x'.repeat(64 * 1024),
      next_retry_at: null,
    });
    expect(dbState.updateCalls).toBe(1);
    expect(dbState.destroy).toHaveBeenCalledTimes(1);
  });

  it('enforces a hard request deadline for slow streaming responses', async () => {
    vi.useFakeTimers();
    httpsState.holdResponses = true;
    httpsState.nextResponse = { statusCode: 200, body: '' };

    const resultPromise = deliverWebhookActivity({
      endpointId: 'wh_1',
      eventId: 'whe_1',
      payload: JSON.stringify({ orderId: 'ord_1' }),
      attempt: 1,
      finalAttempt: false,
    });

    await vi.waitFor(() => {
      expect(httpsState.heldResponses).toHaveLength(1);
    });
    httpsState.heldResponses[0]?.emitData('still open');
    await vi.advanceTimersByTimeAsync(10_000);
    httpsState.heldResponses[0]?.emitData('still open');
    await vi.advanceTimersByTimeAsync(10_001);

    await expect(resultPromise).resolves.toMatchObject({
      ok: false,
      errorCode: 'WEBHOOK_DELIVERY_FAILED',
      retryable: true,
      message: 'Webhook request timed out',
    });
    expect(httpsState.request).toHaveBeenCalledTimes(1);
    expect(dbState.deliveries[0]).toMatchObject({
      status: 'failed',
      status_code: null,
      response: 'Webhook request timed out',
    });
    expect(dbState.updateCalls).toBe(1);
  });

  it('persists synchronous request construction failures without leaving a live deadline', async () => {
    vi.useFakeTimers();
    httpsState.nextRequestError = new TypeError('Invalid header value');

    const result = await deliverWebhookActivity({
      endpointId: 'wh_1',
      eventId: 'whe_1',
      payload: JSON.stringify({ orderId: 'ord_1' }),
      attempt: 1,
      finalAttempt: false,
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'WEBHOOK_DELIVERY_FAILED',
      retryable: true,
      message: 'Invalid header value',
    });
    expect(httpsState.request).toHaveBeenCalledTimes(1);
    expect(dbState.deliveries[0]).toMatchObject({
      status: 'failed',
      status_code: null,
      response: 'Invalid header value',
    });
    expect(dbState.updateCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(20_001);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('throws when a delivered response cannot be persisted', async () => {
    dbState.nextUpdateError = new Error('deadlock detected');

    await expect(
      deliverWebhookActivity({
        endpointId: 'wh_1',
        eventId: 'whe_1',
        payload: JSON.stringify({ orderId: 'ord_1' }),
        attempt: 1,
        finalAttempt: false,
      }),
    ).rejects.toThrow('Failed to persist webhook delivery outcome: deadlock detected');

    expect(httpsState.request).toHaveBeenCalledTimes(1);
    expect(dbState.deliveries).toHaveLength(1);
    expect(dbState.deliveries[0]).toMatchObject({
      id: 'whd_1',
      status: 'pending',
      status_code: null,
      response: null,
      delivered_at: null,
    });
    expect(dbState.updateCalls).toBe(1);
    expect(dbState.destroy).toHaveBeenCalledTimes(1);
  });

  it('throws when a final failed HTTP response cannot be dead-lettered', async () => {
    httpsState.nextResponse = { statusCode: 500, body: 'server error' };
    dbState.nextUpdateError = new Error('write timeout');

    await expect(
      deliverWebhookActivity({
        endpointId: 'wh_1',
        eventId: 'whe_1',
        payload: JSON.stringify({ orderId: 'ord_1' }),
        attempt: 3,
        finalAttempt: true,
      }),
    ).rejects.toThrow('Failed to persist webhook delivery outcome: write timeout');

    expect(httpsState.request).toHaveBeenCalledTimes(1);
    expect(dbState.deliveries).toHaveLength(1);
    expect(dbState.deliveries[0]).toMatchObject({
      id: 'whd_1',
      attempt: 3,
      status: 'pending',
      status_code: null,
      response: null,
      delivered_at: null,
    });
    expect(dbState.updateCalls).toBe(1);
    expect(dbState.destroy).toHaveBeenCalledTimes(1);
  });

  it('reuses the existing delivery row and stable header when the same attempt is retried', async () => {
    httpsState.nextError = new Error('network down');

    const firstResult = await deliverWebhookActivity({
      endpointId: 'wh_1',
      eventId: 'whe_1',
      payload: JSON.stringify({ orderId: 'ord_1' }),
      attempt: 2,
      finalAttempt: false,
    });

    expect(firstResult).toMatchObject({
      ok: false,
      errorCode: 'WEBHOOK_DELIVERY_FAILED',
      retryable: true,
      message: 'network down',
    });
    httpsState.nextError = null;
    httpsState.nextResponse = { statusCode: 204, body: '' };
    dbState.deliveries[0]!.next_retry_at = new Date(Date.now() - 1000);

    const secondResult = await deliverWebhookActivity({
      endpointId: 'wh_1',
      eventId: 'whe_1',
      payload: JSON.stringify({ orderId: 'ord_1' }),
      attempt: 2,
      finalAttempt: false,
    });

    expect(secondResult).toMatchObject({ ok: true, value: { statusCode: 204, response: '' } });
    expect(dbState.deliveries).toHaveLength(1);
    expect(dbState.deliveries[0]).toMatchObject({
      id: 'whd_1',
      attempt: 2,
      status: 'delivered',
      status_code: 204,
    });
    expect(httpsState.requests).toHaveLength(2);
    expect(httpsState.requests[0]?.options.headers).toMatchObject({
      'X-Tixkit-Delivery': 'whd_1',
    });
    expect(httpsState.requests[1]?.options.headers).toMatchObject({
      'X-Tixkit-Delivery': 'whd_1',
    });
    expect(dbState.destroy).toHaveBeenCalledTimes(2);
  });

  it('does not send a duplicate request while the same attempt is already in progress', async () => {
    httpsState.holdResponses = true;
    const firstRequestStarted = new Promise<void>((resolve) => {
      httpsState.onRequest = resolve;
    });

    const firstResultPromise = deliverWebhookActivity({
      endpointId: 'wh_1',
      eventId: 'whe_1',
      payload: JSON.stringify({ orderId: 'ord_1' }),
      attempt: 2,
      finalAttempt: false,
    });
    await firstRequestStarted;

    const secondResult = await deliverWebhookActivity({
      endpointId: 'wh_1',
      eventId: 'whe_1',
      payload: JSON.stringify({ orderId: 'ord_1' }),
      attempt: 2,
      finalAttempt: false,
    });

    expect(secondResult).toMatchObject({
      ok: false,
      errorCode: 'WEBHOOK_DELIVERY_IN_PROGRESS',
      retryable: true,
      message: 'Webhook delivery attempt is already in progress',
    });
    expect(httpsState.request).toHaveBeenCalledTimes(1);
    expect(httpsState.requests).toHaveLength(1);
    expect(dbState.deliveries).toHaveLength(1);
    expect(dbState.deliveries[0]).toMatchObject({
      id: 'whd_1',
      attempt: 2,
      status: 'pending',
      status_code: null,
      response: null,
      delivered_at: null,
    });
    expect(dbState.deliveries[0]?.next_retry_at).toBeInstanceOf(Date);
    expect(dbState.deliveries[0]?.next_retry_at?.getTime()).toBeGreaterThan(Date.now() + 30_000);

    httpsState.holdResponses = false;
    httpsState.heldResponses.shift()?.emitBody();
    const firstResult = await firstResultPromise;

    expect(firstResult).toMatchObject({ ok: true, value: { statusCode: 204, response: '' } });
    expect(dbState.deliveries[0]).toMatchObject({
      id: 'whd_1',
      attempt: 2,
      status: 'delivered',
      status_code: 204,
    });
    expect(dbState.destroy).toHaveBeenCalledTimes(2);
  });

  it('does not send a duplicate request while a failed same-attempt retry is in progress', async () => {
    dbState.deliveries.push({
      id: 'whd_failed',
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
    });
    httpsState.holdResponses = true;
    const firstRequestStarted = new Promise<void>((resolve) => {
      httpsState.onRequest = resolve;
    });

    const firstResultPromise = deliverWebhookActivity({
      endpointId: 'wh_1',
      eventId: 'whe_1',
      payload: JSON.stringify({ orderId: 'ord_1' }),
      attempt: 2,
      finalAttempt: false,
    });
    await firstRequestStarted;

    const secondResult = await deliverWebhookActivity({
      endpointId: 'wh_1',
      eventId: 'whe_1',
      payload: JSON.stringify({ orderId: 'ord_1' }),
      attempt: 2,
      finalAttempt: false,
    });

    expect(secondResult).toMatchObject({
      ok: false,
      errorCode: 'WEBHOOK_DELIVERY_IN_PROGRESS',
      retryable: true,
      message: 'Webhook delivery attempt is already in progress',
    });
    expect(httpsState.request).toHaveBeenCalledTimes(1);
    expect(httpsState.requests).toHaveLength(1);
    expect(dbState.deliveries).toHaveLength(1);
    expect(dbState.deliveries[0]).toMatchObject({
      id: 'whd_failed',
      attempt: 2,
      status: 'pending',
      status_code: null,
      response: null,
      delivered_at: null,
    });

    httpsState.holdResponses = false;
    httpsState.heldResponses.shift()?.emitBody();
    const firstResult = await firstResultPromise;

    expect(firstResult).toMatchObject({ ok: true, value: { statusCode: 204, response: '' } });
    expect(dbState.deliveries[0]).toMatchObject({
      id: 'whd_failed',
      attempt: 2,
      status: 'delivered',
      status_code: 204,
      response: '',
    });
    expect(dbState.destroy).toHaveBeenCalledTimes(2);
  });

  it('does not send a failed same-attempt retry before its scheduled retry time', async () => {
    const retryAt = new Date(Date.now() + 30_000);
    dbState.deliveries.push({
      id: 'whd_failed',
      endpoint_id: 'wh_1',
      requested_endpoint_id: 'wh_1',
      delivery_key: 'live',
      event_id: 'whe_1',
      attempt: 2,
      status_code: null,
      response: 'network down',
      status: 'failed',
      delivered_at: null,
      next_retry_at: retryAt,
      created_at: new Date(),
    });

    const result = await deliverWebhookActivity({
      endpointId: 'wh_1',
      eventId: 'whe_1',
      payload: JSON.stringify({ orderId: 'ord_1' }),
      attempt: 2,
      finalAttempt: false,
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'WEBHOOK_DELIVERY_IN_PROGRESS',
      retryable: true,
      message: 'Webhook delivery attempt is already in progress',
    });
    expect(httpsState.request).not.toHaveBeenCalled();
    expect(dbState.deliveries).toHaveLength(1);
    expect(dbState.deliveries[0]).toMatchObject({
      id: 'whd_failed',
      attempt: 2,
      status: 'failed',
      status_code: null,
      response: 'network down',
      delivered_at: null,
      next_retry_at: retryAt,
    });
    expect(dbState.destroy).toHaveBeenCalledTimes(1);
  });

  it('does not overwrite a delivered row when a stale held request completes', async () => {
    httpsState.holdResponses = true;
    const firstRequestStarted = new Promise<void>((resolve) => {
      httpsState.onRequest = resolve;
    });

    const staleResultPromise = deliverWebhookActivity({
      endpointId: 'wh_1',
      eventId: 'whe_1',
      payload: JSON.stringify({ orderId: 'ord_1' }),
      attempt: 2,
      finalAttempt: false,
    });
    await firstRequestStarted;

    Object.assign(dbState.deliveries[0]!, {
      status: 'delivered',
      status_code: 202,
      response: 'already delivered',
      delivered_at: new Date(),
      next_retry_at: null,
    });

    httpsState.holdResponses = false;
    httpsState.heldResponses.shift()?.emitBody();
    const staleResult = await staleResultPromise;

    expect(staleResult).toMatchObject({
      ok: true,
      value: { statusCode: 202, response: 'already delivered' },
    });
    expect(dbState.deliveries[0]).toMatchObject({
      id: 'whd_1',
      attempt: 2,
      status: 'delivered',
      status_code: 202,
      response: 'already delivered',
      next_retry_at: null,
    });
    expect(dbState.updateCalls).toBe(1);
    expect(dbState.destroy).toHaveBeenCalledTimes(1);
  });

  it('does not overwrite a dead-lettered row when a stale held request completes', async () => {
    httpsState.holdResponses = true;
    const firstRequestStarted = new Promise<void>((resolve) => {
      httpsState.onRequest = resolve;
    });

    const staleResultPromise = deliverWebhookActivity({
      endpointId: 'wh_1',
      eventId: 'whe_1',
      payload: JSON.stringify({ orderId: 'ord_1' }),
      attempt: 2,
      finalAttempt: false,
    });
    await firstRequestStarted;

    Object.assign(dbState.deliveries[0]!, {
      status: 'dead_lettered',
      status_code: 410,
      response: 'operator dead-lettered',
      delivered_at: null,
      next_retry_at: null,
    });

    httpsState.holdResponses = false;
    httpsState.heldResponses.shift()?.emitBody();
    const staleResult = await staleResultPromise;

    expect(staleResult).toMatchObject({
      ok: false,
      errorCode: 'WEBHOOK_DELIVERY_ALREADY_TERMINAL',
      retryable: false,
      message: 'operator dead-lettered',
    });
    expect(dbState.deliveries[0]).toMatchObject({
      id: 'whd_1',
      attempt: 2,
      status: 'dead_lettered',
      status_code: 410,
      response: 'operator dead-lettered',
      next_retry_at: null,
    });
    expect(dbState.updateCalls).toBe(1);
    expect(dbState.destroy).toHaveBeenCalledTimes(1);
  });

  it('returns terminal delivered attempts without creating a second row or sending again', async () => {
    dbState.deliveries.push({
      id: 'whd_1',
      endpoint_id: 'wh_1',
      requested_endpoint_id: 'wh_1',
      delivery_key: 'live',
      event_id: 'whe_1',
      attempt: 1,
      status_code: 204,
      response: '',
      status: 'delivered',
      delivered_at: new Date(),
      next_retry_at: null,
      created_at: new Date(),
    });

    const result = await deliverWebhookActivity({
      endpointId: 'wh_1',
      eventId: 'whe_1',
      payload: JSON.stringify({ orderId: 'ord_1' }),
      attempt: 1,
      finalAttempt: false,
    });

    expect(result).toMatchObject({ ok: true, value: { statusCode: 204, response: '' } });
    expect(httpsState.request).not.toHaveBeenCalled();
    expect(dbState.deliveries).toHaveLength(1);
    expect(dbState.updateCalls).toBe(0);
    expect(dbState.destroy).toHaveBeenCalledTimes(1);
  });

  it('replays a delivered attempt with a replay-scoped delivery key', async () => {
    dbState.deliveries.push({
      id: 'whd_live',
      endpoint_id: 'wh_1',
      requested_endpoint_id: 'wh_1',
      delivery_key: 'live',
      event_id: 'whe_1',
      attempt: 1,
      status_code: 204,
      response: '',
      status: 'delivered',
      delivered_at: new Date(),
      next_retry_at: null,
      created_at: new Date(),
    });

    const result = await deliverWebhookActivity({
      endpointId: 'wh_1',
      eventId: 'whe_1',
      replayNonce: 'rpl_1',
      payload: JSON.stringify({ orderId: 'ord_1' }),
      attempt: 1,
      finalAttempt: false,
    });

    expect(result).toMatchObject({ ok: true, value: { statusCode: 204, response: '' } });
    expect(httpsState.request).toHaveBeenCalledTimes(1);
    expect(dbState.deliveries).toHaveLength(2);
    expect(dbState.deliveries[1]).toMatchObject({
      id: 'whd_2',
      endpoint_id: 'wh_1',
      requested_endpoint_id: 'wh_1',
      delivery_key: 'replay:rpl_1',
      event_id: 'whe_1',
      attempt: 1,
      status: 'delivered',
      status_code: 204,
    });
    expect(dbState.destroy).toHaveBeenCalledTimes(1);
  });

  it('dead-letters inactive endpoints without sending a request', async () => {
    dbState.endpoint = {
      id: 'wh_1',
      url: 'https://example.test/webhook',
      secret: 'secret_1',
      status: 'disabled',
    };

    const result = await deliverWebhookActivity({
      endpointId: 'wh_1',
      eventId: 'whe_1',
      payload: JSON.stringify({ orderId: 'ord_1' }),
      attempt: 1,
      finalAttempt: false,
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'ENDPOINT_INACTIVE',
      retryable: false,
      message: 'Webhook endpoint is not active',
    });
    expect(httpsState.request).not.toHaveBeenCalled();
    expect(dbState.deliveries).toHaveLength(1);
    expect(dbState.deliveries[0]).toMatchObject({
      requested_endpoint_id: 'wh_1',
      attempt: 1,
      status: 'dead_lettered',
      status_code: null,
      response: 'Webhook endpoint is not active',
      delivered_at: null,
      next_retry_at: null,
    });
    expect(dbState.updateCalls).toBe(0);
    expect(dbState.destroy).toHaveBeenCalledTimes(1);
  });

  it('throws when inactive endpoint dead-letter creation cannot be persisted', async () => {
    dbState.endpoint = {
      id: 'wh_1',
      url: 'https://example.test/webhook',
      secret: 'secret_1',
      status: 'disabled',
    };
    dbState.nextCreateError = new Error('database unavailable');

    await expect(
      deliverWebhookActivity({
        endpointId: 'wh_1',
        eventId: 'whe_1',
        payload: JSON.stringify({ orderId: 'ord_1' }),
        attempt: 5,
        finalAttempt: true,
      }),
    ).rejects.toThrow('Failed to persist webhook dead-letter delivery: database unavailable');

    expect(httpsState.request).not.toHaveBeenCalled();
    expect(dbState.deliveries).toHaveLength(0);
    expect(dbState.destroy).toHaveBeenCalledTimes(1);
  });

  it('throws when an existing inactive endpoint delivery cannot be repaired to dead-lettered', async () => {
    dbState.endpoint = {
      id: 'wh_1',
      url: 'https://example.test/webhook',
      secret: 'secret_1',
      status: 'disabled',
    };
    dbState.deliveries.push({
      id: 'whd_existing',
      endpoint_id: 'wh_1',
      requested_endpoint_id: 'wh_1',
      delivery_key: 'live',
      event_id: 'whe_1',
      attempt: 5,
      status_code: null,
      response: null,
      status: 'pending',
      delivered_at: null,
      next_retry_at: new Date(Date.now() - 1000),
      created_at: new Date(),
    });
    dbState.nextUpdateError = new Error('deadlock detected');

    await expect(
      deliverWebhookActivity({
        endpointId: 'wh_1',
        eventId: 'whe_1',
        payload: JSON.stringify({ orderId: 'ord_1' }),
        attempt: 5,
        finalAttempt: true,
      }),
    ).rejects.toThrow('Failed to persist webhook dead-letter delivery: deadlock detected');

    expect(httpsState.request).not.toHaveBeenCalled();
    expect(dbState.deliveries).toHaveLength(1);
    expect(dbState.deliveries[0]).toMatchObject({
      id: 'whd_existing',
      status: 'pending',
      response: null,
    });
    expect(dbState.updateCalls).toBe(1);
    expect(dbState.destroy).toHaveBeenCalledTimes(1);
  });

  it('does not dead-letter an inactive endpoint over an unexpired in-flight lease', async () => {
    dbState.endpoint = {
      id: 'wh_1',
      url: 'https://example.test/webhook',
      secret: 'secret_1',
      status: 'disabled',
    };
    dbState.deliveries.push({
      id: 'whd_existing',
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
    });

    const result = await deliverWebhookActivity({
      endpointId: 'wh_1',
      eventId: 'whe_1',
      payload: JSON.stringify({ orderId: 'ord_1' }),
      attempt: 2,
      finalAttempt: false,
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'WEBHOOK_DELIVERY_IN_PROGRESS',
      retryable: true,
      message: 'Webhook delivery attempt is already in progress',
    });
    expect(httpsState.request).not.toHaveBeenCalled();
    expect(dbState.deliveries).toHaveLength(1);
    expect(dbState.deliveries[0]).toMatchObject({
      id: 'whd_existing',
      status: 'pending',
      response: null,
    });
    expect(dbState.updateCalls).toBe(0);
    expect(dbState.destroy).toHaveBeenCalledTimes(1);
  });

  it('dead-letters missing endpoints without sending a request', async () => {
    dbState.endpoint = null;

    const result = await deliverWebhookActivity({
      endpointId: 'wh_missing',
      eventId: 'whe_1',
      payload: JSON.stringify({ orderId: 'ord_1' }),
      attempt: 1,
      finalAttempt: false,
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'ENDPOINT_NOT_FOUND',
      retryable: false,
      message: 'Webhook endpoint not found',
    });
    expect(httpsState.request).not.toHaveBeenCalled();
    expect(dbState.deliveries).toHaveLength(1);
    expect(dbState.deliveries[0]).toMatchObject({
      endpoint_id: null,
      requested_endpoint_id: 'wh_missing',
      event_id: 'whe_1',
      attempt: 1,
      status: 'dead_lettered',
      status_code: null,
      response: 'Webhook endpoint not found',
      delivered_at: null,
      next_retry_at: null,
    });
    expect(dbState.updateCalls).toBe(0);
    expect(dbState.destroy).toHaveBeenCalledTimes(1);
  });

  it('throws when missing endpoint dead-letter creation cannot be persisted', async () => {
    dbState.endpoint = null;
    dbState.nextCreateError = new Error('write timeout');

    await expect(
      deliverWebhookActivity({
        endpointId: 'wh_missing',
        eventId: 'whe_1',
        payload: JSON.stringify({ orderId: 'ord_1' }),
        attempt: 5,
        finalAttempt: true,
      }),
    ).rejects.toThrow('Failed to persist webhook dead-letter delivery: write timeout');

    expect(httpsState.request).not.toHaveBeenCalled();
    expect(dbState.deliveries).toHaveLength(0);
    expect(dbState.destroy).toHaveBeenCalledTimes(1);
  });

  it('throws when an existing missing endpoint delivery cannot be repaired to dead-lettered', async () => {
    dbState.endpoint = null;
    dbState.deliveries.push({
      id: 'whd_existing',
      endpoint_id: 'wh_missing',
      requested_endpoint_id: 'wh_missing',
      delivery_key: 'live',
      event_id: 'whe_1',
      attempt: 5,
      status_code: null,
      response: null,
      status: 'pending',
      delivered_at: null,
      next_retry_at: new Date(Date.now() - 1000),
      created_at: new Date(),
    });
    dbState.nextUpdateError = new Error('deadlock detected');

    await expect(
      deliverWebhookActivity({
        endpointId: 'wh_missing',
        eventId: 'whe_1',
        payload: JSON.stringify({ orderId: 'ord_1' }),
        attempt: 5,
        finalAttempt: true,
      }),
    ).rejects.toThrow('Failed to persist webhook dead-letter delivery: deadlock detected');

    expect(httpsState.request).not.toHaveBeenCalled();
    expect(dbState.deliveries).toHaveLength(1);
    expect(dbState.deliveries[0]).toMatchObject({
      id: 'whd_existing',
      status: 'pending',
      response: null,
    });
    expect(dbState.updateCalls).toBe(1);
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
    ['NAT64 private', '64:ff9b::a00:5'],
    ['NAT64 link-local', '64:ff9b::a9fe:a9fe'],
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
          callback(null, [{ address, family: address.includes(':') ? 6 : 4 }]);
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
        retryable: false,
        message: `Webhook URL host resolves to private or internal address ${address}`,
      });
      expect(httpsState.request).toHaveBeenCalledTimes(1);
      expect(httpsState.requests[0]?.connected).toBe(false);
      expect(dbState.deliveries).toHaveLength(1);
      expect(dbState.deliveries[0]).toMatchObject({
        attempt: 2,
        status: 'dead_lettered',
        status_code: null,
        response: `Webhook URL host resolves to private or internal address ${address}`,
        delivered_at: null,
        next_retry_at: null,
      });
      expect(dbState.destroy).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['plain HTTP URL', 'http://example.test/webhook', 'Webhook URL must use https'],
    ['localhost URL', 'https://localhost/webhook', 'Webhook URL host is private or internal'],
    ['private IP URL', 'https://10.0.0.5/webhook', 'Webhook URL host is private or internal'],
  ])('dead-letters a non-retryable %s before sending', async (_name, url, message) => {
    dbState.endpoint = {
      id: 'wh_1',
      url,
      secret: 'secret_1',
      status: 'active',
    };

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
      retryable: false,
      message,
    });
    expect(httpsState.request).not.toHaveBeenCalled();
    expect(dbState.deliveries).toHaveLength(1);
    expect(dbState.deliveries[0]).toMatchObject({
      attempt: 2,
      status: 'dead_lettered',
      status_code: null,
      response: message,
      delivered_at: null,
      next_retry_at: null,
    });
    expect(dbState.destroy).toHaveBeenCalledTimes(1);
  });

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
      retryable: false,
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

  it('throws when a final endpoint request failure cannot be dead-lettered', async () => {
    httpsState.nextError = new Error('connection refused');
    dbState.nextUpdateError = new Error('write timeout');

    await expect(
      deliverWebhookActivity({
        endpointId: 'wh_1',
        eventId: 'whe_1',
        payload: JSON.stringify({ orderId: 'ord_1' }),
        attempt: 5,
        finalAttempt: true,
      }),
    ).rejects.toThrow('Failed to persist webhook delivery outcome: write timeout');

    expect(dbState.deliveries).toHaveLength(1);
    expect(dbState.deliveries[0]).toMatchObject({
      attempt: 5,
      status: 'pending',
      status_code: null,
      response: null,
      delivered_at: null,
    });
    expect(dbState.updateCalls).toBe(1);
    expect(dbState.destroy).toHaveBeenCalledTimes(1);
  });
});
