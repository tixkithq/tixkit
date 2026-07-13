#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib/dr-common.sh"

: "${PRODUCTION_BUNDLE_FILE:?PRODUCTION_BUNDLE_FILE is required after independent retrieval/decryption}"
: "${DB_DRIVER:?DB_DRIVER must be postgres or mysql}"
: "${DR_TEMPORAL_RESTORE_COMMAND:?DR_TEMPORAL_RESTORE_COMMAND is required}"
: "${DR_TEMPORAL_EVIDENCE_VERIFY_COMMAND:?DR_TEMPORAL_EVIDENCE_VERIFY_COMMAND is required}"
: "${DR_FINAL_VERIFY_COMMAND:?DR_FINAL_VERIFY_COMMAND is required}"
: "${DR_DATABASE_TARGET_ID:?DR_DATABASE_TARGET_ID must be an opaque non-secret identifier}"
: "${DR_OBJECT_TARGET_ID:?DR_OBJECT_TARGET_ID must be an opaque non-secret identifier}"
: "${DR_PRODUCTION_TARGET_ID:?DR_PRODUCTION_TARGET_ID must identify the combined restored environment}"
: "${DR_EVIDENCE_DIR:?DR_EVIDENCE_DIR is required}"
: "${DR_INCIDENT_AT:?DR_INCIDENT_AT is required}"
: "${DR_TARGET_RELEASE:?DR_TARGET_RELEASE is required}"
test -x "${DR_TEMPORAL_RESTORE_COMMAND}" || { echo 'DR_TEMPORAL_RESTORE_COMMAND is not executable' >&2; exit 1; }
test -x "${DR_TEMPORAL_EVIDENCE_VERIFY_COMMAND}" || { echo 'DR_TEMPORAL_EVIDENCE_VERIFY_COMMAND is not executable' >&2; exit 1; }
test -x "${DR_FINAL_VERIFY_COMMAND}" || { echo 'DR_FINAL_VERIFY_COMMAND is not executable' >&2; exit 1; }
started_epoch="$(date +%s)"

dr_verify_checksum "${PRODUCTION_BUNDLE_FILE}"
DR_ALLOW_ARTIFACT_RENAME=1 dr_verify_backup_manifest "${PRODUCTION_BUNDLE_FILE}" production-bundle
workdir="$(mktemp -d)"
cleanup() { rm -rf "${workdir}"; }
trap cleanup EXIT

ARCHIVE="${PRODUCTION_BUNDLE_FILE}" DESTINATION="${workdir}" DB_DRIVER="${DB_DRIVER}" MAX_BYTES="${PRODUCTION_RESTORE_MAX_BYTES:-536870912000}" MAX_MEMBERS="${PRODUCTION_RESTORE_MAX_MEMBERS:-1000000}" python3 <<'PY'
import os, pathlib, re, tarfile
destination = pathlib.Path(os.environ['DESTINATION']).resolve()
seen = set()
total = 0
database_pattern = r'tixkit-postgres-[A-Za-z0-9._-]+\.dump' if os.environ['DB_DRIVER'] == 'postgres' else r'tixkit-mysql-[A-Za-z0-9._-]+\.sql\.gz'
allowed_fixed = {'temporal-checkpoint.json', 'redis-recovery-boundary.txt', 'postgres-globals-reference.txt' if os.environ['DB_DRIVER'] == 'postgres' else 'mysql-grants-reference.txt'}
def canonical_file(name):
    return name in allowed_fixed or re.fullmatch(database_pattern + r'(?:\.manifest\.json|\.sha256)?', name) or re.fullmatch(r'tixkit-object-storage-[A-Za-z0-9._-]+\.tar\.gz(?:\.manifest\.json|\.sha256)?', name)
with tarfile.open(os.environ['ARCHIVE'], 'r:gz') as tf:
    members = tf.getmembers()
    if len(members) > int(os.environ['MAX_MEMBERS']): raise SystemExit('Production bundle exceeds member limit')
    for member in members:
        path = pathlib.PurePosixPath(member.name)
        normalized = member.name.removeprefix('./')
        if path.is_absolute() or '..' in path.parts or normalized in seen or not (member.isfile() or member.isdir()):
            raise SystemExit(f'Unsafe production bundle entry: {member.name}')
        if member.isdir():
            if normalized not in ('', '.'): raise SystemExit(f'Non-canonical production bundle entry: {member.name}')
        elif '/' in normalized or not canonical_file(normalized):
            raise SystemExit(f'Non-canonical production bundle entry: {member.name}')
        seen.add(normalized)
        total += member.size
        if total > int(os.environ['MAX_BYTES']): raise SystemExit('Production bundle exceeds expansion limit')
    tf.extractall(destination, members=members)
