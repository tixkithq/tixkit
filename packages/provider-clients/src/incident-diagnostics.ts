import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm' as const;
const PURPOSE = 'tixkit.provider-incident-request-id';
const FORMAT_VERSION = 1 as const;
const KEYRING_VERSION = 1 as const;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const KEY_BYTES = 32;
const MAX_REQUEST_ID_BYTES = 255;
const MAX_IDENTIFIER_BYTES = 128;
const MAX_KEY_ID_BYTES = 64;
const MIN_RETENTION_MS = 60 * 1_000;
const MAX_RETENTION_MS = 24 * 60 * 60 * 1_000;
const MIN_TIMESTAMP_MS = Date.UTC(2000, 0, 1);
const MAX_TIMESTAMP_MS = Date.UTC(2100, 0, 1);
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:/-]*[A-Za-z0-9])?$/u;
const KEY_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u;
const PRINTABLE_ASCII_PATTERN = /^[\x21-\x7e]+$/u;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;

export const INCIDENT_DIAGNOSTIC_MAX_RETENTION_MS = MAX_RETENTION_MS;

export interface IncidentDiagnosticKeyring {
  readonly purpose: 'tixkit.provider-incident-request-id';
  readonly version: 1;
  readonly activeKeyId: string;
  readonly keys: Readonly<Record<string, Uint8Array>>;
}

export interface IncidentDiagnosticContext {
  readonly evidenceId: string;
  readonly tenantId: string;
  readonly organizationId: string;
  readonly dependency: string;
  readonly operation: string;
  readonly capturedAt: number;
  readonly expiresAt: number;
}

export interface IncidentDiagnosticBinding extends IncidentDiagnosticContext {
  readonly requestIdHash: string;
}

export interface EncryptedProviderRequestId {
  readonly version: 1;
  readonly algorithm: 'aes-256-gcm';
  readonly keyId: string;
  readonly binding: IncidentDiagnosticBinding;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly authenticationTag: string;
}

export interface IncidentDiagnosticDecryptOptions {
  readonly now?: number;
}

export class IncidentDiagnosticValidationError extends Error {
  readonly name = 'IncidentDiagnosticValidationError';
}

export class IncidentDiagnosticDecryptionError extends Error {
  readonly name = 'IncidentDiagnosticDecryptionError';

  constructor() {
    super('Incident diagnostic could not be decrypted');
  }
}

export function validateExactProviderRequestId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > MAX_REQUEST_ID_BYTES ||
    !PRINTABLE_ASCII_PATTERN.test(value)
  ) {
    throw new IncidentDiagnosticValidationError(
      'Provider request ID must be bounded printable ASCII without whitespace',
    );
  }
  return value;
}

export function hashExactProviderRequestId(value: unknown): string {
  const requestId = validateExactProviderRequestId(value);
  return `sha256:${createHash('sha256').update(requestId, 'ascii').digest('hex')}`;
}

export function encryptExactProviderRequestId(
  requestIdValue: unknown,
  contextValue: IncidentDiagnosticContext,
  keyringValue: IncidentDiagnosticKeyring,
): EncryptedProviderRequestId {
  const requestId = validateExactProviderRequestId(requestIdValue);
  const context = validateContext(contextValue);
  const keyring = validateKeyring(keyringValue);
  const keyId = keyring.activeKeyId;
  const key = keyring.keys[keyId];
  if (!key) throw new IncidentDiagnosticValidationError('Active incident diagnostic key is absent');

  const binding = Object.freeze({
    ...context,
    requestIdHash: hashExactProviderRequestId(requestId),
  });
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce, { authTagLength: AUTH_TAG_BYTES });
  cipher.setAAD(bindingAad(binding));
  const ciphertext = Buffer.concat([cipher.update(requestId, 'ascii'), cipher.final()]);
  const authenticationTag = cipher.getAuthTag();

  return Object.freeze({
    version: FORMAT_VERSION,
    algorithm: ALGORITHM,
    keyId,
    binding,
    nonce: nonce.toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
    authenticationTag: authenticationTag.toString('base64url'),
  });
}

