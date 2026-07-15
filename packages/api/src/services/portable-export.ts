import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  type KeyObject,
} from 'node:crypto';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { s3PutEncryption } from './s3-encryption.js';
import {
  PortableExportAuthorizationRepository,
  PortableExportRepository,
  type Database,
} from '@tixkit/db';
import {
  buildPortableLogicalExport,
  canonicalPortableJson,
  createPortableConfigurationPayloadPolicies,
  isPortableProtocolId,
  parsePortableJson,
  portableManifestSha256,
  validatePortableManifest,
  validatePortableLineage,
  verifyPortableManifestSignature,
  type HistoricalExportAuthorization,
  type SignedPortableBundle,
  type TixkitOperatingModel,
} from '@tixkit/portability';
import {
  loadPortableConfigurationRebindings,
  loadPortableConfigurationSections,
  loadPortableHistoricalSections,
} from '@tixkit/workflows';
import sharp from 'sharp';

const MAX_PORTABLE_ARTIFACT_BYTES = 50 * 1024 * 1024;
export const PORTABLE_EXPORT_API_VERSION = '2026-08-06';
export const PORTABLE_EXPORT_DATA_SCHEMA_VERSION = '0081';
export const PORTABLE_EXPORT_MEDIA_SCANNER_ID = 'tixkit_event_media_scanner_v1';
export const PORTABLE_EXPORT_MEDIA_POLICY_SHA256 = createHash('sha256')
  .update('tixkit-portable-event-media-v1')
  .digest('hex');

function historicalAuthorizationClaim(authorization: {
  id: string;
  tenant_id: string;
  organization_id: string;
  granted_by_principal_id: string;
  granted_at: Date;
  expires_at: Date;
}): HistoricalExportAuthorization {
  return {
    authorizationId: authorization.id,
    tenantId: authorization.tenant_id,
    organizationId: authorization.organization_id,
    scope: 'tenant-historical-portability',
    grantedByPrincipalId: authorization.granted_by_principal_id,
    grantedAt: new Date(authorization.granted_at).toISOString(),
    expiresAt: new Date(authorization.expires_at).toISOString(),
  };
}

export interface PortableExportSigningConfiguration {
  deploymentId: string;
  operatingModel: TixkitOperatingModel;
  bundleKeyId: string;
  bundlePrivateKey: KeyObject;
  payloadKeyId: string;
  payloadPrivateKey: KeyObject;
}

export interface PortableExportArtifactStore {
  putIfAbsent(key: string, bytes: Uint8Array, sha256: string): Promise<'created' | 'exists'>;
  get(key: string): Promise<Uint8Array>;
  getIfExists(key: string): Promise<Uint8Array | undefined>;
}

export interface PortableExportMediaStore {
  read(bucket: string, objectKey: string, maximumBytes: number): Promise<Uint8Array>;
}

export async function readPortableArtifactBody(
  body: AsyncIterable<Uint8Array | string>,
  contentLength?: number,
  maximumBytes = MAX_PORTABLE_ARTIFACT_BYTES,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1)
    throw new Error('PORTABLE_EXPORT_ARTIFACT_LIMIT_INVALID');
  if (contentLength !== undefined && contentLength > maximumBytes)
    throw new Error('PORTABLE_EXPORT_ARTIFACT_TOO_LARGE');
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : Uint8Array.from(chunk);
    total += bytes.byteLength;
    if (total > maximumBytes) throw new Error('PORTABLE_EXPORT_ARTIFACT_TOO_LARGE');
    chunks.push(bytes);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function privateKeyFromBase64(name: string, value: string | undefined): KeyObject {
  if (!value?.trim()) throw new Error(`PORTABLE_EXPORT_${name}_PRIVATE_KEY_REQUIRED`);
  let pem: string;
  try {
    const bytes = Buffer.from(value, 'base64');
    if (bytes.toString('base64') !== value) throw new Error('non-canonical');
    pem = bytes.toString('utf8');
  } catch {
    throw new Error(`PORTABLE_EXPORT_${name}_PRIVATE_KEY_INVALID`);
  }
  try {
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('wrong key type');
    return key;
  } catch {
    throw new Error(`PORTABLE_EXPORT_${name}_PRIVATE_KEY_INVALID`);
  }
}

