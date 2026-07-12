#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib/dr-common.sh"

: "${DATABASE_URL_MYSQL:?DATABASE_URL_MYSQL is required}"
dr_require_backup_policy

backup_dir="${BACKUP_DIR:-backups/mysql}"
timestamp="${BACKUP_TIMESTAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
output="${backup_dir}/tixkit-mysql-${timestamp}.sql.gz"
recovery_point_at="${DR_RECOVERY_POINT_AT:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
mysql_image="${MYSQL_TOOL_IMAGE:-mysql:8.4@sha256:d36d39a64cd12a5c1cc9e6aa2bfb5f8d4c81a2f6586e0a04a9ae13939db02209}"

parse_url() {
  node <<'NODE'
const url = new URL(process.env.DATABASE_URL_MYSQL);
if (url.protocol !== 'mysql:') {
  throw new Error('DATABASE_URL_MYSQL must use the mysql:// scheme');
}
const database = url.pathname.replace(/^\//, '');
if (!database) throw new Error('DATABASE_URL_MYSQL must include a database name');
if (!/^[A-Za-z0-9_$-]+$/.test(database)) throw new Error('DATABASE_URL_MYSQL database name contains unsupported characters');
console.log([
  url.hostname,
  url.port || '3306',
  decodeURIComponent(url.username),
  decodeURIComponent(url.password),
  database,
].join('\t'));
NODE
}

IFS=$'\t' read -r mysql_host mysql_port mysql_user mysql_password mysql_database < <(parse_url)

mkdir -p "${backup_dir}"

docker_host="${mysql_host}"
if [ "${mysql_host}" = "localhost" ] || [ "${mysql_host}" = "127.0.0.1" ]; then
  docker_host="host.docker.internal"
fi

dump_args=(
  "--host=${mysql_host}"
  "--port=${mysql_port}"
  "--user=${mysql_user}"
  "--single-transaction"
  "--routines"
  "--triggers"
  "--events"
  "--no-tablespaces"
  "--set-gtid-purged=OFF"
  "${mysql_database}"
)

engine_query="select count(*) from information_schema.tables where table_schema='${mysql_database}' and table_type='BASE TABLE' and engine <> 'InnoDB';"
if command -v mysql >/dev/null 2>&1; then
  non_transactional_tables="$(MYSQL_PWD="${mysql_password}" mysql "--host=${mysql_host}" "--port=${mysql_port}" "--user=${mysql_user}" --batch --skip-column-names --execute="${engine_query}")"
else
  MYSQL_PWD="${mysql_password}"
  export MYSQL_PWD
  non_transactional_tables="$(docker run --rm --add-host=host.docker.internal:host-gateway --env MYSQL_PWD "${mysql_image}" mysql "--host=${docker_host}" "--port=${mysql_port}" "--user=${mysql_user}" --batch --skip-column-names --execute="${engine_query}")"
fi
test "${non_transactional_tables}" = 0 || {
  echo 'MySQL backup requires every base table to use InnoDB for a consistent recovery point' >&2
  exit 1
}

if command -v mysqldump >/dev/null 2>&1; then
  MYSQL_PWD="${mysql_password}" mysqldump "${dump_args[@]}" | gzip -c > "${output}"
else
  MYSQL_PWD="${mysql_password}"
  export MYSQL_PWD
  docker run --rm --add-host=host.docker.internal:host-gateway --env MYSQL_PWD "${mysql_image}" \
    mysqldump \
    "--host=${docker_host}" \
    "--port=${mysql_port}" \
    "--user=${mysql_user}" \
    "--single-transaction" \
    "--routines" \
    "--triggers" \
    "--events" \
    "--no-tablespaces" \
    "--set-gtid-purged=OFF" \
    "${mysql_database}" | gzip -c > "${output}"
fi
unset MYSQL_PWD

dr_write_checksum "${output}"
dr_write_backup_manifest "${output}" mysql "${recovery_point_at}"
printf '%s\n' "${output}"
