#!/usr/bin/env bash
set -euo pipefail
umask 077
source "$(dirname "$0")/lib/dr-common.sh"

: "${DATABASE_URL_MYSQL:?DATABASE_URL_MYSQL is required}"
: "${MYSQL_BACKUP_FILE:?MYSQL_BACKUP_FILE points to a gzip-compressed MySQL SQL backup}"
: "${DR_ISOLATED_TARGET:?DR_ISOLATED_TARGET=1 confirms DATABASE_URL_MYSQL is an empty isolated restore target}"
test "${DR_ISOLATED_TARGET}" = 1 || { echo 'DR_ISOLATED_TARGET must equal 1' >&2; exit 1; }
started_epoch="$(date +%s)"
mysql_image="${MYSQL_TOOL_IMAGE:-mysql:8.4@sha256:d36d39a64cd12a5c1cc9e6aa2bfb5f8d4c81a2f6586e0a04a9ae13939db02209}"
mysql_tls_mode="${MYSQL_TLS_MODE:-PREFERRED}"
case "${mysql_tls_mode}" in
  DISABLED|PREFERRED|REQUIRED|VERIFY_CA|VERIFY_IDENTITY) ;;
  *) echo 'MYSQL_TLS_MODE must be DISABLED, PREFERRED, REQUIRED, VERIFY_CA, or VERIFY_IDENTITY' >&2; exit 1 ;;
esac
if test "${DR_PRODUCTION_BUNDLE:-0}" = 1 && test "${mysql_tls_mode}" != VERIFY_IDENTITY; then
  echo 'Production MySQL restore requires MYSQL_TLS_MODE=VERIFY_IDENTITY' >&2
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
restore_started=0
restore_verified=0
mysql_provision_receipt_identity=''
mysql_provision_receipt_sha256=''
mysql_provision_nonce=''
mysql_restore_lease_pid=''
mysql_restore_lease_directory=''
mysql_restore_lease_identity=''
mysql_restore_lease_sha256=''
mysql_restore_lease_command_sha256=''
mysql_restore_lease_verifier_sha256=''
mysql_restore_lease_verification_json=''
mysql_import_pid=''
mysql_verifier_pid=''
mysql_restore_lease_holder_alive() {
  test -n "${mysql_restore_lease_pid}" && kill -0 "${mysql_restore_lease_pid}" 2>/dev/null &&
    ! ps -o stat= -p "${mysql_restore_lease_pid}" 2>/dev/null | grep -Eq '^[[:space:]]*Z'
}
cleanup() {
  unset MYSQL_PWD
  if test -n "${mysql_import_pid}" && kill -0 "${mysql_import_pid}" 2>/dev/null; then
    kill -TERM "${mysql_import_pid}" 2>/dev/null || true
    wait "${mysql_import_pid}" 2>/dev/null || true
  fi
  if test -n "${mysql_verifier_pid}" && kill -0 "${mysql_verifier_pid}" 2>/dev/null; then
    kill -TERM "${mysql_verifier_pid}" 2>/dev/null || true
    wait "${mysql_verifier_pid}" 2>/dev/null || true
  fi
  if test "${DR_PRODUCTION_BUNDLE:-0}" = 1 && test "${restore_started}" = 1 && \
    test "${restore_verified}" = 0 && test "${DR_RESTORE_EVIDENCE_RECORDED:-0}" = 0; then
    cleanup_succeeded=1
    if ! DR_HOOK_DATABASE_URL_MYSQL="${DATABASE_URL_MYSQL}" DR_HOOK_MYSQL_RESTORE_LEASE=1 \
      dr_run_isolated_hook "${DR_MYSQL_FAILED_RESTORE_CLEANUP_COMMAND}"; then
      cleanup_succeeded=0
    fi
    if test "${cleanup_succeeded}" = 1; then
      cleaned_server_uuid="$(mysql_query 'select @@server_uuid;' 2>/dev/null || true)"
      cleaned_tables="$(mysql_query 'select count(*) from information_schema.tables where table_schema = database();' 2>/dev/null || true)"
      if test "${cleaned_server_uuid}" != "${DR_MYSQL_TARGET_SERVER_UUID}" || test "${cleaned_tables}" != 0; then
        cleanup_succeeded=0
      fi
    fi
    if test "${cleanup_succeeded}" = 0; then
      echo 'CRITICAL: failed to clean the unverified MySQL restore target' >&2
    fi
  fi
  if mysql_restore_lease_holder_alive; then
    kill -TERM "${mysql_restore_lease_pid}" 2>/dev/null || true
    wait "${mysql_restore_lease_pid}" 2>/dev/null || true
  fi
  test -z "${mysql_restore_lease_directory}" || rm -rf "${mysql_restore_lease_directory}"
}
trap cleanup EXIT INT TERM