PY

mapfile_compatible() {
  local pattern="$1"
  find "${workdir}" -maxdepth 1 -type f -name "${pattern}" -print
}
db_pattern='tixkit-postgres-*.dump'
db_kind=postgres
if [ "${DB_DRIVER}" = mysql ]; then db_pattern='tixkit-mysql-*.sql.gz'; db_kind=mysql; fi
db_artifacts=( $(mapfile_compatible "${db_pattern}") )
object_artifacts=( $(mapfile_compatible 'tixkit-object-storage-*.tar.gz') )
test "${#db_artifacts[@]}" = 1 || { echo 'Production bundle must contain exactly one selected database artifact' >&2; exit 1; }
test "${#object_artifacts[@]}" = 1 || { echo 'Production bundle must contain exactly one object artifact' >&2; exit 1; }
test -f "${workdir}/temporal-checkpoint.json" || { echo 'Temporal checkpoint metadata is missing' >&2; exit 1; }
file_count="$(find "${workdir}" -maxdepth 1 -type f | wc -l | tr -d ' ')"
if [ "${file_count}" != 9 ]; then
  printf 'Production bundle contains a missing or extra artifact (expected 9 files, found %s)\n' "${file_count}" >&2
  find "${workdir}" -maxdepth 1 -type f -exec basename {} \; | LC_ALL=C sort >&2
  exit 1
fi
if [ "${DB_DRIVER}" = postgres ]; then
  test -f "${workdir}/postgres-globals-reference.txt" || { echo 'Postgres globals reference is missing' >&2; exit 1; }
else
  test -f "${workdir}/mysql-grants-reference.txt" || { echo 'MySQL grants reference is missing' >&2; exit 1; }
fi
test -f "${workdir}/redis-recovery-boundary.txt" || { echo 'Redis recovery boundary is missing' >&2; exit 1; }

dr_verify_checksum "${db_artifacts[0]}"
dr_verify_backup_manifest "${db_artifacts[0]}" "${db_kind}"
dr_verify_checksum "${object_artifacts[0]}"
dr_verify_backup_manifest "${object_artifacts[0]}" object-storage
BUNDLE_MANIFEST="${PRODUCTION_BUNDLE_FILE}.manifest.json" DB_MANIFEST="${db_artifacts[0]}.manifest.json" OBJECT_MANIFEST="${object_artifacts[0]}.manifest.json" CHECKPOINT="${workdir}/temporal-checkpoint.json" node <<'NODE'
const { readFileSync } = require('node:fs');
const manifests = [process.env.BUNDLE_MANIFEST, process.env.DB_MANIFEST, process.env.OBJECT_MANIFEST].map((file) => JSON.parse(readFileSync(file, 'utf8')));
if (new Set(manifests.map((value) => value.recoveryPointAt)).size !== 1) throw new Error('Production bundle recovery points do not match');
if (new Set(manifests.map((value) => value.sourceRelease)).size !== 1) throw new Error('Production bundle source releases do not match');
const checkpoint = JSON.parse(readFileSync(process.env.CHECKPOINT, 'utf8'));
if (checkpoint.recoveryPointAt !== manifests[0].recoveryPointAt || checkpoint.verified !== true || !checkpoint.immutableId || !checkpoint.namespace) throw new Error('Temporal checkpoint does not match the production recovery point');
NODE

if test -e "${DR_EVIDENCE_DIR}" || test -L "${DR_EVIDENCE_DIR}"; then
  echo 'DR_EVIDENCE_DIR must be a new path for each production restore' >&2
  exit 1
fi
(umask 077; mkdir "${DR_EVIDENCE_DIR}")
for evidence_name in database.json object-storage.json temporal.json production.json; do
  test ! -e "${DR_EVIDENCE_DIR}/${evidence_name}" && test ! -L "${DR_EVIDENCE_DIR}/${evidence_name}" || {
    printf 'Refusing existing production restore evidence path: %s\n' "${DR_EVIDENCE_DIR}/${evidence_name}" >&2
    exit 1
  }
done
if [ "${DB_DRIVER}" = postgres ]; then
  : "${DATABASE_URL:?DATABASE_URL must point to the isolated restored Postgres target}"
  : "${DR_DATABASE_VERIFY_COMMAND:?DR_DATABASE_VERIFY_COMMAND is required}"
  DATABASE_URL="${DATABASE_URL}" POSTGRES_BACKUP_FILE="${db_artifacts[0]}" DR_ISOLATED_TARGET=1 \
    DR_VERIFY_COMMAND="${DR_DATABASE_VERIFY_COMMAND}" DR_RESTORE_TARGET_ID="${DR_DATABASE_TARGET_ID}" \
    DR_EVIDENCE_FILE="${DR_EVIDENCE_DIR}/database.json" "$(dirname "$0")/restore-postgres.sh"
