import { createHash, createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { ImportRepository, type Database } from '@tixkit/db';
import {
  canonicalPortableJson,
  createPortableDryRunReceipt,
  parsePortableJson,
  portableManifestSha256,
  portableImportControlInputSha256,
  portableRebindingProvenanceSha256,
  verifyPortableDryRunReceipt,
  type PortableBundleManifest,
  type PortableDryRunReceipt,
  type PortabilityPreflightResult,
} from '@tixkit/portability';

export interface PortableDryRunAttestationConfiguration {
  keyId: string;
  trustedPublicKeys: ReadonlyMap<string, KeyObject>;
  createReceipt(input: {
    preflight: PortabilityPreflightResult;
    manifest: PortableBundleManifest;
    destinationId: string;
    inputSha256: string;
    artifactSha256: string;
    checkedAt: string;
  }): Promise<PortableDryRunReceipt>;
}

export function createLocalPortableDryRunAttestation(input: {
  keyId: string;
  privateKey: KeyObject;
  trustedPublicKeys?: ReadonlyMap<string, KeyObject>;
}): PortableDryRunAttestationConfiguration {
  const trustedPublicKeys = new Map(input.trustedPublicKeys ?? []);
  if (!trustedPublicKeys.has(input.keyId))
    trustedPublicKeys.set(input.keyId, createPublicKey(input.privateKey));
  return {
    keyId: input.keyId,
    trustedPublicKeys,
    async createReceipt(receiptInput) {
      return createPortableDryRunReceipt(
        receiptInput.preflight,
        receiptInput.manifest,
        receiptInput.destinationId,
        receiptInput.inputSha256,
        receiptInput.artifactSha256,
        receiptInput.checkedAt,
        input.keyId,
        input.privateKey,
      );
    },
  };
}

function parsedJson(value: string | null): unknown {
  return value === null ? null : JSON.parse(value);
}

export function stablePortableControlHash(value: unknown): string {
  return createHash('sha256').update(canonicalPortableJson(value)).digest('hex');
}

async function portableImportCurrentInputHashFromDatabase(input: {
  db: Database;
  tenantId: string;
  organizationId: string;
  jobId: string;
  sourceSystem: string;
}): Promise<string> {
  const repository = new ImportRepository(input.db);
  const job = await repository.findJob(input.tenantId, input.organizationId, input.jobId);
  if (!job || job.source_system !== input.sourceSystem)
    throw new Error('PORTABLE_IMPORT_JOB_EVIDENCE_INVALID');
  const rows = [];
  for (let offset = 0; ; offset += 5_000) {
    const page = await repository.listRows({
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      jobId: input.jobId,
      limit: 5_000,
      offset,
    });
    rows.push(...page);
    if (page.length < 5_000) break;
  }
  const files = await repository.listFiles(input.tenantId, input.organizationId, input.jobId);
  const mappings = await repository.listMappings(
    input.tenantId,
    input.organizationId,
    input.sourceSystem,
  );
  return portableImportControlInputSha256({
    configuration: parsedJson(job.configuration),
    files: files.map((file) => ({
      id: file.id,
      sha256: file.sha256,
      byteSize: String(file.byte_size),
    })),
    mappings: mappings.map((mapping) => ({
      id: mapping.id,
      version: mapping.version,
      mapping: parsedJson(mapping.mapping),
    })),
    rows: rows.map((row) => ({
      id: row.id,
      source: parsedJson(row.source_data),
      normalized: parsedJson(row.normalized_data),
    })),
  });
}

async function portableImportRebindingsHash(input: {
  repository: ImportRepository;
  tenantId: string;
  organizationId: string;
  jobId: string;
}): Promise<string> {
  const preflight = await input.repository.findPortablePreflight(
    input.tenantId,
    input.organizationId,
    input.jobId,
  );
  if (!preflight) throw new Error('PORTABLE_IMPORT_PREFLIGHT_NOT_FOUND');
  const declaredValue = parsedJson(preflight.required_rebindings);
  if (!Array.isArray(declaredValue)) throw new Error('PORTABLE_IMPORT_PREFLIGHT_EVIDENCE_INVALID');
  const declarations = declaredValue.map((value) => {
    if (
      !value ||
      typeof value !== 'object' ||
      typeof (value as { portableId?: unknown }).portableId !== 'string' ||
      typeof (value as { kind?: unknown }).kind !== 'string' ||
      typeof (value as { required?: unknown }).required !== 'boolean'
    )
      throw new Error('PORTABLE_IMPORT_PREFLIGHT_EVIDENCE_INVALID');
    return value as { portableId: string; kind: string; required: boolean };
  });
  const requiredIds = declarations
    .filter(({ required }) => required)
    .map(({ portableId }) => portableId);
  const rebindings = await input.repository.listPortableImportRebindings(
    input.tenantId,
    input.organizationId,
    input.jobId,
  );
  if (requiredIds.some((portableId) => !rebindings.some((row) => row.portable_id === portableId)))
    throw new Error('PORTABLE_IMPORT_REBINDINGS_REQUIRED');
  for (const rebinding of rebindings) {
    const declaration = declarations.find(({ portableId }) => portableId === rebinding.portable_id);
    if (
      !declaration ||
      declaration.kind !== rebinding.kind ||
      rebinding.provenance_sha256 !==
        portableRebindingProvenanceSha256({
          kind: rebinding.kind as Parameters<typeof portableRebindingProvenanceSha256>[0]['kind'],
          portableId: rebinding.portable_id,
          destinationReference: rebinding.destination_reference,
        })
    )
      throw new Error('PORTABLE_IMPORT_REBINDING_EVIDENCE_INVALID');
    const destination = await input.repository.findPortableDestinationResource({
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      kind: rebinding.kind,
      resourceId: rebinding.destination_reference,
      lockForAuthorization: true,
    });
    if (!destination) throw new Error('PORTABLE_IMPORT_REBINDING_DESTINATION_NOT_FOUND');
  }
  return stablePortableControlHash(
    rebindings.map((rebinding) => ({
      portableId: rebinding.portable_id,
      kind: rebinding.kind,
      destinationReference: rebinding.destination_reference,
      provenanceSha256: rebinding.provenance_sha256,
    })),
  );
}

const PORTABLE_REBINDING_KINDS = new Set([
  'custom_domain',
  'provider_account',
  'payment_provider_account',
  'email_delivery_route',
  'sms_delivery_route',
  'marketing_integration',
  'tax_registration',
  'sending_identity',
  'wallet_credential',
  'oauth_redirect_origin',
  'webhook_endpoint',
]);

function isSecretLikeDestinationReference(value: string): boolean {
  return (
    /(?:^|[._-])(?:sk|rk)_(?:live|test)_/iu.test(value) ||
    /(?:password|passwd|secret|token|private[_-]?key|bearer)/iu.test(value) ||
    /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(value)
  );
}

export async function bindPortableImportDestination(input: {
  db: Database;
  tenantId: string;
  organizationId: string;
  jobId: string;
  portableId: string;
  destinationReference: string;
  boundBy: string;
  now?: Date;
}) {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u.test(input.portableId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u.test(input.destinationReference) ||
    input.destinationReference.includes('://') ||
    isSecretLikeDestinationReference(input.destinationReference)
  )
    throw new Error('PORTABLE_IMPORT_REBINDING_REFERENCE_INVALID');
  const repository = new ImportRepository(input.db);
  const job = await repository.findJob(input.tenantId, input.organizationId, input.jobId);
  if (!job || job.source_system !== 'tixkit-portable' || job.status !== 'ready')
    throw new Error('PORTABLE_IMPORT_REBINDING_JOB_NOT_READY');
  const preflight = await repository.findPortablePreflight(
    input.tenantId,
    input.organizationId,
    input.jobId,
  );
  if (!preflight) throw new Error('PORTABLE_IMPORT_PREFLIGHT_NOT_FOUND');
  const declarations = parsedJson(preflight.required_rebindings);
  if (!Array.isArray(declarations)) throw new Error('PORTABLE_IMPORT_PREFLIGHT_EVIDENCE_INVALID');
  const rebinding = declarations.find(
    (candidate): candidate is { portableId: string; kind: string; required: boolean } =>
      !!candidate &&
      typeof candidate === 'object' &&
      (candidate as { portableId?: unknown }).portableId === input.portableId &&
      typeof (candidate as { kind?: unknown }).kind === 'string' &&
      typeof (candidate as { required?: unknown }).required === 'boolean',
  );
  if (!rebinding || !PORTABLE_REBINDING_KINDS.has(rebinding.kind))
    throw new Error('PORTABLE_IMPORT_REBINDING_NOT_REQUIRED');
  const destination = await repository.findPortableDestinationResource({
    tenantId: input.tenantId,
    organizationId: input.organizationId,
    kind: rebinding.kind,
    resourceId: input.destinationReference,
  });
  if (!destination) throw new Error('PORTABLE_IMPORT_REBINDING_DESTINATION_NOT_FOUND');
  const provenanceSha256 = portableRebindingProvenanceSha256({
    kind: rebinding.kind as Parameters<typeof portableRebindingProvenanceSha256>[0]['kind'],
    portableId: input.portableId,
    destinationReference: destination.resource_id,
  });
  return repository.upsertPortableImportRebinding({
    tenantId: input.tenantId,
    organizationId: input.organizationId,
    jobId: input.jobId,
    portableId: input.portableId,
    kind: rebinding.kind,
    destinationReference: destination.resource_id,
    provenanceSha256,
    boundBy: input.boundBy,
    now: input.now,
  });
}

export async function portableImportRebindingStatus(input: {
  db: Database;
  tenantId: string;
  organizationId: string;
  jobId: string;
}) {
  const repository = new ImportRepository(input.db);
  const preflight = await repository.findPortablePreflight(
    input.tenantId,
    input.organizationId,
    input.jobId,
  );
  if (!preflight) throw new Error('PORTABLE_IMPORT_PREFLIGHT_NOT_FOUND');
  const declarations = parsedJson(preflight.required_rebindings);
  if (!Array.isArray(declarations)) throw new Error('PORTABLE_IMPORT_PREFLIGHT_EVIDENCE_INVALID');
  const required = declarations.filter(
    (candidate): candidate is { portableId: string; kind: string; required: true } =>
      !!candidate &&
      typeof candidate === 'object' &&
      (candidate as { required?: unknown }).required === true &&
      typeof (candidate as { portableId?: unknown }).portableId === 'string' &&
      typeof (candidate as { kind?: unknown }).kind === 'string',
  );
  const completed = await repository.listPortableImportRebindings(
    input.tenantId,
    input.organizationId,
    input.jobId,
  );
  const activeDestinationIds = new Set(
    (
      await Promise.all(
        completed.map(async (rebinding) =>
          (await repository.findPortableDestinationResource({
            tenantId: input.tenantId,
            organizationId: input.organizationId,
            kind: rebinding.kind,
            resourceId: rebinding.destination_reference,
          }))
            ? rebinding.portable_id
            : null,
        ),
      )
    ).filter((portableId): portableId is string => portableId !== null),
  );
  return {
    required,
    completed: completed.map((rebinding) => ({
      portableId: rebinding.portable_id,
      kind: rebinding.kind,
      destinationReference: rebinding.destination_reference,
      provenanceSha256: rebinding.provenance_sha256,
      boundBy: rebinding.bound_by,
      updatedAt: rebinding.updated_at,
    })),
    complete:
      activeDestinationIds.size === completed.length &&
      required.every(
        (candidate) =>
          !!candidate &&
          typeof candidate === 'object' &&
          completed.some(
            (rebinding) =>
              rebinding.portable_id === (candidate as { portableId?: unknown }).portableId,
          ),
      ),
  };
}

export async function portableImportCurrentInputHash(input: {
  db: Database;
  tenantId: string;
  organizationId: string;
  jobId: string;
  sourceSystem: string;
}): Promise<string> {
  return input.db
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute((transaction) =>
      portableImportCurrentInputHashFromDatabase({
        ...input,
        db: transaction as Database,
      }),
    );
}

export function portableDryRunAttestationFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): PortableDryRunAttestationConfiguration {
  if (environment.TIXKIT_OPERATING_MODEL?.trim() !== 'self-hosted')
    throw new Error('PORTABLE_DRY_RUN_ATTESTATION_OPERATING_MODEL_INVALID');
  const keyId = environment.PORTABILITY_DRY_RUN_SIGNING_KEY_ID?.trim() ?? '';
  const encoded = environment.PORTABILITY_DRY_RUN_SIGNING_PRIVATE_KEY_BASE64;
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(keyId))
    throw new Error('PORTABLE_DRY_RUN_ATTESTATION_KEY_ID_INVALID');
  if (!encoded?.trim()) throw new Error('PORTABLE_DRY_RUN_ATTESTATION_PRIVATE_KEY_REQUIRED');
  let privateKey: KeyObject;
  try {
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded)
      throw new Error('PORTABLE_DRY_RUN_ATTESTATION_PRIVATE_KEY_INVALID');
    privateKey = createPrivateKey(bytes.toString('utf8'));
    if (privateKey.asymmetricKeyType !== 'ed25519')
      throw new Error('PORTABLE_DRY_RUN_ATTESTATION_PRIVATE_KEY_INVALID');
  } catch {
    throw new Error('PORTABLE_DRY_RUN_ATTESTATION_PRIVATE_KEY_INVALID');
  }
  const trustedPublicKeys = new Map<string, KeyObject>([[keyId, createPublicKey(privateKey)]]);
  const serializedTrust = environment.PORTABILITY_DRY_RUN_TRUSTED_PUBLIC_KEYS;
  if (serializedTrust) {
    try {
      const parsed = JSON.parse(serializedTrust) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('invalid trust object');
      for (const [trustedKeyId, pem] of Object.entries(parsed)) {
        if (!/^[A-Za-z0-9_-]{1,128}$/u.test(trustedKeyId) || typeof pem !== 'string')
          throw new Error('invalid trust entry');
        if (trustedKeyId === keyId) throw new Error('active key id cannot be overridden');
        const publicKey = createPublicKey(pem);
        if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('invalid trust key');
        trustedPublicKeys.set(trustedKeyId, publicKey);
      }
    } catch {
      throw new Error('PORTABLE_DRY_RUN_ATTESTATION_TRUST_INVALID');
    }
  }
  return createLocalPortableDryRunAttestation({ keyId, privateKey, trustedPublicKeys });
}

