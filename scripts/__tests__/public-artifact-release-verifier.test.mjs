import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  GITHUB_BUILD_PROVENANCE_PREDICATE,
  GITHUB_SPDX_PREDICATE,
  githubAttestationVerifyArgs,
  verifyGithubAttestation,
} from '../lib/github-attestation.mjs';
import {
  parsePublicArtifactReleaseOptions,
  verifyExistingPublicReleaseAssets,
  verifyPublicArtifactRelease,
} from '../verify-public-artifact-release.mjs';

const repository = 'tixkit/tixkit';
const sourceRef = 'refs/tags/v1.2.3';
const sourceDigest = 'a'.repeat(40);
const digest = `sha256:${'b'.repeat(64)}`;

function fixture(layout = 'nested') {
  const directory = mkdtempSync(join(tmpdir(), 'tixkit-attestation-verifier-'));
  writeFileSync(
    join(directory, 'images.json'),
    `${JSON.stringify([{ name: 'api', reference: `ghcr.io/tixkit/tixkit-api@${digest}`, digest }])}\n`,
  );
  writeFileSync(join(directory, 'public-release-manifest.json'), '{}\n');
  writeFileSync(
    join(directory, 'npm-packages.spdx.json'),
    JSON.stringify({ spdxVersion: 'SPDX-2.3', name: 'npm-packages' }),
  );
  writeFileSync(
    join(directory, 'image-api.spdx.json'),
    JSON.stringify({ spdxVersion: 'SPDX-2.3', name: 'image-api' }),
  );
  if (layout === 'nested') {
    mkdirSync(join(directory, 'packages'));
    writeFileSync(join(directory, 'packages', 'tixkit-api-1.2.3.tgz'), 'package');
  } else writeFileSync(join(directory, 'tixkit-api-1.2.3.tgz'), 'package');
  return directory;
}

function options(directory) {
  return {
    directory,
    repository,
    signerWorkflow: 'tixkit/tixkit/.github/workflows/public-artifact-release.yml',
    sourceRef,
    sourceDigest,
  };
}

function successfulRun(calls = []) {
  return (command, args, execution) => {
    calls.push({ command, args, execution });
    if (args[0] === '--version') return 'gh version 2.67.0 (2026-01-01)\n';
    const subject = args[2];
    const predicateType = args[args.indexOf('--predicate-type') + 1];
    const oci = /^oci:\/\/([^@]+)@sha256:([a-f0-9]{64})$/u.exec(subject);
    const subjectRecord = oci
      ? { name: `pkg:docker/${oci[1]}@sha256:${oci[2]}`, digest: { sha256: oci[2] } }
      : {
          name: 'artifact',
          digest: { sha256: createHash('sha256').update(readFileSync(subject)).digest('hex') },
        };
    let predicate = { buildDefinition: {} };
    if (predicateType === GITHUB_SPDX_PREDICATE) {
      const root = fixtureRootFromCalls(calls);
      predicate = JSON.parse(
        readFileSync(join(root, oci ? 'image-api.spdx.json' : 'npm-packages.spdx.json'), 'utf8'),
      );
    }
    return JSON.stringify([
      {
        verificationResult: {
          statement: { predicateType, predicate, subject: [subjectRecord] },
        },
      },
    ]);
  };
}

function fixtureRootFromCalls(calls) {
  const fileCall = calls.find(
    ({ args }) => args[0] === 'attestation' && !args[2].startsWith('oci://'),
  );
  const fileDirectory = dirname(fileCall.args[2]);
  return fileDirectory.endsWith('/packages') ? dirname(fileDirectory) : fileDirectory;
}

