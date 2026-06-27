#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${POSTGRES_BACKUP_FILE:?POSTGRES_BACKUP_FILE points to a pg_dump custom-format backup}"

if [ ! -f "${POSTGRES_BACKUP_FILE}" ]; then
  echo "Backup file not found: ${POSTGRES_BACKUP_FILE}" >&2
  exit 1
fi

if [ -f "${POSTGRES_BACKUP_FILE}.sha256" ]; then
  sha256sum --check "${POSTGRES_BACKUP_FILE}.sha256"
fi

restore_log="$(mktemp)"
restore_sql="$(mktemp)"

cleanup() {
  rm -f "${restore_log}" "${restore_sql}" "${restore_sql}.filtered"
}
trap cleanup EXIT

if pg_restore --clean --if-exists --no-owner --no-acl --dbname="${DATABASE_URL}" "${POSTGRES_BACKUP_FILE}" 2>"${restore_log}"; then
  exit 0
fi

if ! grep -q 'transaction_timeout' "${restore_log}"; then
  cat "${restore_log}" >&2
  exit 1
fi

pg_restore --clean --if-exists --no-owner --no-acl --file="${restore_sql}" "${POSTGRES_BACKUP_FILE}"
grep -v '^SET transaction_timeout' "${restore_sql}" > "${restore_sql}.filtered"
psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -f "${restore_sql}.filtered"
