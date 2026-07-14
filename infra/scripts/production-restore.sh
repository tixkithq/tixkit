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
: "${DR_PRODUCTION_RETRIEVAL_RECEIPT:?DR_PRODUCTION_RETRIEVAL_RECEIPT must be the independently authenticated publication receipt}"
: "${DR_BACKUP_RECEIPT_VERIFY_COMMAND:?DR_BACKUP_RECEIPT_VERIFY_COMMAND must independently authenticate the publication receipt and ciphertext}"
: "${DR_PRODUCTION_TARGET_RECEIPT:?DR_PRODUCTION_TARGET_RECEIPT must authenticate the complete isolated target triplet}"
: "${DR_PRODUCTION_TARGET_LEASE_COMMAND:?DR_PRODUCTION_TARGET_LEASE_COMMAND must atomically claim and hold the complete target triplet}"
: "${DR_PRODUCTION_TARGET_LEASE_VERIFY_COMMAND:?DR_PRODUCTION_TARGET_LEASE_VERIFY_COMMAND must independently authenticate the active outer lease}"
: "${DR_PRODUCTION_TARGET_CLAIM_COMPLETE_COMMAND:?DR_PRODUCTION_TARGET_CLAIM_COMPLETE_COMMAND must durably consume the outer target claim}"
: "${DR_PRODUCTION_TARGET_CLAIM_VERIFY_COMMAND:?DR_PRODUCTION_TARGET_CLAIM_VERIFY_COMMAND must authenticate provider completion state}"
: "${DR_PRODUCTION_TARGET_CLAIM_QUARANTINE_COMMAND:?DR_PRODUCTION_TARGET_CLAIM_QUARANTINE_COMMAND must quarantine an unfinished outer target claim}"
test -x "${DR_TEMPORAL_RESTORE_COMMAND}" || { echo 'DR_TEMPORAL_RESTORE_COMMAND is not executable' >&2; exit 1; }
test -x "${DR_TEMPORAL_EVIDENCE_VERIFY_COMMAND}" || { echo 'DR_TEMPORAL_EVIDENCE_VERIFY_COMMAND is not executable' >&2; exit 1; }
test -x "${DR_FINAL_VERIFY_COMMAND}" || { echo 'DR_FINAL_VERIFY_COMMAND is not executable' >&2; exit 1; }
test -x "${DR_BACKUP_RECEIPT_VERIFY_COMMAND}" || { echo 'DR_BACKUP_RECEIPT_VERIFY_COMMAND is not executable' >&2; exit 1; }
test -x "${DR_PRODUCTION_TARGET_LEASE_COMMAND}" && test -x "${DR_PRODUCTION_TARGET_LEASE_VERIFY_COMMAND}" || {
  echo 'Production target lease holder and verifier commands must be executable' >&2
  exit 1
}
test -x "${DR_PRODUCTION_TARGET_CLAIM_COMPLETE_COMMAND}" && test -x "${DR_PRODUCTION_TARGET_CLAIM_VERIFY_COMMAND}" && test -x "${DR_PRODUCTION_TARGET_CLAIM_QUARANTINE_COMMAND}" || {
  echo 'Production target claim completion, verifier, and quarantine commands must be executable' >&2
  exit 1
}
started_epoch="$(date +%s)"

production_restore_lease_pid=''
production_restore_lease_directory=''
production_restore_lease_identity=''
production_restore_lease_sha256=''
production_restore_lease_command_sha256=''
production_restore_lease_verifier_sha256=''
production_restore_lease_verification_json=''
production_restore_lease_verification_file=''
temporal_checkpoint_identity=''
temporal_checkpoint_sha256=''
publication_receipt_identity=''
publication_receipt_sha256=''
publication_receipt_verifier_sha256=''
production_claim_finalized=0
production_claim_started=0
production_target_claim_output=''
production_target_claim_status_file=''

production_restore_lease_holder_alive() {
  test -n "${production_restore_lease_pid}" && kill -0 "${production_restore_lease_pid}" 2>/dev/null &&
    ! ps -o stat= -p "${production_restore_lease_pid}" 2>/dev/null | grep -Eq '^[[:space:]]*Z'
}

dr_verify_checksum "${PRODUCTION_BUNDLE_FILE}"
DR_ALLOW_ARTIFACT_RENAME=1 dr_verify_backup_manifest "${PRODUCTION_BUNDLE_FILE}" production-bundle
workdir="$(mktemp -d)"
cleanup() {
  if test "${production_claim_started}" = 1 && test "${production_claim_finalized}" != 1 && production_restore_lease_holder_alive; then
    DR_HOOK_PRODUCTION_RESTORE_LEASE=1 dr_run_isolated_hook "${DR_PRODUCTION_TARGET_CLAIM_QUARANTINE_COMMAND}" >/dev/null 2>&1 || true
  fi
  if production_restore_lease_holder_alive; then
    kill -TERM "${production_restore_lease_pid}" 2>/dev/null || true
    wait "${production_restore_lease_pid}" 2>/dev/null || true
  fi
  test -z "${production_restore_lease_directory}" || rm -rf "${production_restore_lease_directory}"
  test -z "${production_target_claim_output}" || rm -f "${production_target_claim_output}"
  test -z "${production_target_claim_status_file}" || rm -f "${production_target_claim_status_file}"
  rm -rf "${workdir}"
}
trap cleanup EXIT

