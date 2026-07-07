import { describe, expect, it } from 'vitest';
import {
  createDefaultEventPageDocument,
  normalizeEventPageDocument,
  renderEventPageDocument,
  resolveEventPageDocument,
  renderResolvedEventPageHtml,
  renderResolvedEventPageHeadless,
  renderResolvedEventPageText,
  type EventPageRenderContext,
} from '../index.js';

const context: EventPageRenderContext = {
  event: {
    title: 'All Access Chicago',
    description: 'A full night of music and access.',
    startsAt: '2026-07-17T19:00:00.000Z',
    timezone: 'America/Chicago',
    publicUrl: 'https://events.example.test/e/all-access-chicago',
    checkoutUrl: 'https://checkout.example.test/checkout?eventId=evt_demo_001',
    venueName: 'The Salt Shed',
    venueCity: 'Chicago',
  },
  brand: {
    name: 'Tixkit',
    supportUrl: 'https://help.example.test',
    termsUrl: 'https://example.test/terms',
    privacyUrl: 'https://example.test/privacy',
    refundUrl: 'https://example.test/refunds',
  },
  tickets: [
    {
      id: 'tt_ga',
      name: 'General Admission',
      description: 'Standing room',
      status: 'active',
      priceLabel: '$35.00',
    },
    { id: 'tt_hidden', name: 'Hidden comp', status: 'hidden', priceLabel: 'Free' },
  ],
  products: [{ id: 'prod_poster', name: 'Poster', priceLabel: '$10.00' }],
  resaleListings: [
    {
      id: 'resale_1',
      ticketTypeName: 'General Admission',
      priceLabel: '$40.00',
      expiresAt: '2026-07-15T00:00:00.000Z',
    },
  ],
};

function baseDocument(checkoutUrl = 'https://checkout.example.test/checkout?eventId=evt_demo_001') {
  return createDefaultEventPageDocument({
    eventId: 'evt_demo_001',
    eventTitle: 'All Access Chicago',
    eventDescription: 'A full night of access.',
    checkoutUrl,
  });
}