export async function attestPortableDryRun(input: {
  db: Database;
  tenantId: string;
  organizationId: string;
  jobId: string;
  inputSha256: string;
  createdBy: string;
  attestation: PortableDryRunAttestationConfiguration;
  checkedAt?: string;
}) {
  if (!/^[a-f0-9]{64}$/u.test(input.inputSha256))
    throw new Error('PORTABLE_DRY_RUN_INPUT_DIGEST_INVALID');
  const repository = new ImportRepository(input.db);
  const evidence = await repository.findPortablePreflight(
    input.tenantId,
    input.organizationId,
    input.jobId,
  );
  if (!evidence) throw new Error('PORTABLE_IMPORT_PREFLIGHT_NOT_FOUND');
  const manifest = parsePortableJson(evidence.manifest_json) as PortableBundleManifest;
  const preflight = parsePortableJson(evidence.preflight_json) as PortabilityPreflightResult;
  const expectedAssets = manifest.assets.map(({ portableId, sha256 }) => ({
    portableId,
    sha256,
  }));
  if (
    portableManifestSha256(manifest) !== evidence.manifest_sha256 ||
    manifest.bundleId !== evidence.bundle_id ||
    manifest.source.deploymentId !== evidence.source_deployment_id ||
    manifest.lineage.toChangeCursor !== evidence.source_change_cursor ||
    !preflight.compatible ||
    preflight.operationId !== evidence.operation_id ||
    canonicalPortableJson(manifest.entityCounts) !== evidence.expected_counts ||
    canonicalPortableJson(expectedAssets) !== evidence.expected_assets ||
    canonicalPortableJson(preflight.rebindings) !== evidence.required_rebindings
  )
    throw new Error('PORTABLE_IMPORT_PREFLIGHT_EVIDENCE_INVALID');
  const files = await repository.listFiles(input.tenantId, input.organizationId, input.jobId);
  if (
    files.length !== 1 ||
    files[0]!.sha256 !== evidence.artifact_sha256 ||
    files[0]!.status !== 'ready'
  )
    throw new Error('PORTABLE_IMPORT_ARTIFACT_EVIDENCE_INVALID');

  const validateReceipt = (stored: {
    receipt_json: string;
    receipt_sha256: string;
    input_sha256: string;
    operation_id: string;
    manifest_sha256: string;
  }) => {
    const { receipt_json: receiptJson, receipt_sha256: receiptSha256 } = stored;
    const receipt = parsePortableJson(receiptJson) as PortableDryRunReceipt;
    const trustedKey = input.attestation.trustedPublicKeys.get(receipt.attestationKeyId);
    if (
      createHash('sha256').update(receiptJson).digest('hex') !== receiptSha256 ||
      !trustedKey ||
      !verifyPortableDryRunReceipt(receipt, trustedKey) ||
      receipt.operationId !== evidence.operation_id ||
      receipt.manifestSha256 !== evidence.manifest_sha256 ||
      receipt.destinationId !== evidence.destination_id ||
      receipt.sourceChangeCursor !== evidence.source_change_cursor ||
      receipt.artifactSha256 !== evidence.artifact_sha256 ||
      receipt.inputSha256 !== stored.input_sha256 ||
      stored.operation_id !== evidence.operation_id ||
      stored.manifest_sha256 !== evidence.manifest_sha256 ||
      canonicalPortableJson(receipt.requiredRebindings) !==
        canonicalPortableJson(preflight.requiredRebindings.map(({ portableId }) => portableId))
    )
      throw new Error('PORTABLE_IMPORT_DRY_RUN_RECEIPT_INVALID');
    if (receipt.inputSha256 !== input.inputSha256)
      throw new Error('PORTABLE_IMPORT_DRY_RUN_INPUT_CHANGED');
    return { receipt, receiptSha256 };
  };
  const existingReceipt = await repository.findPortableDryRunReceipt(
    input.tenantId,
    input.organizationId,
    input.jobId,
  );
  if (existingReceipt) return validateReceipt(existingReceipt);
  const receipt = await input.attestation.createReceipt({
    preflight,
    manifest,
    destinationId: evidence.destination_id,
    inputSha256: input.inputSha256,
    artifactSha256: evidence.artifact_sha256,
    checkedAt: input.checkedAt ?? new Date(evidence.created_at).toISOString(),
  });
  const receiptJson = canonicalPortableJson(receipt);
  const receiptSha256 = createHash('sha256').update(receiptJson).digest('hex');
  await repository.recordPortableDryRunReceipt({
    tenantId: input.tenantId,
    organizationId: input.organizationId,
    jobId: input.jobId,
    operationId: evidence.operation_id,
    manifestSha256: evidence.manifest_sha256,
    inputSha256: input.inputSha256,
    receiptSha256,
    receiptJson,
    createdBy: input.createdBy,
  });
  const persisted = await repository.findPortableDryRunReceipt(
    input.tenantId,
    input.organizationId,
    input.jobId,
  );
  if (!persisted) throw new Error('PORTABLE_IMPORT_DRY_RUN_RECEIPT_NOT_FOUND');
  return validateReceipt(persisted);
}

