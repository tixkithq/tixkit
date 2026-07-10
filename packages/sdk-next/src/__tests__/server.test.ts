import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TixkitClient } from '@tixkit/js';
import {
  completeResaleListing,
  createCheckoutSessionRouteHandler,
  createCheckoutTicketResaleListing,
  createTixkitClient,
  createTixkitWebhookRouteHandler,
  createWebhookHandler,
  createTicketResaleListing,
  delistResaleListing,
  listResaleListings,
  loadPublicEventDiscoveryCard,
  loadPublicEventPage,
  loadPublicEventPageBySlug,
  verifyTixkitWebhook,
} from '../server.js';

function signature(body: string, secret: string, timestamp: number): string {
  const digest = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

describe('Next server webhook helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates a server-side Tixkit client', () => {
    expect(createTixkitClient({ apiKey: 'tk_test_123' })).toBeInstanceOf(TixkitClient);
  });

  it('loads public content-studio event pages through the JS SDK public client', async () => {
    const client = {
      public: {
        getEventPage: vi.fn(async () => ({
          page: {
            document: {
              schemaVersion: 2,
              editor: {
                provider: '@puckeditor/core',
                data: { content: [], root: { props: {} } },
              },
            },
            discovery: { title: 'All Access' },
          },
        })),
        getEventPageBySlug: vi.fn(async () => ({ document: { eventId: 'evt_1' } })),
        getEventDiscoveryCard: vi.fn(async () => ({ title: 'All Access' })),
      },
    } as unknown as TixkitClient;

    await expect(loadPublicEventPage(client, 'evt_1', { locale: 'en' })).resolves.toMatchObject({
      page: {
        document: { schemaVersion: 2 },
        discovery: { title: 'All Access' },
      },
    });
    await expect(
      loadPublicEventPageBySlug(client, 'all-access', {
        host: 'events.example.com',
        locale: 'en',
      }),
    ).resolves.toMatchObject({ document: { eventId: 'evt_1' } });
    await expect(loadPublicEventDiscoveryCard(client, 'evt_1')).resolves.toEqual({
      title: 'All Access',
    });

    expect(client.public.getEventPage).toHaveBeenCalledWith('evt_1', { locale: 'en' });
    expect(client.public.getEventPageBySlug).toHaveBeenCalledWith('all-access', {
      host: 'events.example.com',
      locale: 'en',
    });
    expect(client.public.getEventDiscoveryCard).toHaveBeenCalledWith('evt_1', undefined);
  });

  it('delegates resale helpers through the JS SDK resources', async () => {
    const client = {
      events: {
        listResaleListings: vi.fn(async () => ({ items: [{ id: 'lst_1' }], hasMore: false })),
      },
      tickets: {
        createResaleListing: vi.fn(async () => ({ id: 'lst_2', status: 'listed' })),
        delistResaleListing: vi.fn(async () => ({ id: 'lst_2', status: 'delisted' })),
        completeResaleListing: vi.fn(async () => ({
          listing: { id: 'lst_2', status: 'sold' },
        })),
      },
      checkout: {
        createTicketResaleListing: vi.fn(async () => ({ id: 'lst_3', status: 'listed' })),
      },
    } as unknown as TixkitClient;

    await listResaleListings(client, 'evt_1', { cursor: 'lst_0', limit: 25 });
    await createTicketResaleListing(client, 'tkt_1', {
      priceCents: 5500,
      idempotencyKey: 'idem_create',
    });
    await delistResaleListing(client, 'lst_2', { idempotencyKey: 'idem_delist' });
    await completeResaleListing(client, 'lst_2', {
      buyerId: 'usr_1',
      buyerEmail: 'buyer@example.test',
      buyerDateOfBirth: '1990-01-01',
      externalPaymentReference: 'pi_1',
      idempotencyKey: 'idem_complete',
    });
    await createCheckoutTicketResaleListing(client, 'cs_1', 'tkt_1', {
      priceCents: 5500,
      clientToken: 'client_token',
      idempotencyKey: 'idem_checkout',
    });

    expect(client.events.listResaleListings).toHaveBeenCalledWith('evt_1', {
      cursor: 'lst_0',
      limit: 25,
    });
    expect(client.tickets.createResaleListing).toHaveBeenCalledWith('tkt_1', {
      priceCents: 5500,
      idempotencyKey: 'idem_create',
    });
    expect(client.tickets.delistResaleListing).toHaveBeenCalledWith('lst_2', {
      idempotencyKey: 'idem_delist',
    });
    expect(client.tickets.completeResaleListing).toHaveBeenCalledWith('lst_2', {
      buyerId: 'usr_1',
      buyerEmail: 'buyer@example.test',
      buyerDateOfBirth: '1990-01-01',
      externalPaymentReference: 'pi_1',
      idempotencyKey: 'idem_complete',
    });
    expect(client.checkout.createTicketResaleListing).toHaveBeenCalledWith('cs_1', 'tkt_1', {
      priceCents: 5500,
      clientToken: 'client_token',
      idempotencyKey: 'idem_checkout',
    });
  });

  it('verifies timestamped Tixkit webhook signatures', () => {
    const body = JSON.stringify({ id: 'wevt_1' });
    const secret = 'whsec_test';
    const timestamp = Math.floor(Date.now() / 1000);

    expect(
      verifyTixkitWebhook({
        body,
        secret,
        signature: signature(body, secret, timestamp),
      }),
    ).toBe(true);
  });

  it('rejects legacy raw body signatures', () => {
    const body = JSON.stringify({ id: 'wevt_1' });
    const secret = 'whsec_test';
    const legacy = createHmac('sha256', secret).update(body).digest('hex');

    expect(verifyTixkitWebhook({ body, secret, signature: legacy })).toBe(false);
  });

  it('handles legacy webhook helper requests', async () => {
    const body = JSON.stringify({ id: 'wevt_1', type: 'order.created' });
    const secret = 'whsec_test';
    const timestamp = Math.floor(Date.now() / 1000);
    const handler = createWebhookHandler(secret);

    await expect(
      handler({
        body,
        headers: { 'x-tixkit-signature': signature(body, secret, timestamp) },
      }),
    ).resolves.toEqual({
      status: 200,
      body: { received: true, event: { id: 'wevt_1', type: 'order.created' } },
    });
  });

  it('rejects legacy webhook helper requests with signed malformed JSON', async () => {
    const body = '{"id":';
    const secret = 'whsec_test';
    const timestamp = Math.floor(Date.now() / 1000);
    const handler = createWebhookHandler(secret);

    await expect(
      handler({
        body,
        headers: { 'x-tixkit-signature': signature(body, secret, timestamp) },
      }),
    ).resolves.toEqual({
      status: 400,
      body: { error: 'Invalid JSON body' },
    });
  });

  it('creates App Router-compatible webhook route handlers', async () => {
    const body = JSON.stringify({ id: 'wevt_1', type: 'order.created' });
    const secret = 'whsec_test';
    const timestamp = Math.floor(Date.now() / 1000);
    const onEvent = vi.fn(async () => ({ ok: true }));
    const POST = createTixkitWebhookRouteHandler({ secret, onEvent });

    const response = await POST(
      new Request('https://example.com/api/tixkit/webhooks', {
        method: 'POST',
        body,
        headers: { 'x-tixkit-signature': signature(body, secret, timestamp) },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(onEvent).toHaveBeenCalledWith(
      { id: 'wevt_1', type: 'order.created' },
      expect.objectContaining({ body }),
    );
  });

  it('rejects webhook route handlers with invalid signatures', async () => {
    const POST = createTixkitWebhookRouteHandler({ secret: 'whsec_test' });

    const response = await POST(
      new Request('https://example.com/api/tixkit/webhooks', {
        method: 'POST',
        body: JSON.stringify({ id: 'wevt_1' }),
        headers: { 'x-tixkit-signature': 't=1,v1=bad' },
      }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid signature' });
  });

  it('creates checkout sessions from App Router-compatible route handlers', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ id: 'cs_1', status: 'open' }), { status: 201 }),
      );
    const POST = createCheckoutSessionRouteHandler({
      apiKey: 'tk_test_123',
      apiBaseUrl: 'https://api.example.test',
      defaultSuccessUrl: 'https://app.example.test/success',
      defaultCancelUrl: 'https://app.example.test/cancel',
    });

    const response = await POST(
      new Request('https://app.example.test/api/checkout', {
        method: 'POST',
        body: JSON.stringify({
          eventId: 'evt_1',
          items: [{ ticketTypeId: 'tt_1', quantity: 1 }],
          buyer: { email: 'buyer@example.test' },
        }),
        headers: { 'idempotency-key': 'idem_1' },
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ id: 'cs_1', status: 'open' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/v1/checkout/sessions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer tk_test_123',
          'Idempotency-Key': 'idem_1',
        }),
        body: JSON.stringify({
          eventId: 'evt_1',
          items: [{ ticketTypeId: 'tt_1', quantity: 1 }],
          buyer: { email: 'buyer@example.test' },
          successUrl: 'https://app.example.test/success',
          cancelUrl: 'https://app.example.test/cancel',
        }),
      }),
    );
  });

  it('requires checkout route idempotency keys', async () => {
    const POST = createCheckoutSessionRouteHandler({
      apiKey: 'tk_test_123',
      apiBaseUrl: 'https://api.example.test',
    });

    const response = await POST(
      new Request('https://app.example.test/api/checkout', {
        method: 'POST',
        body: JSON.stringify({ eventId: 'evt_1', items: [] }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Missing idempotency key' });
  });
});
