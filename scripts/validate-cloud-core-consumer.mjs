#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  jsonSchemaViolations,
  loadPublicDistribution,
  validatePublicDistribution,
} from './lib/public-distribution.mjs';

const publicRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const sourceExtension =
  /\.(?:c|cc|cpp|cs|dart|go|java|js|jsx|kt|kts|mjs|mts|py|rb|rs|svelte|swift|ts|tsx|vue)$/u;
let cachedSourceFingerprints;
let cachedSourceSimilarityIndex;
let cachedTrackedPublicSources;

function argument(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1 || !argv[index + 1]) throw new Error(`${name} is required`);
  return resolve(argv[index + 1]);
}

function walk(directory) {
  const output = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (['.git', 'node_modules', 'dist', 'build', 'coverage'].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      output.push(path);
    } else if (entry.isDirectory()) {
      output.push(...walk(path));
    } else if (entry.isFile()) {
      output.push(path);
    }
  }
  return output;
}

function duplicateValues(values) {
  const seen = new Set();
  return values.filter((value) => {
    if (seen.has(value)) return true;
    seen.add(value);
    return false;
  });
}

function canonical(value) {
  if (Array.isArray(value)) {
    const values = value.map(canonical);
    return values.every((entry) => entry && typeof entry === 'object' && 'name' in entry)
      ? values.sort((left, right) => left.name.localeCompare(right.name))
      : values;
  }
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  return value;
}

export function parseBunLock(content) {
  let withoutComments = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    const next = content[index + 1];
    if (inString) {
      withoutComments += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      withoutComments += character;
      continue;
    }
    if (character === '/' && next === '/') {
      while (index < content.length && content[index] !== '\n') index += 1;
      withoutComments += '\n';
      continue;
    }
    if (character === '/' && next === '*') {
      index += 2;
      while (index < content.length && !(content[index] === '*' && content[index + 1] === '/'))
        index += 1;
      index += 1;
      continue;
    }
    withoutComments += character;
  }

  let strictJson = '';
  inString = false;
  escaped = false;
  for (let index = 0; index < withoutComments.length; index += 1) {
    const character = withoutComments[index];
    if (inString) {
      strictJson += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      strictJson += character;
      continue;
    }
    if (character === ',') {
      let lookahead = index + 1;
      while (/\s/u.test(withoutComments[lookahead] ?? '')) lookahead += 1;
      if (withoutComments[lookahead] === '}' || withoutComments[lookahead] === ']') continue;
    }
    strictJson += character;
  }
  return JSON.parse(strictJson);
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function normalizedSource(content) {
  return content
    .toString('utf8')
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/(^|[^:])\/\/.*$/gmu, '$1')
    .replace(/\s+/gu, '');
}

function publicTrackedSourceFiles(paths) {
  if (cachedTrackedPublicSources) return cachedTrackedPublicSources;
  const prefixes = [...paths].map((path) => `${path}/`);
  cachedTrackedPublicSources = execFileSync('git', ['ls-files', '-z'], {
    cwd: publicRoot,
    encoding: 'buffer',
    maxBuffer: 32 * 1024 * 1024,
  })
    .toString('utf8')
    .split('\u0000')
    .filter(
      (path) => sourceExtension.test(path) && prefixes.some((prefix) => path.startsWith(prefix)),
    )
    .map((path) => resolve(publicRoot, path));
  return cachedTrackedPublicSources;
}

function sourceShingles(content) {
  const tokens = content
    .toString('utf8')
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/(^|[^:])\/\/.*$/gmu, '$1')
    .match(/[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|===|!==|=>|&&|\|\||[^\s]/gu);
  const shingles = new Set();
  for (let index = 0; index <= (tokens?.length ?? 0) - 5; index += 1)
    shingles.add(tokens.slice(index, index + 5).join('\u0000'));
  return shingles;
}

function shingleSignature(shingles) {
  return [...shingles]
    .map((shingle) => {
      let hash = 2166136261;
      for (let index = 0; index < shingle.length; index += 1) {
        hash ^= shingle.charCodeAt(index);
        hash = Math.imul(hash, 16777619) >>> 0;
      }
      return [hash, shingle];
    })
    .sort(([left], [right]) => left - right)
    .slice(0, 24)
    .map(([, shingle]) => shingle);
}

