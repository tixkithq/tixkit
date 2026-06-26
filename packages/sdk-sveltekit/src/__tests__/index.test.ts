import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyGateKitWebhook } from '../server.js';
import { checkoutWidgetUrl, checkoutUrl } from '../client.js';

function signature(body: string, secret: string, timestamp: number): string {
  const digest = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

describe('SvelteKit server helpers', () => {
  it('verifies timestamped GateKit webhook signatures', () => {
    const body = JSON.stringify({ id: 'wevt_1' });
    const secret = 'whsec_test';
    const timestamp = Math.floor(Date.now() / 1000);

    expect(
      verifyGateKitWebhook({
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
      verifyGateKitWebhook({
        body,
        secret,
        signature: signature(body, secret, timestamp),
        toleranceSeconds: 300,
      }),
    ).toBe(false);
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
