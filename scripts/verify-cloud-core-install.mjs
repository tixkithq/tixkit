#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function argument(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1 || !argv[index + 1]) throw new Error(`${name} is required`);
  return resolve(argv[index + 1]);
}

function installedPackageDigest(path) {
  const hash = createHash('sha256');
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const file = join(directory, name);
      const metadata = lstatSync(file);
      if (metadata.isSymbolicLink())
        throw new Error(`installed public package contains a symlink: ${file}`);
      if (metadata.isDirectory()) visit(file);
      else if (metadata.isFile()) {
        hash.update(relative(path, file));
        hash.update('\u0000');
        hash.update(readFileSync(file));
        hash.update('\u0000');
      }
    }
  };
  visit(path);
  return hash.digest('hex');
}

function snapshot(manifest, cloudRoot) {
  return new Map(
    manifest.core.packages.map((pin) => {
      const packagePath = resolve(cloudRoot, 'node_modules', ...pin.name.split('/'));
      if (!lstatSync(packagePath, { throwIfNoEntry: false })?.isDirectory())
        throw new Error(`installed public package is missing: ${pin.name}`);
      return [pin.name, installedPackageDigest(packagePath)];
    }),
  );
}

export function verifyCloudCoreInstall(manifest, cloudRoot, command, run = spawnSync) {
  if (command.length === 0) throw new Error('a Cloud build/test command is required');
  const before = snapshot(manifest, cloudRoot);
  const result = run(command[0], command.slice(1), { cwd: cloudRoot, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`Cloud command failed with status ${result.status}`);
  const after = snapshot(manifest, cloudRoot);
  const changed = [...before].filter(([name, digest]) => after.get(name) !== digest);
  if (changed.length > 0)
    throw new Error(
      `Cloud command modified installed public artifacts: ${changed.map(([name]) => name).join(', ')}`,
    );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const separator = process.argv.indexOf('--');
  if (separator === -1) throw new Error('separate the verified command with --');
  const cloudRoot = argument(process.argv.slice(2, separator), '--cloud-root');
  const manifestPath = argument(process.argv.slice(2, separator), '--manifest');
  verifyCloudCoreInstall(
    JSON.parse(readFileSync(manifestPath, 'utf8')),
    cloudRoot,
    process.argv.slice(separator + 1),
  );
  process.stdout.write('Cloud command preserved every installed public artifact byte.\n');
}
