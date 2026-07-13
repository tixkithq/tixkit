#!/usr/bin/env bash
set -euo pipefail
umask 077
source "$(dirname "$0")/lib/dr-common.sh"

: "${DR_QUIESCE_COMMAND:?DR_QUIESCE_COMMAND must be an executable that stops application writes and drains workers}"
: "${DR_RESUME_COMMAND:?DR_RESUME_COMMAND must be an executable that safely resumes writes}"
: "${DR_TEMPORAL_CHECKPOINT_COMMAND:?DR_TEMPORAL_CHECKPOINT_COMMAND must create immutable checkpoint metadata}"
: "${DR_TEMPORAL_CHECKPOINT_VERIFY_COMMAND:?DR_TEMPORAL_CHECKPOINT_VERIFY_COMMAND must independently authenticate checkpoint metadata}"
: "${DR_BACKUP_PUBLISH_COMMAND:?DR_BACKUP_PUBLISH_COMMAND must encrypt and publish the bundle}"
: "${DR_BACKUP_RETRIEVE_COMMAND:?DR_BACKUP_RETRIEVE_COMMAND must retrieve and decrypt the published bundle}"
: "${DR_BACKUP_RECEIPT_VERIFY_COMMAND:?DR_BACKUP_RECEIPT_VERIFY_COMMAND must cryptographically verify the provider receipt}"
: "${DB_DRIVER:?DB_DRIVER must be postgres or mysql}"
test -x "${DR_QUIESCE_COMMAND}" || { echo 'DR_QUIESCE_COMMAND is not executable' >&2; exit 1; }
test -x "${DR_RESUME_COMMAND}" || { echo 'DR_RESUME_COMMAND is not executable' >&2; exit 1; }
test -x "${DR_TEMPORAL_CHECKPOINT_COMMAND}" || { echo 'DR_TEMPORAL_CHECKPOINT_COMMAND is not executable' >&2; exit 1; }
test -x "${DR_TEMPORAL_CHECKPOINT_VERIFY_COMMAND}" || { echo 'DR_TEMPORAL_CHECKPOINT_VERIFY_COMMAND is not executable' >&2; exit 1; }
test -x "${DR_BACKUP_PUBLISH_COMMAND}" || { echo 'DR_BACKUP_PUBLISH_COMMAND is not executable' >&2; exit 1; }
test -x "${DR_BACKUP_RETRIEVE_COMMAND}" || { echo 'DR_BACKUP_RETRIEVE_COMMAND is not executable' >&2; exit 1; }
test -x "${DR_BACKUP_RECEIPT_VERIFY_COMMAND}" || { echo 'DR_BACKUP_RECEIPT_VERIFY_COMMAND is not executable' >&2; exit 1; }
dr_require_backup_policy

output_dir="${BACKUP_DIR:-backups/production}"
timestamp="${BACKUP_TIMESTAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
recovery_point_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
bundle="${output_dir}/tixkit-production-${timestamp}.tar.gz"
receipt="${output_dir}/tixkit-production-${timestamp}.receipt.json"
dr_prepare_output_directory "${output_dir}"
for output_path in "${bundle}" "${bundle}.sha256" "${bundle}.manifest.json" "${receipt}"; do
  dr_assert_output_path_available "${output_path}"
done
bundle_staged="$(mktemp "${output_dir}/.tixkit-production.XXXXXX")"
publish_dir="$(mktemp -d "${output_dir}/.tixkit-production-publish.XXXXXX")"
receipt_staged="${publish_dir}/receipt.json"
workdir="$(mktemp -d)"
resumed=0
bundle_created=0
bundle_identity=''
checksum_created=0
manifest_created=0
receipt_created=0
complete=0
cleanup() {
  if [ "${resumed}" = 0 ]; then
    dr_run_isolated_hook "${DR_RESUME_COMMAND}" || true
  fi
  rm -f "${bundle_staged}"
  rm -rf "${publish_dir}"
  if test "${complete}" = 0; then
    test "${receipt_created}" = 0 || rm -f "${receipt}"
    test "${manifest_created}" = 0 || rm -f "${bundle}.manifest.json"
    test "${checksum_created}" = 0 || rm -f "${bundle}.sha256"
    test "${bundle_created}" = 0 || dr_remove_file_if_identity "${bundle}" "${bundle_identity}"
  fi
  rm -rf "${workdir}"
}
trap cleanup EXIT INT TERM

dr_run_isolated_hook "${DR_QUIESCE_COMMAND}"
export DR_RECOVERY_POINT_AT="${recovery_point_at}"
export BACKUP_TIMESTAMP="${timestamp}"
export DR_TEMPORAL_CHECKPOINT_FILE="${workdir}/temporal-checkpoint.json"
dr_run_isolated_hook "${DR_TEMPORAL_CHECKPOINT_COMMAND}"
CHECKPOINT_FILE="${DR_TEMPORAL_CHECKPOINT_FILE}" RECOVERY_POINT_AT="${recovery_point_at}" node <<'NODE'
const { readFileSync } = require('node:fs');
const checkpoint = JSON.parse(readFileSync(process.env.CHECKPOINT_FILE, 'utf8'));
if (!checkpoint.immutableId || !checkpoint.namespace || checkpoint.recoveryPointAt !== process.env.RECOVERY_POINT_AT || checkpoint.verified !== true) {
  throw new Error('Temporal checkpoint metadata is incomplete or does not match the recovery point');
}
NODE
checkpoint_sha256="$(dr_sha256 "${DR_TEMPORAL_CHECKPOINT_FILE}")"
dr_run_isolated_hook "${DR_TEMPORAL_CHECKPOINT_VERIFY_COMMAND}"
test "$(dr_sha256 "${DR_TEMPORAL_CHECKPOINT_FILE}")" = "${checkpoint_sha256}" || {
  echo 'Temporal checkpoint evidence changed during independent verification' >&2
  exit 1
}

