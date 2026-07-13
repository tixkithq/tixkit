#!/usr/bin/env bash
set -euo pipefail
umask 077
source "$(dirname "$0")/lib/dr-common.sh"

: "${DATABASE_URL:?DATABASE_URL is required}"
dr_require_backup_policy

backup_dir="${BACKUP_DIR:-backups/postgres}"
timestamp="${BACKUP_TIMESTAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
output="${backup_dir}/tixkit-postgres-${timestamp}.dump"
recovery_point_at="${DR_RECOVERY_POINT_AT:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"

dr_prepare_output_directory "${backup_dir}"
dr_assert_output_path_available "${output}"
dr_assert_output_path_available "${output}.sha256"
dr_assert_output_path_available "${output}.manifest.json"
staged="$(mktemp "${backup_dir}/.tixkit-postgres.XXXXXX")"
output_created=0
output_identity=''
checksum_created=0
manifest_created=0
complete=0
cleanup() {
  rm -f "${staged}"
  if test "${complete}" = 0; then
    test "${manifest_created}" = 0 || rm -f "${output}.manifest.json"
    test "${checksum_created}" = 0 || rm -f "${output}.sha256"
    test "${output_created}" = 0 || dr_remove_file_if_identity "${output}" "${output_identity}"
  fi
}
trap cleanup EXIT INT TERM
pg_dump --format=custom --no-owner --no-acl --file="${staged}" "${DATABASE_URL}"
dr_publish_staged_file "${staged}" "${output}"
staged=''
output_created=1
output_identity="$(dr_file_identity "${output}")"

dr_assert_file_identity "${output}" "${output_identity}"
dr_write_checksum "${output}"
checksum_created=1
dr_assert_file_identity "${output}" "${output_identity}"
dr_write_backup_manifest "${output}" postgres "${recovery_point_at}"
manifest_created=1
complete=1
printf '%s\n' "${output}"
