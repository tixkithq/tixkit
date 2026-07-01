import { describe, expect, it } from 'vitest';
import {
  createDefaultSmsTemplate,
  createSmsTestSend,
  normalizeSmsTemplateDocument,
  renderSmsTemplate,
  unknownSmsVariables,
  validateSmsTemplate,
} from '../index.js';

const sampleContext = {
  event: {
    title: 'All Access Chicago',
    startsAt: '2026-07-17 19:00',
    checkoutUrl: 'https://events.example.test/aac',
  },
  recipient: {
    name: 'Ada <Lovelace>',
    phone: '+15550000001',
  },
};

describe('@tixkit/content-message SMS adapter', () => {
  it('renders GSM SMS with opt-out injection, segment count, and cost', () => {
    const document = createDefaultSmsTemplate({
      editor: { body: 'Hi {{recipient.name}}, {{event.title}} starts {{event.startsAt}}.' },
      settings: { segmentLimit: 2, estimatedCostPerSegmentCents: 3 },
    });

    const rendered = renderSmsTemplate(document, sampleContext);

    expect(rendered.text).toBe(
      'Hi Ada <Lovelace>, All Access Chicago starts 2026-07-17 19:00. Reply STOP to opt out',
    );
    expect(rendered.encoding).toBe('gsm');
    expect(rendered.segments).toBe(1);
    expect(rendered.estimatedCostCents).toBe(3);
    expect(rendered.validation.valid).toBe(true);
  });

  it('detects Unicode segment accounting and rendered length blockers', () => {
    const document = createDefaultSmsTemplate({
      editor: { body: '🎟️'.repeat(80) },
      settings: { category: 'transactional', consentCategory: 'transactional', segmentLimit: 1 },
    });

    const rendered = renderSmsTemplate(document, sampleContext);

    expect(rendered.encoding).toBe('unicode');
    expect(rendered.segments).toBeGreaterThan(1);
    expect(rendered.validation.valid).toBe(false);
    expect(rendered.validation.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'segment_limit_exceeded' })]),
    );
  });

  it('counts required opt-out text during save-time segment validation', () => {
    const document = createDefaultSmsTemplate({
      editor: { body: 'A'.repeat(160) },
      settings: {
        category: 'bulk',
        consentCategory: 'marketing',
        optOutText: 'Reply STOP to opt out',
        segmentLimit: 1,
      },
    });

    const validation = validateSmsTemplate(document);

    expect(validation.valid).toBe(false);
    expect(validation.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'segment_limit_exceeded',
          field: 'renderedText',
          severity: 'error',
        }),
      ]),
    );
  });

  it('blocks unknown variables, missing opt-out text, and consent mismatches', () => {
    const document = createDefaultSmsTemplate({
      editor: { body: 'Hi {{recipient.nickname}}' },
      settings: { optOutText: '', consentCategory: 'transactional' },
    });

    const validation = validateSmsTemplate(document);

    expect(unknownSmsVariables(document)).toEqual(['recipient.nickname']);
    expect(validation.valid).toBe(false);
    expect(validation.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'unknown_variable' }),
        expect.objectContaining({ code: 'missing_opt_out_token' }),
        expect.objectContaining({ code: 'consent_category_mismatch' }),
      ]),
    );
  });

  it('flags unsafe URLs and recommends short links for long public URLs', () => {
    const document = createDefaultSmsTemplate({
      editor: {
        body: 'Open https://192.168.1.10/admin or https://events.example.test/really/long/path/that/should/be/short',
      },
      settings: { category: 'transactional', consentCategory: 'transactional' },
    });

    const validation = validateSmsTemplate(document);

    expect(validation.valid).toBe(false);
    expect(validation.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'unsafe_link', severity: 'error' }),
        expect.objectContaining({ code: 'short_link_recommended', severity: 'warning' }),
      ]),
    );
  });

  it('normalizes canonical documents and rejects malformed editor exports', () => {
    const document = createDefaultSmsTemplate();

    expect(normalizeSmsTemplateDocument(document)).toEqual(document);
    expect(
      normalizeSmsTemplateDocument({ ...document, editor: { provider: 'legacy', body: 'x' } }),
    ).toBeUndefined();
  });

  it('creates capture-compatible SendSmsInput without provider side effects', () => {
    const document = createDefaultSmsTemplate({
      settings: { category: 'transactional', consentCategory: 'transactional' },
    });
    const rendered = renderSmsTemplate(document, sampleContext);
    const send = createSmsTestSend(document, rendered, {
      tenantId: 'tnt_1',
      organizationId: 'org_1',
      brandId: 'brd_1',
      jobId: 'smj_1',
      templateVersionId: 'cver_1',
      providerRouteId: 'spr_1',
      deliveryId: 'smd_1',
      from: '+15551112222',
      to: '+15550000001',
      idempotencyKey: 'idem_1',
    });

    expect(send).toMatchObject({
      tenantId: 'tnt_1',
      body: rendered.text,
      notificationType: 'transactional',
      providerRouteId: 'spr_1',
      idempotencyKey: 'idem_1',
    });
  });

  it('keeps randomized SMS renders deterministic, escaped, and within approved segment budgets', () => {
    const document = createDefaultSmsTemplate({
      editor: { body: 'Hi {{recipient.name}}, {{event.title}}: {{event.checkoutUrl}}' },
      settings: { segmentLimit: 3, estimatedCostPerSegmentCents: 2 },
    });

    for (let index = 0; index < 500; index += 1) {
      const name = `Ada${index}\u0000<script>${index}</script>`;
      const context = {
        ...sampleContext,
        recipient: { name },
      };
      const first = renderSmsTemplate(document, context);
      const second = renderSmsTemplate(document, context);

      expect(first).toEqual(second);
      expect(first.text).not.toContain('\u0000');
      expect(first.text).toContain(`<script>${index}</script>`);
      expect(first.segments).toBeGreaterThanOrEqual(1);
      expect(first.segments).toBeLessThanOrEqual(document.settings.segmentLimit);
      expect(first.text.endsWith('Reply STOP to opt out')).toBe(true);
    }
  });

  it('load-renders concurrent SMS variants without drifting output or budget accounting', async () => {
    const templates = Array.from({ length: 250 }, (_, index) =>
      createDefaultSmsTemplate({
        editor: {
          body: `Hi {{recipient.name}}, gate ${index % 7} opens for {{event.title}}: {{event.checkoutUrl}}`,
        },
        settings: {
          templateKey: `event-update-${index}`,
          segmentLimit: 3,
          estimatedCostPerSegmentCents: (index % 3) + 1,
        },
      }),
    );

    const rendered = await Promise.all(
      templates.map(async (document, index) => {
        const context = {
          ...sampleContext,
          recipient: {
            name: `Guest ${index}`,
            phone: `+1555${String(index).padStart(7, '0')}`,
          },
        };
        const first = renderSmsTemplate(document, context);
        const second = renderSmsTemplate(document, context);
        expect(first).toEqual(second);
        return first;
      }),
    );

    expect(rendered).toHaveLength(250);
    expect(rendered.every((message) => message.validation.valid)).toBe(true);
    expect(rendered.every((message) => message.segments >= 1 && message.segments <= 3)).toBe(true);
    expect(rendered.reduce((sum, message) => sum + message.estimatedCostCents, 0)).toBeGreaterThan(
      0,
    );
  });

  it('fails closed for malformed SMS editor exports and hostile canonical content', () => {
    const malformedExports: unknown[] = [
      undefined,
      null,
      [],
      { schemaVersion: 2, editor: { provider: '@tixkit/content-message/sms-composer', body: 'x' } },
      { schemaVersion: 1, editor: { provider: '@tixkit/content-message/sms-composer', body: 7 } },
      {
        schemaVersion: 1,
        editor: { provider: '@tixkit/content-message/sms-composer', body: 'x' },
        settings: {},
      },
      createDefaultSmsTemplate({ settings: { segmentLimit: 0 } }),
      createDefaultSmsTemplate({ settings: { estimatedCostPerSegmentCents: -1 } }),
      createDefaultSmsTemplate({ settings: { category: 'legacy' as never } }),
    ];

    for (const payload of malformedExports) {
      expect(normalizeSmsTemplateDocument(payload)).toBeUndefined();
    }

    const hostileDocument = createDefaultSmsTemplate({
      editor: {
        body: 'Hi {{recipient.name}}, open https://127.0.0.1/admin and {{missing.value}}',
      },
      settings: {
        templateKey: '../bad',
        category: 'bulk',
        consentCategory: 'transactional',
        optOutText: '',
      },
    });
    const rendered = renderSmsTemplate(hostileDocument, sampleContext);

    expect(rendered.validation.valid).toBe(false);
    expect(rendered.validation.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'invalid_template_key' }),
        expect.objectContaining({ code: 'unsafe_link' }),
        expect.objectContaining({ code: 'unknown_variable' }),
        expect.objectContaining({ code: 'missing_opt_out_token' }),
        expect.objectContaining({ code: 'consent_category_mismatch' }),
      ]),
    );
    expect(rendered.text).not.toContain('undefined');
  });
});
