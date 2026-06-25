import { afterEach, describe, it, expect, vi } from 'vitest';
import { GateKitClient, GateKitApiError } from '../index.js';

describe('GateKitClient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should construct with default config', () => {
    const client = new GateKitClient({ apiKey: 'gk_test_123' });
    expect(client).toBeDefined();
    expect(client.checkout).toBeDefined();
    expect(client.events).toBeDefined();
    expect(client.orders).toBeDefined();
    expect(client.tickets).toBeDefined();
  });

  it('constructs a public client without an API key', () => {
    const client = new GateKitClient({ apiBaseUrl: 'https://api.test' });
    expect(client.checkout).toBeDefined();
  });

  it('rejects secret API keys in browser runtimes', () => {
    const runtime = globalThis as typeof globalThis & { window?: unknown; document?: unknown };
    runtime.window = {};
    runtime.document = {};

    try {
      expect(() => new GateKitClient({ apiKey: 'gk_test_123' })).toThrow(/server-only/);
    } finally {
      delete runtime.window;
      delete runtime.document;
    }
  });

  it('should construct with custom config', () => {
    const client = new GateKitClient({
      apiKey: 'gk_test_123',
      apiBaseUrl: 'https://custom.api.com',
      apiVersion: '2026-01-01',
      timeout: 5000,
      maxRetries: 1,
    });
    expect(client).toBeDefined();
  });

  it('GateKitApiError should have correct properties', () => {
    const error = new GateKitApiError('NOT_FOUND', 'Resource not found', 404, 'req_123', { resource: 'event' });
    expect(error.code).toBe('NOT_FOUND');
    expect(error.message).toBe('Resource not found');
    expect(error.statusCode).toBe(404);
    expect(error.requestId).toBe('req_123');
    expect(error.details).toEqual({ resource: 'event' });
    expect(error.name).toBe('GateKitApiError');
  });

  it('sends caller supplied checkout idempotency key only as a header', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'cs_1', eventId: 'evt_1', status: 'open', currency: 'USD', quote: {}, expiresAt: '2026-01-01T00:00:00.000Z' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const client = new GateKitClient({ apiKey: 'gk_test_123', apiBaseUrl: 'https://api.test', maxRetries: 0 });
    await client.checkout.create({
      idempotencyKey: 'idem_checkout_1',
      eventId: 'evt_1',
      items: [{ ticketTypeId: 'tt_1', quantity: 1 }],
      buyer: { email: 'buyer@example.com' },
    });

    const [, init] = fetchMock.mock.calls[0]!;
    const headers = init?.headers as Record<string, string>;
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;

    expect(headers['Idempotency-Key']).toBe('idem_checkout_1');
    expect(body.idempotencyKey).toBeUndefined();
  });

  it('does not send Authorization when no API key is configured', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ items: [], nextCursor: null, hasMore: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const client = new GateKitClient({ apiBaseUrl: 'https://api.test', maxRetries: 0 });
    await client.events.list({ limit: 10 });

    const [url, init] = fetchMock.mock.calls[0]!;
    const headers = init?.headers as Record<string, string>;
    expect(String(url)).toBe('https://api.test/v1/events?limit=10');
    expect(headers.Authorization).toBeUndefined();
  });

	  it('sends caller supplied confirm idempotency key only as a header', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ sessionId: 'cs_1', status: 'pending_payment', totalCents: 5000 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const client = new GateKitClient({ apiKey: 'gk_test_123', apiBaseUrl: 'https://api.test', maxRetries: 0 });
    await client.checkout.confirm('cs_1', {
      idempotencyKey: 'idem_confirm_1',
      clientToken: 'cstok_1',
      paymentMethodId: 'pm_1',
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    const headers = init?.headers as Record<string, string>;
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;

    expect(String(url)).toBe('https://api.test/v1/checkout/sessions/cs_1/confirm');
    expect(headers['Idempotency-Key']).toBe('idem_confirm_1');
	    expect(headers['X-Checkout-Session-Token']).toBe('cstok_1');
	    expect(body).toEqual({ paymentMethodId: 'pm_1' });
	  });

	  it('does not retry unsafe mutations without an idempotency key', async () => {
	    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
	      new Response(
	        JSON.stringify({
	          error: { code: 'SERVICE_UNAVAILABLE', message: 'try later', requestId: 'req_1' },
	        }),
	        { status: 503, headers: { 'Content-Type': 'application/json' } },
	      ),
	    );

	    const client = new GateKitClient({ apiKey: 'gk_test_123', apiBaseUrl: 'https://api.test', maxRetries: 2 });
	    await expect(
	      client.events.create({
	        organizationId: 'org_1',
	        brandId: 'brd_1',
	        slug: 'launch',
	        title: 'Launch',
	        timezone: 'America/New_York',
	        startsAt: '2026-07-01T00:00:00.000Z',
	      }),
	    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });

	    expect(fetchMock).toHaveBeenCalledTimes(1);
	  });

	  it('retries idempotent mutations when an idempotency key is supplied', async () => {
	    const fetchMock = vi
	      .spyOn(globalThis, 'fetch')
	      .mockResolvedValueOnce(
	        new Response(
	          JSON.stringify({
	            error: { code: 'SERVICE_UNAVAILABLE', message: 'try later', requestId: 'req_1' },
	          }),
	          { status: 503, headers: { 'Content-Type': 'application/json' } },
	        ),
	      )
	      .mockResolvedValueOnce(
	        new Response(
	          JSON.stringify({
	            id: 'cs_1',
	            eventId: 'evt_1',
	            status: 'open',
	            currency: 'USD',
	            quote: { totalCents: 1000, subtotalCents: 1000, discountCents: 0, taxCents: 0, feeCents: 0 },
	            expiresAt: '2026-07-01T00:10:00.000Z',
	          }),
	          { status: 201, headers: { 'Content-Type': 'application/json' } },
	        ),
	      );

	    const client = new GateKitClient({ apiKey: 'gk_test_123', apiBaseUrl: 'https://api.test', maxRetries: 2 });
	    await client.checkout.create({
	      idempotencyKey: 'idem_checkout_retry',
	      eventId: 'evt_1',
	      items: [{ ticketTypeId: 'tt_1', quantity: 1 }],
	    });

	    expect(fetchMock).toHaveBeenCalledTimes(2);
	  });
	});
