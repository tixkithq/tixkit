import { afterEach, describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
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

  it('sends checkout tracking separately from affiliate attribution', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'cs_1', eventId: 'evt_1', status: 'open', currency: 'USD', quote: {}, expiresAt: '2026-01-01T00:00:00.000Z' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const client = new GateKitClient({ apiKey: 'gk_test_123', apiBaseUrl: 'https://api.test', maxRetries: 0 });
    await client.checkout.create({
      idempotencyKey: 'idem_checkout_tracking',
      eventId: 'evt_1',
      items: [{ ticketTypeId: 'tt_1', quantity: 1 }],
      trackingId: 'utm-campaign-1',
      affiliateCode: 'partner-1',
    });

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;

    expect(body.trackingId).toBe('utm-campaign-1');
    expect(body.affiliateCode).toBe('partner-1');
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
	        currency: 'USD',
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

  it('browser-target bundle does not contain bundled secret credentials', () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'gatekit-js-bundle-'));
    const outFile = path.join(tempDir, 'gatekit-js.browser.js');

    try {
      execFileSync(
        'bun',
        [
          'build',
          fileURLToPath(new URL('../index.ts', import.meta.url)),
          '--target=browser',
          '--format=esm',
          '--outfile',
          outFile,
        ],
        { stdio: 'pipe' },
      );

      const bundle = readFileSync(outFile, 'utf8');

      expect(bundle).not.toMatch(/\bgk_(live|test)_[A-Za-z0-9_-]{8,}\b/);
      expect(bundle).not.toContain('gatekit-manifest-secret-dev-only');
      expect(bundle).not.toContain('gatekit-qr-secret-dev-only');
      expect(bundle).not.toContain('whsec_');
      expect(bundle).toContain('Secret GateKit API keys are server-only');
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

	});

