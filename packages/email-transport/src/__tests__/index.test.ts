import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CaptureEmailTransport,
  MockEmailTransport,
  FallbackEmailTransport,
  OpenCoreEmailSdkTransport,
  ResendEmailTransport,
  buildEmailTransport,
  createDefaultEmailTransport,
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

describe('CaptureEmailTransport', () => {
  let transport: CaptureEmailTransport;

  beforeEach(() => {
    transport = new CaptureEmailTransport();
  });

  it('should capture sent emails', async () => {
    const input = baseInput();
    const result = await transport.send(input);
    expect(result.status).toBe('accepted');
    expect(result.provider).toBe('capture');
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]).toBe(input);
  });

  it('should find emails by recipient', async () => {
    await transport.send(baseInput({ to: [{ email: 'a@example.com' }] }));
    await transport.send(baseInput({ to: [{ email: 'b@example.com' }] }));
    expect(transport.findByTo('a@example.com')).toHaveLength(1);
    expect(transport.findByTo('b@example.com')).toHaveLength(1);
  });

  it('should find emails by template key', async () => {
    await transport.send(baseInput({ templateKey: 'order-confirmed' }));
    await transport.send(baseInput({ templateKey: 'tickets-issued' }));
    expect(transport.findByTemplate('order-confirmed')).toHaveLength(1);
    expect(transport.findByTemplate('tickets-issued')).toHaveLength(1);
  });

  it('should reset captured emails', async () => {
    await transport.send(baseInput());
    transport.reset();
    expect(transport.sent).toHaveLength(0);
  });
});

describe('MockEmailTransport', () => {
  it('should succeed when not configured to fail', async () => {
    const transport = new MockEmailTransport('mock');
    const result = await transport.send(baseInput());
    expect(result.status).toBe('accepted');
    expect(result.provider).toBe('mock');
  });

  it('should fail when configured to fail', async () => {
    const transport = new MockEmailTransport('mock', true);
    await expect(transport.send(baseInput())).rejects.toThrow();
  });

  it('should toggle failure mode', async () => {
    const transport = new MockEmailTransport('mock', true);
    await expect(transport.send(baseInput())).rejects.toThrow();
    transport.setShouldFail(false);
    const result = await transport.send(baseInput());
    expect(result.status).toBe('accepted');
  });
});

describe('FallbackEmailTransport', () => {
  it('should use primary when it succeeds', async () => {
    const primary = new MockEmailTransport('primary');
    const fallback = new MockEmailTransport('fallback');
    const transport = new FallbackEmailTransport(primary, [fallback]);

    const result = await transport.send(baseInput());
    expect(result.provider).toBe('primary');
    expect(result.attemptedFallbackProviders).toEqual(['primary']);
  });

  it('should fallback when primary fails', async () => {
    const primary = new MockEmailTransport('primary', true);
    const fallback = new MockEmailTransport('fallback');
    const transport = new FallbackEmailTransport(primary, [fallback]);

    const result = await transport.send(baseInput());
    expect(result.provider).toBe('fallback');
    expect(result.attemptedFallbackProviders).toEqual(['primary', 'fallback']);
  });

  it('should fail when all providers fail', async () => {
    const primary = new MockEmailTransport('primary', true);
    const fallback = new MockEmailTransport('fallback', true);
    const transport = new FallbackEmailTransport(primary, [fallback]);

    const result = await transport.send(baseInput());
    expect(result.status).toBe('failed');
    expect(result.attemptedFallbackProviders).toEqual(['primary', 'fallback']);
  });

  it('should try multiple fallbacks in order', async () => {
    const primary = new MockEmailTransport('primary', true);
    const fb1 = new MockEmailTransport('fb1', true);
    const fb2 = new MockEmailTransport('fb2', false);
    const transport = new FallbackEmailTransport(primary, [fb1, fb2]);

    const result = await transport.send(baseInput());
    expect(result.provider).toBe('fb2');
    expect(result.attemptedFallbackProviders).toEqual(['primary', 'fb1', 'fb2']);
  });
});

describe('OpenCoreEmailSdkTransport', () => {
  it('should send and return normalized result', async () => {
    const transport = new OpenCoreEmailSdkTransport('cred_ref_1', 'event.com');
    const result = await transport.send(baseInput());
    expect(result.provider).toBe('opencore_email_sdk');
    expect(result.status).toBe('accepted');
    expect(result.providerMessageId).toMatch(/^ocs_/);
  });
});

