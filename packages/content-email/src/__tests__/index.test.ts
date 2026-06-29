import { describe, expect, it } from 'vitest';
import {
  REACT_EMAIL_EDITOR_PACKAGE,
  createDefaultEmailTemplate,
  createEmailTestSend,
  renderEmailTemplate,
  validateEditorExport,
  validateEmailTemplate,
} from '../index.js';

const context = {
  event: {
    title: 'All Access Chicago',
    startsAt: '2026-07-17 19:00',
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
  },
  order: {
    total: '$35.00',
  },
};

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
