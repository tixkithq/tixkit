import { describe, expect, it } from 'vitest';
import { checkoutUrl, checkoutWidgetUrl, parseTixkitWidgetMessage } from '../client.js';

describe('Remix client helpers', () => {
  it('builds a checkoutUrl with event, items, and optional params', () => {
    const url = checkoutUrl({
      event: 'evt_1',
      brand: 'brd_1',
      items: [{ ticketTypeId: 'tt_1', quantity: 2 }],
      discountCode: 'SAVE20',
      trackingId: 'camp_1',
      mode: 'redirect',
    });

    expect(url).toContain('/checkout?eventId=evt_1');
    expect(url).toContain('brand=brd_1');
    expect(url).toContain('items=tt_1%3D2');
    expect(url).toContain('discount=SAVE20');
    expect(url).toContain('tracking=camp_1');
    expect(url).toContain('mode=redirect');
  });

  it('falls back to the default checkout base URL', () => {
    const url = checkoutUrl({ event: 'evt_1' });
    expect(url).toContain('https://checkout.tixkit.com/checkout?eventId=evt_1');
  });

  it('honours a custom checkout base URL', () => {
    const url = checkoutUrl({
      checkoutBaseUrl: 'https://custom.checkout.com',
      event: 'evt_1',
    });
    expect(url).toContain('https://custom.checkout.com/checkout?eventId=evt_1');
  });

  it('builds a checkoutWidgetUrl with brand and event params', () => {
    const url = checkoutWidgetUrl({ brand: 'brd_1', event: 'evt_1' });
    expect(url).toContain('/checkout?eventId=evt_1');
    expect(url).toContain('brand=brd_1');
  });

  it('includes optional locale, theme, products, discount, tracking, and mode params', () => {
    const url = checkoutWidgetUrl({
      brand: 'brd_1',
      event: 'evt_1',
      locale: 'fr',
      theme: 'dark',
      products: ['tt_1', 'tt_2'],
      discountCode: 'PROMO10',
      trackingId: 'campaign_123',
      mode: 'modal',
    });

    expect(url).toContain('locale=fr');
    expect(url).toContain('theme=dark');
    expect(url).toContain('products=tt_1%2Ctt_2');
    expect(url).toContain('discount=PROMO10');
    expect(url).toContain('tracking=campaign_123');
    expect(url).toContain('mode=modal');
  });

  it('honours a custom widget base URL', () => {
    const url = checkoutWidgetUrl({
      widgetBaseUrl: 'https://custom.widget.com',
      brand: 'brd_1',
      event: 'evt_1',
    });
    expect(url).toContain('https://custom.widget.com/checkout?eventId=evt_1');
  });

  it('filters widget postMessages by expected event id when present', () => {
    expect(
      parseTixkitWidgetMessage(
        {
          origin: 'https://checkout.example.test',
          data: { type: 'order_completed', eventId: 'evt_2' },
        },
        'https://checkout.example.test',
        'evt_1',
      ),
    ).toBeNull();

    expect(
      parseTixkitWidgetMessage(
        {
          origin: 'https://checkout.example.test',
          data: { type: 'order_completed', eventId: 'evt_1' },
        },
        'https://checkout.example.test',
        'evt_1',
      ),
    ).toMatchObject({ type: 'order_completed', eventId: 'evt_1' });

    expect(
      parseTixkitWidgetMessage(
        { origin: 'https://checkout.example.test', data: { type: 'loaded' } },
        'https://checkout.example.test',
        'evt_1',
      ),
    ).toMatchObject({ type: 'loaded' });
  });
});
