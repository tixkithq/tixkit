import { describe, expect, it } from 'vitest';
import {
  REACT_EMAIL_EDITOR_PACKAGE,
  createDefaultEmailTemplate,
  createEmailTestSend,
  normalizeEmailTemplateDocument,
  renderEmailTemplate,
  validateEditorExport,
  validateEmailTemplate,
} from '../index.js';

const context = {
  event: {
    title: 'All Access Chicago',
    startsAt: '2026-07-17 19:00',
    publicUrl: 'https://events.example.test/e/all-access-chicago',
    checkoutUrl: 'https://checkout.example.test/checkout?eventId=evt_demo_001',
  },
  brand: {
    name: 'Tixkit',
    supportUrl: 'https://help.example.test/preferences',
  },
  recipient: {
    name: 'Ada Lovelace',
    email: 'ada@example.test',
  },
  ticket: {
    type: 'General Admission',
    qrCodeUrl: 'https://tickets.example.test/qr/TKT-123.png',
  },
  order: {
    total: '$35.00',
  },
};

describe('normalizeEmailTemplateDocument', () => {
  it('accepts canonical React Email editor documents and rejects malformed JSON', () => {
    const template = createDefaultEmailTemplate();

    expect(normalizeEmailTemplateDocument(template)).toEqual(template);
    expect(normalizeEmailTemplateDocument({ ...template, schemaVersion: 2 })).toBeUndefined();
    expect(
      normalizeEmailTemplateDocument({
        ...template,
        editor: { ...template.editor, provider: 'legacy-html-editor' },
      }),
    ).toBeUndefined();
    expect(
      normalizeEmailTemplateDocument({
        ...template,
        blocks: [{ type: 'event_hero', body: 'Missing headline' }],
      }),
    ).toBeUndefined();
  });
});

describe('validateEmailTemplate', () => {
  it('accepts a transactional template exported through the React Email editor seam', () => {
    const template = createDefaultEmailTemplate();
    const result = validateEmailTemplate(template);

    expect(template.editor.provider).toBe(REACT_EMAIL_EDITOR_PACKAGE);
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('blocks bulk templates without unsubscribe footers', () => {
    const template = createDefaultEmailTemplate({
      settings: {
        templateKey: 'marketing-blast',
        subject: 'Hi {{recipient.name}}',
        locale: 'en',
        category: 'bulk',
        sender: { fromEmail: 'news@example.test' },
      },
      blocks: [{ type: 'ticket_summary', title: 'Offer', body: 'Join {{event.title}}' }],
    });

    const result = validateEmailTemplate(template);

    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.code === 'missing_unsubscribe')).toBe(true);
  });

  it('blocks unsafe links and missing image alt text', () => {
    const template = createDefaultEmailTemplate({
      blocks: [
        {
          type: 'event_hero',
          headline: '{{event.title}}',
          imageUrl: 'https://cdn.example.test/hero.jpg',
          ctaLabel: 'Open',
          ctaUrl: 'javascript:alert(1)',
        },
        {
          type: 'unsubscribe_footer',
          body: 'Manage preferences',
          unsubscribeUrl: 'https://help.example.test/preferences',
        },
      ],
    });

    const result = validateEmailTemplate(template);

    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.code === 'unsafe_link')).toBe(true);
    expect(result.issues.some((issue) => issue.code === 'missing_image_alt')).toBe(true);
  });

  it('blocks unsafe raw HTML', () => {
    const template = createDefaultEmailTemplate({
      blocks: [
        { type: 'raw_html', html: '<script>alert(1)</script>', safe: false },
        {
          type: 'unsubscribe_footer',
          body: 'Manage preferences',
          unsubscribeUrl: 'https://help.example.test/preferences',
        },
      ],
    });

    const result = validateEmailTemplate(template);

    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.code === 'unsafe_raw_html')).toBe(true);
  });
});

