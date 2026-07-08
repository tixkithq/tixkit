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
  brand: { name: 'Brand Tixkit', supportUrl: 'https://help.example.test/support-777' },
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

        expect(doc.editor.contentHtml, `${key} default should use the Studio shell`).toContain(
          'background-color: #dce1e4',
        );
        expect(doc.editor.contentHtml, `${key} default should use the Studio card`).toContain(
          'border-radius: 28px',
        );
        expect(rendered.html, `${key} send render drifted from editor HTML`).toBe(expectedHtml);
      }),
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
