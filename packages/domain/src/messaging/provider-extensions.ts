export const MESSAGING_PROVIDER_EXTENSION_CONTRACT_VERSION =
  'tixkit.messaging-provider/v1' as const;

export type MessagingProviderExtensionContractVersion =
  typeof MESSAGING_PROVIDER_EXTENSION_CONTRACT_VERSION;

export type MessagingProviderChannel = 'email' | 'sms';

export type MessagingProviderOperation = 'send' | 'delivery-webhook' | 'suppression-webhook';

export type MessagingProviderExtensionDescriptor = Readonly<{
  contractVersion: MessagingProviderExtensionContractVersion;
  providerType: string;
  displayName: string;
  channels: readonly MessagingProviderChannel[];
  operations: readonly MessagingProviderOperation[];
}>;

import type { EmailTransport, SendEmailResult, SendSmsResult, SmsTransport } from './index.js';

export type EmailProviderExtensionContext = Readonly<{
  credentialsRef: string;
  senderDomain?: string;
}>;

export type SmsProviderExtensionContext = Readonly<{
  credentialsRef: string;
}>;

export type MessagingProviderExtension = Readonly<{
  descriptor: MessagingProviderExtensionDescriptor;
  createEmail?: (
    context: EmailProviderExtensionContext,
  ) => EmailTransport & { providerName: string };
  createSms?: (context: SmsProviderExtensionContext) => SmsTransport & { providerName: string };
}>;

export type MessagingNotificationCategory = 'transactional' | 'bulk' | 'staff' | 'system';

export type MessagingProviderRoute<TTransport> = Readonly<{
  id: string;
  transport: TTransport;
  priority: number;
  isFallback: boolean;
  allowedCategories: readonly string[];
  rateLimitPerHour?: number;
}>;

export interface MessagingProviderRouteSelector<TTransport> {
  select(category: MessagingNotificationCategory): TTransport | null;
  getFallbacks(category: MessagingNotificationCategory): TTransport[];
}

export class IncompatibleMessagingProviderExtensionError extends Error {
  constructor(
    public readonly providerType: string,
    public readonly contractVersion: string,
  ) {
    super(
      `Messaging provider extension ${providerType} uses unsupported contract ${contractVersion}`,
    );
    this.name = 'IncompatibleMessagingProviderExtensionError';
  }
}

export class DuplicateMessagingProviderExtensionError extends Error {
  constructor(public readonly providerType: string) {
    super(`Messaging provider extension is already registered: ${providerType}`);
    this.name = 'DuplicateMessagingProviderExtensionError';
  }
}

export class MessagingProviderIdentityMismatchError extends Error {
  constructor() {
    super('Messaging provider extension returned an invalid provider identity');
    this.name = 'MessagingProviderIdentityMismatchError';
  }
}

export class InvalidMessagingProviderResultError extends Error {
  constructor() {
    super('Messaging provider extension returned an invalid result');
    this.name = 'InvalidMessagingProviderResultError';
  }
}

const PROVIDER_TYPE_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/u;
const CHANNELS = new Set<MessagingProviderChannel>(['email', 'sms']);
const OPERATIONS = new Set<MessagingProviderOperation>([
  'send',
  'delivery-webhook',
  'suppression-webhook',
]);

export function defineMessagingProviderExtension(
  descriptor: MessagingProviderExtensionDescriptor,
): MessagingProviderExtensionDescriptor {
  if (descriptor.contractVersion !== MESSAGING_PROVIDER_EXTENSION_CONTRACT_VERSION) {
    throw new IncompatibleMessagingProviderExtensionError(
      descriptor.providerType,
      descriptor.contractVersion,
    );
  }
  if (!PROVIDER_TYPE_PATTERN.test(descriptor.providerType)) {
    throw new TypeError('Messaging provider extension providerType must be lowercase snake_case');
  }
  if (!descriptor.displayName.trim()) {
    throw new TypeError('Messaging provider extension displayName is required');
  }
  if (
    descriptor.channels.length === 0 ||
    new Set(descriptor.channels).size !== descriptor.channels.length
  ) {
    throw new TypeError('Messaging provider extension channels must be non-empty and unique');
  }
  if (descriptor.channels.some((channel) => !CHANNELS.has(channel))) {
    throw new TypeError('Messaging provider extension contains an unsupported channel');
  }
  if (!descriptor.operations.includes('send')) {
    throw new TypeError('Messaging provider extension must declare the send operation');
  }
  if (
    descriptor.operations.length === 0 ||
    new Set(descriptor.operations).size !== descriptor.operations.length ||
    descriptor.operations.some((operation) => !OPERATIONS.has(operation))
  ) {
    throw new TypeError('Messaging provider extension operations must be supported and unique');
  }

  return Object.freeze({
    ...descriptor,
    displayName: descriptor.displayName.trim(),
    channels: Object.freeze([...descriptor.channels]),
    operations: Object.freeze([...descriptor.operations]),
  });
}

