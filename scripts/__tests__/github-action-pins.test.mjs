import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const verifier = resolve(root, 'infra/ci/scripts/verify-github-action-pins.sh');
const digest = 'a'.repeat(64);

function verifyWorkflow(workflow) {
  const directory = mkdtempSync(resolve(tmpdir(), 'tixkit-action-pins-'));
  try {
    mkdirSync(resolve(directory, '.github/workflows'), { recursive: true });
    mkdirSync(resolve(directory, '.github/actions'), { recursive: true });
    writeFileSync(resolve(directory, '.github/workflows/test.yml'), workflow);
    return execFileSync(verifier, { cwd: directory, encoding: 'utf8', stdio: 'pipe' });
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function verifyImage(image) {
  return verifyWorkflow(
    `name: Test\npermissions:\n  contents: read\njobs:\n  test:\n    services:\n      database:\n        image: ${image}\n`,
  );
}

function verifyAction(action) {
  const directory = mkdtempSync(resolve(tmpdir(), 'tixkit-action-pins-'));
  try {
    mkdirSync(resolve(directory, '.github/workflows'), { recursive: true });
    mkdirSync(resolve(directory, '.github/actions'), { recursive: true });
    writeFileSync(
      resolve(directory, '.github/workflows/test.yml'),
      `name: Test\npermissions:\n  contents: read\njobs:\n  test:\n    steps:\n      - uses: ${action}\n`,
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
    assert.throws(() => verifyImage(image), /mutable or malformed service .* image/u);
  }
});

test('accepts local actions and immutable action SHAs but rejects mutable or malformed refs', () => {
  assert.equal(verifyAction('./.github/actions/setup-js'), '');
  assert.equal(verifyAction(`actions/checkout@${'a'.repeat(40)}`), '');
  for (const action of ['actions/checkout@v7', 'actions/checkout@main', 'actions/checkout@abc']) {
    assert.throws(() => verifyAction(action), /mutable or malformed action ref/u);
  }
});

test('requires top-level contents read rather than accepting job-only permissions', () => {
  for (const permissions of [
    '',
    'permissions: {}\n',
    'jobs:\n  test:\n    permissions:\n      contents: read\n',
  ]) {
    assert.throws(
      () =>
        verifyWorkflow(
          `name: Test\n${permissions}${permissions.includes('jobs:') ? '' : 'jobs: {}\n'}`,
        ),
      /top-level permissions with contents: read/u,
    );
  }
});

test('validates scalar, mapping, inline, and differently indented service and job containers', () => {
  const pinned = `postgres:16@sha256:${digest}`;
  const base = 'name: Test\npermissions:\n  contents: read\n';
  for (const jobs of [
    `jobs:\n  test:\n    container: ${pinned}\n`,
    `jobs:\n  test:\n    container:\n      image: ${pinned}\n`,
    `jobs:\n  test:\n    services: { database: { image: "${pinned}" } }\n`,
    `jobs:\n    test:\n      services:\n        database:\n          image: ${pinned}\n`,
  ]) {
    assert.equal(verifyWorkflow(`${base}${jobs}`), '');
    assert.throws(
      () => verifyWorkflow(`${base}${jobs.replaceAll(pinned, 'postgres:16')}`),
      /mutable or malformed/u,
    );
  }
});
