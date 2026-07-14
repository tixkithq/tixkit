#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib/dr-common.sh"

: "${DR_EVIDENCE_DIR:?DR_EVIDENCE_DIR must contain the completed Production restore evidence}"
: "${DR_PRODUCTION_TARGET_CLAIM_COMPLETE_COMMAND:?DR_PRODUCTION_TARGET_CLAIM_COMPLETE_COMMAND is required}"
: "${DR_PRODUCTION_TARGET_CLAIM_VERIFY_COMMAND:?DR_PRODUCTION_TARGET_CLAIM_VERIFY_COMMAND is required}"
test -x "${DR_PRODUCTION_TARGET_CLAIM_COMPLETE_COMMAND}" || {
  echo 'Production target claim completion command is not executable' >&2
  exit 1
}
test -x "${DR_PRODUCTION_TARGET_CLAIM_VERIFY_COMMAND}" || {
  echo 'Production target claim verifier is not executable' >&2
  exit 1
}

export DR_PRODUCTION_RESTORE_EVIDENCE_FILE="${DR_EVIDENCE_DIR}/production.json"
export DR_PRODUCTION_RESTORE_LEASE_FILE="${DR_EVIDENCE_DIR}/production-target-lease.json"
export DR_PRODUCTION_TARGET_CLAIM_RECEIPT="${DR_EVIDENCE_DIR}/production-target-claim.json"
test -f "${DR_PRODUCTION_RESTORE_EVIDENCE_FILE}" && test ! -L "${DR_PRODUCTION_RESTORE_EVIDENCE_FILE}" || {
  echo 'Signed Production restore evidence must be a real file' >&2
  exit 1
}
test -f "${DR_PRODUCTION_RESTORE_LEASE_FILE}" && test ! -L "${DR_PRODUCTION_RESTORE_LEASE_FILE}" || {
  echo 'Production target lease evidence must be a real file' >&2
  exit 1
}

restore_evidence_identity="$(dr_file_identity "${DR_PRODUCTION_RESTORE_EVIDENCE_FILE}")"
restore_evidence_sha256="$(dr_sha256 "${DR_PRODUCTION_RESTORE_EVIDENCE_FILE}")"
lease_identity="$(dr_file_identity "${DR_PRODUCTION_RESTORE_LEASE_FILE}")"
lease_sha256="$(dr_sha256 "${DR_PRODUCTION_RESTORE_LEASE_FILE}")"
completer_sha256="$(dr_sha256 "${DR_PRODUCTION_TARGET_CLAIM_COMPLETE_COMMAND}")"
verifier_sha256="$(dr_sha256 "${DR_PRODUCTION_TARGET_CLAIM_VERIFY_COMMAND}")"
DR_ALLOW_HISTORICAL_PRODUCTION_LEASE=1 dr_verify_restore_evidence "${DR_PRODUCTION_RESTORE_EVIDENCE_FILE}" production-bundle

IFS=$'\t' read -r DR_PRODUCTION_RESTORE_ATTEMPT_ID DR_PRODUCTION_BUNDLE_SHA256 \
  DR_PRODUCTION_TARGET_ID DR_DATABASE_TARGET_ID DR_OBJECT_TARGET_ID \
  DR_PRODUCTION_TEMPORAL_IMMUTABLE_ID DR_PRODUCTION_RECOVERY_POINT_AT \
  DR_PRODUCTION_SOURCE_RELEASE DR_TARGET_RELEASE DR_PRODUCTION_TARGET_RECEIPT_SHA256 \
  DR_PRODUCTION_PUBLICATION_RECEIPT_SHA256 DR_PRODUCTION_LEASE_HOLDER_PID \
  DR_PRODUCTION_FENCING_GENERATION < <(
  RESTORE_EVIDENCE="${DR_PRODUCTION_RESTORE_EVIDENCE_FILE}" \
    LEASE_EVIDENCE="${DR_PRODUCTION_RESTORE_LEASE_FILE}" LEASE_SHA256="${lease_sha256}" node <<'NODE'
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const evidence = JSON.parse(readFileSync(process.env.RESTORE_EVIDENCE, 'utf8'));
const leaseBytes = readFileSync(process.env.LEASE_EVIDENCE);
const lease = JSON.parse(leaseBytes);
const outer = evidence.outerTargetClaim;
const boundLease = evidence.adapterEvidenceSha256?.find(({ file }) => file === 'production-target-lease.json');
if (!boundLease || boundLease.sha256 !== process.env.LEASE_SHA256 || createHash('sha256').update(leaseBytes).digest('hex') !== process.env.LEASE_SHA256) {
  throw new Error('Production target lease is not bound by the signed restore evidence');
}
for (const field of ['attemptId', 'bundleSha256', 'productionTargetId', 'databaseTargetId', 'objectTargetId', 'temporalImmutableId', 'recoveryPointAt', 'sourceRelease', 'targetRelease', 'targetReceiptSha256', 'publicationReceiptSha256']) {
  if (lease[field] !== outer[field]) throw new Error(`Production target lease ${field} does not match signed restore evidence`);
}
if (!Number.isInteger(lease.holderPid) || lease.holderPid < 2) throw new Error('Production target lease holder PID is invalid');
if (!Number.isInteger(lease.fencingGeneration) || lease.fencingGeneration < 1) throw new Error('Production target lease fencing generation is invalid');
const values = [
  lease.attemptId, lease.bundleSha256, lease.productionTargetId, lease.databaseTargetId,
  lease.objectTargetId, lease.temporalImmutableId, lease.recoveryPointAt, lease.sourceRelease,
  lease.targetRelease, lease.targetReceiptSha256, lease.publicationReceiptSha256,
  String(lease.holderPid), String(lease.fencingGeneration),
];
if (values.some((value) => typeof value !== 'string' || !value || /[\t\r\n]/.test(value))) {
  throw new Error('Production target claim recovery context contains unsafe values');
}
process.stdout.write(`${values.join('\t')}\n`);
NODE
)
export DR_PRODUCTION_RESTORE_ATTEMPT_ID DR_PRODUCTION_BUNDLE_SHA256 DR_PRODUCTION_TARGET_ID
export DR_DATABASE_TARGET_ID DR_OBJECT_TARGET_ID DR_PRODUCTION_TEMPORAL_IMMUTABLE_ID
export DR_PRODUCTION_RECOVERY_POINT_AT DR_PRODUCTION_SOURCE_RELEASE DR_TARGET_RELEASE
export DR_PRODUCTION_TARGET_RECEIPT_SHA256 DR_PRODUCTION_PUBLICATION_RECEIPT_SHA256
export DR_PRODUCTION_LEASE_HOLDER_PID DR_PRODUCTION_FENCING_GENERATION
export DR_PRODUCTION_RESTORE_EVIDENCE_SHA256="${restore_evidence_sha256}"