test('githubAttestationVerifyArgs emits the exact fail-closed authority argv', () => {
  assert.deepEqual(
    githubAttestationVerifyArgs('/tmp/release.tgz', {
      repository,
      signerWorkflow: 'tixkit/tixkit/.github/workflows/public-artifact-release.yml',
      sourceRef,
      sourceDigest,
      predicateType: GITHUB_SPDX_PREDICATE,
    }),
    [
      'attestation',
      'verify',
      '/tmp/release.tgz',
      '--repo',
      repository,
      '--signer-workflow',
      'tixkit/tixkit/.github/workflows/public-artifact-release.yml',
      '--source-ref',
      sourceRef,
      '--source-digest',
      sourceDigest,
      '--predicate-type',
      'https://spdx.dev/Document/v2.3',
      '--deny-self-hosted-runners',
      '--format',
      'json',
    ],
  );
});

test('verifies every nested-layout file and npm and OCI predicates with exact argv', () => {
  const directory = fixture();
  const calls = [];
  try {
    const result = verifyPublicArtifactRelease(options(directory), successfulRun(calls));
    assert.deepEqual(result, { files: 5, npmTarballs: 1, images: 1 });
    assert.equal(calls.length, 9);
    assert.ok(calls.every(({ command }) => command === 'gh'));
    const verifications = calls.filter(({ args }) => args[0] === 'attestation');
    assert.ok(verifications.every(({ args }) => args.includes('--deny-self-hosted-runners')));
    assert.ok(
      verifications.every(({ args }) => args.includes('--format') && args.includes('json')),
    );
    assert.ok(verifications.every(({ args }) => args.includes(repository)));
    assert.ok(verifications.every(({ args }) => args.includes(sourceRef)));
    assert.ok(verifications.every(({ args }) => args.includes(sourceDigest)));
    assert.ok(
      verifications.every(({ args }) =>
        args.includes('tixkit/tixkit/.github/workflows/public-artifact-release.yml'),
      ),
    );
    assert.equal(
      verifications.filter(({ args }) => args.includes(GITHUB_BUILD_PROVENANCE_PREDICATE)).length,
      6,
    );
    assert.equal(
      verifications.filter(({ args }) => args.includes(GITHUB_SPDX_PREDICATE)).length,
      2,
    );
    assert.ok(
      verifications.some(({ args }) => args[2] === `oci://ghcr.io/tixkit/tixkit-api@${digest}`),
    );
    assert.ok(verifications.every(({ execution }) => execution.stdio[0] === 'ignore'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('supports resumed flat npm tarballs', () => {
  const directory = fixture('flat');
  try {
    assert.deepEqual(verifyPublicArtifactRelease(options(directory), successfulRun()), {
      files: 5,
      npmTarballs: 1,
      images: 1,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('provenance-verifies incomplete existing draft assets before safe classification', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tixkit-incomplete-attestation-'));
  const calls = [];
  try {
    writeFileSync(join(directory, 'public-release-manifest.json'), '{}\n');
    assert.deepEqual(verifyExistingPublicReleaseAssets(options(directory), successfulRun(calls)), {
      files: 1,
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].args[2], realpathSync(join(directory, 'public-release-manifest.json')));
    assert.ok(calls[1].args.includes(GITHUB_BUILD_PROVENANCE_PREDICATE));
    assert.equal(calls[1].args.includes(GITHUB_SPDX_PREDICATE), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('propagates gh verification failure as a fail-closed release error', () => {
  const directory = fixture();
  try {
    assert.throws(
      () =>
        verifyPublicArtifactRelease(options(directory), (_command, args) => {
          if (args[0] === '--version') return 'gh version 2.67.0\n';
          throw new Error('substituted signer');
        }),
      /GitHub attestation verification failed/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects malformed, tagged, foreign, mismatched, and extra-field OCI records', () => {
  for (const image of [
    { name: 'api', reference: 'ghcr.io/tixkit/tixkit-api:latest', digest },
    { name: 'api', reference: `ghcr.io/attacker/tixkit-api@${digest}`, digest },
    { name: 'api', reference: `ghcr.io/tixkit/tixkit-api@sha256:${'c'.repeat(64)}`, digest },
    { name: 'api', reference: `ghcr.io/tixkit/tixkit-api@${digest}`, digest, tag: 'latest' },
  ]) {
    const directory = fixture();
    try {
      writeFileSync(join(directory, 'images.json'), JSON.stringify([image]));
      assert.throws(
        () => verifyPublicArtifactRelease(options(directory), successfulRun()),
        /images\.json/u,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('rejects symlinks, path-bearing package entries, mixed layouts, and unknown directories', () => {
  const outside = mkdtempSync(join(tmpdir(), 'tixkit-attestation-outside-'));
  writeFileSync(join(outside, 'asset'), 'outside');
  for (const mutate of [
    (directory) => symlinkSync(join(outside, 'asset'), join(directory, 'linked.json')),
    (directory) => {
      mkdirSync(join(directory, 'packages', 'nested'));
    },
    (directory) => writeFileSync(join(directory, 'flat.tgz'), 'mixed'),
    (directory) => mkdirSync(join(directory, 'unknown')),
  ]) {
    const directory = fixture();
    try {
      mutate(directory);
      assert.throws(
        () => verifyPublicArtifactRelease(options(directory), successfulRun()),
        /symlink|packages|layout|directory/u,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  rmSync(outside, { recursive: true, force: true });
});

test('strict CLI parsing rejects signer, source, predicate, option, and argv substitutions', () => {
  const valid = [
    '--directory',
    '/tmp/release',
    '--repository',
    repository,
    '--signer-workflow',
    'tixkit/tixkit/.github/workflows/public-artifact-release.yml',
    '--source-ref',
    sourceRef,
    '--source-digest',
    sourceDigest,
  ];
  assert.equal(parsePublicArtifactReleaseOptions(valid).repository, repository);
  assert.equal(
    parsePublicArtifactReleaseOptions([...valid, '--existing-assets-only']).existingAssetsOnly,
    true,
  );
  for (const argv of [
    valid.map((value) =>
      value === 'tixkit/tixkit/.github/workflows/public-artifact-release.yml'
        ? 'attacker/repo/.github/workflows/release.yml'
        : value,
    ),
    valid.map((value) => (value === sourceRef ? 'refs/heads/main' : value)),
    valid.map((value) => (value === sourceDigest ? 'A'.repeat(40) : value)),
    valid.map((value) => (value === repository ? 'attacker/repo\n--source-ref' : value)),
    [...valid, '--repository', repository],
    valid.slice(0, -1),
  ])
    assert.throws(() => parsePublicArtifactReleaseOptions(argv));
});

test('helper rejects signer, repository, source ref, source digest, predicate, and subject substitutions', () => {
  const valid = {
    repository,
    signerWorkflow: 'tixkit/tixkit/.github/workflows/public-artifact-release.yml',
    sourceRef,
    sourceDigest,
    predicateType: GITHUB_BUILD_PROVENANCE_PREDICATE,
  };
  for (const [field, value] of [
    ['signerWorkflow', 'attacker/repo/.github/workflows/public-artifact-release.yml'],
    ['repository', 'tixkit/tixkit\n--repo=attacker/repo'],
    ['sourceRef', 'refs/tags/v1.2.3/../evil'],
    ['sourceDigest', 'A'.repeat(40)],
    ['predicateType', '--format=json'],
  ])
    assert.throws(() => githubAttestationVerifyArgs('/tmp/artifact', { ...valid, [field]: value }));
  assert.throws(() => githubAttestationVerifyArgs('--repo', valid));
});

test('fails closed for old gh, empty JSON, malformed JSON, wrong predicates, and wrong subjects', () => {
  const directory = fixture('flat');
  const subject = join(directory, 'tixkit-api-1.2.3.tgz');
  const authority = {
    repository,
    signerWorkflow: 'tixkit/tixkit/.github/workflows/public-artifact-release.yml',
    sourceRef,
    sourceDigest,
    predicateType: GITHUB_SPDX_PREDICATE,
    expectedPredicate: { spdxVersion: 'SPDX-2.3', name: 'expected' },
  };
  const verificationOutput = (predicateType, subjectRecord) =>
    JSON.stringify([
      {
        verificationResult: {
          statement: {
            predicateType,
            predicate: { spdxVersion: 'SPDX-2.3', name: 'expected' },
            subject: [subjectRecord],
          },
        },
      },
    ]);
  const expectedDigest = createHash('sha256').update(readFileSync(subject)).digest('hex');
  try {
    for (const [version, output] of [
      [
        'gh version 2.66.1\n',
        verificationOutput(GITHUB_SPDX_PREDICATE, { digest: { sha256: expectedDigest } }),
      ],
      ['gh version 2.67.0\n', '[]'],
      ['gh version 2.67.0\n', 'not-json'],
      [
        'gh version 2.67.0\n',
        verificationOutput(GITHUB_BUILD_PROVENANCE_PREDICATE, {
          digest: { sha256: expectedDigest },
        }),
      ],
      [
        'gh version 2.67.0\n',
        verificationOutput(GITHUB_SPDX_PREDICATE, {
          digest: { sha256: 'c'.repeat(64) },
        }),
      ],
      [
        'gh version 2.67.0\n',
        JSON.stringify([
          {
            verificationResult: {
              statement: {
                predicateType: GITHUB_SPDX_PREDICATE,
                predicate: { spdxVersion: 'SPDX-2.3', name: 'substituted' },
                subject: [{ digest: { sha256: expectedDigest } }],
              },
            },
          },
        ]),
      ],
    ])
      assert.throws(() =>
        verifyGithubAttestation(subject, authority, (_command, args) =>
          args[0] === '--version' ? version : output,
        ),
      );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('OCI JSON evidence must bind both the exact reference name and digest', () => {
  const subject = `oci://ghcr.io/tixkit/tixkit-api@${digest}`;
  const authority = {
    repository,
    signerWorkflow: 'tixkit/tixkit/.github/workflows/public-artifact-release.yml',
    sourceRef,
    sourceDigest,
    predicateType: GITHUB_BUILD_PROVENANCE_PREDICATE,
  };
  for (const candidate of [
    { name: 'ghcr.io/attacker/tixkit-api', digest: { sha256: digest.slice(7) } },
    { name: 'ghcr.io/tixkit/tixkit-api', digest: { sha256: 'c'.repeat(64) } },
  ])
    assert.throws(() =>
      verifyGithubAttestation(subject, authority, (_command, args) =>
        args[0] === '--version'
          ? 'gh version 2.67.0\n'
          : JSON.stringify([
              {
                verificationResult: {
                  statement: {
                    predicateType: GITHUB_BUILD_PROVENANCE_PREDICATE,
                    subject: [candidate],
                  },
                },
              },
            ]),
      ),
    );
});

test('release verification rejects substituted npm and image SPDX predicate documents', () => {
  for (const substitute of ['npm', 'image']) {
    const directory = fixture();
    const calls = [];
    const validRun = successfulRun(calls);
    try {
      assert.throws(
        () =>
          verifyPublicArtifactRelease(options(directory), (command, args, execution) => {
            const output = validRun(command, args, execution);
            const isSpdx = args.includes(GITHUB_SPDX_PREDICATE);
            const isImage = args[2]?.startsWith('oci://');
            if (
              args[0] === 'attestation' &&
              isSpdx &&
              ((substitute === 'image' && isImage) || (substitute === 'npm' && !isImage))
            ) {
              const results = JSON.parse(output);
              results[0].verificationResult.statement.predicate.name = 'substituted';
              return JSON.stringify(results);
            }
            return output;
          }),
        /does not bind the expected subject and predicate/u,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});
