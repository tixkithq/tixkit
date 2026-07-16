import { describe, it, expect } from 'vitest';
import {
  ProviderRouteSelector,
  FallbackEmailTransport,
  MockEmailTransport,
  validateProviderFields,
} from '../index.js';
import type { SendEmailInput } from '@tixkit/domain';

const baseInput = (overrides: Partial<SendEmailInput> = {}): SendEmailInput => ({
  tenantId: 'tnt_1',
  organizationId: 'org_1',
  brandId: 'brd_1',
  templateKey: 'order-confirmed',
  templateVersionId: 'ntv_1',
  deliveryId: 'emd_1',
  from: { email: 'tickets@event.com', name: 'Event Tickets' },
  to: [{ email: 'buyer@example.com' }],
  subject: 'Your tickets are confirmed',
  html: '<h1>Thank you</h1>',
  metadata: { notificationType: 'transactional' },
  providerRouteId: 'epr_1',
  idempotencyKey: 'idem_1',
  ...overrides,
});

describe('ProviderRouteSelector', () => {
  it('selects the highest priority non-fallback route for the category', () => {
    const primary = new MockEmailTransport('primary');
    const secondary = new MockEmailTransport('secondary');
    const selector = new ProviderRouteSelector([
      {
        id: 'r2',
        transport: secondary,
        priority: 2,
        isFallback: false,
        allowedCategories: ['transactional'],
      },
      {
        id: 'r1',
        transport: primary,
        priority: 1,
        isFallback: false,
        allowedCategories: ['transactional'],
      },
    ]);
    const selected = selector.select('transactional');
    expect(selected).toBe(primary);
  });

  it('returns null when no route matches the category', () => {
    const transport = new MockEmailTransport('primary');
    const selector = new ProviderRouteSelector([
      { id: 'r1', transport, priority: 1, isFallback: false, allowedCategories: ['bulk'] },
    ]);
    expect(selector.select('transactional')).toBeNull();
  });

  it('returns fallbacks sorted by priority', () => {
    const fb1 = new MockEmailTransport('fb1');
    const fb2 = new MockEmailTransport('fb2');
    const selector = new ProviderRouteSelector([
      {
        id: 'fb2',
        transport: fb2,
        priority: 2,
        isFallback: true,
        allowedCategories: ['transactional'],
      },
      {
        id: 'fb1',
        transport: fb1,
        priority: 1,
        isFallback: true,
        allowedCategories: ['transactional'],
      },
    ]);
    const fallbacks = selector.getFallbacks('transactional');
    expect(fallbacks[0]).toBe(fb1);
    expect(fallbacks[1]).toBe(fb2);
  });

  it('excludes fallbacks for categories not in allowedCategories', () => {
    const fb = new MockEmailTransport('fb');
    const selector = new ProviderRouteSelector([
      { id: 'fb', transport: fb, priority: 1, isFallback: true, allowedCategories: ['bulk'] },
    ]);
    expect(selector.getFallbacks('transactional')).toHaveLength(0);
  });
});

describe('FallbackEmailTransport', () => {
  it('sends via primary when it succeeds', async () => {
    const primary = new MockEmailTransport('primary');
    const fallback = new MockEmailTransport('fallback');
    const transport = new FallbackEmailTransport(primary, [fallback]);
    const result = await transport.send(baseInput());
    expect(result.provider).toBe('primary');
    expect(result.status).toBe('accepted');
  });

  it('falls back to secondary when primary fails', async () => {
    const primary = new MockEmailTransport('primary', true);
    const fallback = new MockEmailTransport('fallback');
    const transport = new FallbackEmailTransport(primary, [fallback]);
    const result = await transport.send(baseInput());
    expect(result.provider).toBe('fallback');
    expect(result.status).toBe('accepted');
    expect(result.attemptedFallbackProviders).toContain('primary');
  });

  it('preserves the normalized terminal failure when all providers reject', async () => {
    const primary = new MockEmailTransport('primary', true);
    const fallback = new MockEmailTransport('fallback', true);
    const transport = new FallbackEmailTransport(primary, [fallback]);
    await expect(transport.send(baseInput())).rejects.toMatchObject({
      kind: 'validation',
      retryable: false,
    });
  });
});

describe('validateProviderFields', () => {
  it('validates supported fields for opencore_email_sdk', () => {
    const input = baseInput({
      tags: [{ name: 'type', value: 'order' }],
      metadata: { notificationType: 'transactional' },
    });
    const result = validateProviderFields(input, 'opencore_email_sdk');
    expect(result.valid).toBe(true);
    expect(result.unsupportedFields).toHaveLength(0);
  });

  it('does not flag attachments as unsupported for smtp', () => {
    const input = baseInput({
      attachments: [
        { filename: 'ticket.pdf', contentType: 'application/pdf', content: 'base64data' },
      ],
    });
    const result = validateProviderFields(input, 'smtp');
    expect(result.unsupportedFields).not.toContain('attachments');
  });

  it('flags unsupported metadata for smtp', () => {
    const input = baseInput();
    const result = validateProviderFields(input, 'smtp');
    expect(result.valid).toBe(false);
    expect(result.unsupportedFields).toContain('metadata');
  });

  it('flags unsupported tags for postmark', () => {
    const input = baseInput({
      tags: [{ name: 'type', value: 'order' }],
    });
    const result = validateProviderFields(input, 'postmark');
    expect(result.valid).toBe(false);
    expect(result.unsupportedFields).toContain('tags');
  });

  it('flags all special fields for unknown provider type', () => {
    const input = baseInput({
      tags: [{ name: 'type', value: 'order' }],
    });
    const result = validateProviderFields(input, 'unknown_provider');
    expect(result.valid).toBe(false);
    expect(result.unsupportedFields.length).toBeGreaterThan(0);
  });
});
