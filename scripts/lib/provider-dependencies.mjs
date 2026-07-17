import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { parseSync } from 'oxc-parser';
import { providerSourceBoundaryFindings } from './provider-client-boundary.mjs';
import {
  loadProviderIntegrationRegistry,
  pathMatchesPolicy,
  registryHostPolicies,
  registryImportPolicies,
  registryNonProviderHostPolicies,
} from './provider-integration-registry.mjs';

const sourceExtension = /\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/u;
const ignoredSegment =
  /(?:^|\/)(?:\.astro|\.dart_tool|\.expo|\.next|\.nuxt|\.output|\.svelte-kit|\.turbo|build|coverage|dist|generated|node_modules|out|test-results)(?:\/|$)/u;
const testPath = /(?:^|\/)(?:__tests__\/|[^/]+\.(?:integration\.)?(?:spec|test)\.)/u;

export const PROVIDER_DEPENDENCY_INVENTORY_PATH = 'distribution/provider-dependency-inventory.json';
export const PROVIDER_DEPENDENCY_INVENTORY_SCHEMA_PATH =
  'distribution/provider-dependency-inventory.schema.json';

function canonicalJson(value) {
  const serialize = (candidate, depth) => {
    if (Array.isArray(candidate)) {
      if (candidate.every((entry) => entry === null || typeof entry !== 'object')) {
        const inline = `[${candidate.map((entry) => JSON.stringify(entry)).join(', ')}]`;
        if (inline.length <= 100) return inline;
        const indentation = '  '.repeat(depth + 1);
        return `[\n${candidate
          .map((entry) => `${indentation}${JSON.stringify(entry)}`)
          .join(',\n')}\n${'  '.repeat(depth)}]`;
      }
      if (candidate.length === 0) return '[]';
      const indentation = '  '.repeat(depth + 1);
      return `[\n${candidate
        .map((entry) => `${indentation}${serialize(entry, depth + 1)}`)
        .join(',\n')}\n${'  '.repeat(depth)}]`;
    }
    if (candidate !== null && typeof candidate === 'object') {
      const entries = Object.entries(candidate);
      if (entries.length === 0) return '{}';
      const indentation = '  '.repeat(depth + 1);
      return `{\n${entries
        .map(
          ([key, entry]) => `${indentation}${JSON.stringify(key)}: ${serialize(entry, depth + 1)}`,
        )
        .join(',\n')}\n${'  '.repeat(depth)}}`;
    }
    return JSON.stringify(candidate);
  };
  return `${serialize(value, 0)}\n`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (ignoredSegment.test(`/${entry.name}/`)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else if (entry.isFile() && sourceExtension.test(path) && !/\.d\.(?:cts|mts|ts)$/u.test(path)) {
      files.push(path);
    }
  }
  return files;
}

function staticString(node) {
  if (!node) return undefined;
  if (
    (node.type === 'Literal' || node.type === 'StringLiteral') &&
    typeof node.value === 'string'
  ) {
    return node.value;
  }
  return undefined;
}

function packageName(specifier) {
  if (
    !specifier ||
    specifier.startsWith('.') ||
    specifier.startsWith('/') ||
    specifier.startsWith('node:')
  ) {
    return undefined;
  }
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/');
  return specifier.split('/')[0];
}

function sourceImports(path, source) {
  const parsed = parseSync(path, source);
  if (parsed.errors.length > 0)
    throw new Error(`Unable to parse ${path} while auditing provider imports`);
  const imports = new Set();
  const seen = new WeakSet();
  const visit = (node) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    let specifier;
    if (
      node.type === 'ImportDeclaration' ||
      node.type === 'ExportNamedDeclaration' ||
      node.type === 'ExportAllDeclaration'
    ) {
      specifier = staticString(node.source);
    } else if (node.type === 'ImportExpression') {
      specifier = staticString(node.source);
    } else if (
      node.type === 'CallExpression' &&
      node.callee?.type === 'Identifier' &&
      node.callee.name === 'require'
    ) {
      specifier = staticString(node.arguments?.[0]);
    } else if (node.type === 'TSImportEqualsDeclaration') {
      specifier = staticString(node.moduleReference?.expression);
    }
    const dependency = packageName(specifier);
    if (dependency) imports.add(dependency);
    for (const [key, value] of Object.entries(node)) {
      if (key === 'parent' || key === 'scope') continue;
      if (Array.isArray(value)) value.forEach(visit);
      else visit(value);
    }
  };
  visit(parsed.program);
  return imports;
}