function portableApprovalDigest(input: {
  tenantId: string;
  organizationId: string;
  jobId: string;
  operationId: string;
  manifestSha256: string;
  artifactSha256: string;
  inputSha256: string;
  receiptSha256: string;
  rebindingsSha256: string;
  approvedBy: string;
  approvedAt: string;
  expiresAt: string;
}): string {
  return createHash('sha256')
    .update(canonicalPortableJson({ action: 'portable-import.commit', ...input }))
    .digest('hex');
}

export async function approvePortableImport(input: {
  db: Database;
  tenantId: string;
  organizationId: string;
  jobId: string;
  approvedBy: string;
  idempotencyKey: string;
  confirmation: string;
  attestation: PortableDryRunAttestationConfiguration;
  now?: Date;
}) {
  if (
    !input.idempotencyKey ||
    input.idempotencyKey !== input.idempotencyKey.trim() ||
    input.idempotencyKey.length > 255
  )
    throw new Error('PORTABLE_IMPORT_APPROVAL_IDEMPOTENCY_INVALID');
  let idempotencyKeySha256 = '';
  let requestFingerprint = '';
  let approvalDigest = '';
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await input.db
        .transaction()
        .setIsolationLevel('serializable')
        .execute(async (transaction) => {
          const transactionDatabase = transaction as Database;
          const repository = new ImportRepository(transactionDatabase);
          const job = await repository.findJob(input.tenantId, input.organizationId, input.jobId);
          if (!job || job.source_system !== 'tixkit-portable' || job.status !== 'ready')
            throw new Error('PORTABLE_IMPORT_APPROVAL_JOB_NOT_READY');
          const storedReceipt = await repository.findPortableDryRunReceipt(
            input.tenantId,
            input.organizationId,
            input.jobId,
          );
          if (!storedReceipt) throw new Error('PORTABLE_IMPORT_DRY_RUN_RECEIPT_NOT_FOUND');
          const currentInputSha256 = await portableImportCurrentInputHashFromDatabase({
            db: transactionDatabase,
            tenantId: input.tenantId,
            organizationId: input.organizationId,
            jobId: input.jobId,
            sourceSystem: job.source_system,
          });
          const summary = parsedJson(job.summary) as {
            accepted?: boolean;
            inputHash?: string;
          } | null;
          if (
            summary?.accepted !== true ||
            summary.inputHash !== currentInputSha256 ||
            storedReceipt.input_sha256 !== currentInputSha256
          )
            throw new Error('PORTABLE_IMPORT_APPROVAL_INPUT_CHANGED');
          if (input.confirmation !== `approve:${input.jobId}:${storedReceipt.receipt_sha256}`)
            throw new Error('PORTABLE_IMPORT_APPROVAL_CONFIRMATION_INVALID');
          const { receipt } = await attestPortableDryRun({
            db: transactionDatabase,
            tenantId: input.tenantId,
            organizationId: input.organizationId,
            jobId: input.jobId,
            inputSha256: storedReceipt.input_sha256,
            createdBy: input.approvedBy,
            attestation: input.attestation,
          });
          const typedReceipt = receipt as PortableDryRunReceipt;
          const rebindingsSha256 = await portableImportRebindingsHash({
            repository,
            tenantId: input.tenantId,
            organizationId: input.organizationId,
            jobId: input.jobId,
          });
          idempotencyKeySha256 = createHash('sha256').update(input.idempotencyKey).digest('hex');
          requestFingerprint = createHash('sha256')
            .update(
              canonicalPortableJson({
                action: 'portable-import.approve',
                approvedBy: input.approvedBy,
                jobId: input.jobId,
                receiptSha256: storedReceipt.receipt_sha256,
                rebindingsSha256,
              }),
            )
            .digest('hex');
          const replay = await repository.findPortableImportApprovalByIdempotency({
            tenantId: input.tenantId,
            organizationId: input.organizationId,
            jobId: input.jobId,
            idempotencyKeySha256,
          });
          if (replay) {
            if (replay.request_fingerprint !== requestFingerprint)
              throw new Error('PORTABLE_IMPORT_APPROVAL_IDEMPOTENCY_CONFLICT');
            return replay;
          }
          const requestedNow = input.now ?? new Date();
          const now = new Date(Math.floor(requestedNow.getTime() / 1000) * 1000);
          const expiresAt = new Date(now.getTime() + 10 * 60 * 1000);
          approvalDigest = portableApprovalDigest({
            tenantId: input.tenantId,
            organizationId: input.organizationId,
            jobId: input.jobId,
            operationId: typedReceipt.operationId,
            manifestSha256: typedReceipt.manifestSha256,
            artifactSha256: typedReceipt.artifactSha256,
            inputSha256: typedReceipt.inputSha256,
            receiptSha256: storedReceipt.receipt_sha256,
            rebindingsSha256,
            approvedBy: input.approvedBy,
            approvedAt: now.toISOString(),
            expiresAt: expiresAt.toISOString(),
          });
          return repository.createPortableImportApproval({
            tenantId: input.tenantId,
            organizationId: input.organizationId,
            jobId: input.jobId,
            operationId: typedReceipt.operationId,
            manifestSha256: typedReceipt.manifestSha256,
            artifactSha256: typedReceipt.artifactSha256,
            inputSha256: typedReceipt.inputSha256,
            receiptSha256: storedReceipt.receipt_sha256,
            rebindingsSha256,
            approvalDigest,
            approvedBy: input.approvedBy,
            idempotencyKeySha256,
            requestFingerprint,
            expiresAt,
            now,
          });
        });
    } catch (error) {
      const repository = new ImportRepository(input.db);
      if (idempotencyKeySha256) {
        const replay = await repository.findPortableImportApprovalByIdempotency({
          tenantId: input.tenantId,
          organizationId: input.organizationId,
          jobId: input.jobId,
          idempotencyKeySha256,
        });
        if (replay) {
          if (replay.request_fingerprint !== requestFingerprint)
            throw new Error('PORTABLE_IMPORT_APPROVAL_IDEMPOTENCY_CONFLICT', { cause: error });
          return replay;
        }
      }
      if (approvalDigest) {
        const replay = await repository.findPortableImportApprovalByDigest({
          tenantId: input.tenantId,
          organizationId: input.organizationId,
          jobId: input.jobId,
          approvalDigest,
        });
        if (replay && replay.request_fingerprint === requestFingerprint) return replay;
      }
      const databaseError = error as {
        code?: string;
        number?: number;
        errno?: number;
        cause?: { code?: string; number?: number; errno?: number };
      };
      const code = databaseError.code ?? databaseError.cause?.code;
      const number = databaseError.number ?? databaseError.cause?.number;
      const errno = databaseError.errno ?? databaseError.cause?.errno;
      const retryable =
        code === '23505' ||
        code === 'ER_DUP_ENTRY' ||
        number === 2601 ||
        number === 2627 ||
        code === '40001' ||
        code === '40P01' ||
        code === 'ER_LOCK_DEADLOCK' ||
        errno === 1213;
      if (!retryable || attempt === 4) throw error;
    }
  }
  throw new Error('PORTABLE_IMPORT_APPROVAL_RETRY_EXHAUSTED');
}

