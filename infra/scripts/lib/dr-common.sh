#!/usr/bin/env bash

dr_run_isolated_hook() {
  local allow_database_url="${DR_HOOK_DATABASE_URL+x}"
  local allow_database_url_mysql="${DR_HOOK_DATABASE_URL_MYSQL+x}"
  local allow_s3="${DR_HOOK_S3+x}"
  local allow_mysql_provision_receipt="${DR_HOOK_MYSQL_PROVISION_RECEIPT+x}"
  local allow_mysql_restore_lease="${DR_HOOK_MYSQL_RESTORE_LEASE+x}"
  local allow_object_ownership="${DR_HOOK_OBJECT_OWNERSHIP+x}"
  local allow_object_reconciliation="${DR_HOOK_OBJECT_RECONCILIATION+x}"
  local database_url="${DR_HOOK_DATABASE_URL:-}"
  local database_url_mysql="${DR_HOOK_DATABASE_URL_MYSQL:-}"
  local s3_endpoint="${S3_ENDPOINT:-}"
  local s3_bucket="${S3_BUCKET:-}"
  local restore_s3_bucket="${RESTORE_S3_BUCKET:-}"
  local s3_access_key_id="${S3_ACCESS_KEY_ID:-}"
  local s3_secret_access_key="${S3_SECRET_ACCESS_KEY:-}"
  local hook_path="${PATH:-/usr/bin:/bin}"
  local hook_home="${HOME:-/var/empty}"
  local hook_tmpdir="${TMPDIR:-/tmp}"
  local hook_context_file="${DR_HOOK_CONTEXT_FILE:-}"
  local recovery_point_at="${DR_RECOVERY_POINT_AT:-}"
  local temporal_checkpoint_file="${DR_TEMPORAL_CHECKPOINT_FILE:-}"
  local publish_artifact="${DR_PUBLISH_ARTIFACT:-}"
  local publish_manifest="${DR_PUBLISH_MANIFEST:-}"
  local publish_checksum="${DR_PUBLISH_CHECKSUM:-}"
  local publish_receipt="${DR_PUBLISH_RECEIPT:-}"
  local receipt_file="${DR_RECEIPT_FILE:-}"
  local retrieve_receipt="${DR_RETRIEVE_RECEIPT:-}"
  local retrieve_output="${DR_RETRIEVE_OUTPUT:-}"
  local retrieve_manifest_output="${DR_RETRIEVE_MANIFEST_OUTPUT:-}"
  local retrieve_checksum_output="${DR_RETRIEVE_CHECKSUM_OUTPUT:-}"
  local temporal_restore_evidence="${DR_TEMPORAL_RESTORE_EVIDENCE:-}"
  local temporal_evidence_file="${DR_TEMPORAL_EVIDENCE_FILE:-}"
  local object_metadata_file="${DR_OBJECT_METADATA_FILE:-}"
  local object_inventory_file="${DR_OBJECT_INVENTORY_FILE:-}"
  local object_transfer_directory="${DR_OBJECT_TRANSFER_DIRECTORY:-}"
  local object_transfer_bucket="${DR_OBJECT_TRANSFER_BUCKET:-}"
  local object_expected_inventory_sha256="${DR_OBJECT_EXPECTED_INVENTORY_SHA256:-}"
  local object_ownership_file="${DR_OBJECT_BUCKET_OWNERSHIP_FILE:-}"
  local object_restore_run_id="${DR_OBJECT_RESTORE_RUN_ID:-}"
  local mc_config_dir="${MC_CONFIG_DIR:-}"
  local mc_alias_name="${MC_ALIAS_NAME:-}"
  local mc_endpoint="${MC_ENDPOINT:-}"
  local restore_kind="${DR_RESTORE_KIND:-}"
  local mysql_provision_receipt="${DR_MYSQL_TARGET_PROVISION_RECEIPT:-}"
  local mysql_restore_attempt_id="${DR_MYSQL_RESTORE_ATTEMPT_ID:-}"
  local mysql_restore_artifact_sha256="${DR_MYSQL_RESTORE_ARTIFACT_SHA256:-}"
  local mysql_restore_lease_file="${DR_MYSQL_RESTORE_LEASE_FILE:-}"
  local mysql_restore_target_id="${DR_MYSQL_RESTORE_TARGET_ID:-}"
  (
    while IFS= read -r variable; do unset "${variable}"; done < <(compgen -e)
    export PATH="${hook_path}" HOME="${hook_home}" TMPDIR="${hook_tmpdir}"
    export LANG=C LC_ALL=C
    test -z "${hook_context_file}" || export DR_HOOK_CONTEXT_FILE="${hook_context_file}"
    test -z "${recovery_point_at}" || export DR_RECOVERY_POINT_AT="${recovery_point_at}"
    test -z "${temporal_checkpoint_file}" || export DR_TEMPORAL_CHECKPOINT_FILE="${temporal_checkpoint_file}"
    test -z "${publish_artifact}" || export DR_PUBLISH_ARTIFACT="${publish_artifact}"
    test -z "${publish_manifest}" || export DR_PUBLISH_MANIFEST="${publish_manifest}"
    test -z "${publish_checksum}" || export DR_PUBLISH_CHECKSUM="${publish_checksum}"
    test -z "${publish_receipt}" || export DR_PUBLISH_RECEIPT="${publish_receipt}"
    test -z "${receipt_file}" || export DR_RECEIPT_FILE="${receipt_file}"
    test -z "${retrieve_receipt}" || export DR_RETRIEVE_RECEIPT="${retrieve_receipt}"
    test -z "${retrieve_output}" || export DR_RETRIEVE_OUTPUT="${retrieve_output}"
    test -z "${retrieve_manifest_output}" || export DR_RETRIEVE_MANIFEST_OUTPUT="${retrieve_manifest_output}"
    test -z "${retrieve_checksum_output}" || export DR_RETRIEVE_CHECKSUM_OUTPUT="${retrieve_checksum_output}"
    test -z "${temporal_restore_evidence}" || export DR_TEMPORAL_RESTORE_EVIDENCE="${temporal_restore_evidence}"
    test -z "${temporal_evidence_file}" || export DR_TEMPORAL_EVIDENCE_FILE="${temporal_evidence_file}"
    test -z "${object_metadata_file}" || export DR_OBJECT_METADATA_FILE="${object_metadata_file}"
    test -z "${object_inventory_file}" || export DR_OBJECT_INVENTORY_FILE="${object_inventory_file}"
    test -z "${object_transfer_directory}" || export DR_OBJECT_TRANSFER_DIRECTORY="${object_transfer_directory}"
    test -z "${object_transfer_bucket}" || export DR_OBJECT_TRANSFER_BUCKET="${object_transfer_bucket}"
    test -z "${mc_config_dir}" || export MC_CONFIG_DIR="${mc_config_dir}"
    test -z "${mc_alias_name}" || export MC_ALIAS_NAME="${mc_alias_name}"
    test -z "${mc_endpoint}" || export MC_ENDPOINT="${mc_endpoint}"
    test -z "${restore_kind}" || export DR_RESTORE_KIND="${restore_kind}"
    if test -n "${allow_mysql_provision_receipt}"; then
      export DR_MYSQL_TARGET_PROVISION_RECEIPT="${mysql_provision_receipt}"
    fi
    if test -n "${allow_mysql_restore_lease}"; then
      export DR_MYSQL_RESTORE_ATTEMPT_ID="${mysql_restore_attempt_id}"
      export DR_MYSQL_RESTORE_ARTIFACT_SHA256="${mysql_restore_artifact_sha256}"
      export DR_MYSQL_RESTORE_LEASE_FILE="${mysql_restore_lease_file}"
      export DR_MYSQL_RESTORE_TARGET_ID="${mysql_restore_target_id}"
    fi
    if test -n "${allow_object_ownership}"; then
      export DR_OBJECT_BUCKET_OWNERSHIP_FILE="${object_ownership_file}"
      export DR_OBJECT_RESTORE_RUN_ID="${object_restore_run_id}"
    fi
    if test -n "${allow_object_reconciliation}"; then
      export DR_OBJECT_EXPECTED_INVENTORY_SHA256="${object_expected_inventory_sha256}"
    fi
    if test -n "${allow_database_url}"; then
      export DATABASE_URL="${database_url}"
    fi
    if test -n "${allow_database_url_mysql}"; then
      export DATABASE_URL_MYSQL="${database_url_mysql}"
    fi
    if test -n "${allow_s3}"; then
      export S3_ENDPOINT="${s3_endpoint}"
      export S3_BUCKET="${s3_bucket}"
      export RESTORE_S3_BUCKET="${restore_s3_bucket}"
      export S3_ACCESS_KEY_ID="${s3_access_key_id}"
      export S3_SECRET_ACCESS_KEY="${s3_secret_access_key}"
    else
      unset S3_ENDPOINT S3_BUCKET RESTORE_S3_BUCKET
    fi
    exec "$@"
  )
}