test -f "${DR_PRODUCTION_RETRIEVAL_RECEIPT}" && test ! -L "${DR_PRODUCTION_RETRIEVAL_RECEIPT}" || {
  echo 'DR_PRODUCTION_RETRIEVAL_RECEIPT must be a real file, not a symlink' >&2
  exit 1
}
publication_receipt_identity="$(dr_file_identity "${DR_PRODUCTION_RETRIEVAL_RECEIPT}")"
publication_receipt_sha256="$(dr_sha256 "${DR_PRODUCTION_RETRIEVAL_RECEIPT}")"
publication_receipt_verifier_sha256="$(dr_sha256 "${DR_BACKUP_RECEIPT_VERIFY_COMMAND}")"
export DR_RECEIPT_FILE="${DR_PRODUCTION_RETRIEVAL_RECEIPT}"
dr_run_isolated_hook "${DR_BACKUP_RECEIPT_VERIFY_COMMAND}"
test "$(dr_sha256 "${DR_BACKUP_RECEIPT_VERIFY_COMMAND}")" = "${publication_receipt_verifier_sha256}" || {
  echo 'Publication receipt verifier changed during execution' >&2
  exit 1
}
dr_assert_file_identity "${DR_PRODUCTION_RETRIEVAL_RECEIPT}" "${publication_receipt_identity}"
test "$(dr_sha256 "${DR_PRODUCTION_RETRIEVAL_RECEIPT}")" = "${publication_receipt_sha256}" || {
  echo 'Publication receipt changed during independent verification' >&2
  exit 1
}
export DR_PRODUCTION_BUNDLE_SHA256="$(dr_sha256 "${PRODUCTION_BUNDLE_FILE}")"
BUNDLE_SHA256="${DR_PRODUCTION_BUNDLE_SHA256}" RECEIPT="${DR_PRODUCTION_RETRIEVAL_RECEIPT}" node <<'NODE'
const { readFileSync } = require('node:fs');
const receipt = JSON.parse(readFileSync(process.env.RECEIPT, 'utf8'));
const retentionUntil = Date.parse(receipt.retentionUntil);
if (receipt.schemaVersion !== 1) throw new Error('Publication receipt schema is unsupported');
if (receipt.immutable !== true || !receipt.storageId) throw new Error('Publication receipt is not immutable provider evidence');
if (!receipt.ciphertextSha256 || receipt.ciphertextSha256 === receipt.plaintextSha256) throw new Error('Publication receipt does not bind distinct ciphertext');
if (receipt.plaintextSha256 !== process.env.BUNDLE_SHA256) throw new Error(`Publication receipt plaintext mismatch: expected ${process.env.BUNDLE_SHA256}, received ${receipt.plaintextSha256}`);
if (!Number.isFinite(retentionUntil) || retentionUntil <= Date.now()) throw new Error('Publication receipt retention is invalid or expired');
NODE

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
export DR_TEMPORAL_CHECKPOINT_FILE="${workdir}/temporal-checkpoint.json"
chmod 0400 "${DR_TEMPORAL_CHECKPOINT_FILE}"
temporal_checkpoint_identity="$(dr_file_identity "${DR_TEMPORAL_CHECKPOINT_FILE}")"
temporal_checkpoint_sha256="$(dr_sha256 "${DR_TEMPORAL_CHECKPOINT_FILE}")"

test -f "${DR_PRODUCTION_TARGET_RECEIPT}" && test ! -L "${DR_PRODUCTION_TARGET_RECEIPT}" || {
  echo 'DR_PRODUCTION_TARGET_RECEIPT must be a real file, not a symlink' >&2
  exit 1
}
export DR_PRODUCTION_TARGET_RECEIPT_SHA256="$(dr_sha256 "${DR_PRODUCTION_TARGET_RECEIPT}")"
production_target_receipt_identity="$(dr_file_identity "${DR_PRODUCTION_TARGET_RECEIPT}")"
export DR_PRODUCTION_PUBLICATION_RECEIPT_SHA256="${publication_receipt_sha256}"
export DR_PRODUCTION_TEMPORAL_IMMUTABLE_ID="$(CHECKPOINT="${workdir}/temporal-checkpoint.json" node -e "process.stdout.write(JSON.parse(require('node:fs').readFileSync(process.env.CHECKPOINT)).immutableId)")"
export DR_PRODUCTION_RECOVERY_POINT_AT="$(BUNDLE_MANIFEST="${PRODUCTION_BUNDLE_FILE}.manifest.json" node -e "process.stdout.write(JSON.parse(require('node:fs').readFileSync(process.env.BUNDLE_MANIFEST)).recoveryPointAt)")"
export DR_PRODUCTION_SOURCE_RELEASE="$(BUNDLE_MANIFEST="${PRODUCTION_BUNDLE_FILE}.manifest.json" node -e "process.stdout.write(JSON.parse(require('node:fs').readFileSync(process.env.BUNDLE_MANIFEST)).sourceRelease)")"