async function validatePortableImportApprovalFromDatabase(input: {
  db: Database;
  tenantId: string;
  organizationId: string;
  jobId: string;
  confirmation: string;
  attestation: PortableDryRunAttestationConfiguration;
  now?: Date;
}) {
  const repository = new ImportRepository(input.db);
  const now = input.now ?? new Date();
  const prefix = `commit:${input.jobId}:`;
  const confirmationParts = input.confirmation.startsWith(prefix)
    ? input.confirmation.slice(prefix.length).split(':')
    : [];
  if (
    confirmationParts.length !== 2 ||
    !confirmationParts[0] ||
    !/^[a-f0-9]{64}$/u.test(confirmationParts[1] ?? '')
  )
    throw new Error('PORTABLE_IMPORT_COMMIT_CONFIRMATION_INVALID');
  const approval = await repository.findPortableImportApproval({
    tenantId: input.tenantId,
    organizationId: input.organizationId,
    jobId: input.jobId,
    approvalId: confirmationParts[0]!,
  });
  if (
    !approval ||
    new Date(approval.expires_at) <= now ||
    (await repository.findPortableImportApprovalRevocation({
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      jobId: input.jobId,
      approvalId: confirmationParts[0]!,
    }))
  )
    throw new Error('PORTABLE_IMPORT_APPROVAL_REQUIRED');
  if (input.confirmation !== `commit:${input.jobId}:${approval.id}:${approval.approval_digest}`)
    throw new Error('PORTABLE_IMPORT_COMMIT_CONFIRMATION_INVALID');
  const { receipt } = await attestPortableDryRun({
    db: input.db,
    tenantId: input.tenantId,
    organizationId: input.organizationId,
    jobId: input.jobId,
    inputSha256: approval.input_sha256,
    createdBy: approval.approved_by,
    attestation: input.attestation,
  });
  const typedReceipt = receipt as PortableDryRunReceipt;
  const expectedDigest = portableApprovalDigest({
    tenantId: input.tenantId,
    organizationId: input.organizationId,
    jobId: input.jobId,
    operationId: approval.operation_id,
    manifestSha256: approval.manifest_sha256,
    artifactSha256: approval.artifact_sha256,
    inputSha256: approval.input_sha256,
    receiptSha256: approval.receipt_sha256,
    rebindingsSha256: approval.rebindings_sha256,
    approvedBy: approval.approved_by,
    approvedAt: new Date(approval.created_at).toISOString(),
    expiresAt: new Date(approval.expires_at).toISOString(),
  });
  if (
    expectedDigest !== approval.approval_digest ||
    typedReceipt.operationId !== approval.operation_id ||
    typedReceipt.manifestSha256 !== approval.manifest_sha256 ||
    typedReceipt.artifactSha256 !== approval.artifact_sha256 ||
    typedReceipt.inputSha256 !== approval.input_sha256
  )
    throw new Error('PORTABLE_IMPORT_APPROVAL_EVIDENCE_INVALID');
  const job = await repository.findJob(input.tenantId, input.organizationId, input.jobId);
  if (!job || job.source_system !== 'tixkit-portable' || job.status !== 'ready')
    throw new Error('PORTABLE_IMPORT_APPROVAL_INPUT_CHANGED');
  const summary = parsedJson(job.summary) as { accepted?: boolean; inputHash?: string } | null;
  const currentInputSha256 = await portableImportCurrentInputHashFromDatabase({
    db: input.db,
    tenantId: input.tenantId,
    organizationId: input.organizationId,
    jobId: input.jobId,
    sourceSystem: job.source_system,
  });
  const currentRebindingsSha256 = await portableImportRebindingsHash({
    repository,
    tenantId: input.tenantId,
    organizationId: input.organizationId,
    jobId: input.jobId,
  });
  if (
    summary?.accepted !== true ||
    summary.inputHash !== currentInputSha256 ||
    approval.input_sha256 !== currentInputSha256 ||
    approval.rebindings_sha256 !== currentRebindingsSha256
  )
    throw new Error('PORTABLE_IMPORT_APPROVAL_INPUT_CHANGED');
  return approval;
}