export function isMessagingProviderExtensionCompatible(
  descriptor: Pick<MessagingProviderExtensionDescriptor, 'contractVersion'>,
): boolean {
  return descriptor.contractVersion === MESSAGING_PROVIDER_EXTENSION_CONTRACT_VERSION;
}

export class MessagingProviderExtensionRegistry {
  private readonly extensions = new Map<string, MessagingProviderExtension>();

  register(extension: MessagingProviderExtension): () => void {
    const descriptor = defineMessagingProviderExtension(extension.descriptor);
    validateFactories(descriptor, extension);
    if (this.extensions.has(descriptor.providerType)) {
      throw new DuplicateMessagingProviderExtensionError(descriptor.providerType);
    }

    const registered = Object.freeze({ ...extension, descriptor });
    this.extensions.set(descriptor.providerType, registered);
    return () => {
      if (this.extensions.get(descriptor.providerType) === registered) {
        this.extensions.delete(descriptor.providerType);
      }
    };
  }

  discover(channel?: MessagingProviderChannel): MessagingProviderExtensionDescriptor[] {
    return [...this.extensions.values()]
      .map(({ descriptor }) => descriptor)
      .filter((descriptor) => !channel || descriptor.channels.includes(channel))
      .sort((left, right) => left.providerType.localeCompare(right.providerType));
  }

  createEmail(
    providerType: string,
    context: EmailProviderExtensionContext,
  ): (EmailTransport & { providerName: string }) | undefined {
    const extension = this.extensions.get(providerType);
    if (!extension?.createEmail) return undefined;
    return bindEmailProviderIdentity(
      extension.createEmail(context),
      extension.descriptor.providerType,
    );
  }

  createSms(
    providerType: string,
    context: SmsProviderExtensionContext,
  ): (SmsTransport & { providerName: string }) | undefined {
    const extension = this.extensions.get(providerType);
    if (!extension?.createSms) return undefined;
    return bindSmsProviderIdentity(extension.createSms(context), extension.descriptor.providerType);
  }
}

const messagingProviderExtensions = new MessagingProviderExtensionRegistry();

export function registerMessagingProviderExtension(
  extension: MessagingProviderExtension,
): () => void {
  return messagingProviderExtensions.register(extension);
}

export function discoverMessagingProviderExtensions(
  channel?: MessagingProviderChannel,
): MessagingProviderExtensionDescriptor[] {
  return messagingProviderExtensions.discover(channel);
}

export function createEmailProviderTransport(
  providerType: string,
  context: EmailProviderExtensionContext,
): (EmailTransport & { providerName: string }) | undefined {
  return messagingProviderExtensions.createEmail(providerType, context);
}

export function createSmsProviderTransport(
  providerType: string,
  context: SmsProviderExtensionContext,
): (SmsTransport & { providerName: string }) | undefined {
  return messagingProviderExtensions.createSms(providerType, context);
}

function validateFactories(
  descriptor: MessagingProviderExtensionDescriptor,
  extension: MessagingProviderExtension,
): void {
  const hasEmail = typeof extension.createEmail === 'function';
  const hasSms = typeof extension.createSms === 'function';
  if (descriptor.channels.includes('email') !== hasEmail) {
    throw new TypeError(
      `Messaging provider extension ${descriptor.providerType} email channel/factory mismatch`,
    );
  }
  if (descriptor.channels.includes('sms') !== hasSms) {
    throw new TypeError(
      `Messaging provider extension ${descriptor.providerType} SMS channel/factory mismatch`,
    );
  }
}

