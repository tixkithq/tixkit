#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL_MYSQL:?DATABASE_URL_MYSQL is required}"
: "${MYSQL_BACKUP_FILE:?MYSQL_BACKUP_FILE points to a gzip-compressed MySQL SQL backup}"

if [ ! -f "${MYSQL_BACKUP_FILE}" ]; then
  echo "Backup file not found: ${MYSQL_BACKUP_FILE}" >&2
  exit 1
fi

if [ -f "${MYSQL_BACKUP_FILE}.sha256" ]; then
  sha256sum --check "${MYSQL_BACKUP_FILE}.sha256"
fi

parse_url() {
  node <<'NODE'
const url = new URL(process.env.DATABASE_URL_MYSQL);
if (url.protocol !== 'mysql:') {
  throw new Error('DATABASE_URL_MYSQL must use the mysql:// scheme');
}
const database = url.pathname.replace(/^\//, '');
if (!database) throw new Error('DATABASE_URL_MYSQL must include a database name');
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
  gzip -dc "${MYSQL_BACKUP_FILE}" | MYSQL_PWD="${mysql_password}" mysql "${mysql_args[@]}"
else
  gzip -dc "${MYSQL_BACKUP_FILE}" | docker run --rm -i --add-host=host.docker.internal:host-gateway --env MYSQL_PWD="${mysql_password}" mysql:8.4 \
    mysql \
    "--host=${docker_host}" \
    "--port=${mysql_port}" \
    "--user=${mysql_user}" \
    "${mysql_database}"
fi
