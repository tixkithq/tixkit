import { ulid } from 'ulid';
import {
  createIncidentDiagnosticKeyring,
  decryptExactProviderRequestId,
  encryptExactProviderRequestId,
  type EncryptedProviderRequestId,
  type IncidentDiagnosticBinding,
  type IncidentDiagnosticKeyring,
  type ProviderExactRequestIdEvent,
  type ProviderClientRuntime,
} from '@tixkit/provider-clients';
import {
  ProviderIncidentEvidenceRepository,
  type Database,
  type EncryptedProviderIncidentEvidence,
  type ProviderIncidentRevealAudit,
} from '@tixkit/db';

const MAX_CAPTURE_WINDOW_MS = 24 * 60 * 60 * 1_000;
const MIN_RETENTION_MINUTES = 1;
const MAX_RETENTION_MINUTES = 24 * 60;

export type ProviderIncidentEvidenceConfiguration =
  | { enabled: false }
  | {
      enabled: true;
      captureUntil: number;
      retentionMs: number;
      maxActivePerTenant: number;
      keyring: IncidentDiagnosticKeyring;
    };

export type ProviderIncidentEvidenceStore = Pick<
  ProviderIncidentEvidenceRepository,
  'capture' | 'findActiveByCorrelation' | 'revealWithAudit'
>;

export type ProviderIncidentEvidenceRuntime = Readonly<{
  service: ProviderIncidentEvidenceService;
  providerClientRuntime: ProviderClientRuntime;
}>;

const MAX_CONCURRENT_PROVIDER_INCIDENT_CAPTURES = 8;

export function createBoundedProviderIncidentCaptureHandler(
  service: Pick<ProviderIncidentEvidenceService, 'capture'>,
  maximumConcurrent = MAX_CONCURRENT_PROVIDER_INCIDENT_CAPTURES,
): NonNullable<ProviderClientRuntime['onExactRequestId']> {
  if (!Number.isSafeInteger(maximumConcurrent) || maximumConcurrent < 1 || maximumConcurrent > 64)
    throw new TypeError('Provider incident capture concurrency must be between 1 and 64');
  let activeCaptures = 0;
  return (event) => {
    if (activeCaptures >= maximumConcurrent) return;
    activeCaptures += 1;
    return service.capture(event).finally(() => {
      activeCaptures -= 1;
    });
  };
}

export function createProviderIncidentEvidenceRuntime(
  db: Database,
  environment: NodeJS.ProcessEnv = process.env,
  now: () => number = Date.now,
): ProviderIncidentEvidenceRuntime {
  const service = new ProviderIncidentEvidenceService(
    new ProviderIncidentEvidenceRepository(db),
    loadProviderIncidentEvidenceConfiguration(environment, now()),
    now,
  );
  return {
    service,
    providerClientRuntime: {
      onExactRequestId: createBoundedProviderIncidentCaptureHandler(service),
    },
  };
}

export function loadProviderIncidentEvidenceConfiguration(
  environment: NodeJS.ProcessEnv,
  now = Date.now(),
): ProviderIncidentEvidenceConfiguration {
  const enabled = environment.PROVIDER_INCIDENT_SINK_ENABLED?.trim().toLowerCase();
  if (enabled === undefined || enabled === '' || enabled === 'false') return { enabled: false };
  if (enabled !== 'true') throw new Error('PROVIDER_INCIDENT_SINK_ENABLED must be true or false');

  const captureUntil = Date.parse(environment.PROVIDER_INCIDENT_CAPTURE_UNTIL ?? '');
  if (!Number.isFinite(captureUntil) || captureUntil > now + MAX_CAPTURE_WINDOW_MS)
    throw new Error(
      'PROVIDER_INCIDENT_CAPTURE_UNTIL must be a valid time no more than 24 hours in the future',
    );
  const retentionMinutes = integerEnvironment(
    environment.PROVIDER_INCIDENT_RETENTION_MINUTES,
    MIN_RETENTION_MINUTES,
    MAX_RETENTION_MINUTES,
    'PROVIDER_INCIDENT_RETENTION_MINUTES',
  );
  const maxActivePerTenant = integerEnvironment(
    environment.PROVIDER_INCIDENT_MAX_ACTIVE_PER_TENANT,
    1,
    1_000,
    'PROVIDER_INCIDENT_MAX_ACTIVE_PER_TENANT',
  );
  const activeKeyId = environment.PROVIDER_INCIDENT_ACTIVE_KEY_ID?.trim() ?? '';
  let encodedKeys: unknown;
  try {
    encodedKeys = JSON.parse(environment.PROVIDER_INCIDENT_KEYRING_JSON ?? '');
  } catch {
    throw new Error('PROVIDER_INCIDENT_KEYRING_JSON must be a JSON object');
  }
  if (!encodedKeys || typeof encodedKeys !== 'object' || Array.isArray(encodedKeys))
    throw new Error('PROVIDER_INCIDENT_KEYRING_JSON must be a JSON object');
  const keys: Record<string, Uint8Array> = {};
  for (const [keyId, encoded] of Object.entries(encodedKeys)) {
    if (typeof encoded !== 'string')
      throw new Error('Provider incident keys must be base64 strings');
    const key = Buffer.from(encoded, 'base64');
    if (key.byteLength !== 32 || key.toString('base64') !== encoded)
      throw new Error('Provider incident keys must be canonical base64-encoded 32-byte values');
    keys[keyId] = key;
  }
  return {
    enabled: true,
    captureUntil,
    retentionMs: retentionMinutes * 60_000,
    maxActivePerTenant,
    keyring: createIncidentDiagnosticKeyring(activeKeyId, keys),
  };
}

