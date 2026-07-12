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
dr_require_backup_policy

backup_dir="${BACKUP_DIR:-backups/object-storage}"
timestamp="${BACKUP_TIMESTAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
output="${backup_dir}/tixkit-object-storage-${timestamp}.tar.gz"
recovery_point_at="${DR_RECOVERY_POINT_AT:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
minio_mc_image="${MINIO_MC_IMAGE:-minio/mc:RELEASE.2025-08-13T08-35-41Z@sha256:a7fe349ef4bd8521fb8497f55c6042871b2ae640607cf99d9bede5e9bdf11727}"
workdir="$(mktemp -d)"
docker_endpoint="${S3_ENDPOINT/localhost/host.docker.internal}"
docker_endpoint="${docker_endpoint/127.0.0.1/host.docker.internal}"

cleanup() {
  rm -rf "${workdir}"
}
trap cleanup EXIT

mkdir -p "${backup_dir}"

if [ "${s3_auth_mode}" = workload-identity ]; then
  export MC_CONFIG_DIR="${workdir}/mc-config"
  export MC_ALIAS_NAME=tixkit-backup
  export MC_ENDPOINT="${S3_ENDPOINT}"
  "${S3_CREDENTIAL_SETUP_COMMAND}"
  mc mirror "${MC_ALIAS_NAME}/${S3_BUCKET}" "${workdir}/${S3_BUCKET}" >&2
elif command -v mc >/dev/null 2>&1; then
  MC_CONFIG_DIR="${workdir}/mc-config" mc alias set tixkit-backup "${S3_ENDPOINT}" "${S3_ACCESS_KEY_ID}" "${S3_SECRET_ACCESS_KEY}" >/dev/null
  MC_CONFIG_DIR="${workdir}/mc-config" mc mirror "tixkit-backup/${S3_BUCKET}" "${workdir}/${S3_BUCKET}" >&2
else
  docker run --rm \
    --entrypoint /bin/sh \
    -v "${workdir}:/backup" \
    --env S3_ENDPOINT="${docker_endpoint}" --env S3_ACCESS_KEY_ID --env S3_SECRET_ACCESS_KEY --env S3_BUCKET \
    "${minio_mc_image}" \
    -c 'export MC_CONFIG_DIR=/tmp/mc; mc alias set tixkit-backup "$S3_ENDPOINT" "$S3_ACCESS_KEY_ID" "$S3_SECRET_ACCESS_KEY" >/dev/null && mc mirror "tixkit-backup/$S3_BUCKET" "/backup/$S3_BUCKET"' >&2
fi

COPYFILE_DISABLE=1 tar -C "${workdir}" -czf "${output}" "${S3_BUCKET}"
dr_write_checksum "${output}"
dr_write_backup_manifest "${output}" object-storage "${recovery_point_at}"
printf '%s\n' "${output}"
