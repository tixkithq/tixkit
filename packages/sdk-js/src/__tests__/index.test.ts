import { afterEach, describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  TixkitClient,
  TixkitApiError,
  type ContentRenderArtifact,
  type EmailTemplateDocument,
  type SmsTemplateDocument,
  type WebhookEvent,
} from '../index.js';

function mockFetch(status: number, body: unknown) {
  const init: ResponseInit = { status, headers: { 'Content-Type': 'application/json' } };
  if (status !== 204) {
    return vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response(JSON.stringify(body), init));
  }
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, init));
}

function getCall(fetchMock: ReturnType<typeof vi.spyOn>, index = 0) {
  const [url, init] = fetchMock.mock.calls[index]!;
  return {
    url: String(url),
    method: init?.method,
    body: init?.body as string,
    headers: init?.headers as Record<string, string>,
  };
}

describe('TixkitClient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should construct with default config', () => {
    const client = new TixkitClient({ apiKey: 'tk_test_123' });
    expect(client).toBeDefined();
    expect(client.checkout).toBeDefined();
    expect(client.events).toBeDefined();
    expect(client.orders).toBeDefined();
    expect(client.tickets).toBeDefined();
  });

  it('constructs a public client without an API key', () => {
    const client = new TixkitClient({ apiBaseUrl: 'https://api.test' });
    expect(client.checkout).toBeDefined();
  });

  it('rejects secret API keys in browser runtimes', () => {
    const runtime = globalThis as typeof globalThis & { window?: unknown; document?: unknown };
    runtime.window = {};
    runtime.document = {};

    try {
      expect(() => new TixkitClient({ apiKey: 'tk_test_123' })).toThrow(/server-only/);
    } finally {
      delete runtime.window;
      delete runtime.document;
    }
  });

  it('should construct with custom config', () => {
    const client = new TixkitClient({
      apiKey: 'tk_test_123',
      apiBaseUrl: 'https://custom.api.com',
      apiVersion: '2026-01-01',
      timeout: 5000,
      maxRetries: 1,
    });
    expect(client).toBeDefined();
  });

  it('normalizes trailing slashes from custom API base URLs', async () => {
    const fetchMock = mockFetch(200, { data: [], nextCursor: null });
    const client = new TixkitClient({
      apiKey: 'tk_test_123',
      apiBaseUrl: 'https://api.test///',
      maxRetries: 0,
    });

    await client.events.list();

    expect(getCall(fetchMock).url).toBe('https://api.test/v1/events');
  });

  it('TixkitApiError should have correct properties', () => {
    const error = new TixkitApiError('NOT_FOUND', 'Resource not found', 404, 'req_123', {
      resource: 'event',
    });
    expect(error.code).toBe('NOT_FOUND');
    expect(error.message).toBe('Resource not found');
    expect(error.statusCode).toBe(404);
    expect(error.requestId).toBe('req_123');
    expect(error.details).toEqual({ resource: 'event' });
    expect(error.name).toBe('TixkitApiError');
  });

  it('wraps empty API error responses with HTTP status details', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const client = new TixkitClient({
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });

    await expect(client.events.list()).rejects.toMatchObject({
      name: 'TixkitApiError',
      code: 'HTTP_502',
      message: 'Request failed with status 502',
      statusCode: 502,
      requestId: '',
    });
  });

  it('wraps malformed API error responses without losing client-error status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('upstream gateway error', {
        status: 400,
        headers: { 'Content-Type': 'text/plain' },
      }),
    );

    const client = new TixkitClient({
      apiBaseUrl: 'https://api.test',
      maxRetries: 3,
    });

    await expect(client.events.list()).rejects.toMatchObject({
      name: 'TixkitApiError',
      code: 'HTTP_400',
      message: 'Request failed with status 400',
      statusCode: 400,
      requestId: '',
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('sends caller supplied checkout idempotency key only as a header', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'cs_1',
          eventId: 'evt_1',
          status: 'open',
          currency: 'USD',
          quote: {},
          expiresAt: '2026-01-01T00:00:00.000Z',
        }),
        {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const client = new TixkitClient({
      apiKey: 'tk_test_123',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
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
      new Response(
        JSON.stringify({
          id: 'cs_1',
          eventId: 'evt_1',
          status: 'open',
          currency: 'USD',
          quote: {},
          expiresAt: '2026-01-01T00:00:00.000Z',
        }),
        {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const client = new TixkitClient({
      apiKey: 'tk_test_123',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
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

  it('sends product checkout line items', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'cs_1',
          eventId: 'evt_1',
          status: 'open',
          currency: 'USD',
          quote: {},
          expiresAt: '2026-01-01T00:00:00.000Z',
        }),
        {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const client = new TixkitClient({
      apiKey: 'tk_test_123',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await client.checkout.create({
      idempotencyKey: 'idem_checkout_products',
      eventId: 'evt_1',
      items: [
        { ticketTypeId: 'tt_1', quantity: 1 },
        { productId: 'prd_1', quantity: 2 },
      ],
    });

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;

    expect(body.items).toEqual([
      { ticketTypeId: 'tt_1', quantity: 1 },
      { productId: 'prd_1', quantity: 2 },
    ]);
  });

  it('sends resale checkout line items', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'cs_1',
          eventId: 'evt_1',
          status: 'open',
          currency: 'USD',
          quote: {},
          expiresAt: '2026-01-01T00:00:00.000Z',
        }),
        {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const client = new TixkitClient({
      apiKey: 'tk_test_123',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await client.checkout.create({
      idempotencyKey: 'idem_checkout_resale',
      eventId: 'evt_1',
      items: [{ resaleListingId: 'lst_1', quantity: 1 }],
    });

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;

    expect(body.items).toEqual([{ resaleListingId: 'lst_1', quantity: 1 }]);
  });

  it('passes waitlist claim tokens through checkout create', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'cs_1',
          eventId: 'evt_1',
          status: 'open',
          currency: 'USD',
          quote: {},
          expiresAt: '2026-01-01T00:00:00.000Z',
        }),
        {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const client = new TixkitClient({
      apiKey: 'tk_test_123',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await client.checkout.create({
      idempotencyKey: 'idem_checkout_waitlist',
      eventId: 'evt_1',
      items: [{ ticketTypeId: 'tt_1', quantity: 1 }],
      waitlistClaimToken: 'claim_token_123',
    });

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;

    expect(body.waitlistClaimToken).toBe('claim_token_123');
  });

  it('exposes admin waitlist list and offer helpers', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [],
            settings: { autoOfferEnabled: true, offerTtlMinutes: 1440 },
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ entry: { id: 'wl_1' }, claimToken: 'claim_token_123' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ autoOfferEnabled: false, offerTtlMinutes: 60 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    const client = new TixkitClient({
      apiKey: 'tk_test_123',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await client.events.listWaitlist('evt_1');
    await client.events.offerWaitlistEntry('evt_1', 'wl_1', { expiresInMinutes: 30 });
    await client.events.updateWaitlistSettings('evt_1', {
      autoOfferEnabled: false,
      offerTtlMinutes: 60,
    });

    expect(getCall(fetchMock, 0)).toMatchObject({
      url: 'https://api.test/v1/events/evt_1/waitlist',
      method: 'GET',
    });
    expect(getCall(fetchMock, 1)).toMatchObject({
      url: 'https://api.test/v1/events/evt_1/waitlist/wl_1/offer',
      method: 'POST',
      body: JSON.stringify({ expiresInMinutes: 30 }),
    });
    expect(getCall(fetchMock, 2)).toMatchObject({
      url: 'https://api.test/v1/events/evt_1/waitlist/settings',
      method: 'PATCH',
      body: JSON.stringify({ autoOfferEnabled: false, offerTtlMinutes: 60 }),
    });
  });

  it('exposes public waitlist helpers', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'wl_1',
            eventId: 'evt_1',
            ticketTypeId: 'tt_1',
            email: 'buyer@example.com',
            quantity: 1,
            status: 'joined',
          }),
          {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'wl_1',
            eventId: 'evt_1',
            ticketTypeId: 'tt_1',
            email: 'buyer@example.com',
            quantity: 1,
            status: 'offered',
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      );

    const client = new TixkitClient({ apiBaseUrl: 'https://api.test', maxRetries: 0 });
    await client.public.joinWaitlist('evt_1', {
      ticketTypeId: 'tt_1',
      email: 'buyer@example.com',
      quantity: 2,
    });
    await client.public.getWaitlistClaim('claim token');

    expect(getCall(fetchMock, 0)).toMatchObject({
      url: 'https://api.test/v1/public/events/evt_1/waitlist',
      method: 'POST',
      body: JSON.stringify({ ticketTypeId: 'tt_1', email: 'buyer@example.com', quantity: 2 }),
    });
    expect(getCall(fetchMock, 1)).toMatchObject({
      url: 'https://api.test/v1/public/waitlist/claims/claim%20token',
      method: 'GET',
    });
  });

  it('exposes admin marketing integration helpers', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [], nextCursor: null, hasMore: false }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'mkt_1', provider: 'ga4', status: 'active' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    const client = new TixkitClient({
      apiKey: 'tk_test_123',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await client.events.listMarketingIntegrations('evt_1');
    await client.events.upsertMarketingIntegration('evt_1', 'ga4', {
      config: { measurementId: 'G-TEST123' },
      consentRequired: true,
      status: 'active',
    });

    expect(getCall(fetchMock, 0)).toMatchObject({
      url: 'https://api.test/v1/events/evt_1/marketing-integrations',
      method: 'GET',
    });
    expect(getCall(fetchMock, 1)).toMatchObject({
      url: 'https://api.test/v1/events/evt_1/marketing-integrations/ga4',
      method: 'PUT',
      body: JSON.stringify({
        config: { measurementId: 'G-TEST123' },
        consentRequired: true,
        status: 'active',
      }),
    });
  });

  it('exposes public marketing integration helper', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ items: [{ provider: 'meta_pixel', status: 'active' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const client = new TixkitClient({ apiBaseUrl: 'https://api.test', maxRetries: 0 });

    await client.public.listMarketingIntegrations('evt_1');

    expect(getCall(fetchMock)).toMatchObject({
      url: 'https://api.test/v1/public/events/evt_1/marketing-integrations',
      method: 'GET',
    });
  });

  it('does not send Authorization when no API key is configured', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ items: [], nextCursor: null, hasMore: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const client = new TixkitClient({ apiBaseUrl: 'https://api.test', maxRetries: 0 });
    await client.events.list({ limit: 10 });

    const [url, init] = fetchMock.mock.calls[0]!;
    const headers = init?.headers as Record<string, string>;
    expect(String(url)).toBe('https://api.test/v1/events?limit=10');
    expect(headers.Authorization).toBeUndefined();
    expect(headers['Content-Type']).toBeUndefined();
  });

  it('sends Content-Type only when a JSON body is present', async () => {
    const fetchMock = mockFetch(200, { id: 'evt_1', title: 'Updated' });
    const client = new TixkitClient({
      apiKey: 'tk_test_123',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });

    await client.events.update('evt_1', { title: 'Updated' });

    expect(getCall(fetchMock).headers['Content-Type']).toBe('application/json');
  });

  it('sends caller supplied confirm idempotency key only as a header', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ sessionId: 'cs_1', status: 'pending_payment', totalCents: 5000 }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const client = new TixkitClient({
      apiKey: 'tk_test_123',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
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

  it('checkout.createBoxOfficeOrder sends POS tender body with idempotency', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          order: { id: 'ord_box', salesChannel: 'box_office', tenderType: 'cash' },
          sessionId: 'cs_box',
          status: 'completed',
        }),
        {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const client = new TixkitClient({
      apiKey: 'tk_test_123',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await client.checkout.createBoxOfficeOrder('evt_box', {
      idempotencyKey: 'box_cash_1',
      tenderType: 'cash',
      amountCents: 2500,
      buyer: { email: 'door@example.com' },
      items: [{ ticketTypeId: 'tt_ga', quantity: 1 }],
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    const headers = init?.headers as Record<string, string>;
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;

    expect(String(url)).toBe('https://api.test/v1/events/evt_box/box-office/orders');
    expect(headers['Idempotency-Key']).toBe('box_cash_1');
    expect(body).toEqual({
      tenderType: 'cash',
      amountCents: 2500,
      buyer: { email: 'door@example.com' },
      items: [{ ticketTypeId: 'tt_ga', quantity: 1 }],
    });
  });

  it('checkout.get can recover pending sessions with a payment intent client secret', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'cs_1', status: 'pending_payment' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const client = new TixkitClient({
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await client.checkout.get('cs_1', { paymentIntentClientSecret: 'pi_secret_123' });

    const [url, init] = fetchMock.mock.calls[0]!;
    const headers = init?.headers as Record<string, string>;

    expect(String(url)).toBe(
      'https://api.test/v1/checkout/sessions/cs_1?payment_intent_client_secret=pi_secret_123',
    );
    expect(headers).not.toHaveProperty('X-Checkout-Session-Token');
  });

  it('checkout.get keeps the legacy token argument for session reads', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'cs_1', status: 'open' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const client = new TixkitClient({
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await client.checkout.get('cs_1', 'cstok_1');

    const [url, init] = fetchMock.mock.calls[0]!;
    const headers = init?.headers as Record<string, string>;

    expect(String(url)).toBe('https://api.test/v1/checkout/sessions/cs_1');
    expect(headers['X-Checkout-Session-Token']).toBe('cstok_1');
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

    const client = new TixkitClient({
      apiKey: 'tk_test_123',
      apiBaseUrl: 'https://api.test',
      maxRetries: 2,
    });
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
            quote: {
              totalCents: 1000,
              subtotalCents: 1000,
              discountCents: 0,
              taxCents: 0,
              feeCents: 0,
            },
            expiresAt: '2026-07-01T00:10:00.000Z',
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
      );

    const client = new TixkitClient({
      apiKey: 'tk_test_123',
      apiBaseUrl: 'https://api.test',
      maxRetries: 2,
    });
    await client.checkout.create({
      idempotencyKey: 'idem_checkout_retry',
      eventId: 'evt_1',
      items: [{ ticketTypeId: 'tt_1', quantity: 1 }],
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('browser-target bundle does not contain bundled secret credentials', () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'tixkit-js-bundle-'));
    const outFile = path.join(tempDir, 'tixkit-js.browser.js');

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

      expect(bundle).not.toMatch(/\btk_(live|test)_[A-Za-z0-9_-]{8,}\b/);
      expect(bundle).not.toContain('tixkit-manifest-secret-dev-only');
      expect(bundle).not.toContain('tixkit-qr-secret-dev-only');
      expect(bundle).not.toContain('whsec_');
      expect(bundle).toContain('Secret Tixkit API keys are server-only');
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });
});

describe('TixkitClient new resource methods', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('events.update sends PATCH with body', async () => {
    const fm = mockFetch(200, { id: 'evt_1', title: 'Updated' });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await c.events.update('evt_1', { title: 'Updated' });
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/events/evt_1');
    expect(call.method).toBe('PATCH');
    expect(JSON.parse(call.body)).toEqual({ title: 'Updated' });
  });

  it('events.create includes required currency in the request body', async () => {
    const fm = mockFetch(201, { id: 'evt_1', title: 'Launch', currency: 'EUR' });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
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
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await c.events.update('evt_1', { status: 'paused', currency: 'GBP' });
    const call = getCall(fm);
    expect(JSON.parse(call.body)).toEqual({ status: 'paused', currency: 'GBP' });
  });

  it('events.pause sends POST', async () => {
    const fm = mockFetch(200, { id: 'evt_1', status: 'paused' });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await c.events.pause('evt_1');
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/events/evt_1/pause');
    expect(call.method).toBe('POST');
  });

  it('events.archive sends POST', async () => {
    const fm = mockFetch(200, { id: 'evt_1', status: 'archived' });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await c.events.archive('evt_1');
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/events/evt_1/archive');
    expect(call.method).toBe('POST');
  });

  it('events exposes resale policy and listing reads', async () => {
    const fm = mockFetch(200, { enabled: true, maxMultiplier: 1.1 });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await c.events.updateResalePolicy('evt_1', { enabled: true, maxMultiplier: 1.1 });
    expect(getCall(fm).url).toBe('https://api.test/v1/events/evt_1/resale-policy');
    expect(getCall(fm).method).toBe('PUT');
    expect(JSON.parse(getCall(fm).body)).toEqual({ enabled: true, maxMultiplier: 1.1 });

    fm.mockClear();
    await c.events.listResaleListings('evt_1', { limit: 25, cursor: 'lst_1' });
    expect(getCall(fm).url).toBe(
      'https://api.test/v1/events/evt_1/resale-listings?cursor=lst_1&limit=25',
    );
    expect(getCall(fm).method).toBe('GET');
  });

  it('tickets creates, delists, and completes resale listings with idempotency keys', async () => {
    const fm = mockFetch(201, { id: 'lst_1', status: 'listed' });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await c.tickets.createResaleListing('tkt_1', {
      priceCents: 5500,
      idempotencyKey: 'resale_1',
    });
    expect(getCall(fm).url).toBe('https://api.test/v1/tickets/tkt_1/resale-listings');
    expect(getCall(fm).method).toBe('POST');
    expect(getCall(fm).headers['Idempotency-Key']).toBe('resale_1');
    expect(JSON.parse(getCall(fm).body)).toEqual({ priceCents: 5500 });

    fm.mockClear();
    await c.tickets.delistResaleListing('lst_1', { idempotencyKey: 'delist_1' });
    expect(getCall(fm).url).toBe('https://api.test/v1/ticket-listings/lst_1/delist');
    expect(getCall(fm).method).toBe('POST');
    expect(getCall(fm).headers['Idempotency-Key']).toBe('delist_1');

    fm.mockClear();
    await c.tickets.completeResaleListing('lst_1', {
      buyerId: 'usr_buyer',
      buyerEmail: 'buyer@example.com',
      externalPaymentReference: 'stripe_pi_1',
      idempotencyKey: 'complete_1',
    });
    expect(getCall(fm).url).toBe('https://api.test/v1/ticket-listings/lst_1/complete');
    expect(getCall(fm).method).toBe('POST');
    expect(getCall(fm).headers['Idempotency-Key']).toBe('complete_1');
    expect(JSON.parse(getCall(fm).body)).toEqual({
      buyerId: 'usr_buyer',
      buyerEmail: 'buyer@example.com',
      externalPaymentReference: 'stripe_pi_1',
    });
  });

  it('checkout creates buyer-owned resale listings with session token and idempotency', async () => {
    const fm = mockFetch(201, { id: 'lst_1', status: 'listed' });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await c.checkout.createTicketResaleListing('cs_1', 'tkt_1', {
      clientToken: 'client_1',
      priceCents: 5500,
      expiresAt: '2026-06-30T00:00:00.000Z',
      idempotencyKey: 'buyer_resale_1',
    });
    expect(getCall(fm).url).toBe(
      'https://api.test/v1/checkout/sessions/cs_1/tickets/tkt_1/resale-listing',
    );
    expect(getCall(fm).method).toBe('POST');
    expect(getCall(fm).headers['X-Checkout-Session-Token']).toBe('client_1');
    expect(getCall(fm).headers['Idempotency-Key']).toBe('buyer_resale_1');
    expect(JSON.parse(getCall(fm).body)).toEqual({
      priceCents: 5500,
      expiresAt: '2026-06-30T00:00:00.000Z',
    });
  });

  it('organizations.update sends PATCH', async () => {
    const fm = mockFetch(200, { id: 'org_1', name: 'Updated' });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await c.organizations.update('org_1', {
      name: 'Updated',
      boxOfficeSettings: {
        enabled: true,
        allowedTenderTypes: ['cash', 'comp'],
        requireBuyerEmail: true,
        receiptMode: 'both',
      },
    });
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/organizations/org_1');
    expect(call.method).toBe('PATCH');
    expect(JSON.parse(call.body)).toEqual({
      name: 'Updated',
      boxOfficeSettings: {
        enabled: true,
        allowedTenderTypes: ['cash', 'comp'],
        requireBuyerEmail: true,
        receiptMode: 'both',
      },
    });
  });

  it('attendees.listAll sends GET to /attendees with query params', async () => {
    const fm = mockFetch(200, { items: [], nextCursor: null, hasMore: false });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await c.attendees.listAll({ eventId: 'evt_1', status: 'checked_in', limit: 50 });
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/attendees?limit=50&eventId=evt_1&status=checked_in');
    expect(call.method).toBe('GET');
  });

  it('checkIns.syncBacklog uses the synchronous route when the whole backlog fits', async () => {
    const fm = mockFetch(200, {
      accepted: 1,
      duplicates: 0,
      invalid: 0,
      results: [{ qrHash: 'hash_1', outcome: 'accepted' }],
    });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });

    const result = await c.checkIns.syncBacklog({
      idempotencyKey: 'idem_sync_backlog',
      headers: { 'X-Scanner-Device-Secret': 'secret' },
      checkInListId: 'cil_1',
      scans: [{ qrHash: 'hash_1', scannedAt: '2026-06-01T12:00:00.000Z', offline: true }],
    });

    const call = getCall(fm);
    expect(result.mode).toBe('sync');
    expect(fm).toHaveBeenCalledTimes(1);
    expect(call.url).toBe('https://api.test/v1/check-ins/sync');
    expect(call.method).toBe('POST');
    expect(call.headers['Idempotency-Key']).toBe('idem_sync_backlog');
    expect(JSON.parse(call.body)).toEqual({
      checkInListId: 'cil_1',
      scans: [{ qrHash: 'hash_1', scannedAt: '2026-06-01T12:00:00.000Z', offline: true }],
    });
  });

  it('checkIns.syncBacklog creates one async job, uploads chunks, and polls with backoff', async () => {
    const job = {
      id: 'bcs_1',
      tenantId: 'tnt_1',
      eventId: 'evt_1',
      checkInListId: 'cil_1',
      deviceId: 'sd_1',
      totalChunks: 2,
      totalScans: 3,
      chunksReceived: 0,
      chunksProcessed: 0,
      status: 'receiving',
      attemptCount: 0,
      accepted: 0,
      duplicates: 0,
      invalid: 0,
      processingMetrics: {
        processingDurationMs: 0,
        transactionDurationMs: 0,
        lockWaitMs: 0,
        scanLogInsertDurationMs: 0,
        ticketUpdateDurationMs: 0,
        attendeeUpdateDurationMs: 0,
        rowsProcessed: 0,
        clockWarnings: 0,
      },
      sampleErrors: [],
      createdAt: '2026-06-01T12:00:00.000Z',
      updatedAt: '2026-06-01T12:00:00.000Z',
      completedAt: null,
    };
    const completedJob = {
      ...job,
      status: 'completed',
      chunksReceived: 2,
      chunksProcessed: 2,
      accepted: 3,
      processingMetrics: { ...job.processingMetrics, rowsProcessed: 3 },
      completedAt: '2026-06-01T12:01:00.000Z',
    };
    const fm = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify(job), {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'bch_1', jobId: 'bcs_1', sequence: 1 }), {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'bch_2', jobId: 'bcs_1', sequence: 2 }), {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ...job, status: 'processing', chunksReceived: 2 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(completedJob), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });

    const result = await c.checkIns.syncBacklog({
      idempotencyKey: 'idem_bulk_backlog',
      headers: { 'X-Scanner-Device-Secret': 'secret' },
      checkInListId: 'cil_1',
      scans: [
        { qrHash: 'hash_1', scannedAt: '2026-06-01T12:00:00.000Z', offline: true },
        { qrHash: 'hash_2', scannedAt: '2026-06-01T12:00:01.000Z', offline: true },
        { qrHash: 'hash_3', scannedAt: '2026-06-01T12:00:02.000Z', offline: true },
      ],
      forceAsync: true,
      chunkSize: 2,
      pollInitialDelayMs: 0,
      pollMaxDelayMs: 0,
    });

    expect(result).toMatchObject({ mode: 'async', job: { status: 'completed', accepted: 3 } });
    expect(fm).toHaveBeenCalledTimes(5);
    expect(getCall(fm, 0).url).toBe('https://api.test/v1/check-ins/bulk-sync-jobs');
    expect(getCall(fm, 0).method).toBe('POST');
    expect(getCall(fm, 0).headers['Idempotency-Key']).toBe('idem_bulk_backlog:job');
    expect(getCall(fm, 1).url).toBe('https://api.test/v1/check-ins/bulk-sync-jobs/bcs_1/chunks/1');
    expect(getCall(fm, 1).headers['Idempotency-Key']).toBe('idem_bulk_backlog:chunk:1');
    expect(getCall(fm, 2).url).toBe('https://api.test/v1/check-ins/bulk-sync-jobs/bcs_1/chunks/2');
    expect(getCall(fm, 3).url).toBe('https://api.test/v1/check-ins/bulk-sync-jobs/bcs_1');
    expect(getCall(fm, 3).method).toBe('GET');
  });

  it('exports.get sends GET', async () => {
    const fm = mockFetch(200, { exportId: 'exp_1', status: 'completed' });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await c.exports.get('exp_1');
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/exports/exp_1');
    expect(call.method).toBe('GET');
  });

  it('exports.download sends GET', async () => {
    const fm = mockFetch(200, {
      downloadUrl: 'https://s3.example/file.csv',
      expiresAt: '2026-01-01',
    });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await c.exports.download('exp_1');
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/exports/exp_1/download');
  });

  it('reports.conversion returns persisted widget view counts from the API contract', async () => {
    const fm = mockFetch(200, {
      eventId: 'evt_1',
      widgetViews: 18,
      checkoutStarted: 12,
      checkoutCompleted: 6,
      conversionRate: 0.5,
    });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    const report = await c.reports.conversion('evt_1');
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/events/evt_1/reports/conversion');
    expect(report.widgetViews).toBe(18);
  });

  it('reports.sales returns sales-channel gross totals from the API contract', async () => {
    const fm = mockFetch(200, {
      eventId: 'evt_1',
      currency: 'USD',
      grossSalesCents: 12500,
      grossSalesByChannelCents: { online: 9000, boxOffice: 3500 },
      netRevenueCents: 10000,
      refundsCents: 2000,
      feesCents: 500,
      taxCents: 1000,
      ticketsSold: 8,
      checkIns: 4,
      ordersCount: 6,
      paidOrdersCount: 5,
      range: { from: '2026-06-01', to: '2026-06-30' },
    });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });

    const report = await c.reports.sales('evt_1', { from: '2026-06-01', to: '2026-06-30' });
    const call = getCall(fm);

    expect(call.url).toBe(
      'https://api.test/v1/events/evt_1/reports/sales?from=2026-06-01&to=2026-06-30',
    );
    expect(report.grossSalesByChannelCents).toEqual({ online: 9000, boxOffice: 3500 });
  });

  it('products resource sends category and product management requests', async () => {
    const fm = mockFetch(201, {
      id: 'prd_1',
      eventId: 'evt_1',
      name: 'T-shirt',
      priceCents: 2500,
      currency: 'USD',
      maxPerOrder: 3,
      status: 'active',
      sortOrder: 1,
    });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });

    await c.products.createCategory('evt_1', { name: 'Merch', sortOrder: 1 });
    expect(getCall(fm).url).toBe('https://api.test/v1/events/evt_1/product-categories');
    expect(JSON.parse(getCall(fm).body)).toEqual({ name: 'Merch', sortOrder: 1 });

    await c.products.create('evt_1', {
      name: 'T-shirt',
      priceCents: 2500,
      currency: 'USD',
      categoryId: 'pcat_1',
      maxPerOrder: 3,
      status: 'active',
      sortOrder: 1,
    });
    expect(getCall(fm, 1).url).toBe('https://api.test/v1/events/evt_1/products');
    expect(JSON.parse(getCall(fm, 1).body)).toMatchObject({
      name: 'T-shirt',
      categoryId: 'pcat_1',
    });

    await c.products.update('prd_1', { description: null, status: 'inactive' });
    expect(getCall(fm, 2).url).toBe('https://api.test/v1/products/prd_1');
    expect(getCall(fm, 2).method).toBe('PATCH');
    expect(JSON.parse(getCall(fm, 2).body)).toEqual({ description: null, status: 'inactive' });
  });

  it('messages.list sends GET with pagination', async () => {
    const fm = mockFetch(200, { items: [], nextCursor: null, hasMore: false });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await c.messages.list('evt_1', { limit: 10 });
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/events/evt_1/messages?limit=10');
  });

  it('messages.previewRecipients sends POST body', async () => {
    const fm = mockFetch(200, {
      audience: 'checked_in',
      audienceCount: 12,
      eligibleCount: 10,
      suppressedRecipients: 1,
      consentExclusions: 1,
      skippedRecipients: 1,
      recipients: [],
    });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await c.messages.previewRecipients('evt_1', {
      audience: 'checked_in',
      channel: 'email',
    });
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/events/evt_1/messages/preview');
    expect(call.method).toBe('POST');
    expect(JSON.parse(call.body)).toEqual({
      audience: 'checked_in',
      channel: 'email',
    });
  });

  it('messages.send sends split template keys with idempotency', async () => {
    const fm = mockFetch(202, {
      campaignId: 'cmp_1',
      eventId: 'evt_1',
      emailTemplateKey: 'door-reminder-email',
      smsTemplateKey: 'door-reminder-sms',
      channel: 'both',
      status: 'queued',
      audienceCount: 2,
      queuedEmailJobs: 2,
      queuedSmsJobs: 2,
      suppressedRecipients: 0,
      consentExclusions: 0,
      skippedRecipients: 0,
      emailJobIds: ['email_1', 'email_2'],
      smsJobIds: ['sms_1', 'sms_2'],
    });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });

    await c.messages.send('evt_1', {
      emailTemplateKey: 'door-reminder-email',
      smsTemplateKey: 'door-reminder-sms',
      audience: 'all',
      channel: 'both',
      idempotencyKey: 'idem_msg_1',
    });

    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/events/evt_1/messages');
    expect(call.method).toBe('POST');
    expect(call.headers).toMatchObject({ 'Idempotency-Key': 'idem_msg_1' });
    expect(JSON.parse(call.body)).toEqual({
      emailTemplateKey: 'door-reminder-email',
      smsTemplateKey: 'door-reminder-sms',
      audience: 'all',
      channel: 'both',
    });
  });

  it('content resource sends lifecycle requests', async () => {
    const fm = mockFetch(200, {
      id: 'cdoc_1',
      tenantId: 'tnt_1',
      organizationId: 'org_1',
      brandId: 'brd_1',
      channel: 'email',
      key: 'order-confirmed',
      name: 'Order confirmed',
      status: 'draft',
      locale: 'en',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });

    await c.content.create({
      organizationId: 'org_1',
      brandId: 'brd_1',
      channel: 'email',
      key: 'order-confirmed',
      name: 'Order confirmed',
    });

    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/content-documents');
    expect(call.method).toBe('POST');
    expect(JSON.parse(call.body)).toMatchObject({
      organizationId: 'org_1',
      brandId: 'brd_1',
      channel: 'email',
      key: 'order-confirmed',
    });

    await c.content.duplicate('cdoc_1', {
      key: 'order-confirmed-copy',
      name: 'Order confirmed copy',
    });
    const duplicateCall = getCall(fm, 1);
    expect(duplicateCall.url).toBe('https://api.test/v1/content-documents/cdoc_1/duplicate');
    expect(duplicateCall.method).toBe('POST');
    expect(JSON.parse(duplicateCall.body)).toEqual({
      key: 'order-confirmed-copy',
      name: 'Order confirmed copy',
    });
  });

  it('content list sends only backend-supported filters', async () => {
    const fm = mockFetch(200, {
      items: [],
      nextCursor: null,
      hasMore: false,
    });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });

    await c.content.list({
      limit: 25,
      channel: 'email',
      brandId: 'brd_1',
      eventId: 'evt_1',
      cursor: 'unsupported',
    } as Parameters<typeof c.content.list>[0] & { cursor: string });

    const call = getCall(fm);
    expect(call.url).toBe(
      'https://api.test/v1/content-documents?limit=25&channel=email&brandId=brd_1&eventId=evt_1',
    );
    expect(call.method).toBe('GET');
  });

  it('content preview and public content page use documented paths', async () => {
    const fm = mockFetch(200, {
      channel: 'sms',
      output: { text: 'Hi Ada', segments: 1 },
      validation: { valid: true, severity: 'warning', issues: [] },
    });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });

    await c.content.preview('cdoc_1', {
      versionId: 'cver_1',
      contentJson: {
        schemaVersion: 1,
        editor: {
          provider: '@tixkit/content-message/sms-composer',
          body: 'Hi {{recipient.name}}',
        },
        settings: {
          templateKey: 'attendee-message',
          locale: 'en',
          category: 'bulk',
          consentCategory: 'marketing',
          segmentLimit: 3,
          estimatedCostPerSegmentCents: 2,
          optOutText: 'Reply STOP to opt out',
        },
        shortLinks: [],
      },
      context: { buyer: { first_name: 'Ada' } },
    });
    expect(getCall(fm, 0).url).toBe('https://api.test/v1/content-documents/cdoc_1/preview');
    expect(getCall(fm, 0).method).toBe('POST');

    await c.public.getContentPage('evt_1', { locale: 'en' });
    expect(getCall(fm, 1).url).toBe(
      'https://api.test/v1/public/events/evt_1/content-page?locale=en',
    );

    await c.public.getEventPage('evt_1', { locale: 'en' });
    expect(getCall(fm, 2).url).toBe('https://api.test/v1/public/events/evt_1/page?locale=en');

    await c.public.getEventPageBySlug('all-access', {
      host: 'events.example.com',
      locale: 'en',
    });
    expect(getCall(fm, 3).url).toBe(
      'https://api.test/v1/public/events/by-slug/all-access/page?host=events.example.com&locale=en',
    );

    await c.public.getEventDiscoveryCard('evt_1');
    expect(getCall(fm, 4).url).toBe('https://api.test/v1/public/events/evt_1/discovery-card');
  });

  it('content preview sends canonical React Email document JSON without narrowing to generic objects', async () => {
    const fm = mockFetch(200, {
      channel: 'email',
      output: {
        subject: 'Your All Access Chicago tickets are ready',
        html: '<h1>All Access Chicago</h1>',
        text: 'All Access Chicago',
      },
      validation: { valid: true, severity: 'warning', issues: [] },
    });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    const contentJson: EmailTemplateDocument = {
      schemaVersion: 1,
      editor: {
        provider: '@react-email/editor',
        contentHtml:
          '<h1>{{event.title}}</h1><p>Hi {{recipient.name}}, your tickets are ready.</p>',
      },
      settings: {
        templateKey: 'order-confirmed',
        subject: 'Your {{event.title}} tickets are ready',
        previewText: 'Everything you need before arrival.',
        locale: 'en',
        category: 'transactional',
        sender: {
          fromEmail: 'tickets@example.test',
          fromName: '{{brand.name}}',
          replyToEmail: 'support@example.test',
        },
      },
      blocks: [
        {
          type: 'event_hero',
          headline: '{{event.title}}',
          body: 'Hi {{recipient.name}}, your order is confirmed.',
          ctaLabel: 'View tickets',
          ctaUrl: '{{event.checkoutUrl}}',
        },
        {
          type: 'ticket_summary',
          title: 'Ticket summary',
          body: '{{ticket.type}} - {{order.total}}',
        },
        {
          type: 'unsubscribe_footer',
          body: 'You are receiving this because you purchased or manage tickets with {{brand.name}}.',
          unsubscribeUrl: '{{brand.supportUrl}}',
        },
      ],
    };

    await c.content.preview('cdoc_email', {
      versionId: 'cver_email',
      contentJson,
      context: { recipient: { name: 'Ada Lovelace' } },
    });

    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/content-documents/cdoc_email/preview');
    expect(call.method).toBe('POST');
    expect(JSON.parse(call.body)).toEqual({
      versionId: 'cver_email',
      contentJson,
      context: { recipient: { name: 'Ada Lovelace' } },
    });
  });

  it('content preview sends canonical SMS document JSON without narrowing to generic objects', async () => {
    const fm = mockFetch(200, {
      channel: 'sms',
      output: {
        text: 'Hi Ada, All Access starts 2026-07-17 19:00. Reply STOP to opt out',
        segments: 1,
        estimatedCostCents: 4,
      },
      validation: { valid: true, severity: 'warning', issues: [] },
    });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    const contentJson: SmsTemplateDocument = {
      schemaVersion: 1,
      editor: {
        provider: '@tixkit/content-message/sms-composer',
        body: 'Hi {{recipient.name}}, {{event.title}} starts {{event.startsAt}}.',
      },
      settings: {
        templateKey: 'event-reminder-sms',
        locale: 'en',
        category: 'bulk',
        consentCategory: 'marketing',
        segmentLimit: 2,
        estimatedCostPerSegmentCents: 4,
        optOutText: 'Reply STOP to opt out',
      },
      shortLinks: [
        {
          originalUrl: '{{event.checkoutUrl}}',
          reason: 'long_url',
          field: 'editor.body',
        },
      ],
    };

    await c.content.preview('cdoc_sms', {
      versionId: 'cver_sms',
      contentJson,
      context: {
        event: { title: 'All Access', startsAt: '2026-07-17 19:00' },
        recipient: { name: 'Ada' },
      },
      optOutToken: 'Reply STOP to opt out',
    });

    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/content-documents/cdoc_sms/preview');
    expect(call.method).toBe('POST');
    expect(JSON.parse(call.body)).toEqual({
      versionId: 'cver_sms',
      contentJson,
      context: {
        event: { title: 'All Access', startsAt: '2026-07-17 19:00' },
        recipient: { name: 'Ada' },
      },
      optOutToken: 'Reply STOP to opt out',
    });
  });

  it('content testSend returns render artifact metadata from the documented path', async () => {
    const acceptedSendArtifact: ContentRenderArtifact = {
      id: 'cra_send_1',
      tenantId: 'tnt_1',
      documentId: 'cdoc_1',
      versionId: 'cver_1',
      channel: 'sms',
      outputType: 'send',
      artifactRef: 'sms-delivery:smd_1',
      checksum: 'b'.repeat(64),
      createdAt: '2026-06-29T00:00:00.000Z',
    };
    expect(acceptedSendArtifact.outputType).toBe('send');

    const fm = mockFetch(202, {
      testSend: {
        id: 'ctsend_1',
        tenantId: 'tnt_1',
        documentId: 'cdoc_1',
        versionId: 'cver_1',
        channel: 'sms',
        recipient: '+15550000001',
        status: 'captured',
        renderedText: 'Hi Ada',
        createdAt: '2026-06-29T00:00:00.000Z',
      },
      output: { text: 'Hi Ada', segments: 1 },
      renderArtifact: {
        id: 'cra_1',
        tenantId: 'tnt_1',
        documentId: 'cdoc_1',
        versionId: 'cver_1',
        channel: 'sms',
        outputType: 'test_send',
        artifactRef: 'content-test-send:ctsend_1',
        checksum: 'a'.repeat(64),
        createdAt: '2026-06-29T00:00:00.000Z',
      },
    });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });

    const result = await c.content.testSend('cdoc_1', {
      versionId: 'cver_1',
      recipient: '+15550000001',
      context: { recipient: { name: 'Ada' } },
    });

    expect(getCall(fm).url).toBe('https://api.test/v1/content-documents/cdoc_1/test-sends');
    expect(getCall(fm).method).toBe('POST');
    expect(JSON.parse(getCall(fm).body)).toEqual({
      versionId: 'cver_1',
      recipient: '+15550000001',
      context: { recipient: { name: 'Ada' } },
    });
    expect(result.renderArtifact).toMatchObject({
      outputType: 'test_send',
      artifactRef: 'content-test-send:ctsend_1',
      checksum: 'a'.repeat(64),
    });
  });

  it('messages.getCampaign sends GET', async () => {
    const fm = mockFetch(200, {
      id: 'cmp_1',
      eventId: 'evt_1',
      emailTemplateKey: 'door-reminder-email',
      smsTemplateKey: 'door-reminder-sms',
      channel: 'both',
      status: 'sent',
      audience: 'custom',
      audienceKey: 'specific',
      audienceAttendeeIds: ['att_1', 'att_2'],
      audienceLabel: 'Custom (2 attendees)',
      audienceCount: 1,
      queuedEmailJobs: 1,
      queuedSmsJobs: 0,
      suppressedRecipients: 0,
      consentExclusions: 0,
      skippedRecipients: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    const campaign = await c.messages.getCampaign('evt_1', 'cmp_1');
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/events/evt_1/messages/cmp_1');
    expect(campaign).toMatchObject({
      emailTemplateKey: 'door-reminder-email',
      smsTemplateKey: 'door-reminder-sms',
      queuedEmailJobs: 1,
      suppressedRecipients: 0,
      audience: 'custom',
      audienceKey: 'specific',
      audienceAttendeeIds: ['att_1', 'att_2'],
      audienceLabel: 'Custom (2 attendees)',
    });
    expect(campaign).not.toHaveProperty('queued');
  });

  it('ticketTypes access-rule methods send typed requests', async () => {
    const fm = mockFetch(201, {
      id: 'acr_1',
      ticketTypeId: 'tt_1',
      type: 'code',
      value: 'VIP123',
      usesCount: 0,
    });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await c.ticketTypes.createAccessRule('tt_1', { type: 'code', value: 'VIP123', maxUses: 5 });
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/ticket-types/tt_1/access-rules');
    expect(call.method).toBe('POST');
    expect(JSON.parse(call.body)).toEqual({ type: 'code', value: 'VIP123', maxUses: 5 });
  });

  it('ticketTypes batch methods send atomic ticket and access-rule requests', async () => {
    const fm = mockFetch(201, {
      ticketType: { id: 'tt_1', name: 'VIP', kind: 'paid', currency: 'USD', priceCents: 5000 },
      accessRules: [
        { id: 'acr_1', ticketTypeId: 'tt_1', type: 'code', value: 'VIP123', usesCount: 0 },
      ],
    });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await c.ticketTypes.createBatch('evt_1', {
      ticketType: { name: 'VIP', kind: 'paid', currency: 'USD', priceCents: 5000 },
      inventoryPool: { name: 'VIP Pool', totalCapacity: 25 },
      accessRules: [{ type: 'code', value: 'VIP123' }],
    });
    let call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/events/evt_1/ticket-types/batch');
    expect(call.method).toBe('POST');
    expect(JSON.parse(call.body)).toMatchObject({
      inventoryPool: { totalCapacity: 25 },
      accessRules: [{ value: 'VIP123' }],
    });

    await c.ticketTypes.updateBatch('tt_1', {
      ticketType: { name: 'VIP 2' },
      accessRules: [{ type: 'code', value: 'VIP456' }],
    });
    call = getCall(fm, 1);
    expect(call.url).toBe('https://api.test/v1/ticket-types/tt_1/batch');
    expect(call.method).toBe('PATCH');
    expect(JSON.parse(call.body)).toEqual({
      ticketType: { name: 'VIP 2' },
      accessRules: [{ type: 'code', value: 'VIP456' }],
    });
  });

  it('webhookEndpoints.listEvents sends GET', async () => {
    const fm = mockFetch(200, { items: [], nextCursor: null, hasMore: false });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await c.webhookEndpoints.listEvents('ep_1');
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/webhook-endpoints/ep_1/events');
  });

  it('webhookEndpoints.replayEvent sends POST to the endpoint-scoped replay route', async () => {
    const fm = mockFetch(202, { queued: true, eventId: 'whe_1', endpointId: 'ep_1' });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });

    const result = await c.webhookEndpoints.replayEvent('ep_1', 'whe_1');
    const call = getCall(fm);

    expect(result).toEqual({ queued: true, eventId: 'whe_1', endpointId: 'ep_1' });
    expect(call.method).toBe('POST');
    expect(call.url).toBe('https://api.test/v1/webhook-endpoints/ep_1/events/whe_1/replay');
  });

  it('webhookEndpoints.listEvents supports missing-endpoint dead letters', async () => {
    mockFetch(200, {
      items: [
        {
          id: 'whe_1',
          eventId: 'whe_1',
          deliveryId: 'whd_deleted',
          endpointId: null,
          requestedEndpointId: 'wh_deleted',
          deliveryKey: 'live',
          eventType: 'order.paid',
          status: 'dead_lettered',
          attemptCount: 1,
          createdAt: '2026-06-01T00:00:00.000Z',
        },
      ],
      nextCursor: null,
      hasMore: false,
    });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });

    const result = await c.webhookEndpoints.listEvents('wh_deleted');
    const event: WebhookEvent = result.items[0]!;
    const endpointId: string | null = event.endpointId;

    expect(endpointId).toBeNull();
    expect(event.deliveryId).toBe('whd_deleted');
    expect(event.eventId).toBe(event.id);
    expect(event.requestedEndpointId).toBe('wh_deleted');
    expect(event.statusCode).toBeUndefined();
  });

  it('questions.list sends GET', async () => {
    const fm = mockFetch(200, { items: [], nextCursor: null, hasMore: false });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await c.questions.list('evt_1');
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/events/evt_1/questions');
  });

  it('questions.create sends POST with body', async () => {
    const fm = mockFetch(201, {
      id: 'q_1',
      label: 'Name',
      type: 'text',
      required: true,
      appliesTo: 'buyer',
      isConsentField: false,
    });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await c.questions.create('evt_1', {
      label: 'Name',
      type: 'text',
      required: true,
      appliesTo: 'buyer',
      ticketTypeId: 'tt_1',
      placeholder: 'Ada Lovelace',
      conditionalVisibility: { field: 'q_opt_in', operator: 'equals', value: 'yes' },
      isConsentField: false,
    });
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/events/evt_1/questions');
    expect(call.method).toBe('POST');
    expect(JSON.parse(call.body)).toEqual({
      label: 'Name',
      type: 'text',
      required: true,
      appliesTo: 'buyer',
      ticketTypeId: 'tt_1',
      placeholder: 'Ada Lovelace',
      conditionalVisibility: { field: 'q_opt_in', operator: 'equals', value: 'yes' },
      isConsentField: false,
    });
  });

  it('questions.update sends PATCH', async () => {
    const fm = mockFetch(200, { id: 'q_1', label: 'Updated' });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await c.questions.update('q_1', { label: 'Updated' });
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/questions/q_1');
    expect(call.method).toBe('PATCH');
  });

  it('questions.reorder sends POST to the event-scoped reorder endpoint', async () => {
    const fm = mockFetch(200, { items: [], nextCursor: null, hasMore: false });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
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
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await c.questions.delete('q_1');
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/questions/q_1');
    expect(call.method).toBe('DELETE');
  });

  it('oauthApplications.list sends GET', async () => {
    const fm = mockFetch(200, { items: [], nextCursor: null, hasMore: false });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await c.oauthApplications.list();
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/oauth-applications');
  });

  it('oauthApplications.create sends POST with body', async () => {
    const fm = mockFetch(201, { id: 'app_1', name: 'Test', clientId: 'cli_1' });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await c.oauthApplications.create({
      organizationId: 'org_1',
      name: 'Test',
      redirectUris: ['https://example.com/cb'],
      scopes: ['read'],
    });
    const call = getCall(fm);
    expect(call.method).toBe('POST');
    expect(JSON.parse(call.body)).toEqual({
      organizationId: 'org_1',
      name: 'Test',
      redirectUris: ['https://example.com/cb'],
      scopes: ['read'],
    });
  });

  it('oauthApplications.delete sends DELETE', async () => {
    const fm = mockFetch(204, null);
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await c.oauthApplications.delete('app_1');
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/oauth-applications/app_1');
    expect(call.method).toBe('DELETE');
  });

  it('oauthApplications.token exchanges authorization codes', async () => {
    const fm = mockFetch(200, {
      access_token: 'tk_oat_test',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'events.read',
      refresh_token: 'tk_ort_test',
    });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await c.oauthApplications.token({
      grantType: 'authorization_code',
      clientId: 'client_1',
      clientSecret: 'secret_1',
      code: 'code_1',
      redirectUri: 'https://example.com/cb',
    });
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/oauth/token');
    expect(JSON.parse(call.body)).toEqual({
      grant_type: 'authorization_code',
      client_id: 'client_1',
      client_secret: 'secret_1',
      code: 'code_1',
      redirect_uri: 'https://example.com/cb',
    });
  });

  it('oauthApplications.revoke sends token revocation body', async () => {
    const fm = mockFetch(200, { revoked: true });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await c.oauthApplications.revoke({
      clientId: 'client_1',
      clientSecret: 'secret_1',
      token: 'tk_oat_test',
    });
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/oauth/revoke');
    expect(JSON.parse(call.body)).toEqual({
      client_id: 'client_1',
      client_secret: 'secret_1',
      token: 'tk_oat_test',
    });
  });

  it('paymentAccounts.refreshStripeConnect sends POST to the account refresh endpoint', async () => {
    const fm = mockFetch(200, {
      id: 'pa_1',
      status: 'active',
      onboardingUrl: 'https://connect.stripe.test/update',
    });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await c.paymentAccounts.refreshStripeConnect('org_1', 'pa_1');
    const call = getCall(fm);
    expect(call.url).toBe(
      'https://api.test/v1/organizations/org_1/payment-accounts/pa_1/stripe-connect/refresh',
    );
    expect(call.method).toBe('POST');
  });

  it('orders.list sends organization and event filters with pagination', async () => {
    const fm = mockFetch(200, { items: [], nextCursor: null, hasMore: false });
    const c = new TixkitClient({
      apiKey: 'tk_test_123',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await c.orders.list({ limit: 50, organizationId: 'org_1', eventId: 'evt_1' });
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/orders?limit=50&organizationId=org_1&eventId=evt_1');
  });

  it('public.getEvent sends GET without auth', async () => {
    const fm = mockFetch(200, { id: 'evt_1', title: 'Event' });
    const c = new TixkitClient({ apiBaseUrl: 'https://api.test', maxRetries: 0 });
    await c.public.getEvent('evt_1');
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/public/events/evt_1');
  });

  it('public.listResaleListings sends public GET with pagination', async () => {
    const fm = mockFetch(200, { items: [{ id: 'lst_1', status: 'listed' }] });
    const c = new TixkitClient({ apiBaseUrl: 'https://api.test', maxRetries: 0 });
    await c.public.listResaleListings('evt_1', { cursor: 'lst_0', limit: 25 });
    const call = getCall(fm);
    expect(call.url).toBe(
      'https://api.test/v1/public/events/evt_1/resale-listings?cursor=lst_0&limit=25',
    );
    expect(call.method).toBe('GET');
  });

  it('public.validateAccessCode sends POST with ticketTypeIds and accessCode', async () => {
    const fm = mockFetch(200, { valid: true, ticketTypeIds: ['tt_1'] });
    const c = new TixkitClient({ apiBaseUrl: 'https://api.test', maxRetries: 0 });
    await c.public.validateAccessCode('evt_1', { ticketTypeIds: ['tt_1'], accessCode: 'CODE123' });
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/public/events/evt_1/access-code');
    expect(call.method).toBe('POST');
    expect(JSON.parse(call.body)).toEqual({ ticketTypeIds: ['tt_1'], accessCode: 'CODE123' });
  });

  it('uploads.create sends a signed upload ticket request', async () => {
    const fm = mockFetch(201, {
      artifactId: 'upl_1',
      uploadUrl: 'https://s3.test/upload',
      uploadHeaders: { 'Content-Type': 'image/png' },
      completeUrl: '/v1/upload-artifacts/upl_1/complete',
      expiresAt: '2026-01-01T00:15:00.000Z',
    });
    const c = new TixkitClient({
      apiKey: 'tk_test_123',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await c.uploads.create({
      purpose: 'brand_logo',
      fileName: 'logo.png',
      contentType: 'image/png',
      sizeBytes: 1234,
      brandId: 'brd_1',
    });
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/upload-artifacts');
    expect(call.method).toBe('POST');
    expect(JSON.parse(call.body)).toEqual({
      purpose: 'brand_logo',
      fileName: 'logo.png',
      contentType: 'image/png',
      sizeBytes: 1234,
      brandId: 'brd_1',
    });
  });

  it('public upload helpers create and complete checkout upload artifacts', async () => {
    const fm = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            artifactId: 'upl_1',
            uploadUrl: 'https://s3.test/upload',
            uploadHeaders: { 'Content-Type': 'application/pdf' },
            completeUrl: '/v1/public/upload-artifacts/upl_1/complete',
            completeToken: 'complete-token',
            expiresAt: '2026-01-01T00:15:00.000Z',
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            artifactId: 'upl_1',
            status: 'uploaded',
            scanStatus: 'clean',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    const c = new TixkitClient({ apiBaseUrl: 'https://api.test', maxRetries: 0 });

    await c.public.createUploadArtifact('evt_1', {
      fileName: 'waiver.pdf',
      contentType: 'application/pdf',
      sizeBytes: 4321,
      questionId: 'q_file',
    });
    await c.public.completeUploadArtifact('upl_1', 'complete-token');

    expect(getCall(fm, 0).url).toBe('https://api.test/v1/public/events/evt_1/upload-artifacts');
    expect(JSON.parse(getCall(fm, 0).body)).toEqual({
      fileName: 'waiver.pdf',
      contentType: 'application/pdf',
      sizeBytes: 4321,
      questionId: 'q_file',
    });
    expect(getCall(fm, 1).url).toBe('https://api.test/v1/public/upload-artifacts/upl_1/complete');
    expect(JSON.parse(getCall(fm, 1).body)).toEqual({ token: 'complete-token' });
  });

  it('public.recordWidgetImpression sends PII-safe impression metadata', async () => {
    const fm = mockFetch(201, { tracked: true, deduped: false });
    const c = new TixkitClient({ apiBaseUrl: 'https://api.test', maxRetries: 0 });
    await c.public.recordWidgetImpression('evt_1', {
      visitorId: 'visitor_123456',
      trackingId: 'utm-widget',
      host: 'example.com',
    });
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/public/events/evt_1/widget-impressions');
    expect(call.method).toBe('POST');
    expect(JSON.parse(call.body)).toEqual({
      visitorId: 'visitor_123456',
      trackingId: 'utm-widget',
      host: 'example.com',
    });
  });

  it('auth.me sends GET to /me', async () => {
    const fm = mockFetch(200, { userId: 'u_1', email: 'test@example.com' });
    const c = new TixkitClient({
      apiKey: '***********',
      apiBaseUrl: 'https://api.test',
      maxRetries: 0,
    });
    await c.auth.me();
    const call = getCall(fm);
    expect(call.url).toBe('https://api.test/v1/me');
  });
});
