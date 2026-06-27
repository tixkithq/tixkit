#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"

backup_dir="${BACKUP_DIR:-backups/postgres}"
timestamp="${BACKUP_TIMESTAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
output="${backup_dir}/tixkit-postgres-${timestamp}.dump"

mkdir -p "${backup_dir}"
pg_dump --format=custom --no-owner --no-acl --file="${output}" "${DATABASE_URL}"

sha256sum "${output}" > "${output}.sha256"
printf '%s\n' "${output}"
