#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib/dr-common.sh"

: "${S3_ENDPOINT:?S3_ENDPOINT is required}"
: "${S3_BUCKET:?S3_BUCKET is required}"
dr_validate_s3_bucket "${S3_BUCKET}"
s3_auth_mode="${S3_AUTH_MODE:-static}"
if [ "${s3_auth_mode}" = static ]; then
  : "${S3_ACCESS_KEY_ID:?S3_ACCESS_KEY_ID is required for static auth}"
  : "${S3_SECRET_ACCESS_KEY:?S3_SECRET_ACCESS_KEY is required for static auth}"
elif [ "${s3_auth_mode}" = workload-identity ]; then
  : "${S3_CREDENTIAL_SETUP_COMMAND:?S3_CREDENTIAL_SETUP_COMMAND is required for workload identity}"
  test -x "${S3_CREDENTIAL_SETUP_COMMAND}" || { echo 'S3_CREDENTIAL_SETUP_COMMAND is not executable' >&2; exit 1; }
else
  echo 'S3_AUTH_MODE must be static or workload-identity' >&2
  exit 1
fi
if test "${DR_PRODUCTION_BUNDLE:-0}" = 1 && test "${s3_auth_mode}" != workload-identity; then
  echo 'Production bundle restore requires S3_AUTH_MODE=workload-identity' >&2
  exit 1
fi
: "${OBJECT_STORAGE_BACKUP_FILE:?OBJECT_STORAGE_BACKUP_FILE points to a tar.gz object-storage backup}"
: "${RESTORE_S3_BUCKET:?RESTORE_S3_BUCKET must be a new isolated destination bucket}"
dr_validate_s3_bucket "${RESTORE_S3_BUCKET}"
: "${DR_ISOLATED_TARGET:?DR_ISOLATED_TARGET=1 confirms RESTORE_S3_BUCKET is isolated}"
test "${DR_ISOLATED_TARGET}" = 1 || { echo 'DR_ISOLATED_TARGET must equal 1' >&2; exit 1; }
test "${RESTORE_S3_BUCKET}" != "${S3_BUCKET}" || { echo 'RESTORE_S3_BUCKET must differ from the source bucket' >&2; exit 1; }
started_epoch="$(date +%s)"

if [ ! -f "${OBJECT_STORAGE_BACKUP_FILE}" ]; then
  echo "Backup file not found: ${OBJECT_STORAGE_BACKUP_FILE}" >&2
  exit 1
fi

dr_verify_checksum "${OBJECT_STORAGE_BACKUP_FILE}"
dr_verify_backup_manifest "${OBJECT_STORAGE_BACKUP_FILE}" object-storage
dr_reserve_restore_evidence

minio_mc_image="${MINIO_MC_IMAGE:-minio/mc:RELEASE.2025-08-13T08-35-41Z@sha256:a7fe349ef4bd8521fb8497f55c6042871b2ae640607cf99d9bede5e9bdf11727}"
workdir="$(mktemp -d)"
remote_started=0
restore_verified=0
restore_run_id="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")"
ownership_file="${workdir}/bucket-ownership-${restore_run_id}.json"
ownership_identity=''
ownership_sha256=''
ownership_verifier_sha256=''
export DR_OBJECT_RESTORE_RUN_ID="${restore_run_id}"
export DR_OBJECT_BUCKET_OWNERSHIP_FILE="${ownership_file}"
docker_endpoint="${S3_ENDPOINT/localhost/host.docker.internal}"
docker_endpoint="${docker_endpoint/127.0.0.1/host.docker.internal}"

