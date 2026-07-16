#!/usr/bin/env node

import { spawn } from 'node:child_process';
import {
  constants,
  chmodSync,
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { createHash, createPublicKey, sign } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const root = resolve(import.meta.dirname, '..');
const components = ['api', 'worker', 'checkout', 'admin'];
const expectedAcknowledgements = {
  'zone-loss': 'I authorize production zone-loss fault injection and recovery',
  'dependency-loss': 'I authorize production dependency-loss fault injection and recovery',
  'release-upgrade-rollback': 'I authorize production release upgrade and application rollback',
};
const activeProcessGroups = new Set();
const processGroupTerminations = new Map();
let interruptedSignal;

function terminateProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

function processGroupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

function wait(milliseconds) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

function terminateAndConfirmProcessGroup(pid) {
  const existing = processGroupTerminations.get(pid);
  if (existing) return existing;
  const termination = (async () => {
    terminateProcessGroup(pid, 'SIGTERM');
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await wait(50);
      if (!processGroupExists(pid)) return;
    }
    terminateProcessGroup(pid, 'SIGKILL');
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await wait(50);
      if (!processGroupExists(pid)) return;
    }
    fail(`process group ${pid} survived SIGKILL`);
  })().finally(() => {
    processGroupTerminations.delete(pid);
    activeProcessGroups.delete(pid);
  });
  processGroupTerminations.set(pid, termination);
  return termination;
}

function handleSignal(signal) {
  interruptedSignal ??= signal;
  for (const pid of activeProcessGroups)
    void terminateAndConfirmProcessGroup(pid).catch(() => {
      // The active capture reports the termination failure.
    });
}

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || value === undefined) fail(`invalid argument ${flag ?? ''}`);
    options[flag.slice(2)] = value;
  }
  for (const required of ['config', 'evidence-dir', 'private-key', 'expectations'])
    if (!options[required]) fail(`--${required} is required`);
  return options;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}

function jsonBytes(value) {
  return `${JSON.stringify(canonical(value), null, 2)}\n`;
}

