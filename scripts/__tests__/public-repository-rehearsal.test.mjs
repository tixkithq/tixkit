import assert from 'node:assert/strict';
import test from 'node:test';
import {
  publicRepositoryValidationCommands,
  rehearsePublicRepository,
} from '../rehearse-public-repository.mjs';

test('defines the complete independent public repository validation sequence', () => {
  const commonPrefix = [
    ['node', ['scripts/validate-public-distribution.mjs']],
    ['bun', ['install', '--frozen-lockfile']],
    ['bun', ['run', 'format:check']],
    ['bun', ['run', 'lint', '--force']],
    ['bun', ['run', 'typecheck', '--force']],
    ['bun', ['run', 'test:unit']],
  ];
  const commonSuffix = [
    ['git', ['restore', '--worktree', '--', 'artifacts/api', 'apps/docs/public/contracts']],
    ['bun', ['run', 'build']],
    ['node', ['packages/cli/dist/index.js', '--help']],
    ['git', ['diff', '--exit-code', 'HEAD', '--']],
    ['git', ['diff', '--cached', '--exit-code', 'HEAD', '--']],
  ];
  assert.deepEqual(publicRepositoryValidationCommands({ createSnapshot: true }), [
    ['git', ['init', '-q']],
    ['git', ['remote', 'add', 'origin', 'https://github.com/tixkit/tixkit.git']],
    ['git', ['add', '-A']],
    [
      'git',
      [
        '-c',
        'user.name=Tixkit Public Rehearsal',
        '-c',
        'user.email=public-rehearsal@tixkit.invalid',
        'commit',
        '-qm',
        'Public repository rehearsal snapshot',
      ],
    ],
    ...commonPrefix,
    [
      'bun',
      [
        'scripts/validate-api-release-provenance.ts',
        '--allow-recorded-source',
        '--allow-derived-export',
      ],
    ],
    ...commonSuffix,
  ]);
  assert.deepEqual(publicRepositoryValidationCommands(), [
    ['git', ['rev-parse', '--verify', 'HEAD']],
    ['git', ['diff', '--quiet', 'HEAD', '--']],
    ['git', ['diff', '--cached', '--quiet', 'HEAD', '--']],
    ...commonPrefix,
    ['bun', ['scripts/validate-api-release-provenance.ts']],
    ...commonSuffix,
  ]);
});

test('requires one explicit repository source', async () => {
  await assert.rejects(rehearsePublicRepository([]), /Use --export <path>/u);
  await assert.rejects(
    rehearsePublicRepository(['--export', '/tmp/export', '--repository', '/tmp/repository']),
    /either --export or --repository/u,
  );
});
