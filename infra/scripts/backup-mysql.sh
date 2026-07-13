#!/usr/bin/env bash
set -euo pipefail
umask 077
source "$(dirname "$0")/lib/dr-common.sh"

: "${DATABASE_URL_MYSQL:?DATABASE_URL_MYSQL is required}"
dr_require_backup_policy

backup_dir="${BACKUP_DIR:-backups/mysql}"
timestamp="${BACKUP_TIMESTAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
output="${backup_dir}/tixkit-mysql-${timestamp}.sql.gz"
recovery_point_at="${DR_RECOVERY_POINT_AT:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
mysql_image="${MYSQL_TOOL_IMAGE:-mysql:8.4@sha256:d36d39a64cd12a5c1cc9e6aa2bfb5f8d4c81a2f6586e0a04a9ae13939db02209}"
mysql_tls_mode="${MYSQL_TLS_MODE:-PREFERRED}"
case "${mysql_tls_mode}" in
  DISABLED|PREFERRED|REQUIRED|VERIFY_CA|VERIFY_IDENTITY) ;;
  *) echo 'MYSQL_TLS_MODE must be DISABLED, PREFERRED, REQUIRED, VERIFY_CA, or VERIFY_IDENTITY' >&2; exit 1 ;;
esac
if test "${DR_PRODUCTION_BUNDLE:-0}" = 1 && test "${mysql_tls_mode}" != VERIFY_IDENTITY; then
  echo 'Production MySQL backup requires MYSQL_TLS_MODE=VERIFY_IDENTITY' >&2
  exit 1
fi
mysql_tls_args=("--ssl-mode=${mysql_tls_mode}")
docker_tls_args=()
docker_mysql_tls_args=("--ssl-mode=${mysql_tls_mode}")
docker_network_args=()
if test -n "${MYSQL_TOOL_DOCKER_NETWORK:-}"; then
  [[ "${MYSQL_TOOL_DOCKER_NETWORK}" =~ ^[A-Za-z0-9_.-]{1,128}$ ]] || {
    echo 'MYSQL_TOOL_DOCKER_NETWORK is invalid' >&2
    exit 1
  }
  docker_network_args=("--network=${MYSQL_TOOL_DOCKER_NETWORK}")
fi
if test "${mysql_tls_mode}" = VERIFY_CA || test "${mysql_tls_mode}" = VERIFY_IDENTITY; then
  : "${MYSQL_TLS_CA_FILE:?MYSQL_TLS_CA_FILE is required for VERIFY_CA or VERIFY_IDENTITY}"
  test -f "${MYSQL_TLS_CA_FILE}" && test ! -L "${MYSQL_TLS_CA_FILE}" || {
    echo 'MYSQL_TLS_CA_FILE must be a real file, not a symlink' >&2
    exit 1
  }
  mysql_tls_args+=("--ssl-ca=${MYSQL_TLS_CA_FILE}")
  docker_tls_args=(-v "${MYSQL_TLS_CA_FILE}:/tixkit-mysql-tls/ca.pem:ro")
  docker_mysql_tls_args+=("--ssl-ca=/tixkit-mysql-tls/ca.pem")
fi

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

dr_prepare_output_directory "${backup_dir}"
dr_assert_output_path_available "${output}"
dr_assert_output_path_available "${output}.sha256"
dr_assert_output_path_available "${output}.manifest.json"
staged="$(mktemp "${backup_dir}/.tixkit-mysql.XXXXXX")"
output_created=0
output_identity=''
checksum_created=0
manifest_created=0
complete=0
cleanup() {
  rm -f "${staged}"
  if test "${complete}" = 0; then
    test "${manifest_created}" = 0 || rm -f "${output}.manifest.json"
    test "${checksum_created}" = 0 || rm -f "${output}.sha256"
    test "${output_created}" = 0 || dr_remove_file_if_identity "${output}" "${output_identity}"
  fi
}
trap cleanup EXIT INT TERM

docker_host="${mysql_host}"
if [ "${mysql_host}" = "localhost" ] || [ "${mysql_host}" = "127.0.0.1" ]; then
  docker_host="host.docker.internal"
fi

dump_args=(
  "--host=${mysql_host}"
  "--port=${mysql_port}"
  "--user=${mysql_user}"
  "${mysql_tls_args[@]}"
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
  non_transactional_tables="$(MYSQL_PWD="${mysql_password}" mysql "--host=${mysql_host}" "--port=${mysql_port}" "--user=${mysql_user}" "${mysql_tls_args[@]}" --batch --skip-column-names --execute="${engine_query}")"
else
  MYSQL_PWD="${mysql_password}"
  export MYSQL_PWD
  non_transactional_tables="$(docker run --rm --add-host=host.docker.internal:host-gateway "${docker_network_args[@]}" "${docker_tls_args[@]}" --env MYSQL_PWD "${mysql_image}" mysql "--host=${docker_host}" "--port=${mysql_port}" "--user=${mysql_user}" "${docker_mysql_tls_args[@]}" --batch --skip-column-names --execute="${engine_query}")"
fi
test "${non_transactional_tables}" = 0 || {
  echo 'MySQL backup requires every base table to use InnoDB for a consistent recovery point' >&2
  exit 1
}

if command -v mysqldump >/dev/null 2>&1; then
  MYSQL_PWD="${mysql_password}" mysqldump "${dump_args[@]}" | gzip -c > "${staged}"
else
  MYSQL_PWD="${mysql_password}"
  export MYSQL_PWD
  docker run --rm --add-host=host.docker.internal:host-gateway "${docker_network_args[@]}" "${docker_tls_args[@]}" --env MYSQL_PWD "${mysql_image}" \
    mysqldump \
    "--host=${docker_host}" \
    "--port=${mysql_port}" \
    "--user=${mysql_user}" \
    "${docker_mysql_tls_args[@]}" \
    "--single-transaction" \
    "--routines" \
    "--triggers" \
    "--events" \
    "--no-tablespaces" \
    "--set-gtid-purged=OFF" \
    "${mysql_database}" | gzip -c > "${staged}"
fi
unset MYSQL_PWD

dr_publish_staged_file "${staged}" "${output}"
staged=''
output_created=1
output_identity="$(dr_file_identity "${output}")"
dr_assert_file_identity "${output}" "${output_identity}"
dr_write_checksum "${output}"
checksum_created=1
dr_assert_file_identity "${output}" "${output_identity}"
dr_write_backup_manifest "${output}" mysql "${recovery_point_at}"
manifest_created=1
complete=1
printf '%s\n' "${output}"
