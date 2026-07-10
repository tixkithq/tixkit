import { describe, it, expect } from 'vitest';
import {
  createDefaultEmailTemplateForKey,
  hasSeedableDefaultEmailTemplate,
  P0_EMAIL_TEMPLATE_DEFAULTS,
  renderEmailTemplate,
  SEEDABLE_EMAIL_TEMPLATE_KEYS,
  validateEmailTemplate,
} from '../index.js';
import {
  TEMPLATE_KEYS,
  getTemplateLifecycle,
  renderMergeTags,
  type MergeTagContext,
} from '@tixkit/domain';
import { STUDIO_TEMPLATE_CONTENT, type StudioArchetype } from '../studio-templates.js';

const distinctiveContext: MergeTagContext = {
  event: {
    title: 'Event All Access',
    startsAt: '2026-07-17 19:00',
    endsAt: '2026-07-17 23:00',
    timezone: 'America/Chicago',
    venueName: 'Venue Grand Hall',
    venueCity: 'Brooklyn',
    publicUrl: 'https://events.example.test/e/all-access',
    checkoutUrl: 'https://checkout.example.test/checkout?eventId=evt_1',
    doorTime: '2026-07-17 18:00',
    mapUrl: 'https://maps.example.test/venue',
    refundPolicyUrl: 'https://help.example.test/refunds-777',
    changeSummary: 'Venue moved to The Forum',
    cancellationReason: 'Unforeseen weather',
  },
  brand: {
    name: 'Brand Tixkit',
    logoUrl: 'https://assets.example.test/brand-tixkit.png',
    supportUrl: 'https://help.example.test/support-777',
  },
  recipient: { name: 'Recipient Ada', email: 'ada@example.test', phone: '+15551234567' },
  attendee: { name: 'Attendee Ada', checkedIn: false },
  ticket: {
    type: 'GA Ticket',
    code: 'TKTCODE-42',
    qrCodeUrl: 'https://tickets.example.test/qr/TKTCODE-42.png',
    pdfUrl: 'https://tickets.example.test/pdf/TKTCODE-42.pdf',
    walletAppleUrl: 'https://tickets.example.test/pass/apple/TKTCODE-42.pkpass',
    walletGoogleUrl: 'https://pay.google.com/gp/v/save/abc',
    transferUrl: 'https://checkout.example.test/transfer/TKTCODE-42/claim',
  },
  order: {
    id: 'ORDER-777',
    total: '$99.00',
    manageUrl: 'https://checkout.example.test/orders/ORDER-777',
    receiptUrl: 'https://checkout.example.test/receipts/ORDER-777',
    retryUrl: 'https://checkout.example.test/checkout?retry=ORDER-777',
    cancellationReason: 'Organizer cancelled',
    creditStatus: 'Full credit issued',
    buyerName: 'Buyer Ada',
    buyerEmail: 'buyer@example.test',
  },
  refund: {
    amount: '$20.00',
    processingEta: '5-10 business days',
    processedAt: '2026-07-10 12:00',
  },
  device: {
    inviteUrl: 'https://scan.example.test/invite/dev-1',
    permissionScope: 'checkins.write',
    expiresAt: '2026-07-17 19:00',
  },
  dashboard: { url: 'https://admin.example.test/events/evt-1' },
  waitlist: {
    position: '3',
    inviteUrl: 'https://checkout.example.test/waitlist/claim/abc',
    expiresAt: '2026-07-18 19:00',
  },
  review: { platform: 'Review Site' },
  salesDigest: {
    revenue: '$4,320.00',
    orders: '38',
    topTicketType: 'VIP',
  },
  payout: {
    amount: '$1,250.00',
    eta: '2-3 business days',
    account: 'Bank ****4242',
    period: 'June 2026',
  },
  integration: {
    name: 'Integration Stripe',
    reconnectUrl: 'https://admin.example.test/integrations/stripe/reconnect',
  },
  webhook: {
    endpointUrl: 'https://hooks.example.test/integrations/stripe',
    attempts: '5',
  },
  chargeback: {
    id: 'DP-777',
    amount: '$45.00',
    dueAt: '2026-07-18',
    evidenceUrl: 'https://admin.example.test/disputes/DP-777',
  },
};