validate_production_restore_lease_json() {
  LEASE_JSON="$1" EXPECTED_HOLDER_PID="${production_restore_lease_pid}" EXPECTED_FENCING_GENERATION="${DR_PRODUCTION_FENCING_GENERATION:-}" \
    EXPECTED_ATTEMPT_ID="${DR_PRODUCTION_RESTORE_ATTEMPT_ID}" \
    EXPECTED_BUNDLE_SHA256="${DR_PRODUCTION_BUNDLE_SHA256}" \
    EXPECTED_TARGET_RECEIPT_SHA256="${DR_PRODUCTION_TARGET_RECEIPT_SHA256}" \
    EXPECTED_PUBLICATION_RECEIPT_SHA256="${DR_PRODUCTION_PUBLICATION_RECEIPT_SHA256}" \
    EXPECTED_PRODUCTION_TARGET_ID="${DR_PRODUCTION_TARGET_ID}" \
    EXPECTED_DATABASE_TARGET_ID="${DR_DATABASE_TARGET_ID}" \
    EXPECTED_OBJECT_TARGET_ID="${DR_OBJECT_TARGET_ID}" \
    EXPECTED_TEMPORAL_IMMUTABLE_ID="${DR_PRODUCTION_TEMPORAL_IMMUTABLE_ID}" \
    EXPECTED_RECOVERY_POINT_AT="${DR_PRODUCTION_RECOVERY_POINT_AT}" \
    EXPECTED_SOURCE_RELEASE="${DR_PRODUCTION_SOURCE_RELEASE}" \
    EXPECTED_TARGET_RELEASE="${DR_TARGET_RELEASE}" \
    MIN_REMAINING_SECONDS="${DR_PRODUCTION_MIN_LEASE_REMAINING_SECONDS:-5}" node <<'NODE'
const lease = JSON.parse(process.env.LEASE_JSON);
if (lease.schemaVersion !== 1 || lease.active !== true || lease.renewable !== true) throw new Error('Production restore lease is not active and renewable');
for (const [field, expected] of [
  ['attemptId', process.env.EXPECTED_ATTEMPT_ID],
  ['bundleSha256', process.env.EXPECTED_BUNDLE_SHA256],
  ['targetReceiptSha256', process.env.EXPECTED_TARGET_RECEIPT_SHA256],
  ['publicationReceiptSha256', process.env.EXPECTED_PUBLICATION_RECEIPT_SHA256],
  ['productionTargetId', process.env.EXPECTED_PRODUCTION_TARGET_ID],
  ['databaseTargetId', process.env.EXPECTED_DATABASE_TARGET_ID],
  ['objectTargetId', process.env.EXPECTED_OBJECT_TARGET_ID],
  ['temporalImmutableId', process.env.EXPECTED_TEMPORAL_IMMUTABLE_ID],
  ['recoveryPointAt', process.env.EXPECTED_RECOVERY_POINT_AT],
  ['sourceRelease', process.env.EXPECTED_SOURCE_RELEASE],
  ['targetRelease', process.env.EXPECTED_TARGET_RELEASE],
]) if (lease[field] !== expected) throw new Error(`Production restore lease ${field} mismatch`);
if (!/^[a-f0-9]{64,128}$/.test(lease.provisioningNonce ?? '')) throw new Error('Production restore lease nonce is invalid');
if (!Number.isInteger(lease.holderPid) || lease.holderPid < 2 || String(lease.holderPid) !== process.env.EXPECTED_HOLDER_PID) throw new Error('Production restore lease holder PID mismatch');
if (!Number.isInteger(lease.fencingGeneration) || lease.fencingGeneration < 1) throw new Error('Production restore lease fencing generation is invalid');
if (process.env.EXPECTED_FENCING_GENERATION && String(lease.fencingGeneration) !== process.env.EXPECTED_FENCING_GENERATION) throw new Error('Production restore lease fencing generation changed');
const expiresAt = Date.parse(lease.expiresAt);
const minimum = Number(process.env.MIN_REMAINING_SECONDS);
if (!Number.isFinite(minimum) || minimum < 1 || !Number.isFinite(expiresAt) || expiresAt <= Date.now() + minimum * 1000) throw new Error('Production restore lease is expired or too close to expiry');
NODE
}

