import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { AuditLogRepository, ImportRepository, OrganizationRepository } from '@tixkit/db';
import {
  assertMigrationSecretReference,
  buildDryRunReport,
  canCommitDryRun,
  canonicalMigrationContentFingerprint,
  migrationAdapter,
  migrationAdapterCatalog,
  parseMigrationPreparationConfiguration,
  MIGRATION_ENTITY_DEPENDENCY_ORDER,
  type DryRunRow,
  type MigrationIssue,
  type NormalizedMigrationEntity,
} from '@tixkit/migration-core';
import { ClerkAuthService } from '../../auth/clerk.js';
import { writeAuditLog } from '../../auth/audit.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@tixkit/domain';
import { resolvePortableCanonicalAdoption } from '@tixkit/workflows';
import {
  approvePortableImport,
  activatePortableImport,
  attestPortableDryRun,
  authorizePortableImportCommit,
  bindPortableImportDestination,
  portableCutoverTrustFromEnvironment,
  portableDryRunAttestationFromEnvironment,
  portableImportCurrentInputHash,
  portableImportRebindingStatus,
  revokePortableImportApproval,
  stablePortableControlHash,
} from '../../services/portable-import-control.js';
import {
  MIGRATION_IMPORT_MAX_BYTES,
  MIGRATION_IMPORT_RETENTION_MS,
  parseUploadArtifactMetadata,
} from '../../services/uploads.js';

class PortableDryRunAttestationUnavailableError extends Error {
  readonly code = 'SERVICE_UNAVAILABLE';
  readonly statusCode = 503;
  readonly expose = true;

  constructor() {
    super('Portable dry-run attestation is unavailable');
  }
}

class PortableCutoverTrustUnavailableError extends Error {
  readonly code = 'SERVICE_UNAVAILABLE';
  readonly statusCode = 503;
  readonly expose = true;

  constructor() {
    super('Portable cutover trust is unavailable');
  }
}

const id = z.string().trim().min(1).max(128);
const organizationIdSchema = id;
const emptyBodySchema = z.object({}).strict();
const portableCutoverProofSchema = z
  .object({
    tenantId: z.string().trim().min(1).max(200),
    deploymentId: z.string().trim().min(1).max(200),
    sourceChangeCursor: z.string().trim().min(1).max(200),
    observedAt: z.string().datetime({ offset: true }),
    sourceFrozen: z.boolean(),
    bundleId: z.string().trim().min(1).max(200),
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    destinationId: z.string().trim().min(1).max(200),
    operationId: z.string().trim().min(1).max(200),
    issuedAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
    nonce: z.string().trim().min(1).max(128),
    receiptSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    keyId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u),
    signature: z.string().trim().min(1).max(512),
  })
  .strict();
const createJobSchema = z
  .object({
    organizationId: organizationIdSchema,
    sourceSystem: z.string().trim().min(1).max(80),
    adapterVersion: z.string().trim().min(1).max(100),
    mode: z.enum(['dry-run', 'commit']).default('dry-run'),
    configuration: z.record(z.string(), z.unknown()),
    credentialId: z
      .string()
      .trim()
      .regex(/^mcred_[A-Za-z0-9_-]{8,128}$/u)
      .optional(),
  })
  .strict();

export type PortableMigrationIdempotencyIdentity = {
  sourceSystem: string;
  adapterVersion: string;
  mode: string;
  configuration: unknown;
};

type MigrationJobIdempotencyIdentity = PortableMigrationIdempotencyIdentity & {
  requestedBy: string;
};

function migrationJobRequestFingerprint(identity: MigrationJobIdempotencyIdentity): string {
  return canonicalMigrationContentFingerprint({
    attributes: {
      sourceSystem: identity.sourceSystem,
      adapterVersion: identity.adapterVersion,
      mode: identity.mode,
      configuration: identity.configuration,
      requestedBy: identity.requestedBy,
    },
  });
}

function assertMigrationJobIdempotency(
  existing: MigrationJobIdempotencyIdentity,
  expectedFingerprint: string,
): void {
  if (migrationJobRequestFingerprint(existing) !== expectedFingerprint) {
    throw new ConflictError('Idempotency-Key was already used for a different migration job');
  }
}

export function portableMigrationRequestFingerprint(
  identity: PortableMigrationIdempotencyIdentity,
): string {
  return canonicalMigrationContentFingerprint({
    attributes: {
      sourceSystem: identity.sourceSystem,
      adapterVersion: identity.adapterVersion,
      mode: identity.mode,
      configuration: identity.configuration,
    },
  });
}

export function assertPortableMigrationIdempotency(
  existing: PortableMigrationIdempotencyIdentity,
  expectedFingerprint: string,
): void {
  if (portableMigrationRequestFingerprint(existing) !== expectedFingerprint) {
    throw new ConflictError('Idempotency-Key was already used for a different portable import');
  }
}
const fileSchema = z
  .object({
    uploadArtifactId: z.string().trim().min(1).max(128),
  })
  .strict();
const credentialSchema = z
  .object({
    organizationId: organizationIdSchema,
    sourceSystem: z.string().trim().min(1).max(80),
    secretReference: z
      .string()
      .min(1)
      .max(1000)
      .superRefine((value, context) => {
        try {
          assertMigrationSecretReference(value);
        } catch (error) {
          context.addIssue({
            code: 'custom',
            message: error instanceof Error ? error.message : 'Invalid secretReference',
          });
        }
      }),
    expiresAt: z.string().datetime(),
  })
  .strict();
const credentialIdSchema = z
  .string()
  .trim()
  .regex(/^mcred_[A-Za-z0-9_-]{8,128}$/u);
const revokeCredentialParamsSchema = z.object({ credentialId: credentialIdSchema }).strict();
const revokeCredentialQuerySchema = z.object({ organizationId: organizationIdSchema }).strict();
const mappingSchema = z
  .object({
    organizationId: organizationIdSchema,
    sourceSystem: z.string().trim().min(1).max(80),
    name: z.string().trim().min(1).max(120),
    entityType: z.string().trim().min(1).max(80),
    mapping: z
      .record(
        z
          .string()
          .trim()
          .min(1)
          .max(120)
          .regex(/^[A-Za-z0-9_.:[\]-]+$/u),
        z.union([
          z.string().trim().min(1).max(160),
          z.array(z.string().trim().min(1).max(160)).max(20),
        ]),
      )
      .refine((value) => Object.keys(value).length <= 200, 'Mapping has too many fields'),
  })
  .strict();

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new ValidationError('Invalid migration request', result.error.flatten());
  return result.data;
}

function parseJson(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function migrationOfficialExportArtifactIds(job: {
  configuration: string | null;
  source_system: string;
}): readonly string[] {
  const raw = parseJson(job.configuration);
  const configurationRecord =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const { credentialId: _credentialId, ...sourceConfiguration } = configurationRecord;
  const configuration = parseMigrationPreparationConfiguration(
    { ...sourceConfiguration, sourceSystem: job.source_system },
    job.source_system,
  );
  return configuration.sourceMode === 'official-export' ? configuration.artifactIds : [];
}

const sensitiveKey =
  /(?:api[-_]?key|authorization|bearer|credential|password|private[-_]?key|secret|token)/iu;
const piiKey = /(?:address|attendee|buyer|date[-_]?of[-_]?birth|dob|email|name|phone)/iu;

export function assertMigrationConfigurationSecretFree(
  value: unknown,
  path = 'configuration',
): void {
  if (
    typeof value === 'string' &&
    /(?:\bBearer\s+|\b(?:sk|pk)_(?:live|test)_|\btk_[A-Za-z0-9_-]{16,}|\bwhsec_)/u.test(value)
  ) {
    throw new ValidationError(`${path} contains credential material; use credentialId`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertMigrationConfigurationSecretFree(item, `${path}[${index}]`),
    );
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (sensitiveKey.test(key)) {
      throw new ValidationError(`${path}.${key} must use credentialId instead of inline secrets`);
    }
    assertMigrationConfigurationSecretFree(nested, `${path}.${key}`);
  }
}

export function assertMigrationMappingSafe(mapping: Record<string, string | string[]>): void {
  const literalPii = /(?:[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\+?\d[\d ().-]{6,}\d)/iu;
  for (const [key, rawValues] of Object.entries(mapping)) {
    if (sensitiveKey.test(key)) {
      throw new ValidationError(`mapping.${key} cannot contain credential fields`);
    }
    for (const value of Array.isArray(rawValues) ? rawValues : [rawValues]) {
      if (literalPii.test(value)) {
        throw new ValidationError(`mapping.${key} cannot contain literal personal data`);
      }
      assertMigrationConfigurationSecretFree(value, `mapping.${key}`);
    }
  }
}

const migrationDigestKeys = new Set([
  'approvalDigest',
  'artifactSha256',
  'beforeCanonicalSha256',
  'checksumSha256',
  'claimOwnerSha256',
  'configurationSha256',
  'inputHash',
  'inputSha256',
  'manifestSha256',
  'receiptSha256',
]);

export function redactMigrationReportValue(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) return value.map((item) => redactMigrationReportValue(item));
  if (typeof value === 'string') {
    if (key && migrationDigestKeys.has(key) && /^[a-f0-9]{64}$/u.test(value)) return value;
    return value
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, '[REDACTED_EMAIL]')
      .replace(/(?:\+?\d[\d ().-]{6,}\d)/gu, '[REDACTED_PHONE]')
      .replace(
        /(?:\bBearer\s+\S+|\b(?:sk|pk)_(?:live|test)_\S+|\btk_[A-Za-z0-9_-]{16,}|\bwhsec_\S+)/gu,
        '[REDACTED_CREDENTIAL]',
      );
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      sensitiveKey.test(key) || piiKey.test(key)
        ? '[REDACTED]'
        : redactMigrationReportValue(nested, key),
    ]),
  );
}

