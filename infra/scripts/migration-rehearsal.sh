#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"

backup_dir="${BACKUP_DIR:-backups/migration-rehearsal}"
timestamp="${BACKUP_TIMESTAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
postgres_backup="${backup_dir}/tixkit-postgres-before-migration-${timestamp}.dump"
mysql_backup_dir="${backup_dir}/mysql"

mkdir -p "${backup_dir}"

echo "Creating pre-migration Postgres backup: ${postgres_backup}"
pg_dump --format=custom --no-owner --no-acl --file="${postgres_backup}" "${DATABASE_URL}"
sha256sum "${postgres_backup}" > "${postgres_backup}.sha256"

if [ -n "${DATABASE_URL_MYSQL:-}" ]; then
  echo "Creating pre-migration MySQL backup"
  mysql_backup="$(
    DATABASE_URL_MYSQL="${DATABASE_URL_MYSQL}" \
      BACKUP_DIR="${mysql_backup_dir}" \
      BACKUP_TIMESTAMP="${timestamp}" \
      "$(dirname "$0")/backup-mysql.sh"
  )"
else
  mysql_backup=""
fi

echo "Running Postgres forward migrations"
bun run --env-file=.env.local db:migrate

if [ -n "${DATABASE_URL_MYSQL:-}" ]; then
  echo "Running MySQL forward migrations"
  bun run --env-file=.env.local db:migrate:mysql
else
  echo "DATABASE_URL_MYSQL is unset; MySQL rehearsal skipped"
fi

echo "Rollback rehearsal command:"
echo "POSTGRES_BACKUP_FILE=${postgres_backup} DATABASE_URL=<target> infra/scripts/restore-postgres.sh"
if [ -n "${mysql_backup}" ]; then
  echo "MYSQL_BACKUP_FILE=${mysql_backup} DATABASE_URL_MYSQL=<target> infra/scripts/restore-mysql.sh"
fi