verify_production_restore_lease() {
  production_restore_lease_holder_alive || {
    echo 'Production restore lease holder exited' >&2
    return 1
  }
  dr_assert_file_identity "${DR_PRODUCTION_RESTORE_LEASE_FILE}" "${production_restore_lease_identity}"
  test "$(dr_sha256 "${DR_PRODUCTION_RESTORE_LEASE_FILE}")" = "${production_restore_lease_sha256}" || {
    echo 'Production restore lease readiness evidence changed' >&2
    return 1
  }
  test "$(dr_sha256 "${DR_PRODUCTION_TARGET_LEASE_COMMAND}")" = "${production_restore_lease_command_sha256}" || {
    echo 'Production restore lease holder changed during execution' >&2
    return 1
  }
  test "$(dr_sha256 "${DR_PRODUCTION_TARGET_LEASE_VERIFY_COMMAND}")" = "${production_restore_lease_verifier_sha256}" || {
    echo 'Production restore lease verifier changed before execution' >&2
    return 1
  }
  dr_assert_file_identity "${DR_PRODUCTION_TARGET_RECEIPT}" "${production_target_receipt_identity}"
  test "$(dr_sha256 "${DR_PRODUCTION_TARGET_RECEIPT}")" = "${DR_PRODUCTION_TARGET_RECEIPT_SHA256}" || {
    echo 'Production target receipt changed during restore' >&2
    return 1
  }
  production_restore_lease_verification_json="$(
    DR_HOOK_PRODUCTION_RESTORE_LEASE=1 dr_run_isolated_hook "${DR_PRODUCTION_TARGET_LEASE_VERIFY_COMMAND}"
  )"
  test "$(dr_sha256 "${DR_PRODUCTION_TARGET_LEASE_VERIFY_COMMAND}")" = "${production_restore_lease_verifier_sha256}" || {
    echo 'Production restore lease verifier changed during execution' >&2
    return 1
  }
  validate_production_restore_lease_json "${production_restore_lease_verification_json}"
}

production_restore_tree_pids() {
  local pid="$1"
  local child
  while IFS= read -r child; do
    test -n "${child}" || continue
    production_restore_tree_pids "${child}"
  done < <(pgrep -P "${pid}" 2>/dev/null || true)
  printf '%s\n' "${pid}"
}

terminate_production_restore_tree() {
  local root_pid="$1"
  local tree_pids pid
  /bin/kill -TERM "-${root_pid}" 2>/dev/null || true
  tree_pids="$(production_restore_tree_pids "${root_pid}")"
  for pid in ${tree_pids}; do kill -TERM "${pid}" 2>/dev/null || true; done
  sleep 0.1
  /bin/kill -KILL "-${root_pid}" 2>/dev/null || true
  for pid in ${tree_pids}; do kill -KILL "${pid}" 2>/dev/null || true; done
}

run_with_production_lease_watchdog() {
  local phase="$1"
  shift
  local child_pid child_status=0 group_ready group_deadline
  group_ready="$(mktemp "${production_restore_lease_directory}/process-group.XXXXXX")"
  rm -f "${group_ready}"
  DR_PROCESS_GROUP_READY_FILE="${group_ready}" \
    DR_TEMPORAL_CHECKPOINT_SOURCE_FILE="${DR_TEMPORAL_CHECKPOINT_FILE}" \
    python3 "$(dirname "$0")/lib/run-in-process-group.py" "$@" &
  child_pid=$!
  group_deadline=$((SECONDS + 5))
  while ! test -f "${group_ready}"; do
    kill -0 "${child_pid}" 2>/dev/null || {
      wait "${child_pid}" 2>/dev/null || true
      printf 'Failed to establish isolated process group for %s\n' "${phase}" >&2
      return 1
    }
    test "${SECONDS}" -lt "${group_deadline}" || {
      terminate_production_restore_tree "${child_pid}"
      printf 'Timed out establishing isolated process group for %s\n' "${phase}" >&2
      return 1
    }
    sleep 0.01
  done
  test "$(cat "${group_ready}")" = "${child_pid}" || {
    terminate_production_restore_tree "${child_pid}"
    printf 'Process group identity mismatch for %s\n' "${phase}" >&2
    return 1
  }
  rm -f "${group_ready}"
  while kill -0 "${child_pid}" 2>/dev/null; do
    if ! assert_production_control_inputs_unchanged; then
      terminate_production_restore_tree "${child_pid}"
      wait "${child_pid}" 2>/dev/null || true
      printf 'Production restore lease was lost during %s\n' "${phase}" >&2
      return 1
    fi
    sleep "${DR_PRODUCTION_LEASE_POLL_SECONDS:-0.25}"
  done
  wait "${child_pid}" || child_status=$?
  test "${child_status}" = 0 || return "${child_status}"
  if /bin/kill -0 "-${child_pid}" 2>/dev/null; then
    terminate_production_restore_tree "${child_pid}"
    printf 'A descendant survived successful %s completion\n' "${phase}" >&2
    return 1
  fi
  assert_production_control_inputs_unchanged || {
    printf 'Production restore control input or lease was lost after %s\n' "${phase}" >&2
    return 1
  }
}

