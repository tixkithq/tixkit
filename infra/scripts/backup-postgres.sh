#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib/dr-common.sh"

: "${DATABASE_URL:?DATABASE_URL is required}"
dr_require_backup_policy

backup_dir="${BACKUP_DIR:-backups/postgres}"
timestamp="${BACKUP_TIMESTAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
output="${backup_dir}/tixkit-postgres-${timestamp}.dump"
recovery_point_at="${DR_RECOVERY_POINT_AT:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"

mkdir -p "${backup_dir}"
pg_dump --format=custom --no-owner --no-acl --file="${output}" "${DATABASE_URL}"

dr_write_checksum "${output}"
dr_write_backup_manifest "${output}" postgres "${recovery_point_at}"
printf '%s\n' "${output}"
