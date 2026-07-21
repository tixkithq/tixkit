import assert from 'node:assert/strict';
import {
  chmodSync,
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  parseApiReleaseCandidateOptions,
  verifyApiReleaseCandidate,
} from '../verify-api-release-candidate.mjs';

const root = resolve(import.meta.dirname, '../..');
const verifier = resolve(root, 'scripts/verify-public-api-release.mjs');
const immutableFixtureRoot = mkdtempSync(resolve(tmpdir(), 'tixkit-verifier-contracts-'));
const contracts = resolve(immutableFixtureRoot, '2026-01-01');
cpSync(resolve(root, 'artifacts/api/2026-01-01'), contracts, {
  recursive: true,
});

function runVerifier(mode) {
  const fixture = mkdtempSync(resolve(tmpdir(), 'tixkit-verifier-test-'));
  const bin = resolve(fixture, 'bin');
  mkdirSync(bin);
  const publicReleaseManifest = resolve(fixture, 'public-release-manifest.json');
  const publicReleaseChecksums = resolve(fixture, 'CHECKSUMS.sha256');
  const publicReleaseSbom = resolve(fixture, 'npm-packages.spdx.json');
  const manifestBytes = Buffer.from(
    `${JSON.stringify({
      schemaVersion: 1,
      releaseVersion: '1.2.3',
      core: {
        sourceCommit: mode === 'public-source' ? 'b'.repeat(40) : 'a'.repeat(40),
        packages: [
          {
            name: '@tixkit/js',
            version: mode === 'public-package-pin' ? '9.9.9' : '1.2.3',
            integrity: 'sha512-good',
          },
          { name: '@tixkit/contract-tests', version: '1.2.3', integrity: 'sha512-good' },
        ],
      },
    })}\n`,
  );
  const sbomBytes = Buffer.from(
    `${JSON.stringify({ spdxVersion: 'SPDX-2.3', name: 'public-packages' })}\n`,
  );
  writeFileSync(publicReleaseManifest, manifestBytes);
  writeFileSync(publicReleaseSbom, sbomBytes);
  const emptySha256 = createHash('sha256').update('').digest('hex');
  writeFileSync(
    publicReleaseChecksums,
    [
      `${createHash('sha256').update(manifestBytes).digest('hex')}  public-release-manifest.json`,
      `${createHash('sha256').update(sbomBytes).digest('hex')}  npm-packages.spdx.json`,
      `${emptySha256}  tixkit-js.tgz`,
      `${emptySha256}  tixkit-contract-tests.tgz`,
    ].join('\n') + '\n',
  );
  const preload = resolve(fixture, 'preload.mjs');
  writeFileSync(
    preload,
    `import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
globalThis.fetch = async (url) => {
  const name = basename(new URL(url).pathname);
  if (process.env.VERIFIER_MODE === 'missing' && name === 'openapi.json') return new Response('', { status: 404 });
  let bytes = await readFile(join(process.env.VERIFIER_CONTRACTS, name));
  if (process.env.VERIFIER_MODE === 'trusted-mismatch' && name === 'CHECKSUMS.sha256') bytes = Buffer.concat([bytes, Buffer.from('\\n')]);
  return new Response(bytes, { status: 200 });
};
`,
  );
  const gh = resolve(bin, 'gh');
  writeFileSync(
    gh,
    `#!/bin/sh
if [ "$1" = '--version' ]; then
  echo 'gh version 2.67.0 (test)'
  exit 0
fi
[ "$VERIFIER_MODE" = 'attestation' ] && exit 17
subject="$3"
predicate='https://slsa.dev/provenance/v1'
while [ "$1" != '' ]; do
  if [ "$1" = '--predicate-type' ]; then predicate="$2"; break; fi
  shift
done
if command -v shasum >/dev/null 2>&1; then
  digest="$(shasum -a 256 "$subject" | awk '{print $1}')"
else
  digest="$(sha256sum "$subject" | awk '{print $1}')"
fi
if [ "$predicate" = 'https://spdx.dev/Document/v2.3' ]; then
  if [ "$VERIFIER_MODE" = 'sbom-predicate' ]; then
    predicate_json='{"spdxVersion":"SPDX-2.3","name":"substituted"}'
  else
    predicate_json="$(cat "$VERIFIER_PUBLIC_SBOM")"
  fi
else
  predicate_json='{}'
fi
printf '[{"verificationResult":{"statement":{"predicateType":"%s","predicate":%s,"subject":[{"name":"fixture","digest":{"sha256":"%s"}}]}}}]\n' "$predicate" "$predicate_json" "$digest"
`,
  );
  chmodSync(gh, 0o755);
  const npm = resolve(bin, 'npm');
  writeFileSync(
    npm,
    `#!/bin/sh
case "$1" in
  view)
    case "$2" in
      @tixkit/js@*) name='@tixkit/js' ;;
      *) name='@tixkit/contract-tests' ;;
    esac
    version="\${2##*@}"
    printf '{"name":"%s","version":"%s","dist.integrity":"sha512-good"}\\n' "$name" "$version"
    ;;
  pack)
    spec="$2"
    shift 2
    while [ "$1" != '' ]; do
      if [ "$1" = '--pack-destination' ]; then destination="$2"; break; fi
      shift
    done
    case "$spec" in
      @tixkit/js@*) filename='tixkit-js.tgz' ;;
      *) filename='tixkit-contract-tests.tgz' ;;
    esac
    : > "$destination/$filename"
    integrity='sha512-good'
    [ "$VERIFIER_MODE" = 'registry-integrity' ] && integrity='sha512-wrong'
    printf '[{"filename":"%s","integrity":"%s"}]\\n' "$filename" "$integrity"
    ;;
  install) exit 0 ;;
  audit) [ "$VERIFIER_MODE" = 'signature' ] && exit 23; exit 0 ;;
esac
`,
  );
  chmodSync(npm, 0o755);
  const node = resolve(bin, 'node');
  writeFileSync(node, '#!/bin/sh\n[ "$VERIFIER_MODE" = "consumer" ] && exit 29\nexit 0\n');
  chmodSync(node, 0o755);
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      preload,
      verifier,
      '--contracts-url',
      'https://contracts.example.test/2026-01-01/',
      '--sdk-spec',
      '@tixkit/js@1.2.3',
      '--contract-tests-spec',
      '@tixkit/contract-tests@1.2.3',
      '--trusted-contracts-root',
      immutableFixtureRoot,
      '--repository',
      'tixkit/tixkit',
      '--signer-workflow',
      'tixkit/tixkit/.github/workflows/api-contract-release.yml',
      '--source-ref',
      'refs/tags/v1.2.3',
      '--source-digest',
      'a'.repeat(40),
      '--public-release-manifest',
      publicReleaseManifest,
      '--public-release-checksums',
      publicReleaseChecksums,
      '--public-release-sbom',
      publicReleaseSbom,
    ],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH}`,
        VERIFIER_CONTRACTS: contracts,
        VERIFIER_MODE: mode,
        VERIFIER_PUBLIC_SBOM: publicReleaseSbom,
      },
    },
  );
  rmSync(fixture, { recursive: true, force: true });
  return result;
}

test('fails when a public trust root file differs from the protected tag', () => {
  const result = runVerifier('trusted-mismatch');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not match the protected tag/u);
});

test('fails when a manifest artifact is absent', () => {
  const result = runVerifier('missing');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unable to download openapi\.json: HTTP 404/u);
});

test('fails when provenance attestation verification fails', () => {
  const result = runVerifier('attestation');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Command failed/u);
});

test('fails when registry pack integrity differs from registry metadata', () => {
  const result = runVerifier('registry-integrity');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /integrity does not match/u);
});

test('fails when npm registry signature verification fails', () => {
  const result = runVerifier('signature');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Command failed/u);
});

test('fails when the packed SDK consumer contract process detects a mismatch', () => {
  const result = runVerifier('consumer');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Command failed/u);
});

test('fails when registry package coordinates are absent from the tag-owned public release', () => {
  const result = runVerifier('public-package-pin');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not pin @tixkit\/js@1\.2\.3/u);
});

test('fails when the public package trust root is bound to another source commit', () => {
  const result = runVerifier('public-source');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /package trust root is invalid/u);
});

test('fails when the signed package SBOM differs from the released SPDX document', () => {
  const result = runVerifier('sbom-predicate');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not bind the expected subject and predicate/u);
});

test('API publication and post-publication verification bind exact provenance identity', () => {
  const releaseWorkflow = readFileSync(
    resolve(root, '.github/workflows/api-contract-release.yml'),
    'utf8',
  );
  const postPublicationWorkflow = readFileSync(
    resolve(root, '.github/workflows/api-post-publication-verify.yml'),
    'utf8',
  );
  assert.match(releaseWorkflow, /github\.ref_type == 'tag'/u);
  assert.match(
    releaseWorkflow,
    /node scripts\/verify-api-release-candidate\.mjs[\s\S]*--signer-workflow "\$GITHUB_REPOSITORY\/\.github\/workflows\/api-contract-release\.yml"[\s\S]*--source-ref "\$GITHUB_REF"[\s\S]*--source-digest "\$GITHUB_SHA"/u,
  );
  assert.doesNotMatch(releaseWorkflow, /gh attestation verify/u);
  assert.match(
    postPublicationWorkflow,
    /--signer-workflow "\$\{\{ github\.repository \}\}\/\.github\/workflows\/api-contract-release\.yml"/u,
  );
  assert.match(
    postPublicationWorkflow,
    /--source-ref "refs\/tags\/\$\{\{ inputs\.release_tag \}\}"/u,
  );
  assert.match(
    postPublicationWorkflow,
    /--source-digest "\$\{\{ steps\.tag\.outputs\.commit \}\}"/u,
  );
  assert.match(
    postPublicationWorkflow,
    /gh release download "\$\{\{ inputs\.release_tag \}\}"[\s\S]*--pattern public-release-manifest\.json[\s\S]*--pattern CHECKSUMS\.sha256[\s\S]*--pattern npm-packages\.spdx\.json/u,
  );
  assert.match(
    postPublicationWorkflow,
    /--public-release-manifest public-release-trust\/public-release-manifest\.json[\s\S]*--public-release-checksums public-release-trust\/CHECKSUMS\.sha256[\s\S]*--public-release-sbom public-release-trust\/npm-packages\.spdx\.json/u,
  );
});

test('API candidate verifier consumes exact provenance for every regular candidate file', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'tixkit-api-candidate-'));
  const calls = [];
  try {
    writeFileSync(join(directory, 'release-manifest.json'), '{}\n');
    writeFileSync(join(directory, 'CHECKSUMS.sha256'), 'fixture\n');
    const options = parseApiReleaseCandidateOptions([
      '--directory',
      directory,
      '--repository',
      'tixkit/tixkit',
      '--signer-workflow',
      'tixkit/tixkit/.github/workflows/api-contract-release.yml',
      '--source-ref',
      'refs/tags/v1.2.3',
      '--source-digest',
      'a'.repeat(40),
    ]);
    const result = verifyApiReleaseCandidate(options, (_command, arguments_) => {
      calls.push(arguments_);
      if (arguments_[0] === '--version') return 'gh version 2.67.0\n';
      const subject = arguments_[2];
      return JSON.stringify([
        {
          verificationResult: {
            statement: {
              predicateType: 'https://slsa.dev/provenance/v1',
              subject: [
                {
                  digest: {
                    sha256: createHash('sha256').update(readFileSync(subject)).digest('hex'),
                  },
                },
              ],
            },
          },
        },
      ]);
    });
    assert.deepEqual(result, { files: 2 });
    assert.equal(calls.length, 3);
    assert.deepEqual(
      calls
        .slice(1)
        .map((arguments_) => arguments_[2])
        .sort(),
      readdirSync(directory)
        .map((name) => join(realpathSync(directory), name))
        .sort(),
    );
    assert.ok(calls.slice(1).every((arguments_) => arguments_.includes('--format')));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('API candidate verifier rejects symlink entries and substituted authority options', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'tixkit-api-candidate-'));
  const outside = join(directory, '..', `outside-${Date.now()}`);
  try {
    writeFileSync(outside, 'outside');
    symlinkSync(outside, join(directory, 'release-manifest.json'));
    assert.throws(
      () =>
        verifyApiReleaseCandidate(
          {
            directory,
            repository: 'tixkit/tixkit',
            signerWorkflow: 'tixkit/tixkit/.github/workflows/api-contract-release.yml',
            sourceRef: 'refs/tags/v1.2.3',
            sourceDigest: 'a'.repeat(40),
          },
          () => '',
        ),
      /regular files/u,
    );
    assert.throws(() =>
      parseApiReleaseCandidateOptions([
        '--directory',
        directory,
        '--repository',
        'tixkit/tixkit',
        '--signer-workflow',
        'attacker/repo/.github/workflows/release.yml',
        '--source-ref',
        'refs/heads/main',
        '--source-digest',
        'A'.repeat(40),
      ]),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(outside, { force: true });
  }
});
