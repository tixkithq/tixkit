#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
  cpSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statfsSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { availableParallelism, platform, release, totalmem, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { assertAuthoritativePublicRepository } from './lib/authoritative-public-repository.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const minimum = Object.freeze({
  cpuCores: 4,
  memoryBytes: 12 * 1024 ** 3,
  diskBytes: 30 * 1024 ** 3,
});
const runningServices = Object.freeze([
  'admin',
  'api',
  'checkout',
  'clamav',
  'minio',
  'postgres',
  'redis',
  'temporal',
  'temporal-postgres',
  'temporal-ui',
  'worker',
]);
const completedServices = Object.freeze(['migrate', 'seed', 'storage-init']);
const servicesWithoutHealthcheck = Object.freeze(['temporal-ui']);
const minioClientImage =
  'minio/mc:RELEASE.2025-08-13T08-35-41Z@sha256:a7fe349ef4bd8521fb8497f55c6042871b2ae640607cf99d9bede5e9bdf11727';
const dockerDiskProbeImage =
  'postgres:16-alpine@sha256:e013e867e712fec275706a6c51c966f0bb0c93cfa8f51000f85a15f9865a28cb';
const compactEicarSignature =
  'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
const scannerHealthyProbe = `const {scanUploadBuffer}=await import('./packages/api/dist/services/uploads.js');const clean=await scanUploadBuffer(Buffer.from('tixkit compact clean scanner probe'));const infected=await scanUploadBuffer(Buffer.from(${JSON.stringify(compactEicarSignature)}));if(!clean.clean||clean.result!=='stream: OK'||infected.clean||!infected.result.endsWith(' FOUND'))throw new Error('Compact malware scanner did not classify the bounded probes correctly.');`;
const scannerMaximumUploadProbe = `const {scanUploadBuffer}=await import('./packages/api/dist/services/uploads.js');const result=await scanUploadBuffer(Buffer.alloc(50*1024*1024,0x61));if(!result.clean||result.result!=='stream: OK')throw new Error('Compact malware scanner did not accept the maximum upload size.');`;
const scannerUnavailableProbe = `const {scanUploadBuffer}=await import('./packages/api/dist/services/uploads.js');try{await scanUploadBuffer(Buffer.from('tixkit compact unavailable scanner probe'));throw new Error('Compact malware scanner unexpectedly accepted a probe while stopped.');}catch(error){if(error?.message!=='Upload malware scanner is unavailable')throw error;}`;
const proofSchema = JSON.parse(readFileSync(join(root, 'infra/compact/proof.schema.json'), 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: true });
addFormats(ajv);
const validateProofSchema = ajv.compile(proofSchema);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function git(arguments_) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('/usr/bin/git', arguments_, {
      cwd: root,
      env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolvePromise(Buffer.concat(stdout).toString('utf8').trim());
      else
        reject(new Error(Buffer.concat(stderr).toString('utf8').trim() || 'Git command failed.'));
    });
  });
}

export function validateHostEnvelope(host) {
  for (const [key, required] of Object.entries(minimum)) {
    if (!Number.isSafeInteger(host[key]) || host[key] < required) {
      throw new Error(`Compact proof requires ${key} >= ${required}; found ${String(host[key])}.`);
    }
  }
  if (!['arm64', 'x64'].includes(host.architecture))
    throw new Error(
      `Compact proof requires a supported 64-bit architecture; found ${host.architecture}.`,
    );
  return host;
}

export function validateDockerEnvelope(docker) {
  const envelope = {
    cpuCores: docker.NCPU,
    memoryBytes: docker.MemTotal,
    architecture: String(docker.Architecture ?? '')
      .toLowerCase()
      .replace('aarch64', 'arm64'),
    operatingSystem: docker.OperatingSystem,
    serverVersion: docker.ServerVersion,
    diskBytes: docker.diskBytes,
    diskScope: 'docker-writable-layer',
    contextName: docker.contextName,
    endpointKind: docker.endpointKind,
    endpointSha256: docker.endpointSha256,
  };
  if (!Number.isSafeInteger(envelope.cpuCores) || envelope.cpuCores < minimum.cpuCores)
    throw new Error(
      `Compact proof requires Docker cpuCores >= ${minimum.cpuCores}; found ${String(envelope.cpuCores)}.`,
    );
  if (!Number.isSafeInteger(envelope.memoryBytes) || envelope.memoryBytes < minimum.memoryBytes)
    throw new Error(
      `Compact proof requires Docker memoryBytes >= ${minimum.memoryBytes}; found ${String(envelope.memoryBytes)}.`,
    );
  if (!['arm64', 'x86_64', 'x64'].includes(envelope.architecture))
    throw new Error(
      `Compact proof requires a supported 64-bit Docker architecture; found ${envelope.architecture}.`,
    );
  if (!Number.isSafeInteger(envelope.diskBytes) || envelope.diskBytes < minimum.diskBytes)
    throw new Error(
      `Compact proof requires Docker diskBytes >= ${minimum.diskBytes}; found ${String(envelope.diskBytes)}.`,
    );
  if (
    typeof envelope.contextName !== 'string' ||
    !envelope.contextName ||
    envelope.endpointKind !== 'local-unix' ||
    !/^[a-f0-9]{64}$/u.test(envelope.endpointSha256 ?? '')
  )
    throw new Error('Compact proof requires a bound local Unix Docker context.');
  return envelope;
}

