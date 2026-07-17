import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';

export const PROVIDER_REGISTRY_PATH = 'distribution/provider-integration-registry.json';
export const PROVIDER_REGISTRY_SCHEMA_PATH =
  'distribution/provider-integration-registry.schema.json';
const HTTP_METHODS = ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'];

export function discoverWorkspacePackageManifests(root) {
  const repositoryRoot = resolve(root);
  const manifests = [];
  for (const workspaceRoot of ['apps', 'packages']) {
    const absoluteWorkspaceRoot = resolve(repositoryRoot, workspaceRoot);
    for (const entry of readdirSync(absoluteWorkspaceRoot, {
      withFileTypes: true,
    })) {
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

export function registryTransportExecutors(registry) {
  const executors = new Map();
  for (const executor of registry.transportExecutors) {
    const exports = executors.get(executor.path) ?? new Set();
    exports.add(executor.export);
    executors.set(executor.path, exports);
  }
  return executors;
}

export function registryTransportExecutorPolicies(registry) {
  return new Map(registry.transportExecutors.map((executor) => [executor.export, executor]));
}

export function registryNonProviderDynamicNetworkAllowances(registry) {
  return new Map(
    registry.nonProviderDynamicNetworkAllowances.map((allowance) => [allowance.path, allowance]),
  );
}

export function registryNetworkTargetAuthorities(registry) {
  return new Map(registry.networkTargetAuthorities.map((authority) => [authority.id, authority]));
}

export function registryNonNetworkReceiverTypes(registry) {
  return new Map(
    registry.nonNetworkReceiverTypes.map((receiver) => [
      `${receiver.path}#${receiver.typeName}`,
      receiver,
    ]),
  );
}

export function sourceSha256(source) {
  return createHash('sha256').update(source).digest('hex');
}

export function dynamicNetworkTargetAllowed(allowance, authority, target) {
  if (
    allowance === undefined ||
    authority === undefined ||
    target === undefined ||
    typeof target.authorityId !== 'string' ||
    target.authorityId !== authority.id ||
    !allowance.allowedAuthorityIds.includes(authority.id) ||
    typeof target.method !== 'string' ||
    typeof target.kind !== 'string' ||
    target.kind !== authority.kind ||
    typeof target.outputShape !== 'string' ||
    target.outputShape !== authority.outputShape ||
    target.mutated === true ||
    (Array.isArray(target.unknownConstituents) && target.unknownConstituents.length > 0) ||
    !Array.isArray(target.environmentVariables) ||
    !authority.allowedSinks.some((sink) => {
      if (sink.path !== allowance.path) return false;
      return target.method === '*'
        ? HTTP_METHODS.every((method) => sink.methods.includes(method))
        : sink.methods.includes(target.method);
    })
  ) {
    return false;
  }
  return target.environmentVariables.every((name) =>
    allowance.allowedEnvironmentVariables.includes(name),
  );
}

export function registryAllowsDynamicNetworkTarget(registry, path, target) {
  const authority =
    typeof target?.authorityId === 'string'
      ? registryNetworkTargetAuthorities(registry).get(target.authorityId)
      : undefined;
  return dynamicNetworkTargetAllowed(
    registryNonProviderDynamicNetworkAllowances(registry).get(path),
    authority,
    target,
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
  const transportExecutorPaths = new Set(registry.transportExecutors.map(({ path }) => path));
  const authorityIds = new Set();
  const authorityIssuerTuples = new Set();

  const sortedUnique = (values) =>
    values.length === new Set(values).size &&
    values.every((value, index) => index === 0 || values[index - 1].localeCompare(value) < 0);

  if (!sortedUnique(registry.dependencyAuditPackages)) {
    violations.push('dependencyAuditPackages must be unique and sorted');
  }
  if (!sortedUnique(registry.nonProviderDependencies)) {
    violations.push('nonProviderDependencies must be unique and sorted');
  }
  const transportExecutorKeys = registry.transportExecutors.map(
    (executor) => `${executor.path}#${executor.export}`,
  );
  if (!sortedUnique(transportExecutorKeys)) {
    violations.push('transportExecutors must be unique and sorted by path and export');
  }
  for (const executor of registry.transportExecutors) {
    if (executor.path.endsWith('/**')) {
      violations.push(`transport executor must target an exact source file: ${executor.path}`);
    }
    if (checkPaths && !existsSync(resolve(root, executor.path))) {
      violations.push(`transport executor source does not exist: ${executor.path}`);
    } else if (checkPaths) {
      const source = readFileSync(resolve(root, executor.path), 'utf8');
      const escapedExport = executor.export.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      if (
        !new RegExp(`\\bexport\\s+(?:async\\s+)?function\\s+${escapedExport}\\b`, 'u').test(source)
      ) {
        violations.push(
          `transport executor export does not exist: ${executor.path}#${executor.export}`,
        );
      }
    }
    if (!sortedUnique(executor.allowedCallPaths)) {
      violations.push(
        `transport executor allowedCallPaths must be unique and sorted: ${executor.export}`,
      );
    }
    if (!sortedUnique(executor.allowedAuthorityIds)) {
      violations.push(
        `transport executor allowedAuthorityIds must be unique and sorted: ${executor.export}`,
      );
    }
    for (const authorityId of executor.allowedAuthorityIds) {
      if (!registry.networkTargetAuthorities.some(({ id }) => id === authorityId)) {
        violations.push(
          `transport executor references unknown authority: ${executor.export}#${authorityId}`,
        );
      }
    }
    for (const callPath of executor.allowedCallPaths) {
      if (callPath.endsWith('/**')) {
        violations.push(`transport executor caller must target an exact source file: ${callPath}`);
      }
      if (checkPaths && !existsSync(resolve(root, callPath))) {
        violations.push(`transport executor caller source does not exist: ${callPath}`);
      }
    }
  }
  const authorityKeys = registry.networkTargetAuthorities.map(({ id }) => id);
  if (!sortedUnique(authorityKeys)) {
    violations.push('networkTargetAuthorities must have unique sorted ids');
  }
  for (const authority of registry.networkTargetAuthorities) {
    if (authorityIds.has(authority.id)) {
      violations.push(`duplicate network target authority id: ${authority.id}`);
    }
    authorityIds.add(authority.id);
    const issuerTuple =
      authority.issuer.type === 'workspace-export'
        ? `workspace:${authority.issuer.path}#${authority.issuer.export}`
        : `package:${authority.issuer.package}#${authority.issuer.export}`;
    if (authorityIssuerTuples.has(issuerTuple)) {
      violations.push(`duplicate network target authority issuer: ${issuerTuple}`);
    }
    authorityIssuerTuples.add(issuerTuple);

    if (authority.issuer.type === 'workspace-export') {
      if (authority.issuer.path.includes('*')) {
        violations.push(`network target authority issuer must be exact: ${authority.id}`);
      } else if (checkPaths && !existsSync(resolve(root, authority.issuer.path))) {
        violations.push(`network target authority issuer does not exist: ${authority.issuer.path}`);
      } else if (checkPaths) {
        const source = readFileSync(resolve(root, authority.issuer.path), 'utf8');
        if (sourceSha256(source) !== authority.issuer.sha256) {
          violations.push(`network target authority issuer digest is stale: ${authority.id}`);
        }
        const escapedExport = authority.issuer.export.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
        if (
          !new RegExp(
            `\\bexport\\s+(?:async\\s+)?(?:function|class|const|let|var)\\s+${escapedExport}\\b`,
            'u',
          ).test(source) &&
          !new RegExp(`\\bexport\\s*\\{[^}]*\\b(?:as\\s+)?${escapedExport}\\b[^}]*\\}`, 'u').test(
            source,
          )
        ) {
          violations.push(
            `network target authority export does not exist: ${authority.issuer.path}#${authority.issuer.export}`,
          );
        }
      }
    }

    const sinkPaths = authority.allowedSinks.map(({ path }) => path);
    if (!sortedUnique(sinkPaths)) {
      violations.push(`network target authority sinks must be unique and sorted: ${authority.id}`);
    }
    for (const sink of authority.allowedSinks) {
      if (sink.path.includes('*')) {
        violations.push(`network target authority sink must be exact: ${authority.id}`);
      }
      if (!sortedUnique(sink.methods)) {
        violations.push(
          `network target authority methods must be unique and sorted: ${authority.id}#${sink.path}`,
        );
      }
      if (checkPaths && !existsSync(resolve(root, sink.path))) {
        violations.push(`network target authority sink does not exist: ${sink.path}`);
      }
    }
    if (!sortedUnique(authority.runtimeEvidencePaths)) {
      violations.push(
        `network target authority evidence must be unique and sorted: ${authority.id}`,
      );
    }
    for (const evidencePath of authority.runtimeEvidencePaths) {
      if (evidencePath.includes('*')) {
        violations.push(`network target authority evidence must be exact: ${authority.id}`);
      }
      if (checkPaths && !existsSync(resolve(root, evidencePath))) {
        violations.push(`network target authority evidence does not exist: ${evidencePath}`);
      }
    }
  }
  const receiverKeys = registry.nonNetworkReceiverTypes.map(
    ({ id, path, typeName }) => `${id}:${path}#${typeName}`,
  );
  if (!sortedUnique(receiverKeys)) {
    violations.push('nonNetworkReceiverTypes must have unique sorted ids and identities');
  }
  for (const receiver of registry.nonNetworkReceiverTypes) {
    if (!sortedUnique(receiver.allowedMethods)) {
      violations.push(`non-network receiver methods must be unique and sorted: ${receiver.id}`);
    }
    if (!sortedUnique(receiver.runtimeEvidencePaths)) {
      violations.push(`non-network receiver evidence must be unique and sorted: ${receiver.id}`);
    }
    const absolutePath = resolve(root, receiver.path);
    if (checkPaths && !existsSync(absolutePath)) {
      violations.push(`non-network receiver source does not exist: ${receiver.path}`);
      continue;
    }
    if (checkPaths) {
      const source = readFileSync(absolutePath, 'utf8');
      if (sourceSha256(source) !== receiver.sha256) {
        violations.push(`non-network receiver digest is stale: ${receiver.id}`);
      }
      const escapedType = receiver.typeName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      if (
        !new RegExp(`\\b(?:interface|type)\\s+${escapedType}\\b`, 'u').test(source) &&
        !new RegExp(`\\bimport\\s*\\{[^}]*\\b${escapedType}\\b[^}]*\\}\\s*from\\b`, 'u').test(
          source,
        )
      ) {
        violations.push(
          `non-network receiver type does not exist: ${receiver.path}#${receiver.typeName}`,
        );
      }
    }
    for (const evidencePath of receiver.runtimeEvidencePaths) {
      if (checkPaths && !existsSync(resolve(root, evidencePath))) {
        violations.push(`non-network receiver evidence does not exist: ${evidencePath}`);
      }
    }
  }
  const dynamicNetworkPaths = registry.nonProviderDynamicNetworkAllowances.map(({ path }) => path);
  if (!sortedUnique(dynamicNetworkPaths)) {
    violations.push('nonProviderDynamicNetworkAllowances must be unique and sorted by path');
  }
  for (const path of dynamicNetworkPaths) {
    if (path.endsWith('/**')) {
      violations.push(`non-provider dynamic network allowance must target an exact file: ${path}`);
    }
    if (checkPaths && !existsSync(resolve(root, path))) {
      violations.push(`non-provider dynamic network allowance does not exist: ${path}`);
    }
  }
  for (const allowance of registry.nonProviderDynamicNetworkAllowances) {
    if (!sortedUnique(allowance.allowedAuthorityIds)) {
      violations.push(`non-provider authority ids must be unique and sorted: ${allowance.path}`);
    }
    if (!sortedUnique(allowance.allowedEnvironmentVariables)) {
      violations.push(
        `non-provider environment variables must be unique and sorted: ${allowance.path}`,
      );
    }
    for (const authorityId of allowance.allowedAuthorityIds) {
      const authority = registry.networkTargetAuthorities.find(({ id }) => id === authorityId);
      if (!authority) {
        violations.push(
          `non-provider allowance references unknown authority: ${allowance.path}#${authorityId}`,
        );
      } else if (!authority.allowedSinks.some(({ path }) => path === allowance.path)) {
        violations.push(
          `non-provider allowance is not an authority sink: ${allowance.path}#${authorityId}`,
        );
      }
    }
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
    for (const path of integration.allowedHostPaths) {
      if (!transportExecutorPaths.has(path)) {
        violations.push(
          `${integration.id}: provider network execution must target an exact transport executor: ${path}`,
        );
      }
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