export function decryptExactProviderRequestId(
  encryptedValue: EncryptedProviderRequestId,
  expectedBindingValue: IncidentDiagnosticBinding,
  keyringValue: IncidentDiagnosticKeyring,
  options: IncidentDiagnosticDecryptOptions = {},
): string {
  try {
    const encrypted = validateEncryptedValue(encryptedValue);
    const expectedBinding = validateBinding(expectedBindingValue);
    const keyring = validateKeyring(keyringValue);
    const now = validateTimestamp('now', options.now ?? Date.now());
    if (now > expectedBinding.expiresAt) throw new IncidentDiagnosticDecryptionError();
    if (!bindingsEqual(encrypted.binding, expectedBinding)) {
      throw new IncidentDiagnosticDecryptionError();
    }

    const key = keyring.keys[encrypted.keyId];
    if (!key) throw new IncidentDiagnosticDecryptionError();
    const nonce = decodeBase64Url(encrypted.nonce, NONCE_BYTES);
    const authenticationTag = decodeBase64Url(encrypted.authenticationTag, AUTH_TAG_BYTES);
    const ciphertext = decodeBase64Url(encrypted.ciphertext);
    if (ciphertext.byteLength === 0 || ciphertext.byteLength > MAX_REQUEST_ID_BYTES) {
      throw new IncidentDiagnosticDecryptionError();
    }

    const decipher = createDecipheriv(ALGORITHM, key, nonce, { authTagLength: AUTH_TAG_BYTES });
    decipher.setAAD(bindingAad(expectedBinding));
    decipher.setAuthTag(authenticationTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
      'ascii',
    );
    const requestId = validateExactProviderRequestId(plaintext);
    if (hashExactProviderRequestId(requestId) !== expectedBinding.requestIdHash) {
      throw new IncidentDiagnosticDecryptionError();
    }
    return requestId;
  } catch (error) {
    if (error instanceof IncidentDiagnosticDecryptionError) throw error;
    throw new IncidentDiagnosticDecryptionError();
  }
}

function validateKeyring(value: IncidentDiagnosticKeyring): IncidentDiagnosticKeyring {
  if (!value || typeof value !== 'object' || value.purpose !== PURPOSE || value.version !== 1) {
    throw new IncidentDiagnosticValidationError('Invalid incident diagnostic keyring');
  }
  const activeKeyId = validateKeyId(value.activeKeyId);
  if (!value.keys || typeof value.keys !== 'object' || Array.isArray(value.keys)) {
    throw new IncidentDiagnosticValidationError('Incident diagnostic keys must be a key map');
  }
  const entries = Object.entries(value.keys);
  if (entries.length === 0) {
    throw new IncidentDiagnosticValidationError('Incident diagnostic keyring must contain a key');
  }
  for (const [keyId, key] of entries) {
    validateKeyId(keyId);
    if (!(key instanceof Uint8Array) || key.byteLength !== KEY_BYTES) {
      throw new IncidentDiagnosticValidationError('Incident diagnostic keys must be 32 bytes');
    }
  }
  if (!Object.hasOwn(value.keys, activeKeyId)) {
    throw new IncidentDiagnosticValidationError('Active incident diagnostic key is absent');
  }
  return value;
}

function validateContext(value: IncidentDiagnosticContext): IncidentDiagnosticContext {
  if (!value || typeof value !== 'object') {
    throw new IncidentDiagnosticValidationError('Invalid incident diagnostic context');
  }
  const context = {
    evidenceId: validateIdentifier('evidenceId', value.evidenceId),
    tenantId: validateIdentifier('tenantId', value.tenantId),
    organizationId: validateIdentifier('organizationId', value.organizationId),
    dependency: validateIdentifier('dependency', value.dependency),
    operation: validateIdentifier('operation', value.operation),
    capturedAt: validateTimestamp('capturedAt', value.capturedAt),
    expiresAt: validateTimestamp('expiresAt', value.expiresAt),
  };
  const retentionMs = context.expiresAt - context.capturedAt;
  if (retentionMs < MIN_RETENTION_MS || retentionMs > MAX_RETENTION_MS) {
    throw new IncidentDiagnosticValidationError(
      'Incident diagnostic retention must be between one minute and 24 hours',
    );
  }
  return Object.freeze(context);
}