if [ ! -f "${MYSQL_BACKUP_FILE}" ]; then
  echo "Backup file not found: ${MYSQL_BACKUP_FILE}" >&2
  exit 1
fi

dr_verify_checksum "${MYSQL_BACKUP_FILE}"
dr_verify_backup_manifest "${MYSQL_BACKUP_FILE}" mysql
gzip -t "${MYSQL_BACKUP_FILE}"
mysql_restore_artifact_sha256="$(dr_sha256 "${MYSQL_BACKUP_FILE}")"
dr_reserve_restore_evidence

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
  "${mysql_tls_args[@]}"
  "${mysql_database}"
)

mysql_query() {
  local sql="$1"
  if command -v mysql >/dev/null 2>&1; then
    MYSQL_PWD="${mysql_password}" mysql "${mysql_args[@]}" --batch --skip-column-names --execute="${sql}"
  else
    MYSQL_PWD="${mysql_password}"
    export MYSQL_PWD
    docker run --rm --add-host=host.docker.internal:host-gateway "${docker_network_args[@]}" \
      "${docker_tls_args[@]}" --env MYSQL_PWD "${mysql_image}" mysql \
      "--host=${docker_host}" "--port=${mysql_port}" "--user=${mysql_user}" \
      "${docker_mysql_tls_args[@]}" "${mysql_database}" --batch --skip-column-names \
      --execute="${sql}"
  fi
}

validate_mysql_provision_receipt() {
  dr_assert_file_identity "${DR_MYSQL_TARGET_PROVISION_RECEIPT}" "${mysql_provision_receipt_identity}"
  test "$(dr_sha256 "${DR_MYSQL_TARGET_PROVISION_RECEIPT}")" = "${mysql_provision_receipt_sha256}" || {
    echo 'MySQL target provisioning receipt changed before import' >&2
    return 1
  }
  MYSQL_PROVISION_RECEIPT="${DR_MYSQL_TARGET_PROVISION_RECEIPT}" \
    EXPECTED_SERVER_UUID="${DR_MYSQL_TARGET_SERVER_UUID}" \
    EXPECTED_DATABASE="${mysql_database}" node <<'NODE'
const { readFileSync } = require('node:fs');
const receipt = JSON.parse(readFileSync(process.env.MYSQL_PROVISION_RECEIPT, 'utf8'));
if (receipt.schemaVersion !== 1) throw new Error('MySQL target provisioning receipt schema is unsupported');
if (receipt.serverUuid !== process.env.EXPECTED_SERVER_UUID) throw new Error('MySQL target provisioning receipt server UUID mismatch');
if (receipt.database !== process.env.EXPECTED_DATABASE) throw new Error('MySQL target provisioning receipt database mismatch');
if (!/^[a-f0-9]{64,128}$/.test(receipt.provisioningNonce ?? '')) throw new Error('MySQL target provisioning receipt nonce is invalid');
if (receipt.exclusive !== true || receipt.empty !== true) throw new Error('MySQL target provisioning receipt must attest an exclusive empty target');
const createdAt = Date.parse(receipt.createdAt);
const expiresAt = Date.parse(receipt.expiresAt);
const now = Date.now();
if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt)) throw new Error('MySQL target provisioning receipt timestamps are invalid');
if (createdAt > now + 60_000 || createdAt < now - 60 * 60 * 1000) throw new Error('MySQL target provisioning receipt is not recent');
if (expiresAt <= now || expiresAt > createdAt + 24 * 60 * 60 * 1000) throw new Error('MySQL target provisioning receipt is expired or overlong');
NODE
}