verify_object_bucket_ownership() {
  local verifier_sha256_before verifier_sha256_after
  test -n "${ownership_identity}" || {
    echo 'Object destination ownership receipt has not been established' >&2
    return 1
  }
  dr_assert_file_identity "${ownership_file}" "${ownership_identity}"
  test "$(dr_sha256 "${ownership_file}")" = "${ownership_sha256}" || {
    echo 'Object destination ownership receipt changed' >&2
    return 1
  }
  verifier_sha256_before="$(dr_sha256 "${DR_OBJECT_BUCKET_OWNERSHIP_VERIFY_COMMAND}")"
  test "${verifier_sha256_before}" = "${ownership_verifier_sha256}" || {
    echo 'Object destination ownership verifier changed' >&2
    return 1
  }
  DR_HOOK_S3=1 DR_HOOK_OBJECT_OWNERSHIP=1 \
    dr_run_isolated_hook "${DR_OBJECT_BUCKET_OWNERSHIP_VERIFY_COMMAND}"
  verifier_sha256_after="$(dr_sha256 "${DR_OBJECT_BUCKET_OWNERSHIP_VERIFY_COMMAND}")"
  test "${verifier_sha256_after}" = "${ownership_verifier_sha256}" || {
    echo 'Object destination ownership verifier changed during execution' >&2
    return 1
  }
  dr_assert_file_identity "${ownership_file}" "${ownership_identity}"
  test "$(dr_sha256 "${ownership_file}")" = "${ownership_sha256}" || {
    echo 'Object destination ownership receipt changed during verification' >&2
    return 1
  }
}

establish_object_bucket_ownership() {
  test -f "${ownership_file}" && test ! -L "${ownership_file}" || {
    echo 'Production object upload did not create a safe destination ownership receipt' >&2
    return 1
  }
  OWNERSHIP_FILE="${ownership_file}" EXPECTED_ENDPOINT="${S3_ENDPOINT}" \
    EXPECTED_BUCKET="${RESTORE_S3_BUCKET}" EXPECTED_RUN_ID="${restore_run_id}" node <<'NODE'
const { readFileSync } = require('node:fs');
const receipt = JSON.parse(readFileSync(process.env.OWNERSHIP_FILE, 'utf8'));
if (
  receipt.schemaVersion !== 1 || receipt.endpoint !== process.env.EXPECTED_ENDPOINT ||
  receipt.bucket !== process.env.EXPECTED_BUCKET || receipt.restoreRunId !== process.env.EXPECTED_RUN_ID ||
  receipt.created !== true
) throw new Error('Object destination ownership receipt does not bind this restore run');
NODE
  ownership_identity="$(dr_file_identity "${ownership_file}")"
  ownership_sha256="$(dr_sha256 "${ownership_file}")"
  verify_object_bucket_ownership
  remote_started=1
}

cleanup() {
  if test "${DR_PRODUCTION_BUNDLE:-0}" = 1 && test "${remote_started}" = 1 && \
    test "${restore_verified}" = 0 && test "${DR_RESTORE_EVIDENCE_RECORDED:-0}" = 0; then
    cleanup_succeeded=1
    if ! verify_object_bucket_ownership; then
      cleanup_succeeded=0
    elif ! DR_HOOK_S3=1 DR_HOOK_OBJECT_OWNERSHIP=1 \
      dr_run_isolated_hook "${DR_OBJECT_FAILED_RESTORE_CLEANUP_COMMAND}"; then
      cleanup_succeeded=0
    fi
    if test "${cleanup_succeeded}" = 1 && ! DR_HOOK_S3=1 DR_HOOK_OBJECT_OWNERSHIP=1 \
      dr_run_isolated_hook "${DR_OBJECT_ABSENCE_VERIFY_COMMAND}"; then
      cleanup_succeeded=0
    fi
    test "${cleanup_succeeded}" = 1 || echo 'CRITICAL: failed to clean the unverified object restore target' >&2
  fi
  rm -rf "${workdir}"
}
trap cleanup EXIT

ARCHIVE="${OBJECT_STORAGE_BACKUP_FILE}" DESTINATION="${workdir}" \
  EXPECTED_BUCKET="${S3_BUCKET}" MAX_BYTES="${OBJECT_RESTORE_MAX_BYTES:-107374182400}" \
  MAX_MEMBERS="${OBJECT_RESTORE_MAX_MEMBERS:-1000000}" python3 <<'PY'
