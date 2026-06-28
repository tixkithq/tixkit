import { describe, expect, it } from 'vitest';
import { checkoutUrl, checkoutWidgetUrl } from '../client.js';

describe('Astro client helpers', () => {
  it('builds checkoutUrl with event and brand params', () => {
    const url = checkoutUrl({ event: 'evt_1', brand: 'brd_1' });
    expect(url).toContain('/checkout?eventId=evt_1');
    expect(url).toContain('brand=brd_1');
  });

  it('builds checkoutUrl with items and optional params', () => {
    const url = checkoutUrl({
      event: 'evt_1',
      items: [{ ticketTypeId: 'tt_1', quantity: 2 }],
      discountCode: 'SAVE20',
      trackingId: 'camp_1',
      mode: 'redirect',
    });
    expect(url).toContain('items=tt_1%3D2');
    expect(url).toContain('discount=SAVE20');
    expect(url).toContain('tracking=camp_1');
    expect(url).toContain('mode=redirect');
  });

  it('builds checkoutWidgetUrl with brand and event params', () => {
    const url = checkoutWidgetUrl({ brand: 'brd_1', event: 'evt_1' });
    expect(url).toContain('/checkout?eventId=evt_1');
    expect(url).toContain('brand=brd_1');
  });

  it('builds checkoutWidgetUrl with locale, theme, and products', () => {
    const url = checkoutWidgetUrl({
      brand: 'brd_1',
      event: 'evt_1',
      locale: 'fr',
      theme: 'dark',
      products: ['tt_1', 'tt_2'],
      mode: 'modal',
    });
    expect(url).toContain('locale=fr');
    expect(url).toContain('theme=dark');
    expect(url).toContain('products=tt_1%2Ctt_2');
    expect(url).toContain('mode=modal');
  });

  it('uses custom widget base URL', () => {
    const url = checkoutWidgetUrl({
      widgetBaseUrl: 'https://custom.widget.com',
      brand: 'brd_1',
      event: 'evt_1',
    });
    expect(url).toContain('https://custom.widget.com/checkout?eventId=evt_1');
  });
});