else
  : "${DATABASE_URL_MYSQL:?DATABASE_URL_MYSQL must point to the isolated restored MySQL target}"
  : "${DR_DATABASE_VERIFY_COMMAND:?DR_DATABASE_VERIFY_COMMAND is required}"
  DR_PRODUCTION_BUNDLE=1 DATABASE_URL_MYSQL="${DATABASE_URL_MYSQL}" MYSQL_BACKUP_FILE="${db_artifacts[0]}" DR_ISOLATED_TARGET=1 \
    DR_VERIFY_COMMAND="${DR_DATABASE_VERIFY_COMMAND}" DR_RESTORE_TARGET_ID="${DR_DATABASE_TARGET_ID}" \
    DR_EVIDENCE_FILE="${DR_EVIDENCE_DIR}/database.json" "$(dirname "$0")/restore-mysql.sh"
fi

: "${RESTORE_S3_BUCKET:?RESTORE_S3_BUCKET is required}"
: "${DR_OBJECT_VERIFY_COMMAND:?DR_OBJECT_VERIFY_COMMAND is required}"
DR_PRODUCTION_BUNDLE=1 OBJECT_STORAGE_BACKUP_FILE="${object_artifacts[0]}" DR_ISOLATED_TARGET=1 \
  DR_VERIFY_COMMAND="${DR_OBJECT_VERIFY_COMMAND}" DR_RESTORE_TARGET_ID="${DR_OBJECT_TARGET_ID}" \
  DR_EVIDENCE_FILE="${DR_EVIDENCE_DIR}/object-storage.json" "$(dirname "$0")/restore-object-storage.sh"

export DR_TEMPORAL_CHECKPOINT_FILE="${workdir}/temporal-checkpoint.json"
export DR_TEMPORAL_RESTORE_EVIDENCE="${DR_EVIDENCE_DIR}/temporal.json"
dr_run_isolated_hook "${DR_TEMPORAL_RESTORE_COMMAND}"
export DR_TEMPORAL_EVIDENCE_FILE="${DR_TEMPORAL_RESTORE_EVIDENCE}"
dr_run_isolated_hook "${DR_TEMPORAL_EVIDENCE_VERIFY_COMMAND}"
TEMPORAL_EVIDENCE="${DR_TEMPORAL_RESTORE_EVIDENCE}" CHECKPOINT="${DR_TEMPORAL_CHECKPOINT_FILE}" node <<'NODE'
const { readFileSync } = require('node:fs');
const evidence = JSON.parse(readFileSync(process.env.TEMPORAL_EVIDENCE, 'utf8'));
const checkpoint = JSON.parse(readFileSync(process.env.CHECKPOINT, 'utf8'));
if (evidence.verified !== true || evidence.immutableId !== checkpoint.immutableId || evidence.namespace !== checkpoint.namespace || evidence.recoveryPointAt !== checkpoint.recoveryPointAt) throw new Error('Temporal restore verification failed');
NODE
export DR_TEMPORAL_EVIDENCE_SHA256="$(dr_sha256 "${DR_TEMPORAL_RESTORE_EVIDENCE}")"
export DR_VERIFY_COMMAND="${DR_FINAL_VERIFY_COMMAND}"
export DR_EVIDENCE_FILE="${DR_EVIDENCE_DIR}/production.json"
dr_reserve_restore_evidence
dr_run_restore_verifier production-bundle
export DR_RESTORE_COMPONENT_FILES="${DR_EVIDENCE_DIR}/database.json,${DR_EVIDENCE_DIR}/object-storage.json,${DR_EVIDENCE_DIR}/temporal.json"
export DR_RESTORE_DATABASE_MANIFEST="${db_artifacts[0]}.manifest.json"
export DR_RESTORE_OBJECT_MANIFEST="${object_artifacts[0]}.manifest.json"
export DR_EXPECTED_DATABASE_TARGET_ID="${DR_DATABASE_TARGET_ID}"
export DR_EXPECTED_OBJECT_TARGET_ID="${DR_OBJECT_TARGET_ID}"
export DR_RESTORE_TARGET_ID="${DR_PRODUCTION_TARGET_ID}"
dr_record_restore_evidence "${PRODUCTION_BUNDLE_FILE}" production-bundle "${started_epoch}"
printf 'Production bundle restore verified; evidence: %s\n' "${DR_EVIDENCE_DIR}"