describe('resolveEventPageDocument', () => {
  it('produces a serializable resolved model with resolved blocks, discovery, and validation', () => {
    const document = baseDocument();
    const resolved = resolveEventPageDocument(document, context);

    expect(resolved.schemaVersion).toBe(1);
    expect(resolved.validation.valid).toBe(true);
    expect(resolved.blocks.map((block) => block.type)).toEqual([
      'event_header',
      'hero',
      'event_details',
      'tickets',
      'schedule',
      'venue_map',
      'faq',
      'resale_tickets',
      'brand_footer',
    ]);
    const hero = resolved.blocks.find((block) => block.type === 'hero');
    expect(hero && hero.type === 'hero' && hero.headline).toBe('All Access Chicago');
    const tickets = resolved.blocks.find((block) => block.type === 'tickets');
    expect(tickets && tickets.type === 'tickets' && tickets.tickets.map((t) => t.id)).toEqual([
      'tt_ga',
    ]);
    expect(resolved.discovery.title).toBe('All Access Chicago');
    // Serializable: no React elements, no functions.
    expect(JSON.parse(JSON.stringify(resolved))).toEqual(resolved);
  });

  it('resolves merge tags in hero headline and body', () => {
    const document = baseDocument();
    const hero = document.blocks.find((block) => block.type === 'hero')!;
    if (hero.type === 'hero') {
      hero.headline = '{{event.title}}';
      hero.body = 'Join {{brand.name}} for {{event.title}}';
    }
    const resolved = resolveEventPageDocument(document, context);
    const resolvedHero = resolved.blocks.find((block) => block.type === 'hero');
    expect(resolvedHero && resolvedHero.type === 'hero' && resolvedHero.headline).toBe(
      'All Access Chicago',
    );
    expect(resolvedHero && resolvedHero.type === 'hero' && resolvedHero.body).toBe(
      'Join Tixkit for All Access Chicago',
    );
  });

  it('maps tickets (excluding hidden) and products onto resolved blocks', () => {
    const document = baseDocument();
    document.blocks.push({
      type: 'products',
      id: 'addons',
      title: 'Add-ons',
      productIds: ['prod_poster', 'prod_missing'],
    });
    const resolved = resolveEventPageDocument(document, context);
    const products = resolved.blocks.find((block) => block.type === 'products');
    expect(products && products.type === 'products' && products.products.map((p) => p.id)).toEqual([
      'prod_poster',
    ]);
  });

  it('marks unsafe URL documents invalid so they render empty', () => {
    const document = baseDocument('javascript:alert(1)');
    const resolved = resolveEventPageDocument(document, context);
    expect(resolved.validation.valid).toBe(false);
    expect(resolved.blocks).toEqual([]);
    expect(renderResolvedEventPageHtml(resolved)).toBe('');
  });

  it('returns empty blocks and invalid validation for an invalid document', () => {
    const document = baseDocument('javascript:alert(1)');
    const resolved = resolveEventPageDocument(document, context);
    expect(resolved.validation.valid).toBe(false);
    expect(resolved.blocks).toEqual([]);
  });

  it('resolves custom embeds only when explicitly allowed', () => {
    const document = baseDocument();
    document.blocks.push({
      type: 'custom_embed',
      id: 'embed',
      html: '<iframe src="https://player.example.test/video"></iframe>',
      allowUnsafeEmbed: true,
    });
    const denied = resolveEventPageDocument(document, context);
    expect(denied.validation.valid).toBe(false);
    expect(denied.blocks).toEqual([]);

    const allowed = resolveEventPageDocument(document, context, { allowUnsafeEmbeds: true });
    expect(allowed.validation.valid).toBe(true);
    const allowedEmbed = allowed.blocks.find((block) => block.type === 'custom_embed');
    expect(allowedEmbed && allowedEmbed.type === 'custom_embed' && allowedEmbed.html).toContain(
      'https://player.example.test/video',
    );
  });
});

describe('renderer parity (resolved model matches renderEventPageDocument)', () => {
  it('renderResolved* produces identical html/text/headless/discovery to renderEventPageDocument', () => {
    const document = baseDocument();
    document.blocks.push({
      type: 'products',
      id: 'addons',
      title: 'Add-ons',
      productIds: ['prod_poster'],
    });
    document.blocks.push({
      type: 'social_links',
      id: 'social',
      title: 'Follow',
      links: [{ label: 'Instagram', url: 'https://instagram.example.test' }],
    });

    const rendered = renderEventPageDocument(document, context);
    const resolved = resolveEventPageDocument(document, context);

    expect(renderResolvedEventPageHtml(resolved)).toBe(rendered.html);
    expect(renderResolvedEventPageText(resolved)).toBe(rendered.text);
    expect(renderResolvedEventPageHeadless(resolved)).toEqual(rendered.headless);
    expect(resolved.discovery).toEqual(rendered.discovery);
  });

  it('invalid resolved model renders empty html and headless', () => {
    const document = baseDocument('javascript:alert(1)');
    const resolved = resolveEventPageDocument(document, context);
    expect(renderResolvedEventPageHtml(resolved)).toBe('');
    expect(renderResolvedEventPageHeadless(resolved)).toEqual([]);
  });

  it('emits the shared namespaced class names used by the React surface', () => {
    const document = baseDocument();
    const html = renderResolvedEventPageHtml(resolveEventPageDocument(document, context));
    expect(html).toContain('class="tixkit-event-page"');
    expect(html).toContain('class="tk-ep-hero"');
    expect(html).toContain('class="tk-ep-tickets"');
    expect(html).toContain('class="tk-ep-venue"');
  });
});

