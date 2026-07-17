import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  randomBytes,
} from 'node:crypto';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { GetObjectCommand, S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import { Context } from '@temporalio/activity';
import { ImportRepository, type Database } from '@tixkit/db';
import {
  MIGRATION_API_ORIGINS,
  HI_EVENTS_API_RESOURCE_PLAN,
  PRETIX_API_RESOURCE_PLAN,
  migrationAdapter,
  parseMigrationPreparationConfiguration,
  prepareTixkitPortableUpload,
  tixkitPortablePreflightEvidence,
  type MigrationAdapter,
  type MigrationCredentialResolver,
  type MigrationIssue,
  type MigrationPreparationConfiguration,
  type NormalizedMigrationEntity,
  type TixkitPortableImportTrust,
} from '@tixkit/migration-core';
import { canonicalPortableJson, portableManifestSha256 } from '@tixkit/portability';
import type { MigrationLifecycleSignalCommand } from '../workflows/migration-lifecycle.js';

export type MigrationPreparationInput = {
  tenantId: string;
  organizationId: string;
  jobId: string;
  chunkSize: number;
};

type PortableTrustScope = Pick<MigrationPreparationInput, 'tenantId' | 'organizationId'>;
type PayloadTrustPolicy =
  TixkitPortableImportTrust['trustedPayloadPolicies'] extends ReadonlyMap<string, infer Policy>
    ? Policy
    : never;
type MediaTrustPolicy =
  TixkitPortableImportTrust['trustedMediaPolicies'] extends ReadonlyMap<string, infer Policy>
    ? Policy
    : never;

function portabilityTrustRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('PORTABILITY_IMPORT_TRUST_INVALID');
  }
  return value as Record<string, unknown>;
}

function portabilityTrustExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  if (
    Object.keys(value).length !== expected.length ||
    Object.keys(value).some((key) => !expected.includes(key))
  ) {
    throw new Error('PORTABILITY_IMPORT_TRUST_INVALID');
  }
}

function portabilityTrustStringArray(value: unknown, allowed?: ReadonlySet<string>): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error('PORTABILITY_IMPORT_TRUST_INVALID');
  }
  const result = value as string[];
  if (
    new Set(result).size !== result.length ||
    (allowed && result.some((item) => !allowed.has(item)))
  ) {
    throw new Error('PORTABILITY_IMPORT_TRUST_INVALID');
  }
  return [...result];
}

export function portableImportTrustFromEnvironment(
  scope: PortableTrustScope,
  environment: NodeJS.ProcessEnv = process.env,
): TixkitPortableImportTrust {
  const serialized = environment.TIXKIT_PORTABILITY_IMPORT_TRUST;
  if (!serialized) throw new Error('PORTABILITY_IMPORT_TRUST_UNAVAILABLE');
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error('PORTABILITY_IMPORT_TRUST_INVALID');
  }
  const trust = portabilityTrustRecord(value);
  portabilityTrustExactKeys(trust, [
    'destination',
    'bundleKeys',
    'payloadKeys',
    'payloadPolicies',
    'mediaKeys',
    'mediaPolicies',
  ]);
  const keyMap = (
    candidate: unknown,
    required: boolean,
  ): Map<string, ReturnType<typeof createPublicKey>> => {
    const entries = Object.entries(portabilityTrustRecord(candidate));
    if (required && entries.length === 0) throw new Error('PORTABILITY_IMPORT_TRUST_INVALID');
    return new Map(
      entries.map(([keyId, pem]) => {
        if (!/^[A-Za-z0-9_-]{1,128}$/u.test(keyId) || typeof pem !== 'string') {
          throw new Error('PORTABILITY_IMPORT_TRUST_INVALID');
        }
        try {
          const key = createPublicKey(pem);
          if (key.asymmetricKeyType !== 'ed25519') {
            throw new Error('PORTABILITY_IMPORT_TRUST_INVALID');
          }
          return [keyId, key];
        } catch {
          throw new Error('PORTABILITY_IMPORT_TRUST_INVALID');
        }
      }),
    );
  };
  const bundleKeys = keyMap(trust.bundleKeys, true);
  const payloadKeys = keyMap(trust.payloadKeys, true);
  const mediaKeys = keyMap(trust.mediaKeys, false);
  const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
  const sha256 = /^[a-f0-9]{64}$/u;
  const payloadPolicies = new Map<string, PayloadTrustPolicy>();
  for (const [section, candidate] of Object.entries(
    portabilityTrustRecord(trust.payloadPolicies),
  )) {
    const policy = portabilityTrustRecord(candidate);
    portabilityTrustExactKeys(policy, [
      'schemaId',
      'schemaSha256',
      'policySha256',
      'scannerId',
      'keyId',
    ]);
    if (
      !identifier.test(section) ||
      typeof policy.schemaId !== 'string' ||
      !identifier.test(policy.schemaId) ||
      typeof policy.schemaSha256 !== 'string' ||
      !sha256.test(policy.schemaSha256) ||
      typeof policy.policySha256 !== 'string' ||
      !sha256.test(policy.policySha256) ||
      typeof policy.scannerId !== 'string' ||
      !identifier.test(policy.scannerId) ||
      typeof policy.keyId !== 'string' ||
      !payloadKeys.has(policy.keyId)
    ) {
      throw new Error('PORTABILITY_IMPORT_TRUST_INVALID');
    }
    payloadPolicies.set(section, policy as unknown as PayloadTrustPolicy);
  }
  const mediaPolicies = new Map<string, MediaTrustPolicy>();
  for (const [scannerId, candidate] of Object.entries(
    portabilityTrustRecord(trust.mediaPolicies),
  )) {
    const policy = portabilityTrustRecord(candidate);
    portabilityTrustExactKeys(policy, ['policySha256', 'keyId', 'detectedMediaTypes']);
    if (
      !identifier.test(scannerId) ||
      typeof policy.policySha256 !== 'string' ||
      !sha256.test(policy.policySha256) ||
      typeof policy.keyId !== 'string' ||
      !mediaKeys.has(policy.keyId)
    ) {
      throw new Error('PORTABILITY_IMPORT_TRUST_INVALID');
    }
    const detectedMediaTypes = portabilityTrustStringArray(policy.detectedMediaTypes);
    mediaPolicies.set(scannerId, { ...policy, detectedMediaTypes } as unknown as MediaTrustPolicy);
  }
  const destination = portabilityTrustRecord(trust.destination);
  portabilityTrustExactKeys(destination, [
    'deploymentId',
    'apiVersion',
    'dataSchemaVersion',
    'capabilities',
    'entitlements',
    'availableStorageBytes',
    'acceptedSourceOperatingModels',
  ]);
  if (
    typeof destination.deploymentId !== 'string' ||
    !identifier.test(destination.deploymentId) ||
    typeof destination.apiVersion !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(destination.apiVersion) ||
    typeof destination.dataSchemaVersion !== 'string' ||
    !/^\d{4}$/u.test(destination.dataSchemaVersion) ||
    !Number.isSafeInteger(destination.availableStorageBytes) ||
    (destination.availableStorageBytes as number) < 0
  ) {
    throw new Error('PORTABILITY_IMPORT_TRUST_INVALID');
  }
  const parsedDestination: TixkitPortableImportTrust['destination'] = {
    deploymentId: destination.deploymentId,
    apiVersion: destination.apiVersion,
    dataSchemaVersion: destination.dataSchemaVersion,
    capabilities: portabilityTrustStringArray(destination.capabilities),
    entitlements: portabilityTrustStringArray(destination.entitlements),
    availableStorageBytes: destination.availableStorageBytes as number,
    acceptedSourceOperatingModels: portabilityTrustStringArray(
      destination.acceptedSourceOperatingModels,
      new Set(['cloud', 'self-hosted']),
    ) as Array<'cloud' | 'self-hosted'>,
  };
  return {
    destination: parsedDestination,
    trustedBundleKeys: bundleKeys,
    trustedPayloadKeys: payloadKeys,
    trustedPayloadPolicies: payloadPolicies,
    trustedMediaKeys: mediaKeys,
    trustedMediaPolicies: mediaPolicies,
    destinationTenantId: scope.tenantId,
    destinationOrganizationId: scope.organizationId,
  };
}

