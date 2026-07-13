#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function valueAfter(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a path`);
  return value;
}

export function publicRepositoryValidationCommands({ createSnapshot = false } = {}) {
  const repositoryPreparation = createSnapshot
    ? [
        ['git', ['init', '-q']],
        ['git', ['remote', 'add', 'origin', 'https://github.com/tixkit/tixkit.git']],
        ['git', ['add', '-A']],
        [
          'git',
          [
            '-c',
            'user.name=Tixkit Public Rehearsal',
            '-c',
            'user.email=public-rehearsal@tixkit.invalid',
            'commit',
            '-qm',
            'Public repository rehearsal snapshot',
          ],
        ],
      ]
    : [
        ['git', ['rev-parse', '--verify', 'HEAD']],
        ['git', ['diff', '--quiet', 'HEAD', '--']],
        ['git', ['diff', '--cached', '--quiet', 'HEAD', '--']],
      ];
  return [
    ...repositoryPreparation,
    ['node', ['scripts/validate-public-distribution.mjs']],
    ['bun', ['install', '--frozen-lockfile']],
    ['bun', ['run', 'format:check']],
    ['bun', ['run', 'lint', '--force']],
    ['bun', ['run', 'typecheck', '--force']],
    ['bun', ['run', 'test:unit']],
    ['bun', ['scripts/validate-api-release-provenance.ts', '--allow-recorded-source']],
    ['git', ['restore', '--worktree', '--', 'artifacts/api', 'apps/docs/public/contracts']],
    ['bun', ['run', 'build']],
    ['node', ['packages/cli/dist/index.js', '--help']],
    ['git', ['diff', '--exit-code', 'HEAD', '--']],
    ['git', ['diff', '--cached', '--exit-code', 'HEAD', '--']],
  ];
}

export function verifyPackedNpmRelease(repository, environment = process.env) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'tixkit-public-cli-'));
  const packDirectory = join(temporaryRoot, 'pack');
  const consumerDirectory = join(temporaryRoot, 'consumer');
  mkdirSync(packDirectory);
  mkdirSync(consumerDirectory);
  try {
    const manifest = JSON.parse(
      readFileSync(resolve(repository, 'distribution/public-distribution.json'), 'utf8'),
    );
    const dependencies = {};
    for (const entry of manifest.release.packages.filter(({ ecosystem }) =>
      ['npm', 'npm-and-cdn'].includes(ecosystem),
    )) {
      const packageDirectory = resolve(repository, entry.path);
      const packageManifest = JSON.parse(
        readFileSync(resolve(packageDirectory, 'package.json'), 'utf8'),
      );
      const before = new Set(readdirSync(packDirectory));
      execFileSync('bun', ['pm', 'pack', '--destination', packDirectory], {
        cwd: packageDirectory,
        env: environment,
        stdio: 'inherit',
      });
      const archives = readdirSync(packDirectory).filter(
        (name) => name.endsWith('.tgz') && !before.has(name),
      );
      if (archives.length !== 1)
        throw new Error(`${entry.path} must produce exactly one unique tarball`);
      dependencies[packageManifest.name] = `file:${join(packDirectory, archives[0])}`;
    }
    writeFileSync(
      join(consumerDirectory, 'package.json'),
      `${JSON.stringify(
        { name: 'tixkit-public-consumer', private: true, dependencies, overrides: dependencies },
        null,
        2,
      )}\n`,
    );
    execFileSync('bun', ['install'], {
      cwd: consumerDirectory,
      env: environment,
      stdio: 'inherit',
    });
    execFileSync(resolve(consumerDirectory, 'node_modules/.bin/tixkit'), ['--help'], {
      cwd: consumerDirectory,
      env: environment,
      stdio: 'inherit',
    });
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export async function rehearsePublicRepository(argv = process.argv.slice(2)) {
  const requestedExport = valueAfter(argv, '--export');
  const requestedRepository = valueAfter(argv, '--repository');
  if (requestedExport && requestedRepository) {
    throw new Error('Use either --export or --repository, not both');
  }
  if (!requestedExport && !requestedRepository) {
    throw new Error('Use --export <path> during transition or --repository <clone> after cutover');
  }

  const repository = resolve(requestedExport ?? requestedRepository);
  if (requestedExport) {
    const { exportOss } = await import('./export-oss.mjs');
    await exportOss(['--out', repository]);
  }

  const environment = { ...process.env, CI: '1' };
  delete environment.DATABASE_URL;
  delete environment.DATABASE_URL_MYSQL;
  for (const [command, args] of publicRepositoryValidationCommands({
    createSnapshot: Boolean(requestedExport),
  })) {
    execFileSync(command, args, { cwd: repository, env: environment, stdio: 'inherit' });
  }
  verifyPackedNpmRelease(repository, environment);
  process.stdout.write(`Validated independent public repository at ${repository}.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  rehearsePublicRepository().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
