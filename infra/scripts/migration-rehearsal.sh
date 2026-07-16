#!/usr/bin/env bash
set -euo pipefail
umask 077

: "${DB_DRIVER:?DB_DRIVER must be postgres or mysql}"
: "${SOURCE_DATABASE_URL:?SOURCE_DATABASE_URL is required}"
: "${FORWARD_DATABASE_URL:?FORWARD_DATABASE_URL must be an empty isolated clone}"
: "${ROLLBACK_DATABASE_URL:?ROLLBACK_DATABASE_URL must be a second empty isolated clone}"
: "${DR_OLD_VERSION_VERIFY_COMMAND:?DR_OLD_VERSION_VERIFY_COMMAND is required}"
: "${DR_NEW_VERSION_VERIFY_COMMAND:?DR_NEW_VERSION_VERIFY_COMMAND is required}"
: "${DR_MIGRATION_COMMAND:?DR_MIGRATION_COMMAND is required}"
: "${DR_MIGRATION_ARTIFACT:?DR_MIGRATION_ARTIFACT is required}"
: "${DR_DATABASE_IDENTITY_COMMAND:?DR_DATABASE_IDENTITY_COMMAND is required}"
: "${DR_OLD_RELEASE_MANIFEST:?DR_OLD_RELEASE_MANIFEST is required}"
: "${DR_NEW_RELEASE_MANIFEST:?DR_NEW_RELEASE_MANIFEST is required}"
: "${DR_REHEARSAL_ID:?DR_REHEARSAL_ID is required}"
: "${DR_INCIDENT_AT:?DR_INCIDENT_AT is required for measured rehearsal evidence}"
: "${DR_SOURCE_RELEASE:?DR_SOURCE_RELEASE is required}"
: "${DR_OLD_RELEASE:?DR_OLD_RELEASE is required}"
: "${DR_NEW_RELEASE:?DR_NEW_RELEASE is required}"
: "${FORWARD_TARGET_ID:?FORWARD_TARGET_ID must be an opaque non-secret identifier}"
: "${ROLLBACK_TARGET_ID:?ROLLBACK_TARGET_ID must be an opaque non-secret identifier}"
: "${DR_MANIFEST_SIGNING_KEY:?DR_MANIFEST_SIGNING_KEY is required}"
: "${DR_MANIFEST_KEY_ID:?DR_MANIFEST_KEY_ID is required}"

manifest_signing_key="${DR_MANIFEST_SIGNING_KEY}"
unset DR_MANIFEST_SIGNING_KEY

case "${DB_DRIVER}" in postgres|mysql) ;; *) echo 'DB_DRIVER must be postgres or mysql' >&2; exit 1 ;; esac
case "${DR_EXPECT_FORWARD_FAILURE:-0}" in 0|1) ;; *) echo 'DR_EXPECT_FORWARD_FAILURE must be 0 or 1' >&2; exit 1 ;; esac
if [ "${DR_EXPECT_FORWARD_FAILURE:-0}" = 1 ]; then
  : "${DR_FAILURE_INJECTION_MANIFEST:?DR_FAILURE_INJECTION_MANIFEST is required for an injected failure}"
  : "${DR_EXPECTED_MIGRATION_EXIT_CODE:?DR_EXPECTED_MIGRATION_EXIT_CODE is required for an injected failure}"
  [[ "${DR_EXPECTED_MIGRATION_EXIT_CODE}" =~ ^([1-9]|[1-9][0-9]|1[01][0-9]|12[0-3])$ ]] || {
    echo 'DR_EXPECTED_MIGRATION_EXIT_CODE must be between 1 and 123; 124 and 125 are runner-reserved' >&2
    exit 1
  }
else
  test -z "${DR_FAILURE_INJECTION_MANIFEST:-}" || { echo 'DR_FAILURE_INJECTION_MANIFEST is only valid for an injected failure' >&2; exit 1; }
  test -z "${DR_EXPECTED_MIGRATION_EXIT_CODE:-}" || { echo 'DR_EXPECTED_MIGRATION_EXIT_CODE is only valid for an injected failure' >&2; exit 1; }
fi
test "${SOURCE_DATABASE_URL}" != "${FORWARD_DATABASE_URL}" || { echo 'Forward target must differ from source' >&2; exit 1; }
test "${SOURCE_DATABASE_URL}" != "${ROLLBACK_DATABASE_URL}" || { echo 'Rollback target must differ from source' >&2; exit 1; }
test "${FORWARD_DATABASE_URL}" != "${ROLLBACK_DATABASE_URL}" || { echo 'Forward and rollback targets must differ' >&2; exit 1; }
test "${FORWARD_TARGET_ID}" != "${ROLLBACK_TARGET_ID}" || { echo 'Forward and rollback target IDs must differ' >&2; exit 1; }
test "${DR_SOURCE_RELEASE}" = "${DR_OLD_RELEASE}" || { echo 'DR_SOURCE_RELEASE must equal DR_OLD_RELEASE' >&2; exit 1; }
test "${DR_OLD_RELEASE}" != "${DR_NEW_RELEASE}" || { echo 'Old and new releases must differ' >&2; exit 1; }
release_pattern='^[A-Za-z0-9][A-Za-z0-9._/:+-]{0,191}@sha256:[a-f0-9]{64}$'
[[ "${DR_OLD_RELEASE}" =~ ${release_pattern} ]] || { echo 'DR_OLD_RELEASE must be an immutable sha256 reference' >&2; exit 1; }
[[ "${DR_NEW_RELEASE}" =~ ${release_pattern} ]] || { echo 'DR_NEW_RELEASE must be an immutable sha256 reference' >&2; exit 1; }
[[ "${DR_REHEARSAL_ID}" =~ ^[a-z0-9]([-a-z0-9]{0,62})$ ]] || { echo 'DR_REHEARSAL_ID is invalid' >&2; exit 1; }

