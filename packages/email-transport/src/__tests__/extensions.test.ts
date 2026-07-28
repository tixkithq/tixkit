import { describe, expect, it } from 'vitest';
import {
  InvalidMessagingProviderResultError,
  MESSAGING_PROVIDER_EXTENSION_CONTRACT_VERSION,
  type SendEmailInput,
  type SendEmailResult,
  type SendSmsInput,
  type SendSmsResult,
} from '@tixkit/domain/messaging';
import {
  buildEmailTransport,
  buildSmsTransport,
  CaptureEmailTransport,
  CaptureSmsTransport,
  discoverMessagingProviderExtensions,
  DuplicateMessagingProviderExtensionError,
  FallbackEmailTransport,
  FallbackSmsTransport,
  registerMessagingProviderExtension,
  ResendEmailTransport,
  TelnyxSmsTransport,
} from '../index.js';
import { ProviderOperationError } from '@tixkit/provider-clients';

describe('messaging provider extension registry', () => {
  it('discovers built-ins through immutable v1 descriptors', () => {
    const email = discoverMessagingProviderExtensions('email');
    const sms = discoverMessagingProviderExtensions('sms');

    expect(email.map(({ providerType }) => providerType)).toEqual(['capture', 'resend', 'smtp']);
    expect(sms.map(({ providerType }) => providerType)).toEqual([
      'capture',
      'plivo',
      'telnyx',
      'twilio',
      'vonage',
    ]);
    expect(
      [...email, ...sms].every(
        ({ contractVersion }) => contractVersion === MESSAGING_PROVIDER_EXTENSION_CONTRACT_VERSION,
      ),
    ).toBe(true);
  });

  it('registers, discovers, selects and unregisters an operator extension', async () => {
    const sent: Array<SendSmsInput> = [];
    const unregister = registerMessagingProviderExtension({
      descriptor: {
        contractVersion: MESSAGING_PROVIDER_EXTENSION_CONTRACT_VERSION,
        providerType: 'operator_sms',
        displayName: 'Operator SMS',
        channels: ['sms'],
        operations: ['send'],
      },
      createSms: () => ({
        providerName: 'operator_sms',
        async send(input: SendSmsInput): Promise<SendSmsResult> {
          sent.push(input);
          return {
            deliveryId: input.deliveryId,
            provider: 'operator_sms',
            providerMessageId: 'operator-message-1',
            status: 'accepted',
            attemptedFallbackProviders: [],
            sentAt: new Date().toISOString(),
          };
        },
      }),
    });

    try {
      expect(discoverMessagingProviderExtensions('sms')).toContainEqual(
        expect.objectContaining({ providerType: 'operator_sms' }),
      );
      const transport = buildSmsTransport('operator_sms', 'OPERATOR_SMS_SECRET');
      await transport.send({
        tenantId: 'tnt_1',
        organizationId: 'org_1',
        brandId: 'brd_1',
        jobId: 'smj_1',
        deliveryId: 'smd_1',
        from: '+15550000001',
        to: '+15550000002',
        body: 'Tixkit update',
        providerRouteId: 'spr_1',
        idempotencyKey: 'extension:test',
        notificationType: 'transactional',
      });
      expect(sent).toHaveLength(1);
    } finally {
      unregister();
    }

    expect(discoverMessagingProviderExtensions('sms')).not.toContainEqual(
      expect.objectContaining({ providerType: 'operator_sms' }),
    );
    expect(() => buildSmsTransport('operator_sms', 'OPERATOR_SMS_SECRET')).toThrow(
      /Unsupported sms provider route/u,
    );
  });

  it('supports an operator email extension without weakening provider identity', async () => {
    const unregister = registerMessagingProviderExtension({
      descriptor: {
        contractVersion: MESSAGING_PROVIDER_EXTENSION_CONTRACT_VERSION,
        providerType: 'operator_email',
        displayName: 'Operator Email',
        channels: ['email'],
        operations: ['send'],
      },
      createEmail: () => ({
        providerName: 'operator_email',
        async send(input: SendEmailInput): Promise<SendEmailResult> {
          return {
            deliveryId: input.deliveryId,
            provider: 'operator_email',
            providerMessageId: 'operator-email-1',
            status: 'accepted',
            attemptedFallbackProviders: [],
            sentAt: new Date().toISOString(),
          };
        },
      }),
    });

    try {
      expect(buildEmailTransport('operator_email', 'OPERATOR_EMAIL_SECRET')).toMatchObject({
        providerName: 'operator_email',
      });
    } finally {
      unregister();
    }
  });

  it('rejects duplicate providers and channel/factory substitution', () => {
    expect(() =>
      registerMessagingProviderExtension({
        descriptor: {
          contractVersion: MESSAGING_PROVIDER_EXTENSION_CONTRACT_VERSION,
          providerType: 'resend',
          displayName: 'Substituted Resend',
          channels: ['email'],
          operations: ['send'],
        },
        createEmail: () => ({
          providerName: 'resend',
          send: async () => ({}) as never,
        }),
      }),
    ).toThrow(DuplicateMessagingProviderExtensionError);

    expect(() =>
      registerMessagingProviderExtension({
        descriptor: {
          contractVersion: MESSAGING_PROVIDER_EXTENSION_CONTRACT_VERSION,
          providerType: 'mismatched_sms',
          displayName: 'Mismatched SMS',
          channels: ['sms'],
          operations: ['send'],
        },
        createEmail: () => ({
          providerName: 'mismatched_sms',
          send: async () => ({}) as never,
        }),
      }),
    ).toThrow(/channel\/factory mismatch/u);
  });

  it('preserves built-in prototypes while binding their provider identity', () => {
    expect(buildEmailTransport('resend', 'RESEND_API_KEY')).toBeInstanceOf(ResendEmailTransport);
    expect(buildSmsTransport('telnyx', 'TELNYX_API_KEY')).toBeInstanceOf(TelnyxSmsTransport);
  });

  it.each(['email', 'sms'] as const)(
    'rejects a %s extension whose transport providerName differs from its descriptor',
    (channel) => {
      const providerType = `spoofed_${channel}_name`;
      const unregister = registerMessagingProviderExtension({
        descriptor: {
          contractVersion: MESSAGING_PROVIDER_EXTENSION_CONTRACT_VERSION,
          providerType,
          displayName: 'Spoofed name',
          channels: [channel],
          operations: ['send'],
        },
        ...(channel === 'email'
          ? {
              createEmail: () => ({
                providerName: 'attacker',
                send: async () => ({}) as never,
              }),
            }
          : {
              createSms: () => ({
                providerName: 'attacker',
                send: async () => ({}) as never,
              }),
            }),
      });
      try {
        expect(() =>
          channel === 'email'
            ? buildEmailTransport(providerType, 'SECRET')
            : buildSmsTransport(providerType, 'SECRET'),
        ).toThrow('Messaging provider extension returned an invalid provider identity');
      } finally {
        unregister();
      }
    },
  );

  it.each(['email', 'sms'] as const)(
    'fails closed when a %s extension send result spoofs another provider',
    async (channel) => {
      const providerType = `spoofed_${channel}_result`;
      const result = {
        deliveryId: 'delivery_1',
        provider: 'attacker',
        providerMessageId: 'message_1',
        status: 'accepted' as const,
        attemptedFallbackProviders: [],
        sentAt: new Date().toISOString(),
      };
      const unregister = registerMessagingProviderExtension({
        descriptor: {
          contractVersion: MESSAGING_PROVIDER_EXTENSION_CONTRACT_VERSION,
          providerType,
          displayName: 'Spoofed result',
          channels: [channel],
          operations: ['send'],
        },
        ...(channel === 'email'
          ? { createEmail: () => ({ providerName: providerType, send: async () => result }) }
          : { createSms: () => ({ providerName: providerType, send: async () => result }) }),
      });
      try {
        const transport =
          channel === 'email'
            ? buildEmailTransport(providerType, 'SECRET')
            : buildSmsTransport(providerType, 'SECRET');
        await expect(transport.send({} as never)).rejects.toThrow(
          'Messaging provider extension returned an invalid provider identity',
        );
      } finally {
        unregister();
      }
    },
  );

  it.each(['email', 'sms'] as const)(
    'locks %s provider identity against accessor and property mutation through fallback audit',
    async (channel) => {
      const providerType = `locked_${channel}`;
      let accessorValue = providerType;
      const target = {
        get providerName() {
          return accessorValue;
        },
        async send(): Promise<never> {
          throw new ProviderOperationError(
            'safe failure',
            providerType,
            'send',
            'transport',
            true,
            'not-sent',
            true,
          );
        },
      };
      const unregister = registerMessagingProviderExtension({
        descriptor: {
          contractVersion: MESSAGING_PROVIDER_EXTENSION_CONTRACT_VERSION,
          providerType,
          displayName: 'Locked identity',
          channels: [channel],
          operations: ['send'],
        },
        ...(channel === 'email' ? { createEmail: () => target } : { createSms: () => target }),
      });

      try {
        if (channel === 'email') {
          const transport = buildEmailTransport(providerType, 'SECRET');
          accessorValue = 'spoofed_accessor';
          expect(Reflect.set(target, 'providerName', 'spoofed_target')).toBe(false);
          expect(Reflect.set(transport, 'providerName', 'spoofed_proxy')).toBe(false);
          expect(
            Reflect.defineProperty(transport, 'providerName', { value: 'spoofed_define' }),
          ).toBe(false);
          expect(Reflect.deleteProperty(transport, 'providerName')).toBe(false);
          expect(transport.providerName).toBe(providerType);
          const result = await new FallbackEmailTransport(transport, [
            new CaptureEmailTransport(),
          ]).send({ deliveryId: 'delivery_1' } as SendEmailInput);
          expect(result.attemptedFallbackProviders).toEqual([providerType, 'capture']);
        } else {
          const transport = buildSmsTransport(providerType, 'SECRET');
          accessorValue = 'spoofed_accessor';
          expect(Reflect.set(target, 'providerName', 'spoofed_target')).toBe(false);
          expect(Reflect.set(transport, 'providerName', 'spoofed_proxy')).toBe(false);
          expect(
            Reflect.defineProperty(transport, 'providerName', { value: 'spoofed_define' }),
          ).toBe(false);
          expect(Reflect.deleteProperty(transport, 'providerName')).toBe(false);
          expect(transport.providerName).toBe(providerType);
          const result = await new FallbackSmsTransport(transport, [
            new CaptureSmsTransport(),
          ]).send({ deliveryId: 'delivery_1' } as SendSmsInput);
          expect(result.attemptedFallbackProviders).toEqual([providerType, 'capture']);
        }
      } finally {
        unregister();
      }
    },
  );

  it.each(['sk_live_DO_NOT_EXPOSE_123456', 'attacker\nInjected: secret', 'x'.repeat(10_000)])(
    'never reflects an untrusted provider identity in mismatch errors',
    async (actualProvider) => {
      const unregister = registerMessagingProviderExtension({
        descriptor: {
          contractVersion: MESSAGING_PROVIDER_EXTENSION_CONTRACT_VERSION,
          providerType: 'safe_error',
          displayName: 'Safe Error',
          channels: ['email'],
          operations: ['send'],
        },
        createEmail: () => ({
          providerName: 'safe_error',
          async send() {
            return {
              deliveryId: 'delivery_1',
              provider: actualProvider,
              providerMessageId: 'message_1',
              status: 'accepted' as const,
              attemptedFallbackProviders: [],
              sentAt: new Date().toISOString(),
            };
          },
        }),
      });
      try {
        const transport = buildEmailTransport('safe_error', 'SECRET');
        const error = await transport.send({} as never).catch((cause: unknown) => cause);
        expect(error).toMatchObject({
          message: 'Messaging provider extension returned an invalid provider identity',
        });
        expect(String(error)).not.toContain(actualProvider);
        expect(String(error).length).toBeLessThan(128);
      } finally {
        unregister();
      }
    },
  );

  it.each(['sk_live_DO_NOT_EXPOSE_123456', 'attacker\nInjected: secret', 'x'.repeat(10_000)])(
    'never reflects an untrusted transport identity in mismatch errors',
    (actualProvider) => {
      const unregister = registerMessagingProviderExtension({
        descriptor: {
          contractVersion: MESSAGING_PROVIDER_EXTENSION_CONTRACT_VERSION,
          providerType: 'safe_factory_error',
          displayName: 'Safe Factory Error',
          channels: ['sms'],
          operations: ['send'],
        },
        createSms: () => ({
          providerName: actualProvider,
          send: async () => ({}) as never,
        }),
      });
      try {
        let error: unknown;
        try {
          buildSmsTransport('safe_factory_error', 'SECRET');
        } catch (cause) {
          error = cause;
        }
        expect(error).toMatchObject({
          message: 'Messaging provider extension returned an invalid provider identity',
        });
        expect(String(error)).not.toContain(actualProvider);
        expect(String(error).length).toBeLessThan(128);
      } finally {
        unregister();
      }
    },
  );

  it.each(['email', 'sms'] as const)(
    'returns an owned immutable %s result snapshot from an accessor-controlled extension',
    async (channel) => {
      const providerType = `snapshot_${channel}`;
      let providerReads = 0;
      let arbitraryGetterReads = 0;
      const attempted = [providerType];
      const rawResult = {
        deliveryId: 'delivery_1',
        get provider() {
          providerReads += 1;
          return providerReads === 1 ? providerType : 'attacker';
        },
        providerMessageId: 'message_1',
        status: 'accepted' as const,
        attemptedFallbackProviders: attempted,
        sentAt: new Date().toISOString(),
        get arbitraryExtensionField() {
          arbitraryGetterReads += 1;
          throw new Error('must not be copied');
        },
      };
      const transportTarget = {
        providerName: providerType,
        async send() {
          return rawResult;
        },
      };
      const unregister = registerMessagingProviderExtension({
        descriptor: {
          contractVersion: MESSAGING_PROVIDER_EXTENSION_CONTRACT_VERSION,
          providerType,
          displayName: 'Snapshot result',
          channels: [channel],
          operations: ['send'],
        },
        ...(channel === 'email'
          ? { createEmail: () => transportTarget }
          : { createSms: () => transportTarget }),
      });

      try {
        const result =
          channel === 'email'
            ? await buildEmailTransport(providerType, 'SECRET').send({} as never)
            : await buildSmsTransport(providerType, 'SECRET').send({} as never);
        rawResult.deliveryId = 'mutated_delivery';
        attempted[0] = 'mutated_attempt';
        attempted.push('another_attempt');

        expect(providerReads).toBe(1);
        expect(arbitraryGetterReads).toBe(0);
        expect(result).toEqual({
          deliveryId: 'delivery_1',
          provider: providerType,
          providerMessageId: 'message_1',
          status: 'accepted',
          attemptedFallbackProviders: [providerType],
          sentAt: rawResult.sentAt,
        });
        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(result.attemptedFallbackProviders)).toBe(true);
        expect(Reflect.set(result, 'provider', 'attacker')).toBe(false);
        expect(() => result.attemptedFallbackProviders.push('attacker')).toThrow();
      } finally {
        unregister();
      }
    },
  );

  it.each([
    { field: 'deliveryId', value: 42 },
    { field: 'providerMessageId', value: { secret: true } },
    { field: 'status', value: 'unknown' },
    { field: 'attemptedFallbackProviders', value: 'snapshot_email' },
    { field: 'sentAt', value: 'not-a-date' },
  ])('rejects an invalid required result field: $field', async ({ field, value }) => {
    const result: Record<string, unknown> = {
      deliveryId: 'delivery_1',
      provider: 'snapshot_validation',
      providerMessageId: 'message_1',
      status: 'accepted',
      attemptedFallbackProviders: [],
      sentAt: new Date().toISOString(),
      [field]: value,
    };
    const unregister = registerMessagingProviderExtension({
      descriptor: {
        contractVersion: MESSAGING_PROVIDER_EXTENSION_CONTRACT_VERSION,
        providerType: 'snapshot_validation',
        displayName: 'Snapshot validation',
        channels: ['email'],
        operations: ['send'],
      },
      createEmail: () => ({
        providerName: 'snapshot_validation',
        send: async () => result as never,
      }),
    });
    try {
      await expect(
        buildEmailTransport('snapshot_validation', 'SECRET').send({} as never),
      ).rejects.toBeInstanceOf(InvalidMessagingProviderResultError);
    } finally {
      unregister();
    }
  });
});
