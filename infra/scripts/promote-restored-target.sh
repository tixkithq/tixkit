#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib/dr-common.sh"

: "${DR_RESTORE_EVIDENCE_FILE:?DR_RESTORE_EVIDENCE_FILE is required}"
: "${DR_CUTOVER_COMMAND:?DR_CUTOVER_COMMAND must atomically bind the restored target}"
: "${DR_CUTOVER_VERIFY_COMMAND:?DR_CUTOVER_VERIFY_COMMAND must verify the promoted runtime}"
: "${DR_ROLLBACK_COMMAND:?DR_ROLLBACK_COMMAND must restore the previous binding}"
: "${DR_ROLLBACK_VERIFY_COMMAND:?DR_ROLLBACK_VERIFY_COMMAND must verify the previous runtime}"
: "${DR_PROMOTION_EVIDENCE_FILE:?DR_PROMOTION_EVIDENCE_FILE is required}"

for command_path in "${DR_CUTOVER_COMMAND}" "${DR_CUTOVER_VERIFY_COMMAND}" "${DR_ROLLBACK_COMMAND}" "${DR_ROLLBACK_VERIFY_COMMAND}"; do
  test -x "${command_path}" || { printf 'Required command is not executable: %s\n' "${command_path}" >&2; exit 1; }
done

dr_verify_restore_evidence "${DR_RESTORE_EVIDENCE_FILE}" production-bundle

started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
set +e
"${DR_CUTOVER_COMMAND}"
cutover_status=$?
set -e
if [ "${cutover_status}" -eq 0 ] && "${DR_CUTOVER_VERIFY_COMMAND}"; then
  outcome=promoted
else
  "${DR_ROLLBACK_COMMAND}"
  "${DR_ROLLBACK_VERIFY_COMMAND}"
  outcome=rolled-back
fi

OUTCOME="${outcome}" STARTED_AT="${started_at}" OUTPUT="${DR_PROMOTION_EVIDENCE_FILE}" \
  RESTORE_EVIDENCE="${DR_RESTORE_EVIDENCE_FILE}" CUTOVER_STATUS="${cutover_status}" \
  CUTOVER_COMMAND="${DR_CUTOVER_COMMAND}" CUTOVER_VERIFY_COMMAND="${DR_CUTOVER_VERIFY_COMMAND}" \
  ROLLBACK_COMMAND="${DR_ROLLBACK_COMMAND}" ROLLBACK_VERIFY_COMMAND="${DR_ROLLBACK_VERIFY_COMMAND}" node <<'NODE'
const { createHash, createHmac } = require('node:crypto');
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { dirname } = require('node:path');
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const payload = {
  schemaVersion: 1,
  outcome: process.env.OUTCOME,
  restoreEvidenceSha256: sha256(process.env.RESTORE_EVIDENCE),
  cutoverCommandSha256: sha256(process.env.CUTOVER_COMMAND),
  cutoverVerifyCommandSha256: sha256(process.env.CUTOVER_VERIFY_COMMAND),
  rollbackCommandSha256: sha256(process.env.ROLLBACK_COMMAND),
  rollbackVerifyCommandSha256: sha256(process.env.ROLLBACK_VERIFY_COMMAND),
  cutoverExitCode: Number(process.env.CUTOVER_STATUS),
  startedAt: process.env.STARTED_AT,
  completedAt: new Date().toISOString(),
};
const value = createHmac('sha256', process.env.DR_MANIFEST_SIGNING_KEY).update(JSON.stringify(payload)).digest('hex');
const evidence = { ...payload, signature: { algorithm: 'hmac-sha256', keyId: process.env.DR_MANIFEST_KEY_ID, value } };
mkdirSync(dirname(process.env.OUTPUT), { recursive: true });
writeFileSync(process.env.OUTPUT, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
NODE

test "${outcome}" = promoted || exit 1
