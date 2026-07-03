import { describe, it, expect } from 'vitest';
import {
  createDefaultEmailTemplateForKey,
  P0_EMAIL_TEMPLATE_DEFAULTS,
  renderEmailTemplate,
  validateEmailTemplate,
} from '../index.js';
import {
  P0_TEMPLATE_KEYS,
  getTemplateLifecycle,
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
  refund: { amount: '$20.00', processingEta: '5-10 business days', processedAt: '2026-07-10 12:00' },
  device: {
    inviteUrl: 'https://scan.example.test/invite/dev-1',
    permissionScope: 'checkins.write',
    expiresAt: '2026-07-17 19:00',
  },
  dashboard: { url: 'https://admin.example.test/events/evt-1' },
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
};

describe('createDefaultEmailTemplateForKey', () => {
  it('covers every P0 template key with a default document', () => {
    for (const key of P0_TEMPLATE_KEYS) {
      const doc = P0_EMAIL_TEMPLATE_DEFAULTS[key];
      expect(doc, `missing default for ${key}`).toBeDefined();
      expect(doc.settings.templateKey).toBe(key);
    }
  });

  it('derives subject, category, and preview text from the lifecycle registry', () => {
    for (const key of P0_TEMPLATE_KEYS) {
      const entry = getTemplateLifecycle(key)!;
      const doc = createDefaultEmailTemplateForKey(key);
      expect(doc.settings.subject).toBe(entry.defaultSubject);
      expect(doc.settings.category).toBe(entry.category);
      expect(doc.settings.previewText).toBe(entry.defaultPreviewText);
    }
  });

  it('produces defaults that validate cleanly', () => {
    for (const key of P0_TEMPLATE_KEYS) {
      const doc = createDefaultEmailTemplateForKey(key);
      const result = validateEmailTemplate(doc);
      expect(result.valid, `${key} default has validation blockers: ${JSON.stringify(result.issues)}`).toBe(true);
    }
  });

  it('renders every required merge tag for each P0 default', async () => {
    await Promise.all(
      P0_TEMPLATE_KEYS.map(async (key) => {
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

  it('requires an unsubscribe footer only for the bulk attendee-message default', () => {
    const attendeeMessage = createDefaultEmailTemplateForKey('attendee-message');
    expect(attendeeMessage.settings.category).toBe('bulk');
    expect(attendeeMessage.blocks.some((block) => block.type === 'unsubscribe_footer')).toBe(true);

    for (const key of P0_TEMPLATE_KEYS) {
      const entry = getTemplateLifecycle(key)!;
      if (entry.category !== 'transactional') continue;
      const doc = createDefaultEmailTemplateForKey(key);
      expect(
        doc.blocks.some((block) => block.type === 'unsubscribe_footer'),
        `${key} transactional default should not force an unsubscribe footer`,
      ).toBe(false);
    }
  });

  it('references ticket PDF and wallet merge tags in the tickets-issued default', async () => {
    const doc = createDefaultEmailTemplateForKey('tickets-issued');
    const rendered = await renderEmailTemplate(doc, distinctiveContext);
    expect(rendered.html).toContain('https://tickets.example.test/pdf/TKTCODE-42.pdf');
    expect(rendered.html).toContain('https://tickets.example.test/pass/apple/TKTCODE-42.pkpass');
  });

  it('throws for template keys without lifecycle metadata', () => {
    expect(() => createDefaultEmailTemplateForKey('not-a-lifecycle-key' as never)).toThrow();
  });
});