export function portableExportSigningFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): PortableExportSigningConfiguration {
  const deploymentId = environment.TIXKIT_DEPLOYMENT_ID?.trim() ?? '';
  const operatingModel = environment.TIXKIT_OPERATING_MODEL?.trim();
  const bundleKeyId = environment.PORTABILITY_BUNDLE_SIGNING_KEY_ID?.trim() ?? '';
  const payloadKeyId = environment.PORTABILITY_PAYLOAD_SIGNING_KEY_ID?.trim() ?? '';
  if (!isPortableProtocolId(deploymentId)) throw new Error('PORTABLE_EXPORT_DEPLOYMENT_ID_INVALID');
  if (operatingModel !== 'self-hosted') throw new Error('PORTABLE_EXPORT_OPERATING_MODEL_INVALID');
  if (!isPortableProtocolId(bundleKeyId) || !isPortableProtocolId(payloadKeyId))
    throw new Error('PORTABLE_EXPORT_SIGNING_KEY_ID_INVALID');
  return {
    deploymentId,
    operatingModel,
    bundleKeyId,
    bundlePrivateKey: privateKeyFromBase64(
      'BUNDLE',
      environment.PORTABILITY_BUNDLE_SIGNING_PRIVATE_KEY_BASE64,
    ),
    payloadKeyId,
    payloadPrivateKey: privateKeyFromBase64(
      'PAYLOAD',
      environment.PORTABILITY_PAYLOAD_SIGNING_PRIVATE_KEY_BASE64,
    ),
  };
}

export function createS3PortableExportArtifactStore(
  environment: NodeJS.ProcessEnv = process.env,
  providedClient?: Pick<S3Client, 'send'>,
): PortableExportArtifactStore {
  const bucket = environment.PORTABILITY_EXPORT_BUCKET?.trim() ?? environment.S3_BUCKET?.trim();
  const region = environment.S3_REGION?.trim() ?? 'us-east-1';
  if (!bucket) throw new Error('PORTABLE_EXPORT_BUCKET_REQUIRED');
  const config: S3ClientConfig = { region };
  if (environment.S3_ENDPOINT?.trim()) {
    config.endpoint = environment.S3_ENDPOINT.trim();
    config.forcePathStyle = environment.S3_FORCE_PATH_STYLE === 'true';
  }
  const accessKeyId = environment.S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = environment.S3_SECRET_ACCESS_KEY?.trim();
  if (Boolean(accessKeyId) !== Boolean(secretAccessKey))
    throw new Error('PORTABLE_EXPORT_STORAGE_CREDENTIALS_INCOMPLETE');
  if (accessKeyId && secretAccessKey) config.credentials = { accessKeyId, secretAccessKey };
  const client = providedClient ?? new S3Client(config);
  return {
    async putIfAbsent(key, bytes, sha256) {
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: bytes,
            ContentType: 'application/vnd.tixkit.portable+json',
            ChecksumSHA256: Buffer.from(sha256, 'hex').toString('base64'),
            IfNoneMatch: '*',
            ...s3PutEncryption(environment),
          }),
        );
        return 'created';
      } catch (error) {
        const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata
          ?.httpStatusCode;
        if (status === 409 || status === 412) return 'exists';
        throw error;
      }
    },
    async get(key) {
      const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!result.Body) throw new Error('PORTABLE_EXPORT_ARTIFACT_MISSING');
      const body = result.Body as unknown as AsyncIterable<Uint8Array | string>;
      return readPortableArtifactBody(body, result.ContentLength);
    },
    async getIfExists(key) {
      try {
        const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        if (!result.Body) throw new Error('PORTABLE_EXPORT_ARTIFACT_MISSING');
        return readPortableArtifactBody(
          result.Body as unknown as AsyncIterable<Uint8Array | string>,
          result.ContentLength,
        );
      } catch (error) {
        const candidate = error as {
          name?: string;
          Code?: string;
          $metadata?: { httpStatusCode?: number };
        };
        if (
          candidate.$metadata?.httpStatusCode === 404 ||
          candidate.name === 'NoSuchKey' ||
          candidate.Code === 'NoSuchKey'
        )
          return undefined;
        throw error;
      }
    },
  };
}

