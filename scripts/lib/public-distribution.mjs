import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { basename, join, relative, resolve, sep } from 'node:path';

const gitExecutable = '/usr/bin/git';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const generatedArtifactNamePattern =
  /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/u;
const agentSkillGeneratorMarker = '@tixkit/api-integration-skill:local-evaluation:v1';

function safeGeneratedArtifactName(name) {
  return (
    typeof name === 'string' &&
    generatedArtifactNamePattern.test(name) &&
    !name.split('/').some((segment) => segment === '.' || segment === '..')
  );
}

function regularTreeFiles(directory, root = directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`${relative(root, path)} is a symbolic link`);
    if (entry.isDirectory()) files.push(...regularTreeFiles(path, root));
    else if (entry.isFile()) files.push(relative(root, path).split(sep).join('/'));
    else throw new Error(`${relative(root, path)} is not a regular file`);
  }
  return files.sort();
}

export function agentIntegrationSkillViolations(manifest, root) {
  const violations = [];
  const declaredSkills = manifest.release.agentIntegrationSkills ?? [];
  const declaredPaths = declaredSkills.map((entry) => entry.path);
  const declaredVersions = declaredSkills.map((entry) => entry.apiVersion);
  const duplicatePaths = declaredPaths.filter(
    (path, index) => declaredPaths.indexOf(path) !== index,
  );
  const duplicateVersions = declaredVersions.filter(
    (version, index) => declaredVersions.indexOf(version) !== index,
  );
  if (duplicatePaths.length > 0 || duplicateVersions.length > 0) {
    violations.push('agent integration skills must declare every retained version exactly once');
  }
  try {
    const retainedPaths = readdirSync(resolve(root, 'artifacts/api-integration-skills'), {
      withFileTypes: true,
    })
      .filter((entry) => {
        if (!/^tixkit-api-\d{4}-\d{2}-\d{2}$/u.test(entry.name)) return false;
        if (!entry.isDirectory()) {
          violations.push(
            `artifacts/api-integration-skills/${entry.name}: retained skill is not a directory`,
          );
          return false;
        }
        return true;
      })
      .map((entry) => `artifacts/api-integration-skills/${entry.name}`)
      .sort((left, right) => right.localeCompare(left));
    if (JSON.stringify(declaredPaths) !== JSON.stringify(retainedPaths)) {
      violations.push(
        'agent integration skill declarations must exactly match retained directories in newest-first order',
      );
    }
    const activeApiVersion = JSON.parse(
      readFileSync(resolve(root, 'apps/docs/public/openapi.json'), 'utf8'),
    ).info?.version;
    if (
      typeof activeApiVersion !== 'string' ||
      declaredSkills[0]?.apiVersion !== activeApiVersion ||
      declaredSkills[0]?.path !== `artifacts/api-integration-skills/tixkit-api-${activeApiVersion}`
    ) {
      violations.push('active OpenAPI version must be the first declared agent integration skill');
    }
  } catch (error) {
    violations.push(
      `agent integration skill inventory cannot be verified: ${error instanceof Error ? error.message : 'invalid inventory'}`,
    );
  }
  for (const entry of declaredSkills) {
    const expectedPath = `artifacts/api-integration-skills/tixkit-api-${entry.apiVersion}`;
    if (entry.path !== expectedPath) {
      violations.push(`${entry.path}: agent integration skill path must be ${expectedPath}`);
      continue;
    }
    const directory = resolve(root, entry.path);
    try {
      const releaseManifest = readFileSync(
        resolve(root, `artifacts/api/${entry.apiVersion}/release-manifest.json`),
      );
      if (sha256(releaseManifest) !== entry.releaseManifestSha256) {
        violations.push(`${entry.path}: source API release manifest digest does not match`);
      }
      const artifactManifestBytes = readFileSync(resolve(directory, 'artifact-manifest.json'));
      const artifactManifest = JSON.parse(artifactManifestBytes.toString('utf8'));
      if (
        artifactManifest.schemaVersion !== 1 ||
        artifactManifest.generator !== agentSkillGeneratorMarker ||
        artifactManifest.apiVersion !== entry.apiVersion ||
        artifactManifest.sourceReleaseManifestSha256 !== entry.releaseManifestSha256
      ) {
        violations.push(`${entry.path}: generated artifact manifest identity does not match`);
      }
      if (artifactManifest.generationMode !== 'local-evaluation') {
        violations.push(`${entry.path}: checked-in skill must remain local-evaluation evidence`);
      }
      const checksums = new Map();
      for (const line of readFileSync(resolve(directory, 'CHECKSUMS.sha256'), 'utf8')
        .trim()
        .split('\n')) {
        const match =
          /^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*)$/u.exec(
            line,
          );
        if (!match || !safeGeneratedArtifactName(match[2])) {
          throw new Error('invalid checksum entry');
        }
        if (checksums.has(match[2])) throw new Error('duplicate checksum entry');
        checksums.set(match[2], match[1]);
      }
      const declared = Array.isArray(artifactManifest.artifacts) ? artifactManifest.artifacts : [];
      const declaredNames = new Set();
      for (const artifact of declared) {
        if (
          !artifact ||
          typeof artifact !== 'object' ||
          !safeGeneratedArtifactName(artifact.name) ||
          declaredNames.has(artifact.name) ||
          typeof artifact.sha256 !== 'string' ||
          !/^[a-f0-9]{64}$/u.test(artifact.sha256) ||
          !Number.isSafeInteger(artifact.size) ||
          artifact.size < 0
        ) {
          throw new Error('invalid or duplicate generated artifact metadata');
        }
        declaredNames.add(artifact.name);
        const bytes = readFileSync(resolve(directory, artifact.name));
        if (
          bytes.byteLength !== artifact.size ||
          sha256(bytes) !== artifact.sha256 ||
          checksums.get(artifact.name) !== artifact.sha256
        ) {
          violations.push(`${entry.path}: ${artifact.name} does not match generated metadata`);
        }
      }
      if (checksums.get('artifact-manifest.json') !== sha256(artifactManifestBytes)) {
        violations.push(`${entry.path}: artifact-manifest.json checksum does not match`);
      }
      const expectedFiles = [
        ...declared.map((artifact) => artifact.name),
        'artifact-manifest.json',
        'CHECKSUMS.sha256',
      ].sort();
      if (JSON.stringify(regularTreeFiles(directory)) !== JSON.stringify(expectedFiles)) {
        violations.push(`${entry.path}: generated file inventory is incomplete or contains extras`);
      }
      if (
        JSON.stringify([...checksums.keys()].sort()) !==
        JSON.stringify(expectedFiles.filter((name) => name !== 'CHECKSUMS.sha256'))
      ) {
        violations.push(`${entry.path}: checksum inventory is incomplete or contains extras`);
      }
    } catch (error) {
      violations.push(`${entry.path}: ${error instanceof Error ? error.message : 'invalid skill'}`);
    }
  }
  return violations;
}