for executable in "${DR_OLD_VERSION_VERIFY_COMMAND}" "${DR_NEW_VERSION_VERIFY_COMMAND}" "${DR_MIGRATION_COMMAND}" "${DR_DATABASE_IDENTITY_COMMAND}"; do
  test -f "${executable}" && test ! -L "${executable}" && test -x "${executable}" || {
    echo "Executable must be a regular non-symlink file: ${executable}" >&2
    exit 1
  }
done
for artifact in "${DR_MIGRATION_ARTIFACT}" "${DR_OLD_RELEASE_MANIFEST}" "${DR_NEW_RELEASE_MANIFEST}" ${DR_FAILURE_INJECTION_MANIFEST:+"${DR_FAILURE_INJECTION_MANIFEST}"}; do
  test -f "${artifact}" && test ! -L "${artifact}" || {
    echo "Artifact must be a regular non-symlink file: ${artifact}" >&2
    exit 1
  }
done

script_dir="$(cd "$(dirname "$0")" && pwd -P)"
root_dir="$(cd "${script_dir}/../.." && pwd -P)"
bounded_runner="${root_dir}/scripts/run-bounded-command.mjs"
node_path="$(command -v node)"
for timeout_name in DR_BACKUP_TIMEOUT_MS DR_RESTORE_TIMEOUT_MS DR_MIGRATION_TIMEOUT_MS DR_VERIFY_TIMEOUT_MS DR_IDENTITY_TIMEOUT_MS; do
  timeout_value="${!timeout_name:-}"
  test -z "${timeout_value}" || [[ "${timeout_value}" =~ ^[1-9][0-9]*$ ]] || { echo "${timeout_name} must be a positive integer" >&2; exit 1; }
done
backup_timeout_ms="${DR_BACKUP_TIMEOUT_MS:-1800000}"
restore_timeout_ms="${DR_RESTORE_TIMEOUT_MS:-1800000}"
migration_timeout_ms="${DR_MIGRATION_TIMEOUT_MS:-600000}"
verify_timeout_ms="${DR_VERIFY_TIMEOUT_MS:-300000}"
identity_timeout_ms="${DR_IDENTITY_TIMEOUT_MS:-60000}"
phase_output_limit="${DR_PHASE_MAX_OUTPUT_BYTES:-4194304}"
[[ "${phase_output_limit}" =~ ^[1-9][0-9]*$ ]] || { echo 'DR_PHASE_MAX_OUTPUT_BYTES must be a positive integer' >&2; exit 1; }
backup_dir="${BACKUP_DIR:-backups/migration-rehearsal}"
evidence_dir="${DR_EVIDENCE_DIR:-${backup_dir}/evidence}"
evidence_file="${DR_MIGRATION_EVIDENCE_FILE:-${evidence_dir}/migration-rehearsal.json}"
timestamp="${BACKUP_TIMESTAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
directory_identities="$(BACKUP_DIR_TO_CHECK="${backup_dir}" EVIDENCE_DIR_TO_CHECK="${evidence_dir}" EVIDENCE_FILE_TO_CHECK="${evidence_file}" node <<'NODE'
const { lstatSync, realpathSync } = require('node:fs');
const { dirname, resolve } = require('node:path');
const identities = [];
for (const [label, value] of [['backup', process.env.BACKUP_DIR_TO_CHECK], ['evidence', process.env.EVIDENCE_DIR_TO_CHECK]]) {
  const requested = resolve(value);
  const stat = lstatSync(requested);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(requested) !== requested)
    throw new Error(`${label} directory and every path component must resolve without symlinks`);
  if (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)
    throw new Error(`${label} directory must be caller-owned and mode 0700 or stricter`);
  identities.push(`${stat.dev}:${stat.ino}:${requested}`);
}
if (dirname(resolve(process.env.EVIDENCE_FILE_TO_CHECK)) !== resolve(process.env.EVIDENCE_DIR_TO_CHECK))
  throw new Error('Migration evidence file must be directly inside DR_EVIDENCE_DIR');
process.stdout.write(identities.join('\t'));
NODE
)"
IFS=$'\t' read -r backup_directory_identity evidence_directory_identity <<<"${directory_identities}"
assert_directories_stable() {
  BACKUP_DIR_TO_CHECK="${backup_dir}" EVIDENCE_DIR_TO_CHECK="${evidence_dir}" \
    EXPECTED_BACKUP_IDENTITY="${backup_directory_identity}" EXPECTED_EVIDENCE_IDENTITY="${evidence_directory_identity}" node <<'NODE'
const { lstatSync, realpathSync } = require('node:fs');
const { resolve } = require('node:path');
for (const [label, value, expected] of [
  ['backup', process.env.BACKUP_DIR_TO_CHECK, process.env.EXPECTED_BACKUP_IDENTITY],
  ['evidence', process.env.EVIDENCE_DIR_TO_CHECK, process.env.EXPECTED_EVIDENCE_IDENTITY],
]) {
  const requested = resolve(value);
  const stat = lstatSync(requested);
  const actual = `${stat.dev}:${stat.ino}:${requested}`;
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(requested) !== requested || actual !== expected ||
      stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)
    throw new Error(`${label} directory identity changed during migration rehearsal`);
}
NODE
}
assert_directories_stable