export async function validatePortableImportApproval(input: {
  db: Database;
  tenantId: string;
  organizationId: string;
  jobId: string;
  confirmation: string;
  attestation: PortableDryRunAttestationConfiguration;
  now?: Date;
}) {
  return input.db
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute((transaction) =>
      validatePortableImportApprovalFromDatabase({ ...input, db: transaction as Database }),
    );
}

export async function authorizePortableImportCommit(input: {
  db: Database;
  tenantId: string;
  organizationId: string;
  jobId: string;
  confirmation: string;
  attestation: PortableDryRunAttestationConfiguration;
  authorizedBy: string;
  now?: Date;
}) {
  const durableReplay = async () => {
    const repository = new ImportRepository(input.db);
    const authorization = await repository.findPortableImportCommitAuthorization(
      input.tenantId,
      input.organizationId,
      input.jobId,
    );
    if (!authorization) return undefined;
    const approval = await repository.findPortableImportApproval({
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      jobId: input.jobId,
      approvalId: authorization.approval_id,
    });
    const job = await repository.findJob(input.tenantId, input.organizationId, input.jobId);
    const revocation = approval
      ? await repository.findPortableImportApprovalRevocation({
          tenantId: input.tenantId,
          organizationId: input.organizationId,
          jobId: input.jobId,
          approvalId: approval.id,
        })
      : undefined;
    if (
      !approval ||
      !job ||
      job.mode !== 'commit' ||
      !['ready', 'committing', 'committed', 'activated'].includes(job.status) ||
      revocation
    )
      return undefined;
    if (
      input.confirmation !==
        `commit:${input.jobId}:${authorization.approval_id}:${authorization.approval_digest}` ||
      authorization.authorized_by !== input.authorizedBy ||
      authorization.approval_digest !== approval.approval_digest ||
      authorization.input_sha256 !== approval.input_sha256 ||
      authorization.rebindings_sha256 !== approval.rebindings_sha256
    )
      throw new Error('PORTABLE_IMPORT_COMMIT_AUTHORIZATION_CONFLICT');
    return authorization;
  };
  const alreadyAuthorized = await durableReplay();
  if (alreadyAuthorized) return alreadyAuthorized;
  let expected:
    | {
        approvalId: string;
        approvalDigest: string;
        inputSha256: string;
        rebindingsSha256: string;
      }
    | undefined;
  const exactReplay = async () => {
    if (!expected) return undefined;
    const existing = await new ImportRepository(input.db).findPortableImportCommitAuthorization(
      input.tenantId,
      input.organizationId,
      input.jobId,
    );
    if (!existing) return undefined;
    if (
      existing.approval_id !== expected.approvalId ||
      existing.approval_digest !== expected.approvalDigest ||
      existing.input_sha256 !== expected.inputSha256 ||
      existing.rebindings_sha256 !== expected.rebindingsSha256 ||
      existing.authorized_by !== input.authorizedBy
    )
      throw new Error('PORTABLE_IMPORT_COMMIT_AUTHORIZATION_CONFLICT');
    return existing;
  };
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await input.db
        .transaction()
        .setIsolationLevel('serializable')
        .execute(async (transaction) => {
          const transactionDatabase = transaction as Database;
          const approval = await validatePortableImportApprovalFromDatabase({
            ...input,
            db: transactionDatabase,
          });
          if (approval.approved_by !== input.authorizedBy)
            throw new Error('PORTABLE_IMPORT_COMMIT_PRINCIPAL_MISMATCH');
          expected = {
            approvalId: approval.id,
            approvalDigest: approval.approval_digest,
            inputSha256: approval.input_sha256,
            rebindingsSha256: approval.rebindings_sha256,
          };
          const repository = new ImportRepository(transactionDatabase);
          const existing = await repository.findPortableImportCommitAuthorization(
            input.tenantId,
            input.organizationId,
            input.jobId,
          );
          if (existing) {
            if (
              existing.approval_id !== expected.approvalId ||
              existing.approval_digest !== expected.approvalDigest ||
              existing.input_sha256 !== expected.inputSha256 ||
              existing.rebindings_sha256 !== expected.rebindingsSha256 ||
              existing.authorized_by !== input.authorizedBy
            )
              throw new Error('PORTABLE_IMPORT_COMMIT_AUTHORIZATION_CONFLICT');
            return existing;
          }
          return repository.authorizePortableImportCommit({
            tenantId: input.tenantId,
            organizationId: input.organizationId,
            jobId: input.jobId,
            ...expected,
            authorizedBy: input.authorizedBy,
            authorizedAt: input.now ?? new Date(),
          });
        });
    } catch (error) {
      const replay = await exactReplay();
      if (replay) return replay;
      const databaseError = error as {
        code?: string;
        number?: number;
        errno?: number;
        cause?: { code?: string; number?: number; errno?: number };
      };
      const code = databaseError.code ?? databaseError.cause?.code;
      const number = databaseError.number ?? databaseError.cause?.number;
      const errno = databaseError.errno ?? databaseError.cause?.errno;
      const retryable =
        code === '23505' ||
        code === 'ER_DUP_ENTRY' ||
        number === 2601 ||
        number === 2627 ||
        code === '40001' ||
        code === '40P01' ||
        code === 'ER_LOCK_DEADLOCK' ||
        errno === 1213;
      if (!retryable || attempt === 4) throw error;
    }
  }
  throw new Error('PORTABLE_IMPORT_COMMIT_AUTHORIZATION_RETRY_EXHAUSTED');
}

