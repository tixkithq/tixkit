import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
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
  /(?:^|\/)(?:\.dart_tool|\.expo|\.next|\.output|\.turbo|build|coverage|dist|generated|node_modules|out|test-results)(?:\/|$)/u;
const testPath = /(?:^|\/)(?:__tests__\/|[^/]+\.(?:integration\.)?(?:spec|test)\.)/u;

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
      const syntaxFindings = sourceMayContainClassifiedDependency(source, classifiedDependencies)
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
          imports.push({ dependency, manifestPath, path, testOnly: testPath.test(path) });
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
) {
  const inventory = providerDependencyInventory(root, registry);
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

export function renderProviderDependencyInventory(root, registry) {
  const inventory = providerDependencyInventory(root, registry);
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