validate_mysql_restore_lease_json() {
  LEASE_JSON="$1" EXPECTED_ATTEMPT_ID="${DR_MYSQL_RESTORE_ATTEMPT_ID}" \
    EXPECTED_ARTIFACT_SHA256="${mysql_restore_artifact_sha256}" \
    EXPECTED_RESTORE_TARGET_ID="${DR_RESTORE_TARGET_ID}" \
    EXPECTED_SERVER_UUID="${DR_MYSQL_TARGET_SERVER_UUID}" EXPECTED_DATABASE="${mysql_database}" \
    EXPECTED_HOLDER_PID="${mysql_restore_lease_pid}" \
    EXPECTED_PROVISIONING_NONCE="${mysql_provision_nonce}" \
    MIN_REMAINING_SECONDS="${DR_MYSQL_MIN_LEASE_REMAINING_SECONDS:-5}" node <<'NODE'
const lease = JSON.parse(process.env.LEASE_JSON);
if (lease.schemaVersion !== 1 || lease.active !== true || lease.renewable !== true) throw new Error('MySQL restore lease is not active and renewable');
for (const [field, expected] of [
  ['attemptId', process.env.EXPECTED_ATTEMPT_ID],
  ['artifactSha256', process.env.EXPECTED_ARTIFACT_SHA256],
  ['restoreTargetId', process.env.EXPECTED_RESTORE_TARGET_ID],
  ['serverUuid', process.env.EXPECTED_SERVER_UUID],
  ['database', process.env.EXPECTED_DATABASE],
]) if (lease[field] !== expected) throw new Error(`MySQL restore lease ${field} mismatch`);
if (!/^[a-f0-9]{64,128}$/.test(lease.provisioningNonce ?? '')) throw new Error('MySQL restore lease nonce is invalid');
if (lease.provisioningNonce !== process.env.EXPECTED_PROVISIONING_NONCE) throw new Error('MySQL restore lease provisioning nonce mismatch');
if (!Number.isInteger(lease.holderPid) || lease.holderPid < 2 || String(lease.holderPid) !== process.env.EXPECTED_HOLDER_PID) throw new Error('MySQL restore lease holder PID mismatch');
const expiresAt = Date.parse(lease.expiresAt);
const minimum = Number(process.env.MIN_REMAINING_SECONDS);
if (!Number.isFinite(minimum) || minimum < 1 || !Number.isFinite(expiresAt) || expiresAt <= Date.now() + minimum * 1000) {
  throw new Error('MySQL restore lease is expired or too close to expiry');
}
NODE
}

verify_mysql_restore_lease() {
  mysql_restore_lease_holder_alive || {
    echo 'MySQL restore lease holder exited' >&2
    return 1
  }
  dr_assert_file_identity "${DR_MYSQL_RESTORE_LEASE_FILE}" "${mysql_restore_lease_identity}"
  test "$(dr_sha256 "${DR_MYSQL_RESTORE_LEASE_FILE}")" = "${mysql_restore_lease_sha256}" || {
    echo 'MySQL restore lease readiness evidence changed' >&2
    return 1
  }
  test "$(dr_sha256 "${DR_MYSQL_TARGET_LEASE_COMMAND}")" = "${mysql_restore_lease_command_sha256}" || {
    echo 'MySQL restore lease holder changed during execution' >&2
    return 1
  }
  test "$(dr_sha256 "${DR_MYSQL_TARGET_LEASE_VERIFY_COMMAND}")" = "${mysql_restore_lease_verifier_sha256}" || {
    echo 'MySQL restore lease verifier changed before execution' >&2
    return 1
  }
  mysql_restore_lease_verification_json="$(
    DR_HOOK_DATABASE_URL_MYSQL="${DATABASE_URL_MYSQL}" DR_HOOK_MYSQL_PROVISION_RECEIPT=1 \
      DR_HOOK_MYSQL_RESTORE_LEASE=1 dr_run_isolated_hook "${DR_MYSQL_TARGET_LEASE_VERIFY_COMMAND}"
  )"
  test "$(dr_sha256 "${DR_MYSQL_TARGET_LEASE_VERIFY_COMMAND}")" = "${mysql_restore_lease_verifier_sha256}" || {
    echo 'MySQL restore lease verifier changed during execution' >&2
    return 1
  }
  validate_mysql_restore_lease_json "${mysql_restore_lease_verification_json}"
  validate_mysql_provision_receipt
}