describe('resolver XSS and URL safety hardening', () => {
  it('escapes HTML in merge-tag values rendered into resolved HTML', () => {
    const document = baseDocument();
    const hero = document.blocks.find((b) => b.type === 'hero')!;
    if (hero.type === 'hero') {
      hero.headline = '{{event.title}}';
    }
    const xssContext: EventPageRenderContext = {
      ...context,
      event: { ...context.event, title: '<script>alert(1)</script>' },
    };
    const resolved = resolveEventPageDocument(document, xssContext);
    const html = renderResolvedEventPageHtml(resolved);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('escapes script tags in direct block field values in resolved HTML', () => {
    const document = baseDocument();
    const hero = document.blocks.find((b) => b.type === 'hero')!;
    if (hero.type === 'hero') {
      hero.headline = '<script>alert(1)</script>';
    }
    const resolved = resolveEventPageDocument(document, context);
    const html = renderResolvedEventPageHtml(resolved);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('marks documents with unsafe hero image URLs invalid', () => {
    const document = baseDocument();
    const hero = document.blocks.find((b) => b.type === 'hero')!;
    if (hero.type === 'hero') {
      hero.imageUrl = 'javascript:alert(1)';
      hero.imageAlt = 'x';
    }
    const resolved = resolveEventPageDocument(document, context);
    expect(resolved.validation.valid).toBe(false);
    expect(resolved.blocks).toEqual([]);
  });

  it('marks documents with unsafe hero CTA URLs invalid', () => {
    const document = baseDocument();
    const hero = document.blocks.find((b) => b.type === 'hero')!;
    if (hero.type === 'hero') {
      hero.ctaUrl = 'data:text/html,<script>alert(1)</script>';
      hero.ctaLabel = 'Click';
    }
    const resolved = resolveEventPageDocument(document, context);
    expect(resolved.validation.valid).toBe(false);
    expect(resolved.blocks).toEqual([]);
  });

  it('marks documents with unsafe social_links URLs invalid', () => {
    const document = baseDocument();
    document.blocks.push({
      type: 'social_links',
      id: 'social',
      title: 'Follow',
      links: [
        { label: 'Bad', url: 'vbscript:msgbox(1)' },
        { label: 'Good', url: 'https://twitter.example.test' },
      ],
    });
    const resolved = resolveEventPageDocument(document, context);
    expect(resolved.validation.valid).toBe(false);
    expect(resolved.blocks).toEqual([]);
  });

  it('marks documents with unsafe button block URLs invalid', () => {
    const document = baseDocument();
    document.blocks.push({
      type: 'button',
      id: 'btn',
      label: 'Register',
      url: 'file:///etc/passwd',
    });
    const resolved = resolveEventPageDocument(document, context);
    expect(resolved.validation.valid).toBe(false);
    expect(resolved.blocks).toEqual([]);
  });

  it('escapes special characters in event_details item labels and values in HTML', () => {
    const document = baseDocument();
    const details = document.blocks.find((b) => b.type === 'event_details')!;
    if (details.type === 'event_details') {
      details.items = [{ label: 'Price & availability', value: 'Free <ticket>' }];
    }
    const resolved = resolveEventPageDocument(document, context);
    const html = renderResolvedEventPageHtml(resolved);
    expect(html).toContain('Price &amp; availability');
    expect(html).toContain('Free &lt;ticket&gt;');
    expect(html).not.toContain('Free <ticket>');
  });

  it('defense-in-depth: safeRenderedUrl replaces merge-tag-resolved unsafe URLs with #', () => {
    const document = baseDocument();
    const hero = document.blocks.find((b) => b.type === 'hero')!;
    if (hero.type === 'hero') {
      hero.ctaUrl = '{{event.checkoutUrl}}';
      hero.ctaLabel = 'Buy';
    }
    const xssContext: EventPageRenderContext = {
      ...context,
      event: { ...context.event, checkoutUrl: 'javascript:alert(1)' },
    };
    const resolved = resolveEventPageDocument(document, xssContext);
    const resolvedHero = resolved.blocks.find((b) => b.type === 'hero');
    expect(resolvedHero && resolvedHero.type === 'hero' && resolvedHero.ctaUrl).toBe('#');
    const html = renderResolvedEventPageHtml(resolved);
    expect(html).not.toContain('javascript:');
  });

  it('headless output for valid documents does not contain unescaped script tags', () => {
    const document = baseDocument();
    const resolved = resolveEventPageDocument(document, context);
    const headless = renderResolvedEventPageHeadless(resolved);
    const headlessJson = JSON.stringify(headless);
    expect(headlessJson).not.toContain('<script>');
    expect(headlessJson).not.toContain('<iframe>');
  });

  it('rich_text blocks are sanitized in the resolved model', () => {
    const document = baseDocument();
    document.blocks.push({
      type: 'rich_text',
      id: 'rt',
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Safe text' }],
          },
        ],
      },
    });
    const resolved = resolveEventPageDocument(document, context);
    const rtBlock = resolved.blocks.find((b) => b.type === 'rich_text');
    expect(rtBlock && rtBlock.type === 'rich_text' && rtBlock.html).toContain('Safe text');
    expect(rtBlock && rtBlock.type === 'rich_text' && rtBlock.html).not.toContain('<script>');
  });

  it('handles a large document (50+ blocks) without errors', () => {
    const document = createDefaultEventPageDocument({
      eventId: 'evt_demo_001',
      eventTitle: 'All Access Chicago',
      eventDescription: 'A full night of access.',
      checkoutUrl: 'https://checkout.example.test/checkout?eventId=evt_demo_001',
    });
    const defaultBlockCount = document.blocks.length;
    for (let i = 0; i < 50; i++) {
      document.blocks.push({
        type: 'rich_text',
        id: `rt-bulk-${i}`,
        content: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: `Paragraph ${i}` }] }],
        },
      });
    }
    const totalBlocks = defaultBlockCount + 50;
    const resolved = resolveEventPageDocument(document, context);
    expect(resolved.validation.valid).toBe(true);
    expect(resolved.blocks.length).toBe(totalBlocks);
    const html = renderResolvedEventPageHtml(resolved);
    expect(html).toContain('Paragraph 49');
    const text = renderResolvedEventPageText(resolved);
    expect(text).toContain('Paragraph 49');
    const headless = renderResolvedEventPageHeadless(resolved);
    expect(headless.length).toBe(totalBlocks);
  });
});

