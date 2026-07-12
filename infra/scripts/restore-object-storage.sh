#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib/dr-common.sh"

: "${S3_ENDPOINT:?S3_ENDPOINT is required}"
: "${S3_BUCKET:?S3_BUCKET is required}"
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
: "${OBJECT_STORAGE_BACKUP_FILE:?OBJECT_STORAGE_BACKUP_FILE points to a tar.gz object-storage backup}"
: "${RESTORE_S3_BUCKET:?RESTORE_S3_BUCKET must be a new isolated destination bucket}"
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

minio_mc_image="${MINIO_MC_IMAGE:-minio/mc:RELEASE.2025-08-13T08-35-41Z@sha256:a7fe349ef4bd8521fb8497f55c6042871b2ae640607cf99d9bede5e9bdf11727}"
workdir="$(mktemp -d)"
docker_endpoint="${S3_ENDPOINT/localhost/host.docker.internal}"
docker_endpoint="${docker_endpoint/127.0.0.1/host.docker.internal}"
cleanup() {
  rm -rf "${workdir}"
}
trap cleanup EXIT

ARCHIVE="${OBJECT_STORAGE_BACKUP_FILE}" DESTINATION="${workdir}" MAX_BYTES="${OBJECT_RESTORE_MAX_BYTES:-107374182400}" python3 <<'PY'
import os, pathlib, tarfile
archive = os.environ['ARCHIVE']
destination = pathlib.Path(os.environ['DESTINATION']).resolve()
maximum = int(os.environ['MAX_BYTES'])
seen = set()
total = 0
with tarfile.open(archive, 'r:gz') as tf:
    members = tf.getmembers()
    for member in members:
        path = pathlib.PurePosixPath(member.name)
        if path.is_absolute() or '..' in path.parts or member.name in seen:
            raise SystemExit(f'Unsafe or duplicate archive path: {member.name}')
        if not (member.isfile() or member.isdir()):
            raise SystemExit(f'Unsupported archive entry type: {member.name}')
        seen.add(member.name)
        total += member.size
        if total > maximum:
            raise SystemExit('Archive exceeds OBJECT_RESTORE_MAX_BYTES')
    tf.extractall(destination, members=members)
PY

if [ "${s3_auth_mode}" = workload-identity ]; then
  export MC_CONFIG_DIR="${workdir}/mc-config"
  export MC_ALIAS_NAME=tixkit-restore
  export MC_ENDPOINT="${S3_ENDPOINT}"
  "${S3_CREDENTIAL_SETUP_COMMAND}"
  mc mb "${MC_ALIAS_NAME}/${RESTORE_S3_BUCKET}" >&2
  mc mirror --overwrite --remove "${workdir}/${S3_BUCKET}" "${MC_ALIAS_NAME}/${RESTORE_S3_BUCKET}" >&2
  reconciliation="$(mc diff "${workdir}/${S3_BUCKET}" "${MC_ALIAS_NAME}/${RESTORE_S3_BUCKET}")"
  test -z "${reconciliation}" || { printf 'Object restore reconciliation failed:\n%s\n' "${reconciliation}" >&2; exit 1; }
elif command -v mc >/dev/null 2>&1; then
  MC_CONFIG_DIR="${workdir}/mc-config" mc alias set tixkit-restore "${S3_ENDPOINT}" "${S3_ACCESS_KEY_ID}" "${S3_SECRET_ACCESS_KEY}" >/dev/null
  MC_CONFIG_DIR="${workdir}/mc-config" mc mb "tixkit-restore/${RESTORE_S3_BUCKET}" >&2
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
fi
dr_run_restore_verifier object-storage
dr_record_restore_evidence "${OBJECT_STORAGE_BACKUP_FILE}" object-storage "${started_epoch}"