function validateTransportProviderName(
  transport: { providerName: string },
  expectedProvider: string,
): void {
  if (transport.providerName !== expectedProvider) {
    throw new MessagingProviderIdentityMismatchError();
  }
  try {
    Object.defineProperty(transport, 'providerName', {
      value: expectedProvider,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  } catch {
    throw new MessagingProviderIdentityMismatchError();
  }
}

function providerIdentityProxy<TTransport extends object, TResult>(
  transport: TTransport,
  expectedProvider: string,
  channel: MessagingProviderChannel,
  send: (...args: never[]) => Promise<unknown>,
): TTransport {
  return new Proxy(transport, {
    get(target, property) {
      if (property === 'providerName') return expectedProvider;
      if (property === 'send') {
        return async (...args: never[]) => {
          const result = await send(...args);
          return createProviderResultSnapshot(result, expectedProvider, channel) as TResult;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set(target, property, value, receiver) {
      if (property === 'providerName') return false;
      return Reflect.set(target, property, value, receiver);
    },
    defineProperty(target, property, attributes) {
      if (property === 'providerName') return false;
      return Reflect.defineProperty(target, property, attributes);
    },
    deleteProperty(target, property) {
      if (property === 'providerName') return false;
      return Reflect.deleteProperty(target, property);
    },
  });
}

function bindEmailProviderIdentity(
  transport: EmailTransport & { providerName: string },
  expectedProvider: string,
): EmailTransport & { providerName: string } {
  validateTransportProviderName(transport, expectedProvider);
  return providerIdentityProxy(
    transport,
    expectedProvider,
    'email',
    transport.send.bind(transport) as (...args: never[]) => Promise<unknown>,
  );
}

function bindSmsProviderIdentity(
  transport: SmsTransport & { providerName: string },
  expectedProvider: string,
): SmsTransport & { providerName: string } {
  validateTransportProviderName(transport, expectedProvider);
  return providerIdentityProxy(
    transport,
    expectedProvider,
    'sms',
    transport.send.bind(transport) as (...args: never[]) => Promise<unknown>,
  );
}

const EMAIL_RESULT_STATUSES = new Set([
  'accepted',
  'queued',
  'sent',
  'delivered',
  'bounced',
  'failed',
  'complained',
]);
const SMS_RESULT_STATUSES = new Set(['accepted', 'queued', 'sent', 'delivered', 'failed']);

function createProviderResultSnapshot(
  value: unknown,
  expectedProvider: string,
  channel: MessagingProviderChannel,
): SendEmailResult | SendSmsResult {
  if (!value || typeof value !== 'object') throw new InvalidMessagingProviderResultError();

  let deliveryId: unknown;
  let provider: unknown;
  let providerMessageId: unknown;
  let status: unknown;
  let attemptedFallbackProviders: unknown;
  let sentAt: unknown;
  try {
    const result = value as Record<string, unknown>;
    deliveryId = result.deliveryId;
    provider = result.provider;
    providerMessageId = result.providerMessageId;
    status = result.status;
    attemptedFallbackProviders = result.attemptedFallbackProviders;
    sentAt = result.sentAt;
  } catch {
    throw new InvalidMessagingProviderResultError();
  }

  if (provider !== expectedProvider) throw new MessagingProviderIdentityMismatchError();
  if (!isBoundedString(deliveryId, 128)) throw new InvalidMessagingProviderResultError();
  if (providerMessageId !== undefined && !isBoundedString(providerMessageId, 512)) {
    throw new InvalidMessagingProviderResultError();
  }
  const allowedStatuses = channel === 'email' ? EMAIL_RESULT_STATUSES : SMS_RESULT_STATUSES;
  if (typeof status !== 'string' || !allowedStatuses.has(status)) {
    throw new InvalidMessagingProviderResultError();
  }
  if (!Array.isArray(attemptedFallbackProviders)) {
    throw new InvalidMessagingProviderResultError();
  }
  const attempted: string[] = [];
  try {
    const attemptedCount = attemptedFallbackProviders.length;
    if (attemptedCount > 32) throw new InvalidMessagingProviderResultError();
    for (let index = 0; index < attemptedCount; index += 1) {
      const attemptedProvider = attemptedFallbackProviders[index];
      if (attemptedProvider !== expectedProvider) {
        throw new MessagingProviderIdentityMismatchError();
      }
      attempted.push(expectedProvider);
    }
  } catch (error) {
    if (error instanceof MessagingProviderIdentityMismatchError) throw error;
    throw new InvalidMessagingProviderResultError();
  }
  if (!isBoundedString(sentAt, 64) || Number.isNaN(Date.parse(sentAt))) {
    throw new InvalidMessagingProviderResultError();
  }

  return Object.freeze({
    deliveryId,
    provider: expectedProvider,
    ...(providerMessageId === undefined ? {} : { providerMessageId }),
    status,
    attemptedFallbackProviders: Object.freeze(attempted) as string[],
    sentAt,
  }) as SendEmailResult | SendSmsResult;
}

function isBoundedString(value: unknown, maximumLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximumLength;
}
