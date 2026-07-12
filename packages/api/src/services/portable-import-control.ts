import { createHash, createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { ImportRepository, type Database } from '@tixkit/db';
import {
  canonicalPortableJson,
  createPortableDryRunReceipt,
  parsePortableJson,
  portableManifestSha256,
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
  return stablePortableControlHash({
    configuration: parsedJson(job.configuration),
    files: files.map((file) => ({
      id: file.id,
      sha256: file.sha256,
      byteSize: String(file.byte_size),
    })),
    mappings: mappings.map((mapping) => ({
      id: mapping.id,
      version: mapping.version,
      mapping: stablePortableControlHash(parsedJson(mapping.mapping)),
    })),
    rows: rows.map((row) => ({
      id: row.id,
      source: stablePortableControlHash(parsedJson(row.source_data)),
      normalized: stablePortableControlHash(parsedJson(row.normalized_data)),
    })),
  });
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
    canonicalPortableJson(preflight.requiredRebindings) !== evidence.required_rebindings
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
          idempotencyKeySha256 = createHash('sha256').update(input.idempotencyKey).digest('hex');
          requestFingerprint = createHash('sha256')
            .update(
              canonicalPortableJson({
                action: 'portable-import.approve',
                approvedBy: input.approvedBy,
                jobId: input.jobId,
                receiptSha256: storedReceipt.receipt_sha256,
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
    .execute(async (transaction) => {
      const transactionDatabase = transaction as Database;
      const repository = new ImportRepository(transactionDatabase);
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
        db: transactionDatabase,
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
        db: transactionDatabase,
        tenantId: input.tenantId,
        organizationId: input.organizationId,
        jobId: input.jobId,
        sourceSystem: job.source_system,
      });
      if (
        summary?.accepted !== true ||
        summary.inputHash !== currentInputSha256 ||
        approval.input_sha256 !== currentInputSha256
      )
        throw new Error('PORTABLE_IMPORT_APPROVAL_INPUT_CHANGED');
      return approval;
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
  return new ImportRepository(input.db).revokePortableImportApproval({
    tenantId: input.tenantId,
    organizationId: input.organizationId,
    jobId: input.jobId,
    approvalId: input.approvalId,
    revokedBy: input.revokedBy,
    reason: input.reason,
    now: input.now ?? new Date(),
  });
}