start_production_restore_lease() {
  production_restore_lease_directory="$(mktemp -d)"
  export DR_PRODUCTION_RESTORE_ATTEMPT_ID
  DR_PRODUCTION_RESTORE_ATTEMPT_ID="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")"
  export DR_PRODUCTION_RESTORE_LEASE_FILE="${production_restore_lease_directory}/lease-ready.json"
  production_restore_lease_command_sha256="$(dr_sha256 "${DR_PRODUCTION_TARGET_LEASE_COMMAND}")"
  production_restore_lease_verifier_sha256="$(dr_sha256 "${DR_PRODUCTION_TARGET_LEASE_VERIFY_COMMAND}")"
  env -i PATH="${PATH:-/usr/bin:/bin}" HOME="${HOME:-/var/empty}" TMPDIR="${TMPDIR:-/tmp}" LANG=C LC_ALL=C \
    DR_PRODUCTION_TARGET_RECEIPT="${DR_PRODUCTION_TARGET_RECEIPT}" \
    DR_PRODUCTION_RESTORE_ATTEMPT_ID="${DR_PRODUCTION_RESTORE_ATTEMPT_ID}" \
    DR_PRODUCTION_BUNDLE_SHA256="${DR_PRODUCTION_BUNDLE_SHA256}" \
    DR_PRODUCTION_RESTORE_LEASE_FILE="${DR_PRODUCTION_RESTORE_LEASE_FILE}" \
    DR_PRODUCTION_TARGET_ID="${DR_PRODUCTION_TARGET_ID}" \
    DR_DATABASE_TARGET_ID="${DR_DATABASE_TARGET_ID}" DR_OBJECT_TARGET_ID="${DR_OBJECT_TARGET_ID}" \
    DR_PRODUCTION_TEMPORAL_IMMUTABLE_ID="${DR_PRODUCTION_TEMPORAL_IMMUTABLE_ID}" \
    DR_PRODUCTION_RECOVERY_POINT_AT="${DR_PRODUCTION_RECOVERY_POINT_AT}" \
    DR_PRODUCTION_TARGET_RECEIPT_SHA256="${DR_PRODUCTION_TARGET_RECEIPT_SHA256}" \
    DR_PRODUCTION_PUBLICATION_RECEIPT_SHA256="${DR_PRODUCTION_PUBLICATION_RECEIPT_SHA256}" \
    DR_PRODUCTION_SOURCE_RELEASE="${DR_PRODUCTION_SOURCE_RELEASE}" DR_TARGET_RELEASE="${DR_TARGET_RELEASE}" \
    "${DR_PRODUCTION_TARGET_LEASE_COMMAND}" &
  production_restore_lease_pid=$!
  export DR_PRODUCTION_LEASE_HOLDER_PID="${production_restore_lease_pid}"
  local acquire_timeout="${DR_PRODUCTION_LEASE_ACQUIRE_TIMEOUT_SECONDS:-10}"
  [[ "${acquire_timeout}" =~ ^[1-9][0-9]*$ ]] || {
    echo 'DR_PRODUCTION_LEASE_ACQUIRE_TIMEOUT_SECONDS must be a positive integer' >&2
    return 1
  }
  local deadline=$((SECONDS + acquire_timeout))
  while ! test -f "${DR_PRODUCTION_RESTORE_LEASE_FILE}"; do
    production_restore_lease_holder_alive || {
      wait "${production_restore_lease_pid}" 2>/dev/null || true
      echo 'Production restore lease acquisition failed' >&2
      return 1
    }
    test "${SECONDS}" -lt "${deadline}" || {
      echo 'Timed out acquiring the Production restore lease' >&2
      return 1
    }
    sleep 0.05
  done
  test ! -L "${DR_PRODUCTION_RESTORE_LEASE_FILE}" || { echo 'Production restore lease evidence must not be a symlink' >&2; return 1; }
  production_restore_lease_identity="$(dr_file_identity "${DR_PRODUCTION_RESTORE_LEASE_FILE}")"
  production_restore_lease_sha256="$(dr_sha256 "${DR_PRODUCTION_RESTORE_LEASE_FILE}")"
  production_claim_started=1
  validate_production_restore_lease_json "$(cat "${DR_PRODUCTION_RESTORE_LEASE_FILE}")"
  export DR_PRODUCTION_FENCING_GENERATION
  DR_PRODUCTION_FENCING_GENERATION="$(LEASE_FILE="${DR_PRODUCTION_RESTORE_LEASE_FILE}" node -e "process.stdout.write(String(JSON.parse(require('node:fs').readFileSync(process.env.LEASE_FILE)).fencingGeneration))")"
  verify_production_restore_lease
}

start_production_restore_lease

