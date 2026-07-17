import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  getResaleSettlement,
  createCheckoutFormAction,
  createCheckoutTicketResaleListing,
  createTicketResaleListing,
  createTixkitClient,
  createTixkitWebhookEndpoint,
  delistResaleListing,
  listResaleListings,
  loadPublicEventDiscoveryCard,
  loadPublicEventPage,
  loadPublicEventPageBySlug,
  verifyTixkitWebhook,
} from '../server.js';
import type { TixkitClient } from '@tixkit/js';

function signature(body: string, secret: string, timestamp: number): string {
  const digest = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

describe('Astro server helpers', () => {
  it('allows unrestricted checkout forms to omit date of birth', async () => {
    const checkoutCreate = vi.fn(async (input: unknown) => input);
    const action = createCheckoutFormAction({ checkout: { create: checkoutCreate } } as never);
    const formData = new FormData();
    formData.set('eventId', 'evt_unrestricted');
    formData.set('idempotencyKey', 'idem_unrestricted');
    formData.set('ticketTypeId', 'tt_1');
    formData.set('quantity', '1');
    formData.set('buyerEmail', 'buyer@example.test');

    await expect(action({ request: { formData: async () => formData } })).resolves.toMatchObject({
      success: true,
    });
    expect(checkoutCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [{ ticketTypeId: 'tt_1', quantity: 1 }],
        buyer: expect.not.objectContaining({ dateOfBirth: expect.anything() }),
      }),
    );
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

  it('returns false for invalid signatures', () => {
    expect(
      verifyTixkitWebhook({
        body: JSON.stringify({ id: 'wevt_1' }),
        secret: 'whsec_test',
        signature: 't=0,v1=invalid',
      }),
    ).toBe(false);
  });

  it('returns false for signatures outside tolerance', () => {
    const body = JSON.stringify({ id: 'wevt_1' });
    const secret = 'whsec_test';
    const timestamp = Math.floor(Date.now() / 1000) - 301;

    expect(
      verifyTixkitWebhook({
        body,
        secret,
        signature: signature(body, secret, timestamp),
        toleranceSeconds: 300,
      }),
    ).toBe(false);
  });

  it('createTixkitClient returns a client instance', () => {
    const client = createTixkitClient({ apiKey: 'tk_test_placeholder' });
    expect(client).toBeDefined();
    expect(typeof client.checkout.create).toBe('function');
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

    await loadPublicEventPage(client, 'evt_1', { locale: 'en' });
    await loadPublicEventPageBySlug(client, 'all-access', {
      host: 'events.example.com',
      locale: 'en',
    });
    await loadPublicEventDiscoveryCard(client, 'evt_1');

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
        getResaleSettlement: vi.fn(async () => ({
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
      termsAcceptance: {
        accepted: true,
        termsVersion: '2026-07-16',
        settlementModel: 'organizer_managed',
        refundModel: 'manual_coordinated_resolution',
      },
      idempotencyKey: 'idem_create',
    });
    await delistResaleListing(client, 'lst_2', { idempotencyKey: 'idem_delist' });
    await getResaleSettlement(client, 'lst_2');
    await createCheckoutTicketResaleListing(client, 'cs_1', 'tkt_1', {
      priceCents: 5500,
      termsAcceptance: {
        accepted: true,
        termsVersion: '2026-07-16',
        settlementModel: 'organizer_managed',
        refundModel: 'manual_coordinated_resolution',
      },
      clientToken: 'client_token',
      idempotencyKey: 'idem_checkout',
    });

    expect(client.events.listResaleListings).toHaveBeenCalledWith('evt_1', {
      cursor: 'lst_0',
      limit: 25,
    });
    expect(client.tickets.createResaleListing).toHaveBeenCalledWith('tkt_1', {
      priceCents: 5500,
      termsAcceptance: {
        accepted: true,
        termsVersion: '2026-07-16',
        settlementModel: 'organizer_managed',
        refundModel: 'manual_coordinated_resolution',
      },
      idempotencyKey: 'idem_create',
    });
    expect(client.tickets.delistResaleListing).toHaveBeenCalledWith('lst_2', {
      idempotencyKey: 'idem_delist',
    });
    expect(client.tickets.getResaleSettlement).toHaveBeenCalledWith('lst_2');
    expect(client.checkout.createTicketResaleListing).toHaveBeenCalledWith('cs_1', 'tkt_1', {
      priceCents: 5500,
      termsAcceptance: {
        accepted: true,
        termsVersion: '2026-07-16',
        settlementModel: 'organizer_managed',
        refundModel: 'manual_coordinated_resolution',
      },
      clientToken: 'client_token',
      idempotencyKey: 'idem_checkout',
    });
  });

  it('createTixkitWebhookEndpoint rejects invalid signatures with 401', async () => {
    const handler = createTixkitWebhookEndpoint({ secret: 'whsec_test' });
    const request = new Request('https://example.test/api/webhook', {
      method: 'POST',
      body: JSON.stringify({ id: 'wevt_1' }),
      headers: { 'x-tixkit-signature': 't=0,v1=invalid' },
    });
    const response = await handler({ request, url: new URL(request.url) });
    expect(response.status).toBe(401);
  });

  it('createTixkitWebhookEndpoint rejects signed malformed JSON with 400', async () => {
    const body = '{"id":';
    const secret = 'whsec_test';
    const timestamp = Math.floor(Date.now() / 1000);
    const handler = createTixkitWebhookEndpoint({ secret });
    const request = new Request('https://example.test/api/webhook', {
      method: 'POST',
      body,
      headers: { 'x-tixkit-signature': signature(body, secret, timestamp) },
    });

    const response = await handler({ request, url: new URL(request.url) });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid JSON body' });
  });

  it('createTixkitWebhookEndpoint accepts valid signatures and calls onEvent', async () => {
    const body = JSON.stringify({ id: 'wevt_1' });
    const secret = 'whsec_test';
    const timestamp = Math.floor(Date.now() / 1000);
    const onEvent = vi.fn().mockResolvedValue({ received: true });
    const handler = createTixkitWebhookEndpoint({ secret, onEvent });
    const request = new Request('https://example.test/api/webhook', {
      method: 'POST',
      body,
      headers: { 'x-tixkit-signature': signature(body, secret, timestamp) },
    });
    const response = await handler({ request, url: new URL(request.url) });
    expect(response.status).toBe(200);
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it('createTixkitWebhookEndpoint rejects legacy signature headers by default', async () => {
    const body = JSON.stringify({ id: 'wevt_legacy' });
    const secret = 'whsec_test';
    const timestamp = Math.floor(Date.now() / 1000);
    const onEvent = vi.fn().mockResolvedValue({ received: true });
    const handler = createTixkitWebhookEndpoint({ secret, onEvent });
    const request = new Request('https://example.test/api/webhook', {
      method: 'POST',
      body,
      headers: { 'tixkit-signature': signature(body, secret, timestamp) },
    });

    const response = await handler({ request, url: new URL(request.url) });

    expect(response.status).toBe(401);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('createTixkitWebhookEndpoint preserves explicit custom signature headers', async () => {
    const body = JSON.stringify({ id: 'wevt_custom' });
    const secret = 'whsec_test';
    const timestamp = Math.floor(Date.now() / 1000);
    const onEvent = vi.fn().mockResolvedValue({ received: true });
    const handler = createTixkitWebhookEndpoint({
      secret,
      onEvent,
      signatureHeader: 'tixkit-signature',
    });
    const request = new Request('https://example.test/api/webhook', {
      method: 'POST',
      body,
      headers: {
        'x-tixkit-signature': signature(body, 'wrong_secret', timestamp),
        'tixkit-signature': signature(body, secret, timestamp),
      },
    });

    const response = await handler({ request, url: new URL(request.url) });

    expect(response.status).toBe(200);
    expect(onEvent).toHaveBeenCalledTimes(1);
  });
});
