import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

export const GITHUB_BUILD_PROVENANCE_PREDICATE = 'https://slsa.dev/provenance/v1';
export const GITHUB_SPDX_PREDICATE = 'https://spdx.dev/Document/v2.3';

const REPOSITORY_PATTERN =
  /^[a-z0-9](?:[a-z0-9_.-]{0,98}[a-z0-9])?\/[a-z0-9](?:[a-z0-9_.-]{0,98}[a-z0-9])?$/u;
const SIGNER_WORKFLOW_PATTERN =
  /^[a-z0-9](?:[a-z0-9_.-]{0,98}[a-z0-9])?\/[a-z0-9](?:[a-z0-9_.-]{0,98}[a-z0-9])?\/\.github\/workflows\/[a-zA-Z0-9_.-]+\.ya?ml$/u;
const SOURCE_REF_PATTERN = /^refs\/(?:heads|tags)\/[a-zA-Z0-9][a-zA-Z0-9._/-]*$/u;
const SOURCE_DIGEST_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const PREDICATE_TYPE_PATTERN = /^https:\/\/[^\s]+$/u;

function hasControlCharacters(value) {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code <= 31 || code === 127;
  });
}

function requireSafeString(value, name, pattern) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    value.startsWith('-') ||
    hasControlCharacters(value) ||
    (pattern && !pattern.test(value))
  )
    throw new Error(`${name} is invalid`);
  return value;
}

export function githubAttestationVerifyArgs(subject, options) {
  const safeSubject = requireSafeString(subject, 'attestation subject');
  const repository = requireSafeString(
    options?.repository,
    'attestation repository',
    REPOSITORY_PATTERN,
  );
  const signerWorkflow = requireSafeString(
    options?.signerWorkflow,
    'attestation signer workflow',
    SIGNER_WORKFLOW_PATTERN,
  );
  if (!signerWorkflow.startsWith(`${repository}/.github/workflows/`))
    throw new Error('attestation signer workflow must belong to the repository');
  const sourceRef = requireSafeString(
    options?.sourceRef,
    'attestation source ref',
    SOURCE_REF_PATTERN,
  );
  if (sourceRef.includes('//') || sourceRef.includes('/../') || sourceRef.endsWith('/..'))
    throw new Error('attestation source ref is invalid');
  const sourceDigest = requireSafeString(
    options?.sourceDigest,
    'attestation source digest',
    SOURCE_DIGEST_PATTERN,
  );
  const args = [
    'attestation',
    'verify',
    safeSubject,
    '--repo',
    repository,
    '--signer-workflow',
    signerWorkflow,
    '--source-ref',
    sourceRef,
    '--source-digest',
    sourceDigest,
  ];
  if (options.predicateType)
    args.push(
      '--predicate-type',
      requireSafeString(
        options.predicateType,
        'attestation predicate type',
        PREDICATE_TYPE_PATTERN,
      ),
    );
  args.push('--deny-self-hosted-runners', '--format', 'json');
  return args;
}

function ghVersion(run) {
  let output;
  try {
    output = String(
      run('gh', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    );
  } catch (error) {
    throw new Error('GitHub CLI version check failed', { cause: error });
  }
  const match = /^gh version (\d+)\.(\d+)\.(\d+)\b/mu.exec(output);
  if (!match) throw new Error('GitHub CLI returned an unrecognized version');
  const version = match.slice(1).map(Number);
  if (version[0] < 2 || (version[0] === 2 && version[1] < 67))
    throw new Error(
      'GitHub CLI 2.67.0 or newer is required for fail-closed predicate verification',
    );
}

function expectedSubject(subject) {
  if (subject.startsWith('oci://')) {
    const match = /^oci:\/\/([^@]+)@sha256:([a-f0-9]{64})$/u.exec(subject);
    if (!match) throw new Error('OCI attestation subject must be an exact digest reference');
    return { digest: match[2], reference: match[1], digestReference: match[0].slice(6) };
  }
  return { digest: createHash('sha256').update(readFileSync(subject)).digest('hex') };
}

function subjectNameMatches(actual, expectedReference, expectedDigestReference) {
  if (!expectedReference) return true;
  return [
    expectedReference,
    expectedDigestReference,
    `pkg:docker/${expectedReference}`,
    `pkg:docker/${expectedDigestReference}`,
  ].includes(actual);
}

function verifyGithubAttestationResult(subject, options, run) {
  if (!options?.predicateType)
    throw new Error('attestation predicate type is required for fail-closed verification');
  if (
    options.predicateType === GITHUB_SPDX_PREDICATE &&
    (!options.expectedPredicate || typeof options.expectedPredicate !== 'object')
  )
    throw new Error('exact expected SPDX predicate is required for SBOM verification');
  const args = githubAttestationVerifyArgs(subject, options);
  let output;
  try {
    output = run('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    throw new Error(`GitHub attestation verification failed for ${subject}`, { cause: error });
  }
  let results;
  try {
    results = JSON.parse(String(output));
  } catch {
    throw new Error(`GitHub attestation verification returned invalid JSON for ${subject}`);
  }
  if (!Array.isArray(results) || results.length === 0)
    throw new Error(`GitHub attestation verification returned no results for ${subject}`);
  const expected = expectedSubject(subject);
  const matches = results.some((result) => {
    const statement = result?.verificationResult?.statement;
    return (
      statement?.predicateType === options.predicateType &&
      (options.expectedPredicate === undefined ||
        isDeepStrictEqual(statement.predicate, options.expectedPredicate)) &&
      Array.isArray(statement.subject) &&
      statement.subject.some(
        (candidate) =>
          candidate?.digest?.sha256 === expected.digest &&
          subjectNameMatches(candidate?.name, expected.reference, expected.digestReference),
      )
    );
  });
  if (!matches)
    throw new Error(
      `GitHub attestation result does not bind the expected subject and predicate for ${subject}`,
    );
  return results;
}

export function createGithubAttestationVerifier(run = execFileSync) {
  ghVersion(run);
  return (subject, options) => verifyGithubAttestationResult(subject, options, run);
}

export function verifyGithubAttestation(subject, options, run = execFileSync) {
  return createGithubAttestationVerifier(run)(subject, options);
}
