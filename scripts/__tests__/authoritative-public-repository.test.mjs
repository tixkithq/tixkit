import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  assertAuthoritativePublicRepository,
  authoritativeApiVersion,
  canonicalGitHubRepository,
} from '../lib/authoritative-public-repository.mjs';

test('normalizes only supported GitHub repository remotes', () => {
  assert.equal(
    canonicalGitHubRepository('https://github.com/Tixkit/Tixkit.git'),
    'github.com/tixkit/tixkit',
  );
  assert.equal(
    canonicalGitHubRepository('git@github.com:tixkit/tixkit.git'),
    'github.com/tixkit/tixkit',
  );
  assert.equal(
    canonicalGitHubRepository('ssh://git@github.com/tixkit/tixkit.git'),
    'github.com/tixkit/tixkit',
  );
  assert.equal(canonicalGitHubRepository('https://example.com/tixkit/tixkit.git'), undefined);
  assert.equal(canonicalGitHubRepository('file:///tmp/tixkit'), undefined);
});

test('selects only the live raw OpenAPI declaration and ignores commented decoys', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tixkit-api-version-'));
  const sourceDirectory = join(directory, 'packages/openapi/src');
  mkdirSync(sourceDirectory, { recursive: true });
  const sourcePath = join(sourceDirectory, 'index.ts');
  try {
    mkdirSync(join(directory, 'distribution'), { recursive: true });
    mkdirSync(join(directory, 'apps/docs/public'), { recursive: true });
    mkdirSync(join(directory, 'artifacts/api/2026-07-18'), { recursive: true });
    writeFileSync(
      join(directory, 'distribution/public-distribution.json'),
      `${JSON.stringify({ release: { contracts: ['artifacts/api/2026-07-18'] } })}\n`,
    );
    const generatedOpenApi = `${JSON.stringify({ info: { version: '2026-07-18' } })}\n`;
    writeFileSync(join(directory, 'apps/docs/public/openapi.json'), generatedOpenApi);
    writeFileSync(join(directory, 'artifacts/api/2026-07-18/openapi.json'), generatedOpenApi);
    writeFileSync(
      sourcePath,
      `// const rawOpenApiSpec = { info: { version: '2026-01-01' } };
/* const rawOpenApiSpec = { info: { version: '2026-01-02' } }; */
const rawOpenApiSpec = {
  openapi: '3.1.0',
  info: { title: 'Tixkit API', version: '2026-07-18' },
};
`,
    );
    assert.equal(authoritativeApiVersion(directory), '2026-07-18');

    writeFileSync(
      sourcePath,
      `const documentation = \`const rawOpenApiSpec = { info: { version: '2026-01-01' } };\`;
const rawOpenApiSpec = { info: { version: '2026-07-18' } };
`,
    );
    assert.equal(authoritativeApiVersion(directory), '2026-07-18');

    writeFileSync(
      sourcePath,
      `if (false) { const rawOpenApiSpec = { info: { version: '2026-01-01' } }; }
const rawOpenApiSpec = { info: { version: '2026-07-18' } };
`,
    );
    assert.throws(
      () => authoritativeApiVersion(directory),
      /must declare rawOpenApiSpec exactly once/u,
    );

    writeFileSync(
      sourcePath,
      `const current = { info: { version: '2026-07-18' } };
const rawOpenApiSpec = {
  info: { version: '2026-01-01' },
  ...current,
};
`,
    );
    assert.throws(
      () => authoritativeApiVersion(directory),
      /must use a canonical property-only object shape/u,
    );

    writeFileSync(
      sourcePath,
      `const rawOpenApiSpec = { info: { version: '2026-01-01' } };
rawOpenApiSpec.info.version = '2026-07-18';
`,
    );
    assert.throws(
      () => authoritativeApiVersion(directory),
      /source version 2026-01-01 differs from the first release contract artifacts\/api\/2026-07-18/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects provenance rebinding unless every authoritative public-root invariant holds', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tixkit-public-authority-'));
  const git = (arguments_, options = {}) =>
    execFileSync('/usr/bin/git', arguments_, { cwd: directory, ...options });
  const commit = (message) =>
    git([
      '-c',
      'user.name=Tixkit Test',
      '-c',
      'user.email=test@tixkit.invalid',
      'commit',
      '-qm',
      message,
    ]);
  try {
    git(['init', '-q']);
    git(['remote', 'add', 'origin', 'https://github.com/tixkit/tixkit.git']);
    mkdirSync(join(directory, 'distribution'));
    writeFileSync(
      join(directory, 'distribution/public-distribution.json'),
      `${JSON.stringify({
        classification: {
          topLevel: { privateCloud: [], internalPlanning: [] },
          docs: { internalPlanning: [] },
          historical: { privateCloud: [], internalPlanning: [] },
        },
      })}\n`,
    );
    writeFileSync(join(directory, 'README.md'), '# Public\n');
    git(['add', '-A']);
    commit('Initial public tree');

    writeFileSync(join(directory, 'SECOND.md'), '# Second\n');
    git(['add', 'SECOND.md']);
    commit('Second public commit');
    git(['replace', 'HEAD', 'HEAD^']);
    assert.throws(
      () => assertAuthoritativePublicRepository(directory),
      /forbids Git replacement references/u,
    );
    git(['replace', '-d', 'HEAD']);

    for (const [flag, clear] of [
      ['--assume-unchanged', '--no-assume-unchanged'],
      ['--skip-worktree', '--no-skip-worktree'],
    ]) {
      git(['update-index', flag, 'README.md']);
      assert.throws(
        () => assertAuthoritativePublicRepository(directory),
        /forbids assume-unchanged or skip-worktree paths/u,
      );
      git(['update-index', clear, 'README.md']);
    }

    writeFileSync(join(directory, 'README.md'), '# Dirty\n');
    assert.throws(
      () => assertAuthoritativePublicRepository(directory),
      /requires a clean authoritative public tree/u,
    );
    git(['restore', 'README.md']);

    const manifestPath = join(directory, 'distribution/public-distribution.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.classification.topLevel.privateCloud = ['managed'];
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    git(['add', manifestPath]);
    commit('Spoof private classification');
    assert.throws(
      () => assertAuthoritativePublicRepository(directory),
      /requires a public-only classification/u,
    );
    git(['reset', '--hard', 'HEAD^'], { stdio: 'ignore' });

    const transitionalPath = join(directory, 'scripts/__tests__/export-oss.test.mjs');
    mkdirSync(join(directory, 'scripts/__tests__'), { recursive: true });
    writeFileSync(transitionalPath, "import test from 'node:test';\n");
    git(['add', transitionalPath]);
    commit('Spoof public classification with transitional tooling');
    assert.throws(
      () => assertAuthoritativePublicRepository(directory),
      /found private or transitional paths: scripts\/__tests__\/export-oss\.test\.mjs/u,
    );
    git(['reset', '--hard', 'HEAD^'], { stdio: 'ignore' });

    git(['remote', 'set-url', 'origin', 'https://github.com/example/tixkit.git']);
    assert.throws(
      () => assertAuthoritativePublicRepository(directory),
      /may be rebound only in github\.com\/tixkit\/tixkit/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