function packageRoot(packagePath) {
  return dirname(packagePath);
}

function maskJavaScriptComments(source) {
  let output = '';
  let quote;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (quote) {
      output += character;
      if (character === '\\') {
        if (next !== undefined) {
          output += next;
          index += 1;
        }
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      output += character;
      continue;
    }
    if (character === '/' && next === '/') {
      output += '  ';
      index += 2;
      while (index < source.length && source[index] !== '\n') {
        output += ' ';
        index += 1;
      }
      if (index < source.length) output += '\n';
      continue;
    }
    if (character === '/' && next === '*') {
      output += '  ';
      index += 2;
      while (index < source.length) {
        if (source[index] === '*' && source[index + 1] === '/') {
          output += '  ';
          index += 1;
          break;
        }
        output += source[index] === '\n' ? '\n' : ' ';
        index += 1;
      }
      continue;
    }
    output += character;
  }
  return output;
}

function sourceMayContainClassifiedDependency(source, classifiedDependencies) {
  const decoded = source
    .replace(/\\x([0-9a-f]{2})/giu, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/\\u([0-9a-f]{4})/giu, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/\\u\{([0-9a-f]{1,6})\}/giu, (_match, hex) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    );
  const compact = decoded.replace(/[^a-z0-9]/giu, '').toLowerCase();
  return [...classifiedDependencies].some((dependency) =>
    compact.includes(dependency.replace(/[^a-z0-9]/giu, '').toLowerCase()),
  );
}