const requiredVarValue: Record<string, string> = {
  'recipient.name': distinctiveContext.recipient!.name!,
  'event.title': distinctiveContext.event!.title!,
  'order.id': distinctiveContext.order!.id!,
  'order.total': distinctiveContext.order!.total!,
  'ticket.type': distinctiveContext.ticket!.type!,
  'ticket.code': distinctiveContext.ticket!.code!,
  'ticket.qrCodeUrl': distinctiveContext.ticket!.qrCodeUrl!,
  'brand.supportUrl': distinctiveContext.brand!.supportUrl!,
  'refund.amount': distinctiveContext.refund!.amount!,
  'event.startsAt': distinctiveContext.event!.startsAt!,
  'event.venueName': distinctiveContext.event!.venueName!,
  'waitlist.inviteUrl': distinctiveContext.waitlist!.inviteUrl!,
  'waitlist.expiresAt': distinctiveContext.waitlist!.expiresAt!,
  'event.checkoutUrl': distinctiveContext.event!.checkoutUrl!,
  'ticket.transferUrl': distinctiveContext.ticket!.transferUrl!,
  'review.platform': distinctiveContext.review!.platform!,
  'dashboard.url': distinctiveContext.dashboard!.url!,
  'payout.amount': distinctiveContext.payout!.amount!,
  'integration.name': distinctiveContext.integration!.name!,
  'integration.reconnectUrl': distinctiveContext.integration!.reconnectUrl!,
  'webhook.endpointUrl': distinctiveContext.webhook!.endpointUrl!,
  'chargeback.id': distinctiveContext.chargeback!.id!,
  'chargeback.amount': distinctiveContext.chargeback!.amount!,
  'chargeback.dueAt': distinctiveContext.chargeback!.dueAt!,
};

const archetypesByKey: Record<(typeof TEMPLATE_KEYS)[number], StudioArchetype> = {
  'order-confirmed': 'receipt',
  'tickets-issued': 'access',
  'payment-failed': 'recovery',
  'order-cancelled': 'receipt',
  'order-refunded': 'receipt',
  'event-updated': 'announcement',
  'event-cancelled': 'announcement',
  'event-reminder': 'access',
  'attendee-message': 'announcement',
  'staff-order-notification': 'ops',
  'organization-member-invited': 'invite',
  'checkin-device-invited': 'invite',
  'waitlist-joined': 'invite',
  'waitlist-invite': 'recovery',
  'waitlist-invite-expiring': 'recovery',
  'abandoned-checkout': 'recovery',
  'ticket-transfer-started': 'invite',
  'ticket-transfer-accepted': 'receipt',
  'ticket-transfer-cancelled': 'receipt',
  'wallet-pass-ready': 'access',
  'post-event-thank-you': 'announcement',
  'review-request': 'announcement',
  'daily-sales-digest': 'ops',
  'payout-scheduled': 'ops',
  'payout-paid': 'ops',
  'payout-failed': 'ops',
  'brand-sender-verification': 'ops',
  'integration-disconnected': 'ops',
  'webhook-failed': 'ops',
  'chargeback-opened': 'ops',
  'chargeback-won': 'ops',
  'chargeback-lost': 'ops',
};

