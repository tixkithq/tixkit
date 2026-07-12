#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib/dr-common.sh"

: "${DATABASE_URL_MYSQL:?DATABASE_URL_MYSQL is required}"
: "${MYSQL_BACKUP_FILE:?MYSQL_BACKUP_FILE points to a gzip-compressed MySQL SQL backup}"
: "${DR_ISOLATED_TARGET:?DR_ISOLATED_TARGET=1 confirms DATABASE_URL_MYSQL is an empty isolated restore target}"
test "${DR_ISOLATED_TARGET}" = 1 || { echo 'DR_ISOLATED_TARGET must equal 1' >&2; exit 1; }
started_epoch="$(date +%s)"
mysql_image="${MYSQL_TOOL_IMAGE:-mysql:8.4@sha256:d36d39a64cd12a5c1cc9e6aa2bfb5f8d4c81a2f6586e0a04a9ae13939db02209}"

if [ ! -f "${MYSQL_BACKUP_FILE}" ]; then
  echo "Backup file not found: ${MYSQL_BACKUP_FILE}" >&2
  exit 1
fi

dr_verify_checksum "${MYSQL_BACKUP_FILE}"
dr_verify_backup_manifest "${MYSQL_BACKUP_FILE}" mysql
gzip -t "${MYSQL_BACKUP_FILE}"

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

docker_host="${mysql_host}"
if [ "${mysql_host}" = "localhost" ] || [ "${mysql_host}" = "127.0.0.1" ]; then
  docker_host="host.docker.internal"
fi

mysql_args=(
  "--host=${mysql_host}"
  "--port=${mysql_port}"
  "--user=${mysql_user}"
  "${mysql_database}"
)

if command -v mysql >/dev/null 2>&1; then
  existing_tables="$(MYSQL_PWD="${mysql_password}" mysql "${mysql_args[@]}" --batch --skip-column-names --execute="select count(*) from information_schema.tables where table_schema = database();")"
  test "${existing_tables}" = 0 || { echo 'MySQL restore target is not empty; refusing in-place restore' >&2; exit 1; }
  gzip -dc "${MYSQL_BACKUP_FILE}" | MYSQL_PWD="${mysql_password}" mysql "${mysql_args[@]}"
else
  MYSQL_PWD="${mysql_password}"
  export MYSQL_PWD
  existing_tables="$(docker run --rm --add-host=host.docker.internal:host-gateway --env MYSQL_PWD "${mysql_image}" mysql "--host=${docker_host}" "--port=${mysql_port}" "--user=${mysql_user}" "${mysql_database}" --batch --skip-column-names --execute="select count(*) from information_schema.tables where table_schema = database();")"
  test "${existing_tables}" = 0 || { echo 'MySQL restore target is not empty; refusing in-place restore' >&2; exit 1; }
  gzip -dc "${MYSQL_BACKUP_FILE}" | docker run --rm -i --add-host=host.docker.internal:host-gateway --env MYSQL_PWD "${mysql_image}" \
    mysql \
    "--host=${docker_host}" \
    "--port=${mysql_port}" \
    "--user=${mysql_user}" \
    "${mysql_database}"
fi
unset MYSQL_PWD
dr_run_restore_verifier mysql
dr_record_restore_evidence "${MYSQL_BACKUP_FILE}" mysql "${started_epoch}"
