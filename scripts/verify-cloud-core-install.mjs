#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  accessSync,
  constants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jsonSchemaViolations } from './lib/public-distribution.mjs';
import { packageContentDigest } from './lib/package-content-digest.mjs';
import { verifyPublicReleaseAttestation } from './lib/public-release-attestation.mjs';
import { parseBunLock, validateCloudCoreConsumer } from './validate-cloud-core-consumer.mjs';

const publicRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

function argument(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1 || !argv[index + 1]) throw new Error(`${name} is required`);
  return resolve(argv[index + 1]);
}

function argumentsFor(argv, name) {
  return argv.flatMap((value, index) =>
    value === name && argv[index + 1] ? [argv[index + 1]] : [],
  );
}

function isWithin(parent, child) {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..');
}

function assertPrivatePackageFiles(path, packageName) {
  for (const name of readdirSync(path)) {
    const child = join(path, name);
    const metadata = lstatSync(child);
    if (metadata.isDirectory()) assertPrivatePackageFiles(child, packageName);
    else if (metadata.isFile() && metadata.nlink !== 1)
      throw new Error(
        `installed public package does not use the required copyfile backend: ${packageName}`,
      );
  }
}

function isDirectoryPath(path) {
  const metadata = lstatSync(path, { throwIfNoEntry: false });
  return metadata?.isDirectory() || (metadata?.isSymbolicLink() && statSync(path).isDirectory());
}

function packageRoots(manifest, cloudRoot) {
  const lock = parseBunLock(readFileSync(resolve(cloudRoot, 'bun.lock'), 'utf8'));
  const canonicalCloudRoot = realpathSync(cloudRoot);
  const workspacePaths = Object.keys(lock.workspaces ?? {})
    .filter(Boolean)
    .map((workspace) => {
      const path = resolve(cloudRoot, workspace);
      if (!isWithin(cloudRoot, path) || !isDirectoryPath(path))
        throw new Error(`private lockfile declares an invalid workspace: ${workspace}`);
      const canonical = realpathSync(path);
      if (!isWithin(canonicalCloudRoot, canonical))
        throw new Error(`private lockfile workspace escapes the repository: ${workspace}`);
      const workspaceManifestPath = resolve(canonical, 'package.json');
      if (!lstatSync(workspaceManifestPath, { throwIfNoEntry: false })?.isFile())
        throw new Error(`private lockfile workspace has no package manifest: ${workspace}`);
      const workspaceManifest = JSON.parse(readFileSync(workspaceManifestPath, 'utf8'));
      if (workspaceManifest.name !== lock.workspaces[workspace]?.name)
        throw new Error(`private lockfile workspace identity is inconsistent: ${workspace}`);
      if (workspaceManifest.name === 'tixkit' || workspaceManifest.name?.startsWith('@tixkit/'))
        throw new Error(`public package identity cannot be a private workspace: ${workspace}`);
      return { canonical, path };
    });
  const nodeModulesRoots = [
    resolve(cloudRoot, 'node_modules'),
    ...workspacePaths.map(({ path }) => resolve(path, 'node_modules')),
  ].filter(isDirectoryPath);
  const canonicalNodeModulesRoots = [
    ...new Set(nodeModulesRoots.map((path) => realpathSync(path))),
  ];
  const workspaceRoots = new Set(workspacePaths.map(({ canonical }) => canonical));
  const pins = new Map(manifest.core.packages.map((pin) => [pin.name, pin]));
  const roots = new Map(manifest.core.packages.map((pin) => [pin.name, new Set()]));
  const visited = new Set();
  const publicName = (name) => name === 'tixkit' || name?.startsWith('@tixkit/');
  const withinInstall = (path) =>
    canonicalNodeModulesRoots.some((nodeModules) => isWithin(nodeModules, path));
  const visit = (directory) => {
    const actual = realpathSync(directory);
    if (visited.has(actual)) return;
    visited.add(actual);
    const packageManifestPath = resolve(actual, 'package.json');
    if (lstatSync(packageManifestPath, { throwIfNoEntry: false })?.isFile()) {
      const packageManifest = JSON.parse(readFileSync(packageManifestPath, 'utf8'));
      if (publicName(packageManifest.name)) {
        const pin = pins.get(packageManifest.name);
        if (!pin)
          throw new Error(`unattested public package is installed: ${packageManifest.name}`);
        if (packageManifest.version !== pin.version)
          throw new Error(
            `installed public package identity does not match release: ${packageManifest.name}`,
          );
        assertPrivatePackageFiles(actual, packageManifest.name);
        roots.get(packageManifest.name).add(actual);
      }
    }
    for (const name of readdirSync(actual)) {
      const child = resolve(actual, name);
      const metadata = lstatSync(child);
      if (metadata.isDirectory()) visit(child);
      else if (metadata.isSymbolicLink()) {
        const target = realpathSync(child);
        if (statSync(target).isDirectory() && withinInstall(target)) visit(target);
        else if (statSync(target).isDirectory() && !workspaceRoots.has(target))
          throw new Error(
            `dependency installation contains an unexpected directory symlink: ${child}`,
          );
      }
    }
  };
  for (const nodeModulesRoot of canonicalNodeModulesRoots) visit(nodeModulesRoot);
  for (const [name, installed] of roots)
    if (installed.size === 0) throw new Error(`installed public package is missing: ${name}`);
  return {
    nodeModulesRoots: canonicalNodeModulesRoots,
    roots: new Map([...roots].map(([name, installed]) => [name, [...installed].sort()])),
  };
}