export type MigrationPreparationChunk = {
  processed: number;
  completed: boolean;
};

export function assertPortableAdapterVersionMatchesManifest(
  adapterVersion: string,
  manifestFormat: string,
): void {
  if (adapterVersion !== manifestFormat) {
    throw new Error('PORTABILITY_ADAPTER_VERSION_MISMATCH');
  }
}

export interface MigrationPreparationService {
  prepare(input: MigrationPreparationInput): Promise<MigrationPreparationChunk>;
  pause(
    input: Omit<MigrationPreparationInput, 'chunkSize'> & {
      lifecycleCommand?: MigrationLifecycleSignalCommand;
    },
  ): Promise<void>;
  resume(
    input: Omit<MigrationPreparationInput, 'chunkSize'> & {
      lifecycleCommand: MigrationLifecycleSignalCommand;
    },
  ): Promise<void>;
  cancel(
    input: Omit<MigrationPreparationInput, 'chunkSize'> & {
      lifecycleCommand?: MigrationLifecycleSignalCommand;
    },
  ): Promise<void>;
  fail(input: Omit<MigrationPreparationInput, 'chunkSize'> & { message: string }): Promise<void>;
}

let service: MigrationPreparationService | undefined;

export function registerMigrationPreparationService(
  value: MigrationPreparationService,
): () => void {
  service = value;
  return () => {
    if (service === value) service = undefined;
  };
}

function preparationService(): MigrationPreparationService {
  if (!service) throw new Error('MIGRATION_PREPARATION_SERVICE_NOT_REGISTERED');
  return service;
}

export function prepareMigrationChunkActivity(
  input: MigrationPreparationInput,
): Promise<MigrationPreparationChunk> {
  return preparationService().prepare(input);
}

export function pauseMigrationPreparationActivity(
  input: Omit<MigrationPreparationInput, 'chunkSize'> & {
    lifecycleCommand?: MigrationLifecycleSignalCommand;
  },
): Promise<void> {
  return preparationService().pause(input);
}

export function resumeMigrationPreparationActivity(
  input: Omit<MigrationPreparationInput, 'chunkSize'> & {
    lifecycleCommand: MigrationLifecycleSignalCommand;
  },
): Promise<void> {
  return preparationService().resume(input);
}

export function cancelMigrationPreparationActivity(
  input: Omit<MigrationPreparationInput, 'chunkSize'> & {
    lifecycleCommand?: MigrationLifecycleSignalCommand;
  },
): Promise<void> {
  return preparationService().cancel(input);
}

export function failMigrationPreparationActivity(
  input: Omit<MigrationPreparationInput, 'chunkSize'> & { message: string },
): Promise<void> {
  return preparationService().fail(input);
}

type Cursor = {
  resourceIndex?: number;
  upstreamCursor?: string;
  artifactIndex?: number;
  adapterCursor?: string;
  pretixPositionQueue?: readonly {
    eventSlug: string;
    listId: string;
  }[];
  pretixListContinuation?: string;
};

export function encodeMigrationPreparationCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

export function decodeMigrationPreparationCursor(value: string | undefined): Cursor {
  if (!value) return {};
  const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Cursor;
  if (!parsed || typeof parsed !== 'object') throw new Error('MIGRATION_CURSOR_INVALID');
  return parsed;
}

export type MigrationCursorScope = {
  tenantId: string;
  organizationId: string;
  jobId: string;
  sourceSystem: string;
};

export type MigrationCursorKeyring = {
  currentKeyId: string;
  keys: Readonly<Record<string, Buffer>>;
};

export function migrationCursorKey(
  configured?: string,
  configuredKeyring?: {
    currentKeyId: string;
    keys: Readonly<Record<string, string>>;
  },
): MigrationCursorKeyring {
  if (configuredKeyring) {
    const keys = Object.fromEntries(
      Object.entries(configuredKeyring.keys).map(([keyId, encoded]) => {
        const key = Buffer.from(encoded, 'base64');
        if (!/^[A-Za-z0-9_-]{1,64}$/u.test(keyId) || key.byteLength !== 32)
          throw new Error('MIGRATION_CURSOR_KEY_INVALID');
        return [keyId, key];
      }),
    );
    if (!keys[configuredKeyring.currentKeyId]) throw new Error('MIGRATION_CURSOR_KEY_INVALID');
    return { currentKeyId: configuredKeyring.currentKeyId, keys };
  }
  const encoded = configured ?? process.env.TIXKIT_MIGRATION_CURSOR_KEY;
  if (!encoded) throw new Error('MIGRATION_CURSOR_KEY_UNAVAILABLE');
  const key = Buffer.from(encoded, 'base64');
  if (key.byteLength !== 32) throw new Error('MIGRATION_CURSOR_KEY_INVALID');
  return { currentKeyId: 'current', keys: { current: key } };
}

export function migrationCursorKeyringFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): MigrationCursorKeyring {
  const activeKeyId = environment.TIXKIT_MIGRATION_CURSOR_ACTIVE_KEY_ID;
  const serializedKeys = environment.TIXKIT_MIGRATION_CURSOR_KEYS;
  if (!activeKeyId || !serializedKeys) throw new Error('MIGRATION_CURSOR_KEYRING_UNAVAILABLE');
  let keys: unknown;
  try {
    keys = JSON.parse(serializedKeys);
  } catch {
    throw new Error('MIGRATION_CURSOR_KEYRING_INVALID');
  }
  if (!keys || typeof keys !== 'object' || Array.isArray(keys))
    throw new Error('MIGRATION_CURSOR_KEYRING_INVALID');
  return migrationCursorKey(undefined, {
    currentKeyId: activeKeyId,
    keys: keys as Readonly<Record<string, string>>,
  });
}

function cursorAad(scope: MigrationCursorScope): Buffer {
  return Buffer.from(
    `tixkit:migration-cursor:v2\u0000${scope.tenantId}\u0000${scope.organizationId}\u0000${scope.jobId}\u0000${scope.sourceSystem}`,
    'utf8',
  );
}