export async function activatePortableImport(input: {
  db: Database;
  tenantId: string;
  organizationId: string;
  jobId: string;
  activatedBy: string;
  now?: Date;
}) {
  return input.db
    .transaction()
    .setIsolationLevel('serializable')
    .execute(async (transaction) => {
      const repository = new ImportRepository(transaction as Database);
      const job = await repository.findJobForUpdate(
        input.tenantId,
        input.organizationId,
        input.jobId,
      );
      if (
        !job ||
        job.source_system !== 'tixkit-portable' ||
        !['committed', 'activated'].includes(job.status)
      )
        throw new Error('PORTABLE_IMPORT_ACTIVATION_JOB_NOT_COMMITTED');
      const authorization = await repository.findPortableImportCommitAuthorization(
        input.tenantId,
        input.organizationId,
        input.jobId,
      );
      if (!authorization) throw new Error('PORTABLE_IMPORT_ACTIVATION_AUTHORIZATION_REQUIRED');
      const currentInputSha256 = await portableImportCurrentInputHashFromDatabase({
        db: transaction as Database,
        tenantId: input.tenantId,
        organizationId: input.organizationId,
        jobId: input.jobId,
        sourceSystem: job.source_system,
      });
      const currentRebindingsSha256 = await portableImportRebindingsHash({
        repository,
        tenantId: input.tenantId,
        organizationId: input.organizationId,
        jobId: input.jobId,
      });
      if (
        currentInputSha256 !== authorization.input_sha256 ||
        currentRebindingsSha256 !== authorization.rebindings_sha256
      )
        throw new Error('PORTABLE_IMPORT_ACTIVATION_INPUT_CHANGED');
      const unresolved = await repository.listRowsForReconciliation(
        input.tenantId,
        input.organizationId,
        input.jobId,
        1,
        0,
      );
      const events = await repository.listEvents(input.tenantId, input.organizationId, input.jobId);
      let reconciliation: (typeof events)[number] | undefined;
      const existingActivation = events.find((event) => event.type === 'commit.activated');
      for (let index = events.length - 1; index >= 0; index -= 1) {
        if (events[index]?.type === 'commit.reconciled') {
          reconciliation = events[index];
          break;
        }
      }
      const reconciliationData = reconciliation?.data
        ? (JSON.parse(reconciliation.data) as { repaired?: number; unresolved?: number })
        : null;
      if (
        unresolved.length > 0 ||
        reconciliationData?.unresolved !== 0 ||
        typeof reconciliationData.repaired !== 'number'
      )
        throw new Error('PORTABLE_IMPORT_ACTIVATION_RECONCILIATION_REQUIRED');
      if (job.status === 'activated') {
        const activationData = existingActivation?.data
          ? (JSON.parse(existingActivation.data) as {
              activatedBy?: string;
              authorizationApprovalId?: string;
              reconciliationEventId?: string;
            })
          : null;
        if (
          activationData?.activatedBy !== input.activatedBy ||
          activationData.authorizationApprovalId !== authorization.approval_id ||
          activationData.reconciliationEventId !== reconciliation?.id
        )
          throw new Error('PORTABLE_IMPORT_ACTIVATION_EVIDENCE_INVALID');
        return { jobId: input.jobId, status: 'activated' as const };
      }
      const changed = await repository.transitionJob({
        tenantId: input.tenantId,
        organizationId: input.organizationId,
        jobId: input.jobId,
        from: ['committed'],
        to: 'activated',
      });
      if (!changed) throw new Error('PORTABLE_IMPORT_ACTIVATION_CONFLICT');
      await repository.appendIdempotentEventInCurrentTransaction({
        tenantId: input.tenantId,
        organizationId: input.organizationId,
        jobId: input.jobId,
        eventKey: 'commit:activated',
        type: 'commit.activated',
        severity: 'info',
        message: 'Portable import activated after reconciliation.',
        data: {
          activatedBy: input.activatedBy,
          authorizationApprovalId: authorization.approval_id,
          reconciliationEventId: reconciliation!.id,
        },
      });
      return { jobId: input.jobId, status: 'activated' as const };
    });
}