describe('GateKitClient new resource methods', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockFetch(status: number, body: unknown) {
    const init: ResponseInit = { status, headers: { 'Content-Type': 'application/json' } };
    if (status !== 204) {
      return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify(body), init),
      );
    }
    return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, init),
    );
  }

  function getCall(fetchMock: ReturnType<typeof vi.spyOn>, index = 0) {
    const [url, init] = fetchMock.mock.calls[index]!;
    return { url: String(url), method: init?.method, body: init?.body as string };
  }

  it('events.update sends PATCH with body', async () => {
    const fm = mockFetch(200, { id: 'evt_1', title: 'Updated' });
    const c = new GateKitClient({ apiKey: '***********', apiBaseUrl: 'https://api.test', maxRetries: 0 });
    await c.events.update('evt_1', { title: 'Updated' });
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/events/evt_1');
    expect(call.method).toBe('PATCH');
    expect(JSON.parse(call.body)).toEqual({ title: 'Updated' });
  });

  it('events.create includes required currency in the request body', async () => {
    const fm = mockFetch(201, { id: 'evt_1', title: 'Launch', currency: 'EUR' });
    const c = new GateKitClient({ apiKey: '***********', apiBaseUrl: 'https://api.test', maxRetries: 0 });
    await c.events.create({
      organizationId: 'org_1',
      brandId: 'brd_1',
      slug: 'launch',
      title: 'Launch',
      currency: 'EUR',
      timezone: 'Europe/Paris',
      startsAt: '2026-07-01T00:00:00.000Z',
    });
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/events');
    expect(call.method).toBe('POST');
    expect(JSON.parse(call.body)).toMatchObject({ currency: 'EUR' });
  });

  it('events.update sends status and currency when supplied', async () => {
    const fm = mockFetch(200, { id: 'evt_1', status: 'paused', currency: 'GBP' });
    const c = new GateKitClient({ apiKey: '***********', apiBaseUrl: 'https://api.test', maxRetries: 0 });
    await c.events.update('evt_1', { status: 'paused', currency: 'GBP' });
    const call = getCall(fm);
    expect(JSON.parse(call.body)).toEqual({ status: 'paused', currency: 'GBP' });
  });

  it('events.pause sends POST', async () => {
    const fm = mockFetch(200, { id: 'evt_1', status: 'paused' });
    const c = new GateKitClient({ apiKey: '***********', apiBaseUrl: 'https://api.test', maxRetries: 0 });
    await c.events.pause('evt_1');
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/events/evt_1/pause');
    expect(call.method).toBe('POST');
  });

  it('events.archive sends POST', async () => {
    const fm = mockFetch(200, { id: 'evt_1', status: 'archived' });
    const c = new GateKitClient({ apiKey: '***********', apiBaseUrl: 'https://api.test', maxRetries: 0 });
    await c.events.archive('evt_1');
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/events/evt_1/archive');
    expect(call.method).toBe('POST');
  });

  it('organizations.update sends PATCH', async () => {
    const fm = mockFetch(200, { id: 'org_1', name: 'Updated' });
    const c = new GateKitClient({ apiKey: '***********', apiBaseUrl: 'https://api.test', maxRetries: 0 });
    await c.organizations.update('org_1', { name: 'Updated' });
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/organizations/org_1');
    expect(call.method).toBe('PATCH');
  });

  it('attendees.listAll sends GET to /attendees with query params', async () => {
    const fm = mockFetch(200, { items: [], nextCursor: null, hasMore: false });
    const c = new GateKitClient({ apiKey: '***********', apiBaseUrl: 'https://api.test', maxRetries: 0 });
    await c.attendees.listAll({ eventId: 'evt_1', status: 'checked_in', limit: 50 });
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/attendees?limit=50&eventId=evt_1&status=checked_in');
    expect(call.method).toBe('GET');
  });

  it('exports.get sends GET', async () => {
    const fm = mockFetch(200, { exportId: 'exp_1', status: 'completed' });
    const c = new GateKitClient({ apiKey: '***********', apiBaseUrl: 'https://api.test', maxRetries: 0 });
    await c.exports.get('exp_1');
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/exports/exp_1');
    expect(call.method).toBe('GET');
  });

  it('exports.download sends GET', async () => {
    const fm = mockFetch(200, { downloadUrl: 'https://s3.example/file.csv', expiresAt: '2026-01-01' });
    const c = new GateKitClient({ apiKey: '***********', apiBaseUrl: 'https://api.test', maxRetries: 0 });
    await c.exports.download('exp_1');
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/exports/exp_1/download');
  });

  it('messages.list sends GET with pagination', async () => {
    const fm = mockFetch(200, { items: [], nextCursor: null, hasMore: false });
    const c = new GateKitClient({ apiKey: '***********', apiBaseUrl: 'https://api.test', maxRetries: 0 });
    await c.messages.list('evt_1', { limit: 10 });
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/events/evt_1/messages?limit=10');
  });

  it('messages.getCampaign sends GET', async () => {
    const fm = mockFetch(200, { id: 'cmp_1', status: 'sent' });
    const c = new GateKitClient({ apiKey: '***********', apiBaseUrl: 'https://api.test', maxRetries: 0 });
    await c.messages.getCampaign('evt_1', 'cmp_1');
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/events/evt_1/messages/cmp_1');
  });

  it('webhookEndpoints.listEvents sends GET', async () => {
    const fm = mockFetch(200, { items: [], nextCursor: null, hasMore: false });
    const c = new GateKitClient({ apiKey: '***********', apiBaseUrl: 'https://api.test', maxRetries: 0 });
    await c.webhookEndpoints.listEvents('ep_1');
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/webhook-endpoints/ep_1/events');
  });

  it('questions.list sends GET', async () => {
    const fm = mockFetch(200, { items: [], nextCursor: null, hasMore: false });
    const c = new GateKitClient({ apiKey: '***********', apiBaseUrl: 'https://api.test', maxRetries: 0 });
    await c.questions.list('evt_1');
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/events/evt_1/questions');
  });

  it('questions.create sends POST with body', async () => {
    const fm = mockFetch(201, { id: 'q_1', label: 'Name', fieldKey: 'name', type: 'text', required: true });
    const c = new GateKitClient({ apiKey: '***********', apiBaseUrl: 'https://api.test', maxRetries: 0 });
    await c.questions.create('evt_1', { label: 'Name', fieldKey: 'name', type: 'text', required: true });
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/events/evt_1/questions');
    expect(call.method).toBe('POST');
    expect(JSON.parse(call.body)).toEqual({ label: 'Name', fieldKey: 'name', type: 'text', required: true });
  });

  it('questions.update sends PATCH', async () => {
    const fm = mockFetch(200, { id: 'q_1', label: 'Updated' });
    const c = new GateKitClient({ apiKey: '***********', apiBaseUrl: 'https://api.test', maxRetries: 0 });
    await c.questions.update('q_1', { label: 'Updated' });
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/questions/q_1');
    expect(call.method).toBe('PATCH');
  });

  it('questions.reorder sends POST to the event-scoped reorder endpoint', async () => {
    const fm = mockFetch(200, { items: [], nextCursor: null, hasMore: false });
    const c = new GateKitClient({ apiKey: '***********', apiBaseUrl: 'https://api.test', maxRetries: 0 });
    await c.questions.reorder('evt_1', [
      { id: 'q_second', sortOrder: 0 },
      { id: 'q_first', sortOrder: 1 },
    ]);
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/events/evt_1/questions/reorder');
    expect(call.method).toBe('POST');
    expect(JSON.parse(call.body)).toEqual({
      questions: [
        { id: 'q_second', sortOrder: 0 },
        { id: 'q_first', sortOrder: 1 },
      ],
    });
  });

  it('questions.delete sends DELETE', async () => {
    const fm = mockFetch(204, null);
    const c = new GateKitClient({ apiKey: '***********', apiBaseUrl: 'https://api.test', maxRetries: 0 });
    await c.questions.delete('q_1');
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/questions/q_1');
    expect(call.method).toBe('DELETE');
  });

  it('oauthApplications.list sends GET', async () => {
    const fm = mockFetch(200, { items: [], nextCursor: null, hasMore: false });
    const c = new GateKitClient({ apiKey: '***********', apiBaseUrl: 'https://api.test', maxRetries: 0 });
    await c.oauthApplications.list();
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/oauth-applications');
  });

  it('oauthApplications.create sends POST with body', async () => {
    const fm = mockFetch(201, { id: 'app_1', name: 'Test', clientId: 'cli_1' });
    const c = new GateKitClient({ apiKey: '***********', apiBaseUrl: 'https://api.test', maxRetries: 0 });
    await c.oauthApplications.create({ organizationId: 'org_1', name: 'Test', redirectUris: ['https://example.com/cb'], scopes: ['read'] });
    const call = getCall(fm);
    expect(call.method).toBe('POST');
    expect(JSON.parse(call.body)).toEqual({ organizationId: 'org_1', name: 'Test', redirectUris: ['https://example.com/cb'], scopes: ['read'] });
  });

  it('oauthApplications.delete sends DELETE', async () => {
    const fm = mockFetch(204, null);
    const c = new GateKitClient({ apiKey: '***********', apiBaseUrl: 'https://api.test', maxRetries: 0 });
    await c.oauthApplications.delete('app_1');
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/oauth-applications/app_1');
    expect(call.method).toBe('DELETE');
  });

  it('public.getEvent sends GET without auth', async () => {
    const fm = mockFetch(200, { id: 'evt_1', title: 'Event' });
    const c = new GateKitClient({ apiBaseUrl: 'https://api.test', maxRetries: 0 });
    await c.public.getEvent('evt_1');
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/public/events/evt_1');
  });

  it('public.validateAccessCode sends POST with ticketTypeIds and accessCode', async () => {
    const fm = mockFetch(200, { valid: true, ticketTypeIds: ['tt_1'] });
    const c = new GateKitClient({ apiBaseUrl: 'https://api.test', maxRetries: 0 });
    await c.public.validateAccessCode('evt_1', { ticketTypeIds: ['tt_1'], accessCode: 'CODE123' });
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/public/events/evt_1/access-code');
    expect(call.method).toBe('POST');
    expect(JSON.parse(call.body)).toEqual({ ticketTypeIds: ['tt_1'], accessCode: 'CODE123' });
  });

  it('auth.me sends GET to /me', async () => {
    const fm = mockFetch(200, { userId: 'u_1', email: 'test@example.com' });
    const c = new GateKitClient({ apiKey: '***********', apiBaseUrl: 'https://api.test', maxRetries: 0 });
    await c.auth.me();
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/me');
  });
});
