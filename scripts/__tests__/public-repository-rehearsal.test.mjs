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
  await assert.rejects(rehearsePublicRepository([]), /Use --repository <clone>/u);
  await assert.rejects(
    rehearsePublicRepository(['--export', '/tmp/export']),
    /no longer supports derived OSS exports/u,
  );
});