function validateBinding(value: IncidentDiagnosticBinding): IncidentDiagnosticBinding {
  const context = validateContext(value);
  if (typeof value.requestIdHash !== 'string' || !HASH_PATTERN.test(value.requestIdHash)) {
    throw new IncidentDiagnosticValidationError('Invalid provider request ID hash');
  }
  return Object.freeze({ ...context, requestIdHash: value.requestIdHash });
}

function validateEncryptedValue(value: EncryptedProviderRequestId): EncryptedProviderRequestId {
  if (
    !value ||
    typeof value !== 'object' ||
    value.version !== FORMAT_VERSION ||
    value.algorithm !== ALGORITHM
  ) {
    throw new IncidentDiagnosticValidationError('Invalid incident diagnostic ciphertext');
  }
  validateKeyId(value.keyId);
  const binding = validateBinding(value.binding);
  if (
    typeof value.nonce !== 'string' ||
    typeof value.ciphertext !== 'string' ||
    typeof value.authenticationTag !== 'string'
  ) {
    throw new IncidentDiagnosticValidationError('Invalid incident diagnostic ciphertext encoding');
  }
  return { ...value, binding };
}

function validateIdentifier(name: string, value: unknown): string {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value, 'utf8') > MAX_IDENTIFIER_BYTES ||
    !IDENTIFIER_PATTERN.test(value)
  ) {
    throw new IncidentDiagnosticValidationError(`Invalid incident diagnostic ${name}`);
  }
  return value;
}

function validateKeyId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value, 'utf8') > MAX_KEY_ID_BYTES ||
    !KEY_ID_PATTERN.test(value)
  ) {
    throw new IncidentDiagnosticValidationError('Invalid incident diagnostic key ID');
  }
  return value;
}

function validateTimestamp(name: string, value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < MIN_TIMESTAMP_MS ||
    value > MAX_TIMESTAMP_MS
  ) {
    throw new IncidentDiagnosticValidationError(`Invalid incident diagnostic ${name}`);
  }
  return value;
}

function bindingAad(binding: IncidentDiagnosticBinding): Buffer {
  return Buffer.from(
    JSON.stringify([
      PURPOSE,
      FORMAT_VERSION,
      binding.evidenceId,
      binding.tenantId,
      binding.organizationId,
      binding.dependency,
      binding.operation,
      binding.requestIdHash,
      binding.capturedAt,
      binding.expiresAt,
    ]),
    'utf8',
  );
}

function bindingsEqual(left: IncidentDiagnosticBinding, right: IncidentDiagnosticBinding): boolean {
  return (
    left.evidenceId === right.evidenceId &&
    left.tenantId === right.tenantId &&
    left.organizationId === right.organizationId &&
    left.dependency === right.dependency &&
    left.operation === right.operation &&
    left.requestIdHash === right.requestIdHash &&
    left.capturedAt === right.capturedAt &&
    left.expiresAt === right.expiresAt
  );
}

function decodeBase64Url(value: string, expectedBytes?: number): Buffer {
  if (!BASE64URL_PATTERN.test(value)) throw new IncidentDiagnosticDecryptionError();
  const decoded = Buffer.from(value, 'base64url');
  if (
    decoded.toString('base64url') !== value ||
    decoded.byteLength !== (expectedBytes ?? decoded.byteLength)
  ) {
    throw new IncidentDiagnosticDecryptionError();
  }
  return decoded;
}

export function createIncidentDiagnosticKeyring(
  activeKeyId: string,
  keys: Readonly<Record<string, Uint8Array>>,
): IncidentDiagnosticKeyring {
  const keyring: IncidentDiagnosticKeyring = {
    purpose: PURPOSE,
    version: KEYRING_VERSION,
    activeKeyId,
    keys,
  };
  validateKeyring(keyring);
  return Object.freeze(keyring);
}