function stableHash(value: unknown): string {
  return stablePortableControlHash(value);
}

function serializeMigrationFile(file: Record<string, unknown>) {
  return {
    id: file.id,
    jobId: file.import_job_id,
    mediaType: file.media_type,
    byteSize: Number(file.byte_size),
    sha256: file.sha256,
    status: file.status,
    createdAt: file.created_at,
  };
}

export function sanitizeDryRunReport(
  report: Record<string, unknown>,
  correlations: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const sanitized = redactMigrationReportValue(report) as Record<string, unknown>;
  const issues = Array.isArray(report.issues) ? report.issues : [];
  const duplicateExternalIds = Array.isArray(report.duplicateExternalIds)
    ? report.duplicateExternalIds
    : [];
  const mappingFailures = Array.isArray(report.mappingFailures) ? report.mappingFailures : [];
  const {
    duplicateExternalIds: _duplicateExternalIds,
    mappingFailures: _mappingFailures,
    rows: _rows,
    issues: _issues,
    ...publicSummary
  } = sanitized;
  return {
    ...publicSummary,
    issues: issues.map((rawIssue) => {
      const issue = rawIssue as Record<string, unknown>;
      const entityType = typeof issue.entityType === 'string' ? issue.entityType : '';
      const externalId = typeof issue.externalId === 'string' ? issue.externalId : '';
      const sourcePosition = typeof issue.sourcePosition === 'string' ? issue.sourcePosition : '';
      const correlationId =
        correlations.get(`${entityType}:${externalId}`) ??
        correlations.get(`${entityType}:${sourcePosition}`);
      const { externalId: _externalId, sourcePosition: _sourcePosition, ...publicIssue } = issue;
      return {
        ...(redactMigrationReportValue(publicIssue) as Record<string, unknown>),
        ...(correlationId ? { correlationId } : {}),
      };
    }),
    duplicateCount: duplicateExternalIds.length,
    mappingFailureCount: mappingFailures.length,
  };
}

export async function unresolvedMigrationDependencies(
  entity: NormalizedMigrationEntity,
  currentJobEntities: ReadonlySet<string>,
  resolvesExternalReference: (entityType: string, externalId: string) => Promise<boolean>,
): Promise<NonNullable<NormalizedMigrationEntity['dependencies']>> {
  const unresolved: Array<NonNullable<NormalizedMigrationEntity['dependencies']>[number]> = [];
  for (const dependency of entity.dependencies ?? []) {
    const key = `${dependency.entityType}:${dependency.externalId}`;
    if (currentJobEntities.has(key)) continue;
    if (!(await resolvesExternalReference(dependency.entityType, dependency.externalId)))
      unresolved.push(dependency);
  }
  return unresolved;
}

function serializeJob(job: Record<string, unknown>) {
  const {
    configuration: rawConfiguration,
    preparation_cursor: _preparationCursor,
    ...safeJob
  } = job;
  const configuration = parseJson(rawConfiguration as string | null);
  return {
    ...safeJob,
    configurationHash: stableHash(configuration),
    credentialConfigured:
      configuration !== null &&
      typeof configuration === 'object' &&
      typeof (configuration as Record<string, unknown>).credentialId === 'string',
    summary: parseJson(job.summary as string | null),
  };
}

function requireMigrationPermission(
  principal: NonNullable<FastifyRequest['principal']>,
  permission: 'migrations.read' | 'migrations.write' | 'migrations.commit' | 'migrations.rollback',
) {
  ClerkAuthService.requirePermission(principal, permission);
  if (principal.brandIds?.length || principal.eventIds?.length) {
    throw new ForbiddenError('Migration jobs require organization-wide access');
  }
}

async function scopedJob(repo: ImportRepository, request: FastifyRequest, jobId: string) {
  const principal = request.principal!;
  const requestedOrganizationId = (request.query as { organizationId?: string }).organizationId;
  const organizationIds = requestedOrganizationId
    ? [requestedOrganizationId]
    : principal.organizationIds;
  if (organizationIds.length === 0) {
    throw new ValidationError('organizationId is required for migration job access');
  }
  if (requestedOrganizationId) {
    ClerkAuthService.requireOrganizationScope(principal, requestedOrganizationId);
  }
  let job: Awaited<ReturnType<ImportRepository['findJob']>> | undefined;
  let organizationId: string | undefined;
  for (const candidate of organizationIds) {
    job = await repo.findJob(principal.tenantId, candidate, jobId);
    if (job) {
      organizationId = candidate;
      break;
    }
  }
  if (!job) throw new NotFoundError('MigrationJob', jobId);
  if (!organizationId) throw new NotFoundError('MigrationJob', jobId);
  return { job, organizationId };
}

async function auditMutation(
  app: Parameters<FastifyPluginAsync>[0],
  request: FastifyRequest,
  organizationId: string,
  jobId: string,
  action: string,
  diffSummary: Record<string, unknown> = {},
) {
  await writeAuditLog(new AuditLogRepository(app.context.db), request, request.principal!, {
    action,
    organizationId,
    resourceType: 'MigrationJob',
    resourceId: jobId,
    diffSummary,
  });
}

