import { ulid } from 'ulid';
import type { Selectable } from 'kysely';
import type { Database } from '../client.js';
import type { ProviderIncidentEvidenceTable } from '../types/db.js';

export const PROVIDER_INCIDENT_MAX_ACTIVE_PER_TENANT = 1_000;
export const PROVIDER_INCIDENT_SWEEP_MAX_BATCH = 1_000;

export class ProviderIncidentCapacityError extends Error {
  readonly name = 'ProviderIncidentCapacityError';
}

export interface EncryptedProviderIncidentEvidence {
  keyId: string;
  ivB64: string;
  tagB64: string;
  ciphertextB64: string;
}

export interface ProviderIncidentRevealAudit {
  actorType: 'user';
  actorId: string;
  reason: string;
  requestId?: string;
  ip?: string;
  userAgent?: string;
}

export class ProviderIncidentEvidenceRepository {
  constructor(private readonly db: Database) {}

  async capture(input: {
    id?: string;
    tenantId: string;
    organizationId: string;
    provider: string;
    operation: string;
    correlationSha256: string;
    encrypted: EncryptedProviderIncidentEvidence;
    capturedAt: Date;
    expiresAt: Date;
    maxActivePerTenant?: number;
  }) {
    const id = input.id ?? `pie_${ulid()}`;
    validateCapture(input, id);
    const maxActive = boundedInteger(
      input.maxActivePerTenant ?? PROVIDER_INCIDENT_MAX_ACTIVE_PER_TENANT,
      1,
      PROVIDER_INCIDENT_MAX_ACTIVE_PER_TENANT,
      'Provider incident active-row cap',
    );

    return this.db.transaction().execute(async (transaction) => {
      const tenant = await transaction
        .selectFrom('tenants')
        .select('id')
        .where('id', '=', input.tenantId)
        .forUpdate()
        .executeTakeFirst();
      if (!tenant) throw new Error('PROVIDER_INCIDENT_TENANT_NOT_FOUND');

      await transaction
        .deleteFrom('provider_incident_evidence')
        .where('tenant_id', '=', input.tenantId)
        .where('expires_at', '<=', input.capturedAt)
        .execute();

      const duplicate = await transaction
        .selectFrom('provider_incident_evidence')
        .selectAll()
        .where('tenant_id', '=', input.tenantId)
        .where('organization_id', '=', input.organizationId)
        .where('provider', '=', input.provider)
        .where('operation', '=', input.operation)
        .where('correlation_sha256', '=', input.correlationSha256)
        .executeTakeFirst();
      if (duplicate) return duplicate;

      const active = await transaction
        .selectFrom('provider_incident_evidence')
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .where('tenant_id', '=', input.tenantId)
        .where('expires_at', '>', input.capturedAt)
        .executeTakeFirstOrThrow();
      if (Number(active.count) >= maxActive) {
        throw new ProviderIncidentCapacityError('Provider incident active-row cap reached');
      }

      await transaction
        .insertInto('provider_incident_evidence')
        .values({
          id,
          tenant_id: input.tenantId,
          organization_id: input.organizationId,
          provider: input.provider,
          operation: input.operation,
          correlation_sha256: input.correlationSha256,
          key_id: input.encrypted.keyId,
          iv_b64: input.encrypted.ivB64,
          tag_b64: input.encrypted.tagB64,
          ciphertext_b64: input.encrypted.ciphertextB64,
          captured_at: input.capturedAt,
          expires_at: input.expiresAt,
        })
        .execute();
      return transaction
        .selectFrom('provider_incident_evidence')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
    });
  }

  async revealWithAudit<T>(input: {
    id: string;
    tenantId: string;
    organizationId: string;
    now: Date;
    audit: ProviderIncidentRevealAudit;
    decrypt: (row: Readonly<Selectable<ProviderIncidentEvidenceTable>>) => T;
  }): Promise<T | undefined> {
    validateReveal(input);
    return this.db.transaction().execute(async (transaction) => {
      const row = await transaction
        .selectFrom('provider_incident_evidence')
        .selectAll()
        .where('id', '=', input.id)
        .where('tenant_id', '=', input.tenantId)
        .where('organization_id', '=', input.organizationId)
        .where('expires_at', '>', input.now)
        .forUpdate()
        .executeTakeFirst();
      if (!row) return undefined;

      const plaintext = input.decrypt(row);
      await transaction
        .insertInto('audit_logs')
        .values({
          id: `audit_${ulid()}`,
          tenant_id: input.tenantId,
          organization_id: input.organizationId,
          brand_id: null,
          actor_type: input.audit.actorType,
          actor_id: input.audit.actorId,
          action: 'provider_incident.request_id.revealed',
          resource_type: 'provider_incident_evidence',
          resource_id: input.id,
          diff_summary: JSON.stringify({
            reason: input.audit.reason,
            provider: row.provider,
            operation: row.operation,
            correlationSha256: row.correlation_sha256,
          }),
          request_id: input.audit.requestId ?? null,
          ip: input.audit.ip ?? null,
          user_agent: input.audit.userAgent ?? null,
          created_at: input.now,
        })
        .execute();
      return plaintext;
    });
  }

