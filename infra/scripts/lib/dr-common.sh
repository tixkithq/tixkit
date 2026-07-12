#!/usr/bin/env bash

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

dr_write_checksum() {
  local artifact="$1"
  printf '%s  %s\n' "$(dr_sha256 "${artifact}")" "$(basename "${artifact}")" >"${artifact}.sha256"
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
writeFileSync(`${artifact}.manifest.json`, `${JSON.stringify(signed, null, 2)}\n`, { mode: 0o600 });
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
  ARTIFACT="${artifact}" KIND="${kind}" STARTED_EPOCH="${started_epoch}" \
    INCIDENT_AT="${DR_INCIDENT_AT}" EVIDENCE_FILE="${evidence_file}" \
    VERIFIER="${DR_VERIFY_COMMAND}" node <<'NODE'
const { createHash, createHmac } = require('node:crypto');
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { dirname } = require('node:path');
const manifest = JSON.parse(readFileSync(`${process.env.ARTIFACT}.manifest.json`, 'utf8'));
const incident = Date.parse(process.env.INCIDENT_AT);
const recoveryPoint = Date.parse(manifest.recoveryPointAt);
if (!Number.isFinite(incident) || incident < recoveryPoint) throw new Error('DR_INCIDENT_AT must be at or after the recovery point');
const completed = new Date();
if (incident > completed.getTime()) throw new Error('DR_INCIDENT_AT must not be in the future');
if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(process.env.DR_RESTORE_TARGET_ID)) throw new Error('DR_RESTORE_TARGET_ID must be an opaque non-secret identifier');
const componentEvidenceSha256 = (process.env.DR_RESTORE_COMPONENT_FILES || '')
  .split(',').filter(Boolean)
  .map((file) => ({ file: file.split('/').pop(), sha256: createHash('sha256').update(readFileSync(file)).digest('hex') }));
const payload = {
  schemaVersion: 1,
  kind: process.env.KIND,
  artifactSha256: manifest.sha256,
  sourceRelease: manifest.sourceRelease,
  targetRelease: process.env.DR_TARGET_RELEASE,
  restoreTargetId: process.env.DR_RESTORE_TARGET_ID,
  verifierSha256: createHash('sha256').update(readFileSync(process.env.VERIFIER)).digest('hex'),
  recoveryPointAt: manifest.recoveryPointAt,
  incidentAt: new Date(incident).toISOString(),
  restoreStartedAt: new Date(Number(process.env.STARTED_EPOCH) * 1000).toISOString(),
  restoreCompletedAt: completed.toISOString(),
  measuredRpoSeconds: Math.floor((incident - recoveryPoint) / 1000),
  restoreDurationSeconds: Math.max(0, Math.ceil(completed.getTime() / 1000 - Number(process.env.STARTED_EPOCH))),
  measuredRtoSeconds: Math.max(0, Math.ceil((completed.getTime() - incident) / 1000)),
  verification: 'command-completed',
  componentEvidenceSha256,
};
const signature = createHmac('sha256', process.env.DR_MANIFEST_SIGNING_KEY).update(JSON.stringify(payload)).digest('hex');
const evidence = { ...payload, signature: { algorithm: 'hmac-sha256', keyId: process.env.DR_MANIFEST_KEY_ID, value: signature } };
mkdirSync(dirname(process.env.EVIDENCE_FILE), { recursive: true });
writeFileSync(process.env.EVIDENCE_FILE, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
NODE
}

dr_run_restore_verifier() {
  local kind="$1"
  : "${DR_VERIFY_COMMAND:?DR_VERIFY_COMMAND must be an executable reconciliation verifier}"
  test -x "${DR_VERIFY_COMMAND}" || {
    printf 'DR_VERIFY_COMMAND is not executable: %s\n' "${DR_VERIFY_COMMAND}" >&2
    return 1
  }
  DR_RESTORE_KIND="${kind}" "${DR_VERIFY_COMMAND}"
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