reservation_token="$({ EVIDENCE_FILE="${evidence_file}" node <<'NODE'
const { randomBytes } = require('node:crypto');
const { constants, lstatSync, openSync, closeSync, writeFileSync } = require('node:fs');
const { dirname } = require('node:path');
const path = process.env.EVIDENCE_FILE;
const directory = dirname(path);
const directoryStat = lstatSync(directory);
if (directoryStat.isSymbolicLink()) throw new Error('Migration evidence directory must not be a symlink');
if (!directoryStat.isDirectory() || directoryStat.uid !== process.getuid() || (directoryStat.mode & 0o077) !== 0) {
  throw new Error('Migration evidence directory must be caller-owned and mode 0700 or stricter');
}
for (const candidate of [path, `${path}.in-progress`]) {
  try { lstatSync(candidate); throw new Error(`Refusing existing migration evidence path: ${candidate}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const token = randomBytes(32).toString('hex');
const descriptor = openSync(`${path}.in-progress`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
try { writeFileSync(descriptor, `${token}\n`); } finally { closeSync(descriptor); }
process.stdout.write(token);
NODE
} )"
rehearsal_nonce="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")"

staging_dir="$(mktemp -d "${TMPDIR:-/tmp}/tixkit-migration-inputs.XXXXXX")"
chmod 700 "${staging_dir}"
migration_stdout="${staging_dir}/migration-stdout"
migration_stderr="${staging_dir}/migration-stderr"
new_verifier_stdout="${staging_dir}/new-verifier-stdout"
new_verifier_stderr="${staging_dir}/new-verifier-stderr"
for output_file in "${migration_stdout}" "${migration_stderr}" "${new_verifier_stdout}" "${new_verifier_stderr}"; do
  (umask 077; : >"${output_file}")
done
failure_result_file="${staging_dir}/failure-result-${rehearsal_nonce}.json"
cleanup() {
  rm -rf "${staging_dir}"
  if assert_directories_stable 2>/dev/null; then
    EVIDENCE_FILE="${evidence_file}" TOKEN="${reservation_token}" node <<'NODE' || true
const { lstatSync, readFileSync, unlinkSync } = require('node:fs');
const path = `${process.env.EVIDENCE_FILE}.in-progress`;
try {
  const stat = lstatSync(path);
  if (stat.isFile() && !stat.isSymbolicLink() && readFileSync(path, 'utf8').trim() === process.env.TOKEN) unlinkSync(path);
} catch (error) { if (error.code !== 'ENOENT') throw error; }
NODE
  fi
}
trap cleanup EXIT INT TERM

sha256_file() {
  node -e "const{createHash}=require('node:crypto'),{readFileSync}=require('node:fs');process.stdout.write(createHash('sha256').update(readFileSync(process.argv[1])).digest('hex'))" "$1"
}
snapshot_input() {
  local source="$1" destination="$2" expected_sha256="$3" executable_mode="${4:-0}"
  cp "${source}" "${destination}"
  if [ "${executable_mode}" = 1 ]; then chmod 700 "${destination}"; else chmod 600 "${destination}"; fi
  test "$(sha256_file "${destination}")" = "${expected_sha256}" || { echo "Input changed while it was snapshotted: ${source}" >&2; exit 1; }
  test "$(sha256_file "${source}")" = "${expected_sha256}" || { echo "Input changed while it was snapshotted: ${source}" >&2; exit 1; }
}
milliseconds() { node -e 'process.stdout.write(String(Date.now()))'; }
iso_now() { node -e 'process.stdout.write(new Date().toISOString())'; }

old_verifier_sha256="$(sha256_file "${DR_OLD_VERSION_VERIFY_COMMAND}")"
new_verifier_sha256="$(sha256_file "${DR_NEW_VERSION_VERIFY_COMMAND}")"
migration_command_sha256="$(sha256_file "${DR_MIGRATION_COMMAND}")"
migration_artifact_sha256="$(sha256_file "${DR_MIGRATION_ARTIFACT}")"
database_identity_command_sha256="$(sha256_file "${DR_DATABASE_IDENTITY_COMMAND}")"
old_release_manifest_sha256="$(sha256_file "${DR_OLD_RELEASE_MANIFEST}")"
new_release_manifest_sha256="$(sha256_file "${DR_NEW_RELEASE_MANIFEST}")"
failure_injection_manifest_sha256=""
if [ "${DR_EXPECT_FORWARD_FAILURE:-0}" = 1 ]; then
  failure_injection_manifest_sha256="$(sha256_file "${DR_FAILURE_INJECTION_MANIFEST}")"
fi
failure_challenge=""

old_verifier_snapshot="${staging_dir}/old-verifier"
new_verifier_snapshot="${staging_dir}/new-verifier"
migration_command_snapshot="${staging_dir}/migration-command"
migration_artifact_snapshot="${staging_dir}/migration-artifact"
database_identity_command_snapshot="${staging_dir}/database-identity-command"
old_release_manifest_snapshot="${staging_dir}/old-release-manifest"
new_release_manifest_snapshot="${staging_dir}/new-release-manifest"
snapshot_input "${DR_OLD_VERSION_VERIFY_COMMAND}" "${old_verifier_snapshot}" "${old_verifier_sha256}" 1
snapshot_input "${DR_NEW_VERSION_VERIFY_COMMAND}" "${new_verifier_snapshot}" "${new_verifier_sha256}" 1
snapshot_input "${DR_MIGRATION_COMMAND}" "${migration_command_snapshot}" "${migration_command_sha256}" 1
snapshot_input "${DR_MIGRATION_ARTIFACT}" "${migration_artifact_snapshot}" "${migration_artifact_sha256}"
snapshot_input "${DR_DATABASE_IDENTITY_COMMAND}" "${database_identity_command_snapshot}" "${database_identity_command_sha256}" 1
snapshot_input "${DR_OLD_RELEASE_MANIFEST}" "${old_release_manifest_snapshot}" "${old_release_manifest_sha256}"
snapshot_input "${DR_NEW_RELEASE_MANIFEST}" "${new_release_manifest_snapshot}" "${new_release_manifest_sha256}"
failure_injection_manifest_snapshot=""
if [ "${DR_EXPECT_FORWARD_FAILURE:-0}" = 1 ]; then
  failure_injection_manifest_snapshot="${staging_dir}/failure-injection-manifest"
  snapshot_input "${DR_FAILURE_INJECTION_MANIFEST}" "${failure_injection_manifest_snapshot}" "${failure_injection_manifest_sha256}"
fi
MANIFEST_KEY="${manifest_signing_key}" KEY_ID="${DR_MANIFEST_KEY_ID}" OLD_MANIFEST="${old_release_manifest_snapshot}" \
  NEW_MANIFEST="${new_release_manifest_snapshot}" FAILURE_MANIFEST="${failure_injection_manifest_snapshot}" \
  OLD_RELEASE="${DR_OLD_RELEASE}" NEW_RELEASE="${DR_NEW_RELEASE}" OLD_VERIFIER_SHA="${old_verifier_sha256}" \
  NEW_VERIFIER_SHA="${new_verifier_sha256}" MIGRATION_COMMAND_SHA="${migration_command_sha256}" IDENTITY_COMMAND_SHA="${database_identity_command_sha256}" \
  MIGRATION_ARTIFACT_SHA="${migration_artifact_sha256}" EXPECTED_FAILURE="${DR_EXPECT_FORWARD_FAILURE:-0}" \
  EXPECTED_EXIT="${DR_EXPECTED_MIGRATION_EXIT_CODE:-0}" node <<'NODE'
const { createHmac, timingSafeEqual } = require('node:crypto');
const { readFileSync } = require('node:fs');
function signed(path, label) {
  const document = JSON.parse(readFileSync(path, 'utf8'));
  const { signature, ...payload } = document;
  const expected = createHmac('sha256', process.env.MANIFEST_KEY).update(JSON.stringify(payload)).digest();
  const actual = Buffer.from(signature?.value ?? '', 'hex');
  if (signature?.algorithm !== 'hmac-sha256' || signature.keyId !== process.env.KEY_ID ||
      actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error(`${label} signature mismatch`);
  return payload;
}
const old = signed(process.env.OLD_MANIFEST, 'old release manifest');
const newer = signed(process.env.NEW_MANIFEST, 'new release manifest');
if (old.schemaVersion !== 1 || old.kind !== 'migration-release-attestation' || old.release !== process.env.OLD_RELEASE ||
    old.components?.oldVerifierSha256 !== process.env.OLD_VERIFIER_SHA ||
    old.components?.databaseIdentityCommandSha256 !== process.env.IDENTITY_COMMAND_SHA || Object.keys(old.components ?? {}).length !== 2)
  throw new Error('old release manifest does not bind the staged old verifier');
if (newer.schemaVersion !== 1 || newer.kind !== 'migration-release-attestation' || newer.release !== process.env.NEW_RELEASE ||
    newer.components?.newVerifierSha256 !== process.env.NEW_VERIFIER_SHA ||
    newer.components?.migrationCommandSha256 !== process.env.MIGRATION_COMMAND_SHA ||
    newer.components?.migrationArtifactSha256 !== process.env.MIGRATION_ARTIFACT_SHA ||
    Object.keys(newer.components ?? {}).length !== 3)
  throw new Error('new release manifest does not bind every staged migration input');
if (process.env.EXPECTED_FAILURE === '1') {
  const injection = signed(process.env.FAILURE_MANIFEST, 'failure injection manifest');
  if (injection.schemaVersion !== 1 || injection.kind !== 'migration-failure-injection' ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(injection.id ?? '') ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(injection.type ?? '') ||
      String(injection.expectedExitCode) !== process.env.EXPECTED_EXIT)
    throw new Error('failure injection manifest contract mismatch');
}
NODE
if [ "${DR_EXPECT_FORWARD_FAILURE:-0}" = 1 ]; then
  failure_challenge="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")"
fi

isolated_bin="${staging_dir}/bin"
mkdir "${isolated_bin}"
chmod 700 "${isolated_bin}"
for tool in pg_dump pg_restore psql mysql mysqldump docker; do
  tool_path="$(command -v "${tool}" 2>/dev/null || true)"
  test -z "${tool_path}" && continue
  printf '#!/usr/bin/env bash\nunset DR_MANIFEST_SIGNING_KEY DR_EVIDENCE_RESERVATION_TOKEN SOURCE_DATABASE_URL FORWARD_DATABASE_URL ROLLBACK_DATABASE_URL UNRELATED_SENTINEL_SECRET\nexec %q "$@"\n' "${tool_path}" >"${isolated_bin}/${tool}"
  chmod 700 "${isolated_bin}/${tool}"
done
isolated_path="${isolated_bin}:${PATH}"
proof_started_at="$(iso_now)"
source_identity_file="${evidence_dir}/source-identity.json"
forward_identity_file="${evidence_dir}/forward-identity.json"
rollback_identity_file="${evidence_dir}/rollback-identity.json"
for identity_file in "${source_identity_file}" "${forward_identity_file}" "${rollback_identity_file}"; do
  test ! -e "${identity_file}" && test ! -L "${identity_file}" || { echo "Refusing existing database identity evidence path: ${identity_file}" >&2; exit 1; }
done
run_identity_command() {
  local role="$1" database_url="$2" output="$3"
  local staged_output="${staging_dir}/${role}-identity.json"
  assert_directories_stable
  if [ "${DB_DRIVER}" = postgres ]; then
    env -i PATH="${isolated_path}" HOME="${HOME:-/var/empty}" TMPDIR="${TMPDIR:-/tmp}" LANG=C LC_ALL=C \
      DATABASE_URL="${database_url}" DB_DRIVER=postgres TIXKIT_DATABASE_IDENTITY_ROLE="${role}" \
      "${node_path}" "${bounded_runner}" --timeout-ms "${identity_timeout_ms}" --max-output-bytes "${phase_output_limit}" -- \
      "${database_identity_command_snapshot}" >"${staged_output}"
  else
    env -i PATH="${isolated_path}" HOME="${HOME:-/var/empty}" TMPDIR="${TMPDIR:-/tmp}" LANG=C LC_ALL=C \
      DATABASE_URL_MYSQL="${database_url}" DB_DRIVER=mysql TIXKIT_DATABASE_IDENTITY_ROLE="${role}" \
      "${node_path}" "${bounded_runner}" --timeout-ms "${identity_timeout_ms}" --max-output-bytes "${phase_output_limit}" -- \
      "${database_identity_command_snapshot}" >"${staged_output}"
  fi
  SOURCE="${staged_output}" DESTINATION="${output}" node <<'NODE'
const { closeSync, constants, openSync, readFileSync, writeFileSync } = require('node:fs');
const bytes = readFileSync(process.env.SOURCE);
const fd = openSync(process.env.DESTINATION, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
try { writeFileSync(fd, bytes); } finally { closeSync(fd); }
NODE
  assert_directories_stable
}
run_identity_command source "${SOURCE_DATABASE_URL}" "${source_identity_file}"
assert_directories_stable

if [ "${DB_DRIVER}" = postgres ]; then
  backup="$(env -i PATH="${isolated_path}" HOME="${HOME:-/var/empty}" TMPDIR="${TMPDIR:-/tmp}" LANG=C LC_ALL=C \
    DR_MANIFEST_SIGNING_KEY="${manifest_signing_key}" DR_MANIFEST_KEY_ID="${DR_MANIFEST_KEY_ID}" DR_SOURCE_RELEASE="${DR_SOURCE_RELEASE}" \
    DR_BACKUP_ENCRYPTION="${DR_BACKUP_ENCRYPTION:-provider-managed}" DR_BACKUP_DESTINATION_CLASS="${DR_BACKUP_DESTINATION_CLASS:-independent}" \
    DR_RECOVERY_POINT_AT="${DR_RECOVERY_POINT_AT:-}" DATABASE_URL="${SOURCE_DATABASE_URL}" BACKUP_DIR="${backup_dir}" BACKUP_TIMESTAMP="${timestamp}" \
    DR_REHEARSAL_ID="${DR_REHEARSAL_ID}" DR_REHEARSAL_NONCE="${rehearsal_nonce}" \
    "${node_path}" "${bounded_runner}" --timeout-ms "${backup_timeout_ms}" --max-output-bytes "${phase_output_limit}" -- "${script_dir}/backup-postgres.sh")"
  assert_directories_stable
  env -i PATH="${isolated_path}" HOME="${HOME:-/var/empty}" TMPDIR="${TMPDIR:-/tmp}" LANG=C LC_ALL=C \
    DR_MANIFEST_SIGNING_KEY="${manifest_signing_key}" DR_MANIFEST_KEY_ID="${DR_MANIFEST_KEY_ID}" DR_INCIDENT_AT="${DR_INCIDENT_AT}" \
    DATABASE_URL="${FORWARD_DATABASE_URL}" POSTGRES_BACKUP_FILE="${backup}" DR_ISOLATED_TARGET=1 DR_RESTORE_PHASE_STARTED_AT="$(iso_now)" \
    DR_VERIFY_COMMAND="${old_verifier_snapshot}" DR_EVIDENCE_FILE="${evidence_dir}/forward-restore.json" \
    DR_RESTORE_TARGET_ID="${FORWARD_TARGET_ID}" DR_TARGET_RELEASE="${DR_OLD_RELEASE}" DR_REHEARSAL_ID="${DR_REHEARSAL_ID}" DR_REHEARSAL_NONCE="${rehearsal_nonce}" DR_REHEARSAL_PHASE=forward \
    "${node_path}" "${bounded_runner}" --timeout-ms "${restore_timeout_ms}" --max-output-bytes "${phase_output_limit}" -- "${script_dir}/restore-postgres.sh"
else
  backup="$(env -i PATH="${isolated_path}" HOME="${HOME:-/var/empty}" TMPDIR="${TMPDIR:-/tmp}" LANG=C LC_ALL=C \
    DR_MANIFEST_SIGNING_KEY="${manifest_signing_key}" DR_MANIFEST_KEY_ID="${DR_MANIFEST_KEY_ID}" DR_SOURCE_RELEASE="${DR_SOURCE_RELEASE}" \
    DR_BACKUP_ENCRYPTION="${DR_BACKUP_ENCRYPTION:-provider-managed}" DR_BACKUP_DESTINATION_CLASS="${DR_BACKUP_DESTINATION_CLASS:-independent}" \
    DR_RECOVERY_POINT_AT="${DR_RECOVERY_POINT_AT:-}" DATABASE_URL_MYSQL="${SOURCE_DATABASE_URL}" BACKUP_DIR="${backup_dir}" BACKUP_TIMESTAMP="${timestamp}" \
    DR_REHEARSAL_ID="${DR_REHEARSAL_ID}" DR_REHEARSAL_NONCE="${rehearsal_nonce}" \
    "${node_path}" "${bounded_runner}" --timeout-ms "${backup_timeout_ms}" --max-output-bytes "${phase_output_limit}" -- "${script_dir}/backup-mysql.sh")"
  assert_directories_stable
  env -i PATH="${isolated_path}" HOME="${HOME:-/var/empty}" TMPDIR="${TMPDIR:-/tmp}" LANG=C LC_ALL=C \
    DR_MANIFEST_SIGNING_KEY="${manifest_signing_key}" DR_MANIFEST_KEY_ID="${DR_MANIFEST_KEY_ID}" DR_INCIDENT_AT="${DR_INCIDENT_AT}" \
    DATABASE_URL_MYSQL="${FORWARD_DATABASE_URL}" MYSQL_BACKUP_FILE="${backup}" DR_ISOLATED_TARGET=1 DR_RESTORE_PHASE_STARTED_AT="$(iso_now)" \
    DR_VERIFY_COMMAND="${old_verifier_snapshot}" DR_EVIDENCE_FILE="${evidence_dir}/forward-restore.json" \
    DR_RESTORE_TARGET_ID="${FORWARD_TARGET_ID}" DR_TARGET_RELEASE="${DR_OLD_RELEASE}" DR_REHEARSAL_ID="${DR_REHEARSAL_ID}" DR_REHEARSAL_NONCE="${rehearsal_nonce}" DR_REHEARSAL_PHASE=forward \
    "${node_path}" "${bounded_runner}" --timeout-ms "${restore_timeout_ms}" --max-output-bytes "${phase_output_limit}" -- "${script_dir}/restore-mysql.sh"
fi
run_identity_command forward "${FORWARD_DATABASE_URL}" "${forward_identity_file}"
assert_directories_stable

migration_started_ms="$(milliseconds)"
migration_started_at="$(iso_now)"
set +e
if [ "${DB_DRIVER}" = postgres ]; then
  env -i PATH="${PATH}" HOME="${HOME:-/var/empty}" TMPDIR="${TMPDIR:-/tmp}" LANG=C LC_ALL=C \
    DATABASE_URL="${FORWARD_DATABASE_URL}" DB_DRIVER=postgres DR_MIGRATION_ARTIFACT="${migration_artifact_snapshot}" \
    TIXKIT_MIGRATION_FAILURE_INJECTION_MANIFEST="${failure_injection_manifest_snapshot}" \
    TIXKIT_MIGRATION_FAILURE_CHALLENGE="${failure_challenge}" TIXKIT_MIGRATION_FAILURE_RESULT_FILE="${failure_result_file}" \
    "${node_path}" "${bounded_runner}" --timeout-ms "${migration_timeout_ms}" --max-output-bytes "${phase_output_limit}" -- \
    "${migration_command_snapshot}" >"${migration_stdout}" 2>"${migration_stderr}"
else
  env -i PATH="${PATH}" HOME="${HOME:-/var/empty}" TMPDIR="${TMPDIR:-/tmp}" LANG=C LC_ALL=C \
    DATABASE_URL_MYSQL="${FORWARD_DATABASE_URL}" DB_DRIVER=mysql DR_MIGRATION_ARTIFACT="${migration_artifact_snapshot}" \
    TIXKIT_MIGRATION_FAILURE_INJECTION_MANIFEST="${failure_injection_manifest_snapshot}" \
    TIXKIT_MIGRATION_FAILURE_CHALLENGE="${failure_challenge}" TIXKIT_MIGRATION_FAILURE_RESULT_FILE="${failure_result_file}" \
    "${node_path}" "${bounded_runner}" --timeout-ms "${migration_timeout_ms}" --max-output-bytes "${phase_output_limit}" -- \
    "${migration_command_snapshot}" >"${migration_stdout}" 2>"${migration_stderr}"
fi
migration_status=$?
set -e
migration_duration_ms=$(( $(milliseconds) - migration_started_ms ))
migration_completed_at="$(iso_now)"

new_verifier_status=null
new_verifier_duration_ms=0
new_verifier_started_at=null
new_verifier_completed_at=null
if [ "${DR_EXPECT_FORWARD_FAILURE:-0}" = 0 ] && [ "${migration_status}" -eq 0 ]; then
  assert_directories_stable
  new_verifier_started_ms="$(milliseconds)"
  new_verifier_started_at="$(iso_now)"
  set +e
  if [ "${DB_DRIVER}" = postgres ]; then
    DATABASE_URL="${FORWARD_DATABASE_URL}" DB_DRIVER=postgres DR_RESTORE_KIND=postgres-forward \
      env -i PATH="${PATH}" HOME="${HOME:-/var/empty}" TMPDIR="${TMPDIR:-/tmp}" LANG=C LC_ALL=C \
      DATABASE_URL="${FORWARD_DATABASE_URL}" DB_DRIVER=postgres DR_RESTORE_KIND=postgres-forward \
      "${node_path}" "${bounded_runner}" --timeout-ms "${verify_timeout_ms}" --max-output-bytes "${phase_output_limit}" -- \
      "${new_verifier_snapshot}" >"${new_verifier_stdout}" 2>"${new_verifier_stderr}"
  else
    DATABASE_URL_MYSQL="${FORWARD_DATABASE_URL}" DB_DRIVER=mysql DR_RESTORE_KIND=mysql-forward \
      env -i PATH="${PATH}" HOME="${HOME:-/var/empty}" TMPDIR="${TMPDIR:-/tmp}" LANG=C LC_ALL=C \
      DATABASE_URL_MYSQL="${FORWARD_DATABASE_URL}" DB_DRIVER=mysql DR_RESTORE_KIND=mysql-forward \
      "${node_path}" "${bounded_runner}" --timeout-ms "${verify_timeout_ms}" --max-output-bytes "${phase_output_limit}" -- \
      "${new_verifier_snapshot}" >"${new_verifier_stdout}" 2>"${new_verifier_stderr}"
  fi
  new_verifier_status=$?
  set -e
  new_verifier_duration_ms=$(( $(milliseconds) - new_verifier_started_ms ))
  new_verifier_completed_at="$(iso_now)"
fi

if [ "${DB_DRIVER}" = postgres ]; then
  assert_directories_stable
  env -i PATH="${isolated_path}" HOME="${HOME:-/var/empty}" TMPDIR="${TMPDIR:-/tmp}" LANG=C LC_ALL=C \
    DR_MANIFEST_SIGNING_KEY="${manifest_signing_key}" DR_MANIFEST_KEY_ID="${DR_MANIFEST_KEY_ID}" DR_INCIDENT_AT="${DR_INCIDENT_AT}" \
    DATABASE_URL="${ROLLBACK_DATABASE_URL}" POSTGRES_BACKUP_FILE="${backup}" DR_ISOLATED_TARGET=1 DR_RESTORE_PHASE_STARTED_AT="$(iso_now)" \
    DR_VERIFY_COMMAND="${old_verifier_snapshot}" DR_EVIDENCE_FILE="${evidence_dir}/rollback-restore.json" \
    DR_RESTORE_TARGET_ID="${ROLLBACK_TARGET_ID}" DR_TARGET_RELEASE="${DR_OLD_RELEASE}" DR_REHEARSAL_ID="${DR_REHEARSAL_ID}" DR_REHEARSAL_NONCE="${rehearsal_nonce}" DR_REHEARSAL_PHASE=rollback DR_REHEARSAL_PREDECESSOR_SHA256="$(sha256_file "${evidence_dir}/forward-restore.json")" \
    "${node_path}" "${bounded_runner}" --timeout-ms "${restore_timeout_ms}" --max-output-bytes "${phase_output_limit}" -- "${script_dir}/restore-postgres.sh"
else
  assert_directories_stable
  env -i PATH="${isolated_path}" HOME="${HOME:-/var/empty}" TMPDIR="${TMPDIR:-/tmp}" LANG=C LC_ALL=C \
    DR_MANIFEST_SIGNING_KEY="${manifest_signing_key}" DR_MANIFEST_KEY_ID="${DR_MANIFEST_KEY_ID}" DR_INCIDENT_AT="${DR_INCIDENT_AT}" \
    DATABASE_URL_MYSQL="${ROLLBACK_DATABASE_URL}" MYSQL_BACKUP_FILE="${backup}" DR_ISOLATED_TARGET=1 DR_RESTORE_PHASE_STARTED_AT="$(iso_now)" \
    DR_VERIFY_COMMAND="${old_verifier_snapshot}" DR_EVIDENCE_FILE="${evidence_dir}/rollback-restore.json" \
    DR_RESTORE_TARGET_ID="${ROLLBACK_TARGET_ID}" DR_TARGET_RELEASE="${DR_OLD_RELEASE}" DR_REHEARSAL_ID="${DR_REHEARSAL_ID}" DR_REHEARSAL_NONCE="${rehearsal_nonce}" DR_REHEARSAL_PHASE=rollback DR_REHEARSAL_PREDECESSOR_SHA256="$(sha256_file "${evidence_dir}/forward-restore.json")" \
    "${node_path}" "${bounded_runner}" --timeout-ms "${restore_timeout_ms}" --max-output-bytes "${phase_output_limit}" -- "${script_dir}/restore-mysql.sh"
fi
run_identity_command rollback "${ROLLBACK_DATABASE_URL}" "${rollback_identity_file}"

test "$(sha256_file "${DR_OLD_VERSION_VERIFY_COMMAND}")" = "${old_verifier_sha256}" || { echo 'Old-version verifier changed during rehearsal' >&2; exit 1; }
test "$(sha256_file "${DR_NEW_VERSION_VERIFY_COMMAND}")" = "${new_verifier_sha256}" || { echo 'New-version verifier changed during rehearsal' >&2; exit 1; }
test "$(sha256_file "${DR_MIGRATION_COMMAND}")" = "${migration_command_sha256}" || { echo 'Migration command changed during rehearsal' >&2; exit 1; }
test "$(sha256_file "${DR_MIGRATION_ARTIFACT}")" = "${migration_artifact_sha256}" || { echo 'Migration artifact changed during rehearsal' >&2; exit 1; }
test "$(sha256_file "${migration_command_snapshot}")" = "${migration_command_sha256}" || { echo 'Executed migration command changed during rehearsal' >&2; exit 1; }
test "$(sha256_file "${migration_artifact_snapshot}")" = "${migration_artifact_sha256}" || { echo 'Executed migration artifact changed during rehearsal' >&2; exit 1; }
test "$(sha256_file "${old_verifier_snapshot}")" = "${old_verifier_sha256}" || { echo 'Executed old-version verifier changed during rehearsal' >&2; exit 1; }
test "$(sha256_file "${new_verifier_snapshot}")" = "${new_verifier_sha256}" || { echo 'Executed new-version verifier changed during rehearsal' >&2; exit 1; }
test "$(sha256_file "${database_identity_command_snapshot}")" = "${database_identity_command_sha256}" || { echo 'Executed database identity command changed during rehearsal' >&2; exit 1; }
test "$(sha256_file "${DR_OLD_RELEASE_MANIFEST}")" = "${old_release_manifest_sha256}" || { echo 'Old release manifest changed during rehearsal' >&2; exit 1; }
test "$(sha256_file "${DR_NEW_RELEASE_MANIFEST}")" = "${new_release_manifest_sha256}" || { echo 'New release manifest changed during rehearsal' >&2; exit 1; }

if [ "${DR_EXPECT_FORWARD_FAILURE:-0}" = 1 ]; then
  test "${migration_status}" -eq "${DR_EXPECTED_MIGRATION_EXIT_CODE}" || { echo 'Migration did not produce the exact injected failure exit code' >&2; exit 1; }
  test -f "${failure_result_file}" && test ! -L "${failure_result_file}" || { echo 'Migration did not emit an authenticated failure result' >&2; exit 1; }
  failure_result_json="$(INJECTION_MANIFEST="${failure_injection_manifest_snapshot}" RESULT_FILE="${failure_result_file}" CHALLENGE="${failure_challenge}" EXPECTED_EXIT="${DR_EXPECTED_MIGRATION_EXIT_CODE}" node <<'NODE'
const { readFileSync } = require('node:fs');
const injection = JSON.parse(readFileSync(process.env.INJECTION_MANIFEST, 'utf8'));
const result = JSON.parse(readFileSync(process.env.RESULT_FILE, 'utf8'));
if (result.schemaVersion !== 1 || result.id !== injection.id || result.type !== injection.type ||
    result.challenge !== process.env.CHALLENGE || String(result.exitCode) !== process.env.EXPECTED_EXIT ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(result.observedPoint ?? '') || Object.keys(result).length !== 6)
  throw new Error('Migration failure result does not match the one-time injection challenge');
process.stdout.write(JSON.stringify(result));
NODE
)"
  failure_evidence_json="$(INJECTION_MANIFEST="${failure_injection_manifest_snapshot}" RESULT="${failure_result_json}" CHALLENGE="${failure_challenge}" MANIFEST_SHA="${failure_injection_manifest_sha256}" node <<'NODE'
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const injection = JSON.parse(readFileSync(process.env.INJECTION_MANIFEST, 'utf8'));
process.stdout.write(JSON.stringify({id: injection.id, type: injection.type, manifestSha256: process.env.MANIFEST_SHA,
  challenge: process.env.CHALLENGE, challengeSha256: createHash('sha256').update(process.env.CHALLENGE).digest('hex'), result: JSON.parse(process.env.RESULT)}));
NODE
)"
  proof_mode=forward-failure-injected
else
  test "${migration_status}" -eq 0 || { echo 'Forward migration failed' >&2; exit "${migration_status}"; }
  test "${new_verifier_status}" -eq 0 || { echo 'New-version verification failed' >&2; exit "${new_verifier_status}"; }
  proof_mode=forward-success
  failure_evidence_json='null'
fi

proof_completed_at="$(iso_now)"
database_identities_json="$(SOURCE_IDENTITY="${source_identity_file}" FORWARD_IDENTITY="${forward_identity_file}" ROLLBACK_IDENTITY="${rollback_identity_file}" DRIVER="${DB_DRIVER}" node <<'NODE'
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const identities = {};
for (const role of ['source', 'forward', 'rollback']) {
  const bytes = readFileSync(process.env[`${role.toUpperCase()}_IDENTITY`]);
  const value = JSON.parse(bytes);
  if (value.schemaVersion !== 1 || value.driver !== process.env.DRIVER || value.role !== role ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value.physicalId ?? '') ||
      !/^[A-Za-z0-9][A-Za-z0-9_$.-]{0,127}$/.test(value.database ?? '') ||
      value.nonEmpty !== true || !/^[a-f0-9]{64}$/.test(value.stateDigest ?? '') || Object.keys(value).length !== 7)
    throw new Error(`database identity output is invalid for ${role}`);
  identities[role] = {...value, evidenceSha256: digest(bytes)};
}
if (new Set(Object.values(identities).map((value) => `${value.physicalId}/${value.database}`)).size !== 3)
  throw new Error('source, forward, and rollback must have distinct authenticated physical identities');
if (new Set(Object.values(identities).map((value) => value.stateDigest)).size !== 1)
  throw new Error('source, forward, and rollback reconciliation state digests differ');
process.stdout.write(JSON.stringify(identities));
NODE
)"
export DR_PROOF_DRIVER="${DB_DRIVER}" DR_PROOF_MODE="${proof_mode}"
export DR_PROOF_STARTED_AT="${proof_started_at}" DR_PROOF_COMPLETED_AT="${proof_completed_at}"
export DR_MIGRATION_EXIT_CODE="${migration_status}" DR_MIGRATION_DURATION_MS="${migration_duration_ms}"
export DR_MIGRATION_STARTED_AT="${migration_started_at}" DR_MIGRATION_COMPLETED_AT="${migration_completed_at}"
export DR_MIGRATION_STDOUT_SHA256="$(sha256_file "${migration_stdout}")" DR_MIGRATION_STDERR_SHA256="$(sha256_file "${migration_stderr}")"
export DR_NEW_VERIFIER_EXIT_CODE="${new_verifier_status}" DR_NEW_VERIFIER_DURATION_MS="${new_verifier_duration_ms}"
export DR_NEW_VERIFIER_STARTED_AT="${new_verifier_started_at}" DR_NEW_VERIFIER_COMPLETED_AT="${new_verifier_completed_at}"
export DR_NEW_VERIFIER_STDOUT_SHA256="$(sha256_file "${new_verifier_stdout}")" DR_NEW_VERIFIER_STDERR_SHA256="$(sha256_file "${new_verifier_stderr}")"
export DR_EVIDENCE_RESERVATION_TOKEN="${reservation_token}"
export DR_OLD_RELEASE_MANIFEST_SHA256="${old_release_manifest_sha256}" DR_NEW_RELEASE_MANIFEST_SHA256="${new_release_manifest_sha256}"
export DR_FAILURE_INJECTION_MANIFEST_SHA256="${failure_injection_manifest_sha256}" DR_EXPECTED_MIGRATION_EXIT_CODE="${DR_EXPECTED_MIGRATION_EXIT_CODE:-0}"
export DR_FAILURE_INJECTION_RESULT="${failure_evidence_json}" DR_REHEARSAL_NONCE="${rehearsal_nonce}"
export DR_DATABASE_IDENTITIES="${database_identities_json}"

verifier_arguments=(
  --evidence "${evidence_file}"
  --backup "${backup}"
  --backup-manifest "${backup}.manifest.json"
  --forward-receipt "${evidence_dir}/forward-restore.json"
  --rollback-receipt "${evidence_dir}/rollback-restore.json"
  --migration-command "${DR_MIGRATION_COMMAND}"
  --migration-artifact "${DR_MIGRATION_ARTIFACT}"
  --old-verifier "${DR_OLD_VERSION_VERIFY_COMMAND}"
  --new-verifier "${DR_NEW_VERSION_VERIFY_COMMAND}"
  --database-identity-command "${DR_DATABASE_IDENTITY_COMMAND}"
  --source-identity "${source_identity_file}"
  --forward-identity "${forward_identity_file}"
  --rollback-identity "${rollback_identity_file}"
  --old-release-manifest "${DR_OLD_RELEASE_MANIFEST}"
  --new-release-manifest "${DR_NEW_RELEASE_MANIFEST}"
  --expected-rehearsal-id "${DR_REHEARSAL_ID}"
  --expected-evidence-directory-identity "${evidence_directory_identity}"
)
if [ "${DR_EXPECT_FORWARD_FAILURE:-0}" = 1 ]; then
  verifier_arguments+=(--failure-injection-manifest "${DR_FAILURE_INJECTION_MANIFEST}")
fi
assert_directories_stable
DR_MANIFEST_SIGNING_KEY="${manifest_signing_key}" node "${root_dir}/scripts/verify-migration-rehearsal.mjs" --create "${verifier_arguments[@]}" >/dev/null
assert_directories_stable
printf 'Migration rehearsal passed; evidence: %s\n' "${evidence_file}"
