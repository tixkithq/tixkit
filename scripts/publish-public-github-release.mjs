#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function value(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1 || !argv[index + 1]) throw new Error(`${name} is required`);
  return argv[index + 1];
}

function releaseAssets(directory) {
  const assets = [];
  const visit = (path) => {
    for (const name of readdirSync(path).sort()) {
      const candidate = join(path, name);
      if (statSync(candidate).isDirectory()) visit(candidate);
      else if (
        name === 'public-release-manifest.json' ||
        name === 'images.json' ||
        name === 'CHECKSUMS.sha256' ||
        name.endsWith('.spdx.json') ||
        name.endsWith('.tgz')
      )
        assets.push(candidate);
    }
  };
  visit(directory);
  const names = assets.map((path) => basename(path));
  if (new Set(names).size !== names.length)
    throw new Error('release asset basenames must be unique');
  return assets;
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function writePublicReleaseChecksums(directory) {
  const output = resolve(directory, 'CHECKSUMS.sha256');
  const assets = releaseAssets(directory).filter((path) => path !== output);
  writeFileSync(
    output,
    `${assets
      .map((path) => `${sha256(path)}  ${basename(path)}`)
      .sort((left, right) => left.localeCompare(right))
      .join('\n')}\n`,
  );
  return output;
}

export function stagePublicGithubRelease(
  tag,
  repository,
  directory,
  run = spawnSync,
  download = execFileSync,
) {
  const assets = releaseAssets(directory);
  const view = run(
    'gh',
    ['release', 'view', tag, '--repo', repository, '--json', 'isDraft,assets'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (view.status !== 0) {
    if (!/release not found|HTTP 404/u.test(view.stderr))
      throw new Error(`GitHub release lookup failed: ${view.stderr.trim()}`);
    const creation = run(
      'gh',
      [
        'release',
        'create',
        tag,
        ...assets,
        '--repo',
        repository,
        '--title',
        `Tixkit ${tag}`,
        '--generate-notes',
        '--verify-tag',
        '--draft',
      ],
      { encoding: 'utf8', stdio: 'inherit' },
    );
    if (creation.status !== 0) throw new Error(`GitHub draft release creation failed for ${tag}`);
    return { created: true, uploaded: assets.map((path) => basename(path)) };
  }

  const release = JSON.parse(view.stdout);
  const existing = new Set(release.assets.map(({ name }) => name));
  const expected = new Set(assets.map((path) => basename(path)));
  const unexpected = [...existing].filter((name) => !expected.has(name));
  if (unexpected.length > 0)
    throw new Error(
      `GitHub release contains unexpected immutable assets: ${unexpected.join(', ')}`,
    );
  const temporary = mkdtempSync(join(tmpdir(), 'tixkit-release-assets-'));
  const missing = [];
  try {
    for (const asset of assets) {
      const name = basename(asset);
      if (!existing.has(name)) {
        missing.push(asset);
        continue;
      }
      download(
        'gh',
        ['release', 'download', tag, '--repo', repository, '--pattern', name, '--dir', temporary],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      if (sha256(asset) !== sha256(resolve(temporary, name)))
        throw new Error(`published GitHub release asset differs: ${name}`);
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  if (missing.length > 0) {
    if (!release.isDraft) throw new Error('published GitHub release is missing immutable assets');
    const upload = run('gh', ['release', 'upload', tag, ...missing, '--repo', repository], {
      encoding: 'utf8',
      stdio: 'inherit',
    });
    if (upload.status !== 0) throw new Error(`GitHub release asset upload failed for ${tag}`);
  }
  return { created: false, uploaded: missing.map((path) => basename(path)) };
}

export function finalizePublicGithubRelease(tag, repository, run = spawnSync) {
  const result = run(
    'gh',
    ['release', 'edit', tag, '--repo', repository, '--draft=false', '--latest=false'],
    { encoding: 'utf8', stdio: 'inherit' },
  );
  if (result.status !== 0) throw new Error(`GitHub release finalization failed for ${tag}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const tag = value(process.argv, '--tag');
  const repository = value(process.argv, '--repository');
  if (process.argv.includes('--write-checksums')) {
    const directory = resolve(value(process.argv, '--directory'));
    writePublicReleaseChecksums(directory);
    process.stdout.write(`Wrote public release checksums for ${tag}.\n`);
  } else if (process.argv.includes('--finalize')) finalizePublicGithubRelease(tag, repository);
  else {
    const directory = resolve(value(process.argv, '--directory'));
    const result = stagePublicGithubRelease(tag, repository, directory);
    process.stdout.write(
      `Staged GitHub release ${tag}; created=${result.created}, uploaded=${result.uploaded.length}.\n`,
    );
  }
}