const boundaryControlPaths = new Set([
  'distribution/public-distribution.json',
  'distribution/public-distribution.schema.json',
  'distribution/README.md',
  'scripts/export-oss.mjs',
  'scripts/lib/public-distribution.mjs',
  'scripts/validate-public-distribution.mjs',
  'scripts/__tests__/public-distribution.test.mjs',
  'scripts/__tests__/export-oss.test.mjs',
  'scripts/rehearse-repository-cutover.mjs',
  'scripts/__tests__/repository-cutover-rehearsal.test.mjs',
  'scripts/rehearse-repository-history-cutover.mjs',
  'scripts/__tests__/repository-history-cutover.test.mjs',
  'scripts/validate-repository-content-review.mjs',
  'scripts/__tests__/repository-content-review.test.mjs',
]);

export function loadPublicDistribution(root) {
  return JSON.parse(readFileSync(resolve(root, 'distribution/public-distribution.json'), 'utf8'));
}

function duplicateValues(values) {
  const seen = new Set();
  return values.filter((value) => {
    if (seen.has(value)) return true;
    seen.add(value);
    return false;
  });
}

function immediateDirectories(root, parent) {
  return readdirSync(join(root, parent), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${parent}/${entry.name}`)
    .sort();
}

const alwaysSkippedDirectories = new Set([
  '.astro',
  '.dart_tool',
  '.gradle',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  'coverage',
  'node_modules',
]);
const trackedSourceDirectoryNames = new Set(['.build', 'build', 'dist', 'out', 'target']);

function trackedFiles(root) {
  try {
    return new Set(
      execFileSync(gitExecutable, ['ls-files', '-z', '--cached'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .split('\0')
        .filter(Boolean),
    );
  } catch {
    return undefined;
  }
}

function hasTrackedPath(tracked, prefix) {
  if (!tracked) return true;
  const directoryPrefix = `${prefix}/`;
  return [...tracked].some((path) => path.startsWith(directoryPrefix));
}

function walkFiles(directory, symlinks, root, tracked, trackedOnly = false) {
  const files = [];
  const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  for (const entry of entries) {
    if (
      alwaysSkippedDirectories.has(entry.name) ||
      entry.name === '.next' ||
      entry.name.startsWith('.next-')
    )
      continue;
    const path = join(directory, entry.name);
    const repositoryPath = relative(root, path).split(sep).join('/');
    const insideTrackedSourceDirectory = trackedOnly || trackedSourceDirectoryNames.has(entry.name);
    if (
      insideTrackedSourceDirectory &&
      tracked &&
      (entry.isDirectory()
        ? !hasTrackedPath(tracked, repositoryPath)
        : !tracked.has(repositoryPath))
    )
      continue;
    if (entry.isSymbolicLink()) {
      symlinks.push(path);
      continue;
    }
    if (entry.isDirectory())
      files.push(...walkFiles(path, symlinks, root, tracked, insideTrackedSourceDirectory));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function isInsideRoot(root, candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.includes('\0')) {
    return false;
  }
  const rootPath = resolve(root);
  const candidatePath = resolve(rootPath, candidate);
  const path = relative(rootPath, candidatePath);
  return path !== '..' && !path.startsWith(`..${sep}`) && !path.startsWith('/');
}

function validateExistingPath(root, candidate, label, violations, options = {}) {
  if (!isInsideRoot(root, candidate)) {
    violations.push(`${label} contains unsafe path ${String(candidate)}`);
    return undefined;
  }
  const absolute = resolve(root, candidate);
  const metadata = lstatSync(absolute, { throwIfNoEntry: false });
  if (!metadata) {
    if (!options.allowMissing) violations.push(`${label} path does not exist: ${candidate}`);
    return undefined;
  }
  if (metadata.isSymbolicLink()) {
    violations.push(`${label} must not be a symbolic link: ${candidate}`);
    return undefined;
  }
  const realRoot = realpathSync(root);
  const realCandidate = realpathSync(absolute);
  const realRelative = relative(realRoot, realCandidate);
  if (
    realRelative === '..' ||
    realRelative.startsWith(`..${sep}`) ||
    realRelative.startsWith('/')
  ) {
    violations.push(`${label} resolves outside the repository: ${candidate}`);
    return undefined;
  }
  if (options.kind === 'file' && !metadata.isFile()) {
    violations.push(`${label} must be a file: ${candidate}`);
  }
  if (options.kind === 'directory' && !metadata.isDirectory()) {
    violations.push(`${label} must be a directory: ${candidate}`);
  }
  return metadata;
}

function trackedInventory(root) {
  try {
    const output = execFileSync(
      gitExecutable,
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const files = output.split('\0').filter(Boolean);
    return {
      topLevel: [...new Set(files.map((path) => path.split('/')[0]))].sort(),
      docs: [
        ...new Set(
          files
            .filter((path) => path.startsWith('docs/'))
            .map((path) => path.split('/').slice(0, 2).join('/')),
        ),
      ].sort(),
    };
  } catch {
    return undefined;
  }
}

function assertCompleteAncestry(root, mode) {
  const shallow = execFileSync(gitExecutable, ['rev-parse', '--is-shallow-repository'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  if (shallow !== 'false') throw new Error(`${mode} history validation requires complete ancestry`);
}

function historicalInventory(root) {
  assertCompleteAncestry(root, 'full');
  const output = execFileSync(
    gitExecutable,
    ['log', 'HEAD', '--tags', '--name-only', '--format=', '-z'],
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  return [...new Set(output.split('\0').filter(Boolean))].sort();
}

function pathMatchesRoot(path, root) {
  return path === root || path.startsWith(`${root}/`);
}

export function historicalClassificationViolations(manifest, root) {
  const violations = [];
  const historical = manifest.classification.historical;
  const exceptions = Object.values(historical).flat();
  for (const duplicate of duplicateValues(exceptions)) {
    violations.push(`historical path has multiple classifications: ${duplicate}`);
  }
  for (const path of exceptions) {
    if (!isInsideRoot(root, path))
      violations.push(`historical classification contains unsafe path ${path}`);
  }

  if (manifest.classification.historyValidation === 'snapshot') {
    if (exceptions.length > 0)
      violations.push('snapshot history classification must not contain historical paths');
    assertCompleteAncestry(root, 'snapshot');
    const commitCount = Number.parseInt(
      execFileSync(gitExecutable, ['rev-list', '--all', '--count'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim(),
      10,
    );
    if (commitCount !== 1)
      violations.push(
        `snapshot history must contain exactly one reachable commit, found ${commitCount}`,
      );
    return violations;
  }

  const current = trackedInventory(root);
  if (current) {
    const currentFiles = new Set(
      execFileSync(
        gitExecutable,
        ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
        {
          cwd: root,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      )
        .split('\0')
        .filter(Boolean),
    );
    for (const path of exceptions) {
      if (currentFiles.has(path))
        violations.push(`historical classification is still present: ${path}`);
    }
  }

  const inventory = historicalInventory(root);
  const topLevelRoots = Object.values(manifest.classification.topLevel).flat();
  const docsRoots = Object.values(manifest.classification.docs).flat();
  const generatedRoots = manifest.classification.generatedRoots;
  const exceptionSet = new Set(exceptions);
  for (const path of inventory) {
    const classified = path.startsWith('docs/')
      ? docsRoots.some((entry) => pathMatchesRoot(path, entry))
      : [...topLevelRoots, ...generatedRoots].some((entry) => pathMatchesRoot(path, entry));
    if (!classified && !exceptionSet.has(path)) {
      violations.push(`unclassified historical path: ${path}`);
    }
  }
  for (const path of exceptionSet) {
    if (!inventory.includes(path)) violations.push(`stale historical classification: ${path}`);
  }
  return violations;
}

function classifyCoverage(actual, groups, label, violations) {
  const classified = groups.flatMap((group) => group ?? []);
  for (const duplicate of duplicateValues(classified)) {
    violations.push(`${label} path has multiple classifications: ${duplicate}`);
  }
  const classifiedSet = new Set(classified);
  for (const path of actual) {
    if (!classifiedSet.has(path)) violations.push(`unclassified ${label} path: ${path}`);
  }
  for (const path of classifiedSet) {
    if (!actual.includes(path)) violations.push(`stale ${label} classification: ${path}`);
  }
}

function matchesForbiddenDependency(value, forbiddenDependencies) {
  const normalized = value.toLowerCase();
  return forbiddenDependencies.some((forbidden) => normalized.includes(forbidden.toLowerCase()));
}

function referencesPrivateRoot(value, privateRoots) {
  const pathSegments = new Set(
    value
      .replaceAll('\\', '/')
      .split(/[\s'"`()=:,]+/u)
      .flatMap((token) => token.split('/'))
      .filter(Boolean),
  );
  return privateRoots.some((privateRoot) => pathSegments.has(privateRoot));
}

