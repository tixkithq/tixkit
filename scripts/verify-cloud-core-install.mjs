#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  accessSync,
  closeSync,
  chmodSync,
  constants,
  cpSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jsonSchemaViolations } from './lib/public-distribution.mjs';
import { directoryContentDigest, packageContentDigest } from './lib/package-content-digest.mjs';
import { verifyPublicReleaseAttestation } from './lib/public-release-attestation.mjs';
import { parseBunLock, validateCloudCoreConsumer } from './validate-cloud-core-consumer.mjs';

const publicRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const gitExecutable = '/usr/bin/git';
const tarExecutable = '/usr/bin/tar';
const bubblewrapExecutable = '/usr/bin/bwrap';

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

function canonicalExistingPath(path) {
  try {
    return lstatSync(path, { throwIfNoEntry: false }) ? realpathSync(path) : path;
  } catch {
    return path;
  }
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

function installationInventory(cloudRoot, nodeModulesRoots) {
  const canonicalRoot = realpathSync(cloudRoot);
  return nodeModulesRoots
    .map((installationRoot) => ({
      path: relative(canonicalRoot, installationRoot).split(sep).join('/'),
      ...directoryContentDigest(installationRoot, canonicalRoot),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function assertInstallationInventory(manifest, cloudRoot, nodeModulesRoots) {
  const actual = installationInventory(cloudRoot, nodeModulesRoots);
  const expected = [...manifest.cloudRelease.installations].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error('installed dependency inventory does not match the private Cloud release');
}

function materializeCloudCommand(cloudRoot, sourceCommit, nodeModulesRoots, writablePaths) {
  const canonicalCloudRoot = realpathSync(cloudRoot);
  const materializedRoot = realpathSync(
    mkdtempSync(resolve(dirname(canonicalCloudRoot), '.tixkit-cloud-source-')),
  );
  try {
    const archive = spawnSync(gitExecutable, ['archive', '--format=tar', sourceCommit], {
      cwd: cloudRoot,
      encoding: 'buffer',
      env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
      maxBuffer: 1024 * 1024 * 1024,
    });
    if (archive.error) throw archive.error;
    if (archive.status !== 0)
      throw new Error(`private Cloud source archive failed with status ${archive.status}`);
    const extraction = spawnSync(tarExecutable, ['-xf', '-', '-C', materializedRoot], {
      input: archive.stdout,
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    if (extraction.error) throw extraction.error;
    if (extraction.status !== 0)
      throw new Error(`private Cloud source extraction failed with status ${extraction.status}`);

    for (const nodeModulesRoot of nodeModulesRoots) {
      const path = relative(canonicalCloudRoot, nodeModulesRoot);
      if (path === '..' || path.startsWith(`..${sep}`))
        throw new Error('installed dependency root escapes the private Cloud repository');
      const destination = resolve(materializedRoot, path);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(nodeModulesRoot, destination, {
        recursive: true,
        verbatimSymlinks: true,
      });
    }

    const normalizedWritablePaths = writablePaths.map((path) => {
      const absolute = resolve(cloudRoot, path);
      if (!isWithin(cloudRoot, absolute) || absolute === cloudRoot)
        throw new Error(`Cloud writable path must be a child of the private repository: ${path}`);
      return { absolute, path };
    });
    if (normalizedWritablePaths.length > 1)
      throw new Error('verified Cloud commands require one common writable output root');
    for (const [index, left] of normalizedWritablePaths.entries())
      for (const right of normalizedWritablePaths.slice(index + 1))
        if (isWithin(left.absolute, right.absolute) || isWithin(right.absolute, left.absolute))
          throw new Error(`Cloud writable paths must not overlap: ${left.path}, ${right.path}`);
    const writable = normalizedWritablePaths.map(({ absolute, path }) => {
      const canonicalCandidate = resolve(canonicalCloudRoot, relative(cloudRoot, absolute));
      if (
        nodeModulesRoots.some(
          (nodeModules) =>
            isWithin(nodeModules, canonicalCandidate) || isWithin(canonicalCandidate, nodeModules),
        )
      )
        throw new Error(`Cloud writable path overlaps installed dependencies: ${path}`);
      if (lstatSync(absolute, { throwIfNoEntry: false }))
        throw new Error(`Cloud writable path must be absent before execution: ${path}`);
      const parent = dirname(absolute);
      const canonicalParent = realpathSync(parent);
      if (!isWithin(canonicalCloudRoot, canonicalParent))
        throw new Error(`Cloud writable path parent escapes the private repository: ${path}`);
      const materializedPath = resolve(materializedRoot, relative(cloudRoot, absolute));
      if (lstatSync(materializedPath, { throwIfNoEntry: false }))
        throw new Error(`Cloud writable path overlaps committed source: ${path}`);
      mkdirSync(materializedPath, { recursive: true });
      return {
        destination: absolute,
        destinationParent: canonicalParent,
        destinationParentIdentity: lstatSync(canonicalParent),
        staging: realpathSync(materializedPath),
      };
    });
    return { materializedRoot, writable };
  } catch (error) {
    rmSync(materializedRoot, { recursive: true, force: true });
    throw error;
  }
}

function sandboxEnvironment(cloudRoot, materializedRoot, nodeModulesRoots) {
  const forbiddenPath = `${cloudRoot}${sep}`;
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        value !== undefined &&
        ![
          'BABEL_CONFIG_PATH',
          'BUN_INSTALL',
          'BUN_INSTALL_CACHE_DIR',
          'INIT_CWD',
          'NODE_OPTIONS',
          'NODE_PATH',
          'OLDPWD',
          'PWD',
          'SWC_BINARY_PATH',
          'TS_NODE_PROJECT',
          'npm_config_local_prefix',
          'npm_config_prefix',
          'npm_execpath',
          'npm_node_execpath',
          'npm_package_json',
        ].includes(key) &&
        value !== cloudRoot &&
        !value.includes(forbiddenPath),
    ),
  );
  const path = [
    ...nodeModulesRoots.map((root) => resolve(root, '.bin')),
    dirname(process.execPath),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ];
  return {
    ...environment,
    INIT_CWD: materializedRoot,
    PATH: [...new Set(path)].join(delimiter),
    PWD: materializedRoot,
  };
}

function sandboxedCommand(originalCloudRoot, cloudRoot, nodeModulesRoots, writable, command) {
  const canonicalOriginalCloudRoot = realpathSync(originalCloudRoot);
  for (const argument of command) {
    const absolute = resolve(argument);
    const canonicalArgument = canonicalExistingPath(absolute);
    if (
      argument.startsWith(sep) &&
      (canonicalArgument === canonicalOriginalCloudRoot ||
        isWithin(canonicalOriginalCloudRoot, canonicalArgument) ||
        isWithin(canonicalArgument, canonicalOriginalCloudRoot))
    )
      throw new Error(`Cloud command argument references live checkout: ${argument}`);
  }
  for (const argument of command.slice(1))
    if (argument.startsWith(sep))
      throw new Error(`Cloud command contains an undeclared absolute input: ${argument}`);
  if (!['darwin', 'linux'].includes(process.platform))
    throw new Error(
      `verified Cloud commands do not support immutable mounts on ${process.platform}`,
    );
  let bubblewrap;
  if (process.platform === 'linux')
    try {
      accessSync(bubblewrapExecutable, constants.X_OK);
      bubblewrap = bubblewrapExecutable;
    } catch {}
  if (process.platform === 'linux' && !bubblewrap)
    throw new Error('verified Cloud commands on Linux require bubblewrap for immutable mounts');
  const temporary = realpathSync(mkdtempSync(resolve(tmpdir(), 'tixkit-cloud-command-')));
  if (process.platform === 'darwin') {
    const escape = (path) => path.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
    const allowedReadPaths = [
      '/System/Library',
      '/System/Cryptexes/OS',
      '/usr/lib',
      '/usr/bin',
      '/usr/share/icu',
      '/bin',
      '/sbin',
      '/dev',
      cloudRoot,
      temporary,
      process.execPath,
      realpathSync(process.execPath),
    ].filter((path) => {
      const canonicalPath = canonicalExistingPath(path);
      return (
        canonicalPath !== canonicalOriginalCloudRoot &&
        !isWithin(canonicalOriginalCloudRoot, canonicalPath) &&
        !isWithin(canonicalPath, canonicalOriginalCloudRoot)
      );
    });
    const allowedReads = allowedReadPaths
      .map(
        (path) =>
          `(allow file-read* (literal "${escape(path)}"))(allow file-read* (subpath "${escape(path)}"))`,
      )
      .join('');
    const readAncestors = [
      ...new Set(
        allowedReadPaths.flatMap((path) => {
          const ancestors = [];
          for (let parent = dirname(path); parent !== '/'; parent = dirname(parent))
            ancestors.push(parent);
          return ancestors;
        }),
      ),
    ]
      .map((path) => `(allow file-read* (literal "${escape(path)}"))`)
      .join('');
    const runtimeReadLiterals = ['/System/Volumes/Data', '/var']
      .map((path) => `(allow file-read* (literal "${escape(path)}"))`)
      .join('');
    const allowedWrites = [
      ...new Set([
        '/dev/null',
        '/dev/dtracehelper',
        temporary,
        ...writable.map(({ staging }) => staging),
      ]),
    ]
      .map((path) => `(subpath "${escape(path)}")`)
      .join(' ');
    const profile = `(version 1)(deny default)(allow process*)(allow file-read* (literal "/"))${runtimeReadLiterals}${readAncestors}${allowedReads}(allow sysctl-read)(allow file-write* ${allowedWrites})`;
    return ['/usr/bin/sandbox-exec', ['-p', profile, ...command], temporary];
  }
  if (process.platform === 'linux') {
    const runtimeReads = [
      '/usr/bin',
      '/usr/lib',
      '/usr/lib64',
      '/usr/share/icu',
      '/usr/share/zoneinfo',
      '/bin',
      '/lib',
      '/lib64',
      '/etc/ld.so.cache',
      '/etc/ssl/certs',
      process.execPath,
      realpathSync(process.execPath),
      cloudRoot,
    ].filter((path) => lstatSync(path, { throwIfNoEntry: false }));
    const readBindings = [...new Set(runtimeReads)].flatMap((path) => ['--ro-bind', path, path]);
    const bindings = [...new Set([temporary, ...writable.map(({ staging }) => staging)])].flatMap(
      (path) => ['--bind', path, path],
    );
    return [
      bubblewrap,
      [
        '--die-with-parent',
        '--unshare-all',
        '--new-session',
        '--tmpfs',
        '/',
        ...readBindings,
        '--proc',
        '/proc',
        '--dev',
        '/dev',
        '--tmpfs',
        '/run',
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

function assertPublishableOutput(path) {
  for (const name of readdirSync(path)) {
    const child = resolve(path, name);
    const metadata = lstatSync(child);
    if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile()))
      throw new Error(`Cloud writable output contains an unsafe entry: ${child}`);
    if (metadata.isDirectory()) assertPublishableOutput(child);
  }
}

function publishWritableOutputs(writable) {
  for (const { destination, destinationParent, destinationParentIdentity, staging } of writable) {
    assertPublishableOutput(staging);
    if (lstatSync(destination, { throwIfNoEntry: false }))
      throw new Error(`Cloud writable path changed before output publication: ${destination}`);
    const parent = dirname(destination);
    const currentParent = lstatSync(destinationParent);
    if (
      realpathSync(parent) !== destinationParent ||
      currentParent.dev !== destinationParentIdentity.dev ||
      currentParent.ino !== destinationParentIdentity.ino
    )
      throw new Error(
        `Cloud writable path parent changed before output publication: ${destination}`,
      );
    const descriptor = openSync(
      staging,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    let candidate;
    try {
      const identity = fstatSync(descriptor);
      const expectedDigest = directoryContentDigest(staging, staging);
      const stagedPath = lstatSync(staging);
      if (
        !stagedPath.isDirectory() ||
        stagedPath.dev !== identity.dev ||
        stagedPath.ino !== identity.ino
      )
        throw new Error(`Cloud writable staging root changed before publication: ${destination}`);
      candidate = mkdtempSync(resolve(dirname(staging), '.tixkit-publish-'));
      rmSync(candidate, { recursive: true });
      renameSync(staging, candidate);
      const candidatePath = lstatSync(candidate);
      if (
        !candidatePath.isDirectory() ||
        candidatePath.dev !== identity.dev ||
        candidatePath.ino !== identity.ino
      )
        throw new Error(
          `Cloud writable staging identity changed before publication: ${destination}`,
        );
      if (
        JSON.stringify(directoryContentDigest(candidate, candidate)) !==
        JSON.stringify(expectedDigest)
      )
        throw new Error(
          `Cloud writable output changed while creating publication candidate: ${destination}`,
        );
      if (lstatSync(destination, { throwIfNoEntry: false }))
        throw new Error(`Cloud writable path changed before output publication: ${destination}`);
      renameSync(candidate, destination);
      const published = lstatSync(destination);
      if (
        !published.isDirectory() ||
        published.dev !== identity.dev ||
        published.ino !== identity.ino
      ) {
        rmSync(destination, { recursive: true, force: true });
        throw new Error(
          `Cloud writable staging identity changed during publication: ${destination}`,
        );
      }
      const publishedParent = lstatSync(destinationParent);
      if (
        realpathSync(parent) !== destinationParent ||
        publishedParent.dev !== destinationParentIdentity.dev ||
        publishedParent.ino !== destinationParentIdentity.ino
      ) {
        rmSync(destination, { recursive: true, force: true });
        throw new Error(
          `Cloud writable path parent changed during output publication: ${destination}`,
        );
      }
      try {
        assertPublishableOutput(destination);
        if (
          JSON.stringify(directoryContentDigest(destination, destination)) !==
          JSON.stringify(expectedDigest)
        )
          throw new Error(`Cloud writable output changed during publication: ${destination}`);
      } catch (error) {
        rmSync(destination, { recursive: true, force: true });
        throw error;
      }
    } finally {
      closeSync(descriptor);
      if (candidate) rmSync(candidate, { recursive: true, force: true });
    }
  }
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
  releaseInputPaths = [],
) {
  if (command.length === 0) throw new Error('a Cloud build/test command is required');
  assertCompleteManifest(manifest);
  const publicRelease = verifyPublicReleaseAttestation(publicRoot, publicReleasePath);
  const violations = validateCloudCoreConsumer(manifest, publicRelease, cloudRoot, {
    allowedPaths: [publicReleasePath, ...releaseInputPaths],
  });
  if (violations.length > 0)
    throw new Error(`Cloud/core compatibility validation failed:\n${violations.join('\n')}`);
  const sourceRoots = packageRoots(manifest, cloudRoot);
  assertInstallationInventory(manifest, cloudRoot, sourceRoots.nodeModulesRoots);
  const { materializedRoot, writable } = materializeCloudCommand(
    cloudRoot,
    manifest.cloudRelease.sourceCommit,
    sourceRoots.nodeModulesRoots,
    writablePaths,
  );
  let result;
  try {
    const installedRoots = packageRoots(manifest, materializedRoot);
    assertInstallationInventory(manifest, materializedRoot, installedRoots.nodeModulesRoots);
    const before = snapshot(manifest, installedRoots);
    const [sandbox, arguments_, temporary] = sandboxedCommand(
      cloudRoot,
      materializedRoot,
      installedRoots.nodeModulesRoots,
      writable,
      command,
    );
    try {
      result = spawnSync(sandbox, arguments_, {
        cwd: materializedRoot,
        stdio: 'inherit',
        env: {
          ...sandboxEnvironment(
            realpathSync(cloudRoot),
            materializedRoot,
            installedRoots.nodeModulesRoots,
          ),
          TMPDIR: temporary,
          TMP: temporary,
          TEMP: temporary,
        },
      });
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(
        `Cloud command failed with status ${result.status}${result.signal ? ` (${result.signal})` : ''}`,
      );
    const after = snapshot(manifest, installedRoots);
    const changed = [...before].filter(
      ([name, digests]) => JSON.stringify(after.get(name)) !== JSON.stringify(digests),
    );
    if (changed.length > 0)
      throw new Error(
        `Cloud command modified installed public artifacts: ${changed.map(([name]) => name).join(', ')}`,
      );
    publishWritableOutputs(writable);
  } finally {
    rmSync(materializedRoot, { recursive: true, force: true });
  }
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
    [manifestPath],
  );
  process.stdout.write('Cloud command consumed immutable attested public artifacts.\n');
}
