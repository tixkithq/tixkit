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
    expect(normalizeSmsTemplateDocument({ ...document, editor: { provider: 'legacy', body: 'x' } }))
      .toBeUndefined();
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
});