start_mysql_restore_lease() {
  mysql_restore_lease_directory="$(mktemp -d)"
  export DR_MYSQL_RESTORE_ATTEMPT_ID
  DR_MYSQL_RESTORE_ATTEMPT_ID="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")"
  export DR_MYSQL_RESTORE_ATTEMPT_ID
  export DR_MYSQL_RESTORE_ARTIFACT_SHA256="${mysql_restore_artifact_sha256}"
  export DR_MYSQL_RESTORE_TARGET_ID="${DR_RESTORE_TARGET_ID}"
  export DR_MYSQL_RESTORE_LEASE_FILE="${mysql_restore_lease_directory}/lease-ready.json"
  mysql_restore_lease_command_sha256="$(dr_sha256 "${DR_MYSQL_TARGET_LEASE_COMMAND}")"
  mysql_restore_lease_verifier_sha256="$(dr_sha256 "${DR_MYSQL_TARGET_LEASE_VERIFY_COMMAND}")"
  env -i PATH="${PATH:-/usr/bin:/bin}" HOME="${HOME:-/var/empty}" TMPDIR="${TMPDIR:-/tmp}" \
    LANG=C LC_ALL=C DATABASE_URL_MYSQL="${DATABASE_URL_MYSQL}" \
    DR_MYSQL_TARGET_PROVISION_RECEIPT="${DR_MYSQL_TARGET_PROVISION_RECEIPT}" \
    DR_MYSQL_RESTORE_ATTEMPT_ID="${DR_MYSQL_RESTORE_ATTEMPT_ID}" \
    DR_MYSQL_RESTORE_ARTIFACT_SHA256="${DR_MYSQL_RESTORE_ARTIFACT_SHA256}" \
    DR_MYSQL_RESTORE_TARGET_ID="${DR_MYSQL_RESTORE_TARGET_ID}" \
    DR_MYSQL_RESTORE_LEASE_FILE="${DR_MYSQL_RESTORE_LEASE_FILE}" \
    "${DR_MYSQL_TARGET_LEASE_COMMAND}" &
  mysql_restore_lease_pid=$!
  local acquire_timeout="${DR_MYSQL_LEASE_ACQUIRE_TIMEOUT_SECONDS:-10}"
  [[ "${acquire_timeout}" =~ ^[1-9][0-9]*$ ]] || {
    echo 'DR_MYSQL_LEASE_ACQUIRE_TIMEOUT_SECONDS must be a positive integer' >&2
    return 1
  }
  local deadline=$((SECONDS + acquire_timeout))
  while test ! -f "${DR_MYSQL_RESTORE_LEASE_FILE}"; do
    mysql_restore_lease_holder_alive || {
      wait "${mysql_restore_lease_pid}" 2>/dev/null || true
      echo 'MySQL restore lease acquisition failed' >&2
      return 1
    }
    test "${SECONDS}" -lt "${deadline}" || {
      echo 'Timed out acquiring the MySQL restore lease' >&2
      return 1
    }
    sleep 0.05
  done
  mysql_restore_lease_identity="$(dr_file_identity "${DR_MYSQL_RESTORE_LEASE_FILE}")"
  mysql_restore_lease_sha256="$(dr_sha256 "${DR_MYSQL_RESTORE_LEASE_FILE}")"
  lease_reported_pid="$(LEASE_FILE="${DR_MYSQL_RESTORE_LEASE_FILE}" node -e "process.stdout.write(String(JSON.parse(require('node:fs').readFileSync(process.env.LEASE_FILE)).holderPid ?? ''))")"
  test "${lease_reported_pid}" = "${mysql_restore_lease_pid}" || {
    echo 'MySQL restore lease holder PID does not match the launched adapter' >&2
    return 1
  }
  validate_mysql_restore_lease_json "$(cat "${DR_MYSQL_RESTORE_LEASE_FILE}")"
  verify_mysql_restore_lease
}