claim_json="$(DR_HOOK_PRODUCTION_RESTORE_LEASE=1 dr_run_isolated_hook "${DR_PRODUCTION_TARGET_CLAIM_COMPLETE_COMMAND}")"
dr_assert_file_identity "${DR_PRODUCTION_RESTORE_EVIDENCE_FILE}" "${restore_evidence_identity}"
dr_assert_file_identity "${DR_PRODUCTION_RESTORE_LEASE_FILE}" "${lease_identity}"
test "$(dr_sha256 "${DR_PRODUCTION_RESTORE_EVIDENCE_FILE}")" = "${restore_evidence_sha256}"
test "$(dr_sha256 "${DR_PRODUCTION_RESTORE_LEASE_FILE}")" = "${lease_sha256}"
test "$(dr_sha256 "${DR_PRODUCTION_TARGET_CLAIM_COMPLETE_COMMAND}")" = "${completer_sha256}"

CLAIM_JSON="${claim_json}" CLAIM_FILE="${DR_PRODUCTION_TARGET_CLAIM_RECEIPT}" \
  EXPECTED_EVIDENCE_SHA256="${restore_evidence_sha256}" \
  EXPECTED_BUNDLE_SHA256="${DR_PRODUCTION_BUNDLE_SHA256}" \
  EXPECTED_TARGET_ID="${DR_PRODUCTION_TARGET_ID}" \
  EXPECTED_FENCING_GENERATION="${DR_PRODUCTION_FENCING_GENERATION}" node <<'NODE'
const { lstatSync, readFileSync, writeFileSync } = require('node:fs');
const claim = JSON.parse(process.env.CLAIM_JSON);
if (claim.schemaVersion !== 1 || claim.status !== 'completed' || claim.active !== false) throw new Error('Provider completion receipt status mismatch');
if (claim.restoreEvidenceSha256 !== process.env.EXPECTED_EVIDENCE_SHA256) throw new Error('Provider completion receipt evidence mismatch');
if (claim.bundleSha256 !== process.env.EXPECTED_BUNDLE_SHA256) throw new Error('Provider completion receipt bundle mismatch');
if (claim.productionTargetId !== process.env.EXPECTED_TARGET_ID) throw new Error('Provider completion receipt target mismatch');
if (String(claim.fencingGeneration) !== process.env.EXPECTED_FENCING_GENERATION) throw new Error('Provider completion receipt fencing generation mismatch');
if (!/^[a-f0-9]{64,128}$/.test(claim.providerSignature || '')) throw new Error('Provider completion receipt signature metadata mismatch');
if (!Number.isFinite(Date.parse(claim.completedAt))) throw new Error('Provider completion receipt timestamp mismatch');
const canonical = `${JSON.stringify(claim, null, 2)}\n`;
try {
  writeFileSync(process.env.CLAIM_FILE, canonical, { flag: 'wx', mode: 0o600 });
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  if (lstatSync(process.env.CLAIM_FILE).isSymbolicLink()) throw new Error('Existing provider completion receipt must not be a symlink');
  const existing = JSON.parse(readFileSync(process.env.CLAIM_FILE, 'utf8'));
  if (JSON.stringify(existing) !== JSON.stringify(claim)) throw new Error('Existing provider completion receipt conflicts with provider state');
}
NODE

claim_identity="$(dr_file_identity "${DR_PRODUCTION_TARGET_CLAIM_RECEIPT}")"
claim_sha256="$(dr_sha256 "${DR_PRODUCTION_TARGET_CLAIM_RECEIPT}")"
DR_HOOK_PRODUCTION_COMPLETED_CLAIM=1 dr_run_isolated_hook "${DR_PRODUCTION_TARGET_CLAIM_VERIFY_COMMAND}"
dr_assert_file_identity "${DR_PRODUCTION_TARGET_CLAIM_RECEIPT}" "${claim_identity}"
test "$(dr_sha256 "${DR_PRODUCTION_TARGET_CLAIM_RECEIPT}")" = "${claim_sha256}"
test "$(dr_sha256 "${DR_PRODUCTION_TARGET_CLAIM_VERIFY_COMMAND}")" = "${verifier_sha256}"
printf 'Production restore claim finalized: %s\n' "${DR_PRODUCTION_TARGET_CLAIM_RECEIPT}"
