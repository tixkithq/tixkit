#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib/dr-common.sh"

: "${DR_QUIESCE_COMMAND:?DR_QUIESCE_COMMAND must be an executable that stops application writes and drains workers}"
: "${DR_RESUME_COMMAND:?DR_RESUME_COMMAND must be an executable that safely resumes writes}"
: "${DR_TEMPORAL_CHECKPOINT_COMMAND:?DR_TEMPORAL_CHECKPOINT_COMMAND must create immutable checkpoint metadata}"
: "${DR_BACKUP_PUBLISH_COMMAND:?DR_BACKUP_PUBLISH_COMMAND must encrypt and publish the bundle}"
: "${DR_BACKUP_RETRIEVE_COMMAND:?DR_BACKUP_RETRIEVE_COMMAND must retrieve and decrypt the published bundle}"
: "${DR_BACKUP_RECEIPT_VERIFY_COMMAND:?DR_BACKUP_RECEIPT_VERIFY_COMMAND must cryptographically verify the provider receipt}"
: "${DB_DRIVER:?DB_DRIVER must be postgres or mysql}"
test -x "${DR_QUIESCE_COMMAND}" || { echo 'DR_QUIESCE_COMMAND is not executable' >&2; exit 1; }
test -x "${DR_RESUME_COMMAND}" || { echo 'DR_RESUME_COMMAND is not executable' >&2; exit 1; }
test -x "${DR_TEMPORAL_CHECKPOINT_COMMAND}" || { echo 'DR_TEMPORAL_CHECKPOINT_COMMAND is not executable' >&2; exit 1; }
test -x "${DR_BACKUP_PUBLISH_COMMAND}" || { echo 'DR_BACKUP_PUBLISH_COMMAND is not executable' >&2; exit 1; }
test -x "${DR_BACKUP_RETRIEVE_COMMAND}" || { echo 'DR_BACKUP_RETRIEVE_COMMAND is not executable' >&2; exit 1; }
test -x "${DR_BACKUP_RECEIPT_VERIFY_COMMAND}" || { echo 'DR_BACKUP_RECEIPT_VERIFY_COMMAND is not executable' >&2; exit 1; }
dr_require_backup_policy

output_dir="${BACKUP_DIR:-backups/production}"
timestamp="${BACKUP_TIMESTAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
recovery_point_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
workdir="$(mktemp -d)"
resumed=0
cleanup() {
  if [ "${resumed}" = 0 ]; then
    "${DR_RESUME_COMMAND}" || true
  fi
  rm -rf "${workdir}"
}
trap cleanup EXIT INT TERM

"${DR_QUIESCE_COMMAND}"
export DR_RECOVERY_POINT_AT="${recovery_point_at}"
export BACKUP_TIMESTAMP="${timestamp}"
export DR_TEMPORAL_CHECKPOINT_FILE="${workdir}/temporal-checkpoint.json"
"${DR_TEMPORAL_CHECKPOINT_COMMAND}"
CHECKPOINT_FILE="${DR_TEMPORAL_CHECKPOINT_FILE}" RECOVERY_POINT_AT="${recovery_point_at}" node <<'NODE'
const { readFileSync } = require('node:fs');
const checkpoint = JSON.parse(readFileSync(process.env.CHECKPOINT_FILE, 'utf8'));
if (!checkpoint.immutableId || !checkpoint.namespace || checkpoint.recoveryPointAt !== process.env.RECOVERY_POINT_AT || checkpoint.verified !== true) {
  throw new Error('Temporal checkpoint metadata is incomplete or does not match the recovery point');
}
NODE

case "${DB_DRIVER}" in
  postgres)
    : "${POSTGRES_GLOBALS_BACKUP_REFERENCE:?POSTGRES_GLOBALS_BACKUP_REFERENCE must identify separately protected roles and required extension policy}"
    BACKUP_DIR="${workdir}" "$(dirname "$0")/backup-postgres.sh" >/dev/null
    printf '%s\n' "${POSTGRES_GLOBALS_BACKUP_REFERENCE}" >"${workdir}/postgres-globals-reference.txt"
    ;;
  mysql)
    : "${MYSQL_GRANTS_BACKUP_REFERENCE:?MYSQL_GRANTS_BACKUP_REFERENCE must identify separately protected users and grants}"
    BACKUP_DIR="${workdir}" "$(dirname "$0")/backup-mysql.sh" >/dev/null
    printf '%s\n' "${MYSQL_GRANTS_BACKUP_REFERENCE}" >"${workdir}/mysql-grants-reference.txt"
    ;;
  *)
    echo 'DB_DRIVER must be postgres or mysql' >&2
    exit 1
    ;;
esac
BACKUP_DIR="${workdir}" "$(dirname "$0")/backup-object-storage.sh" >/dev/null
printf '%s\n' 'Redis is reconstructed from the application database and durable Temporal state; Redis is not a recovery source.' >"${workdir}/redis-recovery-boundary.txt"

"${DR_RESUME_COMMAND}"
resumed=1

mkdir -p "${output_dir}"
bundle="${output_dir}/tixkit-production-${timestamp}.tar.gz"
COPYFILE_DISABLE=1 tar -C "${workdir}" -czf "${bundle}" .
dr_write_checksum "${bundle}"
dr_write_backup_manifest "${bundle}" production-bundle "${recovery_point_at}"

receipt="${output_dir}/tixkit-production-${timestamp}.receipt.json"
export DR_PUBLISH_ARTIFACT="${bundle}"
export DR_PUBLISH_MANIFEST="${bundle}.manifest.json"
export DR_PUBLISH_CHECKSUM="${bundle}.sha256"
export DR_PUBLISH_RECEIPT="${receipt}"
"${DR_BACKUP_PUBLISH_COMMAND}"
export DR_RECEIPT_FILE="${receipt}"
"${DR_BACKUP_RECEIPT_VERIFY_COMMAND}"
PLAINTEXT_SHA="$(dr_sha256 "${bundle}")" RECEIPT="${receipt}" node <<'NODE'
const { readFileSync } = require('node:fs');
const receipt = JSON.parse(readFileSync(process.env.RECEIPT, 'utf8'));
if (receipt.schemaVersion !== 1 || receipt.immutable !== true || !receipt.storageId || !receipt.providerSignature || Date.parse(receipt.retentionUntil) <= Date.now()) throw new Error('Backup publish receipt is incomplete');
if (receipt.plaintextSha256 !== process.env.PLAINTEXT_SHA) throw new Error('Backup receipt plaintext checksum mismatch');
if (!receipt.ciphertextSha256 || receipt.ciphertextSha256 === receipt.plaintextSha256) throw new Error('Backup publisher did not prove ciphertext differs from plaintext');
NODE

retrieved="${workdir}/$(basename "${bundle}")"
export DR_RETRIEVE_RECEIPT="${receipt}"
export DR_RETRIEVE_OUTPUT="${retrieved}"
export DR_RETRIEVE_MANIFEST_OUTPUT="${retrieved}.manifest.json"
export DR_RETRIEVE_CHECKSUM_OUTPUT="${retrieved}.sha256"
"${DR_BACKUP_RETRIEVE_COMMAND}"
dr_verify_checksum "${retrieved}"
dr_verify_backup_manifest "${retrieved}" production-bundle
test "$(dr_sha256 "${retrieved}")" = "$(dr_sha256 "${bundle}")" || { echo 'Published backup retrieval verification failed' >&2; exit 1; }
rm -f "${retrieved}" "${retrieved}.sha256" "${retrieved}.manifest.json" "${bundle}" "${bundle}.sha256" "${bundle}.manifest.json"
printf '%s\n' "${receipt}"