export function validateOperatingEnvironment(host, docker) {
  if (host.platform === 'linux') return { host, docker };
  if (host.platform === 'darwin' && /docker desktop/iu.test(docker.operatingSystem))
    return { host, docker };
  throw new Error('Compact proof requires Linux or macOS with Docker Desktop.');
}

function parseAvailableDiskBytes(output) {
  const lines = output.trim().split('\n');
  const fields = lines.at(-1)?.trim().split(/\s+/u) ?? [];
  const availableKiB = Number(fields[3]);
  if (!Number.isSafeInteger(availableKiB) || availableKiB < 1)
    throw new Error('Compact proof could not determine Docker writable-layer capacity.');
  return availableKiB * 1024;
}

export function parseComposeServices(output) {
  const trimmed = output.trim();
  if (!trimmed) throw new Error('Compact Compose returned no service state.');
  let rows;
  try {
    const parsed = JSON.parse(trimmed);
    rows = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    rows = trimmed.split('\n').map((line) => JSON.parse(line));
  }
  const services = new Map();
  for (const row of rows) {
    const service = row.Service ?? row.service;
    if (typeof service !== 'string' || services.has(service))
      throw new Error('Compact Compose returned invalid or duplicate service state.');
    services.set(service, {
      service,
      state: String(row.State ?? row.state ?? '').toLowerCase(),
      health: String(row.Health ?? row.health ?? '').toLowerCase(),
      exitCode: Number(row.ExitCode ?? row.exitCode ?? 0),
    });
  }
  return [...services.values()].sort((left, right) => left.service.localeCompare(right.service));
}

export function validateCompleteServiceState(services) {
  const byName = new Map(services.map((service) => [service.service, service]));
  const expected = [...runningServices, ...completedServices].sort();
  if (services.length !== expected.length || expected.some((name) => !byName.has(name)))
    throw new Error('Compact proof requires the exact 14-service profile.');
  for (const name of runningServices) {
    const service = byName.get(name);
    const expectedHealth = servicesWithoutHealthcheck.includes(name) ? '' : 'healthy';
    if (service.state !== 'running' || service.health !== expectedHealth)
      throw new Error(`Compact service ${name} is not in its expected running health state.`);
  }
  for (const name of completedServices) {
    const service = byName.get(name);
    if (service.state !== 'exited' || service.exitCode !== 0)
      throw new Error(`Compact initialization service ${name} did not exit successfully.`);
  }
  return services;
}

function secureOutputDirectory(path) {
  const output = resolve(path);
  const repositoryRelative = relative(root, output);
  if (
    repositoryRelative === '' ||
    (!repositoryRelative.startsWith(`..${sep}`) && repositoryRelative !== '..')
  )
    throw new Error('Compact proof output must be outside the repository.');
  const parent = dirname(output);
  if (
    !existsSync(parent) ||
    !statSync(parent).isDirectory() ||
    lstatSync(parent).isSymbolicLink() ||
    realpathSync(parent) !== parent
  )
    throw new Error('Compact proof output parent must be an existing non-symlink directory.');
  mkdirSync(output, { mode: 0o700 });
  return output;
}

function hostEnvelope() {
  const filesystem = statfsSync(root, { bigint: true });
  return validateHostEnvelope({
    cpuCores: availableParallelism(),
    memoryBytes: totalmem(),
    diskBytes: Number(filesystem.bavail * filesystem.bsize),
    architecture: process.arch,
    platform: platform(),
    platformRelease: release(),
  });
}

function composeArguments(...arguments_) {
  return [
    'compose',
    '--project-name',
    'tixkit-compact',
    '--env-file',
    join(root, 'infra/compact/.env'),
    '-f',
    join(root, 'infra/compact/compose.yml'),
    ...arguments_,
  ];
}

