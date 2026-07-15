import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function git(repository, args) {
  return execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
}

function build(repository, output) {
  execFileSync('node', ['scripts/build-widget-release.mjs', output], {
    cwd: repository,
    encoding: 'utf8',
  });
}

test('widget release is checkout-independent and does not require embed-core dist', () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'tixkit-widget-alt-root-'));
  const alternateRepository = join(temporaryRoot, 'repository');
  const primaryOutput = join(temporaryRoot, 'primary-output');
  const alternateOutput = join(temporaryRoot, 'alternate-output');
  try {
    mkdirSync(join(alternateRepository, 'scripts'), { recursive: true });
    mkdirSync(join(alternateRepository, 'packages/widget'), { recursive: true });
    mkdirSync(join(alternateRepository, 'packages/embed-core'), { recursive: true });
    cpSync(
      join(root, 'scripts/build-widget-release.mjs'),
      join(alternateRepository, 'scripts/build-widget-release.mjs'),
    );
    cpSync(
      join(root, 'packages/widget/package.json'),
      join(alternateRepository, 'packages/widget/package.json'),
    );
    cpSync(join(root, 'packages/widget/src'), join(alternateRepository, 'packages/widget/src'), {
      recursive: true,
    });
    cpSync(
      join(root, 'packages/embed-core/src'),
      join(alternateRepository, 'packages/embed-core/src'),
      {
        recursive: true,
      },
    );
    writeFileSync(join(alternateRepository, '.gitignore'), 'node_modules\n');
    symlinkSync(join(root, 'node_modules'), join(alternateRepository, 'node_modules'));

    git(alternateRepository, ['init', '-q']);
    git(alternateRepository, ['add', '-A']);
    git(alternateRepository, [
      '-c',
      'user.name=Widget Release Test',
      '-c',
      'user.email=widget-release@tixkit.invalid',
      'commit',
      '-qm',
      'alternate-root fixture',
    ]);

    assert.equal(existsSync(join(alternateRepository, 'packages/embed-core/dist')), false);
    build(root, primaryOutput);
    build(alternateRepository, alternateOutput);

    const file = 'tixkit-widget-0.1.0.js';
    assert.deepEqual(
      readFileSync(join(primaryOutput, file)),
      readFileSync(join(alternateOutput, file)),
    );
    assert.deepEqual(
      readFileSync(join(primaryOutput, `${file}.map`)),
      readFileSync(join(alternateOutput, `${file}.map`)),
    );

    const sourceMap = JSON.parse(readFileSync(join(primaryOutput, `${file}.map`), 'utf8'));
    assert.equal(sourceMap.sourceRoot, 'tixkit:///');
    assert.deepEqual(sourceMap.sources, [
      'packages/embed-core/src/index.ts',
      'packages/widget/src/index.ts',
    ]);
    assert.equal(JSON.stringify(sourceMap).includes(root), false);
    assert.equal(JSON.stringify(sourceMap).includes(alternateRepository), false);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