case "${DB_DRIVER}" in
  postgres)
    : "${POSTGRES_GLOBALS_BACKUP_REFERENCE:?POSTGRES_GLOBALS_BACKUP_REFERENCE must identify separately protected roles and required extension policy}"
    BACKUP_DIR="${workdir}" "$(dirname "$0")/backup-postgres.sh" >/dev/null
    printf '%s\n' "${POSTGRES_GLOBALS_BACKUP_REFERENCE}" >"${workdir}/postgres-globals-reference.txt"
    ;;
  mysql)
    : "${MYSQL_GRANTS_BACKUP_REFERENCE:?MYSQL_GRANTS_BACKUP_REFERENCE must identify separately protected users and grants}"
    DR_PRODUCTION_BUNDLE=1 BACKUP_DIR="${workdir}" "$(dirname "$0")/backup-mysql.sh" >/dev/null
    printf '%s\n' "${MYSQL_GRANTS_BACKUP_REFERENCE}" >"${workdir}/mysql-grants-reference.txt"
    ;;
  *)
    echo 'DB_DRIVER must be postgres or mysql' >&2
    exit 1
    ;;
esac
DR_PRODUCTION_BUNDLE=1 BACKUP_DIR="${workdir}" "$(dirname "$0")/backup-object-storage.sh" >/dev/null
printf '%s\n' 'Redis is reconstructed from the application database and durable Temporal state; Redis is not a recovery source.' >"${workdir}/redis-recovery-boundary.txt"

dr_run_isolated_hook "${DR_RESUME_COMMAND}"
resumed=1

COPYFILE_DISABLE=1 tar -C "${workdir}" -czf "${bundle_staged}" .
dr_publish_staged_file "${bundle_staged}" "${bundle}"
bundle_staged=''
bundle_created=1
bundle_identity="$(dr_file_identity "${bundle}")"
bundle_sha256="$(dr_sha256 "${bundle}")"
dr_assert_file_identity "${bundle}" "${bundle_identity}"
dr_write_checksum "${bundle}"
checksum_created=1
dr_assert_file_identity "${bundle}" "${bundle_identity}"
dr_write_backup_manifest "${bundle}" production-bundle "${recovery_point_at}"
manifest_created=1

export DR_PUBLISH_ARTIFACT="${bundle}"
export DR_PUBLISH_MANIFEST="${bundle}.manifest.json"
export DR_PUBLISH_CHECKSUM="${bundle}.sha256"
export DR_PUBLISH_RECEIPT="${receipt_staged}"
dr_run_isolated_hook "${DR_BACKUP_PUBLISH_COMMAND}"
dr_assert_file_identity "${bundle}" "${bundle_identity}"
test "$(dr_sha256 "${bundle}")" = "${bundle_sha256}" || { echo 'Plaintext bundle changed during publication' >&2; exit 1; }
export DR_RECEIPT_FILE="${receipt_staged}"
dr_run_isolated_hook "${DR_BACKUP_RECEIPT_VERIFY_COMMAND}"
dr_assert_file_identity "${bundle}" "${bundle_identity}"
test "$(dr_sha256 "${bundle}")" = "${bundle_sha256}" || { echo 'Plaintext bundle changed during receipt verification' >&2; exit 1; }
PLAINTEXT_SHA="$(dr_sha256 "${bundle}")" RECEIPT="${receipt_staged}" node <<'NODE'
const { readFileSync } = require('node:fs');
const receipt = JSON.parse(readFileSync(process.env.RECEIPT, 'utf8'));
if (receipt.schemaVersion !== 1 || receipt.immutable !== true || !receipt.storageId || !receipt.providerSignature || Date.parse(receipt.retentionUntil) <= Date.now()) throw new Error('Backup publish receipt is incomplete');
if (receipt.plaintextSha256 !== process.env.PLAINTEXT_SHA) throw new Error('Backup receipt plaintext checksum mismatch');
if (!receipt.ciphertextSha256 || receipt.ciphertextSha256 === receipt.plaintextSha256) throw new Error('Backup publisher did not prove ciphertext differs from plaintext');
NODE

retrieved="${workdir}/$(basename "${bundle}")"
export DR_RETRIEVE_RECEIPT="${receipt_staged}"
export DR_RETRIEVE_OUTPUT="${retrieved}"
export DR_RETRIEVE_MANIFEST_OUTPUT="${retrieved}.manifest.json"
export DR_RETRIEVE_CHECKSUM_OUTPUT="${retrieved}.sha256"
dr_run_isolated_hook "${DR_BACKUP_RETRIEVE_COMMAND}"
dr_assert_file_identity "${bundle}" "${bundle_identity}"
test "$(dr_sha256 "${bundle}")" = "${bundle_sha256}" || { echo 'Plaintext bundle changed during retrieval verification' >&2; exit 1; }
dr_verify_checksum "${retrieved}"
dr_verify_backup_manifest "${retrieved}" production-bundle
test "$(dr_sha256 "${retrieved}")" = "$(dr_sha256 "${bundle}")" || { echo 'Published backup retrieval verification failed' >&2; exit 1; }
dr_publish_staged_file "${receipt_staged}" "${receipt}"
receipt_created=1
rm -f "${retrieved}" "${retrieved}.sha256" "${retrieved}.manifest.json" "${bundle}.sha256" "${bundle}.manifest.json"
dr_remove_file_if_identity "${bundle}" "${bundle_identity}"
bundle_created=0
checksum_created=0
manifest_created=0
complete=1
printf '%s\n' "${receipt}"