export function createS3PortableExportMediaStore(
  environment: NodeJS.ProcessEnv = process.env,
  providedClient?: Pick<S3Client, 'send'>,
): PortableExportMediaStore {
  const region = environment.S3_REGION?.trim() ?? 'us-east-1';
  const options: S3ClientConfig = { region };
  if (environment.S3_ENDPOINT?.trim()) {
    options.endpoint = environment.S3_ENDPOINT.trim();
    options.forcePathStyle = environment.S3_FORCE_PATH_STYLE === 'true';
  }
  const accessKeyId = environment.S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = environment.S3_SECRET_ACCESS_KEY?.trim();
  if (Boolean(accessKeyId) !== Boolean(secretAccessKey))
    throw new Error('PORTABLE_EXPORT_STORAGE_CREDENTIALS_INCOMPLETE');
  if (accessKeyId && secretAccessKey) options.credentials = { accessKeyId, secretAccessKey };
  const client = providedClient ?? new S3Client(options);
  return {
    async read(bucket, objectKey, maximumBytes) {
      const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey }));
      if (!result.Body) throw new Error('PORTABLE_EXPORT_MEDIA_MISSING');
      return readPortableArtifactBody(
        result.Body as unknown as AsyncIterable<Uint8Array | string>,
        result.ContentLength,
        maximumBytes,
      );
    },
  };
}

function artifactKey(input: { tenantId: string; organizationId: string; jobId: string }): string {
  return `portable-exports/${input.tenantId}/${input.organizationId}/${input.jobId}.json`;
}

function verifyPersistedArtifact(
  bytes: Uint8Array,
  evidence: {
    artifact_sha256: string | null;
    artifact_bytes: number | string | bigint | null;
  },
): void {
  if (
    bytes.byteLength < 1 ||
    bytes.byteLength > MAX_PORTABLE_ARTIFACT_BYTES ||
    bytes.byteLength !== Number(evidence.artifact_bytes) ||
    createHash('sha256').update(bytes).digest('hex') !== evidence.artifact_sha256
  ) {
    throw new Error('PORTABLE_EXPORT_ARTIFACT_EVIDENCE_MISMATCH');
  }
}