import os, pathlib, tarfile
archive = os.environ['ARCHIVE']
destination = pathlib.Path(os.environ['DESTINATION']).resolve()
maximum = int(os.environ['MAX_BYTES'])
maximum_members = int(os.environ['MAX_MEMBERS'])
expected_bucket = os.environ['EXPECTED_BUCKET']
seen = set()
total = 0
with tarfile.open(archive, 'r:gz') as tf:
    members = tf.getmembers()
    if len(members) > maximum_members:
        raise SystemExit('Archive exceeds OBJECT_RESTORE_MAX_MEMBERS')
    for member in members:
        raw = member.name[:-1] if member.isdir() and member.name.endswith('/') else member.name
        path = pathlib.PurePosixPath(raw)
        canonical = path.as_posix()
        is_inventory = canonical == 'object-inventory.json'
        in_bucket = bool(path.parts) and path.parts[0] == expected_bucket
        if ('\\' in raw or '//' in raw or raw.startswith('./') or path.is_absolute() or
                '..' in path.parts or '.' in path.parts or canonical != raw or
                not path.parts or not (is_inventory or in_bucket) or
                (is_inventory and not member.isfile()) or canonical in seen):
            raise SystemExit(f'Unsafe or duplicate archive path: {member.name}')
        if not (member.isfile() or member.isdir()):
            raise SystemExit(f'Unsupported archive entry type: {member.name}')
        seen.add(canonical)
        total += member.size
        if total > maximum:
            raise SystemExit('Archive exceeds OBJECT_RESTORE_MAX_BYTES')
    tf.extractall(destination, members=members)
restored_root = (destination / expected_bucket).resolve()
if not restored_root.is_relative_to(destination) or not restored_root.is_dir():
    raise SystemExit('Archive does not contain the expected bucket root')
if not (destination / 'object-inventory.json').is_file():
    raise SystemExit('Archive does not contain object-inventory.json')
PY

inventory="${workdir}/object-inventory.json"
dr_verify_object_inventory "${workdir}/${S3_BUCKET}" "${S3_BUCKET}" "${inventory}"
export DR_OBJECT_INVENTORY_FILE="${inventory}"
inventory_identity="$(dr_file_identity "${inventory}")"
inventory_sha256="$(dr_sha256 "${inventory}")"
assert_inventory_unchanged() {
  dr_assert_file_identity "${inventory}" "${inventory_identity}"
  test "$(dr_sha256 "${inventory}")" = "${inventory_sha256}" || {
    echo 'Object inventory changed during restore adapters' >&2
    return 1
  }
  dr_verify_object_inventory "${workdir}/${S3_BUCKET}" "${S3_BUCKET}" "${inventory}"
}

if test "${DR_PRODUCTION_BUNDLE:-0}" = 1; then
  : "${DR_OBJECT_FAILED_RESTORE_CLEANUP_COMMAND:?DR_OBJECT_FAILED_RESTORE_CLEANUP_COMMAND must remove a failed Production destination bucket}"
  : "${DR_OBJECT_ABSENCE_VERIFY_COMMAND:?DR_OBJECT_ABSENCE_VERIFY_COMMAND must independently prove failed bucket removal}"
  : "${DR_OBJECT_BUCKET_OWNERSHIP_VERIFY_COMMAND:?DR_OBJECT_BUCKET_OWNERSHIP_VERIFY_COMMAND must authenticate run-owned bucket creation}"
  test -x "${DR_OBJECT_FAILED_RESTORE_CLEANUP_COMMAND}" && test -x "${DR_OBJECT_ABSENCE_VERIFY_COMMAND}" && \
    test -x "${DR_OBJECT_BUCKET_OWNERSHIP_VERIFY_COMMAND}" || {
    echo 'Production object ownership, cleanup, and absence verification commands must be executable' >&2
    exit 1
  }
  ownership_verifier_sha256="$(dr_sha256 "${DR_OBJECT_BUCKET_OWNERSHIP_VERIFY_COMMAND}")"
fi