dr_require_backup_policy() {
  : "${DR_BACKUP_DESTINATION_CLASS:?DR_BACKUP_DESTINATION_CLASS=independent is required}"
  : "${DR_BACKUP_ENCRYPTION:?DR_BACKUP_ENCRYPTION must identify the encryption policy or key}"
  test "${DR_BACKUP_DESTINATION_CLASS}" = independent || {
    printf 'DR_BACKUP_DESTINATION_CLASS must equal independent\n' >&2
    return 1
  }
  test "${DR_BACKUP_ENCRYPTION}" != none || {
    printf 'DR_BACKUP_ENCRYPTION must not be none\n' >&2
    return 1
  }
}

dr_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  else
    shasum -a 256 "$1" | awk '{ print $1 }'
  fi
}

dr_prepare_output_directory() {
  local directory="$1"
  DIRECTORY="${directory}" node <<'NODE'
const { lstatSync, mkdirSync } = require('node:fs');
mkdirSync(process.env.DIRECTORY, { recursive: true, mode: 0o700 });
const stat = lstatSync(process.env.DIRECTORY);
if (stat.isSymbolicLink() || !stat.isDirectory()) {
  throw new Error(`Output directory must be a real directory: ${process.env.DIRECTORY}`);
}
if (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
  throw new Error(`Output directory must be caller-owned and mode 0700 or stricter: ${process.env.DIRECTORY}`);
}
NODE
}