describe('createDefaultEmailTemplateForKey', () => {
  it('covers every lifecycle template key with a default document', () => {
    for (const key of TEMPLATE_KEYS) {
      const doc = P0_EMAIL_TEMPLATE_DEFAULTS[key];
      expect(doc, `missing default for ${key}`).toBeDefined();
      expect(doc.settings.templateKey).toBe(key);
    }
  });

  it('derives subject, category, and preview text from the lifecycle registry', () => {
    for (const key of TEMPLATE_KEYS) {
      const entry = getTemplateLifecycle(key)!;
      const doc = createDefaultEmailTemplateForKey(key);
      expect(doc.settings.subject).toBe(entry.defaultSubject);
      expect(doc.settings.category).toBe(entry.category);
      expect(doc.settings.previewText).toBe(entry.defaultPreviewText);
    }
  });

  it('produces defaults that validate cleanly', () => {
    for (const key of SEEDABLE_EMAIL_TEMPLATE_KEYS) {
      const doc = createDefaultEmailTemplateForKey(key);
      const result = validateEmailTemplate(doc);
      expect(
        result.valid,
        `${key} default has validation blockers: ${JSON.stringify(result.issues)}`,
      ).toBe(true);
    }
  });

  it('renders every required merge tag for each lifecycle default', async () => {
    await Promise.all(
      TEMPLATE_KEYS.map(async (key) => {
        const entry = getTemplateLifecycle(key)!;
        const doc = createDefaultEmailTemplateForKey(key);
        const rendered = await renderEmailTemplate(doc, distinctiveContext);
        expect(rendered.validation.valid, `${key} default did not render cleanly`).toBe(true);
        const output = `${rendered.html}\n${rendered.text}`;
        for (const requiredVar of entry.requiredVariables) {
          const expected = requiredVarValue[requiredVar];
          expect(expected, `no expected value mapped for {{${requiredVar}}}`).toBeDefined();
          expect(
            output,
            `${key} default did not render required variable {{${requiredVar}}}`,
          ).toContain(expected);
        }
      }),
    );
  });

  it('uses the Studio editor HTML as the send-rendered lifecycle body', async () => {
    await Promise.all(
      TEMPLATE_KEYS.map(async (key) => {
        const doc = createDefaultEmailTemplateForKey(key);
        const rendered = await renderEmailTemplate(doc, distinctiveContext);
        const expectedHtml = renderMergeTags(doc.editor.contentHtml, distinctiveContext, {
          channel: 'email',
          escape: 'html',
        });

        expect(doc.editor.contentHtml, `${key} default should use the Studio canvas`).toContain(
          'background-color: #F6F6F6',
        );
        expect(doc.editor.contentHtml, `${key} default should identify its archetype`).toContain(
          `data-studio-archetype="${archetypesByKey[key]}"`,
        );
        expect(
          doc.editor.contentHtml,
          `${key} default should use editor-safe wrappers`,
        ).not.toMatch(/<(?:section|header|footer)\b/i);
        // Send path wraps the editor body in a full email document shell for clients.
        expect(rendered.html, `${key} send render dropped the Studio body`).toContain(expectedHtml);
        expect(rendered.html, `${key} send render should be a full email document`).toContain(
          '<!DOCTYPE html>',
        );
        expect(rendered.html).toContain('background-color:#ffffff');
        expect(rendered.html).toContain('fonts.googleapis.com');
        expect(doc.editor.contentHtml, `${key} default should inherit the brand logo`).toContain(
          '{{brand.logoUrl}}',
        );
        expect(rendered.html, `${key} should render the configured brand logo`).toContain(
          'https://assets.example.test/brand-tixkit.png',
        );
      }),
    );
  });

  it('uses the faithful Studio tokens and a hand-authored definition for every key', () => {
    expect(Object.keys(STUDIO_TEMPLATE_CONTENT)).toEqual(TEMPLATE_KEYS);
    for (const key of TEMPLATE_KEYS) {
      const doc = createDefaultEmailTemplateForKey(key);
      expect(STUDIO_TEMPLATE_CONTENT[key].archetype).toBe(archetypesByKey[key]);
      expect(doc.editor.contentHtml).toContain('font-family: Geist, Inter, Arial, sans-serif');
      expect(doc.editor.contentHtml).toContain(
        archetypesByKey[key] === 'ops' ? 'font-size: 24px' : 'font-size: 40px',
      );
      if ('primaryAction' in STUDIO_TEMPLATE_CONTENT[key]) {
        expect(doc.editor.contentHtml).toContain('border: 1px solid #E8E9E9');
        expect(doc.editor.contentHtml).toContain('box-shadow: 0px 3px 2px');
      }
      expect(doc.editor.contentHtml).not.toMatch(/<(?:style|link|script|iframe|svg|meta)\b/i);
    }
  });

  it('removes optional rows and actions cleanly when their context is absent', async () => {
    await Promise.all(
      TEMPLATE_KEYS.map(async (key) => {
        const lifecycle = getTemplateLifecycle(key)!;
        const minimalContext = minimalContextFor(lifecycle.requiredVariables);
        const rendered = await renderEmailTemplate(
          createDefaultEmailTemplateForKey(key),
          minimalContext,
        );
        expect(rendered.validation.valid, `${key} minimal render should validate`).toBe(true);
        expect(rendered.html, `${key} left an empty optional marker`).not.toContain(
          'data-studio-optional-value=""',
        );
        expect(rendered.html, `${key} left an empty action URL`).not.toContain('href=""');
        expect(rendered.html, `${key} left a blank labeled fact row`).not.toMatch(
          /data-studio-row="true"[^>]*>[\s\S]*?<p[^>]*>[^<]+<\/p><p[^>]*>\s*<\/p>/i,
        );
      }),
    );
  });

  it('keeps CTA destinations readable in plain-text output', async () => {
    const rendered = await renderEmailTemplate(
      createDefaultEmailTemplateForKey('order-confirmed'),
      distinctiveContext,
    );
    expect(rendered.text).toContain(
      'View your order → (https://checkout.example.test/orders/ORDER-777)',
    );
    expect(rendered.text).toContain(
      'View receipt (https://checkout.example.test/receipts/ORDER-777)',
    );
  });

  it('requires unsubscribe footers for bulk defaults only', () => {
    for (const key of TEMPLATE_KEYS) {
      const entry = getTemplateLifecycle(key)!;
      const doc = createDefaultEmailTemplateForKey(key);
      const hasFooter = doc.blocks.some((block) => block.type === 'unsubscribe_footer');
      if (entry.category === 'bulk') {
        expect(hasFooter, `${key} bulk default should include an unsubscribe footer`).toBe(true);
      } else {
        expect(hasFooter, `${key} non-bulk default should not force an unsubscribe footer`).toBe(
          false,
        );
      }
    }
  });

  it('references ticket PDF and wallet merge tags in the tickets-issued default', async () => {
    const doc = createDefaultEmailTemplateForKey('tickets-issued');
    const rendered = await renderEmailTemplate(doc, distinctiveContext);
    expect(rendered.html).toContain('https://tickets.example.test/pdf/TKTCODE-42.pdf');
    expect(rendered.html).toContain('https://tickets.example.test/pass/apple/TKTCODE-42.pkpass');
  });

  it('does not render optional lifecycle rows that would be blank without context', async () => {
    const doc = createDefaultEmailTemplateForKey('event-reminder');
    const rendered = await renderEmailTemplate(doc, {
      event: {
        title: 'Sample Summer Showcase',
        startsAt: 'Sat, Aug 15 at 8:00 PM',
        venueName: 'River North Hall',
      },
      brand: { name: 'All Access Chicago', supportUrl: 'https://help.example.test/support' },
      recipient: { name: 'Ada Lovelace' },
      ticket: {
        qrCodeUrl: 'https://tickets.example.test/qr/TKTCODE-42.png',
      },
    });

    expect(rendered.validation.valid).toBe(true);
    expect(rendered.html).toContain('River North Hall');
    expect(rendered.html).not.toContain('Venue City');
    expect(rendered.html).not.toContain('Timezone');
    expect(rendered.html).not.toContain('Door Time');
  });

  it('renders ticket QR merge tags only as images, not CTA links', () => {
    const doc = createDefaultEmailTemplateForKey('event-reminder');

    expect(doc.editor.contentHtml).toContain('<img src="{{ticket.qrCodeUrl}}"');
    expect(doc.editor.contentHtml).not.toContain('href="{{ticket.qrCodeUrl}}"');
    expect(doc.editor.contentText).not.toContain('Qr Code');
  });

  it('throws for template keys without lifecycle metadata', () => {
    expect(() => createDefaultEmailTemplateForKey('not-a-lifecycle-key' as never)).toThrow();
  });

  it('marks every registered lifecycle key as seedable', () => {
    expect(SEEDABLE_EMAIL_TEMPLATE_KEYS).toEqual(TEMPLATE_KEYS);
    for (const key of TEMPLATE_KEYS) {
      expect(hasSeedableDefaultEmailTemplate(key), key).toBe(true);
    }
  });
});

function minimalContextFor(requiredVariables: string[]): MergeTagContext {
  const context = {
    recipient: { name: distinctiveContext.recipient!.name },
    brand: { ...distinctiveContext.brand },
  } as MergeTagContext;
  for (const variable of requiredVariables) {
    const [namespace, key] = variable.split('.') as [keyof MergeTagContext, string];
    const source = distinctiveContext[namespace] as Record<string, unknown> | undefined;
    const target = (context[namespace] ?? {}) as Record<string, unknown>;
    target[key] = source?.[key];
    Object.assign(context, { [namespace]: target });
  }
  return context;
}
