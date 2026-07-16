import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const verifier = resolve(root, 'infra/ci/scripts/verify-github-action-pins.sh');
const digest = 'a'.repeat(64);

function verifyImage(image) {
  const directory = mkdtempSync(resolve(tmpdir(), 'tixkit-action-pins-'));
  try {
    mkdirSync(resolve(directory, '.github/workflows'), { recursive: true });
    mkdirSync(resolve(directory, '.github/actions'), { recursive: true });
    writeFileSync(
      resolve(directory, '.github/workflows/test.yml'),
      `name: Test\npermissions:\n  contents: read\njobs:\n  test:\n    services:\n      database:\n        image: ${image}\n`,
    );
    return execFileSync(verifier, { cwd: directory, encoding: 'utf8', stdio: 'pipe' });
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

test('accepts direct and binary-choice service images only when every result is digest-pinned', () => {
  assert.equal(verifyImage(`postgres:16@sha256:${digest}`), '');
  assert.equal(
    verifyImage(
      `\${{ matrix.profile == 'postgres' && 'postgres:16@sha256:${digest}' || 'mysql:8@sha256:${digest}' }}`,
    ),
    '',
  );
  for (const image of [
    `\${{ matrix.profile == 'postgres' && 'postgres:16@sha256:${digest}' || 'mysql:8' }}`,
    `\${{ matrix.image }}`,
    'postgres:16',
  ]) {
    assert.throws(() => verifyImage(image), /mutable or malformed service image/u);
  }
});
