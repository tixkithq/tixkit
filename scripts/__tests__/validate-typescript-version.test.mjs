import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  REQUIRED_TYPESCRIPT_VERSION,
  validateTypeScriptVersion,
} from '../validate-typescript-version.mjs';

function createFixture({
  appVersion = REQUIRED_TYPESCRIPT_VERSION,
  override = REQUIRED_TYPESCRIPT_VERSION,
} = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'tixkit-typescript-version-'));
  mkdirSync(path.join(root, 'apps', 'demo'), { recursive: true });
  mkdirSync(path.join(root, 'packages', 'sdk'), { recursive: true });
  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({
      workspaces: ['apps/*', 'packages/*'],
      devDependencies: { typescript: REQUIRED_TYPESCRIPT_VERSION },
      overrides: { typescript: override },
    }),
  );
  writeFileSync(
    path.join(root, 'apps', 'demo', 'package.json'),
    JSON.stringify({ devDependencies: { typescript: appVersion } }),
  );
  writeFileSync(
    path.join(root, 'packages', 'sdk', 'package.json'),
    JSON.stringify({ peerDependencies: { typescript: REQUIRED_TYPESCRIPT_VERSION } }),
  );
  writeFileSync(
    path.join(root, 'bun.lock'),
    `"typescript": ["typescript@${REQUIRED_TYPESCRIPT_VERSION}", "", { "optionalDependencies": { "@typescript/typescript-darwin-arm64": "${REQUIRED_TYPESCRIPT_VERSION}" } }, "sha512-test"]\n"@typescript/typescript-darwin-arm64": ["@typescript/typescript-darwin-arm64@${REQUIRED_TYPESCRIPT_VERSION}", "", {}, "sha512-native"]`,
  );
  return root;
}

test('accepts an exact TypeScript 7 workspace and lockfile', () => {
  const result = validateTypeScriptVersion({
    root: createFixture(),
    compilerVersion: REQUIRED_TYPESCRIPT_VERSION,
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.manifestCount, 3);
});

test('rejects workspace ranges and missing root enforcement', () => {
  const result = validateTypeScriptVersion({
    root: createFixture({ appVersion: '^7.0.2', override: '5.9.3' }),
    compilerVersion: REQUIRED_TYPESCRIPT_VERSION,
  });
  assert.deepEqual(result.errors, [
    'apps/demo/package.json: devDependencies.typescript must be exactly 7.0.2, found ^7.0.2',
    'package.json: overrides.typescript must be exactly 7.0.2',
  ]);
});

test('rejects non-TypeScript workspaces and lockfile drift', () => {
  const root = createFixture();
  writeFileSync(
    path.join(root, 'packages', 'sdk', 'package.json'),
    JSON.stringify({ private: true }),
  );
  writeFileSync(
    path.join(root, 'bun.lock'),
    '"typescript": ["typescript@5.9.3", "", {}, "sha512-test"]',
  );
  const result = validateTypeScriptVersion({ root, compilerVersion: REQUIRED_TYPESCRIPT_VERSION });
  assert.deepEqual(result.errors, [
    'packages/sdk/package.json: must declare TypeScript 7.0.2',
    'bun.lock: typescript must resolve to 7.0.2, found 5.9.3',
  ]);
});

test('rejects nested and native TypeScript resolution drift', () => {
  const root = createFixture();
  writeFileSync(
    path.join(root, 'bun.lock'),
    [
      '"typescript": ["typescript@7.0.2", "", {}, "sha512-root"]',
      '"dependency/typescript": ["typescript@5.9.3", "", {}, "sha512-nested"]',
      '"@typescript/typescript-linux-x64": ["@typescript/typescript-linux-x64@7.0.1", "", {}, "sha512-native"]',
    ].join('\n'),
  );
  const result = validateTypeScriptVersion({ root, compilerVersion: REQUIRED_TYPESCRIPT_VERSION });
  assert.deepEqual(result.errors, [
    'bun.lock: typescript must resolve to 7.0.2, found 5.9.3',
    'bun.lock: @typescript/typescript-linux-x64 must resolve to 7.0.2, found 7.0.1',
  ]);
});

test('rejects a missing or drifted installed compiler', () => {
  const root = createFixture();
  assert.deepEqual(validateTypeScriptVersion({ root, compilerVersion: null }).errors, [
    'node_modules/typescript/bin/tsc: installed compiler is missing or not executable',
  ]);
  assert.deepEqual(validateTypeScriptVersion({ root, compilerVersion: '5.9.3' }).errors, [
    'node_modules/typescript/bin/tsc: must report 7.0.2, found 5.9.3',
  ]);
});

test('rejects scaffold templates that would generate an older TypeScript version', () => {
  const root = createFixture();
  const templateDir = path.join(root, 'packages', 'cli', 'src', 'templates', 'nextjs');
  mkdirSync(templateDir, { recursive: true });
  writeFileSync(
    path.join(templateDir, 'package.json.template'),
    JSON.stringify({ devDependencies: { typescript: '5.9.3' } }),
  );
  const result = validateTypeScriptVersion({ root, compilerVersion: REQUIRED_TYPESCRIPT_VERSION });
  assert.deepEqual(result.errors, [
    'packages/cli/src/templates/nextjs/package.json.template: devDependencies.typescript must be exactly 7.0.2, found 5.9.3',
  ]);
});

test('executes from a repository path containing spaces', () => {
  const root = createFixture();
  const spacedRoot = path.join(root, 'repo with spaces');
  mkdirSync(path.join(spacedRoot, 'scripts'), { recursive: true });
  mkdirSync(path.join(spacedRoot, 'node_modules', 'typescript', 'bin'), { recursive: true });
  writeFileSync(
    path.join(spacedRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    "console.log('Version 7.0.2');\n",
  );
  for (const relativePath of ['package.json', 'bun.lock']) {
    writeFileSync(
      path.join(spacedRoot, relativePath),
      readFileFixture(path.join(root, relativePath)),
    );
  }
  for (const workspace of ['apps/demo', 'packages/sdk']) {
    mkdirSync(path.join(spacedRoot, workspace), { recursive: true });
    writeFileSync(
      path.join(spacedRoot, workspace, 'package.json'),
      readFileFixture(path.join(root, workspace, 'package.json')),
    );
  }
  const sourcePath = fileURLToPath(new URL('../validate-typescript-version.mjs', import.meta.url));
  writeFileSync(
    path.join(spacedRoot, 'scripts', 'validate-typescript-version.mjs'),
    readFileFixture(sourcePath),
  );

  const result = spawnSync(process.execPath, ['scripts/validate-typescript-version.mjs'], {
    cwd: spacedRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Validated TypeScript 7\.0\.2/);
});

function readFileFixture(filePath) {
  return readFileSync(filePath, 'utf8');
}
