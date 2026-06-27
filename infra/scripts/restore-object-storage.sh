#!/usr/bin/env bash
set -euo pipefail

: "${S3_ENDPOINT:?S3_ENDPOINT is required}"
: "${S3_BUCKET:?S3_BUCKET is required}"
: "${S3_ACCESS_KEY_ID:?S3_ACCESS_KEY_ID is required}"
: "${S3_SECRET_ACCESS_KEY:?S3_SECRET_ACCESS_KEY is required}"
: "${OBJECT_STORAGE_BACKUP_FILE:?OBJECT_STORAGE_BACKUP_FILE points to a tar.gz object-storage backup}"

if [ ! -f "${OBJECT_STORAGE_BACKUP_FILE}" ]; then
  echo "Backup file not found: ${OBJECT_STORAGE_BACKUP_FILE}" >&2
  exit 1
fi

if [ -f "${OBJECT_STORAGE_BACKUP_FILE}.sha256" ]; then
  sha256sum --check "${OBJECT_STORAGE_BACKUP_FILE}.sha256"
fi

workdir="$(mktemp -d)"
docker_endpoint="${S3_ENDPOINT/localhost/host.docker.internal}"
docker_endpoint="${docker_endpoint/127.0.0.1/host.docker.internal}"
cleanup() {
  rm -rf "${workdir}"
}
trap cleanup EXIT

tar -C "${workdir}" -xzf "${OBJECT_STORAGE_BACKUP_FILE}"

if command -v mc >/dev/null 2>&1; then
  mc alias set tixkit-restore "${S3_ENDPOINT}" "${S3_ACCESS_KEY_ID}" "${S3_SECRET_ACCESS_KEY}" >/dev/null
  mc mb --ignore-existing "tixkit-restore/${S3_BUCKET}" >&2
  mc mirror --overwrite "${workdir}/${S3_BUCKET}" "tixkit-restore/${S3_BUCKET}" >&2
else
  docker run --rm \
    --entrypoint /bin/sh \
    -v "${workdir}:/backup" \
    minio/mc:latest \
    -c "mc alias set tixkit-restore '${docker_endpoint}' '${S3_ACCESS_KEY_ID}' '${S3_SECRET_ACCESS_KEY}' >/dev/null && mc mb --ignore-existing tixkit-restore/${S3_BUCKET} && mc mirror --overwrite /backup/${S3_BUCKET} tixkit-restore/${S3_BUCKET}" >&2
fi