function verifyRecoverableArtifact(
  bytes: Uint8Array,
  input: {
    bundleId: string;
    tenantId: string;
    organizationId: string;
    exportSequence: number;
    mode: 'configuration' | 'historical';
    historicalAuthorization?: HistoricalExportAuthorization;
    requiredEntitlements: readonly string[];
    signing: PortableExportSigningConfiguration;
    acceptedCompatibilityPairs?: readonly Readonly<{
      apiVersion: string;
      dataSchemaVersion: string;
    }>[];
    expectedParentEnvelope?: SignedPortableBundle;
    enforceExpectedParentEnvelope?: boolean;
  },
): { envelope: SignedPortableBundle; artifactSha256: string } {
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_PORTABLE_ARTIFACT_BYTES)
    throw new Error('PORTABLE_EXPORT_ARTIFACT_EVIDENCE_MISMATCH');
  const decoded = parsePortableJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as {
    envelope?: SignedPortableBundle;
    parentEnvelope?: SignedPortableBundle;
    payloads?: Record<string, string>;
  };
  const { envelope, parentEnvelope, payloads } = decoded;
  try {
    if (envelope) validatePortableManifest(envelope.manifest);
  } catch {
    throw new Error('PORTABLE_EXPORT_ARTIFACT_CONFLICT');
  }
  if (
    !envelope ||
    !payloads ||
    Array.isArray(payloads) ||
    envelope.manifest.bundleId !== input.bundleId ||
    envelope.manifest.source.tenantId !== input.tenantId ||
    envelope.manifest.source.organizationId !== input.organizationId ||
    Number(envelope.manifest.source.exportSequence) !== input.exportSequence ||
    envelope.manifest.mode !== input.mode ||
    !(
      input.acceptedCompatibilityPairs ?? [
        {
          apiVersion: PORTABLE_EXPORT_API_VERSION,
          dataSchemaVersion: PORTABLE_EXPORT_DATA_SCHEMA_VERSION,
        },
      ]
    ).some(
      (pair) =>
        pair.apiVersion === envelope.manifest.apiVersion &&
        pair.dataSchemaVersion === envelope.manifest.dataSchemaVersion,
    ) ||
    canonicalPortableJson(envelope.manifest.compatibility.requiredEntitlements) !==
      canonicalPortableJson(input.requiredEntitlements) ||
    canonicalPortableJson(envelope.manifest.historicalAuthorization ?? null) !==
      canonicalPortableJson(input.historicalAuthorization ?? null) ||
    !/^snapshot-sha256:[a-f0-9]{64}$/u.test(envelope.manifest.source.changeCursor) ||
    envelope.signature.keyId !== input.signing.bundleKeyId ||
    !verifyPortableManifestSignature(
      envelope.manifest,
      envelope.signature,
      createPublicKey(input.signing.bundlePrivateKey),
    )
  )
    throw new Error('PORTABLE_EXPORT_ARTIFACT_CONFLICT');
  try {
    validatePortableLineage(
      envelope,
      new Map([[input.signing.bundleKeyId, createPublicKey(input.signing.bundlePrivateKey)]]),
      parentEnvelope,
    );
  } catch {
    throw new Error('PORTABLE_EXPORT_ARTIFACT_CONFLICT');
  }
  if (
    input.enforceExpectedParentEnvelope &&
    canonicalPortableJson(parentEnvelope ?? null) !==
      canonicalPortableJson(input.expectedParentEnvelope ?? null)
  )
    throw new Error('PORTABLE_EXPORT_ARTIFACT_CONFLICT');
  const expectedPaths = new Set(envelope.manifest.files.map(({ path }) => path));
  const actualPaths = Object.keys(payloads);
  if (
    expectedPaths.size !== envelope.manifest.files.length ||
    actualPaths.length !== expectedPaths.size ||
    actualPaths.some((path) => !expectedPaths.has(path))
  )
    throw new Error('PORTABLE_EXPORT_ARTIFACT_CONFLICT');
  for (const file of envelope.manifest.files) {
    const encoded = payloads[file.path];
    if (typeof encoded !== 'string') throw new Error('PORTABLE_EXPORT_ARTIFACT_CONFLICT');
    const payload = Buffer.from(encoded, 'base64');
    if (
      payload.toString('base64') !== encoded ||
      payload.byteLength !== file.bytes ||
      createHash('sha256').update(payload).digest('hex') !== file.sha256
    )
      throw new Error('PORTABLE_EXPORT_ARTIFACT_CONFLICT');
  }
  return {
    envelope,
    artifactSha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

export interface PortableExportService {
  exportConfiguration(request: {
    tenantId: string;
    organizationId: string;
    requestedBy: string;
    idempotencyKey: string;
    parentExportJobId?: string;
    cutoverFreeze?: { frozenAt: string; receiptSha256: string };
  }): Promise<{ jobId: string; bundleId: string; bytes: Uint8Array }>;
  exportHistorical(request: {
    tenantId: string;
    organizationId: string;
    requestedBy: string;
    idempotencyKey: string;
    authorizationId: string;
  }): Promise<{ jobId: string; bundleId: string; bytes: Uint8Array }>;
}

export function createPortableExportService(input: {
  db: Database;
  store: PortableExportArtifactStore;
  mediaStore?: PortableExportMediaStore;
  signing: PortableExportSigningConfiguration;
  afterSnapshotRead?: () => Promise<void>;
}): PortableExportService {
  const repository = new PortableExportRepository(input.db);
  const authorizationRepository = new PortableExportAuthorizationRepository(input.db);
  const exportBundle = async (request: {
    tenantId: string;
    organizationId: string;
    requestedBy: string;
    idempotencyKey: string;
    mode: 'configuration' | 'historical';
    authorizationId?: string;
    parentExportJobId?: string;
    cutoverFreeze?: { frozenAt: string; receiptSha256: string };
  }): Promise<{ jobId: string; bundleId: string; bytes: Uint8Array }> => {
    const requestFingerprint = createHash('sha256')
      .update(
        canonicalPortableJson({
          mode: request.mode,
          organizationId: request.organizationId,
          requestedBy: request.requestedBy,
          ...(request.authorizationId ? { authorizationId: request.authorizationId } : {}),
          ...(request.parentExportJobId ? { parentExportJobId: request.parentExportJobId } : {}),
          ...(request.cutoverFreeze ? { cutoverFreeze: request.cutoverFreeze } : {}),
          policy:
            request.mode === 'historical'
              ? 'tixkit-portable-historical-policy-v1'
              : 'tixkit-portable-configuration-policy-v1',
        }),
      )
      .digest('hex');
    const job = await repository.begin({
      ...request,
      historicalAuthorizationId: request.authorizationId,
      requestFingerprint,
    });
    if (
      job.mode !== request.mode ||
      job.historical_authorization_id !== (request.authorizationId ?? null)
    )
      throw new Error('PORTABLE_EXPORT_IMMUTABLE_EVIDENCE_MISMATCH');
    if (request.mode === 'historical' && (request.parentExportJobId || request.cutoverFreeze))
      throw new Error('PORTABLE_EXPORT_LINEAGE_INVALID');
    if (request.cutoverFreeze && !request.parentExportJobId)
      throw new Error('PORTABLE_EXPORT_LINEAGE_INVALID');
    let parentEnvelope: SignedPortableBundle | undefined;
    if (request.parentExportJobId) {
      const parent = await input.db
        .selectFrom('portable_export_jobs')
        .selectAll()
        .where('tenant_id', '=', request.tenantId)
        .where('organization_id', '=', request.organizationId)
        .where('id', '=', request.parentExportJobId)
        .executeTakeFirst();
      if (
        !parent ||
        parent.status !== 'completed' ||
        parent.mode !== 'configuration' ||
        Number(parent.export_sequence) >= Number(job.export_sequence) ||
        !parent.manifest_sha256 ||
        !parent.source_change_cursor
      )
        throw new Error('PORTABLE_EXPORT_LINEAGE_PARENT_INVALID');
      const parentBytes = await input.store.get(
        artifactKey({
          tenantId: request.tenantId,
          organizationId: request.organizationId,
          jobId: parent.id,
        }),
      );
      verifyPersistedArtifact(parentBytes, parent);
      const recoveredParent = verifyRecoverableArtifact(parentBytes, {
        bundleId: parent.bundle_id,
        tenantId: request.tenantId,
        organizationId: request.organizationId,
        exportSequence: Number(parent.export_sequence),
        mode: 'configuration',
        requiredEntitlements: [],
        signing: input.signing,
        acceptedCompatibilityPairs: [
          { apiVersion: '2026-07-16', dataSchemaVersion: '0079' },
          { apiVersion: '2026-07-17', dataSchemaVersion: '0080' },
          { apiVersion: '2026-08-06', dataSchemaVersion: '0081' },
        ],
      });
      if (portableManifestSha256(recoveredParent.envelope.manifest) !== parent.manifest_sha256)
        throw new Error('PORTABLE_EXPORT_LINEAGE_PARENT_INVALID');
      parentEnvelope = recoveredParent.envelope;
    }
    const key = artifactKey({ ...request, jobId: job.id });
    if (job.status === 'completed') {
      const historicalAuthorization = request.authorizationId
        ? historicalAuthorizationClaim(
            (await authorizationRepository.find({
              tenantId: request.tenantId,
              organizationId: request.organizationId,
              authorizationId: request.authorizationId,
            })) ??
              (() => {
                throw new Error('PORTABLE_EXPORT_AUTHORIZATION_NOT_FOUND');
              })(),
          )
        : undefined;
      const evidence = await input.db
        .selectFrom('portable_export_events')
        .selectAll()
        .where('tenant_id', '=', request.tenantId)
        .where('organization_id', '=', request.organizationId)
        .where('export_job_id', '=', job.id)
        .executeTakeFirst();
      if (
        !evidence ||
        evidence.bundle_id !== job.bundle_id ||
        Number(evidence.export_sequence) !== Number(job.export_sequence) ||
        evidence.source_change_cursor !== job.source_change_cursor ||
        evidence.mode !== job.mode ||
        evidence.historical_authorization_id !== job.historical_authorization_id ||
        evidence.manifest_sha256 !== job.manifest_sha256 ||
        evidence.artifact_sha256 !== job.artifact_sha256 ||
        Number(evidence.artifact_bytes) !== Number(job.artifact_bytes)
      )
        throw new Error('PORTABLE_EXPORT_IMMUTABLE_EVIDENCE_MISMATCH');
      const bytes = await input.store.get(key);
      verifyPersistedArtifact(bytes, evidence);
      const verified = verifyRecoverableArtifact(bytes, {
        bundleId: evidence.bundle_id,
        tenantId: request.tenantId,
        organizationId: request.organizationId,
        exportSequence: Number(evidence.export_sequence),
        mode: request.mode,
        ...(historicalAuthorization ? { historicalAuthorization } : {}),
        requiredEntitlements: request.mode === 'historical' ? ['historical-import-v1'] : [],
        signing: input.signing,
        ...(parentEnvelope ? { expectedParentEnvelope: parentEnvelope } : {}),
        enforceExpectedParentEnvelope: true,
      });
      if (
        verified.envelope.manifest.source.changeCursor !== evidence.source_change_cursor ||
        portableManifestSha256(verified.envelope.manifest) !== evidence.manifest_sha256 ||
        verified.artifactSha256 !== evidence.artifact_sha256
      )
        throw new Error('PORTABLE_EXPORT_IMMUTABLE_EVIDENCE_MISMATCH');
      return { jobId: job.id, bundleId: job.bundle_id, bytes };
    }
    if (job.status !== 'building') throw new Error('PORTABLE_EXPORT_JOB_NOT_BUILDABLE');

    const ownerSha256 = createHash('sha256').update(randomBytes(32)).digest('hex');
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + 5 * 60 * 1000);
    const claimed = await repository.claimBuild({
      tenantId: request.tenantId,
      organizationId: request.organizationId,
      jobId: job.id,
      ownerSha256,
      now,
      leaseExpiresAt,
    });
    if (!claimed) throw new Error('PORTABLE_EXPORT_IN_PROGRESS');

    let historicalAuthorization: HistoricalExportAuthorization | undefined;
    if (request.mode === 'historical') {
      if (!request.authorizationId) throw new Error('PORTABLE_EXPORT_AUTHORIZATION_REQUIRED');
      const consumed = await authorizationRepository.consume({
        tenantId: request.tenantId,
        organizationId: request.organizationId,
        authorizationId: request.authorizationId,
        exportJobId: job.id,
        actorPrincipalId: request.requestedBy,
      });
      historicalAuthorization = historicalAuthorizationClaim(consumed);
    }

    const existingBytes = await input.store.getIfExists(key);
    if (existingBytes) {
      const recovered = verifyRecoverableArtifact(existingBytes, {
        bundleId: job.bundle_id,
        tenantId: request.tenantId,
        organizationId: request.organizationId,
        exportSequence: Number(job.export_sequence),
        mode: request.mode,
        ...(historicalAuthorization ? { historicalAuthorization } : {}),
        requiredEntitlements: request.mode === 'historical' ? ['historical-import-v1'] : [],
        signing: input.signing,
        ...(parentEnvelope ? { expectedParentEnvelope: parentEnvelope } : {}),
        enforceExpectedParentEnvelope: true,
      });
      if (
        !job.source_change_cursor ||
        recovered.envelope.manifest.source.changeCursor !== job.source_change_cursor
      )
        throw new Error('PORTABLE_EXPORT_ARTIFACT_CONFLICT');
      await repository.complete({
        tenantId: request.tenantId,
        organizationId: request.organizationId,
        jobId: job.id,
        manifestSha256: portableManifestSha256(recovered.envelope.manifest),
        artifactSha256: recovered.artifactSha256,
        artifactBytes: existingBytes.byteLength,
        ownerSha256,
      });
      return { jobId: job.id, bundleId: job.bundle_id, bytes: existingBytes };
    }

    const snapshot = await input.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .execute(async (transaction) => {
        const configurationSections = await loadPortableConfigurationSections(
          transaction as Database,
          {
            tenantId: request.tenantId,
            organizationId: request.organizationId,
          },
        );
        const sections = new Map(configurationSections);
        if (request.mode === 'historical') {
          const historicalSections = await loadPortableHistoricalSections(transaction as Database, {
            tenantId: request.tenantId,
            organizationId: request.organizationId,
          });
          for (const [section, records] of historicalSections) sections.set(section, records);
        }
        const rebindings = await loadPortableConfigurationRebindings(transaction as Database, {
          tenantId: request.tenantId,
          organizationId: request.organizationId,
        });
        const media = await transaction
          .selectFrom('event_media_assets as asset')
          .innerJoin('upload_artifacts as upload', 'upload.id', 'asset.upload_artifact_id')
          .select([
            'asset.id',
            'asset.event_id',
            'asset.role',
            'asset.alt_text',
            'asset.focal_x',
            'asset.focal_y',
            'upload.bucket',
            'upload.object_key',
            'upload.size_bytes',
            'upload.checksum_sha256',
            'upload.scan_status',
          ])
          .where('asset.tenant_id', '=', request.tenantId)
          .where('asset.organization_id', '=', request.organizationId)
          .orderBy('asset.id', 'asc')
          .execute();
        if (
          media.some(
            (asset) =>
              asset.scan_status !== 'clean' ||
              !asset.checksum_sha256 ||
              !Number.isSafeInteger(Number(asset.size_bytes)) ||
              Number(asset.size_bytes) < 1,
          )
        )
          throw new Error('PORTABLE_EXPORT_MEDIA_EVIDENCE_INVALID');
        const portableSections = new Map(sections);
        portableSections.set(
          'events',
          (sections.get('events') ?? []).map((event) => ({
            ...event,
            attributes: {
              ...event.attributes,
              mediaAssets: media
                .filter((asset) => asset.event_id === event.portableId)
                .map((asset) => ({
                  portableId: asset.id,
                  role: asset.role,
                  altText: asset.alt_text,
                  focalPoint: { x: Number(asset.focal_x), y: Number(asset.focal_y) },
                })),
            },
          })),
        );
        await input.afterSnapshotRead?.();
        const sourceChangeCursor = `snapshot-sha256:${createHash('sha256')
          .update(
            canonicalPortableJson({
              sections: portableSections,
              media: media.map(({ bucket: _bucket, object_key: _objectKey, ...asset }) => asset),
              rebindings,
            }),
          )
          .digest('hex')}`;
        const transactionalRepository = new PortableExportRepository(transaction as Database);
        await transactionalRepository.recordSnapshotCursor({
          tenantId: request.tenantId,
          organizationId: request.organizationId,
          jobId: job.id,
          ownerSha256,
          sourceChangeCursor,
          now: new Date(),
        });
        return { sections: portableSections, media, rebindings, sourceChangeCursor };
      });
    if (snapshot.media.length > 0 && !input.mediaStore)
      throw new Error('PORTABLE_EXPORT_MEDIA_STORE_REQUIRED');
    const assets = await Promise.all(
      snapshot.media.map(async (asset) => {
        const sourceBytes = await input.mediaStore!.read(
          asset.bucket,
          asset.object_key,
          Number(asset.size_bytes),
        );
        if (
          sourceBytes.byteLength !== Number(asset.size_bytes) ||
          createHash('sha256').update(sourceBytes).digest('hex') !== asset.checksum_sha256
        )
          throw new Error('PORTABLE_EXPORT_MEDIA_EVIDENCE_MISMATCH');
        const { data, info } = await sharp(sourceBytes, {
          failOn: 'warning',
          limitInputPixels: 40_000_000,
          sequentialRead: true,
        })
          .rotate()
          .webp({ quality: 90, effort: 5 })
          .toBuffer({ resolveWithObject: true });
        return {
          portableId: asset.id,
          path: `assets/${asset.id}/original.webp`,
          bytes: data,
          mediaType: 'image/webp',
          role: `event-media:${asset.event_id}:${asset.role}:original`,
          width: info.width,
          height: info.height,
          policySha256: PORTABLE_EXPORT_MEDIA_POLICY_SHA256,
          scannerId: PORTABLE_EXPORT_MEDIA_SCANNER_ID,
        };
      }),
    );
    let exportedAt = new Date(job.created_at).toISOString();
    if (historicalAuthorization) {
      const signingAuthorization = await authorizationRepository.validateForSigning({
        tenantId: request.tenantId,
        organizationId: request.organizationId,
        authorizationId: historicalAuthorization.authorizationId,
        exportJobId: job.id,
        actorPrincipalId: request.requestedBy,
      });
      historicalAuthorization = historicalAuthorizationClaim(signingAuthorization.authorization);
      exportedAt = signingAuthorization.signingTime.toISOString();
    }
    const built = buildPortableLogicalExport({
      bundleId: job.bundle_id,
      mode: request.mode,
      source: {
        operatingModel: input.signing.operatingModel,
        deploymentId: input.signing.deploymentId,
        tenantId: request.tenantId,
        organizationId: request.organizationId,
        exportSequence: Number(job.export_sequence),
        changeCursor: snapshot.sourceChangeCursor,
      },
      apiVersion: PORTABLE_EXPORT_API_VERSION,
      dataSchemaVersion: PORTABLE_EXPORT_DATA_SCHEMA_VERSION,
      exportedAt,
      currentTime: exportedAt,
      ...(historicalAuthorization ? { historicalAuthorization } : {}),
      compatibility: {
        minimumApiVersion: '2026-01-01',
        maximumApiVersion: '2026-12-31',
        minimumDataSchemaVersion: '0081',
        maximumDataSchemaVersion: '0081',
        requiredCapabilities: [
          'portable-bundle-v2',
          'portable-rebinding-kinds-v2',
          'portable-content-documents-v1',
        ],
        requiredEntitlements: request.mode === 'historical' ? ['historical-import-v1'] : [],
      },
      sections: snapshot.sections,
      bundleSigning: {
        keyId: input.signing.bundleKeyId,
        privateKey: input.signing.bundlePrivateKey,
      },
      payloadSigning: {
        keyId: input.signing.payloadKeyId,
        privateKey: input.signing.payloadPrivateKey,
      },
      payloadPolicies: createPortableConfigurationPayloadPolicies(),
      rebindings: snapshot.rebindings,
      assets,
      ...(parentEnvelope
        ? {
            lineage: {
              kind: 'delta' as const,
              parentEnvelope,
              ...(request.cutoverFreeze ? { cutoverFreeze: request.cutoverFreeze } : {}),
            },
          }
        : {}),
    });
    if (historicalAuthorization) {
      await authorizationRepository.validateForSigning({
        tenantId: request.tenantId,
        organizationId: request.organizationId,
        authorizationId: historicalAuthorization.authorizationId,
        exportJobId: job.id,
        actorPrincipalId: request.requestedBy,
      });
    }
    const artifactSha256 = createHash('sha256').update(built.transport).digest('hex');
    const putResult = await input.store.putIfAbsent(key, built.transport, artifactSha256);
    const persistedBytes = await input.store.get(key);
    const recovered = verifyRecoverableArtifact(persistedBytes, {
      bundleId: job.bundle_id,
      tenantId: request.tenantId,
      organizationId: request.organizationId,
      exportSequence: Number(job.export_sequence),
      mode: request.mode,
      ...(historicalAuthorization ? { historicalAuthorization } : {}),
      requiredEntitlements: request.mode === 'historical' ? ['historical-import-v1'] : [],
      signing: input.signing,
      ...(parentEnvelope ? { expectedParentEnvelope: parentEnvelope } : {}),
      enforceExpectedParentEnvelope: true,
    });
    if (putResult === 'created' && recovered.artifactSha256 !== artifactSha256)
      throw new Error('PORTABLE_EXPORT_ARTIFACT_CONFLICT');
    if (recovered.envelope.manifest.source.changeCursor !== snapshot.sourceChangeCursor) {
      await repository.recordSnapshotCursor({
        tenantId: request.tenantId,
        organizationId: request.organizationId,
        jobId: job.id,
        ownerSha256,
        sourceChangeCursor: recovered.envelope.manifest.source.changeCursor,
        now: new Date(),
      });
    }
    await repository.complete({
      tenantId: request.tenantId,
      organizationId: request.organizationId,
      jobId: job.id,
      manifestSha256: portableManifestSha256(recovered.envelope.manifest),
      artifactSha256: recovered.artifactSha256,
      artifactBytes: persistedBytes.byteLength,
      ownerSha256,
    });
    return { jobId: job.id, bundleId: job.bundle_id, bytes: persistedBytes };
  };
  return {
    exportConfiguration: (request) => exportBundle({ ...request, mode: 'configuration' }),
    exportHistorical: (request) =>
      exportBundle({
        ...request,
        mode: 'historical',
        authorizationId: request.authorizationId,
      }),
  };
}
