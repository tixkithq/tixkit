#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib/dr-common.sh"

: "${DR_RESTORE_EVIDENCE_FILE:?DR_RESTORE_EVIDENCE_FILE is required}"
: "${DR_CUTOVER_COMMAND:?DR_CUTOVER_COMMAND must atomically bind the restored target}"
: "${DR_CUTOVER_VERIFY_COMMAND:?DR_CUTOVER_VERIFY_COMMAND must verify the promoted runtime}"
: "${DR_ROLLBACK_COMMAND:?DR_ROLLBACK_COMMAND must restore the previous binding}"
: "${DR_ROLLBACK_VERIFY_COMMAND:?DR_ROLLBACK_VERIFY_COMMAND must verify the previous runtime}"
: "${DR_PROMOTION_EVIDENCE_FILE:?DR_PROMOTION_EVIDENCE_FILE is required}"
: "${DR_PRODUCTION_TARGET_CLAIM_RECEIPT:?DR_PRODUCTION_TARGET_CLAIM_RECEIPT is required}"
: "${DR_PRODUCTION_TARGET_CLAIM_VERIFY_COMMAND:?DR_PRODUCTION_TARGET_CLAIM_VERIFY_COMMAND must query provider-authoritative completed claim state}"

for command_path in "${DR_CUTOVER_COMMAND}" "${DR_CUTOVER_VERIFY_COMMAND}" "${DR_ROLLBACK_COMMAND}" "${DR_ROLLBACK_VERIFY_COMMAND}" "${DR_PRODUCTION_TARGET_CLAIM_VERIFY_COMMAND}"; do
  test -x "${command_path}" || {
    printf 'Required command is not executable: %s\n' "${command_path}" >&2
    exit 1
  }
done
DR_ALLOW_HISTORICAL_PRODUCTION_LEASE=1 dr_verify_restore_evidence "${DR_RESTORE_EVIDENCE_FILE}" production-bundle
test -f "${DR_PRODUCTION_TARGET_CLAIM_RECEIPT}" && test ! -L "${DR_PRODUCTION_TARGET_CLAIM_RECEIPT}" || {
  echo 'Production target claim receipt must be a real file' >&2
  exit 1
}

restore_evidence_identity="$(dr_file_identity "${DR_RESTORE_EVIDENCE_FILE}")"
restore_evidence_sha256="$(dr_sha256 "${DR_RESTORE_EVIDENCE_FILE}")"
claim_receipt_identity="$(dr_file_identity "${DR_PRODUCTION_TARGET_CLAIM_RECEIPT}")"
claim_receipt_sha256="$(dr_sha256 "${DR_PRODUCTION_TARGET_CLAIM_RECEIPT}")"
claim_verifier_identity="$(dr_file_identity "${DR_PRODUCTION_TARGET_CLAIM_VERIFY_COMMAND}")"
claim_verifier_sha256="$(dr_sha256 "${DR_PRODUCTION_TARGET_CLAIM_VERIFY_COMMAND}")"
cutover_command_identity="$(dr_file_identity "${DR_CUTOVER_COMMAND}")"
cutover_command_sha256="$(dr_sha256 "${DR_CUTOVER_COMMAND}")"
cutover_verify_identity="$(dr_file_identity "${DR_CUTOVER_VERIFY_COMMAND}")"
cutover_verify_sha256="$(dr_sha256 "${DR_CUTOVER_VERIFY_COMMAND}")"
rollback_command_identity="$(dr_file_identity "${DR_ROLLBACK_COMMAND}")"
rollback_command_sha256="$(dr_sha256 "${DR_ROLLBACK_COMMAND}")"
rollback_verify_identity="$(dr_file_identity "${DR_ROLLBACK_VERIFY_COMMAND}")"
rollback_verify_sha256="$(dr_sha256 "${DR_ROLLBACK_VERIFY_COMMAND}")"

