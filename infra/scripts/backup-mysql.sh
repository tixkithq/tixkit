#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL_MYSQL:?DATABASE_URL_MYSQL is required}"

backup_dir="${BACKUP_DIR:-backups/mysql}"
timestamp="${BACKUP_TIMESTAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
output="${backup_dir}/tixkit-mysql-${timestamp}.sql.gz"

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

if command -v mysqldump >/dev/null 2>&1; then
  MYSQL_PWD="${mysql_password}" mysqldump "${dump_args[@]}" | gzip -c > "${output}"
else
  docker run --rm --add-host=host.docker.internal:host-gateway --env MYSQL_PWD="${mysql_password}" mysql:8.4 \
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

sha256sum "${output}" > "${output}.sha256"
printf '%s\n' "${output}"