wait_for_mysql_process_with_lease() {
  local process_pid="$1"
  local process_label="$2"
  local process_status=0
  local verify_interval="${DR_MYSQL_LEASE_VERIFY_INTERVAL_SECONDS:-5}"
  [[ "${verify_interval}" =~ ^[1-9][0-9]*$ ]] || {
    echo 'DR_MYSQL_LEASE_VERIFY_INTERVAL_SECONDS must be a positive integer' >&2
    return 1
  }
  local next_verification=$((SECONDS + verify_interval))
  while kill -0 "${process_pid}" 2>/dev/null; do
    if ! mysql_restore_lease_holder_alive; then
      kill -TERM "${process_pid}" 2>/dev/null || true
      wait "${process_pid}" 2>/dev/null || true
      printf 'MySQL restore lease was lost during %s\n' "${process_label}" >&2
      return 1
    fi
    if test "${SECONDS}" -ge "${next_verification}"; then
      if ! verify_mysql_restore_lease; then
        kill -TERM "${process_pid}" 2>/dev/null || true
        wait "${process_pid}" 2>/dev/null || true
        printf 'MySQL restore lease verification failed during %s\n' "${process_label}" >&2
        return 1
      fi
      next_verification=$((SECONDS + verify_interval))
    fi
    sleep 0.05
  done
  wait "${process_pid}" || process_status=$?
  test "${process_status}" = 0 || return "${process_status}"
  verify_mysql_restore_lease
}

run_mysql_application_verifier_with_lease() {
  : "${DR_VERIFY_COMMAND:?DR_VERIFY_COMMAND must be an executable reconciliation verifier}"
  test -x "${DR_VERIFY_COMMAND}" || {
    echo "DR_VERIFY_COMMAND is not executable: ${DR_VERIFY_COMMAND}" >&2
    return 1
  }
  local verifier_sha256_before verifier_sha256_after
  verifier_sha256_before="$(dr_sha256 "${DR_VERIFY_COMMAND}")"
  env -i PATH="${PATH:-/usr/bin:/bin}" HOME="${HOME:-/var/empty}" TMPDIR="${TMPDIR:-/tmp}" \
    LANG=C LC_ALL=C DATABASE_URL_MYSQL="${DATABASE_URL_MYSQL}" DR_RESTORE_KIND=mysql \
    "${DR_VERIFY_COMMAND}" &
  mysql_verifier_pid=$!
  wait_for_mysql_process_with_lease "${mysql_verifier_pid}" 'application verifier'
  mysql_verifier_pid=''
  verifier_sha256_after="$(dr_sha256 "${DR_VERIFY_COMMAND}")"
  test "${verifier_sha256_before}" = "${verifier_sha256_after}" || {
    echo "Restore verifier changed during execution: ${DR_VERIFY_COMMAND}" >&2
    return 1
  }
  DR_LAST_VERIFIER_SHA256="${verifier_sha256_after}"
}

