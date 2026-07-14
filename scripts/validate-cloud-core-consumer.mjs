#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  jsonSchemaViolations,
  loadPublicDistribution,
  validatePublicDistribution,
} from './lib/public-distribution.mjs';
import { verifyPublicReleaseAttestation } from './lib/public-release-attestation.mjs';

const publicRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const gitExecutable = '/usr/bin/git';
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
    if (['.git', 'node_modules'].includes(entry.name)) continue;
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

function gitCloud(cloudRoot, args, options = {}) {
  const result = execFileSync(gitExecutable, args, {
    cwd: cloudRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
    env: { ...process.env, ...options.env, GIT_NO_REPLACE_OBJECTS: '1' },
  });
  return typeof result === 'string' ? result.trim() : result;
}

function releasePathAllowed(path, allowedPaths) {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//u, '');
  if (allowedPaths.has(normalized)) return true;
  return /(?:^|\/)node_modules(?:\/|$)/u.test(normalized);
}

function repositoryRelativeReleasePaths(cloudRoot, paths) {
  return new Set(
    paths.flatMap((path) => {
      const relativePath = relative(cloudRoot, resolve(cloudRoot, path)).replaceAll('\\', '/');
      return relativePath === '..' || relativePath.startsWith('../') ? [] : [relativePath];
    }),
  );
}