  async findActiveByCorrelation(input: {
    tenantId: string;
    organizationId: string;
    correlationSha256: string;
    now: Date;
  }) {
    boundedToken(input.tenantId, 32, 'Provider incident tenant ID');
    boundedToken(input.organizationId, 32, 'Provider incident organization ID');
    if (!/^sha256:[a-f0-9]{64}$/u.test(input.correlationSha256))
      throw new TypeError('Provider incident correlation must be a SHA-256 token');
    if (!Number.isFinite(input.now.getTime()))
      throw new TypeError('Provider incident lookup time is invalid');
    return this.db
      .selectFrom('provider_incident_evidence')
      .select(['id', 'provider', 'operation', 'correlation_sha256', 'captured_at', 'expires_at'])
      .where('tenant_id', '=', input.tenantId)
      .where('organization_id', '=', input.organizationId)
      .where('correlation_sha256', '=', input.correlationSha256)
      .where('expires_at', '>', input.now)
      .orderBy('captured_at', 'desc')
      .orderBy('id', 'desc')
      .limit(20)
      .execute();
  }

  async sweepExpired(now: Date, batch = 100): Promise<number> {
    if (!Number.isFinite(now.getTime()))
      throw new TypeError('Provider incident sweep time is invalid');
    const limit = boundedInteger(
      batch,
      1,
      PROVIDER_INCIDENT_SWEEP_MAX_BATCH,
      'Provider incident sweep batch',
    );
    return this.db.transaction().execute(async (transaction) => {
      const rows = await transaction
        .selectFrom('provider_incident_evidence')
        .select('id')
        .where('expires_at', '<=', now)
        .orderBy('expires_at', 'asc')
        .orderBy('id', 'asc')
        .limit(limit)
        .forUpdate()
        .execute();
      if (rows.length === 0) return 0;
      await transaction
        .deleteFrom('provider_incident_evidence')
        .where(
          'id',
          'in',
          rows.map((row) => row.id),
        )
        .execute();
      return rows.length;
    });
  }
}

function validateCapture(
  input: Parameters<ProviderIncidentEvidenceRepository['capture']>[0],
  id: string,
): void {
  boundedToken(id, 64, 'Provider incident evidence ID');
  boundedToken(input.tenantId, 32, 'Provider incident tenant ID');
  boundedToken(input.organizationId, 32, 'Provider incident organization ID');
  boundedToken(input.provider, 64, 'Provider incident provider');
  boundedToken(input.operation, 96, 'Provider incident operation');
  if (!/^sha256:[a-f0-9]{64}$/u.test(input.correlationSha256))
    throw new TypeError('Provider incident correlation must be a SHA-256 token');
  boundedToken(input.encrypted.keyId, 64, 'Provider incident key ID');
  boundedBase64Url(input.encrypted.ivB64, 16, 'Provider incident IV');
  boundedBase64Url(input.encrypted.tagB64, 24, 'Provider incident authentication tag');
  boundedBase64Url(input.encrypted.ciphertextB64, 512, 'Provider incident ciphertext');
  if (!Number.isFinite(input.capturedAt.getTime()) || !Number.isFinite(input.expiresAt.getTime()))
    throw new TypeError('Provider incident timestamps are invalid');
  const retention = input.expiresAt.getTime() - input.capturedAt.getTime();
  if (retention < 60_000 || retention > 24 * 60 * 60 * 1_000)
    throw new TypeError('Provider incident retention must be between 1 minute and 24 hours');
}

function validateReveal(input: {
  id: string;
  tenantId: string;
  organizationId: string;
  now: Date;
  audit: ProviderIncidentRevealAudit;
}): void {
  boundedToken(input.id, 64, 'Provider incident evidence ID');
  boundedToken(input.tenantId, 32, 'Provider incident tenant ID');
  boundedToken(input.organizationId, 32, 'Provider incident organization ID');
  boundedText(input.audit.actorId, 255, 'Provider incident audit actor');
  boundedText(input.audit.reason, 256, 'Provider incident audit reason');
  if (!Number.isFinite(input.now.getTime()))
    throw new TypeError('Provider incident reveal time is invalid');
}

function boundedToken(value: string, maximum: number, label: string): void {
  if (!new RegExp(`^[A-Za-z0-9_-]{1,${maximum}}$`, 'u').test(value))
    throw new TypeError(`${label} is invalid`);
}

function boundedText(value: string, maximum: number, label: string): void {
  if (
    !value ||
    value !== value.trim() ||
    Buffer.byteLength(value, 'utf8') > maximum ||
    [...value].some((character) => (character.codePointAt(0) ?? 0) < 32)
  )
    throw new TypeError(`${label} is invalid`);
}

function boundedBase64Url(value: string, maximum: number, label: string): void {
  if (!value || value.length > maximum || !/^[A-Za-z0-9_-]+$/u.test(value))
    throw new TypeError(`${label} is invalid`);
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new TypeError(`${label} must be between ${minimum} and ${maximum}`);
  return value;
}