promotion_reservation="${DR_PROMOTION_EVIDENCE_FILE}.in-progress"
promotion_reservation_token="$(OUTPUT="${DR_PROMOTION_EVIDENCE_FILE}" RESERVATION="${promotion_reservation}" node <<'NODE'
const { lstatSync, mkdirSync, writeFileSync } = require('node:fs');
const { dirname } = require('node:path');
const output = process.env.OUTPUT;
const directory = dirname(output);
mkdirSync(directory, { recursive: true, mode: 0o700 });
if (lstatSync(directory).isSymbolicLink()) throw new Error('Promotion evidence directory must not be a symlink');
for (const path of [output, process.env.RESERVATION]) {
  try {
    lstatSync(path);
    throw new Error(`Refusing existing promotion evidence path: ${path}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
const token = require('node:crypto').randomBytes(32).toString('hex');
writeFileSync(process.env.RESERVATION, `${token}\n`, { flag: 'wx', mode: 0o600 });
process.stdout.write(token);
NODE
)"
promotion_evidence_written=0
cleanup() {
  test "${promotion_evidence_written}" = 1 || rm -f "${promotion_reservation}" "${promotion_reservation}.evidence"
}
trap cleanup EXIT

export DR_PRODUCTION_RESTORE_EVIDENCE_FILE="${DR_RESTORE_EVIDENCE_FILE}"
export DR_PRODUCTION_RESTORE_EVIDENCE_SHA256="${restore_evidence_sha256}"
DR_HOOK_PRODUCTION_COMPLETED_CLAIM=1 dr_run_isolated_hook "${DR_PRODUCTION_TARGET_CLAIM_VERIFY_COMMAND}"

assert_pinned_file() {
  local path="$1" identity="$2" sha256="$3"
  dr_assert_file_identity "${path}" "${identity}" && test "$(dr_sha256 "${path}")" = "${sha256}"
}

assert_promotion_inputs_unchanged() {
  assert_pinned_file "${DR_RESTORE_EVIDENCE_FILE}" "${restore_evidence_identity}" "${restore_evidence_sha256}" &&
    assert_pinned_file "${DR_PRODUCTION_TARGET_CLAIM_RECEIPT}" "${claim_receipt_identity}" "${claim_receipt_sha256}" &&
    assert_pinned_file "${DR_PRODUCTION_TARGET_CLAIM_VERIFY_COMMAND}" "${claim_verifier_identity}" "${claim_verifier_sha256}" &&
    assert_pinned_file "${DR_CUTOVER_COMMAND}" "${cutover_command_identity}" "${cutover_command_sha256}" &&
    assert_pinned_file "${DR_CUTOVER_VERIFY_COMMAND}" "${cutover_verify_identity}" "${cutover_verify_sha256}" &&
    assert_pinned_file "${DR_ROLLBACK_COMMAND}" "${rollback_command_identity}" "${rollback_command_sha256}" &&
    assert_pinned_file "${DR_ROLLBACK_VERIFY_COMMAND}" "${rollback_verify_identity}" "${rollback_verify_sha256}"
}

validate_completed_claim() {
  RESTORE_EVIDENCE="${DR_RESTORE_EVIDENCE_FILE}" CLAIM_RECEIPT="${DR_PRODUCTION_TARGET_CLAIM_RECEIPT}" \
    RESTORE_EVIDENCE_SHA256="${restore_evidence_sha256}" node <<'NODE'
const { readFileSync } = require('node:fs');
const restore = JSON.parse(readFileSync(process.env.RESTORE_EVIDENCE, 'utf8'));
const claim = JSON.parse(readFileSync(process.env.CLAIM_RECEIPT, 'utf8'));
if (
  claim.schemaVersion !== 1 || claim.status !== 'completed' || claim.active !== false ||
  claim.restoreEvidenceSha256 !== process.env.RESTORE_EVIDENCE_SHA256 ||
  claim.bundleSha256 !== restore.artifactSha256 || claim.productionTargetId !== restore.restoreTargetId ||
  !Number.isInteger(claim.fencingGeneration) || claim.fencingGeneration < 1 ||
  !Number.isFinite(Date.parse(claim.completedAt)) || !/^[a-f0-9]{64,128}$/.test(claim.providerSignature || '')
) throw new Error('Completed provider claim does not bind the promoted restore evidence');
NODE
}

rollback_and_verify() {
  assert_pinned_file "${DR_ROLLBACK_COMMAND}" "${rollback_command_identity}" "${rollback_command_sha256}"
  assert_pinned_file "${DR_ROLLBACK_VERIFY_COMMAND}" "${rollback_verify_identity}" "${rollback_verify_sha256}"
  "${DR_ROLLBACK_COMMAND}"
  "${DR_ROLLBACK_VERIFY_COMMAND}"
}

write_promotion_evidence() {
  local outcome="$1" cutover_status="$2"
  OUTCOME="${outcome}" STARTED_AT="${started_at}" OUTPUT="${DR_PROMOTION_EVIDENCE_FILE}" \
    RESERVATION="${promotion_reservation}" RESERVATION_TOKEN="${promotion_reservation_token}" \
    RESTORE_EVIDENCE="${DR_RESTORE_EVIDENCE_FILE}" RESTORE_EVIDENCE_SHA256="${restore_evidence_sha256}" \
    CUTOVER_STATUS="${cutover_status}" CLAIM_RECEIPT="${DR_PRODUCTION_TARGET_CLAIM_RECEIPT}" \
    CLAIM_RECEIPT_SHA256="${claim_receipt_sha256}" CLAIM_VERIFIER_SHA256="${claim_verifier_sha256}" \
    CUTOVER_COMMAND_SHA256="${cutover_command_sha256}" CUTOVER_VERIFY_SHA256="${cutover_verify_sha256}" \
    ROLLBACK_COMMAND_SHA256="${rollback_command_sha256}" ROLLBACK_VERIFY_SHA256="${rollback_verify_sha256}" node <<'NODE' || return 1
const { createHmac } = require('node:crypto');
const { linkSync, readFileSync, unlinkSync, writeFileSync } = require('node:fs');
if (readFileSync(process.env.RESERVATION, 'utf8').trim() !== process.env.RESERVATION_TOKEN) throw new Error('Promotion evidence reservation changed');
const restore = JSON.parse(readFileSync(process.env.RESTORE_EVIDENCE, 'utf8'));
const claim = JSON.parse(readFileSync(process.env.CLAIM_RECEIPT, 'utf8'));
if (claim.restoreEvidenceSha256 !== process.env.RESTORE_EVIDENCE_SHA256 || claim.bundleSha256 !== restore.artifactSha256 || claim.productionTargetId !== restore.restoreTargetId) throw new Error('Completed provider claim changed before promotion evidence');
const payload = {
  schemaVersion: 1,
  outcome: process.env.OUTCOME,
  restoreEvidenceSha256: process.env.RESTORE_EVIDENCE_SHA256,
  completedClaim: {
    receiptSha256: process.env.CLAIM_RECEIPT_SHA256,
    verifierSha256: process.env.CLAIM_VERIFIER_SHA256,
    productionTargetId: claim.productionTargetId,
    bundleSha256: claim.bundleSha256,
    restoreEvidenceSha256: claim.restoreEvidenceSha256,
    fencingGeneration: claim.fencingGeneration,
    status: claim.status,
    completedAt: claim.completedAt,
  },
  cutoverCommandSha256: process.env.CUTOVER_COMMAND_SHA256,
  cutoverVerifyCommandSha256: process.env.CUTOVER_VERIFY_SHA256,
  rollbackCommandSha256: process.env.ROLLBACK_COMMAND_SHA256,
  rollbackVerifyCommandSha256: process.env.ROLLBACK_VERIFY_SHA256,
  cutoverExitCode: Number(process.env.CUTOVER_STATUS),
  startedAt: process.env.STARTED_AT,
  completedAt: new Date().toISOString(),
};
const value = createHmac('sha256', process.env.DR_MANIFEST_SIGNING_KEY).update(JSON.stringify(payload)).digest('hex');
const evidence = { ...payload, signature: { algorithm: 'hmac-sha256', keyId: process.env.DR_MANIFEST_KEY_ID, value } };
const pending = `${process.env.RESERVATION}.evidence`;
writeFileSync(pending, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
try {
  linkSync(pending, process.env.OUTPUT);
} finally {
  unlinkSync(pending);
}
unlinkSync(process.env.RESERVATION);
NODE
  promotion_evidence_written=1
}

assert_promotion_inputs_unchanged
validate_completed_claim
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
set +e
"${DR_CUTOVER_COMMAND}"
cutover_status=$?
set -e
if test "${cutover_status}" != 0 || ! "${DR_CUTOVER_VERIFY_COMMAND}"; then
  rollback_and_verify
  write_promotion_evidence rolled-back "${cutover_status}"
  exit 1
fi

if ! assert_promotion_inputs_unchanged || ! validate_completed_claim || ! write_promotion_evidence promoted "${cutover_status}"; then
  rollback_and_verify
  exit 1
fi

printf 'Restored target promoted; evidence: %s\n' "${DR_PROMOTION_EVIDENCE_FILE}"
