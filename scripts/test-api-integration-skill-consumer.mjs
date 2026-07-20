import { execFileSync, spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const apiVersion = '2026-08-23';
const distribution = JSON.parse(
  await readFile(resolve(root, 'distribution/public-distribution.json'), 'utf8'),
);
const skillPin = distribution.release.agentIntegrationSkills.find(
  (entry) => entry.apiVersion === apiVersion,
);
if (!skillPin) throw new Error(`Missing public distribution skill pin for ${apiVersion}`);
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'tixkit-api-skill-consumer-'));

function pack(workspace) {
  const output = execFileSync(
    'bun',
    ['pm', 'pack', '--destination', temporaryDirectory, '--quiet'],
    {
      cwd: resolve(root, workspace),
      encoding: 'utf8',
    },
  );
  return resolve(temporaryDirectory, output.trim().split('\n').at(-1));
}

try {
  execFileSync('bun', ['run', 'build'], {
    cwd: resolve(root, 'packages/api-integration-skill'),
    stdio: 'inherit',
  });
  execFileSync('bun', ['run', 'build'], {
    cwd: resolve(root, 'packages/sdk-js'),
    stdio: 'inherit',
  });
  const skillPackage = pack('packages/api-integration-skill');
  const sdkPackage = pack('packages/sdk-js');
  await writeFile(
    resolve(temporaryDirectory, 'package.json'),
    `${JSON.stringify(
      {
        private: true,
        type: 'module',
        dependencies: {
          '@tixkit/api-integration-skill': `file:${skillPackage}`,
          '@tixkit/js': `file:${sdkPackage}`,
        },
      },
      null,
      2,
    )}\n`,
  );
  execFileSync('bun', ['install'], { cwd: temporaryDirectory, stdio: 'inherit' });
  const releaseRoot = resolve(temporaryDirectory, 'releases');
  await cp(resolve(root, 'artifacts/api', apiVersion), resolve(releaseRoot, apiVersion), {
    recursive: true,
  });
  const outputRoot = resolve(temporaryDirectory, 'skills');
  const binary = resolve(temporaryDirectory, 'node_modules/.bin/tixkit-api-skill');
  const generated = JSON.parse(
    execFileSync(
      binary,
      [
        '--release-root',
        releaseRoot,
        '--api-version',
        apiVersion,
        '--output',
        outputRoot,
        '--expected-release-manifest-sha256',
        skillPin.releaseManifestSha256,
        '--allow-local-evaluation',
      ],
      { cwd: temporaryDirectory, encoding: 'utf8' },
    ),
  );
  if (generated.apiVersion !== apiVersion || generated.localEvaluation !== true) {
    throw new Error('External skill generation did not preserve local release identity');
  }
  const skill = await readFile(resolve(generated.directory, 'SKILL.md'), 'utf8');
  const contract = JSON.parse(
    await readFile(resolve(generated.directory, 'references/contract.json'), 'utf8'),
  );
  if (!skill.includes(`name: tixkit-api-${apiVersion}`) || contract.apiVersion !== apiVersion) {
    throw new Error('External generated skill is not bound to the selected API release');
  }
  const secretFixture = 'sk_live_external_consumer_must_never_leak';
  const mismatch = spawnSync(
    binary,
    [
      '--release-root',
      releaseRoot,
      '--api-version',
      '2026-08-19',
      '--output',
      outputRoot,
      '--expected-release-manifest-sha256',
      skillPin.releaseManifestSha256,
      '--allow-local-evaluation',
    ],
    {
      cwd: temporaryDirectory,
      encoding: 'utf8',
      env: { ...process.env, TIXKIT_API_KEY: secretFixture },
    },
  );
  if (mismatch.status === 0) throw new Error('Mismatched external API release unexpectedly passed');
  if (`${mismatch.stdout}${mismatch.stderr}`.includes(secretFixture)) {
    throw new Error('External mismatch failure leaked a credential');
  }
  const sdkProbe = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      "import('@tixkit/js').then((sdk) => { if (typeof sdk.TixkitClient !== 'function') process.exit(2); })",
    ],
    { cwd: temporaryDirectory, encoding: 'utf8' },
  );
  if (sdkProbe !== '') throw new Error('Unexpected SDK probe output');
  process.stdout.write(
    `External Tixkit API integration skill and independent SDK install passed for ${apiVersion}.\n`,
  );
} finally {
  await rm(temporaryDirectory, { recursive: true });
}