async function loadAllRows(
  repository: ImportRepository,
  scope: { tenantId: string; organizationId: string; jobId: string },
) {
  const rows = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const page = await repository.listRows({ ...scope, limit: pageSize, offset });
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

function normalizedEntity(value: string | null): NormalizedMigrationEntity | undefined {
  const parsed = parseJson(value);
  if (!parsed || typeof parsed !== 'object') return undefined;
  const candidate = parsed as Partial<NormalizedMigrationEntity>;
  return typeof candidate.entityType === 'string' &&
    MIGRATION_ENTITY_DEPENDENCY_ORDER.includes(candidate.entityType as never) &&
    typeof candidate.externalId === 'string' &&
    typeof candidate.sourcePosition === 'string' &&
    candidate.attributes !== null &&
    typeof candidate.attributes === 'object'
    ? (candidate as NormalizedMigrationEntity)
    : undefined;
}

export const migrationRoutes: FastifyPluginAsync = async (app) => {
  const repo = () => new ImportRepository(app.context.db);
  const portableAttestation = () =>
    app.context.portableDryRunAttestation ?? portableDryRunAttestationFromEnvironment();
  const portableCutoverTrust = () =>
    app.context.portableCutoverTrust ?? portableCutoverTrustFromEnvironment();

  app.get('/migration-adapters', async (request) => {
    requireMigrationPermission(request.principal!, 'migrations.read');
    return { items: migrationAdapterCatalog() };
  });

  app.post('/migration-credentials', async (request, reply) => {
    const principal = request.principal!;
    requireMigrationPermission(principal, 'migrations.write');
    const body = parse(credentialSchema, request.body);
    ClerkAuthService.requireOrganizationScope(principal, body.organizationId);
    const expiresAt = new Date(body.expiresAt);
    if (expiresAt <= new Date()) throw new ValidationError('Migration credential must expire');
    const credential = await repo().createCredential({
      tenantId: principal.tenantId,
      organizationId: body.organizationId,
      sourceSystem: body.sourceSystem,
      secretReference: body.secretReference,
      expiresAt,
      createdBy: principal.id,
    });
    await writeAuditLog(new AuditLogRepository(app.context.db), request, principal, {
      action: 'migration_credential.created',
      organizationId: body.organizationId,
      resourceType: 'MigrationCredential',
      resourceId: credential.id,
      diffSummary: { sourceSystem: body.sourceSystem, expiresAt: body.expiresAt },
    });
    return reply.status(201).send({
      id: credential.id,
      organizationId: credential.organization_id,
      sourceSystem: credential.source_system,
      status: credential.status,
      expiresAt: credential.expires_at,
    });
  });

  app.delete('/migration-credentials/:credentialId', async (request, reply) => {
    const principal = request.principal!;
    requireMigrationPermission(principal, 'migrations.write');
    const { credentialId } = parse(revokeCredentialParamsSchema, request.params);
    const { organizationId } = parse(revokeCredentialQuerySchema, request.query);
    ClerkAuthService.requireOrganizationScope(principal, organizationId);
    const revoked = await repo().revokeCredential({
      tenantId: principal.tenantId,
      organizationId,
      credentialId,
    });
    if (!revoked) throw new NotFoundError('MigrationCredential', credentialId);
    await writeAuditLog(new AuditLogRepository(app.context.db), request, principal, {
      action: 'migration_credential.revoked',
      organizationId,
      resourceType: 'MigrationCredential',
      resourceId: credentialId,
    });
    return reply.status(204).send();
  });

  app.post('/migration-jobs', async (request, reply) => {
    const principal = request.principal!;
    requireMigrationPermission(principal, 'migrations.write');
    const body = parse(createJobSchema, request.body);
    if (body.sourceSystem === 'tixkit-portable') {
      throw new ValidationError('Portable imports must use POST /portable-migration-jobs');
    }
    assertMigrationConfigurationSecretFree(body.configuration);
    let configuration;
    try {
      configuration = parseMigrationPreparationConfiguration(body.configuration, body.sourceSystem);
    } catch (error) {
      throw new ValidationError(
        error instanceof Error ? error.message : 'Invalid migration preparation configuration',
      );
    }
    const adapter = migrationAdapterCatalog().find(
      (candidate) => candidate.id === body.sourceSystem,
    );
    if (!adapter) throw new ValidationError(`Unsupported migration source: ${body.sourceSystem}`);
    if (!adapter.supportedVersions.includes(body.adapterVersion)) {
      throw new ValidationError(
        `Unsupported ${body.sourceSystem} adapter version: ${body.adapterVersion}`,
      );
    }
    if (configuration.sourceMode === 'official-api' && !body.credentialId) {
      throw new ValidationError('credentialId is required for official-api migration jobs');
    }
    if (!adapter.sourceModes.includes(configuration.sourceMode)) {
      throw new ValidationError(
        `${body.sourceSystem} does not support source mode ${configuration.sourceMode}`,
      );
    }
    const organization = await new OrganizationRepository(app.context.db).findById(
      body.organizationId,
    );
    if (!organization) throw new NotFoundError('Organization', body.organizationId);
    ClerkAuthService.requireResourceTenant(
      principal,
      organization,
      'Organization',
      body.organizationId,
    );
    ClerkAuthService.requireOrganizationScope(principal, body.organizationId);
    if (
      body.credentialId &&
      !(await repo().findActiveCredential({
        tenantId: principal.tenantId,
        organizationId: body.organizationId,
        credentialId: body.credentialId,
        sourceSystem: body.sourceSystem,
      }))
    ) {
      throw new NotFoundError('MigrationCredential', body.credentialId);
    }
    const key = String(request.headers['idempotency-key'] ?? '').trim();
    if (!key || key.length > 255)
      throw new ValidationError('A valid Idempotency-Key header is required');
    const storedConfiguration = {
      ...configuration,
      ...(body.credentialId ? { credentialId: body.credentialId } : {}),
    };
    const expectedFingerprint = migrationJobRequestFingerprint({
      sourceSystem: body.sourceSystem,
      adapterVersion: body.adapterVersion,
      mode: body.mode,
      configuration: storedConfiguration,
      requestedBy: principal.id,
    });
    const assertReplayIdentity = (candidate: Awaited<ReturnType<ImportRepository['findJob']>>) => {
      if (!candidate) throw new Error('Migration job replay candidate is missing');
      assertMigrationJobIdempotency(
        {
          sourceSystem: candidate.source_system,
          adapterVersion: candidate.adapter_version,
          mode: candidate.mode,
          configuration: candidate.configuration ? JSON.parse(candidate.configuration) : null,
          requestedBy: candidate.requested_by,
        },
        expectedFingerprint,
      );
      return candidate;
    };
    let job;
    try {
      job = await app.context.db.transaction().execute(async (transaction) => {
        const repository = new ImportRepository(transaction as typeof app.context.db);
        const result = await repository.createJobWithDisposition({
          tenantId: principal.tenantId,
          organizationId: body.organizationId,
          sourceSystem: body.sourceSystem,
          adapterVersion: body.adapterVersion,
          mode: body.mode,
          idempotencyKey: key,
          requestedBy: principal.id,
          configuration: storedConfiguration,
        });
        const created = assertReplayIdentity(result.job);
        if (!result.created) return created;
        await writeAuditLog(
          new AuditLogRepository(transaction as typeof app.context.db),
          request,
          principal,
          {
            action: 'migration_job.created',
            organizationId: body.organizationId,
            resourceType: 'MigrationJob',
            resourceId: created.id,
            diffSummary: { sourceSystem: body.sourceSystem, mode: body.mode },
          },
          { failClosed: true },
        );
        return created;
      });
    } catch (error) {
      const raced = await repo().findJobByIdempotencyKey(
        principal.tenantId,
        body.organizationId,
        key,
      );
      if (!raced) throw error;
      job = assertReplayIdentity(raced);
    }
    return reply.status(201).send(serializeJob(job as unknown as Record<string, unknown>));
  });

  app.post('/portable-migration-jobs', async (request, reply) => {
    const principal = request.principal!;
    requireMigrationPermission(principal, 'migrations.write');
    const body = parse(createJobSchema, request.body);
    if (body.sourceSystem !== 'tixkit-portable') {
      throw new ValidationError('Portable migration sourceSystem must be tixkit-portable');
    }
    assertMigrationConfigurationSecretFree(body.configuration);
    let configuration;
    try {
      configuration = parseMigrationPreparationConfiguration(body.configuration, 'tixkit-portable');
    } catch (error) {
      throw new ValidationError(
        error instanceof Error ? error.message : 'Invalid portable migration configuration',
      );
    }
    if (
      configuration.sourceMode !== 'official-export' ||
      configuration.sourceSystem !== 'tixkit-portable'
    ) {
      throw new ValidationError('Portable migrations require one official-export artifact');
    }
    if (body.credentialId) {
      throw new ValidationError('Portable migrations do not accept source credentials');
    }
    if (body.mode !== 'dry-run') {
      throw new ValidationError(
        'Portable migration commit is unavailable until cutover, rebinding, and reconciliation gates pass',
      );
    }
    const adapter = migrationAdapter('tixkit-portable');
    if (!adapter.supportedVersions.includes(body.adapterVersion)) {
      throw new ValidationError(
        `Unsupported tixkit-portable adapter version: ${body.adapterVersion}`,
      );
    }
    const organization = await new OrganizationRepository(app.context.db).findById(
      body.organizationId,
    );
    if (!organization) throw new NotFoundError('Organization', body.organizationId);
    ClerkAuthService.requireResourceTenant(
      principal,
      organization,
      'Organization',
      body.organizationId,
    );
    ClerkAuthService.requireOrganizationScope(principal, body.organizationId);
    const key = String(request.headers['idempotency-key'] ?? '').trim();
    if (!key || key.length > 255) {
      throw new ValidationError('A valid Idempotency-Key header is required');
    }
    const operationKey = `portable:${createHash('sha256').update(key).digest('hex')}`;
    const expectedFingerprint = migrationJobRequestFingerprint({
      sourceSystem: 'tixkit-portable',
      adapterVersion: body.adapterVersion,
      mode: 'dry-run',
      configuration,
      requestedBy: principal.id,
    });
    const assertReplayIdentity = (candidate: Awaited<ReturnType<ImportRepository['findJob']>>) => {
      if (!candidate) throw new Error('Portable migration replay candidate is missing');
      assertMigrationJobIdempotency(
        {
          sourceSystem: candidate.source_system,
          adapterVersion: candidate.adapter_version,
          mode: candidate.mode,
          configuration: candidate.configuration ? JSON.parse(candidate.configuration) : null,
          requestedBy: candidate.requested_by,
        },
        expectedFingerprint,
      );
      return candidate;
    };
    let job;
    try {
      job = await app.context.db.transaction().execute(async (transaction) => {
        const repository = new ImportRepository(transaction as typeof app.context.db);
        const result = await repository.createJobWithDisposition({
          tenantId: principal.tenantId,
          organizationId: body.organizationId,
          sourceSystem: 'tixkit-portable',
          adapterVersion: body.adapterVersion,
          mode: 'dry-run',
          idempotencyKey: operationKey,
          requestedBy: principal.id,
          configuration,
        });
        const created = assertReplayIdentity(result.job);
        if (!result.created) return created;
        await writeAuditLog(
          new AuditLogRepository(transaction as typeof app.context.db),
          request,
          principal,
          {
            action: 'migration_job.created',
            organizationId: body.organizationId,
            resourceType: 'MigrationJob',
            resourceId: created.id,
            diffSummary: { sourceSystem: 'tixkit-portable', mode: 'dry-run' },
          },
          { failClosed: true },
        );
        return created;
      });
    } catch (error) {
      const raced = await repo().findJobByIdempotencyKey(
        principal.tenantId,
        body.organizationId,
        operationKey,
      );
      if (!raced) throw error;
      job = assertReplayIdentity(raced);
    }
    return reply.status(201).send(serializeJob(job as unknown as Record<string, unknown>));
  });

  app.post('/migration-jobs/:jobId/prepare', async (request, reply) => {
    const principal = request.principal!;
    requireMigrationPermission(principal, 'migrations.write');
    const { jobId } = request.params as { jobId: string };
    if (request.body && Object.keys(request.body as object).length > 0)
      throw new ValidationError('Migration preparation request body must be empty');
    const repository = repo();
    const { job, organizationId } = await scopedJob(repository, request, jobId);
    if (!['pending', 'failed'].includes(job.status))
      throw new ConflictError('Migration preparation cannot start in the current status');
    let preparationConfiguration;
    try {
      preparationConfiguration = parseMigrationPreparationConfiguration(
        {
          ...(parseJson(job.configuration) as Record<string, unknown> | null),
          sourceSystem: job.source_system,
        },
        job.source_system,
      );
    } catch (error) {
      throw new ValidationError(
        error instanceof Error ? error.message : 'Invalid migration preparation configuration',
      );
    }
    if (preparationConfiguration.sourceMode === 'official-export') {
      try {
        await repository.acquireMigrationArtifactsForState({
          tenantId: principal.tenantId,
          organizationId,
          jobId,
          artifactIds: preparationConfiguration.artifactIds,
          targetState: 'preparing',
          transition: false,
        });
      } catch (error) {
        throw new ConflictError(
          error instanceof Error ? error.message : 'Migration artifact is unavailable',
        );
      }
    }
    await writeAuditLog(
      new AuditLogRepository(app.context.db),
      request,
      principal,
      {
        action: 'migration_job.prepare_requested',
        organizationId,
        resourceType: 'MigrationJob',
        resourceId: jobId,
      },
      { failClosed: true },
    );
    await app.context.temporalClient.startMigrationPreparation({
      tenantId: principal.tenantId,
      organizationId,
      jobId,
    });
    return reply.status(202).send({ jobId, status: 'preparing' });
  });

  app.get('/migration-jobs', async (request) => {
    const principal = request.principal!;
    requireMigrationPermission(principal, 'migrations.read');
    const query = request.query as { limit?: string; offset?: string; organizationId?: string };
    if (query.organizationId)
      ClerkAuthService.requireOrganizationScope(principal, query.organizationId);
    const organizationIds = query.organizationId
      ? [query.organizationId]
      : principal.organizationIds;
    if (organizationIds.length === 0) {
      throw new ValidationError('organizationId is required to list migration jobs');
    }
    const pages = await Promise.all(
      organizationIds.map((organizationId) =>
        repo().listJobs({
          tenantId: principal.tenantId,
          organizationId,
          limit: Number(query.limit) || 50,
          offset: Number(query.offset) || 0,
        }),
      ),
    );
    return {
      items: pages.flat().map((job) => serializeJob(job as unknown as Record<string, unknown>)),
    };
  });

  app.get('/migration-jobs/:jobId', async (request) => {
    const principal = request.principal!;
    requireMigrationPermission(principal, 'migrations.read');
    const { jobId } = request.params as { jobId: string };
    const { job } = await scopedJob(repo(), request, jobId);
    return serializeJob(job as unknown as Record<string, unknown>);
  });

  app.post('/migration-jobs/:jobId/files', async (request, reply) => {
    const principal = request.principal!;
    requireMigrationPermission(principal, 'migrations.write');
    const { jobId } = request.params as { jobId: string };
    const repository = repo();
    const { job, organizationId } = await scopedJob(repository, request, jobId);
    if (!['pending', 'discovering', 'extracting'].includes(job.status))
      throw new ConflictError('Files cannot be added in the current migration status');
    const body = parse(fileSchema, request.body);
    if (job.source_system === 'tixkit-portable') {
      let configuration;
      try {
        configuration = parseMigrationPreparationConfiguration(
          {
            ...(parseJson(job.configuration) as Record<string, unknown> | null),
            sourceSystem: job.source_system,
          },
          'tixkit-portable',
        );
      } catch (error) {
        throw new ValidationError(
          error instanceof Error ? error.message : 'Invalid portable migration configuration',
        );
      }
      if (
        configuration.sourceMode !== 'official-export' ||
        configuration.artifactIds.length !== 1 ||
        configuration.artifactIds[0] !== body.uploadArtifactId
      ) {
        throw new ValidationError(
          'Portable migrations accept only their configured upload artifact',
        );
      }
    }
    const registeredAt = new Date();
    const artifact = await app.context.db
      .selectFrom('upload_artifacts')
      .select([
        'id',
        'object_key',
        'file_name',
        'content_type',
        'size_bytes',
        'checksum_sha256',
        'metadata',
      ])
      .where('id', '=', body.uploadArtifactId)
      .where('tenant_id', '=', principal.tenantId)
      .where('organization_id', '=', organizationId)
      .where('purpose', '=', 'migration_import')
      .where('status', '=', 'uploaded')
      .where('scan_status', '=', 'clean')
      .where('expires_at', '>', registeredAt)
      .executeTakeFirst();
    if (!artifact?.checksum_sha256 || !/^[a-f0-9]{64}$/u.test(artifact.checksum_sha256)) {
      throw new NotFoundError('MigrationUploadArtifact', body.uploadArtifactId);
    }
    const artifactSha256 = artifact.checksum_sha256;
    if (artifact.size_bytes > MIGRATION_IMPORT_MAX_BYTES) {
      throw new ValidationError('Migration upload artifact exceeds the 50 MiB import limit');
    }
    if (
      job.source_system === 'tixkit-portable' &&
      artifact.content_type !== 'application/vnd.tixkit.portable+json'
    ) {
      throw new ValidationError(
        'Portable migration uploads require application/vnd.tixkit.portable+json',
      );
    }
    const file = await app.context.db.transaction().execute(async (transaction) => {
      const consumption = await transaction
        .updateTable('upload_artifacts')
        .set({
          metadata: JSON.stringify({
            ...parseUploadArtifactMetadata(artifact.metadata),
            migrationImport: { jobId, registeredAt: registeredAt.toISOString() },
          }),
          consumed_at: registeredAt,
          expires_at: new Date(registeredAt.getTime() + MIGRATION_IMPORT_RETENTION_MS),
          updated_at: registeredAt,
        })
        .where('id', '=', artifact.id)
        .where('tenant_id', '=', principal.tenantId)
        .where('organization_id', '=', organizationId)
        .where('purpose', '=', 'migration_import')
        .where('status', '=', 'uploaded')
        .where('scan_status', '=', 'clean')
        .where('consumed_at', 'is', null)
        .where('expires_at', '>', registeredAt)
        .executeTakeFirst();
      if (Number(consumption.numUpdatedRows) !== 1) {
        throw new ConflictError('Migration upload artifact was already registered');
      }
      const file = await new ImportRepository(transaction as typeof app.context.db).addFile({
        tenantId: principal.tenantId,
        organizationId,
        jobId,
        objectKey: artifact.object_key,
        originalName: artifact.file_name,
        mediaType: artifact.content_type,
        byteSize: artifact.size_bytes,
        sha256: artifactSha256,
      });
      await new AuditLogRepository(transaction as typeof app.context.db).create({
        tenantId: principal.tenantId,
        organizationId,
        actorType: principal.type,
        actorId: principal.id,
        action: 'migration_job.file_registered',
        resourceType: 'MigrationJob',
        resourceId: jobId,
        diffSummary: {
          fileId: file.id,
          uploadArtifactId: artifact.id,
          byteSize: artifact.size_bytes,
          sha256: artifactSha256,
        },
        requestId: request.id,
        ip: request.ip,
        userAgent: request.headers['user-agent'],
      });
      return file;
    });
    return reply
      .status(201)
      .send(serializeMigrationFile(file as unknown as Record<string, unknown>));
  });

  app.get('/migration-jobs/:jobId/files', async (request) => {
    const principal = request.principal!;
    requireMigrationPermission(principal, 'migrations.read');
    const { jobId } = request.params as { jobId: string };
    const repository = repo();
    const { organizationId } = await scopedJob(repository, request, jobId);
    const files = await repository.listFiles(principal.tenantId, organizationId, jobId);
    return {
      items: files.map((file) =>
        serializeMigrationFile(file as unknown as Record<string, unknown>),
      ),
    };
  });

  app.post('/migration-mappings', async (request, reply) => {
    const principal = request.principal!;
    requireMigrationPermission(principal, 'migrations.write');
    const body = parse(mappingSchema, request.body);
    assertMigrationMappingSafe(body.mapping);
    const organization = await new OrganizationRepository(app.context.db).findById(
      body.organizationId,
    );
    if (!organization) throw new NotFoundError('Organization', body.organizationId);
    ClerkAuthService.requireResourceTenant(
      principal,
      organization,
      'Organization',
      body.organizationId,
    );
    ClerkAuthService.requireOrganizationScope(principal, body.organizationId);
    const mapping = await app.context.db.transaction().execute(async (transaction) => {
      const created = await new ImportRepository(transaction as typeof app.context.db).saveMapping({
        ...body,
        tenantId: principal.tenantId,
        createdBy: principal.id,
      });
      await writeAuditLog(
        new AuditLogRepository(transaction as typeof app.context.db),
        request,
        principal,
        {
          action: 'migration_mapping.created',
          organizationId: body.organizationId,
          resourceType: 'MigrationMapping',
          resourceId: created.id,
          diffSummary: { sourceSystem: body.sourceSystem, entityType: body.entityType },
        },
        { failClosed: true },
      );
      return created;
    });
    return reply.status(201).send({
      ...mapping,
      mapping: redactMigrationReportValue(parseJson(mapping.mapping)),
    });
  });

  app.get('/migration-mappings', async (request) => {
    const principal = request.principal!;
    requireMigrationPermission(principal, 'migrations.read');
    const { organizationId, sourceSystem } = request.query as {
      organizationId: string;
      sourceSystem?: string;
    };
    ClerkAuthService.requireOrganizationScope(principal, organizationId);
    const items = await repo().listMappings(principal.tenantId, organizationId, sourceSystem);
    return {
      items: items.map((item) => ({
        ...item,
        mapping: redactMigrationReportValue(parseJson(item.mapping)),
      })),
    };
  });

  app.get('/migration-jobs/:jobId/rows', async (request) => {
    const principal = request.principal!;
    requireMigrationPermission(principal, 'migrations.read');
    const { jobId } = request.params as { jobId: string };
    const query = request.query as { limit?: string; entityType?: string; status?: string };
    const repository = repo();
    const { organizationId } = await scopedJob(repository, request, jobId);
    const rows = await repository.listRows({
      tenantId: principal.tenantId,
      organizationId,
      jobId,
      entityTypes: query.entityType ? [query.entityType] : undefined,
      statuses: query.status ? [query.status] : undefined,
      limit: Number(query.limit) || 100,
    });
    return {
      items: rows.map((row) => ({
        id: row.id,
        importJobId: row.import_job_id,
        fileId: row.import_job_file_id,
        entityType: row.entity_type,
        correlationId: row.id,
        rowNumber: row.row_number,
        status: row.status,
        severity: row.severity,
        tixkitId: row.tixkit_id,
        sourceHash: stableHash(parseJson(row.source_data)),
        normalizedHash: row.normalized_data ? stableHash(parseJson(row.normalized_data)) : null,
      })),
    };
  });

  app.get('/migration-jobs/:jobId/conflicts', async (request) => {
    const principal = request.principal!;
    requireMigrationPermission(principal, 'migrations.read');
    const { jobId } = request.params as { jobId: string };
    const query = request.query as { limit?: string; offset?: string };
    const repository = repo();
    const { organizationId } = await scopedJob(repository, request, jobId);
    const items = await repository.listConflicts({
      tenantId: principal.tenantId,
      organizationId,
      jobId,
      limit: Number(query.limit) || 100,
      offset: Number(query.offset) || 0,
    });
    return {
      items: items.map((item) => ({
        id: item.id,
        entity_type: item.entity_type,
        correlationId: item.id,
        severity: item.severity,
        code: item.code,
        message: redactMigrationReportValue(item.message),
        details: redactMigrationReportValue(parseJson(item.details)),
      })),
    };
  });

  app.get('/migration-jobs/:jobId/events', async (request) => {
    const principal = request.principal!;
    requireMigrationPermission(principal, 'migrations.read');
    const { jobId } = request.params as { jobId: string };
    const { afterSequence } = request.query as { afterSequence?: string };
    const repository = repo();
    const { organizationId } = await scopedJob(repository, request, jobId);
    const items = await repository.listEvents(
      principal.tenantId,
      organizationId,
      jobId,
      Number(afterSequence) || 0,
    );
    return {
      items: items.map((item) => ({
        id: item.id,
        sequence: item.sequence,
        type: item.type,
        severity: item.severity,
        message: redactMigrationReportValue(item.message),
        createdAt: item.created_at,
        data: redactMigrationReportValue(parseJson(item.data)),
      })),
    };
  });

  app.post('/migration-jobs/:jobId/dry-run', async (request) => {
    const principal = request.principal!;
    requireMigrationPermission(principal, 'migrations.write');
    const { jobId } = request.params as { jobId: string };
    const repository = repo();
    const { job, organizationId } = await scopedJob(repository, request, jobId);
    if (!['prepared', 'failed', 'ready'].includes(job.status))
      throw new ConflictError('Dry-run cannot start in the current migration status');
    const scope = { tenantId: principal.tenantId, organizationId, jobId };
    const rows = await loadAllRows(repository, scope);
    const conflicts = await repository.listConflicts({ ...scope, limit: 5000 });
    const conflictsByExternalId = new Map<string, MigrationIssue[]>();
    for (const conflict of conflicts) {
      const key = `${conflict.entity_type}:${conflict.external_id ?? ''}`;
      const issues = conflictsByExternalId.get(key) ?? [];
      issues.push({
        code: conflict.code,
        severity: conflict.severity as MigrationIssue['severity'],
        message: conflict.message,
        entityType: conflict.entity_type as MigrationIssue['entityType'],
        externalId: conflict.external_id ?? undefined,
      });
      conflictsByExternalId.set(key, issues);
    }
    const reportRows: DryRunRow[] = [];
    const canonicalAdoptions = [];
    const currentJobEntities = new Set(
      rows.flatMap((candidate) => {
        const normalized = normalizedEntity(candidate.normalized_data);
        return normalized ? [`${normalized.entityType}:${normalized.externalId}`] : [];
      }),
    );
    const externalDependencyCache = new Map<string, boolean>();
    for (const row of rows) {
      const entity = normalizedEntity(row.normalized_data) ?? {
        entityType: row.entity_type as NormalizedMigrationEntity['entityType'],
        externalId: row.external_id ?? `row-${row.row_number}`,
        sourcePosition: `row:${row.row_number}`,
        attributes: {},
      };
      const issues = [
        ...(conflictsByExternalId.get(`${row.entity_type}:${row.external_id ?? ''}`) ?? []),
      ];
      if (!normalizedEntity(row.normalized_data)) {
        issues.push({
          code: 'NORMALIZATION_MISSING',
          severity: 'fatal',
          message: 'Row has no valid normalized entity.',
          entityType: entity.entityType,
          externalId: entity.externalId,
          sourcePosition: entity.sourcePosition,
        });
      }
      const unresolvedDependencies = await unresolvedMigrationDependencies(
        entity,
        currentJobEntities,
        async (entityType, externalId) => {
          const key = `${entityType}:${externalId}`;
          let resolved = externalDependencyCache.get(key);
          if (resolved === undefined) {
            resolved = Boolean(
              await repository.findExternalReference({
                tenantId: principal.tenantId,
                organizationId,
                sourceSystem: job.source_system,
                entityType,
                externalId,
              }),
            );
            externalDependencyCache.set(key, resolved);
          }
          return resolved;
        },
      );
      for (const dependency of unresolvedDependencies) {
        issues.push({
          code: 'DEPENDENCY_UNRESOLVED',
          severity: 'error',
          message: `No current-job row or scoped external reference resolves ${dependency.entityType}.`,
          entityType: entity.entityType,
          externalId: entity.externalId,
          sourcePosition: entity.sourcePosition,
          field: `dependencies.${dependency.entityType}`,
        });
      }
      const existing = row.external_id
        ? await repository.findExternalReference({
            tenantId: principal.tenantId,
            organizationId,
            sourceSystem: job.source_system,
            entityType: row.entity_type,
            externalId: row.external_id,
          })
        : undefined;
      const imported = existing
        ? await repository.findImportedEntity(
            principal.tenantId,
            organizationId,
            existing.tixkit_id,
          )
        : undefined;
      const sameCanonicalContent =
        Boolean(imported) &&
        canonicalMigrationContentFingerprint({
          attributes: JSON.parse(imported!.attributes) as Record<string, unknown>,
          financialSnapshot: imported!.financial_snapshot
            ? (JSON.parse(
                imported!.financial_snapshot,
              ) as NormalizedMigrationEntity['financialSnapshot'])
            : undefined,
        }) === canonicalMigrationContentFingerprint(entity);
      const financialChanged =
        Boolean(imported) &&
        !sameCanonicalContent &&
        (entity.entityType === 'historical-payment' || entity.entityType === 'historical-refund');
      if (financialChanged) {
        issues.push({
          code: 'HISTORICAL_FINANCIAL_RECORD_CHANGED',
          severity: 'error',
          message: 'An imported historical financial snapshot cannot be changed by re-import.',
          entityType: entity.entityType,
          externalId: entity.externalId,
          sourcePosition: entity.sourcePosition,
        });
      }
      let canonicalAdoption;
      if (job.source_system === 'tixkit-portable') {
        try {
          canonicalAdoption = await resolvePortableCanonicalAdoption(app.context.db, {
            tenantId: principal.tenantId,
            organizationId,
            sourceSystem: job.source_system,
            entity,
          });
          if (canonicalAdoption) canonicalAdoptions.push(canonicalAdoption);
        } catch (error) {
          if (error instanceof Error && error.message === 'PORTABLE_CANONICAL_ADOPTION_CONFLICT')
            issues.push({
              code: 'PORTABLE_CANONICAL_ADOPTION_CONFLICT',
              severity: 'error',
              message:
                'The destination Compact bootstrap brand does not match the safe adoption policy.',
              entityType: entity.entityType,
              externalId: entity.externalId,
              sourcePosition: entity.sourcePosition,
            });
          else throw error;
        }
      }
      reportRows.push({
        entity,
        disposition:
          issues.length > 0
            ? 'conflict'
            : canonicalAdoption
              ? 'skip'
              : imported && sameCanonicalContent
                ? 'skip'
                : existing
                  ? 'update'
                  : 'create',
        issues,
      });
    }
    const configuration = parseJson(job.configuration);
    const files = await repository.listFiles(principal.tenantId, organizationId, jobId);
    const mappings = await repository.listMappings(
      principal.tenantId,
      organizationId,
      job.source_system,
    );
    const inputHash =
      job.source_system === 'tixkit-portable' &&
      reportRows.every(({ issues }) => issues.length === 0)
        ? await portableImportCurrentInputHash({
            db: app.context.db,
            tenantId: principal.tenantId,
            organizationId,
            jobId,
            sourceSystem: job.source_system,
          })
        : stableHash({
            configuration,
            files: files.map((file) => ({
              id: file.id,
              sha256: file.sha256,
              byteSize: String(file.byte_size),
            })),
            mappings: mappings.map((mapping) => ({
              id: mapping.id,
              version: mapping.version,
              mapping: stableHash(parseJson(mapping.mapping)),
            })),
            rows: rows.map((row) => ({
              id: row.id,
              source: stableHash(parseJson(row.source_data)),
              normalized: stableHash(parseJson(row.normalized_data)),
            })),
          });
    const dryRun = buildDryRunReport({
      rows: reportRows,
      unsupportedFeatures:
        configuration &&
        typeof configuration === 'object' &&
        Array.isArray((configuration as Record<string, unknown>).unsupportedFeatures)
          ? ((configuration as Record<string, unknown>).unsupportedFeatures as string[])
          : [],
    });
    const accepted = canCommitDryRun(dryRun) && rows.length > 0;
    const correlations = new Map<string, string>();
    for (const row of rows) {
      if (row.external_id) correlations.set(`${row.entity_type}:${row.external_id}`, row.id);
      correlations.set(`${row.entity_type}:row:${row.row_number}`, row.id);
    }
    const summary = sanitizeDryRunReport(
      {
        ...dryRun,
        rows: undefined,
        inputHash,
        configurationHash: stableHash(configuration),
        accepted,
        ...(canonicalAdoptions.length > 0 ? { canonicalAdoptions } : {}),
      },
      correlations,
    );
    let portableDryRunReceipt: unknown;
    let portableDryRunReceiptSha256: string | undefined;
    await app.context.db.transaction().execute(async (transaction) => {
      const transactionDb = transaction as typeof app.context.db;
      const changed = await new ImportRepository(transactionDb).transitionJob({
        tenantId: principal.tenantId,
        organizationId,
        jobId,
        from: [job.status as never],
        to: accepted ? 'ready' : 'failed',
        summary,
      });
      if (!changed) throw new ConflictError('Migration status changed concurrently');
      if (accepted && job.source_system === 'tixkit-portable') {
        try {
          const attested = await attestPortableDryRun({
            db: transactionDb,
            tenantId: principal.tenantId,
            organizationId,
            jobId,
            inputSha256: inputHash,
            createdBy: principal.id,
            attestation: portableAttestation(),
          });
          portableDryRunReceipt = attested.receipt;
          portableDryRunReceiptSha256 = attested.receiptSha256;
        } catch (error) {
          if (error instanceof Error && error.message === 'PORTABLE_IMPORT_DRY_RUN_INPUT_CHANGED') {
            throw new ConflictError(
              'Portable migration input changed after its immutable dry-run receipt; create a new migration job',
            );
          }
          request.log.error({ err: error, jobId }, 'Portable dry-run attestation failed');
          throw new PortableDryRunAttestationUnavailableError();
        }
      }
      await writeAuditLog(
        new AuditLogRepository(transactionDb),
        request,
        principal,
        {
          action: accepted ? 'migration_job.dry_run_completed' : 'migration_job.dry_run_failed',
          organizationId,
          resourceType: 'MigrationJob',
          resourceId: jobId,
          diffSummary: {
            accepted,
            counts: summary.counts,
            severityCounts: summary.severityCounts,
            issueCodes: Array.isArray(summary.issues)
              ? [
                  ...new Set(
                    summary.issues
                      .map((issue) => (issue as { code?: string }).code)
                      .filter(Boolean),
                  ),
                ]
              : [],
            ...(portableDryRunReceiptSha256 ? { portableDryRunReceiptSha256 } : {}),
          },
        },
        { failClosed: true },
      );
    });
    return {
      status: accepted ? 'ready' : 'failed',
      report: summary,
      domainWrites: 0,
      ...(portableDryRunReceipt ? { portableDryRunReceipt, portableDryRunReceiptSha256 } : {}),
    };
  });

  const report = async (request: FastifyRequest, download: boolean) => {
    const principal = request.principal!;
    requireMigrationPermission(principal, 'migrations.read');
    const { jobId } = request.params as { jobId: string };
    const repository = repo();
    const { job, organizationId } = await scopedJob(repository, request, jobId);
    const conflicts = [];
    const pageSize = 500;
    for (let offset = 0; ; offset += pageSize) {
      const page = await repository.listConflicts({
        tenantId: principal.tenantId,
        organizationId,
        jobId,
        limit: pageSize,
        offset,
      });
      conflicts.push(
        ...page.map((item) => ({
          id: item.id,
          entityType: item.entity_type,
          correlationId: item.id,
          severity: item.severity,
          code: item.code,
          message: redactMigrationReportValue(item.message),
          details: redactMigrationReportValue(parseJson(item.details)),
          resolution: item.resolution,
          resolvedAt: item.resolved_at,
        })),
      );
      if (page.length < pageSize) break;
    }
    const portableReceipt =
      job.source_system === 'tixkit-portable'
        ? await repository.findPortableDryRunReceipt(principal.tenantId, organizationId, jobId)
        : undefined;
    const payload = {
      job: {
        id: job.id,
        organizationId: job.organization_id,
        sourceSystem: job.source_system,
        adapterVersion: job.adapter_version,
        mode: job.mode,
        status: job.status,
        createdAt: job.created_at,
        updatedAt: job.updated_at,
      },
      report: parseJson(job.summary),
      ...(portableReceipt
        ? { portableDryRunReceipt: parseJson(portableReceipt.receipt_json) }
        : {}),
      conflicts,
      correctivePlans: (await repository.listEvents(principal.tenantId, organizationId, jobId))
        .filter((event) => event.type === 'rollback.corrective-plan')
        .map((event) => ({
          id: event.id,
          sequence: event.sequence,
          createdAt: event.created_at,
          plan: redactMigrationReportValue(parseJson(event.data)),
        })),
    };
    return { payload, download };
  };
  app.get('/migration-jobs/:jobId/report', async (request, reply) => {
    const { payload } = await report(request, false);
    return reply.send(payload);
  });
  app.get('/migration-jobs/:jobId/report/download', async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const { payload } = await report(request, true);
    return reply
      .header('content-disposition', `attachment; filename="migration-${jobId}-report.json"`)
      .type('application/json')
      .send(payload);
  });

  app.post('/migration-jobs/:jobId/commit', async (request, reply) => {
    const principal = request.principal!;
    requireMigrationPermission(principal, 'migrations.commit');
    const { jobId } = request.params as { jobId: string };
    const repository = repo();
    const { job, organizationId } = await scopedJob(repository, request, jobId);
    if (job.source_system === 'tixkit-portable') {
      const body = parse(
        z.object({ cutoverProof: portableCutoverProofSchema }).strict(),
        request.body ?? {},
      );
      try {
        await authorizePortableImportCommit({
          db: app.context.db,
          tenantId: principal.tenantId,
          organizationId,
          jobId,
          confirmation: String(request.headers['x-tixkit-confirmation'] ?? ''),
          attestation: portableAttestation(),
          cutoverProof: body.cutoverProof,
          cutoverTrust: portableCutoverTrust(),
          authorizedBy: principal.id,
        });
      } catch (error) {
        if (
          error instanceof Error &&
          error.message ===
            'portable final cutover requires a matching freeze or delta source proof'
        )
          throw new ConflictError('A fresh, trusted final cutover proof is required');
        if (
          error instanceof Error &&
          (error.message === 'PORTABLE_IMPORT_APPROVAL_REQUIRED' ||
            error.message === 'PORTABLE_IMPORT_COMMIT_CONFIRMATION_INVALID')
        )
          throw new ConflictError('A fresh, unrevoked portable import approval is required');
        if (
          error instanceof Error &&
          (error.message === 'PORTABLE_IMPORT_APPROVAL_INPUT_CHANGED' ||
            error.message === 'PORTABLE_IMPORT_REBINDINGS_REQUIRED' ||
            error.message === 'PORTABLE_IMPORT_REBINDING_DESTINATION_NOT_FOUND' ||
            error.message === 'PORTABLE_IMPORT_COMMIT_PRINCIPAL_MISMATCH' ||
            error.message === 'PORTABLE_IMPORT_CUTOVER_PROOF_ALREADY_CONSUMED' ||
            error.message === 'PORTABLE_IMPORT_COMMIT_AUTHORIZATION_CONFLICT' ||
            error.message === 'PORTABLE_IMPORT_COMMIT_AUTHORIZATION_JOB_CHANGED')
        )
          throw new ConflictError(
            'Portable import input changed after approval; create a new approval',
          );
        if (
          error instanceof Error &&
          (error.message === 'PORTABLE_CUTOVER_TRUST_REQUIRED' ||
            error.message === 'PORTABLE_CUTOVER_TRUST_INVALID')
        )
          throw new PortableCutoverTrustUnavailableError();
        request.log.error({ err: error, jobId }, 'Portable import approval validation failed');
        throw new PortableDryRunAttestationUnavailableError();
      }
      const authorizedJob = await repository.findJob(principal.tenantId, organizationId, jobId);
      if (authorizedJob?.status === 'ready') {
        const artifactIds = migrationOfficialExportArtifactIds(authorizedJob);
        if (artifactIds.length > 0) {
          try {
            await repository.acquireMigrationArtifactsForState({
              tenantId: principal.tenantId,
              organizationId,
              jobId,
              artifactIds,
              targetState: 'committing',
              transition: false,
            });
          } catch (error) {
            throw new ConflictError(
              error instanceof Error ? error.message : 'Migration artifact is unavailable',
            );
          }
        }
        await app.context.temporalClient.startMigrationCommit({
          tenantId: principal.tenantId,
          organizationId,
          jobId,
        });
      }
      await auditMutation(
        app,
        request,
        organizationId,
        jobId,
        'migration_job.portable_commit_authorized',
      );
      return reply.status(202).send({
        jobId,
        status:
          authorizedJob?.status === 'ready'
            ? 'committing'
            : (authorizedJob?.status ?? 'committing'),
      });
    }
    if (job.mode !== 'commit' || job.status !== 'ready') {
      throw new ConflictError('Only a ready commit-mode migration can be committed');
    }
    if (request.headers['x-tixkit-confirmation'] !== `commit:${jobId}`) {
      throw new ValidationError(`x-tixkit-confirmation must equal commit:${jobId}`);
    }
    const summary = parseJson(job.summary) as {
      accepted?: boolean;
      inputHash?: string;
      configurationHash?: string;
    } | null;
    const rows = await loadAllRows(repository, {
      tenantId: principal.tenantId,
      organizationId,
      jobId,
    });
    const files = await repository.listFiles(principal.tenantId, organizationId, jobId);
    const mappings = await repository.listMappings(
      principal.tenantId,
      organizationId,
      job.source_system,
    );
    const currentInputHash = stableHash({
      configuration: parseJson(job.configuration),
      files: files.map((file) => ({
        id: file.id,
        sha256: file.sha256,
        byteSize: String(file.byte_size),
      })),
      mappings: mappings.map((mapping) => ({
        id: mapping.id,
        version: mapping.version,
        mapping: stableHash(parseJson(mapping.mapping)),
      })),
      rows: rows.map((row) => ({
        id: row.id,
        source: stableHash(parseJson(row.source_data)),
        normalized: stableHash(parseJson(row.normalized_data)),
      })),
    });
    if (
      summary?.accepted !== true ||
      summary.inputHash !== currentInputHash ||
      summary.configurationHash !== stableHash(parseJson(job.configuration))
    ) {
      throw new ConflictError('Dry-run report is missing, rejected, or stale');
    }
    const artifactIds = migrationOfficialExportArtifactIds(job);
    if (artifactIds.length > 0) {
      try {
        await repository.acquireMigrationArtifactsForState({
          tenantId: principal.tenantId,
          organizationId,
          jobId,
          artifactIds,
          targetState: 'committing',
          transition: false,
        });
      } catch (error) {
        throw new ConflictError(
          error instanceof Error ? error.message : 'Migration artifact is unavailable',
        );
      }
    }
    await writeAuditLog(
      new AuditLogRepository(app.context.db),
      request,
      principal,
      {
        action: 'migration_job.commit_requested',
        organizationId,
        resourceType: 'MigrationJob',
        resourceId: jobId,
      },
      { failClosed: true },
    );
    await app.context.temporalClient.startMigrationCommit({
      tenantId: principal.tenantId,
      organizationId,
      jobId,
    });
    return reply.status(202).send({ jobId, status: 'committing' });
  });

  app.post('/migration-jobs/:jobId/activate', async (request, reply) => {
    const principal = request.principal!;
    requireMigrationPermission(principal, 'migrations.commit');
    const { jobId } = request.params as { jobId: string };
    parse(z.object({}).strict(), request.body ?? {});
    if (request.headers['x-tixkit-confirmation'] !== `activate:${jobId}`)
      throw new ValidationError(`x-tixkit-confirmation must equal activate:${jobId}`);
    const repository = repo();
    const { job, organizationId } = await scopedJob(repository, request, jobId);
    if (job.source_system !== 'tixkit-portable')
      throw new ValidationError('Explicit activation is only available for portable imports');
    try {
      const activated = await activatePortableImport({
        db: app.context.db,
        tenantId: principal.tenantId,
        organizationId,
        jobId,
        activatedBy: principal.id,
      });
      await auditMutation(app, request, organizationId, jobId, 'migration_job.portable_activated');
      return reply.status(200).send(activated);
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === 'PORTABLE_IMPORT_ACTIVATION_JOB_NOT_COMMITTED' ||
          error.message === 'PORTABLE_IMPORT_ACTIVATION_AUTHORIZATION_REQUIRED' ||
          error.message === 'PORTABLE_IMPORT_ACTIVATION_INPUT_CHANGED' ||
          error.message === 'PORTABLE_IMPORT_ACTIVATION_RECONCILIATION_REQUIRED' ||
          error.message === 'PORTABLE_IMPORT_ACTIVATION_PREFLIGHT_REQUIRED' ||
          error.message === 'PORTABLE_IMPORT_ACTIVATION_EVIDENCE_INVALID' ||
          error.message === 'PORTABLE_IMPORT_LINEAGE_STALE' ||
          error.message === 'PORTABLE_IMPORT_LINEAGE_CUTOVER_FINALIZED' ||
          error.message === 'PORTABLE_IMPORT_LINEAGE_REBASE_REQUIRED' ||
          error.message === 'PORTABLE_IMPORT_ACTIVATION_CONFLICT')
      )
        throw new ConflictError('Portable import is not eligible for activation');
      throw error;
    }
  });

  app.get('/migration-jobs/:jobId/portable-rebindings', async (request) => {
    const principal = request.principal!;
    requireMigrationPermission(principal, 'migrations.read');
    const { jobId } = request.params as { jobId: string };
    const repository = repo();
    const { job, organizationId } = await scopedJob(repository, request, jobId);
    if (job.source_system !== 'tixkit-portable')
      throw new ValidationError('Rebinding status is only available for portable imports');
    return portableImportRebindingStatus({
      db: app.context.db,
      tenantId: principal.tenantId,
      organizationId,
      jobId,
    });
  });

  app.put('/migration-jobs/:jobId/portable-rebindings/:portableId', async (request) => {
    const principal = request.principal!;
    requireMigrationPermission(principal, 'migrations.write');
    const { jobId, portableId } = request.params as { jobId: string; portableId: string };
    const body = parse(
      z.object({ destinationReference: z.string().trim().min(1).max(200) }).strict(),
      request.body,
    );
    const repository = repo();
    const { job, organizationId } = await scopedJob(repository, request, jobId);
    if (job.source_system !== 'tixkit-portable')
      throw new ValidationError('Destination rebinding is only available for portable imports');
    let rebinding;
    try {
      rebinding = await bindPortableImportDestination({
        db: app.context.db,
        tenantId: principal.tenantId,
        organizationId,
        jobId,
        portableId,
        destinationReference: body.destinationReference,
        boundBy: principal.id,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === 'PORTABLE_IMPORT_REBINDING_REFERENCE_INVALID' ||
          error.message === 'PORTABLE_IMPORT_REBINDING_NOT_REQUIRED' ||
          error.message === 'PORTABLE_IMPORT_REBINDING_DESTINATION_NOT_FOUND')
      )
        throw new ValidationError('Invalid or unrequested portable destination rebinding');
      if (error instanceof Error && error.message === 'PORTABLE_IMPORT_REBINDING_JOB_NOT_READY')
        throw new ConflictError('Portable destination rebindings require a ready dry-run');
      throw error;
    }
    await auditMutation(app, request, organizationId, jobId, 'migration_job.portable_rebound', {
      portableId,
      kind: rebinding.kind,
      destinationReference: rebinding.destination_reference,
      provenanceSha256: rebinding.provenance_sha256,
    });
    return {
      portableId: rebinding.portable_id,
      kind: rebinding.kind,
      destinationReference: rebinding.destination_reference,
      provenanceSha256: rebinding.provenance_sha256,
      updatedAt: rebinding.updated_at,
    };
  });

  app.post('/migration-jobs/:jobId/portable-approval', async (request, reply) => {
    const principal = request.principal!;
    requireMigrationPermission(principal, 'migrations.commit');
    const { jobId } = request.params as { jobId: string };
    parse(emptyBodySchema, request.body ?? {});
    const repository = repo();
    const { job, organizationId } = await scopedJob(repository, request, jobId);
    if (job.source_system !== 'tixkit-portable')
      throw new ValidationError('Portable approval is only available for portable imports');
    const idempotencyKey = request.headers['idempotency-key'];
    const confirmation = request.headers['x-tixkit-confirmation'];
    if (typeof idempotencyKey !== 'string' || typeof confirmation !== 'string')
      throw new ValidationError('Idempotency-Key and x-tixkit-confirmation are required');
    let approval;
    try {
      approval = await approvePortableImport({
        db: app.context.db,
        tenantId: principal.tenantId,
        organizationId,
        jobId,
        approvedBy: principal.id,
        idempotencyKey,
        confirmation,
        attestation: portableAttestation(),
      });
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === 'PORTABLE_IMPORT_APPROVAL_CONFIRMATION_INVALID' ||
          error.message === 'PORTABLE_IMPORT_APPROVAL_IDEMPOTENCY_INVALID')
      )
        throw new ValidationError('Portable approval confirmation or idempotency key is invalid');
      if (
        error instanceof Error &&
        (error.message === 'PORTABLE_IMPORT_APPROVAL_JOB_NOT_READY' ||
          error.message === 'PORTABLE_IMPORT_APPROVAL_INPUT_CHANGED' ||
          error.message === 'PORTABLE_IMPORT_REBINDINGS_REQUIRED' ||
          error.message === 'PORTABLE_IMPORT_REBINDING_DESTINATION_NOT_FOUND' ||
          error.message === 'PORTABLE_IMPORT_APPROVAL_IDEMPOTENCY_CONFLICT')
      )
        throw new ConflictError('Portable approval request conflicts with current job state');
      request.log.error({ err: error, jobId }, 'Portable import approval failed');
      throw new PortableDryRunAttestationUnavailableError();
    }
    await auditMutation(app, request, organizationId, jobId, 'migration_job.portable_approved', {
      approvalId: approval.id,
      approvalDigest: approval.approval_digest,
      expiresAt: approval.expires_at,
    });
    return reply.status(201).send({
      approvalId: approval.id,
      approvalDigest: approval.approval_digest,
      expiresAt: approval.expires_at,
      commitConfirmation: `commit:${jobId}:${approval.id}:${approval.approval_digest}`,
    });
  });

  app.post('/migration-jobs/:jobId/portable-approvals/:approvalId/revoke', async (request) => {
    const principal = request.principal!;
    requireMigrationPermission(principal, 'migrations.commit');
    const { jobId, approvalId } = request.params as { jobId: string; approvalId: string };
    const body = parse(
      z.object({ reason: z.string().trim().min(1).max(500).optional() }).strict(),
      request.body ?? {},
    );
    const repository = repo();
    const { job, organizationId } = await scopedJob(repository, request, jobId);
    if (job.source_system !== 'tixkit-portable')
      throw new ValidationError('Portable revocation is only available for portable imports');
    if (request.headers['x-tixkit-confirmation'] !== `revoke:${approvalId}`)
      throw new ValidationError(`x-tixkit-confirmation must equal revoke:${approvalId}`);
    let revocation;
    try {
      revocation = await revokePortableImportApproval({
        db: app.context.db,
        tenantId: principal.tenantId,
        organizationId,
        jobId,
        approvalId,
        revokedBy: principal.id,
        reason: body.reason,
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'PORTABLE_IMPORT_APPROVAL_NOT_FOUND')
        throw new NotFoundError('PortableImportApproval', approvalId);
      if (
        error instanceof Error &&
        error.message === 'PORTABLE_IMPORT_APPROVAL_REVOCATION_CONFLICT'
      )
        throw new ConflictError('Portable approval was already revoked with different evidence');
      if (error instanceof Error && error.message === 'PORTABLE_IMPORT_APPROVAL_EXECUTION_STARTED')
        throw new ConflictError('Portable approval cannot be revoked after execution starts');
      request.log.error({ err: error, jobId, approvalId }, 'Portable approval revocation failed');
      throw new PortableDryRunAttestationUnavailableError();
    }
    await auditMutation(app, request, organizationId, jobId, 'migration_job.portable_revoked', {
      approvalId,
      revocationId: revocation.id,
      reason: body.reason,
    });
    return { approvalId, revoked: true, revokedAt: revocation.created_at };
  });

  for (const action of ['pause', 'resume', 'cancel', 'rollback'] as const) {
    app.post(`/migration-jobs/:jobId/${action}`, async (request, reply) => {
      const principal = request.principal!;
      requireMigrationPermission(
        principal,
        action === 'rollback' ? 'migrations.rollback' : 'migrations.commit',
      );
      const { jobId } = request.params as { jobId: string };
      const repository = repo();
      const { job, organizationId } = await scopedJob(repository, request, jobId);
      if (
        action === 'rollback' &&
        request.headers['x-tixkit-confirmation'] !== `rollback:${jobId}`
      ) {
        throw new ValidationError(`x-tixkit-confirmation must equal rollback:${jobId}`);
      }
      const allowed: Record<typeof action, string[]> = {
        pause: ['preparing', 'committing'],
        resume: ['paused'],
        cancel: ['pending', 'prepared', 'ready', 'preparing', 'committing', 'paused'],
        rollback: ['committed', 'failed'],
      };
      if (!allowed[action].includes(job.status))
        throw new ConflictError(`Migration cannot ${action} in its current status`);
      const preparation = await repository.preparationProgress(
        principal.tenantId,
        organizationId,
        jobId,
      );
      const preparationAction =
        job.status === 'preparing' || (job.status === 'paused' && !preparation.completed);
      if (action === 'cancel' && ['pending', 'prepared', 'ready'].includes(job.status)) {
        const changed = await repository.transitionJob({
          tenantId: principal.tenantId,
          organizationId,
          jobId,
          from: [job.status as never],
          to: 'cancelled',
        });
        if (!changed) throw new ConflictError('Migration status changed concurrently');
      } else if (action === 'rollback') {
        await app.context.temporalClient.startMigrationRollback({
          tenantId: principal.tenantId,
          organizationId,
          jobId,
        });
      } else if (preparationAction) {
        await app.context.temporalClient.signalMigrationPreparation(
          principal.tenantId,
          organizationId,
          jobId,
          action,
        );
      } else {
        await app.context.temporalClient.signalMigration(
          principal.tenantId,
          organizationId,
          jobId,
          action,
        );
      }
      await auditMutation(app, request, organizationId, jobId, `migration_job.${action}_requested`);
      return reply.status(202).send({ jobId, action, accepted: true });
    });
  }

  app.get('/migration-jobs/:jobId/rollback-assessment', async (request) => {
    const principal = request.principal!;
    requireMigrationPermission(principal, 'migrations.read');
    const { jobId } = request.params as { jobId: string };
    const repository = repo();
    const { organizationId } = await scopedJob(repository, request, jobId);
    return repository.getRollbackEligibility(principal.tenantId, organizationId, jobId);
  });
};
