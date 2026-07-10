import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, test } from 'node:test';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const installerPath = join(repositoryRoot, 'infra/ci/scripts/install-playwright-runtime.sh');
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function writeExecutable(path, source) {
  await writeFile(path, source);
  await chmod(path, 0o755);
}

test('installs missing Playwright libraries without sudo and persists the runtime paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tixkit-playwright-runtime-'));
  temporaryDirectories.push(root);
  const binDirectory = join(root, 'bin');
  const runnerTemp = join(root, 'runner-temp');
  const githubEnv = join(root, 'github-env');
  await mkdir(binDirectory);

  await writeExecutable(
    join(binDirectory, 'uname'),
    `#!/usr/bin/env bash
echo Linux
`,
  );
  await writeExecutable(
    join(binDirectory, 'bunx'),
    `#!/usr/bin/env bash
if [[ "$*" == 'playwright --version' ]]; then
  echo 'Version 1.61.1'
elif [[ "$*" == 'playwright install-deps --dry-run chromium' ]]; then
  printf 'Missing system dependencies (1):\n  libnspr4\n'
  exit 1
elif [[ "$*" != 'playwright install chromium' ]]; then
  exit 2
fi
`,
  );
  await writeExecutable(
    join(binDirectory, 'apt-get'),
    `#!/usr/bin/env bash
if [[ "$1" != 'download' || "$2" != 'libnspr4' ]]; then exit 2; fi
touch libnspr4_1.deb
`,
  );
  await writeExecutable(
    join(binDirectory, 'dpkg-deb'),
    `#!/usr/bin/env bash
if [[ "$1" != '--extract' ]]; then exit 2; fi
mkdir -p "$3/usr/lib/x86_64-linux-gnu"
touch "$3/usr/lib/x86_64-linux-gnu/libnspr4.so"
`,
  );
  await writeExecutable(
    join(binDirectory, 'bun'),
    `#!/usr/bin/env bash
[[ "${'${LD_LIBRARY_PATH:-}'}" == *'/playwright-runtime/root/usr/lib/x86_64-linux-gnu'* ]]
`,
  );

  const result = spawnSync('bash', [installerPath], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_ENV: githubEnv,
      PATH: `${binDirectory}:${process.env.PATH}`,
      RUNNER_TEMP: runnerTemp,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Extracted 1 missing Playwright dependency packages/);
  assert.match(result.stdout, /Playwright 1\.61\.1 Chromium runtime is ready/);
  const persistedEnvironment = await readFile(githubEnv, 'utf8');
  assert.match(persistedEnvironment, /^LD_LIBRARY_PATH=.*playwright-runtime\/root\/usr\/lib/m);
  assert.match(
    persistedEnvironment,
    /^XDG_DATA_DIRS=.*playwright-runtime\/root\/usr\/share:\/usr\/local\/share:\/usr\/share/m,
  );
  assert.doesNotMatch(result.stdout + result.stderr, /sudo/);
});

test('fails closed when the installed Playwright version drifts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tixkit-playwright-version-'));
  temporaryDirectories.push(root);
  const binDirectory = join(root, 'bin');
  await mkdir(binDirectory);
  await writeExecutable(
    join(binDirectory, 'bunx'),
    `#!/usr/bin/env bash
echo 'Version 1.61.2'
`,
  );

  const result = spawnSync('bash', [installerPath], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${binDirectory}:${process.env.PATH}` },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not match the trusted runtime/);
});
