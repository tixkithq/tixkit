import { describe, expect, it } from 'vitest';
import { CaptureSmsTransport, FallbackSmsTransport, TelnyxSmsTransport } from './index.js';
import type { SendSmsInput, SendSmsResult, SmsTransport } from '@tixkit/domain/messaging';

const smsInput: SendSmsInput = {
  tenantId: 'tnt_1',
  organizationId: 'org_1',
  brandId: 'brd_1',
  jobId: 'smj_1',
  deliveryId: 'smd_1',
  from: '+15550000001',
  to: '+15550000002',
  body: 'Tixkit update',
  providerRouteId: 'spr_1',
  idempotencyKey: 'sms:test',
  notificationType: 'bulk',
};

class FailingSmsTransport implements SmsTransport {
  providerName = 'failing';

  async send(): Promise<SendSmsResult> {
    throw new Error('failed');
  }
}

class ExtensionSmsTransport implements SmsTransport {
  providerName = 'operator-extension';

  async send(input: SendSmsInput): Promise<SendSmsResult> {
    return {
      deliveryId: input.deliveryId,
      provider: this.providerName,
      providerMessageId: 'extension-message-1',
      status: 'accepted',
      attemptedFallbackProviders: [],
      sentAt: new Date().toISOString(),
    };
  }
}

describe('SMS transports', () => {
  it('captures SMS sends without network calls', async () => {
    const transport = new CaptureSmsTransport();

    const result = await transport.send(smsInput);

    expect(result.provider).toBe('capture');
    expect(result.status).toBe('accepted');
    expect(transport.findByTo('+15550000002')).toHaveLength(1);
  });

  it('falls back when the primary SMS transport fails', async () => {
    const fallback = new CaptureSmsTransport();
    const transport = new FallbackSmsTransport(new FailingSmsTransport(), [fallback]);

    const result = await transport.send(smsInput);

    expect(result.provider).toBe('capture');
    expect(result.attemptedFallbackProviders).toEqual(['failing', 'capture']);
  });

  it('preserves third-party provider identity through fallback execution', async () => {
    const transport = new FallbackSmsTransport(new FailingSmsTransport(), [
      new ExtensionSmsTransport(),
    ]);

    const result = await transport.send(smsInput);

    expect(result.provider).toBe('operator-extension');
    expect(result.attemptedFallbackProviders).toEqual(['failing', 'operator-extension']);
  });

  it('builds a Telnyx send request using the Messages API shape', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ id: 'telnyx_msg_1' }), { status: 200 });
    }) as typeof fetch;

    try {
      const transport = new TelnyxSmsTransport('test_api_key', 'https://api.telnyx.test/v2');
      const result = await transport.send(smsInput);

      expect(result.provider).toBe('telnyx');
      expect(result.providerMessageId).toBe('telnyx_msg_1');
      expect(calls[0].url).toBe('https://api.telnyx.test/v2/messages');
      expect(JSON.parse(String(calls[0].init.body))).toMatchObject({
        from: { phone_number: '+15550000001' },
        to: [{ phone_number: '+15550000002' }],
        text: 'Tixkit update',
        type: 'SMS',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
