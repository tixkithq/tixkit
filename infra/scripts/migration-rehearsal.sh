#!/usr/bin/env bash
set -euo pipefail
umask 077

: "${DB_DRIVER:?DB_DRIVER must be postgres or mysql}"
: "${SOURCE_DATABASE_URL:?SOURCE_DATABASE_URL is required}"
: "${FORWARD_DATABASE_URL:?FORWARD_DATABASE_URL must be an empty isolated clone}"
: "${ROLLBACK_DATABASE_URL:?ROLLBACK_DATABASE_URL must be a second empty isolated clone}"
: "${DR_OLD_VERSION_VERIFY_COMMAND:?DR_OLD_VERSION_VERIFY_COMMAND is required}"
: "${DR_NEW_VERSION_VERIFY_COMMAND:?DR_NEW_VERSION_VERIFY_COMMAND is required}"
: "${DR_INCIDENT_AT:?DR_INCIDENT_AT is required for measured rehearsal evidence}"
: "${DR_OLD_RELEASE:?DR_OLD_RELEASE is required}"
: "${DR_NEW_RELEASE:?DR_NEW_RELEASE is required}"
: "${FORWARD_TARGET_ID:?FORWARD_TARGET_ID must be an opaque non-secret identifier}"
: "${ROLLBACK_TARGET_ID:?ROLLBACK_TARGET_ID must be an opaque non-secret identifier}"

test "${SOURCE_DATABASE_URL}" != "${FORWARD_DATABASE_URL}" || { echo 'Forward target must differ from source' >&2; exit 1; }
test "${SOURCE_DATABASE_URL}" != "${ROLLBACK_DATABASE_URL}" || { echo 'Rollback target must differ from source' >&2; exit 1; }
test "${FORWARD_DATABASE_URL}" != "${ROLLBACK_DATABASE_URL}" || { echo 'Forward and rollback targets must differ' >&2; exit 1; }
test -x "${DR_OLD_VERSION_VERIFY_COMMAND}" || { echo 'Old-version verifier is not executable' >&2; exit 1; }
test -x "${DR_NEW_VERSION_VERIFY_COMMAND}" || { echo 'New-version verifier is not executable' >&2; exit 1; }

backup_dir="${BACKUP_DIR:-backups/migration-rehearsal}"
evidence_dir="${DR_EVIDENCE_DIR:-${backup_dir}/evidence}"
timestamp="${BACKUP_TIMESTAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "${backup_dir}" "${evidence_dir}"

case "${DB_DRIVER}" in
  postgres)
    backup="$(DATABASE_URL="${SOURCE_DATABASE_URL}" BACKUP_DIR="${backup_dir}" BACKUP_TIMESTAMP="${timestamp}" "$(dirname "$0")/backup-postgres.sh")"
    DATABASE_URL="${FORWARD_DATABASE_URL}" POSTGRES_BACKUP_FILE="${backup}" DR_ISOLATED_TARGET=1 \
      DR_VERIFY_COMMAND="${DR_OLD_VERSION_VERIFY_COMMAND}" DR_EVIDENCE_FILE="${evidence_dir}/forward-restore.json" \
      DR_RESTORE_TARGET_ID="${FORWARD_TARGET_ID}" DR_TARGET_RELEASE="${DR_OLD_RELEASE}" \
      "$(dirname "$0")/restore-postgres.sh"
    set +e
    DATABASE_URL="${FORWARD_DATABASE_URL}" DB_DRIVER=postgres bun run db:migrate
    migration_status=$?
    set -e
    if [ "${DR_EXPECT_FORWARD_FAILURE:-0}" = 1 ]; then
      test "${migration_status}" -ne 0 || { echo 'Expected forward migration failure did not occur' >&2; exit 1; }
    else
      test "${migration_status}" -eq 0 || { echo 'Forward migration failed' >&2; exit "${migration_status}"; }
      DATABASE_URL="${FORWARD_DATABASE_URL}" DB_DRIVER=postgres DR_RESTORE_KIND=postgres-forward \
        "${DR_NEW_VERSION_VERIFY_COMMAND}"
    fi
    DATABASE_URL="${ROLLBACK_DATABASE_URL}" POSTGRES_BACKUP_FILE="${backup}" DR_ISOLATED_TARGET=1 \
      DR_VERIFY_COMMAND="${DR_OLD_VERSION_VERIFY_COMMAND}" DR_EVIDENCE_FILE="${evidence_dir}/rollback-restore.json" \
      DR_RESTORE_TARGET_ID="${ROLLBACK_TARGET_ID}" DR_TARGET_RELEASE="${DR_OLD_RELEASE}" \
      "$(dirname "$0")/restore-postgres.sh"
    ;;
  mysql)
    backup="$(DATABASE_URL_MYSQL="${SOURCE_DATABASE_URL}" BACKUP_DIR="${backup_dir}" BACKUP_TIMESTAMP="${timestamp}" "$(dirname "$0")/backup-mysql.sh")"
    DATABASE_URL_MYSQL="${FORWARD_DATABASE_URL}" MYSQL_BACKUP_FILE="${backup}" DR_ISOLATED_TARGET=1 \
      DR_VERIFY_COMMAND="${DR_OLD_VERSION_VERIFY_COMMAND}" DR_EVIDENCE_FILE="${evidence_dir}/forward-restore.json" \
      DR_RESTORE_TARGET_ID="${FORWARD_TARGET_ID}" DR_TARGET_RELEASE="${DR_OLD_RELEASE}" \
      "$(dirname "$0")/restore-mysql.sh"
    set +e
    DATABASE_URL_MYSQL="${FORWARD_DATABASE_URL}" DB_DRIVER=mysql bun run db:migrate:mysql
    migration_status=$?
    set -e
    if [ "${DR_EXPECT_FORWARD_FAILURE:-0}" = 1 ]; then
      test "${migration_status}" -ne 0 || { echo 'Expected forward migration failure did not occur' >&2; exit 1; }
    else
      test "${migration_status}" -eq 0 || { echo 'Forward migration failed' >&2; exit "${migration_status}"; }
      DATABASE_URL_MYSQL="${FORWARD_DATABASE_URL}" DB_DRIVER=mysql DR_RESTORE_KIND=mysql-forward \
        "${DR_NEW_VERSION_VERIFY_COMMAND}"
    fi
    DATABASE_URL_MYSQL="${ROLLBACK_DATABASE_URL}" MYSQL_BACKUP_FILE="${backup}" DR_ISOLATED_TARGET=1 \
      DR_VERIFY_COMMAND="${DR_OLD_VERSION_VERIFY_COMMAND}" DR_EVIDENCE_FILE="${evidence_dir}/rollback-restore.json" \
      DR_RESTORE_TARGET_ID="${ROLLBACK_TARGET_ID}" DR_TARGET_RELEASE="${DR_OLD_RELEASE}" \
      "$(dirname "$0")/restore-mysql.sh"
    ;;
  *)
    echo 'DB_DRIVER must be postgres or mysql' >&2
    exit 1
    ;;
esac

printf 'Migration rehearsal passed; evidence: %s\n' "${evidence_dir}"