assert_production_pinned_inputs_unchanged() {
  dr_assert_file_identity "${DR_TEMPORAL_CHECKPOINT_FILE}" "${temporal_checkpoint_identity}"
  test "$(dr_sha256 "${DR_TEMPORAL_CHECKPOINT_FILE}")" = "${temporal_checkpoint_sha256}" || {
    echo 'Authenticated Temporal checkpoint changed during Production restore' >&2
    return 1
  }
  dr_assert_file_identity "${DR_PRODUCTION_RETRIEVAL_RECEIPT}" "${publication_receipt_identity}"
  test "$(dr_sha256 "${DR_PRODUCTION_RETRIEVAL_RECEIPT}")" = "${publication_receipt_sha256}" || {
    echo 'Publication receipt changed during restore' >&2
    return 1
  }
  test "$(dr_sha256 "${DR_BACKUP_RECEIPT_VERIFY_COMMAND}")" = "${publication_receipt_verifier_sha256}" || {
    echo 'Publication receipt verifier changed during restore' >&2
    return 1
  }
}

assert_production_control_inputs_unchanged() {
  assert_production_pinned_inputs_unchanged
  verify_production_restore_lease
}

assert_production_completion_control_unchanged() {
  assert_production_pinned_inputs_unchanged
  production_restore_lease_holder_alive || {
    echo 'Production restore lease holder exited during claim completion' >&2
    return 1
  }
  dr_assert_file_identity "${DR_PRODUCTION_RESTORE_LEASE_FILE}" "${production_restore_lease_identity}"
  test "$(dr_sha256 "${DR_PRODUCTION_RESTORE_LEASE_FILE}")" = "${production_restore_lease_sha256}" || {
    echo 'Production restore lease readiness evidence changed during claim completion' >&2
    return 1
  }
  test "$(dr_sha256 "${DR_PRODUCTION_TARGET_LEASE_COMMAND}")" = "${production_restore_lease_command_sha256}" || {
    echo 'Production restore lease holder changed during claim completion' >&2
    return 1
  }
  test "$(dr_sha256 "${DR_PRODUCTION_TARGET_LEASE_VERIFY_COMMAND}")" = "${production_restore_lease_verifier_sha256}" || {
    echo 'Production restore lease verifier changed during claim completion' >&2
    return 1
  }
}

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
  assert_production_control_inputs_unchanged
  run_with_production_lease_watchdog database-restore env \
    DATABASE_URL="${DATABASE_URL}" POSTGRES_BACKUP_FILE="${db_artifacts[0]}" DR_ISOLATED_TARGET=1 \
    DR_HOOK_TEMPORAL_CHECKPOINT=1 \
    DR_VERIFY_COMMAND="${DR_DATABASE_VERIFY_COMMAND}" DR_RESTORE_TARGET_ID="${DR_DATABASE_TARGET_ID}" \
    DR_EVIDENCE_FILE="${DR_EVIDENCE_DIR}/database.json" "$(dirname "$0")/restore-postgres.sh"
else
  : "${DATABASE_URL_MYSQL:?DATABASE_URL_MYSQL must point to the isolated restored MySQL target}"
  : "${DR_DATABASE_VERIFY_COMMAND:?DR_DATABASE_VERIFY_COMMAND is required}"
  assert_production_control_inputs_unchanged
  run_with_production_lease_watchdog database-restore env \
    DR_PRODUCTION_BUNDLE=1 DATABASE_URL_MYSQL="${DATABASE_URL_MYSQL}" MYSQL_BACKUP_FILE="${db_artifacts[0]}" DR_ISOLATED_TARGET=1 \
    DR_HOOK_TEMPORAL_CHECKPOINT=1 \
    DR_VERIFY_COMMAND="${DR_DATABASE_VERIFY_COMMAND}" DR_RESTORE_TARGET_ID="${DR_DATABASE_TARGET_ID}" \
    DR_EVIDENCE_FILE="${DR_EVIDENCE_DIR}/database.json" "$(dirname "$0")/restore-mysql.sh"
fi
assert_production_control_inputs_unchanged

: "${RESTORE_S3_BUCKET:?RESTORE_S3_BUCKET is required}"
: "${DR_OBJECT_VERIFY_COMMAND:?DR_OBJECT_VERIFY_COMMAND is required}"
run_with_production_lease_watchdog object-restore env \
  DR_PRODUCTION_BUNDLE=1 OBJECT_STORAGE_BACKUP_FILE="${object_artifacts[0]}" DR_ISOLATED_TARGET=1 \
  DR_HOOK_TEMPORAL_CHECKPOINT=1 \
  DR_VERIFY_COMMAND="${DR_OBJECT_VERIFY_COMMAND}" DR_RESTORE_TARGET_ID="${DR_OBJECT_TARGET_ID}" \
  DR_EVIDENCE_FILE="${DR_EVIDENCE_DIR}/object-storage.json" "$(dirname "$0")/restore-object-storage.sh"
assert_production_control_inputs_unchanged

