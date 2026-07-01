import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { cleanAdminDistDir, resolveAdminDistDir } from '../playwright-clean-admin-dist.mjs';

async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

test('resolveAdminDistDir accepts contained .next paths', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tixkit-admin-dist-'));
  const result = resolveAdminDistDir('.next/e2e-3202-run', { root });

  assert.equal(result.relativePath, '.next/e2e-3202-run');
  assert.equal(result.absolutePath, path.join(root, '.next/e2e-3202-run'));
});

test('resolveAdminDistDir rejects unsafe paths', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tixkit-admin-dist-'));
  const unsafePaths = [
    '',
    ' .next/e2e',
    '.next/e2e ',
    '/tmp/e2e',
    '../admin-dashboard/.next/e2e',
    '.next/../outside',
    '.next',
    'dist/e2e',
    '.next/e2e;rm-rf',
    '.next/e2e $(date)',
    '.next/e2e*',
    '.next//e2e',
  ];

  for (const unsafePath of unsafePaths) {
    assert.throws(() => resolveAdminDistDir(unsafePath, { root }), {
      name: 'Error',
    });
  }
});

test('cleanAdminDistDir removes only the validated directory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tixkit-admin-dist-'));
  const target = path.join(root, '.next/e2e-safe');
  const sibling = path.join(root, '.next/keep');
  await mkdir(target, { recursive: true });
  await mkdir(sibling, { recursive: true });
  await writeFile(path.join(target, 'BUILD_ID'), 'test');
  await writeFile(path.join(sibling, 'BUILD_ID'), 'keep');

  const result = await cleanAdminDistDir('.next/e2e-safe', { root });

  assert.equal(result.absolutePath, target);
  assert.equal(await pathExists(target), false);
  assert.equal(await pathExists(sibling), true);
});