export function cloudRepositoryReleaseViolations(
  cloudRoot,
  sourceCommit,
  { allowedPaths = [] } = {},
) {
  const violations = [];
  const permittedPaths = repositoryRelativeReleasePaths(cloudRoot, allowedPaths);
  try {
    const canonicalRoot = realpathSync(cloudRoot);
    const worktreeRoot = realpathSync(gitCloud(cloudRoot, ['rev-parse', '--show-toplevel']));
    if (canonicalRoot !== worktreeRoot)
      return ['private Cloud release root must equal Git worktree top level'];
  } catch {
    return ['private Cloud release root must be a readable Git worktree'];
  }
  let head;
  try {
    head = gitCloud(cloudRoot, ['rev-parse', '--verify', 'HEAD^{commit}']);
  } catch {
    return ['private Cloud release root must have a readable Git commit'];
  }
  try {
    gitCloud(cloudRoot, ['rev-parse', '--verify', `${sourceCommit}^{commit}`]);
  } catch {
    violations.push('cloudRelease.sourceCommit is not a commit in the private Cloud repository');
  }
  if (sourceCommit !== head) {
    violations.push(`cloudRelease.sourceCommit must equal private Cloud HEAD ${head}`);
  }
  try {
    const replacementReferences = gitCloud(cloudRoot, [
      'for-each-ref',
      '--format=%(refname)',
      'refs/replace',
    ]);
    if (replacementReferences)
      violations.push('private Cloud repository must not contain Git replacement references');
  } catch {
    violations.push('private Cloud repository replacement references could not be inspected');
  }
  try {
    const flaggedPaths = gitCloud(cloudRoot, ['ls-files', '-v', '-z'], {
      encoding: 'buffer',
    })
      .toString('utf8')
      .split('\0')
      .filter(Boolean)
      .filter((entry) => entry[0] === 'S' || entry[0] === entry[0].toLowerCase())
      .map((entry) => entry.slice(2));
    if (flaggedPaths.length > 0)
      violations.push(
        `private Cloud repository has assume-unchanged or skip-worktree paths: ${flaggedPaths.join(', ')}`,
      );
  } catch {
    violations.push('private Cloud repository index flags could not be inspected');
  }
  try {
    const gitlinks = gitCloud(cloudRoot, ['ls-files', '--stage', '-z'], {
      encoding: 'buffer',
    })
      .toString('utf8')
      .split('\0')
      .filter((entry) => entry.startsWith('160000 '))
      .map((entry) => entry.slice(entry.indexOf('\t') + 1));
    if (gitlinks.length > 0)
      violations.push(
        `private Cloud release tree cannot contain submodules: ${gitlinks.join(', ')}`,
      );
  } catch {
    violations.push('private Cloud repository gitlinks could not be inspected');
  }
  try {
    const entries = gitCloud(
      cloudRoot,
      ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'],
      { encoding: 'buffer' },
    )
      .toString('utf8')
      .split('\0')
      .filter(Boolean);
    const trackedDirty = entries.some((entry) => !entry.startsWith('?? '));
    if (trackedDirty) violations.push('private Cloud release tree has uncommitted tracked changes');
    const untracked = entries
      .filter((entry) => entry.startsWith('?? '))
      .map((entry) => entry.slice(3))
      .filter((path) => !releasePathAllowed(path, permittedPaths));
    if (untracked.length > 0)
      violations.push(
        `private Cloud release tree has unbound untracked paths: ${untracked.join(', ')}`,
      );
  } catch {
    violations.push('private Cloud repository worktree state could not be inspected');
  }
  try {
    const ignored = gitCloud(
      cloudRoot,
      ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'],
      { encoding: 'buffer' },
    )
      .toString('utf8')
      .split('\0')
      .filter(Boolean)
      .filter((path) => !releasePathAllowed(path, permittedPaths));
    if (ignored.length > 0)
      violations.push(
        `private Cloud release tree has unbound ignored paths: ${ignored.join(', ')}`,
      );
  } catch {
    violations.push('private Cloud repository ignored inventory could not be inspected');
  }
  return violations;
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

export function resolvedPackageTuple(entry) {
  if (!Array.isArray(entry) || typeof entry[0] !== 'string') return undefined;
  const separator = entry[0].lastIndexOf('@');
  if (separator <= 0) return undefined;
  return {
    name: entry[0].slice(0, separator),
    version: entry[0].slice(separator + 1),
    integrity: entry[3],
  };
}

function forbiddenSourceReference(value) {
  if (typeof value !== 'string') return false;
  return (
    /^(?:git(?:\+[^:]+)?:|github:|https?:|file:|link:)/iu.test(value) ||
    referencesPublicRepository(value)
  );
}

function bunInstallConfigurationViolations(cloudRoot) {
  const path = resolve(cloudRoot, 'bunfig.toml');
  const content = statSync(path, { throwIfNoEntry: false }) ? readFileSync(path, 'utf8') : '';
  const lines = content.split('\n');
  const sectionStart = lines.findIndex((line) => /^\s*\[install\]\s*(?:#.*)?$/u.test(line));
  const sectionEnd = lines.findIndex(
    (line, index) => index > sectionStart && /^\s*\[[^\]]+\]\s*(?:#.*)?$/u.test(line),
  );
  const installSection =
    sectionStart === -1
      ? ''
      : lines.slice(sectionStart + 1, sectionEnd === -1 ? undefined : sectionEnd).join('\n');
  const violations = [];
  if (!/^\s*linker\s*=\s*['"]isolated['"]\s*(?:#.*)?$/mu.test(installSection))
    violations.push('private Cloud bunfig.toml must set install.linker to isolated');
  if (!/^\s*backend\s*=\s*['"]copyfile['"]\s*(?:#.*)?$/mu.test(installSection))
    violations.push('private Cloud bunfig.toml must set install.backend to copyfile');
  return violations;
}

function referencesPublicRepository(value) {
  return /(?:(?:github\.com[/:]|api\.github\.com\/repos\/)?tixkit\/tixkit(?:\.git)?(?:[#/?\s'"\]]|$)|(?:^|[\s='"])\.\.\/tixkit(?:\.git)?(?:[#/?\s'"\]]|$))/iu.test(
    value,
  );
}

function acquiresPublicRepository(value) {
  return (
    referencesPublicRepository(value) &&
    /(?:actions\/checkout@|\bgit\s+(?:clone|fetch|pull)\b|\bgit\s+submodule\s+add\b|\bgh\s+repo\s+clone\b|\b(?:bunx|npx)\s+degit\b|\bnpm\s+(?:i|install)\b|\bbun\s+add\b|\b(?:curl|wget)\b)/iu.test(
      value,
    )
  );
}

function trackedCloudPaths(cloudRoot, violations) {
  try {
    return execFileSync(gitExecutable, ['ls-files', '-z'], {
      cwd: cloudRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\0')
      .filter(Boolean);
  } catch {
    violations.push('private Cloud tree must be a Git repository with readable tracked inventory');
    return [];
  }
}

function isDependencyOutputPath(path) {
  return /(?:^|\/)node_modules(?:\/|$)/u.test(path.replaceAll('\\', '/'));
}

export function normalizedSource(content) {
  return content
    .toString('utf8')
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/(^|[^:])\/\/.*$/gmu, '$1')
    .replace(/\s+/gu, '');
}

function publicTrackedSourceFiles(paths) {
  if (cachedTrackedPublicSources) return cachedTrackedPublicSources;
  const prefixes = [...paths].map((path) => `${path}/`);
  cachedTrackedPublicSources = execFileSync(gitExecutable, ['ls-files', '-z'], {
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

export function sourceShingles(content) {
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

export function shingleSignature(shingles) {
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

export function privateCloudSourceBoundaryViolations(cloudRoot) {
  const violations = [];
  const distribution = validatePublicDistribution(loadPublicDistribution(publicRoot), publicRoot);
  const publicSourcePaths = new Set([
    ...distribution.source.applications,
    ...distribution.source.packages,
  ]);
  const sourceFingerprints = publicSourceFingerprints(publicSourcePaths);
  const sourceSimilarityIndex = publicSourceSimilarityIndex(publicSourcePaths);
  for (const path of trackedCloudPaths(cloudRoot, violations)) {
    if (isDependencyOutputPath(path))
      violations.push(`private Cloud tracks forbidden dependency output: ${path}`);
  }
  for (const path of publicSourcePaths)
    if (statSync(resolve(cloudRoot, path), { throwIfNoEntry: false }))
      violations.push(`private Cloud tree copies public source path: ${path}`);
  for (const file of walk(cloudRoot)) {
    const relativePath = relative(cloudRoot, file).split(sep).join('/');
    const metadata = lstatSync(file, { throwIfNoEntry: false });
    if (!metadata?.isFile()) {
      violations.push(`private Cloud tree contains a symbolic or invalid path: ${relativePath}`);
      continue;
    }
    if (!sourceExtension.test(file)) continue;
    const bytes = readFileSync(file);
    const content = normalizedSource(bytes);
    if (content.length >= 20) {
      const matches = sourceFingerprints.get(sha256(content));
      if (matches)
        violations.push(`${relativePath}: copies public source content from ${matches.join(', ')}`);
    }
    const shingles = sourceShingles(bytes);
    if (shingles.size < 15) continue;
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
  return violations;
}

export function validateCloudCoreConsumer(compatibility, publicRelease, cloudRoot, options = {}) {
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
  violations.push(
    ...cloudRepositoryReleaseViolations(
      cloudRoot,
      compatibility.cloudRelease.sourceCommit,
      options,
    ),
  );
  if (
    JSON.stringify(canonical(compatibility.core)) !== JSON.stringify(canonical(publicRelease.core))
  )
    violations.push('core pins must exactly match the verified public release manifest');

  for (const duplicate of duplicateValues(
    compatibility.core.contracts.map(({ name, version }) => `${name}@${version}`),
  ))
    violations.push(`duplicate core contract pin: ${duplicate}`);
  const openApiPins = compatibility.core.contracts.filter(({ name }) => name === 'openapi');
  if (openApiPins.length !== 1)
    violations.push('core release must contain exactly one OpenAPI contract pin');
  else if (openApiPins[0].version !== compatibility.core.apiVersion)
    violations.push('OpenAPI contract version must equal core.apiVersion');

  if (
    compatibility.core.migrationRange.minimum.localeCompare(
      compatibility.core.migrationRange.maximum,
      'en',
      { numeric: true },
    ) > 0
  )
    violations.push('core migration range minimum must not exceed maximum');

  const { agentProtocol } = compatibility.core;
  const agentContractVersions = compatibility.core.contracts
    .map(({ name }) => name.match(/agent-protocol-([0-9A-Za-z.-]+)\.json$/u)?.[1])
    .filter(Boolean);
  if (
    (agentProtocol.status === 'supported' && agentProtocol.version === '') ||
    (agentProtocol.status === 'unavailable' && agentProtocol.version !== '')
  )
    violations.push('agent protocol status and version are inconsistent');
  if (
    agentProtocol.status === 'supported' &&
    (agentContractVersions.length !== 1 || agentContractVersions[0] !== agentProtocol.version)
  )
    violations.push('supported agent protocol must match exactly one released contract');
  if (agentProtocol.status === 'unavailable' && agentContractVersions.length > 0)
    violations.push('unavailable agent protocol must not include a released contract');

  const publicPackages = new Map(
    publicRelease.core.packages.map((entry) => [entry.name, entry.version]),
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
  const consumedPackageNames = compatibility.cloudRelease.consumedPackages;
  for (const duplicate of duplicateValues(consumedPackageNames))
    violations.push(`duplicate consumed public package: ${duplicate}`);
  const consumedPackages = new Set(consumedPackageNames);
  for (const name of consumedPackages)
    if (!packagePins.has(name)) violations.push(`unknown consumed public package: ${name}`);

  const expectedImages = new Set(publicRelease.core.images.map(({ name }) => name));
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
  for (const path of trackedCloudPaths(cloudRoot, violations)) {
    if (isDependencyOutputPath(path))
      violations.push(`private Cloud tracks forbidden dependency output: ${path}`);
  }
  const lockPath = resolve(cloudRoot, 'bun.lock');
  violations.push(...bunInstallConfigurationViolations(cloudRoot));
  const lock = statSync(lockPath, { throwIfNoEntry: false })
    ? parseBunLock(readFileSync(lockPath, 'utf8'))
    : undefined;
  if (!lock) violations.push('private Cloud tree must include a frozen bun.lock');
  const publicLockResolutions = new Map([...publicPackageNames].map((name) => [name, []]));
  for (const entry of Object.values(lock?.packages ?? {})) {
    const resolution = resolvedPackageTuple(entry);
    if (resolution && publicLockResolutions.has(resolution.name)) {
      publicLockResolutions.get(resolution.name).push(resolution);
    }
  }
  for (const pin of compatibility.core.packages.filter(({ name }) => consumedPackages.has(name))) {
    const resolutions = publicLockResolutions.get(pin.name) ?? [];
    if (resolutions.length === 0) {
      violations.push(`bun.lock does not resolve claimed pin ${pin.name}@${pin.version}`);
      continue;
    }
    if (resolutions.length > 1)
      violations.push(`bun.lock contains multiple resolutions for public package ${pin.name}`);
    for (const resolution of resolutions) {
      if (resolution.version !== pin.version)
        violations.push(
          `bun.lock resolves public package ${pin.name} at forbidden version ${resolution.version}`,
        );
      if (resolution.integrity !== pin.integrity)
        violations.push(
          `bun.lock integrity for claimed pin ${pin.name} does not match the public release`,
        );
    }
  }
  for (const [name, resolutions] of publicLockResolutions)
    if (!consumedPackages.has(name) && resolutions.length > 0)
      violations.push(`bun.lock resolves undeclared consumed public package ${name}`);
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
          if (forbiddenSourceReference(version))
            violations.push(
              `${relativePath}: dependency ${name} uses a forbidden mutable or source reference`,
            );
          if (!publicName) continue;
          if (!consumedPackages.has(publicName))
            violations.push(`${relativePath}: ${publicName} is not declared as consumed`);
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
        if (typeof command === 'string' && acquiresPublicRepository(command))
          violations.push(`${relativePath}: script ${name} acquires public Tixkit source`);
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
    if (relativePath === '.gitmodules') {
      const content = readFileSync(file, 'utf8');
      if (referencesPublicRepository(content))
        violations.push(`${relativePath}: public Tixkit source submodules are forbidden`);
    }
    if (/\.(?:diff|patch)$/u.test(file)) {
      const content = readFileSync(file, 'utf8');
      if (/@tixkit\/|packages\/(?:api|db|domain|shared|workflows)/u.test(content))
        violations.push(`${relativePath}: patch targets public Tixkit source`);
    }
    if (/(?:^|\/)(?:Dockerfile[^/]*|[^/]+\.(?:bash|js|mjs|sh|ts|ya?ml))$/u.test(relativePath)) {
      const content = readFileSync(file, 'utf8');
      if (acquiresPublicRepository(content))
        violations.push(`${relativePath}: executable acquires public Tixkit source`);
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
  const publicRelease = verifyPublicReleaseAttestation(publicRoot, publicReleasePath);
  const compatibility = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const violations = validateCloudCoreConsumer(compatibility, publicRelease, cloudRoot, {
    allowedPaths: [manifestPath, publicReleasePath],
  });
  if (violations.length > 0) {
    throw new Error(`Cloud/core compatibility validation failed:\n${violations.join('\n')}`);
  }
  process.stdout.write(`Validated Cloud/core compatibility manifest ${manifestPath}.\n`);
}