export async function revokePortableImportApproval(input: {
  db: Database;
  tenantId: string;
  organizationId: string;
  jobId: string;
  approvalId: string;
  revokedBy: string;
  reason?: string;
  now?: Date;
}) {
  return input.db
    .transaction()
    .setIsolationLevel('serializable')
    .execute(async (transaction) => {
      const repository = new ImportRepository(transaction as Database);
      const job = await repository.findJobForUpdate(
        input.tenantId,
        input.organizationId,
        input.jobId,
      );
      if (!job) throw new Error('PORTABLE_IMPORT_APPROVAL_NOT_FOUND');
      if (['committing', 'committed', 'activated'].includes(job.status))
        throw new Error('PORTABLE_IMPORT_APPROVAL_EXECUTION_STARTED');
      const existing = await repository.findPortableImportApprovalRevocation(input);
      if (existing) {
        if (existing.revoked_by !== input.revokedBy || existing.reason !== (input.reason ?? null))
          throw new Error('PORTABLE_IMPORT_APPROVAL_REVOCATION_CONFLICT');
        return existing;
      }
      return repository.revokePortableImportApproval({
        tenantId: input.tenantId,
        organizationId: input.organizationId,
        jobId: input.jobId,
        approvalId: input.approvalId,
        revokedBy: input.revokedBy,
        reason: input.reason,
        now: input.now ?? new Date(),
      });
    });
}
