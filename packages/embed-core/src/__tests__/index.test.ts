import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  EMBED_CONTRACT_VERSION,
  createCheckoutLifecycleMessage,
  createCheckoutReadyMessage,
  createHostHelloMessage,
  embedCheckoutMessageSchema,
  embedLifecycleSchema,
  generateCspProfile,
  generateEmbed,
  generateEmbedSnippet,
  parseHostHelloMessage,
  validateCheckoutMessageEvent,
  validateEmbedOptions,
} from '../index.js';

const base = {
  brandId: 'brd_demo',
  eventId: 'evt_demo',
  mode: 'inline' as const,
  platform: 'html' as const,
  checkoutBaseUrl: 'https://checkout.example.test',
  widgetScriptUrl: 'https://cdn.example.test/widget/1.0.0/tixkit-widget.js',
  hostOrigin: 'https://merchant.example.test',
};

describe('Embed Contract v1', () => {
  it('generates one versioned lifecycle surface including loading', () => {
    const snippet = generateEmbedSnippet({ ...base, includeLifecycle: true });
    expect(snippet).toContain(`Embed Contract ${EMBED_CONTRACT_VERSION}`);
    expect(snippet).toContain('tixkit:v1:loading');
    expect(snippet).toContain('tixkit:v1:checkout-session-created');
    expect(snippet).toContain('host-origin="https://merchant.example.test"');
  });

  it('generates button attributes consumed by the public contract', () => {
    const snippet = generateEmbedSnippet({
      ...base,
      mode: 'button',
      theme: 'dark',
      locale: 'fr-FR',
    });
    expect(snippet).toContain('<tixkit-button');
    expect(snippet).toContain('theme="dark"');
    expect(snippet).toContain('locale="fr-FR"');
  });

  it('rejects unsafe theme values and inexact origins', () => {
    const errors = validateEmbedOptions({
      ...base,
      hostOrigin: 'https://merchant.example.test/path',
      themeTokens: { colorPrimary: 'red', fontFamily: 'x; background:url(evil)' },
    });
    expect(errors.map((issue) => issue.path)).toEqual(
      expect.arrayContaining(['hostOrigin', 'themeTokens.colorPrimary', 'themeTokens.fontFamily']),
    );
  });

  it('emits a strict minimal CSP without wildcard https or unsafe-inline', () => {
    const csp = generateCspProfile(base);
    expect(csp.header).not.toContain("'unsafe-inline'");
    expect(csp.directives['connect-src']).not.toContain('https:');
    expect(csp.header).not.toContain('google');
    expect(csp.header).not.toContain('facebook');
  });

  it('uses marketing origins only when selected', () => {
    const csp = generateCspProfile({ ...base, marketing: true });
    expect(csp.header).toContain('www.googletagmanager.com');
    expect(csp.header).toContain('connect.facebook.net');
  });

  it('round-trips host hello and rejects unknown versions', () => {
    const hello = createHostHelloMessage({
      widgetId: 'tkw_1',
      eventId: 'evt_demo',
      nonce: '0123456789012345678901',
      hostOrigin: 'https://merchant.example.test',
    });
    expect(parseHostHelloMessage(hello)).toEqual(hello);
    expect(parseHostHelloMessage({ ...hello, contractVersion: '2.0' })).toBeNull();
    expect(parseHostHelloMessage({ ...hello, buyerEmail: 'buyer@example.test' })).toBeNull();
  });

  it('requires exact origin, source, widget, event, and nonce', () => {
    const frame = {} as Window;
    const message = createCheckoutReadyMessage({
      widgetId: 'tkw_1',
      eventId: 'evt_demo',
      nonce: '0123456789012345678901',
    });
    const expected = {
      origin: 'https://checkout.example.test',
      source: frame,
      widgetId: 'tkw_1',
      eventId: 'evt_demo',
      nonce: '0123456789012345678901',
    };
    expect(
      validateCheckoutMessageEvent(
        { data: message, origin: expected.origin, source: frame },
        expected,
      ).ok,
    ).toBe(true);
    expect(
      validateCheckoutMessageEvent(
        { data: message, origin: expected.origin, source: {} as Window },
        expected,
      ).ok,
    ).toBe(false);
    expect(
      validateCheckoutMessageEvent(
        { data: { ...message, widgetId: 'tkw_2' }, origin: expected.origin, source: frame },
        expected,
      ).ok,
    ).toBe(false);
    expect(
      validateCheckoutMessageEvent(
        { data: { ...message, nonce: 'stale' }, origin: expected.origin, source: frame },
        expected,
      ).ok,
    ).toBe(false);
    expect(
      validateCheckoutMessageEvent(
        { data: { ...message, contractVersion: '9.0' }, origin: expected.origin, source: frame },
        expected,
      ),
    ).toMatchObject({ ok: false, code: 'unsupported-contract-version' });
    expect(
      validateCheckoutMessageEvent(
        {
          data: { ...message, buyerEmail: 'buyer@example.test' },
          origin: expected.origin,
          source: frame,
        },
        expected,
      ),
    ).toMatchObject({ ok: false, code: 'invalid-message' });
  });

  it('requires lifecycle-specific opaque identifiers', () => {
    const frame = {} as Window;
    const expected = {
      origin: 'https://checkout.example.test',
      source: frame,
      widgetId: 'tkw_1',
      eventId: 'evt_demo',
      nonce: '0123456789012345678901',
    };
    const completed = createCheckoutLifecycleMessage({
      widgetId: expected.widgetId,
      eventId: expected.eventId,
      nonce: expected.nonce,
      lifecycle: 'order-completed',
      orderId: 'ord_1',
    });
    expect(
      validateCheckoutMessageEvent(
        { data: completed, origin: expected.origin, source: frame },
        expected,
      ).ok,
    ).toBe(true);
    expect(
      validateCheckoutMessageEvent(
        { data: { ...completed, orderId: undefined }, origin: expected.origin, source: frame },
        expected,
      ).ok,
    ).toBe(false);
  });

  it('returns structured generator failures', () => {
    const result = generateEmbed({ ...base, eventId: '<bad>' });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errors[0]).toMatchObject({ path: 'eventId', code: 'invalid-config' });
  });

  it('keeps exported schemas synchronized with downloadable JSON schemas', () => {
    const checkoutSchema = JSON.parse(
      readFileSync(new URL('../../schemas/checkout-message.schema.json', import.meta.url), 'utf8'),
    );
    const lifecycleSchema = JSON.parse(
      readFileSync(new URL('../../schemas/lifecycle.schema.json', import.meta.url), 'utf8'),
    );
    expect(embedCheckoutMessageSchema).toEqual(checkoutSchema);
    expect(embedLifecycleSchema).toEqual(lifecycleSchema);
  });
});