export DR_TEMPORAL_RESTORE_EVIDENCE="${DR_EVIDENCE_DIR}/temporal.json"
run_with_production_lease_watchdog temporal-restore bash -c \
  'source "$1"; DR_HOOK_TEMPORAL_CHECKPOINT=1 DR_HOOK_TEMPORAL_TARGET_RECEIPT=1 DR_HOOK_PRODUCTION_RESTORE_LEASE=1 dr_run_isolated_hook "$2"' \
  _ "$(dirname "$0")/lib/dr-common.sh" "${DR_TEMPORAL_RESTORE_COMMAND}"
assert_production_control_inputs_unchanged
export DR_TEMPORAL_EVIDENCE_FILE="${DR_TEMPORAL_RESTORE_EVIDENCE}"
run_with_production_lease_watchdog temporal-verification bash -c \
  'source "$1"; DR_HOOK_TEMPORAL_CHECKPOINT=1 DR_HOOK_TEMPORAL_TARGET_RECEIPT=1 DR_HOOK_PRODUCTION_RESTORE_LEASE=1 dr_run_isolated_hook "$2"' \
  _ "$(dirname "$0")/lib/dr-common.sh" "${DR_TEMPORAL_EVIDENCE_VERIFY_COMMAND}"
assert_production_control_inputs_unchanged
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
run_with_production_lease_watchdog final-verification bash -c \
  'source "$1"; DR_HOOK_TEMPORAL_CHECKPOINT=1 DR_HOOK_TEMPORAL_TARGET_RECEIPT=1 DR_HOOK_PRODUCTION_RESTORE_LEASE=1 dr_run_restore_verifier production-bundle' \
  _ "$(dirname "$0")/lib/dr-common.sh"