function publicSourceSimilarityIndex(paths) {
  if (cachedSourceSimilarityIndex) return cachedSourceSimilarityIndex;
  const bySignature = new Map();
  const shinglesByPath = new Map();
  for (const file of publicTrackedSourceFiles(paths)) {
    const publicPath = relative(publicRoot, file).split(sep).join('/');
    const shingles = sourceShingles(readFileSync(file));
    shinglesByPath.set(publicPath, shingles);
    for (const shingle of shingleSignature(shingles)) {
      const pathsForShingle = bySignature.get(shingle) ?? [];
      pathsForShingle.push(publicPath);
      bySignature.set(shingle, pathsForShingle);
    }
  }
  cachedSourceSimilarityIndex = { bySignature, shinglesByPath };
  return cachedSourceSimilarityIndex;
}

function publicSourceFingerprints(paths) {
  if (cachedSourceFingerprints) return cachedSourceFingerprints;
  const fingerprints = new Map();
  for (const file of publicTrackedSourceFiles(paths)) {
    const content = normalizedSource(readFileSync(file));
    if (content.length < 20) continue;
    const digest = sha256(content);
    const matches = fingerprints.get(digest) ?? [];
    matches.push(relative(publicRoot, file).split(sep).join('/'));
    fingerprints.set(digest, matches);
  }
  cachedSourceFingerprints = fingerprints;
  return cachedSourceFingerprints;
}

function checksumFor(contractDirectory, fileName) {
  const primary = resolve(contractDirectory, 'CHECKSUMS.sha256');
  const docsMirror = resolve(
    publicRoot,
    'apps/docs/public/contracts',
    basename(contractDirectory),
    'CHECKSUMS.sha256',
  );
  const checksums = readFileSync(
    statSync(primary, { throwIfNoEntry: false }) ? primary : docsMirror,
    'utf8',
  );
  const line = checksums.split('\n').find((candidate) => candidate.endsWith(`  ${fileName}`));
  return line?.split(/\s+/u)[0];
}

function currentMigrationRange() {
  const ids = readdirSync(resolve(publicRoot, 'packages/db/src/migrations'))
    .map((name) => name.match(/^(\d{4}(?:_\d+)?)/u)?.[1])
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right, 'en', { numeric: true }));
  return { minimum: ids[0], maximum: ids.at(-1) };
}