function loadValidated(path, schemaPath) {
  const value = JSON.parse(safeFile(path).bytes);
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
  const ajv = new Ajv({ allErrors: true, strict: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  if (!validate(value)) fail(`invalid ${path}: ${ajv.errorsText(validate.errors)}`);
  return value;
}

function safeFile(path, { executable = false, secret = false, ownerOnly = false, maxBytes } = {}) {
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile()) fail(`${path} must be a regular non-symlink file`);
    if (executable && (before.mode & 0o111) === 0) fail(`${path} must be executable`);
    if (secret && (before.mode & 0o077) !== 0) fail(`${path} must not be group/world accessible`);
    if (ownerOnly) {
      if (typeof process.getuid !== 'function') fail('owner verification requires a POSIX runtime');
      if (before.uid !== process.getuid()) fail(`${path} must be owned by the current user`);
      if ((before.mode & 0o077) !== 0) fail(`${path} must not be group/world accessible`);
    }
    let bytes;
    if (maxBytes === undefined) {
      bytes = readFileSync(descriptor);
    } else {
      if (before.size > maxBytes) fail(`${path} exceeds the ${maxBytes}-byte safety limit`);
      const bounded = Buffer.allocUnsafe(maxBytes + 1);
      let length = 0;
      while (length <= maxBytes) {
        const count = readSync(descriptor, bounded, length, maxBytes + 1 - length, null);
        if (count === 0) break;
        length += count;
      }
      if (length > maxBytes) fail(`${path} exceeds the ${maxBytes}-byte safety limit`);
      bytes = bounded.subarray(0, length);
    }
    const after = fstatSync(descriptor);
    if (
      !after.isFile() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.uid !== after.uid ||
      before.gid !== after.gid ||
      before.mode !== after.mode ||
      before.nlink !== after.nlink ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      fail(`${path} changed while it was being reviewed`);
    return { bytes, stat: after };
  } finally {
    closeSync(descriptor);
  }
}

function loadExpectations(path) {
  let expectations;
  try {
    expectations = JSON.parse(safeFile(path, { ownerOnly: true, maxBytes: 1024 * 1024 }).bytes);
  } catch (error) {
    fail(`invalid production expectations ${path}: ${error.message}`);
  }
  const proofSchema = JSON.parse(
    readFileSync(join(root, 'infra/production/rehearsal-proof.schema.json'), 'utf8'),
  );
  const expectationsSchema = JSON.parse(
    readFileSync(join(root, 'infra/production/rehearsal-expectations.schema.json'), 'utf8'),
  );
  const ajv = new Ajv({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addSchema(proofSchema);
  const validate = ajv.compile(expectationsSchema);
  if (!validate(expectations))
    fail(`invalid production expectations: ${ajv.errorsText(validate.errors)}`);
  return expectations;
}

function resolveConfigFile(configPath, value) {
  return isAbsolute(value) ? value : resolve(dirname(configPath), value);
}

async function capture(command, args, options = {}) {
  const { expectedExitCodes = [0], timeoutSeconds = 60, env = process.env } = options;
  return await new Promise((resolveRun, reject) => {
    const started = performance.now();
    const child = spawn(command, args, {
      detached: true,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    activeProcessGroups.add(child.pid);
    const stdout = [];
    const stderr = [];
    let stdoutSize = 0;
    let stderrSize = 0;
    let overflow = false;
    const collect = (chunks, kind) => (chunk) => {
      if (kind === 'stdout') stdoutSize += chunk.length;
      else stderrSize += chunk.length;
      if (stdoutSize + stderrSize > 4 * 1024 * 1024) {
        overflow = true;
        terminateProcessGroup(child.pid, 'SIGKILL');
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on('data', collect(stdout, 'stdout'));
    child.stderr.on('data', collect(stderr, 'stderr'));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void terminateAndConfirmProcessGroup(child.pid).catch(() => {
        // The close handler reports the termination failure.
      });
    }, timeoutSeconds * 1000);
    child.on('error', (error) => {
      clearTimeout(timer);
      activeProcessGroups.delete(child.pid);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      void (async () => {
        const hadDescendants = processGroupExists(child.pid);
        if (hadDescendants || timedOut || interruptedSignal)
          await terminateAndConfirmProcessGroup(child.pid);
        else activeProcessGroups.delete(child.pid);
        const out = Buffer.concat(stdout);
        const err = Buffer.concat(stderr);
        if (overflow) throw new Error(`${command} output exceeded 4 MiB`);
        if (signal)
          throw new Error(
            `${command} ${timedOut ? `timed out after ${timeoutSeconds}s` : `terminated by ${signal}`}`,
          );
        if (hadDescendants) throw new Error(`${command} left a descendant process after exit`);
        if (!expectedExitCodes.includes(code))
          throw new Error(`${command} exited ${code}; stderr sha256 ${sha256(err)}`);
        resolveRun({
          code,
          stdout: out,
          stderr: err,
          durationMilliseconds: Math.round(performance.now() - started),
        });
      })().catch(reject);
    });
  });
}

function commandIdentity(path) {
  const { bytes, stat } = safeFile(path, { executable: true });
  return { path, device: stat.dev, inode: stat.ino, sha256: sha256(bytes) };
}

function stageAdapters(configPath, config, evidenceDirectory) {
  assertEvidenceDirectory(evidenceDirectory);
  const stagingDirectory = mkdtempSync(join(evidenceDirectory.path, '.tixkit-reviewed-adapters-'));
  chmodSync(stagingDirectory, 0o700);
  const adapters = {};
  try {
    for (const [name, configuredPath] of Object.entries(config.adapters)) {
      const sourcePath = resolveConfigFile(configPath, configuredPath);
      const source = safeFile(sourcePath, { executable: true });
      const stagedPath = join(stagingDirectory, name);
      const descriptor = openSync(
        stagedPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
        0o500,
      );
      try {
        writeSync(descriptor, source.bytes);
        fchmodSync(descriptor, 0o500);
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      const identity = commandIdentity(stagedPath);
      if (identity.sha256 !== sha256(source.bytes)) fail(`staged adapter changed: ${name}`);
      adapters[name] = identity;
    }
    chmodSync(stagingDirectory, 0o500);
    assertEvidenceDirectory(evidenceDirectory);
    return { adapters, stagingDirectory };
  } catch (error) {
    try {
      assertEvidenceDirectory(evidenceDirectory);
      chmodSync(stagingDirectory, 0o700);
      rmSync(stagingDirectory, { recursive: true, force: true });
    } catch {
      // Never follow a replaced evidence-directory path during cleanup.
    }
    throw error;
  }
}

function assertIdentity(identity) {
  const current = commandIdentity(identity.path);
  if (
    current.device !== identity.device ||
    current.inode !== identity.inode ||
    current.sha256 !== identity.sha256
  )
    fail(`adapter changed after review: ${identity.path}`);
}

function parseAdapterResult(name, stdout, expectedHealthy) {
  let result;
  try {
    result = JSON.parse(stdout.toString('utf8'));
  } catch {
    fail(`${name} must emit one JSON adapter result`);
  }
  const keys = Object.keys(result).sort();
  if (
    JSON.stringify(keys) !==
    JSON.stringify(['healthy', 'observationCount', 'outageMilliseconds', 'schemaVersion'])
  )
    fail(`${name} adapter result contains an unexpected or missing field`);
  if (
    result.schemaVersion !== 'tixkit-production-adapter-result-v1' ||
    result.healthy !== expectedHealthy ||
    !Number.isSafeInteger(result.outageMilliseconds) ||
    result.outageMilliseconds < 0 ||
    result.outageMilliseconds > 7_200_000 ||
    !Number.isSafeInteger(result.observationCount) ||
    result.observationCount < 1 ||
    result.observationCount > 10_000_000
  )
    fail(`${name} adapter result is invalid`);
  return result;
}

async function runAdapter(
  name,
  identity,
  config,
  expectedExitCodes = [0],
  expectedHealthy = true,
  destructive = false,
) {
  assertIdentity(identity);
  if (destructive && interruptedSignal)
    fail(`refusing ${name}: operator interrupted the drill with ${interruptedSignal}`);
  const result = await capture(identity.path, [], {
    expectedExitCodes,
    timeoutSeconds: config.thresholds.adapterTimeoutSeconds,
    env: {
      ...process.env,
      TIXKIT_PRODUCTION_DRILL_ID: config.drillId,
      TIXKIT_PRODUCTION_DRILL_KIND: config.kind,
      TIXKIT_PRODUCTION_CONTEXT: config.expectedContext,
      TIXKIT_PRODUCTION_NAMESPACE: config.namespace,
      TIXKIT_PRODUCTION_RELEASE: config.release,
      ...(config.dependency ? { TIXKIT_PRODUCTION_DEPENDENCY: config.dependency } : {}),
    },
  });
  assertIdentity(identity);
  const adapterResult = parseAdapterResult(name, result.stdout, expectedHealthy);
  return {
    name,
    adapterSha256: identity.sha256,
    exitCode: result.code,
    durationMilliseconds: result.durationMilliseconds,
    stdoutSha256: sha256(result.stdout),
    stderrSha256: sha256(result.stderr),
    result: adapterResult,
  };
}

async function clusterIdentity(kubectl, config) {
  const context = (await capture(kubectl, ['config', 'current-context'])).stdout.toString().trim();
  if (context !== config.expectedContext)
    fail(`current context ${context} does not match ${config.expectedContext}`);
  const view = JSON.parse(
    (await capture(kubectl, ['config', 'view', '--minify', '-o', 'json'])).stdout,
  );
  const cluster = view.clusters?.[0]?.cluster;
  if (!cluster?.server?.startsWith('https://')) fail('cluster server must use HTTPS');
  const ca = cluster['certificate-authority-data'];
  if (typeof ca !== 'string' || ca.length === 0)
    fail('embedded cluster certificate authority is required');
  const systemNamespace = JSON.parse(
    (
      await capture(kubectl, [
        '--context',
        context,
        'get',
        'namespace',
        'kube-system',
        '-o',
        'json',
      ])
    ).stdout,
  );
  const namespace = JSON.parse(
    (
      await capture(kubectl, [
        '--context',
        context,
        'get',
        'namespace',
        config.namespace,
        '-o',
        'json',
      ])
    ).stdout,
  );
  if (!systemNamespace.metadata?.uid || !namespace.metadata?.uid)
    fail('cluster namespace UIDs are required');
  return {
    cluster: {
      context,
      server: cluster.server,
      caSha256: sha256(Buffer.from(ca, 'base64')),
      systemNamespaceUid: systemNamespace.metadata.uid,
    },
    namespace: { name: config.namespace, uid: namespace.metadata.uid },
  };
}

function releaseImageMap(manifest) {
  const images = manifest?.core?.images;
  if (!Array.isArray(images)) fail('public release manifest core.images is required');
  const mapped = {};
  for (const image of images) {
    const component = components.find(
      (candidate) => image.name === candidate || image.name.endsWith(`-${candidate}`),
    );
    if (component) mapped[component] = image.reference;
  }
  if (Object.keys(mapped).length !== components.length)
    fail('public release manifest must bind api, worker, checkout, and admin images');
  return mapped;
}

function releaseManifestIdentity(path) {
  const { bytes } = safeFile(path);
  const value = JSON.parse(bytes);
  const compatibilitySchema = JSON.parse(
    readFileSync(join(root, 'distribution/cloud-core-compatibility.schema.json'), 'utf8'),
  );
  const releaseSchema = JSON.parse(
    readFileSync(join(root, 'distribution/public-release-manifest.schema.json'), 'utf8'),
  );
  const ajv = new Ajv({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addSchema(compatibilitySchema);
  const validate = ajv.compile(releaseSchema);
  if (!validate(value))
    fail(`invalid public release manifest ${path}: ${ajv.errorsText(validate.errors)}`);
  return {
    identity: { sha256: sha256(bytes), size: bytes.length },
    images: releaseImageMap(value),
  };
}

async function snapshot(phase, kubectl, helm, config, expectedImages) {
  const base = ['--context', config.expectedContext, '--namespace', config.namespace];
  const selector = `app.kubernetes.io/instance=${config.release}`;
  const [deploymentsRun, replicaSetsRun, podsRun, nodesRun, metadataRun, valuesRun, manifestRun] =
    await Promise.all([
      capture(kubectl, [...base, 'get', 'deployments', '--selector', selector, '-o', 'json']),
      capture(kubectl, [...base, 'get', 'replicasets', '--selector', selector, '-o', 'json']),
      capture(kubectl, [...base, 'get', 'pods', '--selector', selector, '-o', 'json']),
      capture(kubectl, ['--context', config.expectedContext, 'get', 'nodes', '-o', 'json']),
      capture(helm, [
        'get',
        'metadata',
        config.release,
        '--namespace',
        config.namespace,
        '-o',
        'json',
      ]),
      capture(helm, [
        'get',
        'values',
        config.release,
        '--namespace',
        config.namespace,
        '--all',
        '-o',
        'json',
      ]),
      capture(helm, ['get', 'manifest', config.release, '--namespace', config.namespace]),
    ]);
  const deployments = JSON.parse(deploymentsRun.stdout);
  const replicaSets = JSON.parse(replicaSetsRun.stdout);
  const pods = JSON.parse(podsRun.stdout);
  const nodes = JSON.parse(nodesRun.stdout);
  const metadata = JSON.parse(metadataRun.stdout);
  const nodeZones = new Map(
    nodes.items.map((node) => [
      node.metadata?.name,
      {
        uid: node.metadata?.uid,
        zone: node.metadata?.labels?.['topology.kubernetes.io/zone'],
      },
    ]),
  );
  const images = {};
  const zones = {};
  const placements = {};
  const rollouts = {};
  for (const component of components) {
    const deployment = deployments.items.filter(
      (item) => item.metadata?.labels?.['app.kubernetes.io/component'] === component,
    );
    if (deployment.length !== 1) fail(`expected one ${component} deployment`);
    const currentDeployment = deployment[0];
    const replicas = currentDeployment.spec?.replicas;
    const revision = Number(
      currentDeployment.metadata?.annotations?.['deployment.kubernetes.io/revision'],
    );
    if (
      !currentDeployment.metadata?.uid ||
      !Number.isInteger(replicas) ||
      replicas < 2 ||
      !Number.isInteger(revision) ||
      revision < 1 ||
      currentDeployment.status?.observedGeneration < currentDeployment.metadata?.generation ||
      currentDeployment.status?.availableReplicas !== replicas ||
      currentDeployment.status?.readyReplicas !== replicas ||
      currentDeployment.status?.updatedReplicas !== replicas ||
      (currentDeployment.status?.unavailableReplicas ?? 0) !== 0
    )
      fail(`${phase} ${component} deployment rollout is not fully observed and available`);
    const image = currentDeployment.spec?.template?.spec?.containers?.[0]?.image;
    if (image !== expectedImages[component])
      fail(`${phase} ${component} image does not match the reviewed public release manifest`);
    images[component] = image;
    const activeReplicaSets = replicaSets.items.filter(
      (item) =>
        item.metadata?.labels?.['app.kubernetes.io/component'] === component &&
        item.metadata?.ownerReferences?.some(
          (owner) =>
            owner.kind === 'Deployment' &&
            owner.uid === currentDeployment.metadata.uid &&
            owner.controller === true,
        ) &&
        (item.spec?.replicas ?? 0) > 0,
    );
    if (activeReplicaSets.length !== 1)
      fail(`${phase} ${component} must have one active ReplicaSet`);
    const replicaSet = activeReplicaSets[0];
    const replicaSetRevision = Number(
      replicaSet.metadata?.annotations?.['deployment.kubernetes.io/revision'],
    );
    if (
      !replicaSet.metadata?.uid ||
      replicaSetRevision !== revision ||
      replicaSet.spec?.replicas !== replicas ||
      replicaSet.status?.readyReplicas !== replicas ||
      replicaSet.status?.availableReplicas !== replicas ||
      replicaSet.spec?.template?.spec?.containers?.[0]?.image !== expectedImages[component]
    )
      fail(`${phase} ${component} active ReplicaSet does not match the deployment revision`);
    const observed = new Set();
    const componentPlacements = [];
    for (const pod of pods.items.filter(
      (item) => item.metadata?.labels?.['app.kubernetes.io/component'] === component,
    )) {
      if (
        !pod.status?.conditions?.some(
          (condition) => condition.type === 'Ready' && condition.status === 'True',
        )
      )
        continue;
      const placement = nodeZones.get(pod.spec?.nodeName);
      const podImage = pod.spec?.containers?.[0]?.image;
      const containerStatus = pod.status?.containerStatuses?.[0];
      const digest = expectedImages[component].slice(expectedImages[component].indexOf('@sha256:'));
      if (
        !pod.metadata?.uid ||
        !pod.metadata.ownerReferences?.some(
          (owner) =>
            owner.kind === 'ReplicaSet' &&
            owner.uid === replicaSet.metadata.uid &&
            owner.controller === true,
        ) ||
        !placement?.uid ||
        !placement.zone ||
        podImage !== expectedImages[component] ||
        containerStatus?.ready !== true ||
        containerStatus.image !== expectedImages[component] ||
        !containerStatus.imageID?.endsWith(digest)
      )
        fail(`${phase} ${component} Ready pod does not run the reviewed image and digest`);
      observed.add(placement.zone);
      componentPlacements.push({
        podUid: pod.metadata.uid,
        nodeUid: placement.uid,
        nodeName: pod.spec.nodeName,
        zone: placement.zone,
        image: podImage,
        imageId: containerStatus.imageID,
      });
    }
    if (observed.size < 2) fail(`${component} Ready pods must span at least two zones`);
    zones[component] = [...observed].sort();
    placements[component] = componentPlacements.sort((left, right) =>
      left.podUid.localeCompare(right.podUid),
    );
    if (componentPlacements.length !== replicas)
      fail(`${phase} ${component} Ready pod count does not match desired replicas`);
    rollouts[component] = {
      deploymentUid: currentDeployment.metadata.uid,
      generation: currentDeployment.metadata.generation,
      revision,
      replicas,
      replicaSetUid: replicaSet.metadata.uid,
      replicaSetRevision,
    };
  }
  const revision = Number(metadata.version ?? metadata.revision);
  if (!Number.isInteger(revision) || revision < 1) fail('Helm release revision is invalid');
  const chart = metadata.chart ?? metadata.chartName;
  const appVersion = metadata.appVersion;
  if (!chart || !appVersion) fail('Helm chart and appVersion are required');
  return {
    phase,
    capturedAt: new Date().toISOString(),
    helm: {
      revision,
      chart,
      appVersion,
      manifestSha256: sha256(manifestRun.stdout),
      valuesSha256: sha256(valuesRun.stdout),
    },
    images,
    zones,
    placements,
    rollouts,
  };
}

function openEvidenceDirectory(evidenceDir) {
  const requestedPath = resolve(evidenceDir);
  const requested = lstatSync(requestedPath);
  if (requested.isSymbolicLink() || !requested.isDirectory())
    fail('--evidence-dir must be an existing non-symlink directory');
  if (typeof process.getuid !== 'function') fail('owner verification requires a POSIX runtime');
  if (requested.uid !== process.getuid()) fail('--evidence-dir must be owned by the current user');
  if ((requested.mode & 0o077) !== 0) fail('--evidence-dir must not be group/world accessible');
  const path = realpathSync(requestedPath);
  const descriptor = openSync(
    path,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
  );
  const opened = fstatSync(descriptor);
  if (
    !opened.isDirectory() ||
    opened.dev !== requested.dev ||
    opened.ino !== requested.ino ||
    opened.uid !== requested.uid
  ) {
    closeSync(descriptor);
    fail('--evidence-dir identity changed while it was opened');
  }
  return {
    path,
    descriptor,
    device: opened.dev,
    inode: opened.ino,
    uid: opened.uid,
  };
}

function assertEvidenceDirectory(evidenceDirectory) {
  const pathIdentity = lstatSync(evidenceDirectory.path);
  const descriptorIdentity = fstatSync(evidenceDirectory.descriptor);
  for (const identity of [pathIdentity, descriptorIdentity]) {
    if (
      identity.isSymbolicLink() ||
      !identity.isDirectory() ||
      identity.dev !== evidenceDirectory.device ||
      identity.ino !== evidenceDirectory.inode ||
      identity.uid !== evidenceDirectory.uid
    )
      fail('--evidence-dir identity changed during the rehearsal');
    if ((identity.mode & 0o077) !== 0)
      fail('--evidence-dir became group/world accessible during the rehearsal');
  }
  if (realpathSync(evidenceDirectory.path) !== evidenceDirectory.path)
    fail('--evidence-dir canonical path changed during the rehearsal');
}

function artifactIdentity(path, descriptor) {
  const identity = fstatSync(descriptor);
  if (
    !identity.isFile() ||
    identity.uid !== process.getuid() ||
    (identity.mode & 0o777) !== 0o400 ||
    identity.nlink !== 1
  )
    fail(`reserved production evidence artifact is unsafe: ${path}`);
  return {
    path,
    descriptor,
    device: identity.dev,
    inode: identity.ino,
    uid: identity.uid,
  };
}

function assertArtifactIdentity(artifact) {
  const descriptorIdentity = fstatSync(artifact.descriptor);
  const pathIdentity = lstatSync(artifact.path);
  for (const identity of [descriptorIdentity, pathIdentity])
    if (
      identity.isSymbolicLink() ||
      !identity.isFile() ||
      identity.dev !== artifact.device ||
      identity.ino !== artifact.inode ||
      identity.uid !== artifact.uid ||
      (identity.mode & 0o777) !== 0o400 ||
      identity.nlink !== 1
    )
      fail(`production evidence artifact identity changed: ${artifact.path}`);
}

function assertArtifactContent(artifact, expectedBytes) {
  const content = safeFile(artifact.path, { maxBytes: expectedBytes.length });
  if (
    content.stat.dev !== artifact.device ||
    content.stat.ino !== artifact.inode ||
    content.bytes.length !== expectedBytes.length ||
    sha256(content.bytes) !== sha256(expectedBytes)
  )
    fail(`production evidence artifact content is incomplete: ${artifact.path}`);
}

export function writeAll(descriptor, value, writer = writeSync) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  let offset = 0;
  while (offset < bytes.length) {
    const written = writer(descriptor, bytes, offset, bytes.length - offset);
    if (!Number.isInteger(written) || written <= 0 || written > bytes.length - offset)
      fail('production evidence artifact write made invalid progress');
    offset += written;
  }
  return bytes;
}

function openArtifacts(evidenceDirectory, drillId) {
  assertEvidenceDirectory(evidenceDirectory);
  const flags =
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0);
  const paths = {
    evidence: join(evidenceDirectory.path, `${drillId}.json`),
    signature: join(evidenceDirectory.path, `${drillId}.json.sig`),
    checksum: join(evidenceDirectory.path, `${drillId}.json.sha256`),
  };
  const artifacts = {};
  try {
    for (const [name, path] of Object.entries(paths)) {
      const descriptor = openSync(path, flags, 0o400);
      fchmodSync(descriptor, 0o400);
      artifacts[name] = artifactIdentity(path, descriptor);
    }
    fsyncSync(evidenceDirectory.descriptor);
    assertEvidenceDirectory(evidenceDirectory);
    for (const artifact of Object.values(artifacts)) assertArtifactIdentity(artifact);
  } catch (error) {
    for (const artifact of Object.values(artifacts)) closeSync(artifact.descriptor);
    throw new Error(`refusing to overwrite or follow production evidence path: ${error.message}`, {
      cause: error,
    });
  }
  return { artifacts, paths };
}

function publish(artifacts, evidenceDirectory, payload, signatureBytes) {
  assertEvidenceDirectory(evidenceDirectory);
  for (const artifact of Object.values(artifacts)) assertArtifactIdentity(artifact);
  const checksum = sha256(payload);
  const values = {
    evidence: payload,
    signature: `${signatureBytes.toString('base64')}\n`,
    checksum: `${checksum}  evidence.json\n`,
  };
  for (const [name, artifact] of Object.entries(artifacts)) {
    const expectedBytes = writeAll(artifact.descriptor, values[name]);
    if (fstatSync(artifact.descriptor).size !== expectedBytes.length)
      fail(`production evidence artifact has an unexpected size: ${artifact.path}`);
    fsyncSync(artifact.descriptor);
    assertArtifactIdentity(artifact);
    assertArtifactContent(artifact, expectedBytes);
  }
  fsyncSync(evidenceDirectory.descriptor);
  assertEvidenceDirectory(evidenceDirectory);
  for (const [name, artifact] of Object.entries(artifacts)) {
    assertArtifactIdentity(artifact);
    assertArtifactContent(artifact, Buffer.from(values[name]));
    closeSync(artifact.descriptor);
  }
}

function assertSnapshotTransitions(kind, snapshots) {
  if (kind === 'release-upgrade-rollback') {
    const [before, target, rollback] = snapshots;
    if (
      !(
        target.helm.revision > before.helm.revision && rollback.helm.revision > target.helm.revision
      )
    )
      fail('Helm upgrade and rollback revisions must increase monotonically');
    for (const component of components)
      if (
        !(
          target.rollouts[component].revision > before.rollouts[component].revision &&
          rollback.rollouts[component].revision > target.rollouts[component].revision
        )
      )
        fail(`${component} upgrade and rollback revisions must increase monotonically`);
    return;
  }
  const [before, recovered] = snapshots;
  if (
    before.helm.revision !== recovered.helm.revision ||
    before.helm.manifestSha256 !== recovered.helm.manifestSha256 ||
    before.helm.valuesSha256 !== recovered.helm.valuesSha256
  )
    fail('failure recovery unexpectedly changed the Helm release');
}

function assertReviewedExpectations(
  { config, identity, beforeManifest, targetManifest, adapters },
  expected,
) {
  const actual = {
    schemaVersion: 'tixkit-production-rehearsal-expectations-v1',
    drillId: config.drillId,
    kind: config.kind,
    ...(config.dependency ? { dependency: config.dependency } : {}),
    context: identity.cluster.context,
    clusterServer: identity.cluster.server,
    clusterCaSha256: identity.cluster.caSha256,
    systemNamespaceUid: identity.cluster.systemNamespaceUid,
    namespaceName: identity.namespace.name,
    namespaceUid: identity.namespace.uid,
    release: config.release,
    beforeReleaseSha256: beforeManifest.identity.sha256,
    beforeImages: beforeManifest.images,
    ...(targetManifest
      ? {
          targetReleaseSha256: targetManifest.identity.sha256,
          targetImages: targetManifest.images,
        }
      : {}),
    thresholds: config.thresholds,
    adapterSha256: Object.fromEntries(
      Object.entries(adapters).map(([name, adapter]) => [name, adapter.sha256]),
    ),
  };
  if (jsonBytes(actual) !== jsonBytes(expected))
    fail('production rehearsal inputs do not exactly match the reviewed expectations');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const configPath = resolve(options.config);
  const config = loadValidated(
    configPath,
    join(root, 'infra/production/rehearsal-config.schema.json'),
  );
  if (config.acknowledgement !== expectedAcknowledgements[config.kind])
    fail(`acknowledgement must exactly equal: ${expectedAcknowledgements[config.kind]}`);
  const keyPath = resolve(options['private-key']);
  const privateKeyBytes = safeFile(keyPath, { secret: true }).bytes;
  const publicKey = createPublicKey(privateKeyBytes);
  if (publicKey.asymmetricKeyType !== 'ed25519')
    fail('production evidence signing key must be Ed25519');
  const signingKeyFingerprint = sha256(publicKey.export({ type: 'spki', format: 'der' }));
  const expectations = loadExpectations(resolve(options.expectations));
  const evidenceDirectory = openEvidenceDirectory(options['evidence-dir']);
  let artifacts;
  let stagingDirectory;
  const signalHandlers = new Map(
    ['SIGINT', 'SIGTERM'].map((signal) => [signal, () => handleSignal(signal)]),
  );
  for (const [signal, handler] of signalHandlers) process.on(signal, handler);
  let published = false;
  try {
    const kubectl = options.kubectl ?? 'kubectl';
    const helm = options.helm ?? 'helm';
    const identity = await clusterIdentity(kubectl, config);
    const beforePath = resolveConfigFile(configPath, config.beforeReleaseManifest);
    const beforeManifest = releaseManifestIdentity(beforePath);
    const targetManifest = config.targetReleaseManifest
      ? releaseManifestIdentity(resolveConfigFile(configPath, config.targetReleaseManifest))
      : undefined;
    const staged = stageAdapters(configPath, config, evidenceDirectory);
    const adapters = staged.adapters;
    stagingDirectory = staged.stagingDirectory;
    assertReviewedExpectations(
      { config, identity, beforeManifest, targetManifest, adapters },
      expectations,
    );
    artifacts = openArtifacts(evidenceDirectory, config.drillId);
    const steps = [];
    const snapshots = [];
    const startedAt = new Date().toISOString();
    snapshots.push(await snapshot('before', kubectl, helm, config, beforeManifest.images));
    steps.push(await runAdapter('baseline-probe', adapters.baselineProbe, config));
    let recoveryStartedAt;
    let primaryError;
    let recoveryError;
    try {
      steps.push(await runAdapter('inject', adapters.inject, config, [0], true, true));
      const expectedDuring = config.kind === 'dependency-loss' ? [1] : [0];
      steps.push(
        await runAdapter(
          'during-probe',
          adapters.duringProbe,
          config,
          expectedDuring,
          config.kind !== 'dependency-loss',
        ),
      );
      if (config.kind === 'release-upgrade-rollback') {
        snapshots.push(await snapshot('target', kubectl, helm, config, targetManifest.images));
      }
    } catch (error) {
      primaryError = error;
    } finally {
      recoveryStartedAt = performance.now();
      try {
        steps.push(await runAdapter('recover', adapters.recover, config));
        steps.push(await runAdapter('recovered-probe', adapters.recoveredProbe, config));
      } catch (error) {
        recoveryError = error;
      }
    }
    if (recoveryError)
      throw new AggregateError(
        [...(primaryError ? [primaryError] : []), recoveryError],
        'production recovery failed',
      );
    const recoveredAt = performance.now();
    let finalSnapshotError;
    try {
      snapshots.push(
        await snapshot(
          config.kind === 'release-upgrade-rollback' ? 'rollback' : 'recovered',
          kubectl,
          helm,
          config,
          beforeManifest.images,
        ),
      );
    } catch (error) {
      finalSnapshotError = error;
    }
    if (primaryError || finalSnapshotError)
      throw new AggregateError(
        [
          ...(primaryError ? [primaryError] : []),
          ...(finalSnapshotError ? [finalSnapshotError] : []),
        ],
        'production drill or verified recovery failed',
      );
    assertSnapshotTransitions(config.kind, snapshots);
    if (interruptedSignal)
      fail(`production drill interrupted by ${interruptedSignal} after recovery`);
    const outageSeconds =
      steps.reduce((total, step) => total + step.result.outageMilliseconds, 0) / 1000;
    const recoverySeconds = (recoveredAt - recoveryStartedAt) / 1000;
    if (outageSeconds > config.thresholds.maxOutageSeconds)
      fail(`measured outage ${outageSeconds.toFixed(3)}s exceeded threshold`);
    if (recoverySeconds > config.thresholds.maxRecoverySeconds)
      fail(`measured recovery ${recoverySeconds.toFixed(3)}s exceeded threshold`);
    const completedAt = new Date().toISOString();
    const proof = {
      schemaVersion: 'tixkit-production-rehearsal-proof-v1',
      status: 'passed',
      drillId: config.drillId,
      kind: config.kind,
      ...(config.dependency ? { dependency: config.dependency } : {}),
      acknowledgement: config.acknowledgement,
      ...identity,
      release: config.release,
      releaseManifests: {
        before: beforeManifest.identity,
        ...(targetManifest ? { target: targetManifest.identity } : {}),
      },
      thresholds: config.thresholds,
      startedAt,
      completedAt,
      measurements: { outageSeconds, recoverySeconds },
      steps,
      snapshots,
      signingKeyFingerprint,
    };
    const proofSchema = JSON.parse(
      readFileSync(join(root, 'infra/production/rehearsal-proof.schema.json'), 'utf8'),
    );
    const ajv = new Ajv({ allErrors: true, strict: true });
    addFormats(ajv);
    const validate = ajv.compile(proofSchema);
    if (!validate(proof)) fail(`generated invalid proof: ${ajv.errorsText(validate.errors)}`);
    const payload = jsonBytes(proof);
    publish(
      artifacts.artifacts,
      evidenceDirectory,
      payload,
      sign(null, Buffer.from(payload), privateKeyBytes),
    );
    published = true;
    process.stdout.write(`${artifacts.paths.evidence}\n`);
  } finally {
    if (!published && artifacts)
      for (const artifact of Object.values(artifacts.artifacts))
        try {
          closeSync(artifact.descriptor);
        } catch {}
    if (stagingDirectory) {
      try {
        assertEvidenceDirectory(evidenceDirectory);
        chmodSync(stagingDirectory, 0o700);
        rmSync(stagingDirectory, { recursive: true, force: true });
      } catch {
        // Fail closed without following a replaced evidence-directory path.
      }
    }
    try {
      closeSync(evidenceDirectory.descriptor);
    } catch {}
    privateKeyBytes.fill(0);
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
  }
}

function formatError(error, indent = '') {
  const current = `${indent}${error.stack ?? error.message}`;
  if (!(error instanceof AggregateError)) return current;
  return [current, ...error.errors.map((cause) => formatError(cause, `${indent}  `))].join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    process.stderr.write(`${formatError(error)}\n`);
    process.exitCode = 1;
  });