export class ProviderIncidentEvidenceService {
  constructor(
    private readonly store: ProviderIncidentEvidenceStore,
    private readonly configuration: ProviderIncidentEvidenceConfiguration,
    private readonly now: () => number = Date.now,
  ) {}

  async capture(event: Readonly<ProviderExactRequestIdEvent>): Promise<void> {
    if (!this.configuration.enabled) return;
    const capturedAt = this.now();
    if (capturedAt > this.configuration.captureUntil) return;
    const evidenceId = `pie_${ulid(capturedAt)}`;
    const expiresAt = capturedAt + this.configuration.retentionMs;
    const encrypted = encryptExactProviderRequestId(
      event.exactRequestId,
      {
        evidenceId,
        tenantId: event.scope.tenantId,
        organizationId: event.scope.organizationId,
        dependency: event.dependency,
        operation: event.operation,
        capturedAt,
        expiresAt,
      },
      this.configuration.keyring,
    );
    if (encrypted.binding.requestIdHash !== event.requestIdHash)
      throw new Error('Provider incident request ID hash mismatch');
    await this.store.capture({
      id: evidenceId,
      tenantId: event.scope.tenantId,
      organizationId: event.scope.organizationId,
      provider: event.dependency,
      operation: event.operation,
      correlationSha256: event.requestIdHash,
      encrypted: persistedCiphertext(encrypted),
      capturedAt: new Date(capturedAt),
      expiresAt: new Date(expiresAt),
      maxActivePerTenant: this.configuration.maxActivePerTenant,
    });
  }

  async reveal(input: {
    evidenceId: string;
    tenantId: string;
    organizationId: string;
    audit: ProviderIncidentRevealAudit;
  }): Promise<string | undefined> {
    const configuration = this.configuration;
    if (!configuration.enabled) throw new ProviderIncidentEvidenceUnavailableError();
    const now = this.now();
    return this.store.revealWithAudit<string>({
      id: input.evidenceId,
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      now: new Date(now),
      audit: input.audit,
      decrypt: (row) =>
        decryptExactProviderRequestId(
          encryptedFromRow(row),
          bindingFromRow(row),
          configuration.keyring,
          { now },
        ),
    });
  }

  async findActiveByCorrelation(input: {
    tenantId: string;
    organizationId: string;
    correlationSha256: string;
  }) {
    if (!this.configuration.enabled) throw new ProviderIncidentEvidenceUnavailableError();
    return this.store.findActiveByCorrelation({ ...input, now: new Date(this.now()) });
  }
}

export class ProviderIncidentEvidenceUnavailableError extends Error {
  readonly name = 'ProviderIncidentEvidenceUnavailableError';

  constructor() {
    super('Provider incident evidence is unavailable');
  }
}

function persistedCiphertext(
  encrypted: EncryptedProviderRequestId,
): EncryptedProviderIncidentEvidence {
  return {
    keyId: encrypted.keyId,
    ivB64: encrypted.nonce,
    tagB64: encrypted.authenticationTag,
    ciphertextB64: encrypted.ciphertext,
  };
}

type PersistedRow = Parameters<
  Parameters<ProviderIncidentEvidenceRepository['revealWithAudit']>[0]['decrypt']
>[0];

function bindingFromRow(row: PersistedRow): IncidentDiagnosticBinding {
  return {
    evidenceId: row.id,
    tenantId: row.tenant_id,
    organizationId: row.organization_id,
    dependency: row.provider,
    operation: row.operation,
    requestIdHash: row.correlation_sha256,
    capturedAt: new Date(row.captured_at).getTime(),
    expiresAt: new Date(row.expires_at).getTime(),
  };
}

function encryptedFromRow(row: PersistedRow): EncryptedProviderRequestId {
  return {
    version: 1,
    algorithm: 'aes-256-gcm',
    keyId: row.key_id,
    binding: bindingFromRow(row),
    nonce: row.iv_b64,
    ciphertext: row.ciphertext_b64,
    authenticationTag: row.tag_b64,
  };
}

function integerEnvironment(
  value: string | undefined,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (!value || !/^\d+$/u.test(value)) throw new Error(`${name} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum)
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  return parsed;
}
