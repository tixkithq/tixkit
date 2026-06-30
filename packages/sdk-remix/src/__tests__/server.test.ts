import { describe, expect, it, vi } from 'vitest';
import { TixkitClient } from '@tixkit/js';
import {
  completeResaleListing,
  createCheckoutTicketResaleListing,
  createTicketResaleListing,
  createTixkitClient,
  delistResaleListing,
  listResaleListings,
  loadPublicEventDiscoveryCard,
  loadPublicEventPage,
  loadPublicEventPageBySlug,
  verifyTixkitWebhook,
} from '../server.js';

describe('Remix server helpers', () => {
  it('creates a server-side Tixkit client', () => {
    expect(createTixkitClient({ apiKey: 'tk_test_placeholder' })).toBeInstanceOf(TixkitClient);
  });

  it('loads public content-studio event pages through the JS SDK public client', async () => {
    const client = {
      public: {
        getEventPage: vi.fn(async () => ({ page: { discovery: { title: 'All Access' } } })),
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
      externalPaymentReference: 'pi_1',
      idempotencyKey: 'idem_complete',
    });
    expect(client.checkout.createTicketResaleListing).toHaveBeenCalledWith('cs_1', 'tkt_1', {
      priceCents: 5500,
      clientToken: 'client_token',
      idempotencyKey: 'idem_checkout',
    });
  });

  it('returns false for an invalid webhook signature', () => {
    expect(
      verifyTixkitWebhook({
        body: JSON.stringify({ id: 'wevt_1' }),
        secret: 'whsec_test',
        signature: 't=1,v1=bad',
      }),
    ).toBe(false);
  });

  it('returns false for a malformed signature', () => {
    expect(
      verifyTixkitWebhook({
        body: JSON.stringify({ id: 'wevt_1' }),
        secret: 'whsec_test',
        signature: 'not-a-signature',
      }),
    ).toBe(false);
  });

  it('returns false for an empty signature', () => {
    expect(
      verifyTixkitWebhook({
        body: JSON.stringify({ id: 'wevt_1' }),
        secret: 'whsec_test',
        signature: '',
      }),
    ).toBe(false);
  });
});