if test "${DR_PRODUCTION_BUNDLE:-0}" = 1; then
  : "${DR_MYSQL_TARGET_SERVER_UUID:?DR_MYSQL_TARGET_SERVER_UUID must bind the isolated Production restore target}"
  [[ "${DR_MYSQL_TARGET_SERVER_UUID}" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$ ]] || {
    echo 'DR_MYSQL_TARGET_SERVER_UUID must be a lowercase UUID' >&2
    exit 1
  }
  : "${DR_MYSQL_FAILED_RESTORE_CLEANUP_COMMAND:?DR_MYSQL_FAILED_RESTORE_CLEANUP_COMMAND must reset a failed isolated target}"
  : "${DR_RESTORE_TARGET_ID:?DR_RESTORE_TARGET_ID must bind the Production MySQL lease to the isolated target}"
  test -x "${DR_MYSQL_FAILED_RESTORE_CLEANUP_COMMAND}" || {
    echo 'DR_MYSQL_FAILED_RESTORE_CLEANUP_COMMAND must be executable' >&2
    exit 1
  }
  : "${DR_MYSQL_TARGET_PROVISION_RECEIPT:?DR_MYSQL_TARGET_PROVISION_RECEIPT must attest a newly provisioned exclusive target}"
  test -f "${DR_MYSQL_TARGET_PROVISION_RECEIPT}" && test ! -L "${DR_MYSQL_TARGET_PROVISION_RECEIPT}" || {
    echo 'DR_MYSQL_TARGET_PROVISION_RECEIPT must be a real file, not a symlink' >&2
    exit 1
  }
  : "${DR_MYSQL_TARGET_LEASE_COMMAND:?DR_MYSQL_TARGET_LEASE_COMMAND must atomically consume the provisioning nonce and hold the target lease}"
  : "${DR_MYSQL_TARGET_LEASE_VERIFY_COMMAND:?DR_MYSQL_TARGET_LEASE_VERIFY_COMMAND must independently authenticate the active lease}"
  test -x "${DR_MYSQL_TARGET_LEASE_COMMAND}" && test -x "${DR_MYSQL_TARGET_LEASE_VERIFY_COMMAND}" || {
    echo 'Production MySQL lease holder and verifier commands must be executable' >&2
    exit 1
  }
  [[ "${DR_MYSQL_LEASE_VERIFY_INTERVAL_SECONDS:-5}" =~ ^[1-9][0-9]*$ ]] || {
    echo 'DR_MYSQL_LEASE_VERIFY_INTERVAL_SECONDS must be a positive integer' >&2
    exit 1
  }
  mysql_provision_receipt_identity="$(dr_file_identity "${DR_MYSQL_TARGET_PROVISION_RECEIPT}")"
  mysql_provision_receipt_sha256="$(dr_sha256 "${DR_MYSQL_TARGET_PROVISION_RECEIPT}")"
  validate_mysql_provision_receipt
  mysql_provision_nonce="$(RECEIPT="${DR_MYSQL_TARGET_PROVISION_RECEIPT}" node -e "process.stdout.write(JSON.parse(require('node:fs').readFileSync(process.env.RECEIPT)).provisioningNonce)")"
  start_mysql_restore_lease
fi

if command -v mysql >/dev/null 2>&1; then
  if test "${DR_PRODUCTION_BUNDLE:-0}" = 1; then
    actual_server_uuid="$(mysql_query 'select @@server_uuid;')"
    test "${actual_server_uuid}" = "${DR_MYSQL_TARGET_SERVER_UUID}" || {
      echo 'MySQL restore target server UUID does not match DR_MYSQL_TARGET_SERVER_UUID' >&2
      exit 1
    }
  fi
  existing_tables="$(mysql_query 'select count(*) from information_schema.tables where table_schema = database();')"
  test "${existing_tables}" = 0 || { echo 'MySQL restore target is not empty; refusing in-place restore' >&2; exit 1; }
  if test "${DR_PRODUCTION_BUNDLE:-0}" = 1; then
    verify_mysql_restore_lease
    actual_server_uuid="$(mysql_query 'select @@server_uuid;')"
    existing_tables="$(mysql_query 'select count(*) from information_schema.tables where table_schema = database();')"
    test "${actual_server_uuid}" = "${DR_MYSQL_TARGET_SERVER_UUID}" && test "${existing_tables}" = 0 || {
      echo 'MySQL restore target changed after provisioning verification' >&2
      exit 1
    }
  fi
  restore_started=1
  if test "${DR_PRODUCTION_BUNDLE:-0}" = 1; then
    gzip -dc "${MYSQL_BACKUP_FILE}" | MYSQL_PWD="${mysql_password}" mysql "${mysql_args[@]}" &
    mysql_import_pid=$!
    wait_for_mysql_process_with_lease "${mysql_import_pid}" import
    mysql_import_pid=''
  else
    gzip -dc "${MYSQL_BACKUP_FILE}" | MYSQL_PWD="${mysql_password}" mysql "${mysql_args[@]}"
  fi