if [ "${s3_auth_mode}" = workload-identity ]; then
  export MC_CONFIG_DIR="${workdir}/mc-config"
  export MC_ALIAS_NAME=tixkit-restore
  export MC_ENDPOINT="${S3_ENDPOINT}"
  DR_HOOK_S3=1 dr_run_isolated_hook "${S3_CREDENTIAL_SETUP_COMMAND}"
  assert_inventory_unchanged
  if test -n "${S3_UPLOAD_COMMAND:-}"; then
    test -x "${S3_UPLOAD_COMMAND}" || { echo 'S3_UPLOAD_COMMAND must be executable' >&2; exit 1; }
    export DR_OBJECT_TRANSFER_DIRECTORY="${workdir}/${S3_BUCKET}"
    export DR_OBJECT_TRANSFER_BUCKET="${RESTORE_S3_BUCKET}"
    DR_HOOK_S3=1 DR_HOOK_OBJECT_OWNERSHIP=1 dr_run_isolated_hook "${S3_UPLOAD_COMMAND}"
    assert_inventory_unchanged
    if test "${DR_PRODUCTION_BUNDLE:-0}" = 1; then establish_object_bucket_ownership; fi
  else
    mc mb "${MC_ALIAS_NAME}/${RESTORE_S3_BUCKET}" >&2
    if test "${DR_PRODUCTION_BUNDLE:-0}" = 1; then
      OWNERSHIP_FILE="${ownership_file}" ENDPOINT="${S3_ENDPOINT}" BUCKET="${RESTORE_S3_BUCKET}" \
        RUN_ID="${restore_run_id}" node <<'NODE'
const { writeFileSync } = require('node:fs');
writeFileSync(process.env.OWNERSHIP_FILE, JSON.stringify({
  schemaVersion: 1, endpoint: process.env.ENDPOINT, bucket: process.env.BUCKET,
  restoreRunId: process.env.RUN_ID, created: true,
}), { flag: 'wx', mode: 0o600 });
NODE
      establish_object_bucket_ownership
    else
      remote_started=1
    fi
    mc mirror --overwrite --remove "${workdir}/${S3_BUCKET}" "${MC_ALIAS_NAME}/${RESTORE_S3_BUCKET}" >&2
    reconciliation="$(mc diff "${workdir}/${S3_BUCKET}" "${MC_ALIAS_NAME}/${RESTORE_S3_BUCKET}")"
    test -z "${reconciliation}" || { printf 'Object restore reconciliation failed:\n%s\n' "${reconciliation}" >&2; exit 1; }
  fi
elif command -v mc >/dev/null 2>&1; then
  MC_CONFIG_DIR="${workdir}/mc-config" mc alias set tixkit-restore "${S3_ENDPOINT}" "${S3_ACCESS_KEY_ID}" "${S3_SECRET_ACCESS_KEY}" >/dev/null
  MC_CONFIG_DIR="${workdir}/mc-config" mc mb "tixkit-restore/${RESTORE_S3_BUCKET}" >&2
  remote_started=1
  MC_CONFIG_DIR="${workdir}/mc-config" mc mirror --overwrite --remove "${workdir}/${S3_BUCKET}" "tixkit-restore/${RESTORE_S3_BUCKET}" >&2
  reconciliation="$(MC_CONFIG_DIR="${workdir}/mc-config" mc diff "${workdir}/${S3_BUCKET}" "tixkit-restore/${RESTORE_S3_BUCKET}")"
  test -z "${reconciliation}" || { printf 'Object restore reconciliation failed:\n%s\n' "${reconciliation}" >&2; exit 1; }
