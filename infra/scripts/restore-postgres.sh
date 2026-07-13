#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib/dr-common.sh"

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${POSTGRES_BACKUP_FILE:?POSTGRES_BACKUP_FILE points to a pg_dump custom-format backup}"
: "${DR_ISOLATED_TARGET:?DR_ISOLATED_TARGET=1 confirms DATABASE_URL is an empty isolated restore target}"
test "${DR_ISOLATED_TARGET}" = 1 || { echo 'DR_ISOLATED_TARGET must equal 1' >&2; exit 1; }
started_epoch="$(date +%s)"

if [ ! -f "${POSTGRES_BACKUP_FILE}" ]; then
  echo "Backup file not found: ${POSTGRES_BACKUP_FILE}" >&2
  exit 1
fi

dr_verify_checksum "${POSTGRES_BACKUP_FILE}"
dr_verify_backup_manifest "${POSTGRES_BACKUP_FILE}" postgres
pg_restore --list "${POSTGRES_BACKUP_FILE}" >/dev/null
dr_reserve_restore_evidence
existing_relations="$(psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -Atqc "select count(*) from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname not in ('pg_catalog','information_schema') and n.nspname not like 'pg_toast%' and c.relkind in ('r','p','v','m','S');")"
test "${existing_relations}" = 0 || { echo 'Postgres restore target is not empty; refusing in-place restore' >&2; exit 1; }

restore_log="$(mktemp)"
restore_sql="$(mktemp)"

cleanup() {
  rm -f "${restore_log}" "${restore_sql}" "${restore_sql}.filtered"
}
trap cleanup EXIT

if pg_restore --exit-on-error --single-transaction --no-owner --no-acl --dbname="${DATABASE_URL}" "${POSTGRES_BACKUP_FILE}" 2>"${restore_log}"; then
  dr_run_restore_verifier postgres
  dr_record_restore_evidence "${POSTGRES_BACKUP_FILE}" postgres "${started_epoch}"
  exit 0
fi

if ! grep -q 'transaction_timeout' "${restore_log}"; then
  cat "${restore_log}" >&2
  exit 1
fi

pg_restore --no-owner --no-acl --file="${restore_sql}" "${POSTGRES_BACKUP_FILE}"
grep -v '^SET transaction_timeout' "${restore_sql}" > "${restore_sql}.filtered"
psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 --single-transaction -f "${restore_sql}.filtered"
dr_run_restore_verifier postgres
dr_record_restore_evidence "${POSTGRES_BACKUP_FILE}" postgres "${started_epoch}"