function writeBytesExclusive(path, bytes) {
  const descriptor = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(descriptor, bytes);
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function writeCompactProofArtifact(path, value) {
  writeBytesExclusive(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function assertCompactProofSchema(value) {
  if (!validateProofSchema(value)) {
    throw new Error(
      `Compact proof evidence violates its schema: ${ajv.errorsText(validateProofSchema.errors)}`,
    );
  }
  if (value.source.commit !== value.remote.object)
    throw new Error('Compact proof source commit differs from its advertised remote object.');
  for (const services of Object.values(value.phases)) validateCompleteServiceState(services);
  for (const command of value.commands) {
    const consistent =
      command.signal === null &&
      ((command.expectedOutcome === 'success' && command.exitCode === 0) ||
        (command.expectedOutcome === 'failure' && command.exitCode > 0));
    if (!consistent)
      throw new Error('Compact proof command outcome differs from its exit status or signal.');
    if (
      command.expectedOutcome === 'success'
        ? command.failurePattern !== null || command.failureMatched !== null
        : typeof command.failurePattern !== 'string' || command.failureMatched !== true
    )
      throw new Error('Compact proof command failure assertion is incomplete.');
  }
  const negativeCommandIndexes = new Set();
  for (const proof of value.negativeRestoreProof) {
    const command = value.commands[proof.commandIndex];
    if (
      !command ||
      command.expectedOutcome !== 'failure' ||
      command.exitCode !== proof.expectedExitCode ||
      command.assertion !== `negative-restore-${proof.id}` ||
      JSON.stringify(proof.before) !== JSON.stringify(proof.after)
    )
      throw new Error(`Compact negative restore ${proof.id} is not bound to its failed command.`);
    if (negativeCommandIndexes.has(proof.commandIndex))
      throw new Error('Compact negative restore proofs reuse one command outcome.');
    negativeCommandIndexes.add(proof.commandIndex);
  }
  const scannerCommandBindings = [
    ['classificationCommandIndex', 'malware-scanner-clean-and-eicar-classification'],
    ['maximumUploadCommandIndex', 'malware-scanner-maximum-upload-classification'],
    ['dependencyFailureCommandIndex', 'malware-scanner-dependency-fails-closed'],
    ['recoveryCommandIndex', 'malware-scanner-recovered-after-dependency-restart'],
  ];
  const scannerCommandIndexes = new Set();
  for (const [indexField, assertion] of scannerCommandBindings) {
    const commandIndex = value.malwareScannerProof[indexField];
    if (scannerCommandIndexes.has(commandIndex))
      throw new Error('Compact malware scanner proofs reuse one command outcome.');
    scannerCommandIndexes.add(commandIndex);
    const command = value.commands[commandIndex];
    if (
      !command ||
      command.expectedOutcome !== 'success' ||
      command.exitCode !== 0 ||
      command.signal !== null ||
      command.assertion !== assertion
    )
      throw new Error(`Compact malware scanner proof is not bound to ${assertion}.`);
  }
  if (
    value.backup.manifest.sourceCommit !== value.source.commit ||
    value.upgradeBackup.manifest.sourceCommit !== value.source.commit
  )
    throw new Error('Compact backup evidence differs from the proven source commit.');
  const expectedBackupFiles = [
    'minio.tar.gz',
    'postgres.sql',
    'temporal-visibility.sql',
    'temporal.sql',
  ];
  for (const backup of [value.backup, value.upgradeBackup]) {
    const names = backup.manifest.files.map((file) => file.name).sort();
    if (JSON.stringify(names) !== JSON.stringify(expectedBackupFiles))
      throw new Error('Compact backup evidence does not contain the exact artifact set.');
    const manifestBytes = `${JSON.stringify(backup.manifest, null, 2)}\n`;
    if (sha256(manifestBytes) !== backup.manifestSha256)
      throw new Error('Compact backup manifest digest does not match its evidence object.');
  }
  return value;
}

function updateBackupFile(manifestPath, fileName) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const file = manifest.files.find((candidate) => candidate.name === fileName);
  if (!file) throw new Error(`Backup manifest does not declare ${fileName}.`);
  const bytes = readFileSync(join(dirname(manifestPath), fileName));
  file.size = bytes.length;
  file.sha256 = sha256(bytes);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}

function assertTranscriptSafe(bytes, environment) {
  const transcript = bytes.toString('utf8');
  const sensitiveValues = Object.entries(environment)
    .filter(
      ([key, value]) =>
        /(?:PASSWORD|PRIVATE_KEY|SIGNING_KEY|SECRET|ROOT_USER|CURSOR_KEY)/u.test(key) && value,
    )
    .map(([, value]) => value);
  if (sensitiveValues.some((value) => transcript.includes(value)))
    throw new Error('Compact proof transcript contains a generated credential value.');
  if (/https?:\/\/[^/\s:@]+:[^/\s@]+@/u.test(transcript) || /PRIVATE KEY-----/u.test(transcript))
    throw new Error('Compact proof transcript contains credential-bearing output.');
}

export async function proveCompactProfile({
  outputPath,
  publicRef,
  apiPort = 4000,
  commandRunner,
} = {}) {
  if (!outputPath) throw new Error('Compact proof requires --out <directory>.');
  if (!/^refs\/(?:heads\/main|tags\/v[0-9][A-Za-z0-9._-]*)$/u.test(publicRef ?? ''))
    throw new Error('Compact proof requires --ref refs/heads/main or an explicit version tag.');
  if (!Number.isSafeInteger(apiPort) || apiPort < 1024 || apiPort > 65_535)
    throw new Error('Compact proof API port must be an integer from 1024 through 65535.');
  assertAuthoritativePublicRepository(root);
  if ((await git(['rev-parse', '--is-shallow-repository'])) !== 'false')
    throw new Error('Compact proof requires a complete, non-shallow public clone.');
  if (existsSync(join(root, 'infra/compact/.env')))
    throw new Error('Compact proof requires a fresh clone without an initialized environment.');

  const commit = await git(['rev-parse', 'HEAD']);
  const sourceTree = await git(['rev-parse', 'HEAD^{tree}']);
  const origin = await git(['remote', 'get-url', 'origin']);
  const advertised = await git([
    'ls-remote',
    '--exit-code',
    'origin',
    publicRef,
    `${publicRef}^{}`,
  ]);
  const advertisedRefs = new Map(
    advertised.split('\n').map((line) => {
      const fields = line.trim().split(/\s+/u);
      return [fields[1], fields[0]];
    }),
  );
  const refObject = advertisedRefs.get(publicRef);
  const object = advertisedRefs.get(`${publicRef}^{}`) ?? refObject;
  if (!refObject || advertisedRefs.size > 2)
    throw new Error(`Authoritative public ref ${publicRef} is ambiguous or missing.`);
  if (object !== commit)
    throw new Error(
      `HEAD is not the exact object advertised by authoritative public ref ${publicRef}.`,
    );
  const remote = { url: origin, ref: publicRef, refObject, object };

  const host = hostEnvelope();
  const output = secureOutputDirectory(outputPath);
  const transcriptPath = join(output, 'command-transcript.log');
  const transcriptDescriptor = openSync(
    transcriptPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  const commands = [];
  const run =
    commandRunner ??
    ((file, arguments_, options = {}) =>
      new Promise((resolvePromise, reject) => {
        const startedAt = new Date().toISOString();
        const startedMilliseconds = Date.now();
        const stdoutHash = createHash('sha256');
        const stderrHash = createHash('sha256');
        const capturedStdout = [];
        const capturedStderr = [];
        let capturedStdoutBytes = 0;
        let capturedStderrBytes = 0;
        let stdoutBytes = 0;
        let stderrBytes = 0;
        appendFileSync(transcriptDescriptor, `\n$ ${JSON.stringify([file, ...arguments_])}\n`);
        const child = spawn(file, arguments_, {
          cwd: root,
          env: { ...process.env, TZ: 'UTC' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const consume = (stream, digest, destination, countBytes, captureChunk) =>
          stream.on('data', (chunk) => {
            digest.update(chunk);
            countBytes(chunk.length);
            if (options.retainOutput === true) writeFileSync(transcriptDescriptor, chunk);
            if (options.display !== false) destination.write(chunk);
            if (options.capture) captureChunk(chunk);
          });
        consume(
          child.stdout,
          stdoutHash,
          process.stdout,
          (bytes) => {
            stdoutBytes += bytes;
          },
          (chunk) => {
            if (capturedStdoutBytes + chunk.length <= 4 * 1024 * 1024) {
              capturedStdout.push(chunk);
              capturedStdoutBytes += chunk.length;
            }
          },
        );
        consume(
          child.stderr,
          stderrHash,
          process.stderr,
          (bytes) => {
            stderrBytes += bytes;
          },
          (chunk) => {
            if (capturedStderrBytes + chunk.length <= 4 * 1024 * 1024) {
              capturedStderr.push(chunk);
              capturedStderrBytes += chunk.length;
            }
          },
        );
        child.on('error', reject);
        child.on('close', (code, signal) => {
          const record = {
            command: [file, ...arguments_],
            expectedOutcome: options.expectFailure ? 'failure' : 'success',
            assertion: options.assertion ?? 'command-completed-as-declared',
            startedAt,
            finishedAt: new Date().toISOString(),
            durationMs: Date.now() - startedMilliseconds,
            exitCode: code,
            signal,
            stdoutSha256: stdoutHash.digest('hex'),
            stdoutBytes,
            stderrSha256: stderrHash.digest('hex'),
            stderrBytes,
          };
          commands.push(record);
          if (options.retainOutput !== true) {
            writeFileSync(
              transcriptDescriptor,
              `[output omitted; stdout sha256=${record.stdoutSha256}; stderr sha256=${record.stderrSha256}]\n`,
            );
          }
          const text = Buffer.concat(capturedStdout).toString('utf8');
          const errorText = Buffer.concat(capturedStderr).toString('utf8');
          record.failurePattern = options.failurePattern?.source ?? null;
          record.failureMatched = options.failurePattern
            ? options.failurePattern.test(`${text}\n${errorText}`)
            : null;
          if (
            options.capture &&
            (stdoutBytes !== capturedStdoutBytes || stderrBytes !== capturedStderrBytes)
          ) {
            reject(new Error(`Captured command output exceeds the 4 MiB bound: ${file}.`));
          } else if (options.expectFailure ? code === 0 : code !== 0) {
            reject(
              new Error(
                options.expectFailure
                  ? `Expected command to fail: ${file} ${arguments_.join(' ')}`
                  : `Command failed: ${file} ${arguments_.join(' ')}`,
              ),
            );
          } else if (options.failurePattern && !record.failureMatched) {
            reject(new Error(`Command failed for an unexpected reason: ${file}.`));
          } else resolvePromise({ record, text, errorText });
        });
      }));

  const workspace = mkdtempSync(join(tmpdir(), 'tixkit-compact-proof-'));
  const backup = join(workspace, 'backup');
  const upgradeBackup = join(workspace, 'pre-upgrade');
  let phases;
  let scannerStopped = false;
  try {
    const preexistingContainers = await run(
      'docker',
      ['ps', '-aq', '--filter', 'label=com.docker.compose.project=tixkit-compact'],
      { capture: true },
    );
    if (preexistingContainers.text.trim())
      throw new Error('Compact proof requires no pre-existing tixkit-compact containers.');
    for (const resource of ['volume', 'network']) {
      const existing = await run(
        'docker',
        [resource, 'ls', '-q', '--filter', 'label=com.docker.compose.project=tixkit-compact'],
        { capture: true },
      );
      if (existing.text.trim())
        throw new Error(`Compact proof requires no pre-existing tixkit-compact ${resource}s.`);
    }
    const dockerContextName = (
      await run('docker', ['context', 'show'], {
        capture: true,
        retainOutput: false,
        assertion: 'active-docker-context-identity',
      })
    ).text.trim();
    const dockerContextResult = await run('docker', ['context', 'inspect', dockerContextName], {
      capture: true,
      display: false,
      retainOutput: false,
      assertion: 'local-docker-context-endpoint',
    });
    const dockerContext = JSON.parse(dockerContextResult.text);
    if (
      !Array.isArray(dockerContext) ||
      dockerContext.length !== 1 ||
      dockerContext[0]?.Name !== dockerContextName
    )
      throw new Error('Compact proof could not bind the active Docker context.');
    const dockerEndpoint = process.env.DOCKER_HOST ?? dockerContext[0]?.Endpoints?.docker?.Host;
    if (typeof dockerEndpoint !== 'string' || !dockerEndpoint.startsWith('unix://'))
      throw new Error('Compact single-host proof forbids a remote Docker endpoint.');
    const dockerSocket = realpathSync(dockerEndpoint.slice('unix://'.length));
    if (!statSync(dockerSocket).isSocket())
      throw new Error('Compact proof Docker endpoint is not a local Unix socket.');
    const dockerInfoResult = await run('docker', ['info', '--format', '{{json .}}'], {
      capture: true,
      display: false,
      retainOutput: false,
      assertion: 'docker-capacity-and-runtime-identity',
    });
    const dockerInfo = JSON.parse(dockerInfoResult.text);
    const dockerDiskResult = await run(
      'docker',
      ['run', '--rm', '--entrypoint', 'df', dockerDiskProbeImage, '-Pk', '/'],
      { capture: true, assertion: 'docker-writable-layer-minimum-capacity' },
    );
    dockerInfo.diskBytes = parseAvailableDiskBytes(dockerDiskResult.text);
    dockerInfo.contextName = dockerContextName;
    dockerInfo.endpointKind = 'local-unix';
    dockerInfo.endpointSha256 = sha256(dockerSocket);
    const docker = validateDockerEnvelope(dockerInfo);
    validateOperatingEnvironment(host, docker);

    await run('bun', ['run', 'compact:init']);
    if (apiPort !== 4000) {
      const environmentPath = join(root, 'infra/compact/.env');
      const environmentBytes = readFileSync(environmentPath, 'utf8');
      const configured = environmentBytes.replace(/^API_PORT=4000$/mu, `API_PORT=${apiPort}`);
      if (configured === environmentBytes)
        throw new Error('Compact proof could not configure the requested API port.');
      writeFileSync(environmentPath, configured, { mode: 0o600 });
    }
    await run('bun', ['run', 'compact:up']);
    const inspectState = async () => {
      const result = await run('docker', composeArguments('ps', '--all', '--format', 'json'), {
        capture: true,
      });
      return validateCompleteServiceState(parseComposeServices(result.text));
    };
    const assertSeed = async () => {
      const result = await run(
        'docker',
        composeArguments(
          'exec',
          '-T',
          'postgres',
          'psql',
          '-At',
          '-U',
          'tixkit',
          '-d',
          'tixkit',
          '-c',
          "SELECT count(*) FROM events WHERE id='evt_sample_data' AND slug='sample-summer-showcase';",
        ),
        { capture: true },
      );
      if (result.text.trim() !== '1')
        throw new Error('Compact seeded event is missing or duplicated.');
    };
    const initial = await inspectState();
    await assertSeed();
    await run('curl', ['-fsS', `http://127.0.0.1:${apiPort}/ready`]);
    const scannerClassification = await run(
      'docker',
      composeArguments(
        'exec',
        '-T',
        'api',
        'node',
        '--input-type=module',
        '-e',
        scannerHealthyProbe,
      ),
      {
        display: false,
        retainOutput: false,
        assertion: 'malware-scanner-clean-and-eicar-classification',
      },
    );
    const scannerMaximumUpload = await run(
      'docker',
      composeArguments(
        'exec',
        '-T',
        'api',
        'node',
        '--input-type=module',
        '-e',
        scannerMaximumUploadProbe,
      ),
      {
        display: false,
        retainOutput: false,
        assertion: 'malware-scanner-maximum-upload-classification',
      },
    );

    await run('bun', ['run', 'compact:restart']);
    const restarted = await inspectState();
    await assertSeed();

    await run('bun', ['run', 'compact:backup', '--', backup]);
    const backupManifest = JSON.parse(readFileSync(join(backup, 'manifest.json'), 'utf8'));
    const backupManifestSha256 = sha256(readFileSync(join(backup, 'manifest.json')));

    const sentinel = randomUUID();
    await run(
      'docker',
      composeArguments(
        'exec',
        '-T',
        'postgres',
        'psql',
        '-v',
        'ON_ERROR_STOP=1',
        '-U',
        'tixkit',
        '-d',
        'tixkit',
        '-c',
        `CREATE TABLE compact_proof_sentinel (marker text PRIMARY KEY); INSERT INTO compact_proof_sentinel(marker) VALUES ('${sentinel}');`,
      ),
      { assertion: 'post-backup-live-database-sentinel-created' },
    );
    const compactEnvironment = Object.fromEntries(
      readFileSync(join(root, 'infra/compact/.env'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const separator = line.indexOf('=');
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );
    const minioEnvironmentPath = join(workspace, 'mc.env');
    writeFileSync(
      minioEnvironmentPath,
      `MC_HOST_tixkit=http://${encodeURIComponent(compactEnvironment.MINIO_ROOT_USER)}:${encodeURIComponent(compactEnvironment.MINIO_ROOT_PASSWORD)}@minio:9000\n`,
      { mode: 0o600 },
    );
    chmodSync(minioEnvironmentPath, 0o600);
    const sentinelDirectory = join(workspace, 'sentinel-object');
    mkdirSync(sentinelDirectory, { mode: 0o700 });
    writeFileSync(join(sentinelDirectory, 'sentinel'), sentinel, { mode: 0o600 });
    await run(
      'docker',
      [
        'run',
        '--rm',
        '--network',
        'tixkit-compact_default',
        '--env-file',
        minioEnvironmentPath,
        '--volume',
        `${sentinelDirectory}:/proof:ro`,
        minioClientImage,
        'cp',
        '/proof/sentinel',
        `tixkit/tixkit/.compact-proof/${sentinel}`,
      ],
      { assertion: 'post-backup-live-object-sentinel-created' },
    );
    const liveFingerprint = async () => {
      const database = await run(
        'docker',
        composeArguments(
          'exec',
          '-T',
          'postgres',
          'psql',
          '-At',
          '-U',
          'tixkit',
          '-d',
          'tixkit',
          '-c',
          "SELECT current_database() || '|' || (SELECT oid::text FROM pg_database WHERE datname=current_database()) || '|' || (SELECT marker FROM compact_proof_sentinel LIMIT 1) || '|' || (SELECT id || ':' || slug FROM events WHERE id='evt_sample_data');",
        ),
        { capture: true, retainOutput: false, assertion: 'live-database-fingerprint' },
      );
      const objects = await run(
        'docker',
        [
          'run',
          '--rm',
          '--network',
          'tixkit-compact_default',
          '--env-file',
          minioEnvironmentPath,
          minioClientImage,
          'find',
          'tixkit/tixkit',
          '--json',
        ],
        {
          capture: true,
          display: false,
          retainOutput: false,
          assertion: 'live-object-inventory-fingerprint',
        },
      );
      const objectInventory = objects.text.trim().split('\n').filter(Boolean).sort();
      return {
        databaseSha256: sha256(database.text.trim()),
        objectInventorySha256: sha256(objectInventory.join('\n')),
        objectInventoryCount: objectInventory.length,
        objectInventoryBytes: Buffer.byteLength(objects.text),
      };
    };
    const negativeRestoreProof = [];
    const runNegativeRestore = async (id, directory, failurePattern) => {
      const before = await liveFingerprint();
      const result = await run('bun', ['run', 'compact:restore', '--', directory], {
        capture: true,
        expectFailure: true,
        failurePattern,
        assertion: `negative-restore-${id}`,
      });
      const after = await liveFingerprint();
      if (
        before.databaseSha256 !== after.databaseSha256 ||
        before.objectInventorySha256 !== after.objectInventorySha256
      )
        throw new Error(`Negative restore ${id} mutated live database or object state.`);
      negativeRestoreProof.push({
        id,
        commandIndex: commands.indexOf(result.record),
        expectedExitCode: result.record.exitCode,
        before,
        after,
        liveStatePreserved: true,
      });
    };

    const incompatible = join(workspace, 'incompatible');
    cpSync(backup, incompatible, { recursive: true });
    const incompatibleManifestPath = join(incompatible, 'manifest.json');
    const incompatibleManifest = JSON.parse(readFileSync(incompatibleManifestPath, 'utf8'));
    incompatibleManifest.sourceCommit = '0'.repeat(40);
    writeFileSync(incompatibleManifestPath, `${JSON.stringify(incompatibleManifest, null, 2)}\n`);
    await runNegativeRestore('incompatible-source-commit', incompatible, /commit is incompatible/u);

    const corrupt = join(workspace, 'corrupt');
    cpSync(backup, corrupt, { recursive: true });
    appendFileSync(join(corrupt, 'postgres.sql'), '\ncorrupt\n');
    await runNegativeRestore('checksum-mismatch', corrupt, /checksum mismatch/u);

    const incomplete = join(workspace, 'incomplete');
    cpSync(backup, incomplete, { recursive: true });
    rmSync(join(incomplete, 'temporal-visibility.sql'));
    const incompleteManifestPath = join(incomplete, 'manifest.json');
    const incompleteManifest = JSON.parse(readFileSync(incompleteManifestPath, 'utf8'));
    incompleteManifest.files = incompleteManifest.files.filter(
      (file) => file.name !== 'temporal-visibility.sql',
    );
    writeFileSync(incompleteManifestPath, `${JSON.stringify(incompleteManifest, null, 2)}\n`);
    await runNegativeRestore('incomplete-artifact-set', incomplete, /invalid artifact set/u);

    const incompatibleVersion = join(workspace, 'incompatible-version');
    cpSync(backup, incompatibleVersion, { recursive: true });
    const incompatibleVersionManifestPath = join(incompatibleVersion, 'manifest.json');
    const incompatibleVersionManifest = JSON.parse(
      readFileSync(incompatibleVersionManifestPath, 'utf8'),
    );
    incompatibleVersionManifest.tixkitVersion = 'incompatible-version';
    writeFileSync(
      incompatibleVersionManifestPath,
      `${JSON.stringify(incompatibleVersionManifest, null, 2)}\n`,
    );
    await runNegativeRestore(
      'incompatible-version',
      incompatibleVersion,
      /version is incompatible/u,
    );

    const invalidSql = join(workspace, 'invalid-sql');
    cpSync(backup, invalidSql, { recursive: true });
    writeFileSync(join(invalidSql, 'postgres.sql'), 'THIS IS NOT VALID SQL;\n');
    updateBackupFile(join(invalidSql, 'manifest.json'), 'postgres.sql');
    await runNegativeRestore('checksummed-invalid-sql', invalidSql, /Restore staging failed/u);

    const unsafeArchive = join(workspace, 'unsafe-archive');
    cpSync(backup, unsafeArchive, { recursive: true });
    const unsafeTree = join(workspace, 'unsafe-tree');
    mkdirSync(join(unsafeTree, 'tixkit'), { recursive: true });
    symlinkSync('../escape', join(unsafeTree, 'tixkit', 'escape'));
    await run('tar', ['-C', unsafeTree, '-czf', join(unsafeArchive, 'minio.tar.gz'), 'tixkit']);
    updateBackupFile(join(unsafeArchive, 'manifest.json'), 'minio.tar.gz');
    await runNegativeRestore('checksummed-unsafe-archive', unsafeArchive, /unsafe entry/u);
    await assertSeed();

    await run('bun', ['run', 'compact:restore', '--', backup]);
    const restored = await inspectState();
    await assertSeed();

    await run('docker', composeArguments('stop', 'clamav'));
    scannerStopped = true;
    const scannerDependencyFailure = await run(
      'docker',
      composeArguments(
        'exec',
        '-T',
        'api',
        'node',
        '--input-type=module',
        '-e',
        scannerUnavailableProbe,
      ),
      {
        display: false,
        retainOutput: false,
        assertion: 'malware-scanner-dependency-fails-closed',
      },
    );
    await run('docker', composeArguments('start', 'clamav'));
    await run('docker', composeArguments('up', '-d', '--no-build', '--wait'));
    scannerStopped = false;
    const scannerRecovery = await run(
      'docker',
      composeArguments(
        'exec',
        '-T',
        'api',
        'node',
        '--input-type=module',
        '-e',
        scannerHealthyProbe,
      ),
      {
        display: false,
        retainOutput: false,
        assertion: 'malware-scanner-recovered-after-dependency-restart',
      },
    );

    await run('docker', composeArguments('stop', 'temporal'));
    const workerId = (
      await run('docker', composeArguments('ps', '-q', 'worker'), { capture: true })
    ).text.trim();
    if (!workerId) throw new Error('Compact worker container is missing.');
    const failureDeadline = Date.now() + 90_000;
    let workerFailureObserved = false;
    while (Date.now() < failureDeadline) {
      const health = await run(
        'docker',
        ['inspect', '--format', '{{.State.Health.Status}}', workerId],
        { capture: true },
      );
      if (health.text.trim() === 'unhealthy') {
        workerFailureObserved = true;
        break;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000));
    }
    if (!workerFailureObserved)
      throw new Error('Compact worker did not become unhealthy after Temporal stopped.');
    await run('docker', composeArguments('start', 'temporal'));
    await run('docker', composeArguments('up', '-d', '--no-build', '--wait'));
    const recovered = await inspectState();

    await run('bun', ['run', 'compact:upgrade', '--', upgradeBackup]);
    const upgraded = await inspectState();
    await assertSeed();
    const upgradeManifest = JSON.parse(readFileSync(join(upgradeBackup, 'manifest.json'), 'utf8'));
    const upgradeManifestSha256 = sha256(readFileSync(join(upgradeBackup, 'manifest.json')));

    await run('node', ['--test', 'scripts/__tests__/compact-profile.test.mjs']);
    await run('bun', ['run', 'docs:check']);
    await run('bun', ['run', 'validate:public-distribution']);
    phases = { initial, restarted, restored, recovered, upgraded };
    const negativeOrder = [
      'incompatible-source-commit',
      'incompatible-version',
      'incomplete-artifact-set',
      'checksum-mismatch',
      'checksummed-invalid-sql',
      'checksummed-unsafe-archive',
    ];
    negativeRestoreProof.sort(
      (left, right) => negativeOrder.indexOf(left.id) - negativeOrder.indexOf(right.id),
    );

    const finishedAt = new Date().toISOString();
    fchmodSync(transcriptDescriptor, 0o600);
    fsyncSync(transcriptDescriptor);
    assertTranscriptSafe(readFileSync(transcriptPath), compactEnvironment);
    closeSync(transcriptDescriptor);
    const evidence = {
      schemaVersion: 2,
      schema: 'https://tixkit.com/schemas/compact-clean-host-proof-v2.json',
      kind: 'tixkit-compact-clean-host-proof',
      result: 'passed',
      startedFromFreshEnvironment: true,
      authoritativePublicRepository: 'github.com/tixkithq/tixkit',
      apiPort,
      source: { commit, tree: sourceTree },
      remote,
      host,
      docker,
      minimum,
      phases,
      negativeRestoreProof,
      backup: { manifest: backupManifest, manifestSha256: backupManifestSha256 },
      upgradeBackup: { manifest: upgradeManifest, manifestSha256: upgradeManifestSha256 },
      malwareScannerProof: {
        cleanAccepted: true,
        eicarRejected: true,
        maximumUploadAccepted: true,
        dependencyFailureObserved: true,
        recovered: true,
        classificationCommandIndex: commands.indexOf(scannerClassification.record),
        maximumUploadCommandIndex: commands.indexOf(scannerMaximumUpload.record),
        dependencyFailureCommandIndex: commands.indexOf(scannerDependencyFailure.record),
        recoveryCommandIndex: commands.indexOf(scannerRecovery.record),
      },
      workerDependencyFailureObserved: true,
      seedPersistenceChecks: 5,
      commands,
      transcript: {
        path: 'command-transcript.log',
        bytes: statSync(transcriptPath).size,
        sha256: sha256(readFileSync(transcriptPath)),
      },
      finishedAt,
      limitations: [
        'This proof covers one Compact host and does not establish high availability.',
        'This proof does not establish legal approval, hosted publication, or production DR.',
      ],
    };
    assertCompactProofSchema(evidence);
    const evidencePath = join(output, 'compact-proof.json');
    writeCompactProofArtifact(evidencePath, evidence);
    writeBytesExclusive(
      join(output, 'checksums.txt'),
      `${sha256(readFileSync(evidencePath))}  compact-proof.json\n${sha256(readFileSync(transcriptPath))}  command-transcript.log\n`,
    );
    return evidence;
  } catch (error) {
    if (scannerStopped) {
      try {
        await run('docker', composeArguments('start', 'clamav'), {
          display: false,
          retainOutput: false,
          assertion: 'malware-scanner-best-effort-failure-recovery',
        });
        await run('docker', composeArguments('up', '-d', '--no-build', '--wait'), {
          display: false,
          retainOutput: false,
          assertion: 'malware-scanner-best-effort-profile-recovery',
        });
        scannerStopped = false;
      } catch {}
    }
    try {
      fchmodSync(transcriptDescriptor, 0o600);
      fsyncSync(transcriptDescriptor);
      closeSync(transcriptDescriptor);
    } catch {}
    writeCompactProofArtifact(join(output, 'compact-proof-failure.json'), {
      schemaVersion: 2,
      kind: 'tixkit-compact-clean-host-proof',
      result: 'failed',
      source: { commit, tree: sourceTree },
      host,
      error: error instanceof Error ? error.message : String(error),
      commands,
      transcript: {
        path: 'command-transcript.log',
        bytes: statSync(transcriptPath).size,
        sha256: sha256(readFileSync(transcriptPath)),
      },
    });
    throw error;
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function parseArguments(arguments_) {
  const values = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (!['--out', '--ref', '--api-port'].includes(name) || !value || values.has(name))
      throw new Error(
        'Usage: bun run compact:prove -- --ref <public-ref> --out <new-absolute-directory> [--api-port <port>]',
      );
    values.set(name, value);
  }
  if (
    !values.has('--out') ||
    !values.has('--ref') ||
    !isAbsolute(values.get('--out')) ||
    (values.has('--api-port') &&
      (!/^[0-9]+$/u.test(values.get('--api-port')) ||
        Number(values.get('--api-port')) < 1024 ||
        Number(values.get('--api-port')) > 65_535))
  )
    throw new Error(
      'Usage: bun run compact:prove -- --ref <public-ref> --out <new-absolute-directory> [--api-port <port>]',
    );
  return {
    outputPath: resolve(values.get('--out')),
    publicRef: values.get('--ref'),
    apiPort: Number(values.get('--api-port') ?? 4000),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const arguments_ = parseArguments(process.argv.slice(2));
    const evidence = await proveCompactProfile(arguments_);
    process.stdout.write(
      `Compact clean-host proof passed for ${evidence.source.commit}; evidence written to ${arguments_.outputPath}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