else
  docker run --rm \
    --entrypoint /bin/sh \
    -v "${workdir}:/backup" \
    --env S3_ENDPOINT="${docker_endpoint}" --env S3_ACCESS_KEY_ID --env S3_SECRET_ACCESS_KEY --env RESTORE_S3_BUCKET --env S3_BUCKET \
    "${minio_mc_image}" \
    -c 'export MC_CONFIG_DIR=/tmp/mc; mc alias set tixkit-restore "$S3_ENDPOINT" "$S3_ACCESS_KEY_ID" "$S3_SECRET_ACCESS_KEY" >/dev/null && mc mb "tixkit-restore/$RESTORE_S3_BUCKET" && mc mirror --overwrite --remove "/backup/$S3_BUCKET" "tixkit-restore/$RESTORE_S3_BUCKET" && test -z "$(mc diff "/backup/$S3_BUCKET" "tixkit-restore/$RESTORE_S3_BUCKET")"' >&2
  remote_started=1
fi
if test "${DR_PRODUCTION_BUNDLE:-0}" = 1; then
  : "${DR_OBJECT_METADATA_RESTORE_COMMAND:?DR_OBJECT_METADATA_RESTORE_COMMAND must restore Production object metadata}"
  : "${DR_OBJECT_INVENTORY_VERIFY_COMMAND:?DR_OBJECT_INVENTORY_VERIFY_COMMAND must verify the restored Production inventory}"
  test -x "${DR_OBJECT_METADATA_RESTORE_COMMAND}" && test -x "${DR_OBJECT_INVENTORY_VERIFY_COMMAND}" || {
    echo 'Production object metadata restore and inventory verification commands must be executable' >&2
    exit 1
  }
  export DR_OBJECT_EXPECTED_INVENTORY_SHA256="${inventory_sha256}"
  export DR_OBJECT_RECONCILIATION_FILE="${workdir}/remote-reconciliation.json"
  DR_HOOK_S3=1 dr_run_isolated_hook "${DR_OBJECT_METADATA_RESTORE_COMMAND}"
  assert_inventory_unchanged
  reconciliation_verifier_sha256="$(dr_sha256 "${DR_OBJECT_INVENTORY_VERIFY_COMMAND}")"
  reconciliation_json="$(DR_HOOK_S3=1 DR_HOOK_OBJECT_RECONCILIATION=1 dr_run_isolated_hook "${DR_OBJECT_INVENTORY_VERIFY_COMMAND}")"
  test "$(dr_sha256 "${DR_OBJECT_INVENTORY_VERIFY_COMMAND}")" = "${reconciliation_verifier_sha256}" || {
    echo 'Object reconciliation verifier changed during execution' >&2
    exit 1
  }
  assert_inventory_unchanged
  RECONCILIATION_FILE="${DR_OBJECT_RECONCILIATION_FILE}" RECONCILIATION_JSON="${reconciliation_json}" \
    EXPECTED_SHA="${inventory_sha256}" VERIFIER_SHA="${reconciliation_verifier_sha256}" node <<'NODE'
const { writeFileSync } = require('node:fs');
const evidence = JSON.parse(process.env.RECONCILIATION_JSON);
if (evidence.verified !== true || evidence.inventorySha256 !== process.env.EXPECTED_SHA) {
  throw new Error('Object reconciliation evidence does not bind the signed inventory');
}
writeFileSync(process.env.RECONCILIATION_FILE, JSON.stringify({ ...evidence, verifierSha256: process.env.VERIFIER_SHA }), {
  flag: 'wx', mode: 0o600,
});
NODE
fi
dr_run_restore_verifier object-storage
assert_inventory_unchanged
if test "${DR_PRODUCTION_BUNDLE:-0}" = 1; then
  export DR_RESTORE_ADAPTER_COMMANDS="${S3_CREDENTIAL_SETUP_COMMAND},${S3_UPLOAD_COMMAND:-},${DR_OBJECT_BUCKET_OWNERSHIP_VERIFY_COMMAND},${DR_OBJECT_METADATA_RESTORE_COMMAND},${DR_OBJECT_INVENTORY_VERIFY_COMMAND}"
  export DR_RESTORE_ADAPTER_EVIDENCE_FILES="${ownership_file},${DR_OBJECT_RECONCILIATION_FILE}"
fi
dr_record_restore_evidence "${OBJECT_STORAGE_BACKUP_FILE}" object-storage "${started_epoch}"
restore_verified=1