dr_validate_s3_bucket() {
  local bucket="$1"
  BUCKET="${bucket}" node <<'NODE'
const bucket = process.env.BUCKET;
if (
  !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) ||
  bucket.includes('..') ||
  /^\d{1,3}(?:\.\d{1,3}){3}$/.test(bucket) ||
  bucket.split('.').some((label) => label.startsWith('-') || label.endsWith('-'))
) {
  throw new Error(`Invalid S3 bucket name: ${bucket}`);
}
NODE
}

dr_write_object_inventory() {
  local root="$1"
  local bucket="$2"
  local metadata_file="${3:-}"
  local output="$4"
  ROOT="${root}" BUCKET="${bucket}" METADATA_FILE="${metadata_file}" OUTPUT="${output}" node <<'NODE'
const { createHash, createHmac } = require('node:crypto');
const { closeSync, lstatSync, openSync, readFileSync, readSync, readdirSync, writeFileSync } = require('node:fs');
const { join, relative, sep } = require('node:path');
const root = process.env.ROOT;
const metadata = process.env.METADATA_FILE
  ? JSON.parse(readFileSync(process.env.METADATA_FILE, 'utf8'))
  : { objects: [] };
if (!Array.isArray(metadata.objects)) throw new Error('Object metadata export must contain an objects array');
const metadataByKey = new Map();
for (const entry of metadata.objects) {
  if (!entry || typeof entry.key !== 'string' || metadataByKey.has(entry.key)) {
    throw new Error('Object metadata export contains an invalid or duplicate key');
  }
  metadataByKey.set(entry.key, entry);
}
const objects = [];
const hashFile = (path) => {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = openSync(path, 'r');
  let sizeBytes = 0;
  try {
    for (;;) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      sizeBytes += bytesRead;
    }
  } finally {
    closeSync(descriptor);
  }
  return { sizeBytes, sha256: hash.digest('hex') };
};
const walk = (directory) => {
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`Object backup refuses symlink: ${path}`);
    if (stat.isDirectory()) {
      walk(path);
      continue;
    }
    if (!stat.isFile()) throw new Error(`Object backup refuses non-file: ${path}`);
    const key = relative(root, path).split(sep).join('/');
    if (!key || key.startsWith('/') || key.split('/').some((part) => !part || part === '.' || part === '..')) {
      throw new Error(`Object backup key is unsafe: ${key}`);
    }
    const exported = metadataByKey.get(key) || {};
    metadataByKey.delete(key);
    const objectMetadata = {
      contentType: exported.contentType ?? null,
      cacheControl: exported.cacheControl ?? null,
      contentDisposition: exported.contentDisposition ?? null,
      contentEncoding: exported.contentEncoding ?? null,
      customMetadata: exported.customMetadata ?? {},
    };
    for (const [field, value] of Object.entries(objectMetadata)) {
      if (field === 'customMetadata') {
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.entries(value).some(([key, item]) => !key || typeof item !== 'string')) {
          throw new Error(`Object metadata ${field} is invalid for ${key}`);
        }
      } else if (value !== null && (typeof value !== 'string' || value.length > 1024)) {
        throw new Error(`Object metadata ${field} is invalid for ${key}`);
      }
    }
    if (process.env.DR_PRODUCTION_BUNDLE === '1' && !objectMetadata.contentType) {
      throw new Error(`Production object metadata is missing contentType for ${key}`);
    }
    const contentIdentity = hashFile(path);
    objects.push({
      key,
      ...contentIdentity,
      metadata: objectMetadata,
    });
  }
};
walk(root);
if (metadataByKey.size) throw new Error(`Object metadata references missing key: ${metadataByKey.keys().next().value}`);
const payload = { schemaVersion: 1, bucket: process.env.BUCKET, objects };
const signature = createHmac('sha256', process.env.DR_MANIFEST_SIGNING_KEY)
  .update(JSON.stringify(payload))
  .digest('hex');
