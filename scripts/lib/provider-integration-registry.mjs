import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';

export const PROVIDER_REGISTRY_PATH = 'distribution/provider-integration-registry.json';
export const PROVIDER_REGISTRY_SCHEMA_PATH =
  'distribution/provider-integration-registry.schema.json';

export function discoverWorkspacePackageManifests(root) {
  const repositoryRoot = resolve(root);
  const manifests = [];
  for (const workspaceRoot of ['apps', 'packages']) {
    const absoluteWorkspaceRoot = resolve(repositoryRoot, workspaceRoot);
    for (const entry of readdirSync(absoluteWorkspaceRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = join(absoluteWorkspaceRoot, entry.name, 'package.json');
      if (existsSync(manifest)) {
        manifests.push(relative(repositoryRoot, manifest).replaceAll('\\', '/'));
      }
    }
  }
  return manifests.sort();
}

export function pathMatchesPolicy(path, pattern) {
  if (pattern.endsWith('/**')) return path.startsWith(pattern.slice(0, -2));
  return path === pattern;
}

export function registrySdkPackages(registry) {
  return new Set(
    registry.integrations.flatMap(({ allowedImports }) =>
      allowedImports.map(({ package: packageName }) => packageName),
    ),
  );
}

export function registryHostPolicies(registry) {
  const policies = new Map();
  for (const integration of registry.integrations) {
    for (const host of integration.providerHosts ?? []) {
      policies.set(host, {
        integrationId: integration.id,
        provider: integration.provider,
        allowedHostPaths: integration.allowedHostPaths,
        allowedNonExecutionHostPaths: integration.allowedNonExecutionHostPaths,
      });
    }
  }
  return policies;
}

export function registryNonProviderHostPolicies(registry) {
  return new Map(
    (registry.nonProviderHostAllowances ?? []).map(({ host, allowedExecutionPaths, rationale }) => [
      host,
      { allowedExecutionPaths, rationale },
    ]),
  );
}

export function registryImportPolicies(registry) {
  const policies = new Map();
  for (const integration of registry.integrations) {
    for (const allowance of integration.allowedImports) {
      const current = policies.get(allowance.package) ?? {
        integrationIds: [],
        paths: [],
      };
      current.integrationIds.push(integration.id);
      current.paths.push(...allowance.paths);
      policies.set(allowance.package, current);
    }
  }
  return policies;
}

export function providerIntegrationRegistryViolations(registry, root, { checkPaths = true } = {}) {
  const violations = [];
  const ids = new Set();
  const hosts = new Map();
  const auditedPackages = new Set(registry.dependencyAuditPackages);
  const nonProviderDependencies = new Set(registry.nonProviderDependencies);

  const sortedUnique = (values) =>
    values.length === new Set(values).size &&
    values.every((value, index) => index === 0 || values[index - 1].localeCompare(value) < 0);

  if (!sortedUnique(registry.dependencyAuditPackages)) {
    violations.push('dependencyAuditPackages must be unique and sorted');
  }
  if (!sortedUnique(registry.nonProviderDependencies)) {
    violations.push('nonProviderDependencies must be unique and sorted');
  }

  for (const packagePath of registry.dependencyAuditPackages) {
    if (checkPaths && !existsSync(resolve(root, packagePath))) {
      violations.push(`audited package manifest does not exist: ${packagePath}`);
    }
  }
  if (checkPaths) {
    const discoveredManifests = discoverWorkspacePackageManifests(root);
    if (JSON.stringify(registry.dependencyAuditPackages) !== JSON.stringify(discoveredManifests)) {
      const missing = discoveredManifests.filter((path) => !auditedPackages.has(path));
      const stale = registry.dependencyAuditPackages.filter(
        (path) => !discoveredManifests.includes(path),
      );
      if (missing.length > 0) {
        violations.push(`dependency audit omits workspace manifests: ${missing.join(', ')}`);
      }
      if (stale.length > 0) {
        violations.push(`dependency audit contains stale workspace manifests: ${stale.join(', ')}`);
      }
    }
  }

  for (const integration of registry.integrations) {
    if (ids.has(integration.id)) violations.push(`duplicate integration id: ${integration.id}`);
    ids.add(integration.id);

    for (const owner of integration.ownerPackages) {
      if (!auditedPackages.has(owner)) {
        violations.push(`${integration.id}: owner package is not dependency-audited: ${owner}`);
      }
    }

    if (integration.classification === 'direct-http') {
      if (integration.providerHosts.length === 0) {
        violations.push(`${integration.id}: direct-http integration must declare a provider host`);
      }
      if (integration.allowedImports.length > 0 || integration.allowedDependencies.length > 0) {
        violations.push(`${integration.id}: direct-http integration must not declare a vendor SDK`);
      }
    } else if (
      integration.allowedImports.length === 0 ||
      integration.allowedDependencies.length === 0
    ) {
      violations.push(`${integration.id}: SDK integration must declare imports and dependencies`);
    }

    for (const host of integration.providerHosts) {
      const existing = hosts.get(host);
      if (existing)
        violations.push(
          `provider host ${host} is classified by both ${existing} and ${integration.id}`,
        );
      hosts.set(host, integration.id);
    }

    const importedPackages = new Set(
      integration.allowedImports.map(({ package: packageName }) => packageName),
    );
    const dependencyPackages = new Set(
      integration.allowedDependencies.map(({ package: packageName }) => packageName),
    );
    for (const packageName of importedPackages) {
      if (!dependencyPackages.has(packageName)) {
        violations.push(
          `${integration.id}: imported SDK lacks a dependency allowance: ${packageName}`,
        );
      }
    }
    for (const packageName of dependencyPackages) {
      if (!importedPackages.has(packageName)) {
        violations.push(
          `${integration.id}: SDK dependency lacks an import allowance: ${packageName}`,
        );
      }
      if (nonProviderDependencies.has(packageName)) {
        violations.push(
          `${integration.id}: classified SDK is also listed as non-provider: ${packageName}`,
        );
      }
    }

    for (const allowance of integration.allowedDependencies) {
      if (!auditedPackages.has(allowance.packagePath)) {
        violations.push(
          `${integration.id}: dependency allowance targets an unaudited manifest: ${allowance.packagePath}`,
        );
      }
    }

    for (const path of [
      ...integration.allowedHostPaths,
      ...integration.allowedNonExecutionHostPaths,
      ...integration.allowedImports.flatMap(({ paths }) => paths),
    ]) {
      const pathBase = path.endsWith('/**') ? path.slice(0, -3) : path;
      if (checkPaths && !existsSync(resolve(root, pathBase))) {
        violations.push(`${integration.id}: allowed path does not exist: ${path}`);
      }
    }
  }

  for (const allowance of registry.nonProviderHostAllowances) {
    if (hosts.has(allowance.host)) {
      violations.push(`non-provider host duplicates a provider classification: ${allowance.host}`);
    }
    hosts.set(allowance.host, 'non-provider');
    for (const path of allowance.allowedExecutionPaths) {
      const pathBase = path.endsWith('/**') ? path.slice(0, -3) : path;
      if (checkPaths && !existsSync(resolve(root, pathBase))) {
        violations.push(`non-provider host allowed path does not exist: ${path}`);
      }
    }
  }

  if (
    !registry.integrations.every(
      ({ id }, index) => index === 0 || registry.integrations[index - 1].id.localeCompare(id) < 0,
    )
  ) {
    violations.push('integrations must be sorted by id');
  }
  return violations.sort();
}

export function validateProviderIntegrationRegistry(registry, schema, root, options) {
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  if (!validate(registry)) {
    throw new Error(
      `Provider integration registry schema violations:\n${JSON.stringify(validate.errors, null, 2)}`,
    );
  }
  const violations = providerIntegrationRegistryViolations(registry, root, options);
  if (violations.length > 0) {
    throw new Error(`Provider integration registry violations:\n${violations.join('\n')}`);
  }
  return registry;
}

export function loadProviderIntegrationRegistry(root, options) {
  const registry = JSON.parse(readFileSync(resolve(root, PROVIDER_REGISTRY_PATH), 'utf8'));
  const schema = JSON.parse(readFileSync(resolve(root, PROVIDER_REGISTRY_SCHEMA_PATH), 'utf8'));
  return validateProviderIntegrationRegistry(registry, schema, root, options);
}