describe('validateProviderFields', () => {
  it('should validate supported fields', () => {
    const input = baseInput({
      attachments: [
        { filename: 'ticket.pdf', contentType: 'application/pdf', content: 'base64data' },
      ],
    });
    const result = validateProviderFields(input, 'ses');
    expect(result.valid).toBe(true);
    expect(result.unsupportedFields).toHaveLength(0);
  });

  it('should flag unsupported attachment field for providers without attachment support', () => {
    const input = baseInput({
      attachments: [
        { filename: 'ticket.pdf', contentType: 'application/pdf', content: 'base64data' },
      ],
      metadata: { notificationType: 'transactional' },
    });
    // smtp supports attachments but not metadata/tags
    const result = validateProviderFields(input, 'smtp');
    expect(result.valid).toBe(false);
    expect(result.unsupportedFields).toContain('metadata');
  });

  it('should flag unsupported tags field', () => {
    const input = baseInput({
      tags: [{ name: 'campaign', value: 'summer' }],
    });
    const result = validateProviderFields(input, 'smtp');
    expect(result.valid).toBe(false);
    expect(result.unsupportedFields).toContain('tags');
  });

  it('should allow headers for resend', () => {
    const input = baseInput({
      headers: { 'X-Custom': 'value' },
    });
    const result = validateProviderFields(input, 'resend');
    expect(result.valid).toBe(true);
    expect(result.unsupportedFields).toHaveLength(0);
  });
});

describe('ResendEmailTransport', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  it('sends through the Resend emails API', async () => {
    vi.stubEnv('RESEND_API_KEY', 're_test_key');
    const fetchMock = vi.fn(async () => Response.json({ id: 'email_123' }, { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const transport = new ResendEmailTransport('RESEND_API_KEY');
    const result = await transport.send(
      baseInput({
        from: { email: 'onboarding@resend.dev', name: 'Tixkit' },
        text: 'Thanks',
        replyTo: { email: 'support@example.com' },
        tags: [{ name: 'template', value: 'order-confirmed' }],
        attachments: [
          {
            filename: 'ticket.pdf',
            contentType: 'application/pdf',
            content: 'cGRm',
            contentEncoding: 'base64',
          },
        ],
      }),
    );

    expect(result).toMatchObject({
      provider: 'resend',
      providerMessageId: 'email_123',
      status: 'accepted',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const [url, init] = call;
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer re_test_key',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'idem_1',
    });
    expect(JSON.parse(String(init.body))).toMatchObject({
      from: 'Tixkit <onboarding@resend.dev>',
      to: ['buyer@example.com'],
      subject: 'Your tickets are confirmed',
      html: '<h1>Thank you</h1>',
      text: 'Thanks',
      reply_to: 'support@example.com',
      tags: [{ name: 'template', value: 'order-confirmed' }],
      attachments: [
        {
          filename: 'ticket.pdf',
          content: 'cGRm',
          content_type: 'application/pdf',
        },
      ],
    });
  });

  it('throws when Resend rejects the message', async () => {
    vi.stubEnv('RESEND_API_KEY', 're_test_key');
    globalThis.fetch = vi.fn(async () =>
      Response.json({ message: 'Invalid from address', name: 'validation_error' }, { status: 422 }),
    ) as unknown as typeof fetch;

    const transport = new ResendEmailTransport('RESEND_API_KEY');
    await expect(transport.send(baseInput())).rejects.toThrow('Invalid from address');
  });
});

describe('buildEmailTransport', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns a Resend transport for provider_type resend', () => {
    vi.stubEnv('RESEND_API_KEY', 're_test_key');
    const transport = buildEmailTransport('resend', 'RESEND_API_KEY');
    expect(transport).toBeInstanceOf(ResendEmailTransport);
  });

  it('returns capture when provider is unknown and Resend is not configured', () => {
    vi.stubEnv('RESEND_API_KEY', '');
    const transport = buildEmailTransport('unknown', 'unused');
    expect(transport).toBeInstanceOf(CaptureEmailTransport);
  });
});

describe('createDefaultEmailTransport', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('prefers Resend when RESEND_API_KEY is set', () => {
    vi.stubEnv('RESEND_API_KEY', 're_test_key');
    expect(createDefaultEmailTransport()).toBeInstanceOf(ResendEmailTransport);
  });

  it('falls back to capture without RESEND_API_KEY', () => {
    vi.stubEnv('RESEND_API_KEY', '');
    expect(createDefaultEmailTransport()).toBeInstanceOf(CaptureEmailTransport);
  });
});
