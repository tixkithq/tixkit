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
import { pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const widgetPackageJson = JSON.parse(
  readFileSync(join(root, 'packages/widget/package.json'), 'utf8'),
);
const widgetVersion = widgetPackageJson.version;

function git(repository, args) {
  return execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
}

function build(repository, output) {
  execFileSync('node', ['scripts/build-widget-release.mjs', output], {
    cwd: repository,
    encoding: 'utf8',
  });
}

test('widget package separates its compatible package root from the lean browser entry', () => {
  const packageJson = widgetPackageJson;
  assert.equal(packageJson.main, './dist/index.js');
  assert.equal(packageJson.exports['.'].import, './dist/index.js');
  assert.equal(packageJson.exports['./browser'].import, './dist/tixkit-widget.js');
  assert.deepEqual(packageJson.sideEffects, ['./dist/index.js', './dist/tixkit-widget.js']);

  const rootEntry = readFileSync(join(root, 'packages/widget/src/index.ts'), 'utf8');
  const browserEntry = readFileSync(join(root, 'packages/widget/src/browser.ts'), 'utf8');
  assert.match(rootEntry, /export \* from '@tixkit\/embed-core'/u);
  assert.doesNotMatch(browserEntry, /export \* from '@tixkit\/embed-core'/u);
  assert.match(browserEntry, /export type \* from '@tixkit\/embed-core'/u);
});

test('immutable release collision requires a new widget version', () => {
  const output = mkdtempSync(join(tmpdir(), 'tixkit-widget-collision-'));
  try {
    build(root, output);
    writeFileSync(join(output, `tixkit-widget-${widgetVersion}.js`), 'tampered immutable bytes');
    assert.throws(() => build(root, output), /Immutable widget release collision/u);

    rmSync(output, { recursive: true, force: true });
    build(root, output);
    rmSync(join(output, 'checksums.txt'));
    assert.throws(() => build(root, output), /Immutable widget release collision/u);

    rmSync(output, { recursive: true, force: true });
    build(root, output);
    writeFileSync(join(output, 'checksums.txt'), 'tampered checksums\n');
    assert.throws(() => build(root, output), /Immutable widget release collision/u);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test('documented bare package import retains custom-element registration', () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'tixkit-widget-consumer-'));
  try {
    execFileSync('bun', ['run', '--filter', '@tixkit/widget', 'build'], {
      cwd: root,
      stdio: 'pipe',
    });
    const scopedModules = join(temporaryRoot, 'node_modules/@tixkit');
    mkdirSync(scopedModules, { recursive: true });
    symlinkSync(join(root, 'packages/widget'), join(scopedModules, 'widget'));
    symlinkSync(join(root, 'packages/embed-core'), join(scopedModules, 'embed-core'));
    const entry = join(temporaryRoot, 'entry.mjs');
    const output = join(temporaryRoot, 'consumer.mjs');
    writeFileSync(entry, "import '@tixkit/widget';\n");
    execFileSync(
      join(root, 'node_modules/.bin/esbuild'),
      [entry, '--bundle', '--format=esm', `--outfile=${output}`],
      { cwd: temporaryRoot, stdio: 'pipe' },
    );
    const bundled = readFileSync(output, 'utf8');
    assert.match(bundled, /customElements\.define\("tixkit-widget"/u);
    assert.match(bundled, /customElements\.define\("tixkit-button"/u);

    const rootContract = JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          'globalThis.HTMLElement=class {};const definitions=new Map();globalThis.customElements={get:(name)=>definitions.get(name),define:(name,value)=>definitions.set(name,value)};globalThis.window={customElements};const module=await import(process.argv[1]);console.log(JSON.stringify({exports:Object.keys(module),definitions:[...definitions.keys()]}));',
          pathToFileURL(join(root, 'packages/widget/dist/index.js')).href,
        ],
        { encoding: 'utf8' },
      ),
    );
    assert.ok(rootContract.exports.includes('generateEmbedSnippet'));
    assert.ok(rootContract.exports.includes('embedLifecycleSchema'));
    assert.ok(rootContract.exports.includes('TixkitWidget'));
    assert.deepEqual(rootContract.definitions, ['tixkit-widget', 'tixkit-button']);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

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

    const file = `tixkit-widget-${widgetVersion}.js`;
    assert.deepEqual(
      readFileSync(join(primaryOutput, file)),
      readFileSync(join(alternateOutput, file)),
    );
    assert.deepEqual(
      readFileSync(join(primaryOutput, `${file}.map`)),
      readFileSync(join(alternateOutput, `${file}.map`)),
    );
    assert.ok(readFileSync(join(primaryOutput, file)).byteLength <= 45_000);
    const browserContract = JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          'globalThis.HTMLElement=class {};const definitions=new Map();globalThis.customElements={get:(name)=>definitions.get(name),define:(name,value)=>definitions.set(name,value)};globalThis.window={customElements};const module=await import(process.argv[1]);console.log(JSON.stringify({exports:Object.keys(module),definitions:[...definitions.keys()]}));',
          pathToFileURL(join(primaryOutput, file)).href,
        ],
        { encoding: 'utf8' },
      ),
    );
    assert.deepEqual(browserContract.exports, [
      'TIXKIT_WIDGET_VERSION',
      'TixkitButton',
      'TixkitWidget',
    ]);
    assert.deepEqual(browserContract.definitions, ['tixkit-widget', 'tixkit-button']);

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