export function encryptMigrationPreparationCursor(
  value: string,
  keyring: MigrationCursorKeyring,
  scope: MigrationCursorScope,
): string {
  const iv = randomBytes(12);
  const key = keyring.keys[keyring.currentKeyId];
  if (!key || key.byteLength !== 32 || !/^[A-Za-z0-9_-]{1,64}$/u.test(keyring.currentKeyId))
    throw new Error('MIGRATION_CURSOR_KEY_INVALID');
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(cursorAad(scope));
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `v2.${keyring.currentKeyId}.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
}

export function decryptMigrationPreparationCursor(
  value: string,
  keyring: MigrationCursorKeyring,
  scope: MigrationCursorScope,
): string {
  const [version, keyId, iv, tag, encrypted] = value.split('.');
  const key = keyId ? keyring.keys[keyId] : undefined;
  if (version !== 'v2' || !keyId || !key || !iv || !tag || !encrypted)
    throw new Error('MIGRATION_CURSOR_INVALID');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(cursorAad(scope));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new Error('MIGRATION_CURSOR_INVALID');
  }
}

export function isBlockedMigrationAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const octets = address.split('.').map(Number);
    const value = octets.reduce((result, octet) => (result << 8n) | BigInt(octet), 0n);
    const inCidr = (network: string, prefix: number): boolean => {
      const base = network
        .split('.')
        .map(Number)
        .reduce((result, octet) => (result << 8n) | BigInt(octet), 0n);
      const shift = BigInt(32 - prefix);
      return value >> shift === base >> shift;
    };
    return (
      octets[0] === 0 ||
      octets[0] === 10 ||
      octets[0] === 127 ||
      (octets[0] === 100 && (octets[1] ?? 0) >= 64 && (octets[1] ?? 0) <= 127) ||
      (octets[0] === 169 && octets[1] === 254) ||
      (octets[0] === 172 && (octets[1] ?? 0) >= 16 && (octets[1] ?? 0) <= 31) ||
      inCidr('192.0.0.0', 24) ||
      inCidr('192.88.99.0', 24) ||
      (octets[0] === 192 && octets[1] === 168) ||
      (octets[0] === 192 && octets[1] === 0 && octets[2] === 2) ||
      (octets[0] === 198 && (octets[1] === 18 || octets[1] === 19)) ||
      (octets[0] === 198 && octets[1] === 51 && octets[2] === 100) ||
      (octets[0] === 203 && octets[1] === 0 && octets[2] === 113) ||
      (octets[0] ?? 0) >= 224
    );
  }
  if (isIP(address) !== 6) return true;
  const normalized = address.toLowerCase();
  const mapped = /^(?:::ffff:)(\d+\.\d+\.\d+\.\d+)$/u.exec(normalized)?.[1];
  if (mapped) return isBlockedMigrationAddress(mapped);
  const expanded = (() => {
    const [left, right = ''] = normalized.split('::');
    const leftParts = left ? left.split(':') : [];
    const rightParts = right ? right.split(':') : [];
    const fill = Array(Math.max(0, 8 - leftParts.length - rightParts.length)).fill('0');
    return [...leftParts, ...fill, ...rightParts].map((part) => Number.parseInt(part || '0', 16));
  })();
  const value = expanded.reduce((result, part) => (result << 16n) | BigInt(part), 0n);
  const inCidr = (network: bigint, prefix: number): boolean => {
    const shift = BigInt(128 - prefix);
    return value >> shift === network >> shift;
  };
  return (
    normalized === '::1' ||
    normalized === '::' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb') ||
    normalized.startsWith('fec') ||
    normalized.startsWith('fed') ||
    normalized.startsWith('fee') ||
    normalized.startsWith('fef') ||
    normalized.startsWith('ff') ||
    normalized.startsWith('64:ff9b:') ||
    normalized.startsWith('2001:db8:') ||
    inCidr(0x20010000000000000000000000000000n, 23) ||
    normalized.startsWith('2001:0:') ||
    normalized.startsWith('2001:0000:') ||
    normalized.startsWith('2002:') ||
    normalized.startsWith('::ffff:') ||
    normalized.startsWith('::')
  );
}

type HostLookup = typeof lookup;

export async function assertSafeMigrationOrigin(
  origin: string,
  resolveHost: HostLookup = lookup,
): Promise<URL> {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443'))
    throw new Error('MIGRATION_SOURCE_ORIGIN_REJECTED');
  if (
    url.hostname === 'localhost' ||
    (isIP(url.hostname) && isBlockedMigrationAddress(url.hostname))
  )
    throw new Error('MIGRATION_SOURCE_ORIGIN_REJECTED');
  const addresses = await resolveHost(url.hostname, {
    all: true,
    verbatim: true,
  });
  if (addresses.length === 0 || addresses.some(({ address }) => isBlockedMigrationAddress(address)))
    throw new Error('MIGRATION_SOURCE_ORIGIN_REJECTED');
  return url;
}

export function createPinnedMigrationFetch(resolveHost: HostLookup): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method !== 'GET') throw new Error('MIGRATION_SOURCE_METHOD_REJECTED');
    const addresses = await resolveHost(url.hostname, {
      all: true,
      verbatim: true,
    });
    if (
      addresses.length === 0 ||
      addresses.some(({ address }) => isBlockedMigrationAddress(address))
    )
      throw new Error('MIGRATION_SOURCE_ORIGIN_REJECTED');
    const pinned = addresses[0]!;
    return new Promise<Response>((resolve, reject) => {
      const request = httpsRequest(
        url,
        {
          method: 'GET',
          headers: init?.headers as Record<string, string> | undefined,
          signal: init?.signal ?? undefined,
          lookup: (_hostname, options, callback) => {
            if (typeof options === 'object' && options.all)
              callback(null, [{ address: pinned.address, family: pinned.family }]);
            else callback(null, pinned.address, pinned.family);
          },
        },
        (response) => {
          const maximum = 10 * 1024 * 1024;
          const declared = Number(response.headers['content-length']);
          if (Number.isFinite(declared) && declared > maximum) {
            response.destroy();
            reject(new Error('MIGRATION_SOURCE_PAGE_TOO_LARGE'));
            return;
          }
          const chunks: Buffer[] = [];
          let length = 0;
          response.on('data', (chunk: Buffer) => {
            length += chunk.byteLength;
            if (length > maximum) {
              response.destroy(new Error('MIGRATION_SOURCE_PAGE_TOO_LARGE'));
              return;
            }
            chunks.push(chunk);
          });
          response.once('error', reject);
          response.once('end', () => {
            resolve(
              new Response(Buffer.concat(chunks, length), {
                status: response.statusCode ?? 500,
                headers: Object.entries(response.headers).flatMap(([key, value]) =>
                  value === undefined
                    ? []
                    : Array.isArray(value)
                      ? value.map((item) => [key, item] as [string, string])
                      : [[key, String(value)] as [string, string]],
                ),
              }),
            );
          });
        },
      );
      request.once('error', reject);
      request.end();
    });
  }) as typeof fetch;
}

function assertConfiguredSelfHostedOrigin(
  configuration: Exclude<MigrationPreparationConfiguration, { sourceMode: 'official-export' }>,
  origin: string,
): void {
  if (!('baseUrl' in configuration) || !configuration.baseUrl) return;
  const allowed = new Set(
    (process.env.TIXKIT_MIGRATION_SELF_HOSTED_ORIGINS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => new URL(value).origin),
  );
  if (!allowed.has(new URL(origin).origin))
    throw new Error('MIGRATION_SELF_HOSTED_ORIGIN_NOT_ALLOWLISTED');
}

export async function readMigrationJsonResponse(
  response: Response,
): Promise<Record<string, unknown>> {
  const maximum = 10 * 1024 * 1024;
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximum)
    throw new Error('MIGRATION_SOURCE_PAGE_TOO_LARGE');
  if (!response.body) throw new Error('MIGRATION_SOURCE_RESPONSE_INVALID');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maximum) {
      await reader.cancel();
      throw new Error('MIGRATION_SOURCE_PAGE_TOO_LARGE');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('MIGRATION_SOURCE_RESPONSE_INVALID');
  return parsed as Record<string, unknown>;
}

function retryAfter(response: Response): number | undefined {
  const value = response.headers.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? Math.min(Math.max(0, timestamp - Date.now()), 30_000)
    : undefined;
}

async function officialFetch(
  url: URL,
  authorization: string,
  signal: AbortSignal,
  fetcher: typeof fetch,
  heartbeat: (details: unknown) => void,
): Promise<Record<string, unknown>> {
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    signal.throwIfAborted();
    const response = await fetcher(url, {
      headers: { accept: 'application/json', authorization },
      redirect: 'manual',
      signal,
    });
    if (response.status >= 300 && response.status < 400)
      throw new Error('MIGRATION_SOURCE_REDIRECT_REJECTED');
    if (response.ok) return readMigrationJsonResponse(response);
    if (![429, 502, 503, 504].includes(response.status) || attempt === 6)
      throw new Error(`MIGRATION_SOURCE_HTTP_${response.status}`);
    const delay = retryAfter(response) ?? Math.min(30_000, 500 * 2 ** (attempt - 1));
    heartbeat({ attempt, retryInMs: delay });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(resolve, delay);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timeout);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  }
  throw new Error('MIGRATION_SOURCE_RETRY_EXHAUSTED');
}

export function migrationAuthorizationHeader(
  sourceSystem: MigrationPreparationConfiguration['sourceSystem'],
  material: string,
): string {
  if (!material || /[\r\n]/u.test(material)) throw new Error('MIGRATION_CREDENTIAL_INVALID');
  if (sourceSystem === 'pretix') return `Token ${material}`;
  if (sourceSystem === 'ticket-tailor')
    return `Basic ${Buffer.from(`${material}:`, 'utf8').toString('base64')}`;
  return `Bearer ${material}`;
}

export async function readMigrationArtifactBody(
  body: unknown,
  maximum: number,
): Promise<Uint8Array> {
  if (!body || typeof body !== 'object') throw new Error('MIGRATION_ARTIFACT_BODY_INVALID');
  if (Symbol.asyncIterator in body) {
    const chunks: Uint8Array[] = [];
    let length = 0;
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      length += bytes.byteLength;
      if (length > maximum) throw new Error('MIGRATION_ARTIFACT_TOO_LARGE');
      chunks.push(bytes);
    }
    const output = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output;
  }
  throw new Error('MIGRATION_ARTIFACT_BODY_NOT_STREAMING');
}

function recordsFromPayload(
  payload: Record<string, unknown>,
  resource: string,
): readonly Record<string, unknown>[] {
  const collectionKey: Readonly<Record<string, string>> = {
    event: 'events',
    order: 'orders',
    attendee: 'attendees',
    ticket_class: 'ticket_classes',
    discount: 'discounts',
    venue: 'venues',
    ticket_type: 'ticket_types',
    issued_ticket: 'issued_tickets',
    check_in: 'check_ins',
    payment: 'payments',
    refund: 'refunds',
  };
  const records =
    payload.results ??
    payload.data ??
    payload.items ??
    payload[collectionKey[resource] ?? resource] ??
    payload.events;
  const source = Array.isArray(records) ? records : [payload];
  return source.map((record) => {
    if (!record || typeof record !== 'object' || Array.isArray(record))
      throw new Error('MIGRATION_SOURCE_RECORD_INVALID');
    return record as Record<string, unknown>;
  });
}

function expandedNativeRecords(
  sourceSystem: 'pretix' | 'hi-events',
  resource: string,
  records: readonly Record<string, unknown>[],
): readonly { resource: string; body: Record<string, unknown> }[] {
  const expanded: Array<{ resource: string; body: Record<string, unknown> }> = [];
  for (const record of records) {
    const body =
      record.body && typeof record.body === 'object' && !Array.isArray(record.body)
        ? (record.body as Record<string, unknown>)
        : record;
    if (sourceSystem === 'pretix' && resource === 'checkins') {
      if (body.position_id !== undefined && !Array.isArray(body.checkins)) {
        expanded.push({ resource: 'checkins', body });
        continue;
      }
      if (!Array.isArray(body.checkins)) continue;
      for (const checkin of body.checkins) {
        if (!checkin || typeof checkin !== 'object' || Array.isArray(checkin)) continue;
        expanded.push({
          resource: 'checkins',
          body: {
            ...(checkin as Record<string, unknown>),
            position_id: body.id,
          },
        });
      }
      continue;
    }
    expanded.push({
      resource: String(record.resource ?? record.collection ?? resource),
      body,
    });
    if (resource !== 'orders') continue;
    const orderId = body.code ?? body.id ?? body.order_short_id;
    for (const [nested, nestedResource] of [
      ['payments', 'payments'],
      ['refunds', 'refunds'],
    ] as const) {
      if (!Array.isArray(body[nested])) continue;
      for (const item of body[nested]) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        expanded.push({
          resource: nestedResource,
          body: {
            ...(item as Record<string, unknown>),
            [sourceSystem === 'pretix' ? 'order' : 'order_id']: orderId,
          },
        });
      }
    }
    if (sourceSystem === 'pretix' && Array.isArray(body.positions)) {
      for (const position of body.positions) {
        if (!position || typeof position !== 'object' || Array.isArray(position)) continue;
        const sourcePosition = position as Record<string, unknown>;
        if (!Array.isArray(sourcePosition.checkins)) continue;
        for (const checkin of sourcePosition.checkins) {
          if (!checkin || typeof checkin !== 'object' || Array.isArray(checkin)) continue;
          expanded.push({
            resource: 'checkins',
            body: {
              ...(checkin as Record<string, unknown>),
              position_id: sourcePosition.id,
            },
          });
        }
      }
    }
  }
  return expanded;
}

const PAGINATION_PARAMETERS = new Set(['page', 'cursor', 'continuation', 'offset']);

export function migrationPaginationCursor(
  payload: Record<string, unknown>,
  origin: string,
): string | undefined {
  const pagination =
    payload.pagination && typeof payload.pagination === 'object'
      ? (payload.pagination as Record<string, unknown>)
      : undefined;
  const candidate = payload.next ?? pagination?.continuation ?? pagination?.next_page;
  if (candidate === undefined || candidate === null || candidate === '') return undefined;
  if (typeof candidate !== 'string') throw new Error('MIGRATION_SOURCE_CURSOR_INVALID');
  if (/^https?:/u.test(candidate)) {
    const next = new URL(candidate);
    if (next.origin !== origin) throw new Error('MIGRATION_SOURCE_CURSOR_ORIGIN_REJECTED');
    const filtered = new URLSearchParams();
    for (const [key, value] of next.searchParams) {
      if (PAGINATION_PARAMETERS.has(key)) filtered.append(key, value);
    }
    if ([...filtered].length === 0) throw new Error('MIGRATION_SOURCE_CURSOR_INVALID');
    return filtered.toString();
  }
  if (!/^[A-Za-z0-9._~-]{1,2048}$/u.test(candidate))
    throw new Error('MIGRATION_SOURCE_CURSOR_INVALID');
  return new URLSearchParams({ continuation: candidate }).toString();
}

function recordId(record: Record<string, unknown>): string {
  const value = record.id ?? record.code ?? record.reference;
  if ((typeof value !== 'string' && typeof value !== 'number') || !String(value).trim())
    throw new Error('MIGRATION_SOURCE_RECORD_ID_MISSING');
  return String(value);
}

export function buildMigrationAdapterApiPage(
  configuration: Exclude<MigrationPreparationConfiguration, { sourceMode: 'official-export' }>,
  payload: Record<string, unknown>,
  sourceCursor: string,
  resource: string,
): unknown {
  const records = recordsFromPayload(payload, resource);
  const importedAt = new Date().toISOString();
  if (configuration.sourceSystem === 'pretix')
    return {
      sourceMode: 'official-api',
      organizerSlug: configuration.organizerSlug,
      sourceVersion: '2026.1',
      importedAt,
      pages: [
        {
          cursor: sourceCursor,
          records:
            resource === 'checkinlists'
              ? []
              : expandedNativeRecords('pretix', resource, records).map(({ resource, body }) => ({
                  resource,
                  body,
                })),
        },
      ],
    };
  if (configuration.sourceSystem === 'hi-events')
    return {
      sourceMode: 'official-api',
      accountId: configuration.accountId,
      sourceVersion: '0.20.0',
      importedAt,
      pages: [
        {
          cursor: sourceCursor,
          records: expandedNativeRecords('hi-events', resource, records).map(
            ({ resource, body }) => ({ collection: resource, body }),
          ),
        },
      ],
    };
  const vendorRecords =
    configuration.sourceSystem === 'eventbrite'
      ? records.flatMap((body) => {
          const expanded = [{ resource, id: recordId(body), changed: body.changed, body }];
          if (resource !== 'order' || !Array.isArray(body.attendees)) return expanded;
          const orderId = recordId(body);
          const eventId =
            typeof body.event_id === 'string'
              ? body.event_id
              : body.event && typeof body.event === 'object' && !Array.isArray(body.event)
                ? String((body.event as Record<string, unknown>).id ?? '')
                : undefined;
          for (const candidate of body.attendees) {
            if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
            const attendee = candidate as Record<string, unknown>;
            const attendeeId = recordId(attendee);
            const shared = {
              ...attendee,
              attendee_id: attendeeId,
              event_id: eventId,
              order_id: orderId,
            };
            expanded.push({
              resource: 'attendee',
              id: attendeeId,
              changed: attendee.changed,
              body: shared,
            });
            const barcode = Array.isArray(attendee.barcodes)
              ? attendee.barcodes.find((value): value is Record<string, unknown> =>
                  Boolean(value && typeof value === 'object' && !Array.isArray(value)),
                )
              : undefined;
            expanded.push({
              resource: 'ticket',
              id: attendeeId,
              changed: attendee.changed,
              body: { ...shared, barcode: barcode?.barcode },
            });
          }
          return expanded;
        })
      : records.map((body) => ({
          resource: String(body.resource ?? resource),
          id: recordId(body),
          changed: body.changed,
          body,
        }));
  return {
    accountId:
      configuration.sourceSystem === 'eventbrite'
        ? configuration.organizationId
        : configuration.accountId,
    sourceVersion: configuration.sourceSystem === 'eventbrite' ? 'v3' : 'v1',
    importedAt,
    records: vendorRecords,
  };
}

type ApiResource = {
  resource: string;
  path: string;
  query?: Readonly<Record<string, string>>;
  eventSlug?: string;
};

export function migrationApiResourcePlan(
  configuration: Exclude<MigrationPreparationConfiguration, { sourceMode: 'official-export' }>,
): { origin: string; resources: readonly ApiResource[] } {
  const origin =
    configuration.sourceSystem === 'pretix'
      ? (configuration.baseUrl ?? 'https://pretix.eu')
      : configuration.sourceSystem === 'hi-events'
        ? (configuration.baseUrl ?? 'https://api.hi.events')
        : MIGRATION_API_ORIGINS[configuration.sourceSystem];
  const resources: ApiResource[] = [];
  if (configuration.sourceSystem === 'pretix') {
    const organizer = encodeURIComponent(configuration.organizerSlug);
    for (const entry of PRETIX_API_RESOURCE_PLAN) {
      if (entry.scope === 'order' || entry.resource === 'checkins') continue;
      if (entry.scope === 'organizer') {
        resources.push({
          resource: entry.resource,
          path: entry.path.replace('{organizer}', organizer),
        });
        continue;
      }
      for (const eventSlug of configuration.eventSlugs ?? []) {
        resources.push({
          resource: entry.resource,
          path: entry.path
            .replace('{organizer}', organizer)
            .replace('{event}', encodeURIComponent(eventSlug)),
          ...(entry.resource === 'orders'
            ? { query: { expand: 'positions,payments,refunds' } }
            : {}),
        });
      }
    }
    for (const eventSlug of configuration.eventSlugs ?? []) {
      const encodedEvent = encodeURIComponent(eventSlug);
      resources.push({
        resource: 'checkinlists',
        path: `/api/v1/organizers/${organizer}/events/${encodedEvent}/checkinlists/`,
        eventSlug,
      });
    }
  } else if (configuration.sourceSystem === 'hi-events') {
    const accountId = encodeURIComponent(configuration.accountId);
    for (const entry of HI_EVENTS_API_RESOURCE_PLAN) {
      if (entry.scope === 'order') continue;
      if (entry.scope === 'account') {
        resources.push({
          resource: entry.collection,
          path: entry.path,
          query: { account_id: accountId },
        });
        continue;
      }
      for (const eventId of configuration.eventIds ?? []) {
        resources.push({
          resource: entry.collection,
          path: entry.path.replace('{event}', encodeURIComponent(eventId)),
        });
      }
    }
  } else if (configuration.sourceSystem === 'eventbrite') {
    const organization = encodeURIComponent(configuration.organizationId);
    const root = `/v3/organizations/${organization}`;
    resources.push(
      { resource: 'event', path: `${root}/events/` },
      { resource: 'order', path: `${root}/orders/` },
      { resource: 'discount', path: `${root}/discounts/` },
      { resource: 'venue', path: `${root}/venues/` },
    );
    for (const eventId of configuration.eventIds ?? []) {
      const encodedEventId = encodeURIComponent(eventId);
      resources.push(
        {
          resource: 'ticket_class',
          path: `/v3/events/${encodedEventId}/ticket_classes/`,
        },
        {
          resource: 'order',
          path: `/v3/events/${encodedEventId}/orders/`,
          query: { expand: 'attendees' },
        },
      );
    }
  } else {
    const eventIds = configuration.eventIds ?? [];
    for (const [resource, path] of [
      ['event', '/v1/events'],
      ['ticket_type', '/v1/ticket_types'],
      ['order', '/v1/orders'],
      ['issued_ticket', '/v1/issued_tickets'],
      ['check_in', '/v1/check_ins'],
      ['payment', '/v1/payments'],
      ['refund', '/v1/refunds'],
    ] as const) {
      for (const eventId of eventIds)
        resources.push({ resource, path, query: { event_id: eventId } });
    }
  }
  if (resources.length === 0) throw new Error('MIGRATION_SOURCE_RESOURCE_SCOPE_REQUIRED');
  return { origin, resources };
}

function apiUrl(
  origin: string,
  resource: ApiResource,
  cursor: string | undefined,
  limit: number,
): URL {
  const url = new URL(resource.path, origin);
  for (const [key, value] of Object.entries(resource.query ?? {})) url.searchParams.set(key, value);
  url.searchParams.set('limit', String(limit));
  if (cursor) {
    const parameters = new URLSearchParams(cursor);
    for (const [key, value] of parameters) {
      if (!PAGINATION_PARAMETERS.has(key)) throw new Error('MIGRATION_SOURCE_CURSOR_INVALID');
      url.searchParams.set(key, value);
    }
  }
  return url;
}

function s3Client(): S3Client {
  const endpoint = process.env.S3_ENDPOINT;
  const config: S3ClientConfig = {
    region: process.env.S3_REGION ?? 'us-east-1',
  };
  if (endpoint) {
    config.endpoint = endpoint;
    config.forcePathStyle = process.env.S3_FORCE_PATH_STYLE !== 'false';
    if (process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY)
      config.credentials = {
        accessKeyId: process.env.S3_ACCESS_KEY_ID,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
      };
  }
  return new S3Client(config);
}

export function createMigrationPreparationService(
  db: Database,
  credentialResolver: MigrationCredentialResolver<string>,
  runtime: {
    fetch?: typeof fetch;
    resolveHost?: HostLookup;
    createS3Client?: () => S3Client;
    signal?: AbortSignal;
    heartbeat?: (details: unknown) => void;
    cursorEncryptionKey?: string;
    cursorEncryptionKeyring?: {
      currentKeyId: string;
      keys: Readonly<Record<string, string>>;
    };
    portableTrust?: (scope: PortableTrustScope) => TixkitPortableImportTrust;
  } = {},
): MigrationPreparationService {
  const repository = new ImportRepository(db);
  const persistLifecycleOutcome = (
    input: Parameters<ImportRepository['persistMigrationLifecycleCommandOutcome']>[0],
  ) =>
    db
      .transaction()
      .setIsolationLevel('serializable')
      .execute((transaction) =>
        new ImportRepository(transaction as Database).persistMigrationLifecycleCommandOutcome(
          input,
        ),
      );
  return {
    async prepare(input) {
      if (!Number.isSafeInteger(input.chunkSize) || input.chunkSize < 1 || input.chunkSize > 500)
        throw new Error('MIGRATION_PREPARATION_CHUNK_SIZE_INVALID');
      const job = await repository.findJob(input.tenantId, input.organizationId, input.jobId);
      if (!job) throw new Error('MIGRATION_JOB_NOT_FOUND');
      if (job.source_system === 'tixkit-portable' && job.mode !== 'dry-run') {
        throw new Error('PORTABILITY_COMMIT_AUTHORIZATION_UNAVAILABLE');
      }
      if (job.status === 'prepared') return { processed: 0, completed: true };
      if (!['pending', 'failed', 'paused', 'preparing'].includes(job.status)) {
        throw new Error('MIGRATION_JOB_NOT_PREPARABLE');
      }
      const raw = job.configuration
        ? (JSON.parse(job.configuration) as Record<string, unknown>)
        : null;
      const { credentialId: rawCredentialId, ...sourceConfiguration } = raw ?? {};
      const configuration = parseMigrationPreparationConfiguration(
        { ...sourceConfiguration, sourceSystem: job.source_system },
        job.source_system,
      );
      if (configuration.sourceMode === 'official-export') {
        await repository.acquireMigrationArtifactsForState({
          tenantId: input.tenantId,
          organizationId: input.organizationId,
          jobId: input.jobId,
          artifactIds: configuration.artifactIds,
          targetState: 'preparing',
          transition: true,
        });
      } else if (['pending', 'failed', 'paused'].includes(job.status)) {
        const changed = await repository.transitionJob({
          tenantId: input.tenantId,
          organizationId: input.organizationId,
          jobId: input.jobId,
          from: [job.status as never],
          to: 'preparing' as never,
        });
        if (!changed) throw new Error('MIGRATION_JOB_STATE_CHANGED');
      }
      const progress = await repository.preparationProgress(
        input.tenantId,
        input.organizationId,
        input.jobId,
      );
      if (progress.completed) return { processed: 0, completed: true };
      const cursorKeyMaterial = migrationCursorKey(
        runtime.cursorEncryptionKey,
        runtime.cursorEncryptionKeyring,
      );
      const cursorScope: MigrationCursorScope = {
        tenantId: input.tenantId,
        organizationId: input.organizationId,
        jobId: input.jobId,
        sourceSystem: job.source_system,
      };
      const cursor = decodeMigrationPreparationCursor(
        progress.cursor
          ? decryptMigrationPreparationCursor(progress.cursor, cursorKeyMaterial, cursorScope)
          : undefined,
      );
      const activityContext = runtime.signal ? undefined : Context.current();
      const signal = runtime.signal ?? activityContext!.cancellationSignal;
      const heartbeat =
        runtime.heartbeat ?? ((details: unknown) => activityContext!.heartbeat(details));
      const adapter = migrationAdapter(
        job.source_system as Parameters<typeof migrationAdapter>[0],
      ) as MigrationAdapter<unknown, string>;
      if (!adapter.supportedVersions.includes(job.adapter_version))
        throw new Error('MIGRATION_ADAPTER_VERSION_UNSUPPORTED');
      let transient: unknown;
      let sourceNext: string | undefined;
      let cursorKey: string;
      let apiResourceCount = 0;
      let apiResourceIndex = cursor.resourceIndex ?? 0;
      let apiResource: ApiResource | undefined;
      let pretixDiscoveredLists: readonly { eventSlug: string; listId: string }[] | undefined;
      if (configuration.sourceMode === 'official-api') {
        const credentialId = typeof rawCredentialId === 'string' ? rawCredentialId : undefined;
        if (!credentialId) throw new Error('MIGRATION_CREDENTIAL_REQUIRED');
        const credential = await repository.findActiveCredential({
          tenantId: input.tenantId,
          organizationId: input.organizationId,
          sourceSystem: job.source_system,
          credentialId,
        });
        if (!credential) throw new Error('MIGRATION_CREDENTIAL_INACTIVE');
        const resolved = await credentialResolver.resolve(
          {
            id: credential.id,
            tenantId: input.tenantId,
            organizationId: input.organizationId,
            sourceSystem: job.source_system,
            secretReference: credential.secret_reference,
            expiresAt: credential.expires_at.toISOString(),
          },
          { signal },
        );
        if (Date.parse(resolved.expiresAt) <= Date.now())
          throw new Error('MIGRATION_CREDENTIAL_EXPIRED');
        const source = migrationApiResourcePlan(configuration);
        apiResourceCount = source.resources.length;
        const queuedPosition = cursor.pretixPositionQueue?.[0];
        const resource = queuedPosition
          ? {
              resource: 'checkins',
              path: `/api/v1/organizers/${encodeURIComponent(
                configuration.sourceSystem === 'pretix' ? configuration.organizerSlug : '',
              )}/events/${encodeURIComponent(queuedPosition.eventSlug)}/checkinlists/${encodeURIComponent(
                queuedPosition.listId,
              )}/positions/`,
              eventSlug: queuedPosition.eventSlug,
            }
          : source.resources[apiResourceIndex];
        if (!resource) throw new Error('MIGRATION_SOURCE_RESOURCE_CURSOR_INVALID');
        apiResource = resource;
        const target = apiUrl(source.origin, resource, cursor.upstreamCursor, input.chunkSize);
        assertConfiguredSelfHostedOrigin(configuration, source.origin);
        await assertSafeMigrationOrigin(source.origin, runtime.resolveHost ?? lookup);
        if (target.origin !== new URL(source.origin).origin)
          throw new Error('MIGRATION_SOURCE_CURSOR_ORIGIN_REJECTED');
        const payload = await officialFetch(
          target,
          migrationAuthorizationHeader(configuration.sourceSystem, resolved.material),
          signal,
          runtime.fetch ?? createPinnedMigrationFetch(runtime.resolveHost ?? lookup),
          heartbeat,
        );
        transient = buildMigrationAdapterApiPage(
          configuration,
          payload,
          `resource-${apiResourceIndex}-page-${createHash('sha256')
            .update(
              JSON.stringify({
                upstreamCursor: cursor.upstreamCursor ?? 'first',
                pretixPosition: cursor.pretixPositionQueue?.[0] ?? null,
              }),
            )
            .digest('hex')
            .slice(0, 16)}`,
          resource.resource,
        );
        sourceNext = migrationPaginationCursor(payload, source.origin);
        if (configuration.sourceSystem === 'pretix' && resource.resource === 'checkinlists') {
          if (!resource.eventSlug) throw new Error('MIGRATION_PRETIX_CHECKIN_LIST_SCOPE_INVALID');
          const lists = recordsFromPayload(payload, 'checkinlists');
          if (lists.length > 500) throw new Error('MIGRATION_PRETIX_CHECKIN_LIST_PAGE_TOO_LARGE');
          pretixDiscoveredLists = lists.map((list) => {
            const listId = recordId(list);
            if (listId.length > 256) throw new Error('MIGRATION_PRETIX_CHECKIN_LIST_ID_INVALID');
            return { eventSlug: resource.eventSlug!, listId };
          });
        }
        cursorKey = createHash('sha256').update(target.href).digest('hex');
      } else {
        const index = cursor.artifactIndex ?? 0;
        const artifactId = configuration.artifactIds[index];
        if (!artifactId) throw new Error('MIGRATION_ARTIFACT_CURSOR_INVALID');
        const artifact = await db
          .selectFrom('upload_artifacts')
          .selectAll()
          .where('id', '=', artifactId)
          .where('tenant_id', '=', input.tenantId)
          .where('organization_id', '=', input.organizationId)
          .where('purpose', '=', 'migration_import')
          .where('status', '=', 'uploaded')
          .where('scan_status', '=', 'clean')
          .executeTakeFirst();
        if (!artifact || !artifact.checksum_sha256 || artifact.size_bytes > 50 * 1024 * 1024)
          throw new Error('MIGRATION_ARTIFACT_NOT_AVAILABLE');
        const registeredFiles = await repository.listFiles(
          input.tenantId,
          input.organizationId,
          input.jobId,
        );
        if (
          !registeredFiles.some(
            (file) =>
              file.object_key === artifact.object_key &&
              file.sha256 === artifact.checksum_sha256 &&
              Number(file.byte_size) === artifact.size_bytes &&
              file.status === 'ready',
          )
        )
          throw new Error('MIGRATION_ARTIFACT_NOT_REGISTERED_WITH_JOB');
        const response = await (runtime.createS3Client?.() ?? s3Client()).send(
          new GetObjectCommand({
            Bucket: artifact.bucket,
            Key: artifact.object_key,
          }),
        );
        const bytes = await readMigrationArtifactBody(response.Body, artifact.size_bytes);
        if (
          bytes.byteLength !== artifact.size_bytes ||
          createHash('sha256').update(bytes).digest('hex') !== artifact.checksum_sha256
        )
          throw new Error('MIGRATION_ARTIFACT_INTEGRITY_FAILED');
        if (job.source_system === 'generic-csv')
          transient = {
            documents: [
              {
                name: artifact.file_name,
                content: new TextDecoder().decode(bytes),
              },
            ],
          };
        else if (job.source_system === 'tixkit-portable') {
          if (configuration.artifactIds.length !== 1) {
            throw new Error('PORTABILITY_IMPORT_REQUIRES_SINGLE_ARTIFACT');
          }
          const trust = (runtime.portableTrust ?? portableImportTrustFromEnvironment)({
            tenantId: input.tenantId,
            organizationId: input.organizationId,
          });
          const portableConfiguration = prepareTixkitPortableUpload(bytes, trust);
          transient = portableConfiguration;
          const evidence = tixkitPortablePreflightEvidence(portableConfiguration, {
            tenantId: input.tenantId,
            organizationId: input.organizationId,
          });
          assertPortableAdapterVersionMatchesManifest(
            job.adapter_version,
            evidence.manifest.format,
          );
          await repository.assertPortableImportLineageEligible({
            tenantId: input.tenantId,
            organizationId: input.organizationId,
            destinationId: trust.destination.deploymentId,
            sourceDeploymentId: evidence.manifest.source.deploymentId,
            sourceTenantId: evidence.manifest.source.tenantId,
            ...(evidence.manifest.source.organizationId
              ? { sourceOrganizationId: evidence.manifest.source.organizationId }
              : {}),
            lineageKind: evidence.manifest.lineage.kind,
            exportSequence: evidence.manifest.source.exportSequence,
            ...(evidence.manifest.lineage.parentBundleId
              ? { parentBundleId: evidence.manifest.lineage.parentBundleId }
              : {}),
            ...(evidence.manifest.lineage.parentManifestSha256
              ? { parentManifestSha256: evidence.manifest.lineage.parentManifestSha256 }
              : {}),
            ...(evidence.manifest.lineage.fromChangeCursor
              ? { fromChangeCursor: evidence.manifest.lineage.fromChangeCursor }
              : {}),
          });
          await repository.recordPortablePreflight({
            tenantId: input.tenantId,
            organizationId: input.organizationId,
            jobId: input.jobId,
            operationId: evidence.preflight.operationId,
            bundleId: evidence.manifest.bundleId,
            manifestSha256: portableManifestSha256(evidence.manifest),
            artifactSha256: artifact.checksum_sha256,
            sourceDeploymentId: evidence.manifest.source.deploymentId,
            sourceChangeCursor: evidence.manifest.lineage.toChangeCursor,
            destinationId: trust.destination.deploymentId,
            manifestJson: canonicalPortableJson(evidence.manifest),
            preflightJson: canonicalPortableJson(evidence.preflight),
            expectedCounts: canonicalPortableJson(evidence.manifest.entityCounts),
            expectedAssets: canonicalPortableJson(
              evidence.manifest.assets.map(({ portableId, sha256 }) => ({ portableId, sha256 })),
            ),
            requiredRebindings: canonicalPortableJson(evidence.preflight.rebindings),
          });
        } else transient = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
        cursorKey = artifact.checksum_sha256;
      }
      const context = {
        tenantId: input.tenantId,
        organizationId: input.organizationId,
        signal,
      };
      const discovery = await adapter.discover(transient, context);
      const extracted = await adapter.extract({
        configuration: transient,
        discovery,
        cursor: cursor.adapterCursor,
        limit: input.chunkSize,
        context,
      });
      const prepared: Array<{
        entityType: string;
        externalId: string;
        sourceData: unknown;
        normalizedData: NormalizedMigrationEntity;
        severity?: string;
        issues: Array<{
          code: string;
          severity: string;
          message: string;
          details?: unknown;
        }>;
      }> = [];
      for (const row of extracted.rows) {
        signal.throwIfAborted();
        const normalized = await adapter.normalize(row, context);
        const issues = [...(await adapter.validate(normalized, context))] as MigrationIssue[];
        prepared.push({
          entityType: normalized.entityType,
          externalId: normalized.externalId,
          sourceData: row.data,
          normalizedData: normalized,
          severity: issues[0]?.severity,
          issues: issues.map(({ code, severity, message, field }) => ({
            code,
            severity,
            message,
            details: field ? { field } : undefined,
          })),
        });
      }
      let next: Cursor | undefined;
      if (extracted.nextCursor) next = { ...cursor, adapterCursor: extracted.nextCursor };
      else if (
        configuration.sourceMode === 'official-api' &&
        configuration.sourceSystem === 'pretix' &&
        cursor.pretixPositionQueue?.length &&
        sourceNext
      )
        next = { ...cursor, upstreamCursor: sourceNext };
      else if (
        configuration.sourceMode === 'official-api' &&
        configuration.sourceSystem === 'pretix' &&
        cursor.pretixPositionQueue?.length
      ) {
        const remaining = cursor.pretixPositionQueue.slice(1);
        next = remaining.length
          ? {
              ...cursor,
              upstreamCursor: undefined,
              pretixPositionQueue: remaining,
            }
          : cursor.pretixListContinuation
            ? {
                resourceIndex: apiResourceIndex,
                upstreamCursor: cursor.pretixListContinuation,
              }
            : apiResourceIndex + 1 < apiResourceCount
              ? { resourceIndex: apiResourceIndex + 1 }
              : undefined;
      } else if (
        configuration.sourceMode === 'official-api' &&
        configuration.sourceSystem === 'pretix' &&
        apiResource?.resource === 'checkinlists'
      ) {
        next = pretixDiscoveredLists?.length
          ? {
              resourceIndex: apiResourceIndex,
              pretixPositionQueue: pretixDiscoveredLists,
              pretixListContinuation: sourceNext,
            }
          : sourceNext
            ? { resourceIndex: apiResourceIndex, upstreamCursor: sourceNext }
            : apiResourceIndex + 1 < apiResourceCount
              ? { resourceIndex: apiResourceIndex + 1 }
              : undefined;
      } else if (configuration.sourceMode === 'official-api' && sourceNext)
        next = { resourceIndex: apiResourceIndex, upstreamCursor: sourceNext };
      else if (
        configuration.sourceMode === 'official-api' &&
        apiResourceIndex + 1 < apiResourceCount
      )
        next = { resourceIndex: apiResourceIndex + 1 };
      else if (
        configuration.sourceMode === 'official-export' &&
        (cursor.artifactIndex ?? 0) + 1 < configuration.artifactIds.length
      )
        next = { artifactIndex: (cursor.artifactIndex ?? 0) + 1 };
      const rawNextCursor = next ? encodeMigrationPreparationCursor(next) : undefined;
      const nextCursor = rawNextCursor
        ? encryptMigrationPreparationCursor(rawNextCursor, cursorKeyMaterial, cursorScope)
        : undefined;
      const result = await repository.persistPreparationChunk({
        tenantId: input.tenantId,
        organizationId: input.organizationId,
        jobId: input.jobId,
        cursorKey: createHash('sha256')
          .update(cursorKey)
          .update('\u0000')
          .update(cursor.adapterCursor ?? 'first')
          .digest('hex'),
        nextCursor,
        startRowNumber: progress.rowNumber,
        completed: !next,
        rows: prepared,
      });
      heartbeat({
        processed: result.rowNumber,
        cursorHash: nextCursor ? createHash('sha256').update(nextCursor).digest('hex') : null,
      });
      return { processed: prepared.length, completed: !next };
    },
    async pause(input) {
      if (input.lifecycleCommand) {
        await persistLifecycleOutcome({
          tenantId: input.tenantId,
          organizationId: input.organizationId,
          jobId: input.jobId,
          commandId: input.lifecycleCommand.commandId,
          lifecycleSequence: input.lifecycleCommand.lifecycleSequence,
          outcome: 'paused',
        });
        return;
      }
      await repository.transitionJob({
        ...input,
        from: ['preparing' as never],
        to: 'paused',
      });
    },
    async resume(input) {
      await persistLifecycleOutcome({
        tenantId: input.tenantId,
        organizationId: input.organizationId,
        jobId: input.jobId,
        commandId: input.lifecycleCommand.commandId,
        lifecycleSequence: input.lifecycleCommand.lifecycleSequence,
        outcome: 'resumed',
      });
    },
    async cancel(input) {
      if (input.lifecycleCommand) {
        await persistLifecycleOutcome({
          tenantId: input.tenantId,
          organizationId: input.organizationId,
          jobId: input.jobId,
          commandId: input.lifecycleCommand.commandId,
          lifecycleSequence: input.lifecycleCommand.lifecycleSequence,
          outcome: 'cancelled',
        });
        return;
      }
      await repository.transitionJob({
        ...input,
        from: ['preparing' as never, 'paused'],
        to: 'cancelled',
      });
    },
    async fail(input) {
      await repository.transitionJob({
        ...input,
        from: ['preparing' as never],
        to: 'failed',
        errorCode: 'MIGRATION_PREPARATION_FAILED',
        errorMessage: input.message,
      });
    },
  };
}
