import { describe, expect, it } from 'vitest';
import { checkoutUrl, checkoutWidgetUrl } from '../client.js';

describe('Vue client helpers', () => {
  it('builds checkoutUrl with eventId and brand params', () => {
    const url = checkoutUrl({ event: 'evt_demo', brand: 'brd_demo' });
    expect(url).toContain('eventId=evt_demo');
    expect(url).toContain('brand=brd_demo');
    expect(url).toContain('/checkout?');
  });

  it('builds checkoutWidgetUrl with eventId and brand params', () => {
    const url = checkoutWidgetUrl({ event: 'evt_demo', brand: 'brd_demo' });
    expect(url).toContain('eventId=evt_demo');
    expect(url).toContain('brand=brd_demo');
    expect(url).toContain('/checkout?');
  });

  it('includes items in checkoutUrl', () => {
    const url = checkoutUrl({
      event: 'evt_demo',
      brand: 'brd_demo',
      items: [{ ticketTypeId: 'tt_1', quantity: 2 }],
    });
    expect(url).toContain('items=tt_1%3D2');
  });

  it('includes optional params in checkoutWidgetUrl', () => {
    const url = checkoutWidgetUrl({
      brand: 'brd_demo',
      event: 'evt_demo',
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

  it('uses custom widget base URL', () => {
    const url = checkoutWidgetUrl({
      widgetBaseUrl: 'https://custom.widget.com',
      brand: 'brd_demo',
      event: 'evt_demo',
    });
    expect(url).toContain('https://custom.widget.com/checkout?eventId=evt_demo');
  });
});
