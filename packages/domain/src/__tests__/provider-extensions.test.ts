import { describe, expect, it } from 'vitest';
import {
  defineMessagingProviderExtension,
  IncompatibleMessagingProviderExtensionError,
  isMessagingProviderExtensionCompatible,
  MESSAGING_PROVIDER_EXTENSION_CONTRACT_VERSION,
} from '../messaging/provider-extensions.js';

describe('messaging provider extension contract', () => {
  it('normalizes and freezes a compatible descriptor', () => {
    const descriptor = defineMessagingProviderExtension({
      contractVersion: MESSAGING_PROVIDER_EXTENSION_CONTRACT_VERSION,
      providerType: 'operator_sms',
      displayName: ' Operator SMS ',
      channels: ['sms'],
      operations: ['send', 'delivery-webhook'],
    });

    expect(descriptor).toEqual({
      contractVersion: 'tixkit.messaging-provider/v1',
      providerType: 'operator_sms',
      displayName: 'Operator SMS',
      channels: ['sms'],
      operations: ['send', 'delivery-webhook'],
    });
    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(Object.isFrozen(descriptor.channels)).toBe(true);
    expect(isMessagingProviderExtensionCompatible(descriptor)).toBe(true);
  });

  it('rejects unknown contract versions', () => {
    expect(() =>
      defineMessagingProviderExtension({
        contractVersion: 'tixkit.messaging-provider/v2',
        providerType: 'operator_sms',
        displayName: 'Operator SMS',
        channels: ['sms'],
        operations: ['send'],
      } as never),
    ).toThrow(IncompatibleMessagingProviderExtensionError);
  });

  it.each([
    [{ providerType: 'Operator-SMS' }, /lowercase snake_case/u],
    [{ displayName: '   ' }, /displayName is required/u],
    [{ channels: [] }, /channels must be non-empty and unique/u],
    [{ channels: ['sms', 'sms'] }, /channels must be non-empty and unique/u],
    [{ operations: ['delivery-webhook'] }, /must declare the send operation/u],
    [{ operations: ['send', 'send'] }, /operations must be supported and unique/u],
  ])('rejects an invalid descriptor override', (override, expected) => {
    expect(() =>
      defineMessagingProviderExtension({
        contractVersion: MESSAGING_PROVIDER_EXTENSION_CONTRACT_VERSION,
        providerType: 'operator_sms',
        displayName: 'Operator SMS',
        channels: ['sms'],
        operations: ['send'],
        ...override,
      } as never),
    ).toThrow(expected);
  });
});