function sourceMayContainDynamicModuleLoad(source) {
  const withoutStaticLoads = source.replace(
    /\b(?:import|require)\s*\(\s*(?:'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`$\\])*`)\s*\)/gu,
    '',
  );
  const lexical = maskJavaScriptComments(withoutStaticLoads);
  return (
    /\bcreateRequire\b/u.test(lexical) ||
    /\bmodule\s*\[/u.test(lexical) ||
    /=\s*[^;]*\bmodule\b/u.test(lexical) ||
    /\b(?:const|let|var)\s+(?:[A-Za-z_$][\w$]*\s*=\s*module\b|\{[^}]*\brequire\s*:)/u.test(
      lexical,
    ) ||
    /\brequire\s*(?:[([.;,\]}]|$)/u.test(lexical) ||
    /\bimport\s*\(/u.test(lexical)
  );
}

function sourceMayContainClassifiedImport(source, classifiedDependencies) {
  const decoded = source
    .replace(/\\x([0-9a-f]{2})/giu, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/\\u([0-9a-f]{4})/giu, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/\\u\{([0-9a-f]{1,6})\}/giu, (_match, hex) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    );
  const lexical = maskJavaScriptComments(decoded);
  for (const dependency of classifiedDependencies) {
    const escaped = dependency.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const packageLiteral = `(?:'${escaped}(?:/[^'\\\\]*)?'|"${escaped}(?:/[^"\\\\]*)?"|\`${escaped}(?:/[^\`\\\\$]*)?\`)`;
    const gap = String.raw`(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*(?:\n|$))*`;
    const patterns = [
      new RegExp(`\\bimport${gap}${packageLiteral}`, 'u'),
      new RegExp(`\\bimport${gap}\\(${gap}${packageLiteral}`, 'u'),
      new RegExp(`\\b(?:export|import)[^;]*?\\bfrom${gap}${packageLiteral}`, 'u'),
      new RegExp(`\\bimport[^;]*?=\\s*require\\s*\\(\\s*${packageLiteral}`, 'u'),
      new RegExp(`\\b(?:module|require)[^;]*?\\(\\s*${packageLiteral}`, 'u'),
    ];
    if (patterns.some((pattern) => pattern.test(lexical))) return true;
  }
  return false;
}

export function providerDependencyInventory(
  root,
  registry = loadProviderIntegrationRegistry(root),
) {
  const repositoryRoot = resolve(root);
  const hostPolicies = registryHostPolicies(registry);
  const importPolicies = registryImportPolicies(registry);
  const nonProviderHostPolicies = registryNonProviderHostPolicies(registry);
  const classifiedDependencies = new Set(importPolicies.keys());
  const dependencyAllowances = new Map();
  for (const integration of registry.integrations) {
    for (const allowance of integration.allowedDependencies) {
      const key = `${allowance.packagePath}\0${allowance.package}\0${allowance.dependencyClass}`;
      const integrationIds = dependencyAllowances.get(key) ?? [];
      integrationIds.push(integration.id);
      dependencyAllowances.set(key, integrationIds);
    }
  }

  const manifests = [];
  const imports = [];
  for (const manifestPath of registry.dependencyAuditPackages) {
    const manifest = JSON.parse(readFileSync(resolve(repositoryRoot, manifestPath), 'utf8'));
    manifests.push({ path: manifestPath, manifest });
    const sourceRoot = resolve(repositoryRoot, packageRoot(manifestPath));
    let files = [];
    try {
      files = walk(sourceRoot);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    for (const absolutePath of files) {
      const path = relative(repositoryRoot, absolutePath).replaceAll('\\', '/');
      const source = readFileSync(absolutePath, 'utf8');
      const mayContainClassifiedImport = sourceMayContainClassifiedImport(
        source,
        classifiedDependencies,
      );
      const mayContainDynamicModuleLoad = sourceMayContainDynamicModuleLoad(source);
      if (!mayContainClassifiedImport && !mayContainDynamicModuleLoad) continue;
      const syntaxFindings = mayContainDynamicModuleLoad
        ? providerSourceBoundaryFindings(
            path,
            source,
            hostPolicies,
            importPolicies,
            nonProviderHostPolicies,
          )
        : { sdkPackages: [] };
      for (const dependency of new Set([
        ...sourceImports(path, source),
        ...syntaxFindings.sdkPackages,
      ])) {
        if (classifiedDependencies.has(dependency)) {
          imports.push({
            dependency,
            manifestPath,
            path,
            testOnly: testPath.test(path),
          });
        }
      }
    }
  }

  return {
    dependencyAllowances,
    importPolicies,
    imports: imports.sort((a, b) =>
      `${a.dependency}\0${a.path}`.localeCompare(`${b.dependency}\0${b.path}`),
    ),
    manifests,
  };
}

export function providerDependencyViolations(
  root,
  registry = loadProviderIntegrationRegistry(root),
  inventory = providerDependencyInventory(root, registry),
) {
  const violations = [];
  const nonProviderDependencies = new Set(registry.nonProviderDependencies);
  const classifiedDependencies = new Set(inventory.importPolicies.keys());
  const actualAllowances = new Set();

  for (const { path: manifestPath, manifest } of inventory.manifests) {
    for (const [dependencyClass, dependencies] of [
      ['dependencies', manifest.dependencies ?? {}],
      ['devDependencies', manifest.devDependencies ?? {}],
    ]) {
      for (const dependency of Object.keys(dependencies)) {
        if (dependency.startsWith('@tixkit/')) continue;
        const key = `${manifestPath}\0${dependency}\0${dependencyClass}`;
        if (classifiedDependencies.has(dependency)) {
          if (!inventory.dependencyAllowances.has(key)) {
            violations.push(`${manifestPath}: ${dependency} is not approved in ${dependencyClass}`);
          } else {
            actualAllowances.add(key);
          }
        } else if (!nonProviderDependencies.has(dependency)) {
          const dependencyScope = dependencyClass === 'dependencies' ? 'production' : 'development';
          violations.push(
            `${manifestPath}: unclassified ${dependencyScope} dependency ${dependency}; classify it or explicitly mark it non-provider`,
          );
        }
      }
    }
  }

  for (const [key, integrationIds] of inventory.dependencyAllowances) {
    if (!actualAllowances.has(key)) {
      violations.push(
        `${integrationIds.join(',')}: approved dependency is missing: ${key.replaceAll('\0', ' ')}`,
      );
    }
  }

  for (const imported of inventory.imports) {
    const policy = inventory.importPolicies.get(imported.dependency);
    if (!policy.paths.some((pattern) => pathMatchesPolicy(imported.path, pattern))) {
      violations.push(
        `${imported.path}: ${imported.dependency} import is outside registry-approved paths`,
      );
    }
    const manifest = inventory.manifests.find(
      ({ path }) => path === imported.manifestPath,
    )?.manifest;
    const declaredClass = Object.hasOwn(manifest?.dependencies ?? {}, imported.dependency)
      ? 'dependencies'
      : Object.hasOwn(manifest?.devDependencies ?? {}, imported.dependency)
        ? 'devDependencies'
        : undefined;
    if (!declaredClass) {
      violations.push(
        `${imported.path}: ${imported.dependency} is imported without a direct package dependency`,
      );
    }
  }

  for (const { path: manifestPath, manifest } of inventory.manifests) {
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      if (!classifiedDependencies.has(dependency)) continue;
      const usage = inventory.imports.filter(
        (entry) => entry.manifestPath === manifestPath && entry.dependency === dependency,
      );
      if (usage.length > 0 && usage.every(({ testOnly }) => testOnly)) {
        violations.push(
          `${manifestPath}: ${dependency} is production-scoped but imported only by tests`,
        );
      }
    }
  }
  return [...new Set(violations)].sort();
}

export function renderProviderDependencyInventory(
  root,
  registry,
  inventory = providerDependencyInventory(root, registry),
) {
  return inventory.imports.map(({ dependency, manifestPath, path, testOnly }) => {
    const integrations = registry.integrations.filter(({ allowedImports }) =>
      allowedImports.some(
        ({ package: packageName, paths }) =>
          packageName === dependency && paths.some((pattern) => pathMatchesPolicy(path, pattern)),
      ),
    );
    const manifest = inventory.manifests.find(
      ({ path: candidate }) => candidate === manifestPath,
    )?.manifest;
    const dependencyClass = Object.hasOwn(manifest?.dependencies ?? {}, dependency)
      ? 'dependencies'
      : Object.hasOwn(manifest?.devDependencies ?? {}, dependency)
        ? 'devDependencies'
        : 'undeclared';
    return {
      classifications: [...new Set(integrations.map(({ classification }) => classification))],
      dependency,
      dependencyClass,
      dependencyOwner: manifestPath,
      importPath: path,
      integrationIds: integrations.map(({ id }) => id),
      integrationOwners: [
        ...new Set(integrations.flatMap(({ ownerPackages }) => ownerPackages)),
      ].sort(),
      usage: testOnly ? 'test' : 'runtime',
    };
  });
}

export function buildProviderDependencyInventoryArtifact(
  root,
  registry,
  inventory = providerDependencyInventory(root, registry),
) {
  const repositoryRoot = resolve(root);
  return {
    $schema: './provider-dependency-inventory.schema.json',
    schemaVersion: 1,
    registry: {
      path: 'distribution/provider-integration-registry.json',
      sha256: sha256(
        readFileSync(resolve(repositoryRoot, 'distribution/provider-integration-registry.json')),
      ),
    },
    imports: renderProviderDependencyInventory(repositoryRoot, registry, inventory),
  };
}

export function validateProviderDependencyInventoryArtifact(root, artifact, registry, inventory) {
  const repositoryRoot = resolve(root);
  const schema = JSON.parse(
    readFileSync(resolve(repositoryRoot, PROVIDER_DEPENDENCY_INVENTORY_SCHEMA_PATH), 'utf8'),
  );
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  if (!validate(artifact)) {
    throw new Error(
      `Provider dependency inventory schema violations:\n${JSON.stringify(validate.errors, null, 2)}`,
    );
  }
  const expected = buildProviderDependencyInventoryArtifact(repositoryRoot, registry, inventory);
  if (canonicalJson(artifact) !== canonicalJson(expected)) {
    throw new Error(
      'Provider dependency inventory is stale or tampered; regenerate it with validate-provider-dependencies.mjs --write.',
    );
  }
  return artifact;
}

export function loadProviderDependencyInventoryArtifact(
  root,
  registry,
  artifactPath = PROVIDER_DEPENDENCY_INVENTORY_PATH,
  inventory,
) {
  const artifact = JSON.parse(readFileSync(resolve(root, artifactPath), 'utf8'));
  return validateProviderDependencyInventoryArtifact(root, artifact, registry, inventory);
}

export function writeProviderDependencyInventoryArtifact(root, outputPath, registry, inventory) {
  const artifact = buildProviderDependencyInventoryArtifact(root, registry, inventory);
  const absoluteOutputPath = resolve(root, outputPath);
  mkdirSync(dirname(absoluteOutputPath), { recursive: true });
  writeFileSync(absoluteOutputPath, canonicalJson(artifact), { mode: 0o644 });
  return artifact;
}
