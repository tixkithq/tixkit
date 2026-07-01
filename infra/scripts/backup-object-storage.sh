#!/usr/bin/env bash
set -euo pipefail

: "${S3_ENDPOINT:?S3_ENDPOINT is required}"
: "${S3_BUCKET:?S3_BUCKET is required}"
: "${S3_ACCESS_KEY_ID:?S3_ACCESS_KEY_ID is required}"
: "${S3_SECRET_ACCESS_KEY:?S3_SECRET_ACCESS_KEY is required}"

backup_dir="${BACKUP_DIR:-backups/object-storage}"
timestamp="${BACKUP_TIMESTAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
output="${backup_dir}/tixkit-object-storage-${timestamp}.tar.gz"
minio_mc_image="${MINIO_MC_IMAGE:-minio/mc:RELEASE.2025-08-13T08-35-41Z@sha256:a7fe349ef4bd8521fb8497f55c6042871b2ae640607cf99d9bede5e9bdf11727}"
workdir="$(mktemp -d)"
docker_endpoint="${S3_ENDPOINT/localhost/host.docker.internal}"
docker_endpoint="${docker_endpoint/127.0.0.1/host.docker.internal}"

cleanup() {
  rm -rf "${workdir}"
}
trap cleanup EXIT

mkdir -p "${backup_dir}"

if command -v mc >/dev/null 2>&1; then
  mc alias set tixkit-backup "${S3_ENDPOINT}" "${S3_ACCESS_KEY_ID}" "${S3_SECRET_ACCESS_KEY}" >/dev/null
  mc mirror "tixkit-backup/${S3_BUCKET}" "${workdir}/${S3_BUCKET}" >&2
else
  docker run --rm \
    --entrypoint /bin/sh \
    -v "${workdir}:/backup" \
    "${minio_mc_image}" \
    -c "mc alias set tixkit-backup '${docker_endpoint}' '${S3_ACCESS_KEY_ID}' '${S3_SECRET_ACCESS_KEY}' >/dev/null && mc mirror tixkit-backup/${S3_BUCKET} /backup/${S3_BUCKET}" >&2
fi

tar -C "${workdir}" -czf "${output}" "${S3_BUCKET}"
sha256sum "${output}" > "${output}.sha256"
printf '%s\n' "${output}"
