import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  EMBED_CONTRACT_VERSION,
  EMBED_LIFECYCLE_SCRIPT_SOURCE,
  createCheckoutLifecycleMessage,
  createCheckoutReadyMessage,
  createHostHelloMessage,
  embedCheckoutMessageSchema,
  embedLifecycleSchema,
  generateCspProfile,
  generateEmbed,
  generateEmbedSnippet,
  isEmbedLifecycleDetail,
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
    const generated = generateEmbed({ ...base, includeLifecycle: true });
    expect(generated.ok).toBe(true);
    if (!generated.ok) return;
    const snippet = generated.snippet;
    expect(snippet).toContain(`Embed Contract ${EMBED_CONTRACT_VERSION}`);
    expect(snippet).toContain('tixkit:v1:loading');
    expect(snippet).toContain('tixkit:v1:checkout-session-created');
    expect(snippet).toContain('host-origin="https://merchant.example.test"');
    const hash = createHash('sha256').update(EMBED_LIFECYCLE_SCRIPT_SOURCE).digest('base64');
    expect(generated.csp.directives['script-src']).toContain(`'sha256-${hash}'`);
    const inlineSource = snippet.match(/<script type="module">([\s\S]*?)<\/script>$/)?.[1];
    expect(inlineSource).toBe(EMBED_LIFECYCLE_SCRIPT_SOURCE);
  });

  it('generates an SRI-pinned script and a usable no-JavaScript fallback', () => {
    const integrity = `sha384-${'A'.repeat(64)}`;
    const snippet = generateEmbedSnippet({ ...base, widgetIntegrity: integrity });
    expect(snippet).toContain(`integrity="${integrity}" crossorigin="anonymous"`);
    expect(snippet).toContain(
      '<a href="https://checkout.example.test/checkout?eventId=evt_demo&amp;brand=brd_demo">',
    );
    expect(snippet).not.toContain('latest');
  });

  it('preserves safe checkout preselection in the no-JavaScript fallback', () => {
    const snippet = generateEmbedSnippet({
      ...base,
      locale: 'ar-SA',
      theme: 'dark',
      products: 'tt_hidden',
      items: 'tt_hidden=2',
      discountCode: 'SAVE10',
      accessCode: 'LOCKED',
      trackingId: 'campaign',
      affiliateCode: 'partner',
    });
    expect(snippet).toContain('locale=ar-SA');
    expect(snippet).toContain('products=tt_hidden');
    expect(snippet).toContain('accessCode=LOCKED');
    expect(snippet).toContain('affiliateCode=partner');
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

  it.each(['react', 'vue', 'svelte'] as const)(
    'keeps %s configuration and lifecycle output synchronized with HTML',
    (platform) => {
      const snippet = generateEmbedSnippet({
        ...base,
        platform,
        locale: 'ar-SA',
        theme: 'high-contrast',
        products: 'tt_general',
        themeTokens: { fontFamily: 'Inter', buttonSize: 'lg', buttonVariant: 'outline' },
        includeLifecycle: true,
      });
      expect(snippet).toContain(platform === 'react' ? '"locale":"ar-SA"' : 'locale="ar-SA"');
      expect(snippet).toContain(
        platform === 'react' ? '"theme":"high-contrast"' : 'theme="high-contrast"',
      );
      expect(snippet).toContain(
        platform === 'react' ? '"products":"tt_general"' : 'products="tt_general"',
      );
      expect(snippet).toContain('fontFamily');
      expect(snippet).toContain('Inter');
      expect(snippet).toContain('tixkit:v1:loading');
      expect(snippet).toContain('tixkit:v1:fatal-error');
    },
  );

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

  it('rejects unknown theme-token keys and keeps framework CSP feature-minimal', () => {
    const errors = validateEmbedOptions({
      ...base,
      themeTokens: { colorPrimary: '#112233', arbitraryCss: 'display:none' } as never,
    });
    expect(errors.map((issue) => issue.path)).toContain('themeTokens.arbitraryCss');
    const result = generateEmbed({ ...base, platform: 'react' });
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.csp.directives['script-src']).not.toContain('https://cdn.example.test');
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

  it('rejects lifecycle PII, invalid enums, oversized messages, and variant fields', () => {
    const detail = {
      contractVersion: '1.0',
      widgetId: 'widget_1',
      eventId: 'evt_1',
      mode: 'inline',
      timestamp: '2026-07-10T12:00:00.000Z',
      name: 'loading',
    } as const;
    expect(isEmbedLifecycleDetail(detail)).toBe(true);
    expect(isEmbedLifecycleDetail({ ...detail, buyerEmail: 'buyer@example.test' })).toBe(false);
    expect(isEmbedLifecycleDetail({ ...detail, mode: 'button' })).toBe(false);
    expect(isEmbedLifecycleDetail({ ...detail, reason: 'buyer' })).toBe(false);
    expect(
      isEmbedLifecycleDetail({
        ...detail,
        name: 'recoverable-error',
        errorCode: 'internal-error',
        message: 'x'.repeat(241),
        retryable: true,
      }),
    ).toBe(false);
  });
});