function publicScanEntries(manifest, root) {
  const paths = [
    ...(manifest.source.rootFiles ?? []),
    ...(manifest.source.rootDirectories ?? []),
    ...(manifest.source.applications ?? []),
    ...(manifest.source.packages ?? []),
    ...(manifest.source.documentation ?? []),
  ];
  const files = new Set();
  const symlinks = [];
  const tracked = trackedFiles(root);
  for (const path of paths) {
    const absolute = resolve(root, path);
    const metadata = lstatSync(absolute, { throwIfNoEntry: false });
    if (!metadata) continue;
    if (metadata.isSymbolicLink()) {
      symlinks.push(absolute);
      continue;
    }
    if (metadata.isDirectory()) {
      for (const file of walkFiles(absolute, symlinks, root, tracked)) files.add(file);
    } else if (metadata.isFile()) {
      files.add(absolute);
    }
  }
  return {
    files: [...files].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
    symlinks: symlinks.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
  };
}

export function publicDependencyBoundaryViolations(manifest, root) {
  const violations = [];
  const forbiddenDependencies = manifest?.forbiddenDependencies ?? [];
  const privateRoots = manifest?.classification?.topLevel?.privateCloud ?? [];
  const { files, symlinks } = publicScanEntries(manifest, root);
  for (const symlink of symlinks) {
    violations.push(
      `${relative(root, symlink).split(sep).join('/')}: symbolic links are forbidden in public source`,
    );
  }
  for (const file of files) {
    const relativePath = relative(root, file).split(sep).join('/');
    if (boundaryControlPaths.has(relativePath)) continue;
    let content;
    try {
      content = readFileSync(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (file.endsWith('package.json')) {
      const packageManifest = JSON.parse(content);
      for (const field of [
        'dependencies',
        'devDependencies',
        'optionalDependencies',
        'peerDependencies',
      ]) {
        for (const [name, version] of Object.entries(packageManifest[field] ?? {})) {
          if (
            matchesForbiddenDependency(`${name} ${String(version)}`, forbiddenDependencies) ||
            referencesPrivateRoot(`${name} ${String(version)}`, privateRoots)
          ) {
            violations.push(`${relativePath}: forbidden ${field} dependency ${name}`);
          }
        }
      }
      for (const [name, command] of Object.entries(packageManifest.scripts ?? {})) {
        if (
          matchesForbiddenDependency(String(command), forbiddenDependencies) ||
          referencesPrivateRoot(String(command), privateRoots)
        ) {
          violations.push(`${relativePath}: forbidden private script reference ${name}`);
        }
      }
      continue;
    }
    if (/^(?:tsconfig(?:\.[a-z0-9_-]+)?|turbo)\.json$/u.test(basename(file))) {
      if (referencesPrivateRoot(content, privateRoots)) {
        violations.push(`${relativePath}: forbidden private JSON build reference`);
      }
      continue;
    }
    if (
      !/\.(?:cjs|css|dockerfile|go|html|js|jsx|kt|kts|md|mdx|mjs|rs|sh|swift|toml|ts|tsx|yaml|yml)$/u.test(
        file,
      ) &&
      !file.split(sep).at(-1)?.startsWith('Dockerfile')
    )
      continue;
    for (const line of content.split('\n')) {
      const hasForbiddenIdentifier = matchesForbiddenDependency(line, forbiddenDependencies);
      const hasPrivateRootReference = referencesPrivateRoot(line, privateRoots);
      if (!hasForbiddenIdentifier && !hasPrivateRootReference) continue;
      const hasBuildReference =
        /^\s*(?:-\s*)?(?:require|replace|uses:|run:|FROM|COPY)\s+/u.test(line) ||
        /\b(?:from|import|require)\s*(?:\(|[`'"])/u.test(line);
      const hasRemoteReference = /(?:https?:\/\/|git@)\S+/u.test(line);
      if (
        (hasForbiddenIdentifier && (hasBuildReference || hasRemoteReference)) ||
        (hasPrivateRootReference && hasBuildReference)
      ) {
        violations.push(`${relativePath}: forbidden private dependency/build reference`);
        break;
      }
    }
  }
  return violations;
}

function valueType(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

export function jsonSchemaViolations(value, schema, path = '$', rootSchema = schema) {
  const violations = [];
  if (schema.$ref) {
    if (!schema.$ref.startsWith('#/'))
      return [`${path} uses unsupported schema ref ${schema.$ref}`];
    const target = schema.$ref
      .slice(2)
      .split('/')
      .reduce(
        (current, segment) => current?.[segment.replaceAll('~1', '/').replaceAll('~0', '~')],
        rootSchema,
      );
    if (!target) return [`${path} references missing schema ${schema.$ref}`];
    return jsonSchemaViolations(value, target, path, rootSchema);
  }
  if (schema.const !== undefined && value !== schema.const) {
    violations.push(`${path} must equal ${JSON.stringify(schema.const)}`);
    return violations;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    violations.push(`${path} must be one of ${schema.enum.join(', ')}`);
    return violations;
  }
  const actualType = valueType(value);
  const matchesType =
    schema.type === 'integer'
      ? actualType === 'number' && Number.isInteger(value)
      : !schema.type || actualType === schema.type;
  if (!matchesType) {
    violations.push(`${path} must be ${schema.type}`);
    return violations;
  }
  if (
    (schema.type === 'integer' || schema.type === 'number') &&
    schema.minimum !== undefined &&
    value < schema.minimum
  ) {
    violations.push(`${path} must be at least ${schema.minimum}`);
  }
  if (schema.type === 'object') {
    for (const required of schema.required ?? []) {
      if (!(required in value)) violations.push(`${path}.${required} is required`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in (schema.properties ?? {}))) violations.push(`${path}.${key} is not allowed`);
      }
    }
    for (const [key, childSchema] of Object.entries(schema.properties ?? {})) {
      if (key in value)
        violations.push(
          ...jsonSchemaViolations(value[key], childSchema, `${path}.${key}`, rootSchema),
        );
    }
  }
  if (schema.type === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      violations.push(`${path} must contain at least ${schema.minItems} items`);
    }
    value.forEach((item, index) => {
      violations.push(
        ...jsonSchemaViolations(item, schema.items ?? {}, `${path}[${index}]`, rootSchema),
      );
    });
  }
  if (schema.type === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      violations.push(`${path} must contain at least ${schema.minLength} characters`);
    }
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) {
      violations.push(`${path} must match ${schema.pattern}`);
    }
  }
  return violations;
}

function validateNpmReleaseMetadata(entry, manifest, root, violations) {
  const packagePath = resolve(root, entry.path, 'package.json');
  const packageManifest = JSON.parse(readFileSync(packagePath, 'utf8'));
  const expectedRepository = {
    type: 'git',
    url: 'git+https://github.com/tixkithq/tixkit.git',
    directory: entry.path,
  };
  if (packageManifest.private === true)
    violations.push(`${entry.path}: release package is private`);
  const expectedLicense =
    manifest.licensing.status === 'approved'
      ? manifest.licensing.intendedPublicLicense
      : 'UNLICENSED';
  if (packageManifest.license !== expectedLicense) {
    violations.push(`${entry.path}: license must be ${expectedLicense}`);
  }
  if (JSON.stringify(packageManifest.repository) !== JSON.stringify(expectedRepository)) {
    violations.push(`${entry.path}: repository metadata must point to tixkithq/tixkit`);
  }
  if (
    packageManifest.homepage &&
    packageManifest.homepage !== 'https://github.com/tixkithq/tixkit#readme'
  ) {
    violations.push(`${entry.path}: homepage metadata must point to tixkithq/tixkit`);
  }
  if (
    packageManifest.bugs?.url &&
    packageManifest.bugs.url !== 'https://github.com/tixkithq/tixkit/issues'
  ) {
    violations.push(`${entry.path}: bugs metadata must point to tixkithq/tixkit`);
  }
  if (!Array.isArray(packageManifest.files) || packageManifest.files.length === 0) {
    violations.push(`${entry.path}: files must define the published package boundary`);
  }
  if (!packageManifest.exports?.['./package.json']) {
    violations.push(`${entry.path}: exports must expose ./package.json`);
  }
  if (
    packageManifest.publishConfig?.access !== 'public' ||
    packageManifest.publishConfig?.provenance !== true
  ) {
    violations.push(`${entry.path}: publishConfig must require public access and provenance`);
  }
  if (!statSync(resolve(root, entry.path, 'README.md'), { throwIfNoEntry: false })) {
    violations.push(`${entry.path}: README.md is required`);
  }
}

export function sdkReleaseWorkflowViolations(manifest, workflow) {
  const violations = [];
  const pullRequestBlock = workflow.match(/^  pull_request:\s*\n((?: {4}.*\n)*)/mu)?.[1];
  const runsForEveryPullRequest =
    pullRequestBlock !== undefined && !/^    paths(?:-ignore)?:/mu.test(pullRequestBlock);
  const explicitlyCoversEveryPackage = /^\s+- ['"]packages\/\*\*['"]$/mu.test(workflow);
  if (!runsForEveryPullRequest && !explicitlyCoversEveryPackage) {
    violations.push('SDK release workflow must trigger for every packages/** change');
  }
  for (const entry of manifest.release.packages.filter(({ path }) =>
    path.split('/').at(-1)?.startsWith('sdk-'),
  )) {
    const job =
      entry.ecosystem === 'npm'
        ? 'public-npm-dry-run'
        : `${entry.path.split('/').at(-1).slice(4)}-sdk-dry-run`;
    if (!new RegExp(`^  ${job}:$`, 'mu').test(workflow)) {
      violations.push(`${entry.path}: SDK release workflow is missing job ${job}`);
    }
  }
  return violations;
}

function validateSdkReleaseWorkflow(manifest, root, violations) {
  const workflowPath = resolve(root, '.github/workflows/sdk-release-dry-run.yml');
  const workflow = readFileSync(workflowPath, 'utf8');
  violations.push(...sdkReleaseWorkflowViolations(manifest, workflow));
}

export function npmReleaseDependencyViolations(packageManifest, packagePath = 'package') {
  const violations = [];
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [name, version] of Object.entries(packageManifest[field] ?? {}))
      if (String(version).startsWith('workspace:'))
        violations.push(
          `${packagePath}: ${field}.${name} uses non-publishable workspace protocol ${version}`,
        );
  }
  return violations;
}

export function validatePublicDistribution(manifest, root, schema) {
  const violations = [];
  const resolvedSchema =
    schema ??
    JSON.parse(readFileSync(resolve(root, 'distribution/public-distribution.schema.json'), 'utf8'));
  violations.push(...jsonSchemaViolations(manifest, resolvedSchema));
  if (violations.length > 0) {
    throw new Error(
      `Public distribution manifest validation failed:\n${violations.map((item) => `- ${item}`).join('\n')}`,
    );
  }

  if (manifest.authority.publicRepository !== 'tixkithq/tixkit')
    violations.push('publicRepository must be tixkithq/tixkit');
  if (manifest.authority.cloudRepository !== 'tixkithq/tixkit-cloud')
    violations.push('cloudRepository must be tixkithq/tixkit-cloud');
  if (manifest.authority.sharedFixPolicy !== 'public-first')
    violations.push('sharedFixPolicy must be public-first');
  if (manifest.authority.cloudConsumption !== 'immutable-artifacts-only')
    violations.push('cloudConsumption must be immutable-artifacts-only');
  if (manifest.licensing.intendedPublicLicense !== 'MIT')
    violations.push('intendedPublicLicense must be MIT');
  if (
    manifest.licensing.status === 'pending-legal-review' &&
    (manifest.licensing.mayClaimLegalApproval !== false ||
      manifest.licensing.legalReviewEvidence !== '')
  ) {
    violations.push('pending legal review must not claim legal approval or approval evidence');
  }
  if (
    manifest.licensing.status === 'approved' &&
    (manifest.licensing.mayClaimLegalApproval !== true ||
      !['docs/completion/legal-review-approval.md', 'LEGAL_APPROVAL.md'].includes(
        manifest.licensing.legalReviewEvidence,
      ))
  ) {
    violations.push(
      'approved legal status requires an approval claim and canonical legal evidence',
    );
  }
  if (manifest.licensing.status === 'approved')
    validateExistingPath(
      root,
      manifest.licensing.legalReviewEvidence,
      'legal approval evidence',
      violations,
      { kind: 'file' },
    );
  if (
    manifest.licensing.legalReviewEvidence === 'LEGAL_APPROVAL.md' &&
    (manifest.classification.topLevel.privateCloud.length > 0 ||
      manifest.classification.topLevel.internalPlanning.length > 0 ||
      manifest.classification.docs.internalPlanning.length > 0)
  )
    violations.push(
      'public legal approval receipt is valid only in the extracted public repository',
    );

  for (const [group, values] of Object.entries(manifest.source)) {
    for (const duplicate of duplicateValues(values))
      violations.push(`source.${group} duplicates ${duplicate}`);
    for (const path of values) validateExistingPath(root, path, `source.${group}`, violations);
  }

  const inventory = trackedInventory(root);
  if (inventory) {
    classifyCoverage(
      inventory.topLevel,
      Object.values(manifest.classification.topLevel),
      'top-level',
      violations,
    );
    classifyCoverage(
      inventory.docs,
      Object.values(manifest.classification.docs),
      'docs',
      violations,
    );
  }
  violations.push(...historicalClassificationViolations(manifest, root));
  if (inventory) {
    for (const path of [
      ...Object.values(manifest.classification.topLevel).flat(),
      ...Object.values(manifest.classification.docs).flat(),
      ...manifest.classification.generatedRoots,
    ]) {
      validateExistingPath(root, path, 'classification', violations, {
        allowMissing: path === 'graphify-out',
      });
    }
  }

  for (const parent of ['apps', 'packages']) {
    const declared = new Set(
      parent === 'apps' ? manifest.source.applications : manifest.source.packages,
    );
    const actual = immediateDirectories(root, parent);
    for (const path of actual)
      if (!declared.has(path)) violations.push(`unclassified public ${parent} directory: ${path}`);
    for (const path of declared)
      if (!actual.includes(path)) violations.push(`stale ${parent} classification: ${path}`);
  }

  const sourcePackages = new Set(manifest.source.packages);
  const releaseEntries = manifest.release.packages;
  const releasePaths = new Set(releaseEntries.map((entry) => entry.path));
  for (const packagePath of sourcePackages) {
    if (packagePath.split('/').at(-1)?.startsWith('sdk-') && !releasePaths.has(packagePath)) {
      violations.push(`public SDK missing from release.packages: ${packagePath}`);
    }
    const packageJson = resolve(root, packagePath, 'package.json');
    if (!statSync(packageJson, { throwIfNoEntry: false })) continue;
    const packageManifest = JSON.parse(readFileSync(packageJson, 'utf8'));
    if (
      (packageManifest.private === false || packageManifest.publishConfig?.access === 'public') &&
      !releasePaths.has(packagePath)
    ) {
      violations.push(`publishable package missing from release.packages: ${packagePath}`);
    }
  }
  const packageNameToPath = new Map();
  for (const packagePath of sourcePackages) {
    const packageJson = resolve(root, packagePath, 'package.json');
    if (!statSync(packageJson, { throwIfNoEntry: false })) continue;
    const packageManifest = JSON.parse(readFileSync(packageJson, 'utf8'));
    if (typeof packageManifest.name === 'string')
      packageNameToPath.set(packageManifest.name, packagePath);
  }
  for (const entry of releaseEntries) {
    if (!sourcePackages.has(entry.path))
      violations.push(`release package is not a public source package: ${entry.path}`);
    validateExistingPath(root, entry.path, 'release.packages', violations, {
      kind: 'directory',
    });
    if (entry.ecosystem === 'npm' || entry.ecosystem === 'npm-and-cdn') {
      validateNpmReleaseMetadata(entry, manifest, root, violations);
      const packageManifest = JSON.parse(
        readFileSync(resolve(root, entry.path, 'package.json'), 'utf8'),
      );
      violations.push(...npmReleaseDependencyViolations(packageManifest, entry.path));
      for (const field of ['dependencies', 'optionalDependencies']) {
        for (const [name, version] of Object.entries(packageManifest[field] ?? {})) {
          const dependencyPath = packageNameToPath.get(name);
          if (
            String(version).startsWith('workspace:') &&
            dependencyPath &&
            !releasePaths.has(dependencyPath)
          ) {
            violations.push(
              `${entry.path}: workspace dependency is not released: ${dependencyPath}`,
            );
          }
        }
      }
    }
  }
  validateSdkReleaseWorkflow(manifest, root, violations);

  const declaredDockerfiles = new Set(manifest.release.images.map((image) => image.dockerfile));
  const repositoryDockerfiles = readdirSync(root)
    .filter((name) => /^Dockerfile\.[a-z0-9-]+$/u.test(name))
    .sort();
  for (const image of manifest.release.images)
    validateExistingPath(root, image.dockerfile, 'release.images', violations, {
      kind: 'file',
    });
  for (const dockerfile of repositoryDockerfiles)
    if (!declaredDockerfiles.has(dockerfile))
      violations.push(`unclassified release image Dockerfile: ${dockerfile}`);
  for (const dockerfile of declaredDockerfiles)
    if (!repositoryDockerfiles.includes(dockerfile))
      violations.push(`stale release image Dockerfile classification: ${dockerfile}`);
  for (const contract of manifest.release.contracts)
    validateExistingPath(root, contract, 'release.contracts', violations);
  for (const skill of manifest.release.agentIntegrationSkills ?? [])
    validateExistingPath(root, skill.path, 'release.agentIntegrationSkills', violations, {
      kind: 'directory',
    });
  violations.push(...agentIntegrationSkillViolations(manifest, root));
  const apiContractPaths = manifest.release.contracts.filter((contract) =>
    /^artifacts\/api\/\d{4}-\d{2}-\d{2}$/u.test(contract),
  );
  const declaredApiContracts = new Set(apiContractPaths);
  const generatedOpenApiVersion = JSON.parse(
    readFileSync(resolve(root, 'apps/docs/public/openapi.json'), 'utf8'),
  ).info?.version;
  const expectedActiveApiContract = `artifacts/api/${generatedOpenApiVersion}`;
  if (apiContractPaths[0] !== expectedActiveApiContract) {
    violations.push(
      `first release API contract must be the generated active contract: ${expectedActiveApiContract}`,
    );
  }
  for (const entry of readdirSync(resolve(root, 'artifacts/api'), {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/u.test(entry.name)) continue;
    const contract = `artifacts/api/${entry.name}`;
    if (!declaredApiContracts.has(contract)) {
      violations.push(`retained API contract missing from release.contracts: ${contract}`);
    }
  }
  for (const [profile, path] of Object.entries(manifest.release.selfHostedProfiles)) {
    validateExistingPath(root, path, `self-hosted ${profile}`, violations);
  }

  const privateRoots = new Set(manifest.classification.topLevel.privateCloud);
  const publicSelections = Object.values(manifest.source).flat();
  for (const privateRoot of privateRoots) {
    if (
      publicSelections.some((path) => path === privateRoot || path.startsWith(`${privateRoot}/`))
    ) {
      violations.push(`private Cloud root is included publicly: ${privateRoot}`);
    }
  }
  violations.push(...publicDependencyBoundaryViolations(manifest, root));

  if (violations.length > 0) {
    throw new Error(
      `Public distribution manifest validation failed:\n${violations.map((item) => `- ${item}`).join('\n')}`,
    );
  }
  return manifest;
}