describe('renderEmailTemplate', () => {
  it('renders deterministic React Email HTML and plain text with escaped variables', async () => {
    const template = createDefaultEmailTemplate();
    const maliciousContext = {
      ...context,
      event: { ...context.event, title: '<script>alert(1)</script>' },
    };

    const first = await renderEmailTemplate(template, maliciousContext);
    const second = await renderEmailTemplate(template, maliciousContext);

    expect(first.validation.valid).toBe(true);
    expect(first.subject).toBe('Your <script>alert(1)</script> tickets are ready');
    expect(first.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(first.text).toContain('Ada Lovelace');
    expect(second.html).toBe(first.html);
    expect(second.text).toBe(first.text);
  });

  it('returns validation issues instead of rendering invalid templates', async () => {
    const template = createDefaultEmailTemplate({
      settings: {
        templateKey: 'bad',
        subject: '',
        locale: 'en',
        category: 'transactional',
        sender: { fromEmail: 'tickets@example.test' },
      },
    });

    const rendered = await renderEmailTemplate(template, context);

    expect(rendered.validation.valid).toBe(false);
    expect(rendered.html).toBe('');
    expect(rendered.validation.issues.some((issue) => issue.code === 'missing_subject')).toBe(true);
  });

  it('renders QR code images and calendar buttons from merge-tag URLs', async () => {
    const template = createDefaultEmailTemplate({
      blocks: [
        {
          type: 'qr_code',
          title: 'Your entry QR',
          imageUrl: '{{ticket.qrCodeUrl}}',
          imageAlt: 'Personal ticket QR code',
        },
        {
          type: 'calendar_button',
          label: 'Save this date',
          url: '{{event.publicUrl}}',
        },
        {
          type: 'unsubscribe_footer',
          body: 'You are receiving this because you purchased tickets with {{brand.name}}.',
          unsubscribeUrl: '{{brand.supportUrl}}',
        },
      ],
    });

    const rendered = await renderEmailTemplate(template, context);

    expect(rendered.validation.valid).toBe(true);
    expect(rendered.html).toContain('Save this date');
    expect(rendered.html).toContain('https://tickets.example.test/qr/TKT-123.png');
    expect(rendered.text).toContain('Save this date');
  });

  it('load-renders concurrent email variants without drifting output or merge-tag escaping', async () => {
    const baseTemplate = createDefaultEmailTemplate();
    const templates = Array.from({ length: 120 }, (_, index) =>
      createDefaultEmailTemplate({
        settings: {
          ...baseTemplate.settings,
          templateKey: `order-confirmed-${index}`,
          subject: `Gate ${index % 5}: {{event.title}} tickets for {{recipient.name}}`,
          previewText: `Arrival window ${index % 3}`,
        },
        blocks: [
          {
            type: 'event_hero',
            headline: `Welcome {{recipient.name}} ${index}`,
            body: 'Your {{event.title}} order is confirmed.',
            ctaLabel: 'View tickets',
            ctaUrl: '{{event.checkoutUrl}}',
          },
          {
            type: 'order_summary',
            title: 'Order summary',
            rows: [
              { label: 'Ticket', value: '{{ticket.type}}' },
              { label: 'Total', value: '{{order.total}}' },
            ],
          },
          {
            type: 'unsubscribe_footer',
            body: 'Manage email preferences for {{brand.name}}.',
            unsubscribeUrl: '{{brand.supportUrl}}',
          },
        ],
      }),
    );

    const rendered = await Promise.all(
      templates.map(async (template, index) => {
        const variantContext = {
          ...context,
          recipient: {
            name: `Guest ${index}<script>${index}</script>`,
            email: `guest-${index}@example.test`,
          },
        };
        const first = await renderEmailTemplate(template, variantContext);
        const second = await renderEmailTemplate(template, variantContext);

        expect(first).toEqual(second);
        expect(first.validation.valid).toBe(true);
        expect(first.html).toContain(`Guest ${index}&lt;script&gt;${index}&lt;/script&gt;`);
        expect(first.html).not.toContain(`Guest ${index}<script>${index}</script>`);
        return first;
      }),
    );

    expect(rendered).toHaveLength(120);
    expect(new Set(rendered.map((message) => message.subject)).size).toBe(120);
    expect(rendered.every((message) => message.html.includes('Order summary'))).toBe(true);
    expect(rendered.every((message) => message.text.trim().length > 0)).toBe(true);
  });

  it('fails closed for malformed editor exports and hostile provider-incompatible content', async () => {
    const baseTemplate = createDefaultEmailTemplate();
    const malformedExports: unknown[] = [
      undefined,
      null,
      [],
      createDefaultEmailTemplate({ schemaVersion: 2 as 1 }),
      {
        ...baseTemplate,
        editor: { ...baseTemplate.editor, provider: 'legacy-html-editor' },
      },
      createDefaultEmailTemplate({ blocks: [{ type: 'legacy_block' } as never] }),
      {
        ...baseTemplate,
        settings: { ...baseTemplate.settings, category: 'legacy' },
      },
      {
        ...baseTemplate,
        settings: {
          ...baseTemplate.settings,
          sender: { ...baseTemplate.settings.sender, fromEmail: 42 },
        },
      },
    ];

    for (const payload of malformedExports) {
      expect(normalizeEmailTemplateDocument(payload)).toBeUndefined();
    }

    const hostileTemplate = createDefaultEmailTemplate({
      settings: {
        ...baseTemplate.settings,
        subject: 'x'.repeat(999),
        sender: { ...baseTemplate.settings.sender, fromEmail: 'not-an-email', replyToEmail: 'bad-reply-to' },
      },
      blocks: [
        {
          type: 'event_hero',
          headline: '{{unknown.value}}',
          imageUrl: 'https://cdn.example.test/hero.jpg',
          ctaLabel: 'Open',
          ctaUrl: 'http://127.0.0.1/admin',
        },
        { type: 'raw_html', html: '<script>alert(1)</script>', safe: false },
        {
          type: 'unsubscribe_footer',
          body: 'Manage preferences',
          unsubscribeUrl: 'https://help.example.test/preferences',
        },
      ],
    });

    const validation = validateEmailTemplate(hostileTemplate, { provider: 'resend' });
    const rendered = await renderEmailTemplate(hostileTemplate, context);

    expect(validation.valid).toBe(false);
    expect(validation.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'unknown_variable' }),
        expect.objectContaining({ code: 'invalid_sender_context' }),
        expect.objectContaining({ code: 'invalid_reply_to' }),
        expect.objectContaining({ code: 'unsafe_link' }),
        expect.objectContaining({ code: 'missing_image_alt' }),
        expect.objectContaining({ code: 'unsafe_raw_html' }),
        expect.objectContaining({ code: 'provider_incompatible_subject' }),
      ]),
    );
    expect(rendered.validation.valid).toBe(false);
    expect(rendered.html).toBe('');
    expect(rendered.text).toBe('');
  });
});

describe('createEmailTestSend', () => {
  it('maps rendered template output to the existing SendEmailInput contract', async () => {
    const template = createDefaultEmailTemplate();
    const rendered = await renderEmailTemplate(template, context);

    const send = createEmailTestSend(template, rendered, {
      tenantId: 'tnt_1',
      organizationId: 'org_1',
      brandId: 'br_1',
      templateVersionId: 'cv_1',
      providerRouteId: 'epr_1',
      deliveryId: 'emd_1',
      to: [{ email: 'ada@example.test', name: 'Ada Lovelace' }],
      idempotencyKey: 'test-send-1',
    });

    expect(send.templateKey).toBe('order-confirmed');
    expect(send.templateVersionId).toBe('cv_1');
    expect(send.subject).toBe(rendered.subject);
    expect(send.html).toBe(rendered.html);
    expect(send.text).toBe(rendered.text);
    expect(send.metadata.notificationType).toBe('transactional');
  });
});

describe('validateEditorExport', () => {
  it('fails editor exports with unknown variables', () => {
    const result = validateEditorExport('<p>{{unknown.value}}</p>');

    expect(result.valid).toBe(false);
    expect(result.issues[0]?.code).toBe('unknown_variable');
  });
});
