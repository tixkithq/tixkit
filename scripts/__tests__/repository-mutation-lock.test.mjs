import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { acquireRepositoryMutationLock } from './helpers/repository-mutation-lock.mjs';

test('reclaims a lock immediately after its owner exits without releasing it', async () => {
  const repository = await mkdtemp(join(tmpdir(), 'tixkit-mutation-lock-fixture-'));
  const helperUrl = pathToFileURL(
    join(import.meta.dirname, 'helpers/repository-mutation-lock.mjs'),
  ).href;
  try {
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { acquireRepositoryMutationLock } from ${JSON.stringify(helperUrl)}; await acquireRepositoryMutationLock(${JSON.stringify(repository)});`,
      ],
      { stdio: 'pipe' },
    );

    const startedAt = Date.now();
    const release = await acquireRepositoryMutationLock(repository);
    assert.ok(Date.now() - startedAt < 2_000, 'dead-owner recovery exceeded two seconds');
    await release();
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});
