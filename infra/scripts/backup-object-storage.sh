#!/usr/bin/env bash
set -euo pipefail
umask 077
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
  echo 'Production bundle backup requires S3_AUTH_MODE=workload-identity' >&2
  exit 1
fi
dr_require_backup_policy

backup_dir="${BACKUP_DIR:-backups/object-storage}"
timestamp="${BACKUP_TIMESTAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
output="${backup_dir}/tixkit-object-storage-${timestamp}.tar.gz"
recovery_point_at="${DR_RECOVERY_POINT_AT:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
minio_mc_image="${MINIO_MC_IMAGE:-minio/mc:RELEASE.2025-08-13T08-35-41Z@sha256:a7fe349ef4bd8521fb8497f55c6042871b2ae640607cf99d9bede5e9bdf11727}"
dr_prepare_output_directory "${backup_dir}"
dr_assert_output_path_available "${output}"
dr_assert_output_path_available "${output}.sha256"
dr_assert_output_path_available "${output}.manifest.json"
staged="$(mktemp "${backup_dir}/.tixkit-object-storage.XXXXXX")"
workdir="$(mktemp -d)"
docker_endpoint="${S3_ENDPOINT/localhost/host.docker.internal}"
docker_endpoint="${docker_endpoint/127.0.0.1/host.docker.internal}"

cleanup() {
  rm -f "${staged}"
  rm -rf "${workdir}"
  if test "${complete}" = 0; then
    test "${manifest_created}" = 0 || rm -f "${output}.manifest.json"
    test "${checksum_created}" = 0 || rm -f "${output}.sha256"
    test "${output_created}" = 0 || dr_remove_file_if_identity "${output}" "${output_identity}"
  fi
}
trap cleanup EXIT
output_created=0
output_identity=''
checksum_created=0
manifest_created=0
complete=0

if [ "${s3_auth_mode}" = workload-identity ]; then
  export MC_CONFIG_DIR="${workdir}/mc-config"
  export MC_ALIAS_NAME=tixkit-backup
  export MC_ENDPOINT="${S3_ENDPOINT}"
  DR_HOOK_S3=1 dr_run_isolated_hook "${S3_CREDENTIAL_SETUP_COMMAND}"
  if test -n "${S3_DOWNLOAD_COMMAND:-}"; then
    test -x "${S3_DOWNLOAD_COMMAND}" || { echo 'S3_DOWNLOAD_COMMAND must be executable' >&2; exit 1; }
    export DR_OBJECT_TRANSFER_DIRECTORY="${workdir}/${S3_BUCKET}"
    export DR_OBJECT_TRANSFER_BUCKET="${S3_BUCKET}"
    mkdir "${DR_OBJECT_TRANSFER_DIRECTORY}"
    DR_HOOK_S3=1 dr_run_isolated_hook "${S3_DOWNLOAD_COMMAND}"
  else
    mc mirror "${MC_ALIAS_NAME}/${S3_BUCKET}" "${workdir}/${S3_BUCKET}" >&2
  fi
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

metadata_file=''
if test "${DR_PRODUCTION_BUNDLE:-0}" = 1; then
  : "${DR_OBJECT_METADATA_EXPORT_COMMAND:?DR_OBJECT_METADATA_EXPORT_COMMAND must export Production object metadata}"
  test -x "${DR_OBJECT_METADATA_EXPORT_COMMAND}" || {
    echo 'DR_OBJECT_METADATA_EXPORT_COMMAND must be executable' >&2
    exit 1
  }
  metadata_file="${workdir}/object-metadata-export.json"
  export DR_OBJECT_METADATA_FILE="${metadata_file}"
  DR_HOOK_S3=1 dr_run_isolated_hook "${DR_OBJECT_METADATA_EXPORT_COMMAND}"
  test -f "${metadata_file}" && test ! -L "${metadata_file}" || {
    echo 'Production object metadata export was not created safely' >&2
    exit 1
  }
fi
inventory="${workdir}/object-inventory.json"
dr_write_object_inventory "${workdir}/${S3_BUCKET}" "${S3_BUCKET}" "${metadata_file}" "${inventory}"
rm -f "${metadata_file}"
COPYFILE_DISABLE=1 tar -C "${workdir}" -czf "${staged}" object-inventory.json "${S3_BUCKET}"
dr_publish_staged_file "${staged}" "${output}"
staged=''
output_created=1
output_identity="$(dr_file_identity "${output}")"
dr_assert_file_identity "${output}" "${output_identity}"
dr_write_checksum "${output}"
checksum_created=1
dr_assert_file_identity "${output}" "${output_identity}"
dr_write_backup_manifest "${output}" object-storage "${recovery_point_at}"
manifest_created=1
complete=1
printf '%s\n' "${output}"