function snapshot(manifest, installedRoots) {
  return new Map(
    manifest.core.packages.map((pin) => {
      const digests = installedRoots.roots.get(pin.name).map((packageRoot) => {
        const content = packageContentDigest(packageRoot);
        if (content.contentSha256 !== pin.contentSha256 || content.fileCount !== pin.fileCount)
          throw new Error(`installed public package does not match release content: ${pin.name}`);
        return content.contentSha256;
      });
      return [pin.name, digests];
    }),
  );
}

function executable(name) {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = resolve(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return undefined;
}

function sandboxedCommand(cloudRoot, nodeModulesRoots, writablePaths, command) {
  const canonicalCloudRoot = realpathSync(cloudRoot);
  const writable = writablePaths.map((path) => {
    const absolute = resolve(cloudRoot, path);
    if (!isWithin(cloudRoot, absolute) || absolute === cloudRoot)
      throw new Error(`Cloud writable path must be a child of the private repository: ${path}`);
    const canonicalCandidate = resolve(canonicalCloudRoot, relative(cloudRoot, absolute));
    if (
      nodeModulesRoots.some(
        (nodeModules) =>
          isWithin(nodeModules, canonicalCandidate) || isWithin(canonicalCandidate, nodeModules),
      )
    )
      throw new Error(`Cloud writable path overlaps installed dependencies: ${path}`);
    mkdirSync(absolute, { recursive: true });
    const canonical = realpathSync(absolute);
    if (!isWithin(canonicalCloudRoot, canonical) || canonical === canonicalCloudRoot)
      throw new Error(`Cloud writable path escapes the private repository: ${path}`);
    if (
      nodeModulesRoots.some(
        (nodeModules) => isWithin(nodeModules, canonical) || isWithin(canonical, nodeModules),
      )
    )
      throw new Error(`Cloud writable path overlaps installed dependencies: ${path}`);
    return canonical;
  });
  if (!['darwin', 'linux'].includes(process.platform))
    throw new Error(
      `verified Cloud commands do not support immutable mounts on ${process.platform}`,
    );
  const bubblewrap = process.platform === 'linux' ? executable('bwrap') : undefined;
  if (process.platform === 'linux' && !bubblewrap)
    throw new Error('verified Cloud commands on Linux require bubblewrap for immutable mounts');
  const temporary = realpathSync(mkdtempSync(resolve(tmpdir(), 'tixkit-cloud-command-')));
  if (process.platform === 'darwin') {
    const escape = (path) => path.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
    const allowedWrites = [...new Set(['/dev/null', temporary, ...writable])]
      .map((path) => `(subpath "${escape(path)}")`)
      .join(' ');
    const profile = `(version 1)(deny default)(allow process*)(allow file-read*)(allow sysctl-read)(allow file-write* ${allowedWrites})`;
    return ['/usr/bin/sandbox-exec', ['-p', profile, ...command], temporary];
  }
  if (process.platform === 'linux') {
    const bindings = [...new Set([temporary, ...writable])].flatMap((path) => [
      '--bind',
      path,
      path,
    ]);
    return [
      bubblewrap,
      [
        '--die-with-parent',
        '--unshare-all',
        '--new-session',
        '--ro-bind',
        '/',
        '/',
        '--proc',
        '/proc',
        '--dev',
        '/dev',
        '--tmpfs',
        '/run',
        '--tmpfs',
        '/tmp',
        '--dir',
        temporary,
        ...bindings,
        '--unsetenv',
        'SSH_AUTH_SOCK',
        '--unsetenv',
        'DOCKER_HOST',
        '--unsetenv',
        'CONTAINER_HOST',
        '--unsetenv',
        'KUBECONFIG',
        '--unsetenv',
        'XDG_RUNTIME_DIR',
        '--chdir',
        cloudRoot,
        '--',
        ...command,
      ],
      temporary,
    ];
  }
  throw new Error('unreachable immutable command platform');
}

function assertCompleteManifest(manifest) {
  const schema = JSON.parse(
    readFileSync(resolve(publicRoot, 'distribution/cloud-core-compatibility.schema.json'), 'utf8'),
  );
  const violations = jsonSchemaViolations(manifest, schema);
  if (violations.length > 0)
    throw new Error(`Cloud/core install manifest is invalid:\n${violations.join('\n')}`);
}

export function verifyCloudCoreInstall(
  manifest,
  publicReleasePath,
  cloudRoot,
  command,
  writablePaths = [],
) {
  if (command.length === 0) throw new Error('a Cloud build/test command is required');
  assertCompleteManifest(manifest);
  const publicRelease = verifyPublicReleaseAttestation(publicRoot, publicReleasePath);
  const violations = validateCloudCoreConsumer(manifest, publicRelease, cloudRoot);
  if (violations.length > 0)
    throw new Error(`Cloud/core compatibility validation failed:\n${violations.join('\n')}`);
  const installedRoots = packageRoots(manifest, cloudRoot);
  const before = snapshot(manifest, installedRoots);
  const [sandbox, arguments_, temporary] = sandboxedCommand(
    cloudRoot,
    installedRoots.nodeModulesRoots,
    writablePaths,
    command,
  );
  let result;
  try {
    result = spawnSync(sandbox, arguments_, {
      cwd: cloudRoot,
      stdio: 'inherit',
      env: { ...process.env, TMPDIR: temporary, TMP: temporary, TEMP: temporary },
    });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Cloud command failed with status ${result.status}`);
  const after = snapshot(manifest, installedRoots);
  const changed = [...before].filter(
    ([name, digests]) => JSON.stringify(after.get(name)) !== JSON.stringify(digests),
  );
  if (changed.length > 0)
    throw new Error(
      `Cloud command modified installed public artifacts: ${changed.map(([name]) => name).join(', ')}`,
    );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const separator = process.argv.indexOf('--');
  if (separator === -1) throw new Error('separate the verified command with --');
  const options = process.argv.slice(2, separator);
  const cloudRoot = argument(options, '--cloud-root');
  const manifestPath = argument(options, '--manifest');
  const publicReleasePath = argument(options, '--public-release-manifest');
  verifyCloudCoreInstall(
    JSON.parse(readFileSync(manifestPath, 'utf8')),
    publicReleasePath,
    cloudRoot,
    process.argv.slice(separator + 1),
    argumentsFor(options, '--writable-path'),
  );
  process.stdout.write('Cloud command consumed immutable attested public artifacts.\n');
}