describe('chrome blocks (event_header, resale_tickets, brand_footer)', () => {
  it('event_header resolves event metadata from context and respects visibility toggles', () => {
    const document = baseDocument();
    const header = document.blocks.find((b) => b.type === 'event_header')!;
    if (header.type === 'event_header') {
      header.showBadge = true;
      header.showDate = true;
      header.showVenue = false;
      header.showDescription = true;
    }
    const resolved = resolveEventPageDocument(document, context);
    const block = resolved.blocks.find((b) => b.type === 'event_header');
    expect(block && block.type === 'event_header' && block.title).toBe('All Access Chicago');
    expect(block && block.type === 'event_header' && block.description).toBe(
      'A full night of music and access.',
    );
    expect(block && block.type === 'event_header' && block.badgeLabel).toBe('Tixkit');
    expect(block && block.type === 'event_header' && block.showVenue).toBe(false);
    expect(block && block.type === 'event_header' && block.venueName).toBeUndefined();
    const html = renderResolvedEventPageHtml(resolved);
    expect(html).toContain('tk-ep-header');
    expect(html).toContain('All Access Chicago');
    // The header section itself must not render the venue when showVenue is false.
    const headerHtml = html.match(/<section class="tk-ep-header"[\s\S]*?<\/section>/)?.[0] ?? '';
    expect(headerHtml).not.toContain('The Salt Shed');
  });

  it('event_header uses descriptionOverride when provided', () => {
    const document = baseDocument();
    const header = document.blocks.find((b) => b.type === 'event_header')!;
    if (header.type === 'event_header') {
      header.descriptionOverride = 'Custom description {{brand.name}}';
    }
    const resolved = resolveEventPageDocument(document, context);
    const block = resolved.blocks.find((b) => b.type === 'event_header');
    expect(block && block.type === 'event_header' && block.description).toBe(
      'Custom description Tixkit',
    );
  });

  it('resale_tickets resolves listings from context', () => {
    const document = baseDocument();
    const resolved = resolveEventPageDocument(document, context);
    const block = resolved.blocks.find((b) => b.type === 'resale_tickets');
    expect(block && block.type === 'resale_tickets' && block.listings.length).toBe(1);
    expect(block && block.type === 'resale_tickets' && block.listings[0].priceLabel).toBe('$40.00');
    const html = renderResolvedEventPageHtml(resolved);
    expect(html).toContain('tk-ep-resale');
    expect(html).toContain('General Admission');
    expect(html).toContain('$40.00');
  });

  it('resale_tickets shows empty state when no listings', () => {
    const document = baseDocument();
    const resolved = resolveEventPageDocument(document, { ...context, resaleListings: [] });
    const block = resolved.blocks.find((b) => b.type === 'resale_tickets');
    expect(block && block.type === 'resale_tickets' && block.listings).toEqual([]);
    const html = renderResolvedEventPageHtml(resolved);
    expect(html).toContain('No resale tickets available.');
  });

  it('brand_footer resolves links from brand context respecting toggles', () => {
    const document = baseDocument();
    const footer = document.blocks.find((b) => b.type === 'brand_footer')!;
    if (footer.type === 'brand_footer') {
      footer.showRefund = false;
    }
    const resolved = resolveEventPageDocument(document, context);
    const block = resolved.blocks.find((b) => b.type === 'brand_footer');
    const links = block && block.type === 'brand_footer' ? block.links : [];
    expect(links.map((l) => l.label)).toEqual(['Support', 'Terms', 'Privacy']);
    expect(links.find((l) => l.label === 'Refund')).toBeUndefined();
    const html = renderResolvedEventPageHtml(resolved);
    expect(html).toContain('tk-ep-footer');
    expect(html).toContain('https://example.test/terms');
    expect(html).not.toContain('https://example.test/refunds');
  });

  it('brand_footer renders empty footer when no brand URLs configured', () => {
    const document = baseDocument();
    const resolved = resolveEventPageDocument(document, {
      ...context,
      brand: { name: 'NoUrls' },
    });
    const block = resolved.blocks.find((b) => b.type === 'brand_footer');
    expect(block && block.type === 'brand_footer' && block.links).toEqual([]);
  });
});

describe('normalizeEventPageDocument chrome upgrade', () => {
  it('appends default chrome blocks to older documents lacking them', () => {
    const document = baseDocument();
    // Simulate an older document without chrome blocks.
    const legacy = {
      ...document,
      blocks: document.blocks.filter(
        (b) =>
          b.type !== 'event_header' && b.type !== 'resale_tickets' && b.type !== 'brand_footer',
      ),
    };
    expect(legacy.blocks.length).toBe(document.blocks.length - 3);

    const normalized = normalizeEventPageDocument(legacy);
    expect(normalized).toBeDefined();
    const types = normalized!.blocks.map((b) => b.type);
    expect(types[0]).toBe('event_header');
    expect(types[types.length - 1]).toBe('brand_footer');
    expect(types).toContain('resale_tickets');
    expect(normalized!.blocks.length).toBe(legacy.blocks.length + 3);
    // Original legacy document is not mutated.
    expect(legacy.blocks.length).toBe(document.blocks.length - 3);
  });

  it('returns the same reference when chrome blocks are already present', () => {
    const document = baseDocument();
    expect(normalizeEventPageDocument(document)).toBe(document);
  });
});
