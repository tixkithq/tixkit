import { describe, it, expect } from 'vitest';
import {
  generateEmbed,
  generateEmbedSnippet,
  validateEmbedOptions,
  EMBED_MODES,
  EMBED_PLATFORMS,
  type EmbedGeneratorOptions,
} from '../embed-generator.js';

const validOptions: EmbedGeneratorOptions = {
  eventId: 'evt_demo',
  brandId: 'brd_demo',
  mode: 'inline',
  platform: 'webflow',
};

describe('validateEmbedOptions', () => {
  it('accepts valid options', () => {
    expect(validateEmbedOptions(validOptions)).toEqual([]);
  });

  it('rejects empty event ID', () => {
    const errors = validateEmbedOptions({ ...validOptions, eventId: '' });
    expect(errors).toContainEqual(expect.stringContaining('Invalid event ID'));
  });

  it('rejects event ID with spaces', () => {
    const errors = validateEmbedOptions({ ...validOptions, eventId: 'evt demo' });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects invalid origin', () => {
    const errors = validateEmbedOptions({ ...validOptions, allowedOrigin: 'not-a-url' });
    expect(errors).toContainEqual(expect.stringContaining('Invalid allowed origin'));
  });

  it('rejects invalid mode', () => {
    const errors = validateEmbedOptions({ ...validOptions, mode: 'popup' as never });
    expect(errors).toContainEqual(expect.stringContaining('Invalid mode'));
  });
});

describe('generateEmbedSnippet', () => {
  it('generates an inline widget snippet', () => {
    const snippet = generateEmbedSnippet(validOptions);
    expect(snippet).toContain('<tixkit-widget');
    expect(snippet).toContain('event="evt_demo"');
    expect(snippet).toContain('brand="brd_demo"');
    expect(snippet).toContain('checkout-mode="inline"');
    expect(snippet).toContain('tixkit-widget-1.0.0.js');
    expect(snippet).toContain('integrity="sha384-');
  });

  it('generates a button snippet for button mode', () => {
    const snippet = generateEmbedSnippet({ ...validOptions, mode: 'button' });
    expect(snippet).toContain('<tixkit-button');
    expect(snippet).toContain('Buy tickets');
    expect(snippet).toContain('checkout-mode="modal"');
  });

  it('includes optional attributes when provided', () => {
    const snippet = generateEmbedSnippet({
      ...validOptions,
      theme: 'dark',
      locale: 'fr',
      trackingId: 'spring_campaign',
      discountCode: 'EARLYBIRD',
      products: 'tt_general,tt_vip',
    });
    expect(snippet).toContain('theme="dark"');
    expect(snippet).toContain('locale="fr"');
    expect(snippet).toContain('tracking-id="spring_campaign"');
    expect(snippet).toContain('discount-code="EARLYBIRD"');
    expect(snippet).toContain('products="tt_general,tt_vip"');
  });

  it('includes lifecycle script when requested', () => {
    const snippet = generateEmbedSnippet({
      ...validOptions,
      includeLifecycle: true,
      lifecycleCallbackName: 'handleTixkit',
    });
    expect(snippet).toContain('handleTixkit');
    expect(snippet).toContain('addEventListener');
    expect(snippet).toContain('tixkit:v1:loading');
    expect(snippet).toContain('tixkit:v1:order-completed');
  });

  it('does not include secret keys', () => {
    const snippet = generateEmbedSnippet({
      ...validOptions,
      // Try to sneak in a secret via tracking ID
      trackingId: 'tk_live_secret_12345',
    });
    expect(snippet).not.toContain('API_KEY');
    expect(snippet).not.toContain('api_key');
    expect(snippet).not.toContain('SECRET');
    // tracking-id is a public attribute and is included, but it's not a secret field
    expect(snippet).toContain('tracking-id="tk_live_secret_12345"');
  });

  it('escapes HTML in attribute values', () => {
    expect(() =>
      generateEmbedSnippet({
        ...validOptions,
        eventId: 'evt"><script>alert(1)</script>',
      }),
    ).toThrow();
  });

  it('uses custom checkout URL when provided', () => {
    const snippet = generateEmbedSnippet({
      ...validOptions,
      checkoutBaseUrl: 'https://custom.checkout.com',
    });
    expect(snippet).toContain('api-base-url="https://custom.checkout.com"');
  });
});

describe('generateEmbed', () => {
  it('returns ok result for valid options', () => {
    const result = generateEmbed(validOptions);
    expect(result.ok).toBe(true);
    expect(result.snippet).toContain('<tixkit-widget');
    expect(result.cspGuidance).toContain('Content-Security-Policy');
    expect(result.instructions).toContain('Webflow');
  });

  it('returns error result for invalid options', () => {
    const result = generateEmbed({ ...validOptions, eventId: '' });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('Invalid event ID');
  });

  it('generates Framer instructions', () => {
    const result = generateEmbed({ ...validOptions, platform: 'framer' });
    expect(result.instructions).toContain('Framer');
  });

  it('generates plain HTML instructions', () => {
    const result = generateEmbed({ ...validOptions, platform: 'plain' });
    expect(result.instructions).toContain('Plain HTML');
  });
});

describe('constants', () => {
  it('exports all embed modes', () => {
    expect(EMBED_MODES).toEqual(['inline', 'modal', 'button', 'redirect']);
  });

  it('exports all platforms', () => {
    expect(EMBED_PLATFORMS).toEqual(['webflow', 'framer', 'plain']);
  });
});