else
  MYSQL_PWD="${mysql_password}"
  export MYSQL_PWD
  if test "${DR_PRODUCTION_BUNDLE:-0}" = 1; then
    actual_server_uuid="$(mysql_query 'select @@server_uuid;')"
    test "${actual_server_uuid}" = "${DR_MYSQL_TARGET_SERVER_UUID}" || {
      echo 'MySQL restore target server UUID does not match DR_MYSQL_TARGET_SERVER_UUID' >&2
      exit 1
    }
  fi
  existing_tables="$(mysql_query 'select count(*) from information_schema.tables where table_schema = database();')"
  test "${existing_tables}" = 0 || { echo 'MySQL restore target is not empty; refusing in-place restore' >&2; exit 1; }
  if test "${DR_PRODUCTION_BUNDLE:-0}" = 1; then
    verify_mysql_restore_lease
    actual_server_uuid="$(mysql_query 'select @@server_uuid;')"
    existing_tables="$(mysql_query 'select count(*) from information_schema.tables where table_schema = database();')"
    test "${actual_server_uuid}" = "${DR_MYSQL_TARGET_SERVER_UUID}" && test "${existing_tables}" = 0 || {
      echo 'MySQL restore target changed after provisioning verification' >&2
      exit 1
    }
  fi
  restore_started=1
  if test "${DR_PRODUCTION_BUNDLE:-0}" = 1; then
    gzip -dc "${MYSQL_BACKUP_FILE}" | docker run --rm -i --add-host=host.docker.internal:host-gateway "${docker_network_args[@]}" "${docker_tls_args[@]}" --env MYSQL_PWD "${mysql_image}" \
      mysql "--host=${docker_host}" "--port=${mysql_port}" "--user=${mysql_user}" \
      "${docker_mysql_tls_args[@]}" "${mysql_database}" &
    mysql_import_pid=$!
    wait_for_mysql_process_with_lease "${mysql_import_pid}" import
    mysql_import_pid=''
  else
    gzip -dc "${MYSQL_BACKUP_FILE}" | docker run --rm -i --add-host=host.docker.internal:host-gateway "${docker_network_args[@]}" "${docker_tls_args[@]}" --env MYSQL_PWD "${mysql_image}" \
      mysql "--host=${docker_host}" "--port=${mysql_port}" "--user=${mysql_user}" \
      "${docker_mysql_tls_args[@]}" "${mysql_database}"
  fi
fi
unset MYSQL_PWD
if test "${DR_PRODUCTION_BUNDLE:-0}" = 1; then verify_mysql_restore_lease; fi
if test "${DR_PRODUCTION_BUNDLE:-0}" = 1; then
  run_mysql_application_verifier_with_lease
  verify_mysql_restore_lease
else
  dr_run_restore_verifier mysql
fi
if test "${DR_PRODUCTION_BUNDLE:-0}" = 1; then
  lease_verification_file="${mysql_restore_lease_directory}/lease-verification.json"
  LEASE_JSON="${mysql_restore_lease_verification_json}" LEASE_FILE="${lease_verification_file}" node <<'NODE'
const { writeFileSync } = require('node:fs');
writeFileSync(process.env.LEASE_FILE, process.env.LEASE_JSON, { flag: 'wx', mode: 0o600 });
NODE
  DR_RESTORE_ADAPTER_COMMANDS="${DR_RESTORE_ADAPTER_COMMANDS:+${DR_RESTORE_ADAPTER_COMMANDS},}${DR_MYSQL_TARGET_LEASE_COMMAND},${DR_MYSQL_TARGET_LEASE_VERIFY_COMMAND},${DR_MYSQL_FAILED_RESTORE_CLEANUP_COMMAND}"
  DR_RESTORE_ADAPTER_EVIDENCE_FILES="${DR_RESTORE_ADAPTER_EVIDENCE_FILES:+${DR_RESTORE_ADAPTER_EVIDENCE_FILES},}${DR_MYSQL_TARGET_PROVISION_RECEIPT},${DR_MYSQL_RESTORE_LEASE_FILE},${lease_verification_file}"
  export DR_RESTORE_ADAPTER_COMMANDS DR_RESTORE_ADAPTER_EVIDENCE_FILES
fi
dr_record_restore_evidence "${MYSQL_BACKUP_FILE}" mysql "${started_epoch}"
if test "${DR_PRODUCTION_BUNDLE:-0}" = 1 && ! verify_mysql_restore_lease; then
  if test -n "${DR_EVIDENCE_FILE:-}" && test -f "${DR_EVIDENCE_FILE}"; then
    invalid_evidence_identity="$(dr_file_identity "${DR_EVIDENCE_FILE}")"
    dr_remove_file_if_identity "${DR_EVIDENCE_FILE}" "${invalid_evidence_identity}"
  fi
  DR_RESTORE_EVIDENCE_RECORDED=0
  echo 'MySQL restore lease was lost while recording evidence' >&2
  exit 1
fi
restore_verified=1