export DR_LAST_VERIFIER_SHA256="$(dr_sha256 "${DR_FINAL_VERIFY_COMMAND}")"
assert_production_control_inputs_unchanged
export DR_RECEIPT_FILE="${DR_PRODUCTION_RETRIEVAL_RECEIPT}"
dr_run_isolated_hook "${DR_BACKUP_RECEIPT_VERIFY_COMMAND}"
assert_production_control_inputs_unchanged
production_restore_lease_verification_file="${DR_EVIDENCE_DIR}/production-target-lease.json"
LEASE_VERIFICATION="${production_restore_lease_verification_json}" LEASE_FILE="${production_restore_lease_verification_file}" node <<'NODE'
const { writeFileSync } = require('node:fs');
const lease = JSON.parse(process.env.LEASE_VERIFICATION);
writeFileSync(process.env.LEASE_FILE, `${JSON.stringify(lease, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
NODE
export DR_RESTORE_COMPONENT_FILES="${DR_EVIDENCE_DIR}/database.json,${DR_EVIDENCE_DIR}/object-storage.json,${DR_EVIDENCE_DIR}/temporal.json"
export DR_RESTORE_DATABASE_MANIFEST="${db_artifacts[0]}.manifest.json"
export DR_RESTORE_OBJECT_MANIFEST="${object_artifacts[0]}.manifest.json"
export DR_EXPECTED_DATABASE_TARGET_ID="${DR_DATABASE_TARGET_ID}"
export DR_EXPECTED_OBJECT_TARGET_ID="${DR_OBJECT_TARGET_ID}"
export DR_RESTORE_TARGET_ID="${DR_PRODUCTION_TARGET_ID}"
export DR_RESTORE_ADAPTER_COMMANDS="${DR_BACKUP_RECEIPT_VERIFY_COMMAND},${DR_PRODUCTION_TARGET_LEASE_COMMAND},${DR_PRODUCTION_TARGET_LEASE_VERIFY_COMMAND},${DR_TEMPORAL_RESTORE_COMMAND},${DR_TEMPORAL_EVIDENCE_VERIFY_COMMAND}"
export DR_RESTORE_ADAPTER_EVIDENCE_FILES="${DR_PRODUCTION_RETRIEVAL_RECEIPT},${DR_PRODUCTION_TARGET_RECEIPT},${DR_PRODUCTION_RESTORE_LEASE_FILE},${production_restore_lease_verification_file}"
export DR_PRODUCTION_LEASE_VERIFICATION_FILE="${production_restore_lease_verification_file}"
export DR_PRODUCTION_PUBLICATION_RECEIPT="${DR_PRODUCTION_RETRIEVAL_RECEIPT}"
export DR_PRODUCTION_PUBLICATION_VERIFIER_SHA256="${publication_receipt_verifier_sha256}"
assert_production_control_inputs_unchanged
run_with_production_lease_watchdog evidence-recording bash -c \
  'source "$1"; dr_record_restore_evidence "$2" production-bundle "$3"' \
  _ "$(dirname "$0")/lib/dr-common.sh" "${PRODUCTION_BUNDLE_FILE}" "${started_epoch}"
export DR_PRODUCTION_RESTORE_EVIDENCE_FILE="${DR_EVIDENCE_DIR}/production.json"
export DR_PRODUCTION_RESTORE_EVIDENCE_SHA256="$(dr_sha256 "${DR_PRODUCTION_RESTORE_EVIDENCE_FILE}")"
production_target_claim_file="${DR_EVIDENCE_DIR}/production-target-claim.json"
production_target_claim_output="$(mktemp "${DR_EVIDENCE_DIR}/.production-target-claim.XXXXXX")"
production_target_claim_status_file="$(mktemp "${DR_EVIDENCE_DIR}/.production-target-claim-status.XXXXXX")"
rm -f "${production_target_claim_status_file}"
complete_production_target_claim() {
  local status=0 status_pending="${production_target_claim_status_file}.$$"
  DR_HOOK_PRODUCTION_RESTORE_LEASE=1 dr_run_isolated_hook "${DR_PRODUCTION_TARGET_CLAIM_COMPLETE_COMMAND}" >"${production_target_claim_output}" || status=$?
  printf '%s\n' "${status}" >"${status_pending}"
  mv "${status_pending}" "${production_target_claim_status_file}"
  return "${status}"
}
completion_pid=''
completion_reaped=0
complete_production_target_claim &
completion_pid=$!
while ! test -f "${production_target_claim_status_file}"; do
  assert_production_completion_control_unchanged || {
    terminate_production_restore_tree "${completion_pid}"
    wait "${completion_pid}" 2>/dev/null || true
    echo 'Production restore lease was lost during provider claim completion' >&2
    exit 1
  }
  if ! kill -0 "${completion_pid}" 2>/dev/null; then
    wait "${completion_pid}" 2>/dev/null || true
    completion_reaped=1
    test -f "${production_target_claim_status_file}" || {
      echo 'Provider claim completion exited without an atomic status receipt' >&2
      exit 1
    }
    break
  fi
  sleep "${DR_PRODUCTION_LEASE_POLL_SECONDS:-0.25}"
done
completion_status="$(cat "${production_target_claim_status_file}")"
rm -f "${production_target_claim_status_file}"
production_target_claim_status_file=''
test "${completion_reaped}" = 1 || wait "${completion_pid}" || true
test "${completion_status}" = 0 || {
  printf 'Provider claim completion failed with status %s\n' "${completion_status}" >&2
  exit "${completion_status}"
}
assert_production_pinned_inputs_unchanged
production_target_claim_json="$(cat "${production_target_claim_output}")"
rm -f "${production_target_claim_output}"
production_target_claim_output=''
CLAIM_JSON="${production_target_claim_json}" CLAIM_FILE="${production_target_claim_file}" \
  EXPECTED_EVIDENCE_SHA256="${DR_PRODUCTION_RESTORE_EVIDENCE_SHA256}" \
  EXPECTED_BUNDLE_SHA256="${DR_PRODUCTION_BUNDLE_SHA256}" \
  EXPECTED_TARGET_ID="${DR_PRODUCTION_TARGET_ID}" node <<'NODE'
const { writeFileSync } = require('node:fs');
const claim = JSON.parse(process.env.CLAIM_JSON);
if (claim.schemaVersion !== 1) throw new Error('Provider completion receipt schema mismatch');
if (claim.status !== 'completed' || claim.active !== false) throw new Error('Provider completion receipt status mismatch');
if (claim.restoreEvidenceSha256 !== process.env.EXPECTED_EVIDENCE_SHA256) throw new Error('Provider completion receipt evidence mismatch');
if (claim.bundleSha256 !== process.env.EXPECTED_BUNDLE_SHA256) throw new Error('Provider completion receipt bundle mismatch');
if (claim.productionTargetId !== process.env.EXPECTED_TARGET_ID) throw new Error('Provider completion receipt target mismatch');
if (!Number.isInteger(claim.fencingGeneration) || claim.fencingGeneration < 1) throw new Error('Provider completion receipt fencing generation mismatch');
if (!/^[a-f0-9]{64,128}$/.test(claim.providerSignature || '')) throw new Error('Provider completion receipt signature metadata mismatch');
if (!Number.isFinite(Date.parse(claim.completedAt))) throw new Error('Provider completion receipt timestamp mismatch');
writeFileSync(process.env.CLAIM_FILE, `${JSON.stringify(claim, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
NODE
export DR_PRODUCTION_TARGET_CLAIM_RECEIPT="${production_target_claim_file}"
DR_HOOK_PRODUCTION_COMPLETED_CLAIM=1 dr_run_isolated_hook "${DR_PRODUCTION_TARGET_CLAIM_VERIFY_COMMAND}"
test "$(dr_sha256 "${DR_PRODUCTION_RESTORE_EVIDENCE_FILE}")" = "${DR_PRODUCTION_RESTORE_EVIDENCE_SHA256}" || {
  echo 'Production restore evidence changed during provider claim completion' >&2
  exit 1
}
production_claim_finalized=1
printf 'Production bundle restore verified; evidence: %s\n' "${DR_EVIDENCE_DIR}"