writeFileSync(process.env.OUTPUT, `${JSON.stringify({
  ...payload,
  signature: { algorithm: 'hmac-sha256', keyId: process.env.DR_MANIFEST_KEY_ID, value: signature },
}, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
NODE
}

dr_verify_object_inventory() {
  local root="$1"
  local bucket="$2"
  local inventory="$3"
  ROOT="${root}" BUCKET="${bucket}" INVENTORY="${inventory}" node <<'NODE'
const { createHash, createHmac, timingSafeEqual } = require('node:crypto');
const { closeSync, lstatSync, openSync, readFileSync, readSync, readdirSync } = require('node:fs');
const { join, relative, sep } = require('node:path');
const inventory = JSON.parse(readFileSync(process.env.INVENTORY, 'utf8'));
const { signature, ...payload } = inventory;
const expected = createHmac('sha256', process.env.DR_MANIFEST_SIGNING_KEY)
  .update(JSON.stringify(payload)).digest();
const actual = Buffer.from(signature?.value || '', 'hex');
if (signature?.algorithm !== 'hmac-sha256' || signature.keyId !== process.env.DR_MANIFEST_KEY_ID || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
  throw new Error('Object inventory signature mismatch');
}
if (payload.schemaVersion !== 1 || payload.bucket !== process.env.BUCKET || !Array.isArray(payload.objects)) {
  throw new Error('Object inventory identity is invalid');
}
const actualObjects = [];
const hashFile = (path) => {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = openSync(path, 'r');
  let sizeBytes = 0;
  try {
    for (;;) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      sizeBytes += bytesRead;
    }
  } finally {
    closeSync(descriptor);
  }
  return { sizeBytes, sha256: hash.digest('hex') };
};
const walk = (directory) => {
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`Object restore refuses symlink: ${path}`);
    if (stat.isDirectory()) { walk(path); continue; }
    if (!stat.isFile()) throw new Error(`Object restore refuses non-file: ${path}`);
    actualObjects.push({
      key: relative(process.env.ROOT, path).split(sep).join('/'),
      ...hashFile(path),
    });
  }
};
walk(process.env.ROOT);
const declared = payload.objects.map(({ key, sizeBytes, sha256, metadata }) => {
  if (!metadata || typeof metadata !== 'object') throw new Error(`Object inventory metadata is missing for ${key}`);
  return { key, sizeBytes, sha256 };
});
if (new Set(declared.map(({ key }) => key)).size !== declared.length || JSON.stringify(declared) !== JSON.stringify(actualObjects)) {
  throw new Error('Object inventory does not match archived content');
}
NODE
}

dr_assert_output_path_available() {
  local output="$1"
  OUTPUT="${output}" node <<'NODE'
const { lstatSync } = require('node:fs');
try {
  lstatSync(process.env.OUTPUT);
  throw new Error(`Refusing existing output path: ${process.env.OUTPUT}`);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
NODE
}

dr_publish_staged_file() {
  local staged="$1"
  local output="$2"
  STAGED="${staged}" OUTPUT="${output}" node <<'NODE'
const { chmodSync, linkSync, unlinkSync } = require('node:fs');
linkSync(process.env.STAGED, process.env.OUTPUT);
try {
  chmodSync(process.env.OUTPUT, 0o600);
  unlinkSync(process.env.STAGED);
} catch (error) {
  try { unlinkSync(process.env.OUTPUT); } catch {}
  throw error;
}
NODE
}

dr_file_identity() {
  local file="$1"
  FILE="${file}" node <<'NODE'
const { lstatSync } = require('node:fs');
const stat = lstatSync(process.env.FILE);
if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid()) {
  throw new Error(`Artifact identity is unsafe: ${process.env.FILE}`);
}
process.stdout.write(`${stat.dev}:${stat.ino}:${stat.size}`);
NODE
}

dr_assert_file_identity() {
  local file="$1"
  local expected="$2"
  test "$(dr_file_identity "${file}")" = "${expected}" || {
    printf 'Artifact identity changed: %s\n' "${file}" >&2
    return 1
  }
}

dr_remove_file_if_identity() {
  local file="$1"
  local expected="$2"
  FILE="${file}" EXPECTED="${expected}" node <<'NODE'
const { lstatSync, unlinkSync } = require('node:fs');
try {
  const stat = lstatSync(process.env.FILE);
  const actual = `${stat.dev}:${stat.ino}:${stat.size}`;
  if (!stat.isFile() || stat.isSymbolicLink() || actual !== process.env.EXPECTED) {
    throw new Error(`Refusing to unlink changed artifact: ${process.env.FILE}`);
  }
  unlinkSync(process.env.FILE);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
NODE
}

dr_write_checksum() {
  local artifact="$1"
  ARTIFACT="${artifact}" CHECKSUM="$(dr_sha256 "${artifact}")" node <<'NODE'
const { writeFileSync } = require('node:fs');
const { basename } = require('node:path');
writeFileSync(`${process.env.ARTIFACT}.sha256`, `${process.env.CHECKSUM}  ${basename(process.env.ARTIFACT)}\n`, {
  flag: 'wx',
  mode: 0o600,
});
NODE
}

dr_verify_checksum() {
  local artifact="$1"
  local checksum_file="${artifact}.sha256"
  test -f "${checksum_file}" || {
    printf 'Required checksum is missing: %s\n' "${checksum_file}" >&2
    return 1
  }
  local expected actual
  expected="$(awk 'NR == 1 { print $1 }' "${checksum_file}")"
  actual="$(dr_sha256 "${artifact}")"
  test -n "${expected}" && test "${expected}" = "${actual}" || {
    printf 'Checksum mismatch for %s\n' "${artifact}" >&2
    return 1
  }
}

dr_write_backup_manifest() {
  local artifact="$1"
  local kind="$2"
  local recovery_point_at="$3"
  : "${DR_MANIFEST_SIGNING_KEY:?DR_MANIFEST_SIGNING_KEY is required}"
  : "${DR_MANIFEST_KEY_ID:?DR_MANIFEST_KEY_ID is required}"
  : "${DR_SOURCE_RELEASE:?DR_SOURCE_RELEASE is required}"
  ARTIFACT="${artifact}" KIND="${kind}" RECOVERY_POINT_AT="${recovery_point_at}" \
    CHECKSUM="$(dr_sha256 "${artifact}")" node <<'NODE'
const { createHmac } = require('node:crypto');
const { statSync, writeFileSync } = require('node:fs');
const { basename } = require('node:path');
const artifact = process.env.ARTIFACT;
const manifest = {
  schemaVersion: 1,
  kind: process.env.KIND,
  artifact: basename(artifact),
  recoveryPointAt: process.env.RECOVERY_POINT_AT,
  completedAt: new Date().toISOString(),
  sizeBytes: statSync(artifact).size,
  sha256: process.env.CHECKSUM,
  sourceRelease: process.env.DR_SOURCE_RELEASE,
  encryption: process.env.DR_BACKUP_ENCRYPTION || 'provider-managed',
  destinationClass: process.env.DR_BACKUP_DESTINATION_CLASS || 'independent',
};
const value = createHmac('sha256', process.env.DR_MANIFEST_SIGNING_KEY)
  .update(JSON.stringify(manifest))
  .digest('hex');
const signed = {
  ...manifest,
  signature: { algorithm: 'hmac-sha256', keyId: process.env.DR_MANIFEST_KEY_ID, value },
};
writeFileSync(`${artifact}.manifest.json`, `${JSON.stringify(signed, null, 2)}\n`, {
  flag: 'wx',
  mode: 0o600,
});
NODE
}

dr_verify_backup_manifest() {
  local artifact="$1"
  local expected_kind="$2"
  test -f "${artifact}.manifest.json" || {
    printf 'Required backup manifest is missing: %s.manifest.json\n' "${artifact}" >&2
    return 1
  }
  : "${DR_MANIFEST_SIGNING_KEY:?DR_MANIFEST_SIGNING_KEY is required}"
  : "${DR_MANIFEST_KEY_ID:?DR_MANIFEST_KEY_ID is required}"
  ARTIFACT="${artifact}" EXPECTED_KIND="${expected_kind}" CHECKSUM="$(dr_sha256 "${artifact}")" \
    node <<'NODE'
const { createHmac, timingSafeEqual } = require('node:crypto');
const { readFileSync, statSync } = require('node:fs');
const { basename } = require('node:path');
const artifact = process.env.ARTIFACT;
const manifest = JSON.parse(readFileSync(`${artifact}.manifest.json`, 'utf8'));
const { signature, ...payload } = manifest;
if (signature?.algorithm !== 'hmac-sha256' || signature.keyId !== process.env.DR_MANIFEST_KEY_ID) throw new Error('Backup manifest signature metadata mismatch');
const expectedSignature = createHmac('sha256', process.env.DR_MANIFEST_SIGNING_KEY).update(JSON.stringify(payload)).digest();
const actualSignature = Buffer.from(signature.value || '', 'hex');
if (actualSignature.length !== expectedSignature.length || !timingSafeEqual(actualSignature, expectedSignature)) throw new Error('Backup manifest signature mismatch');
if (manifest.schemaVersion !== 1) throw new Error('Unsupported backup manifest schema');
if (manifest.kind !== process.env.EXPECTED_KIND) throw new Error('Backup kind mismatch');
if (process.env.DR_ALLOW_ARTIFACT_RENAME !== '1' && manifest.artifact !== basename(artifact)) throw new Error('Backup artifact name mismatch');
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(manifest.artifact)) throw new Error('Backup artifact name is unsafe');
if (manifest.sha256 !== process.env.CHECKSUM) throw new Error('Backup manifest checksum mismatch');
if (manifest.sizeBytes !== statSync(artifact).size) throw new Error('Backup manifest size mismatch');
if (!Number.isFinite(Date.parse(manifest.recoveryPointAt))) throw new Error('Invalid recovery point');
if (!manifest.sourceRelease || !manifest.encryption || manifest.destinationClass !== 'independent') throw new Error('Backup durability metadata is incomplete');
NODE
}

dr_reserve_restore_evidence() {
  local evidence_file="${DR_EVIDENCE_FILE:-}"
  test -n "${evidence_file}" || return 0
  if ! DR_EVIDENCE_RESERVATION_TOKEN="$(DR_EVIDENCE_FILE="${evidence_file}" node 2>&1 <<'NODE'
const { randomBytes } = require('node:crypto');
const { lstatSync, mkdirSync, writeFileSync } = require('node:fs');
const { dirname } = require('node:path');
const evidenceFile = process.env.DR_EVIDENCE_FILE;
const evidenceDirectory = dirname(evidenceFile);
mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
if (lstatSync(evidenceDirectory).isSymbolicLink()) {
  throw new Error('DR evidence directory must not be a symlink');
}
try {
  lstatSync(evidenceFile);
  throw new Error(`Refusing existing DR evidence path: ${evidenceFile}`);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const token = randomBytes(32).toString('hex');
writeFileSync(`${evidenceFile}.in-progress`, `${token}\n`, { flag: 'wx', mode: 0o600 });
process.stdout.write(token);
NODE
  )"; then
    printf '%s\n' "${DR_EVIDENCE_RESERVATION_TOKEN}" >&2
    unset DR_EVIDENCE_RESERVATION_TOKEN
    return 1
  fi
  export DR_EVIDENCE_RESERVATION_TOKEN
}

dr_record_restore_evidence() {
  local artifact="$1"
  local kind="$2"
  local started_epoch="$3"
  local evidence_file="${DR_EVIDENCE_FILE:-}"
  test -n "${evidence_file}" || return 0
  : "${DR_INCIDENT_AT:?DR_INCIDENT_AT is required when DR_EVIDENCE_FILE is set}"
  : "${DR_RESTORE_TARGET_ID:?DR_RESTORE_TARGET_ID is required when DR_EVIDENCE_FILE is set}"
  : "${DR_TARGET_RELEASE:?DR_TARGET_RELEASE is required when DR_EVIDENCE_FILE is set}"
  : "${DR_MANIFEST_SIGNING_KEY:?DR_MANIFEST_SIGNING_KEY is required}"
  : "${DR_MANIFEST_KEY_ID:?DR_MANIFEST_KEY_ID is required}"
  : "${DR_LAST_VERIFIER_SHA256:?dr_run_restore_verifier must bind the verifier before evidence is recorded}"
  : "${DR_EVIDENCE_RESERVATION_TOKEN:?dr_reserve_restore_evidence must reserve the evidence path before restoration}"
  test "$(dr_sha256 "${DR_VERIFY_COMMAND}")" = "${DR_LAST_VERIFIER_SHA256}" || {
    printf 'Restore verifier changed after execution: %s\n' "${DR_VERIFY_COMMAND}" >&2
    return 1
  }
  ARTIFACT="${artifact}" KIND="${kind}" STARTED_EPOCH="${started_epoch}" \
    INCIDENT_AT="${DR_INCIDENT_AT}" EVIDENCE_FILE="${evidence_file}" \
    VERIFIER_SHA256="${DR_LAST_VERIFIER_SHA256}" \
    RESERVATION_TOKEN="${DR_EVIDENCE_RESERVATION_TOKEN}" \
    COMPONENT_FILES="${DR_RESTORE_COMPONENT_FILES:-}" \
    DATABASE_MANIFEST="${DR_RESTORE_DATABASE_MANIFEST:-}" \
    OBJECT_MANIFEST="${DR_RESTORE_OBJECT_MANIFEST:-}" \
    EXPECTED_DATABASE_TARGET_ID="${DR_EXPECTED_DATABASE_TARGET_ID:-}" \
    EXPECTED_OBJECT_TARGET_ID="${DR_EXPECTED_OBJECT_TARGET_ID:-}" \
    TARGET_RELEASE="${DR_TARGET_RELEASE}" \
    ADAPTER_COMMANDS="${DR_RESTORE_ADAPTER_COMMANDS:-}" \
    ADAPTER_EVIDENCE_FILES="${DR_RESTORE_ADAPTER_EVIDENCE_FILES:-}" \
    TEMPORAL_EVIDENCE_SHA256="${DR_TEMPORAL_EVIDENCE_SHA256:-}" node <<'NODE'
const { createHash, createHmac } = require('node:crypto');
const { lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } = require('node:fs');
const { dirname } = require('node:path');
const manifest = JSON.parse(readFileSync(`${process.env.ARTIFACT}.manifest.json`, 'utf8'));
const incident = Date.parse(process.env.INCIDENT_AT);
const recoveryPoint = Date.parse(manifest.recoveryPointAt);
if (!Number.isFinite(incident) || incident < recoveryPoint) throw new Error('DR_INCIDENT_AT must be at or after the recovery point');
const completed = new Date();
if (incident > completed.getTime()) throw new Error('DR_INCIDENT_AT must not be in the future');
if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(process.env.DR_RESTORE_TARGET_ID)) throw new Error('DR_RESTORE_TARGET_ID must be an opaque non-secret identifier');
const componentFiles = (process.env.COMPONENT_FILES || '').split(',').filter(Boolean);
const hashFiles = (value) => value.split(',').filter(Boolean).map((file) => ({
  file: file.split('/').pop(),
  sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
}));
const adapterSha256 = hashFiles(process.env.ADAPTER_COMMANDS || '');
const adapterEvidenceSha256 = hashFiles(process.env.ADAPTER_EVIDENCE_FILES || '');
const componentEvidenceSha256 = componentFiles.map((file) => {
  const contents = readFileSync(file);
  const name = file.split('/').pop();
  if (name === 'database.json' || name === 'object-storage.json') {
    const evidence = JSON.parse(contents);
    const { signature, ...signedPayload } = evidence;
    const expected = createHmac('sha256', process.env.DR_MANIFEST_SIGNING_KEY)
      .update(JSON.stringify(signedPayload))
      .digest('hex');
    if (signature?.algorithm !== 'hmac-sha256' || signature.keyId !== process.env.DR_MANIFEST_KEY_ID || signature.value !== expected) {
      throw new Error(`Component restore evidence signature mismatch: ${name}`);
    }
    if (signedPayload.verification !== 'command-completed') {
      throw new Error(`Component restore evidence is incomplete: ${name}`);
    }
    if (name === 'database.json' && !['postgres', 'mysql'].includes(signedPayload.kind)) {
      throw new Error('Database restore evidence kind is invalid');
    }
    if (name === 'object-storage.json' && signedPayload.kind !== 'object-storage') {
      throw new Error('Object restore evidence kind is invalid');
    }
    const componentManifestFile = name === 'database.json'
      ? process.env.DATABASE_MANIFEST
      : process.env.OBJECT_MANIFEST;
    const expectedTargetId = name === 'database.json'
      ? process.env.EXPECTED_DATABASE_TARGET_ID
      : process.env.EXPECTED_OBJECT_TARGET_ID;
    if (!componentManifestFile || !expectedTargetId) {
      throw new Error(`Aggregate component binding is incomplete: ${name}`);
    }
    const componentManifest = JSON.parse(readFileSync(componentManifestFile, 'utf8'));
    if (
      signedPayload.artifactSha256 !== componentManifest.sha256 ||
      signedPayload.recoveryPointAt !== componentManifest.recoveryPointAt ||
      signedPayload.sourceRelease !== componentManifest.sourceRelease ||
      signedPayload.targetRelease !== process.env.TARGET_RELEASE ||
      signedPayload.restoreTargetId !== expectedTargetId
    ) {
      throw new Error(`Component restore evidence does not match this drill: ${name}`);
    }
  }
  const sha256 = createHash('sha256').update(contents).digest('hex');
  if (name === 'temporal.json' && sha256 !== process.env.TEMPORAL_EVIDENCE_SHA256) {
    throw new Error('Temporal restore evidence changed after authentication');
  }
  return { file: name, sha256 };
});
const payload = {
  schemaVersion: 1,
  kind: process.env.KIND,
  artifactSha256: manifest.sha256,
  sourceRelease: manifest.sourceRelease,
  targetRelease: process.env.DR_TARGET_RELEASE,
  restoreTargetId: process.env.DR_RESTORE_TARGET_ID,
  verifierSha256: process.env.VERIFIER_SHA256,
  recoveryPointAt: manifest.recoveryPointAt,
  incidentAt: new Date(incident).toISOString(),
  restoreStartedAt: new Date(Number(process.env.STARTED_EPOCH) * 1000).toISOString(),
  restoreCompletedAt: completed.toISOString(),
  measuredRpoSeconds: Math.floor((incident - recoveryPoint) / 1000),
  restoreDurationSeconds: Math.max(0, Math.ceil(completed.getTime() / 1000 - Number(process.env.STARTED_EPOCH))),
  measuredRtoSeconds: Math.max(0, Math.ceil((completed.getTime() - incident) / 1000)),
  verification: 'command-completed',
  componentEvidenceSha256,
  adapterSha256,
  adapterEvidenceSha256,
};
const signature = createHmac('sha256', process.env.DR_MANIFEST_SIGNING_KEY).update(JSON.stringify(payload)).digest('hex');
const evidence = { ...payload, signature: { algorithm: 'hmac-sha256', keyId: process.env.DR_MANIFEST_KEY_ID, value: signature } };
const evidenceDirectory = dirname(process.env.EVIDENCE_FILE);
mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
if (lstatSync(evidenceDirectory).isSymbolicLink()) throw new Error('DR evidence directory must not be a symlink');
const reservationFile = `${process.env.EVIDENCE_FILE}.in-progress`;
if (readFileSync(reservationFile, 'utf8').trim() !== process.env.RESERVATION_TOKEN) {
  throw new Error('DR evidence reservation token mismatch');
}
writeFileSync(process.env.EVIDENCE_FILE, `${JSON.stringify(evidence, null, 2)}\n`, {
  flag: 'wx',
  mode: 0o600,
});
unlinkSync(reservationFile);
NODE
  local record_status=$?
  test "${record_status}" = 0 || return "${record_status}"
  unset DR_EVIDENCE_RESERVATION_TOKEN
  DR_RESTORE_EVIDENCE_RECORDED=1
}

dr_run_restore_verifier() {
  local kind="$1"
  : "${DR_VERIFY_COMMAND:?DR_VERIFY_COMMAND must be an executable reconciliation verifier}"
  test -x "${DR_VERIFY_COMMAND}" || {
    printf 'DR_VERIFY_COMMAND is not executable: %s\n' "${DR_VERIFY_COMMAND}" >&2
    return 1
  }
  local verifier_sha256_before verifier_sha256_after
  verifier_sha256_before="$(dr_sha256 "${DR_VERIFY_COMMAND}")"
  case "${kind}" in
    postgres)
      DR_HOOK_DATABASE_URL="${DATABASE_URL:-}" DR_RESTORE_KIND="${kind}" \
        dr_run_isolated_hook "${DR_VERIFY_COMMAND}"
      ;;
    mysql)
      DR_HOOK_DATABASE_URL_MYSQL="${DATABASE_URL_MYSQL:-}" DR_RESTORE_KIND="${kind}" \
        dr_run_isolated_hook "${DR_VERIFY_COMMAND}"
      ;;
    object-storage)
      DR_HOOK_S3=1 DR_RESTORE_KIND="${kind}" dr_run_isolated_hook "${DR_VERIFY_COMMAND}"
      ;;
    *)
      DR_RESTORE_KIND="${kind}" dr_run_isolated_hook "${DR_VERIFY_COMMAND}"
      ;;
  esac
  verifier_sha256_after="$(dr_sha256 "${DR_VERIFY_COMMAND}")"
  test "${verifier_sha256_before}" = "${verifier_sha256_after}" || {
    printf 'Restore verifier changed during execution: %s\n' "${DR_VERIFY_COMMAND}" >&2
    return 1
  }
  DR_LAST_VERIFIER_SHA256="${verifier_sha256_after}"
}

dr_verify_restore_evidence() {
  local evidence_file="$1"
  local expected_kind="${2:-}"
  : "${DR_MANIFEST_SIGNING_KEY:?DR_MANIFEST_SIGNING_KEY is required}"
  : "${DR_MANIFEST_KEY_ID:?DR_MANIFEST_KEY_ID is required}"
  EVIDENCE_FILE="${evidence_file}" EXPECTED_KIND="${expected_kind}" node <<'NODE'
const { createHmac, timingSafeEqual } = require('node:crypto');
const { readFileSync } = require('node:fs');
const evidence = JSON.parse(readFileSync(process.env.EVIDENCE_FILE, 'utf8'));
const { signature, ...payload } = evidence;
if (payload.schemaVersion !== 1 || payload.verification !== 'command-completed' || !payload.restoreTargetId || !payload.targetRelease || !payload.verifierSha256) throw new Error('Restore evidence is not eligible for cutover');
if (process.env.EXPECTED_KIND && payload.kind !== process.env.EXPECTED_KIND) throw new Error('Restore evidence kind is not eligible for cutover');
if (process.env.EXPECTED_KIND === 'production-bundle') {
  const expectedComponents = ['database.json', 'object-storage.json', 'temporal.json'];
  if (!Array.isArray(payload.componentEvidenceSha256) || payload.componentEvidenceSha256.length !== expectedComponents.length) throw new Error('Production restore evidence must bind exactly three component results');
  const components = payload.componentEvidenceSha256.map((component) => component?.file).sort();
  if (JSON.stringify(components) !== JSON.stringify(expectedComponents)) throw new Error('Production restore evidence component set is invalid');
  if (new Set(payload.componentEvidenceSha256.map((component) => component.sha256)).size !== expectedComponents.length || payload.componentEvidenceSha256.some((component) => !/^[a-f0-9]{64}$/.test(component.sha256))) throw new Error('Production restore evidence component hashes are invalid');
}
if (signature?.algorithm !== 'hmac-sha256' || signature.keyId !== process.env.DR_MANIFEST_KEY_ID) throw new Error('Restore evidence signature metadata mismatch');
const expected = createHmac('sha256', process.env.DR_MANIFEST_SIGNING_KEY).update(JSON.stringify(payload)).digest();
const actual = Buffer.from(signature.value || '', 'hex');
if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('Restore evidence signature mismatch');
NODE
}
