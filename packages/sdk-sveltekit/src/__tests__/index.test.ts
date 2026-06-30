import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  completeResaleListing,
  createCheckoutFormAction,
  createCheckoutTicketResaleListing,
  createTicketResaleListing,
  delistResaleListing,
  listResaleListings,
  loadPublicEventDiscoveryCard,
  loadPublicEventPage,
  loadPublicEventPageBySlug,
  verifyTixkitWebhook,
} from '../server.js';
import type { TixkitClient } from '@tixkit/js';
import {
  checkoutWidgetUrl,
  checkoutUrl,
  tixkitWidgetIframeAttributes,
  parseTixkitWidgetMessage,
} from '../client.js';

function signature(body: string, secret: string, timestamp: number): string {
  const digest = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

describe('SvelteKit server helpers', () => {
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

  it('rejects signatures outside tolerance', () => {
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

  it('creates checkout sessions from validated form actions', async () => {
    const checkoutCreate = vi.fn(async (input: unknown) => ({ id: 'cs_1', status: 'open', input }));
    const action = createCheckoutFormAction({ checkout: { create: checkoutCreate } } as never, {
      successUrl: 'https://app.example.test/success',
      cancelUrl: 'https://app.example.test/cancel',
    });
    const formData = new FormData();
    formData.set('eventId', 'evt_1');
    formData.set('idempotencyKey', 'idem_1');
    formData.append('ticketTypeId', 'tt_1');
    formData.append('quantity', '2');
    formData.append('productId', 'prod_1');
    formData.append('productQuantity', '1');
    formData.set('buyerEmail', 'buyer@example.test');
    formData.set('discountCode', 'SAVE20');
    formData.set('trackingId', 'campaign_1');

    await expect(action({ request: { formData: async () => formData } })).resolves.toEqual({
      success: true,
      session: {
        id: 'cs_1',
        status: 'open',
        input: expect.objectContaining({
          eventId: 'evt_1',
          idempotencyKey: 'idem_1',
          items: [
            { ticketTypeId: 'tt_1', quantity: 2 },
            { productId: 'prod_1', quantity: 1 },
          ],
          buyer: expect.objectContaining({ email: 'buyer@example.test' }),
          discountCode: 'SAVE20',
          trackingId: 'campaign_1',
          successUrl: 'https://app.example.test/success',
          cancelUrl: 'https://app.example.test/cancel',
        }),
      },
    });
    expect(checkoutCreate).toHaveBeenCalledTimes(1);
  });

  it('returns typed form validation errors before creating checkout sessions', async () => {
    const checkoutCreate = vi.fn();
    const action = createCheckoutFormAction({ checkout: { create: checkoutCreate } } as never);
    const formData = new FormData();
    formData.set('eventId', '');
    formData.set('idempotencyKey', '');
    formData.append('ticketTypeId', 'tt_1');
    formData.append('quantity', '0');

    await expect(action({ request: { formData: async () => formData } })).resolves.toEqual({
      success: false,
      status: 400,
      error: 'Checkout form is invalid.',
      fieldErrors: {
        eventId: 'Event is required.',
        idempotencyKey: 'Idempotency key is required.',
        quantity: 'Ticket quantity must be a positive integer.',
      },
    });
    expect(checkoutCreate).not.toHaveBeenCalled();
  });
});

describe('SvelteKit client helpers', () => {
  it('builds checkout widget URL with brand and event params', () => {
    const url = checkoutWidgetUrl({ brand: 'brd_1', event: 'evt_1' });
    expect(url).toContain('/checkout?eventId=evt_1');
    expect(url).toContain('brand=brd_1');
  });

  it('includes optional locale and theme params', () => {
    const url = checkoutWidgetUrl({
      brand: 'brd_1',
      event: 'evt_1',
      locale: 'fr',
      theme: 'dark',
    });
    expect(url).toContain('locale=fr');
    expect(url).toContain('theme=dark');
  });

  it('uses custom widget base URL', () => {
    const url = checkoutWidgetUrl({
      widgetBaseUrl: 'https://custom.widget.com',
      brand: 'brd_1',
      event: 'evt_1',
    });
    expect(url).toContain('https://custom.widget.com/checkout?eventId=evt_1');
  });

  it('includes products, discount, tracking, and mode params', () => {
    const url = checkoutWidgetUrl({
      brand: 'brd_1',
      event: 'evt_1',
      products: ['tt_1', 'tt_2'],
      discountCode: 'PROMO10',
      trackingId: 'campaign_123',
      mode: 'modal',
    });
    expect(url).toContain('products=tt_1%2Ctt_2');
    expect(url).toContain('discount=PROMO10');
    expect(url).toContain('tracking=campaign_123');
    expect(url).toContain('mode=modal');
  });

  it('builds checkoutUrl with items and all params', () => {
    const url = checkoutUrl({
      event: 'evt_1',
      brand: 'brd_1',
      items: [{ ticketTypeId: 'tt_1', quantity: 2 }],
      discountCode: 'SAVE20',
      trackingId: 'camp_1',
      mode: 'redirect',
    });
    expect(url).toContain('/checkout?eventId=evt_1');
    expect(url).toContain('items=tt_1%3D2');
    expect(url).toContain('discount=SAVE20');
    expect(url).toContain('tracking=camp_1');
    expect(url).toContain('mode=redirect');
  });

  it('builds Svelte widget iframe attributes with the shared sandbox policy', () => {
    const attributes = tixkitWidgetIframeAttributes({
      widgetBaseUrl: 'https://checkout.example.test',
      brand: 'brd_1',
      event: 'evt_1',
      title: 'Event checkout',
      mode: 'inline',
    });

    expect(attributes).toEqual({
      src: 'https://checkout.example.test/checkout?eventId=evt_1&brand=brd_1&mode=inline',
      title: 'Event checkout',
      sandbox:
        'allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-scripts allow-same-origin',
      allow: 'payment *',
      referrerPolicy: 'strict-origin-when-cross-origin',
    });
  });

  it('filters Svelte widget postMessages by origin and lifecycle event type', () => {
    expect(
      parseTixkitWidgetMessage(
        {
          origin: 'https://checkout.example.test',
          data: {
            type: 'order_completed',
            eventId: 'evt_1',
            orderId: 'ord_1',
          },
        },
        'https://checkout.example.test',
      ),
    ).toEqual({
      type: 'order_completed',
      eventId: 'evt_1',
      orderId: 'ord_1',
      raw: {
        type: 'order_completed',
        eventId: 'evt_1',
        orderId: 'ord_1',
      },
    });

    expect(
      parseTixkitWidgetMessage(
        { origin: 'https://evil.example.test', data: { type: 'order_completed' } },
        'https://checkout.example.test',
      ),
    ).toBeNull();
    expect(
      parseTixkitWidgetMessage(
        { origin: 'https://checkout.example.test', data: { type: '<script>alert(1)</script>' } },
        'https://checkout.example.test',
      ),
    ).toBeNull();
  });

  it('ships a Svelte 5 widget component subpath backed by client helpers', async () => {
    const componentSource = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../TixkitWidget.svelte', import.meta.url), 'utf-8'),
    );
    const declarationSource = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../TixkitWidget.svelte.d.ts', import.meta.url), 'utf-8'),
    );

    expect(componentSource).toContain('let {');
    expect(componentSource).toContain('$props()');
    expect(componentSource).toContain('tixkitWidgetIframeAttributes');
    expect(componentSource).toContain('parseTixkitWidgetMessage');
    expect(componentSource).toContain('<svelte:window onmessage={handleMessage} />');
    expect(componentSource).toContain('<iframe');
    expect(declarationSource).toContain('export type TixkitWidgetProps');
  });
});

describe('SvelteKit bundle isolation', () => {
  it('client module does not import node:crypto', async () => {
    const clientSource = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../client.ts', import.meta.url), 'utf-8'),
    );
    expect(clientSource).not.toContain('node:crypto');
    expect(clientSource).not.toContain('createHmac');
    expect(clientSource).not.toContain('timingSafeEqual');
  });

  it('root index module does not import node:crypto or server module', async () => {
    const indexSource = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../index.ts', import.meta.url), 'utf-8'),
    );
    expect(indexSource).not.toContain('node:crypto');
    expect(indexSource).not.toContain('createHmac');
    expect(indexSource).not.toContain('timingSafeEqual');
    expect(indexSource).not.toContain('./server');
  });

  it('server module imports node:crypto', async () => {
    const serverSource = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../server.ts', import.meta.url), 'utf-8'),
    );
    expect(serverSource).toContain('node:crypto');
  });
});