export function validateCloudCoreConsumer(compatibility, publicRelease, cloudRoot) {
  const violations = [];
  const distribution = validatePublicDistribution(loadPublicDistribution(publicRoot), publicRoot);
  const schema = JSON.parse(
    readFileSync(resolve(publicRoot, 'distribution/cloud-core-compatibility.schema.json'), 'utf8'),
  );
  violations.push(...jsonSchemaViolations(compatibility, schema));
  const releaseSchema = JSON.parse(
    readFileSync(resolve(publicRoot, 'distribution/public-release-manifest.schema.json'), 'utf8'),
  );
  const releaseEnvelopeSchema = structuredClone(releaseSchema);
  releaseEnvelopeSchema.properties.core = { type: 'object' };
  violations.push(
    ...jsonSchemaViolations(publicRelease, releaseEnvelopeSchema).map(
      (violation) => `public release manifest: ${violation}`,
    ),
  );
  violations.push(
    ...jsonSchemaViolations(publicRelease?.core, schema.$defs.core).map(
      (violation) => `public release manifest core: ${violation}`,
    ),
  );
  if (violations.length > 0) return violations;
  if (
    JSON.stringify(canonical(compatibility.core)) !== JSON.stringify(canonical(publicRelease.core))
  )
    violations.push('core pins must exactly match the verified public release manifest');

  const activeApiContract = distribution.release.contracts.find((path) =>
    path.startsWith('artifacts/api/'),
  );
  if (!activeApiContract) {
    violations.push('public distribution does not declare an active API contract');
    return violations;
  }
  const activeApiVersion = basename(activeApiContract);
  if (compatibility.core.apiVersion !== activeApiVersion)
    violations.push(`core.apiVersion must equal ${activeApiVersion}`);
  const contractPins = new Map(
    compatibility.core.contracts.map((entry) => [`${entry.name}@${entry.version}`, entry.sha256]),
  );
  for (const duplicate of duplicateValues(
    compatibility.core.contracts.map(({ name, version }) => `${name}@${version}`),
  ))
    violations.push(`duplicate core contract pin: ${duplicate}`);
  const expectedOpenApiChecksum = checksumFor(
    resolve(publicRoot, activeApiContract),
    'openapi.json',
  );
  const openApiPin = contractPins.get(`openapi@${activeApiVersion}`);
  if (!openApiPin) violations.push(`missing openapi@${activeApiVersion} contract pin`);
  else if (openApiPin !== expectedOpenApiChecksum)
    violations.push(`openapi@${activeApiVersion} checksum does not match the public contract`);

  const expectedMigrationRange = currentMigrationRange();
  if (compatibility.core.migrationRange.minimum !== expectedMigrationRange.minimum)
    violations.push(`migration minimum must equal ${expectedMigrationRange.minimum}`);
  if (compatibility.core.migrationRange.maximum !== expectedMigrationRange.maximum)
    violations.push(`migration maximum must equal ${expectedMigrationRange.maximum}`);

  const agentContracts = distribution.release.contracts.filter((path) =>
    path.includes('agent-protocol'),
  );
  if (agentContracts.length === 0) {
    if (
      compatibility.core.agentProtocol.status !== 'unavailable' ||
      compatibility.core.agentProtocol.version !== ''
    )
      violations.push('agent protocol must remain unavailable until a public contract is released');
  } else if (
    compatibility.core.agentProtocol.status !== 'supported' ||
    compatibility.core.agentProtocol.version === ''
  ) {
    violations.push('released agent protocol requires a supported pinned version');
  }

  const publicPackages = new Map(
    distribution.release.packages
      .filter(({ ecosystem }) => ecosystem === 'npm' || ecosystem === 'npm-and-cdn')
      .map((entry) => {
        const manifest = JSON.parse(
          readFileSync(resolve(publicRoot, entry.path, 'package.json'), 'utf8'),
        );
        return [manifest.name, manifest.version];
      }),
  );
  const packagePins = new Map(
    compatibility.core.packages.map((entry) => [entry.name, entry.version]),
  );
  for (const duplicate of duplicateValues(compatibility.core.packages.map(({ name }) => name)))
    violations.push(`duplicate core package pin: ${duplicate}`);
  for (const [name, version] of packagePins) {
    if (!publicPackages.has(name)) violations.push(`unknown public package pin: ${name}`);
    else if (publicPackages.get(name) !== version)
      violations.push(`${name} must pin public version ${publicPackages.get(name)}`);
  }
  for (const name of publicPackages.keys())
    if (!packagePins.has(name)) violations.push(`missing core package pin: ${name}`);

  const expectedImages = new Set(distribution.release.images.map(({ name }) => name));
  const actualImages = compatibility.core.images.map(({ name }) => name);
  for (const duplicate of duplicateValues(actualImages))
    violations.push(`duplicate core image pin: ${duplicate}`);
  for (const name of expectedImages)
    if (!actualImages.includes(name)) violations.push(`missing core image pin: ${name}`);
  for (const image of compatibility.core.images) {
    if (!expectedImages.has(image.name)) violations.push(`unknown core image pin: ${image.name}`);
    if (!image.reference.endsWith(`@${image.digest}`))
      violations.push(`${image.name} reference and digest disagree`);
  }

  const publicSourcePaths = new Set([
    ...distribution.source.applications,
    ...distribution.source.packages,
  ]);
  const sourceFingerprints = publicSourceFingerprints(publicSourcePaths);
  const sourceSimilarityIndex = publicSourceSimilarityIndex(publicSourcePaths);
  const publicPackageNames = new Set(publicPackages.keys());
  const lockPath = resolve(cloudRoot, 'bun.lock');
  const lock = statSync(lockPath, { throwIfNoEntry: false })
    ? parseBunLock(readFileSync(lockPath, 'utf8'))
    : undefined;
  if (!lock) violations.push('private Cloud tree must include a frozen bun.lock');
  for (const pin of compatibility.core.packages) {
    const resolution = Object.values(lock?.packages ?? {}).find(
      (entry) => Array.isArray(entry) && entry[0] === `${pin.name}@${pin.version}`,
    );
    if (!resolution)
      violations.push(`bun.lock does not resolve claimed pin ${pin.name}@${pin.version}`);
    else if (resolution[3] !== pin.integrity)
      violations.push(
        `bun.lock integrity for claimed pin ${pin.name} does not match the public release`,
      );
  }
  for (const path of publicSourcePaths) {
    if (statSync(resolve(cloudRoot, path), { throwIfNoEntry: false }))
      violations.push(`private Cloud tree copies public source path: ${path}`);
  }

  for (const file of walk(cloudRoot)) {
    const relativePath = relative(cloudRoot, file).split(sep).join('/');
    const metadata = lstatSync(file, { throwIfNoEntry: false });
    if (!metadata?.isFile()) {
      violations.push(`private Cloud tree contains a symbolic or invalid path: ${relativePath}`);
      continue;
    }
    if (file.endsWith('package.json')) {
      const manifest = JSON.parse(readFileSync(file, 'utf8'));
      const importerPath = dirname(relativePath) === '.' ? '' : dirname(relativePath);
      const importer = lock?.workspaces?.[importerPath];
      if (!importer)
        violations.push(`${relativePath}: bun.lock has no matching workspace importer`);
      for (const field of [
        'dependencies',
        'devDependencies',
        'optionalDependencies',
        'peerDependencies',
      ]) {
        for (const [name, version] of Object.entries(manifest[field] ?? {})) {
          const alias =
            typeof version === 'string'
              ? version.match(/^npm:(@?[^@]+(?:\/[^@]+)?)@/u)?.[1]
              : undefined;
          const publicName = publicPackageNames.has(name)
            ? name
            : alias && publicPackageNames.has(alias)
              ? alias
              : undefined;
          if (!publicName) continue;
          if (importer?.[field]?.[name] !== version)
            violations.push(
              `${relativePath}: bun.lock importer does not bind ${name} to ${version}`,
            );
          if (alias)
            violations.push(
              `${relativePath}: aliases of public package ${publicName} are forbidden`,
            );
          if (!packagePins.has(publicName))
            violations.push(
              `${relativePath}: ${publicName} is not pinned in compatibility manifest`,
            );
          else if (name !== publicName || version !== packagePins.get(publicName))
            violations.push(`${relativePath}: ${publicName} must use exact compatibility version`);
          const pin = compatibility.core.packages.find((entry) => entry.name === publicName);
          const resolution = Object.values(lock?.packages ?? {}).find(
            (entry) => Array.isArray(entry) && entry[0] === `${publicName}@${pin?.version}`,
          );
          if (!resolution)
            violations.push(
              `${relativePath}: bun.lock does not resolve ${publicName}@${pin?.version}`,
            );
          else if (resolution[3] !== pin?.integrity)
            violations.push(
              `${relativePath}: bun.lock integrity for ${publicName} does not match the public release`,
            );
        }
      }
      for (const field of ['overrides', 'resolutions', 'patchedDependencies']) {
        const serialized = JSON.stringify(manifest[field] ?? {});
        for (const name of publicPackageNames)
          if (serialized.includes(name))
            violations.push(`${relativePath}: private patching of ${name} is forbidden`);
      }
      for (const [name, command] of Object.entries(manifest.scripts ?? {})) {
        if (/^(?:preinstall|install|postinstall|prepare|prepack|postpack)$/u.test(name))
          violations.push(`${relativePath}: package lifecycle hook ${name} is forbidden in Cloud`);
        if (
          /^(?:prebuild|build|postbuild)$/u.test(name) &&
          typeof command === 'string' &&
          /(?:^|&&|\|\|)\s*(?:bash|bun|node|sh)\s+(?:\.\/)?(?:scripts|tools)\//u.test(command)
        )
          violations.push(`${relativePath}: build script ${name} invokes a mutable local helper`);
        if (
          typeof command === 'string' &&
          [...publicPackageNames].some((packageName) => command.includes(packageName)) &&
          /(?:\b(?:awk|cp|install|mv|patch|perl|python|replace|rewrite|sed)\b|\bnode\b|(?:^|[^>])>{1,2}[^>])/mu.test(
            command,
          )
        )
          violations.push(`${relativePath}: script ${name} modifies public Tixkit artifacts`);
      }
      continue;
    }
    if (/\.(?:diff|patch)$/u.test(file)) {
      const content = readFileSync(file, 'utf8');
      if (/@tixkit\/|packages\/(?:api|db|domain|shared|workflows)/u.test(content))
        violations.push(`${relativePath}: patch targets public Tixkit source`);
    }
    if (/(?:^|\/)(?:Dockerfile[^/]*|[^/]+\.(?:bash|js|mjs|sh|ts|ya?ml))$/u.test(relativePath)) {
      const content = readFileSync(file, 'utf8');
      if (
        /node_modules\/(?:@tixkit\/|tixkit(?:\/|\b))/u.test(content) &&
        /(?:\b(?:awk|cp|install|mv|patch|perl|python|sed)\b|\bnode\b|(?:^|[^>])>{1,2}[^>])/mu.test(
          content,
        )
      )
        violations.push(`${relativePath}: executable rewrites installed public Tixkit artifacts`);
    }
    if (sourceExtension.test(file)) {
      const bytes = readFileSync(file);
      const content = normalizedSource(bytes);
      if (content.length >= 20) {
        const matches = sourceFingerprints.get(sha256(content));
        if (matches)
          violations.push(
            `${relativePath}: copies public source content from ${matches.join(', ')}`,
          );
      }
      const shingles = sourceShingles(bytes);
      if (shingles.size >= 15) {
        const candidates = new Set();
        for (const shingle of shingleSignature(shingles))
          for (const publicPath of sourceSimilarityIndex.bySignature.get(shingle) ?? [])
            candidates.add(publicPath);
        const similar = [...candidates]
          .map((publicPath) => {
            const publicShingles = sourceSimilarityIndex.shinglesByPath.get(publicPath);
            const overlap = [...shingles].filter((shingle) => publicShingles.has(shingle)).length;
            return [publicPath, overlap];
          })
          .find(([, overlap]) => overlap / shingles.size >= 0.8);
        if (similar)
          violations.push(
            `${relativePath}: structurally copies public source content from ${similar[0]} (${similar[1]}/${shingles.size} shingles)`,
          );
      }
    }
  }
  return violations;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const manifestPath = argument(process.argv.slice(2), '--manifest');
  const publicReleasePath = argument(process.argv.slice(2), '--public-release-manifest');
  const cloudRoot = argument(process.argv.slice(2), '--cloud-root');
  const publicRelease = JSON.parse(readFileSync(publicReleasePath, 'utf8'));
  const authority = loadPublicDistribution(publicRoot).authority.publicRepository;
  const releaseTag = publicRelease.releaseVersion?.startsWith('v')
    ? publicRelease.releaseVersion
    : `v${publicRelease.releaseVersion}`;
  execFileSync(
    'gh',
    [
      'attestation',
      'verify',
      publicReleasePath,
      '--repo',
      authority,
      '--signer-workflow',
      `${authority}/.github/workflows/public-artifact-release.yml`,
      '--source-ref',
      `refs/tags/${releaseTag}`,
      '--source-digest',
      publicRelease.core?.sourceCommit,
      '--deny-self-hosted-runners',
    ],
    { stdio: 'inherit' },
  );
  const compatibility = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const violations = validateCloudCoreConsumer(compatibility, publicRelease, cloudRoot);
  if (violations.length > 0) {
    throw new Error(`Cloud/core compatibility validation failed:\n${violations.join('\n')}`);
  }
  process.stdout.write(`Validated Cloud/core compatibility manifest ${manifestPath}.\n`);
}
