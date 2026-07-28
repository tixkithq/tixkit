import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve, relative, sep } from 'node:path';
import { jsonSchemaViolations } from './public-distribution.mjs';

export const REQUIRED_CAPABILITY_DECISIONS = Object.freeze([
  'apple-messages-for-business',
  'generic-messaging-contracts',
  'managed-email-operations',
  'managed-routing-intelligence',
  'managed-sms-operations',
  'opencore-email-sdk-adapter',
  'plivo-sms-adapter',
  'rcs-messaging',
  'resend-email-adapter',
  'smtp-email-adapter',
  'telnyx-sms-adapter',
  'twilio-sms-adapter',
  'vonage-sms-adapter',
  'whatsapp-messaging',
]);

function acceptedDecision(
  classification,
  lifecycle,
  availability,
  path,
  symbols,
  credentialCustody,
  portability,
) {
  return Object.freeze({
    classification,
    lifecycle,
    availability: Object.freeze(availability),
    extensionContract: Object.freeze({
      status: 'versioned',
      version: 'tixkit.messaging-provider/v1',
      packageBoundary: Object.freeze({
        packageName: '@tixkit/domain',
        exportPath: './messaging',
        symbol: 'registerMessagingProviderExtension',
      }),
    }),
    publicBoundary: Object.freeze({ path, symbols: Object.freeze(symbols) }),
    obligations: Object.freeze({
      credentialCustody,
      plaintextCredentialsPortable: false,
      portability,
      destinationRebinding: 'required',
      consent: 'required',
      suppression: 'required',
      webhooks: 'required',
      retries: 'required',
      idempotency: 'required',
      audit: 'required',
    }),
  });
}

function pendingContractDecision(
  classification,
  lifecycle,
  availability,
  missingContractReason,
  credentialCustody,
  portability,
) {
  return Object.freeze({
    classification,
    lifecycle,
    availability: Object.freeze(availability),
    extensionContract: Object.freeze({
      status: 'not-yet-versioned',
      missingContractReason,
    }),
    obligations: Object.freeze({
      credentialCustody,
      plaintextCredentialsPortable: false,
      portability,
      destinationRebinding: 'required',
      consent: 'required',
      suppression: 'required',
      webhooks: 'required',
      retries: 'required',
      idempotency: 'required',
      audit: 'required',
    }),
  });
}

const availableEverywhere = {
  cloud: 'available',
  platformApi: 'available',
  selfHosted: 'available',
};
const plannedEverywhere = { cloud: 'planned', platformApi: 'planned', selfHosted: 'planned' };
const plannedManaged = { cloud: 'planned', platformApi: 'planned', selfHosted: 'unavailable' };
const missingRichChannelContract =
  'A public rich-channel extension contract has not been published.';

export const EXPECTED_CAPABILITY_DECISIONS = Object.freeze({
  'apple-messages-for-business': pendingContractDecision(
    'managed-provider-service',
    'planned',
    plannedManaged,
    missingRichChannelContract,
    'managed-cloud',
    'contract-metadata',
  ),
  'generic-messaging-contracts': acceptedDecision(
    'shared-core',
    'stable',
    availableEverywhere,
    'packages/domain/src/messaging/index.ts',
    ['EmailTransport', 'SmsTransport'],
    'caller-or-operator',
    'contract-metadata',
  ),
  'managed-email-operations': acceptedDecision(
    'managed-provider-service',
    'planned',
    plannedManaged,
    'packages/domain/src/messaging/index.ts',
    ['EmailTransport'],
    'managed-cloud',
    'configuration-only',
  ),
  'managed-routing-intelligence': acceptedDecision(
    'managed-intelligence',
    'planned',
    plannedManaged,
    'packages/domain/src/messaging/provider-extensions.ts',
    ['MessagingProviderRouteSelector'],
    'managed-cloud',
    'contract-metadata',
  ),
  'managed-sms-operations': acceptedDecision(
    'managed-provider-service',
    'planned',
    plannedManaged,
    'packages/domain/src/messaging/index.ts',
    ['SmsTransport'],
    'managed-cloud',
    'configuration-only',
  ),
  'opencore-email-sdk-adapter': acceptedDecision(
    'public-provider-adapter',
    'planned',
    plannedEverywhere,
    'packages/email-transport/src/index.ts',
    ['OpenCoreEmailSdkTransport'],
    'caller-or-operator',
    'configuration-only',
  ),
  'plivo-sms-adapter': acceptedDecision(
    'public-provider-adapter',
    'planned',
    plannedEverywhere,
    'packages/email-transport/src/index.ts',
    ['PlivoSmsTransport'],
    'caller-or-operator',
    'configuration-only',
  ),
  'rcs-messaging': pendingContractDecision(
    'managed-provider-service',
    'planned',
    plannedManaged,
    missingRichChannelContract,
    'managed-cloud',
    'contract-metadata',
  ),
  'resend-email-adapter': acceptedDecision(
    'public-provider-adapter',
    'stable',
    availableEverywhere,
    'packages/email-transport/src/index.ts',
    ['ResendEmailTransport'],
    'caller-or-operator',
    'configuration-only',
  ),
  'smtp-email-adapter': acceptedDecision(
    'public-provider-adapter',
    'stable',
    availableEverywhere,
    'packages/email-transport/src/index.ts',
    ['SmtpEmailTransport'],
    'caller-or-operator',
    'configuration-only',
  ),
  'telnyx-sms-adapter': acceptedDecision(
    'public-provider-adapter',
    'stable',
    availableEverywhere,
    'packages/email-transport/src/index.ts',
    ['TelnyxSmsTransport'],
    'caller-or-operator',
    'configuration-only',
  ),
  'twilio-sms-adapter': acceptedDecision(
    'public-provider-adapter',
    'stable',
    availableEverywhere,
    'packages/email-transport/src/index.ts',
    ['TwilioSmsTransport'],
    'caller-or-operator',
    'configuration-only',
  ),
  'vonage-sms-adapter': acceptedDecision(
    'public-provider-adapter',
    'planned',
    plannedEverywhere,
    'packages/email-transport/src/index.ts',
    ['VonageSmsTransport'],
    'caller-or-operator',
    'configuration-only',
  ),
  'whatsapp-messaging': pendingContractDecision(
    'managed-provider-service',
    'planned',
    plannedManaged,
    missingRichChannelContract,
    'managed-cloud',
    'contract-metadata',
  ),
});

const managedClassifications = new Set(['managed-provider-service', 'managed-intelligence']);
const forbiddenPrivateReferences =
  /(?:tixkit-cloud|@tixkit\/managed|managed[/\\]+src|private[/\\]+src)/iu;

function isInsideRoot(root, path) {
  const candidate = resolve(root, path);
  const location = relative(resolve(root), candidate);
  return location !== '..' && !location.startsWith(`..${sep}`) && !location.startsWith('/');
}

function publicRoots(manifest) {
  return [
    ...manifest.source.rootFiles,
    ...manifest.source.rootDirectories,
    ...manifest.source.applications,
    ...manifest.source.packages,
    ...manifest.source.documentation,
  ];
}

function isPublicPath(path, roots) {
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

function exportedSymbolPattern(symbol) {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(
    `(?:export\\s+(?:(?:declare|abstract)\\s+)?(?:class|function|const|let|var|interface|type|enum)\\s+${escaped}\\b|export\\s*\\{[^}]*\\b${escaped}\\b[^}]*\\})`,
    'u',
  );
}

function packageExportTarget(definition) {
  if (typeof definition === 'string') return definition;
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) return undefined;
  return definition.import ?? definition.default;
}

function sourceEntrypoint(root, packagePath, target) {
  if (typeof target !== 'string' || !/^\.\/dist\/.+\.js$/u.test(target)) return undefined;
  const source = target.replace(/^\.\/dist\//u, './src/').replace(/\.js$/u, '.ts');
  const packageRoot = resolve(root, packagePath);
  const candidate = resolve(packageRoot, source);
  const location = relative(packageRoot, candidate);
  if (location === '..' || location.startsWith(`..${sep}`) || location.startsWith('/')) {
    return undefined;
  }
  return candidate;
}

function moduleExportsSymbol(modulePath, symbol, packageRoot, visited = new Set()) {
  if (visited.has(modulePath)) return false;
  visited.add(modulePath);
  const metadata = statSync(modulePath, { throwIfNoEntry: false });
  if (!metadata?.isFile()) return false;
  const source = readFileSync(modulePath, 'utf8');
  if (exportedSymbolPattern(symbol).test(source)) return true;
  for (const match of source.matchAll(/export\s*\*\s*from\s*['"]([^'"]+)['"]/gu)) {
    const specifier = match[1];
    if (!specifier?.startsWith('.')) continue;
    const candidate = resolve(dirname(modulePath), specifier.replace(/\.js$/u, '.ts'));
    const location = relative(packageRoot, candidate);
    if (location === '..' || location.startsWith(`..${sep}`) || location.startsWith('/')) continue;
    if (moduleExportsSymbol(candidate, symbol, packageRoot, visited)) return true;
  }
  return false;
}

export function publishedPackageBoundaryViolations(root, publicDistribution, boundary) {
  const violations = [];
  const releasePackages = publicDistribution.release.packages.flatMap(({ path }) => {
    const manifestPath = resolve(root, path, 'package.json');
    if (!statSync(manifestPath, { throwIfNoEntry: false })?.isFile()) return [];
    const packageManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    return packageManifest.name === boundary.packageName ? [{ path, packageManifest }] : [];
  });
  if (releasePackages.length !== 1) {
    return ['versioned extension contract package is not uniquely present in the public release'];
  }
  const publishedPackage = releasePackages[0];
  if (publishedPackage.packageManifest.private === true) {
    violations.push('versioned extension contract package must be publishable');
  }
  const target = packageExportTarget(
    publishedPackage.packageManifest.exports?.[boundary.exportPath],
  );
  if (!target) {
    violations.push(
      `versioned extension contract package export is missing: ${boundary.exportPath}`,
    );
    return violations;
  }
  const packageRoot = resolve(root, publishedPackage.path);
  const entrypoint = sourceEntrypoint(root, publishedPackage.path, target);
  if (!entrypoint || !moduleExportsSymbol(entrypoint, boundary.symbol, packageRoot)) {
    violations.push(
      `versioned extension contract package entrypoint does not export: ${boundary.exportPath}#${boundary.symbol}`,
    );
  }
  return violations;
}

function formatAvailability(availability) {
  return `Cloud: ${availability.cloud}; Platform API: ${availability.platformApi}; Self-Hosted: ${availability.selfHosted}`;
}

function formatObligations(obligations) {
  return [
    `credentials=${obligations.credentialCustody}`,
    `plaintext-portable=${String(obligations.plaintextCredentialsPortable)}`,
    `portability=${obligations.portability}`,
    `rebind=${obligations.destinationRebinding}`,
    `consent=${obligations.consent}`,
    `suppression=${obligations.suppression}`,
    `webhooks=${obligations.webhooks}`,
    `retries=${obligations.retries}`,
    `idempotency=${obligations.idempotency}`,
    `audit=${obligations.audit}`,
  ].join('; ');
}

function formatExtensionContract(capability) {
  if (capability.extensionContract.status === 'not-yet-versioned') {
    return `Not yet versioned: ${capability.extensionContract.missingContractReason ?? 'Missing contract reason.'}`;
  }
  if (!capability.publicBoundary) return 'Versioned: missing public boundary';
  const published = capability.extensionContract.packageBoundary;
  const packageExport = `${published.packageName}${published.exportPath.slice(1)}`;
  return `Versioned: \`${capability.extensionContract.version}\` via \`${packageExport}#${published.symbol}\`; implementation: \`${capability.publicBoundary.path}#${capability.publicBoundary.symbols.join(',')}\``;
}

function normalizeDocumentation(documentation) {
  return documentation
    .split('\n')
    .map((line) => {
      if (!line.startsWith('|')) return line;
      const cells = line
        .slice(1, -1)
        .split('|')
        .map((cell) => {
          const value = cell.trim();
          return /^-+$/u.test(value) ? '---' : value;
        });
      return `| ${cells.join(' | ')} |`;
    })
    .join('\n');
}

function conditionalSchemaViolations(registry) {
  const violations = [];
  for (const [index, capability] of registry.capabilities.entries()) {
    const path = `$.capabilities[${index}]`;
    const status = capability.extensionContract.status;
    if (status === 'versioned') {
      if (!capability.publicBoundary)
        violations.push(
          `${path}.publicBoundary is required by schema when extensionContract.status is versioned`,
        );
      if (capability.extensionContract.missingContractReason !== undefined)
        violations.push(
          `${path}.extensionContract.missingContractReason is forbidden by schema when extensionContract.status is versioned`,
        );
      if (!capability.extensionContract.version)
        violations.push(
          `${path}.extensionContract.version is required by schema when extensionContract.status is versioned`,
        );
      if (!capability.extensionContract.packageBoundary)
        violations.push(
          `${path}.extensionContract.packageBoundary is required by schema when extensionContract.status is versioned`,
        );
      continue;
    }
    if (status !== 'not-yet-versioned') continue;
    if (capability.publicBoundary !== undefined)
      violations.push(
        `${path}.publicBoundary is forbidden by schema when extensionContract.status is not-yet-versioned`,
      );
    if (!capability.extensionContract.missingContractReason?.trim())
      violations.push(
        `${path}.extensionContract.missingContractReason is required by schema when extensionContract.status is not-yet-versioned`,
      );
    if (capability.extensionContract.version !== undefined)
      violations.push(
        `${path}.extensionContract.version is forbidden by schema when extensionContract.status is not-yet-versioned`,
      );
    if (capability.extensionContract.packageBoundary !== undefined)
      violations.push(
        `${path}.extensionContract.packageBoundary is forbidden by schema when extensionContract.status is not-yet-versioned`,
      );
    if (capability.lifecycle !== 'planned')
      violations.push(
        `${path}.lifecycle must equal "planned" by schema when extensionContract.status is not-yet-versioned`,
      );
    for (const adoptionPath of ['cloud', 'platformApi'])
      if (capability.availability[adoptionPath] === 'available')
        violations.push(
          `${path}.availability.${adoptionPath} must not equal "available" by schema when extensionContract.status is not-yet-versioned`,
        );
    if (capability.availability.selfHosted !== 'unavailable')
      violations.push(
        `${path}.availability.selfHosted must equal "unavailable" by schema when extensionContract.status is not-yet-versioned`,
      );
  }
  return violations;
}

export function renderCapabilityRegistryDocumentation(registry) {
  const rows = registry.capabilities
    .map(
      (capability) =>
        `| \`${capability.id}\` | ${capability.name} | ${capability.classification} | ${capability.lifecycle} | ${formatAvailability(capability.availability)} | ${formatExtensionContract(capability)} | ${formatObligations(capability.obligations)} | ${capability.notes} |`,
    )
    .join('\n');

  return `---
title: Capabilities and integrations
description: Authoritative availability and public-boundary registry for Tixkit integrations.
audience:
  - developer
  - self-hoster
  - contributor
product_area: platform
content_type: reference
status: beta
owner: platform-integrations
last_verified: 2026-07-15
prerequisites: []
related:
  - /operators/messaging
  - /platform
---

# Capabilities and integrations

This page is generated from the public capability registry. “Available” describes an implemented public contract or adapter, not a promise that Tixkit Cloud is generally available. Managed services are shown only as private beta or planned. Cloud, Platform API, and Self-Hosted availability are independent decisions.

| ID | Capability | Classification | Lifecycle | Availability | Extension contract | Delivery and portability obligations | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
${rows}

## Contract rules

- Shared behavior and provider adapters cross the repository boundary only through the named public symbols above. Cloud consumes immutable public artifacts and does not copy or patch shared source.
- Credentials, signing keys, and provider tokens are never included in portable bundles. Configuration and contract metadata require destination rebinding where shown.
- Consent, suppression, webhook verification, bounded retries, idempotency, and audit requirements are mandatory wherever marked required; a managed service does not weaken them.
- Apple Messages for Business, RCS, and WhatsApp are planned managed services. They are unavailable to Self-Hosted deployments until Tixkit publishes a versioned rich-channel extension contract.
- The schema permits a pending managed contract to enter private beta on Cloud or Platform API without implying a public extension contract. Every current rich-channel decision remains pinned to planned until this registry records an accepted promotion.
- The optional exact request-ID incident sink is wired only through Tixkit's built-in direct-HTTP messaging adapters. \`tixkit.messaging-provider/v1\` custom extension factories do not receive this privileged callback. Extension operators must keep provider diagnostics hash-only and must not return exact IDs in transport results, errors, logs, traces, or Temporal payloads; a future versioned contract is required before custom extensions can participate in encrypted exact-ID capture.
- Managed routing intelligence may remain private, but execution must use the public provider-routing boundary and remain auditable.
`;
}

export function capabilityRegistryViolations(registry, root, publicDistribution) {
  const violations = [];
  const schema = JSON.parse(
    readFileSync(resolve(root, 'distribution/capability-registry.schema.json'), 'utf8'),
  );
  violations.push(...jsonSchemaViolations(registry, schema));
  if (violations.length > 0) return violations;
  violations.push(...conditionalSchemaViolations(registry));
  if (violations.length > 0) return violations;

  const ids = registry.capabilities.map(({ id }) => id);
  const sortedIds = [...ids].sort();
  if (new Set(ids).size !== ids.length) violations.push('capability IDs must be unique');
  if (ids.some((id, index) => id !== sortedIds[index]))
    violations.push('capability IDs must be sorted lexicographically');

  const missing = REQUIRED_CAPABILITY_DECISIONS.filter((id) => !ids.includes(id));
  const unexpected = ids.filter((id) => !REQUIRED_CAPABILITY_DECISIONS.includes(id));
  for (const id of missing) violations.push(`required capability decision is missing: ${id}`);
  for (const id of unexpected) violations.push(`unsupported capability decision: ${id}`);

  for (const capability of registry.capabilities) {
    const expected = EXPECTED_CAPABILITY_DECISIONS[capability.id];
    if (!expected) continue;
    for (const field of Object.keys(expected))
      if (JSON.stringify(capability[field]) !== JSON.stringify(expected[field]))
        violations.push(`${capability.id}: accepted ${field} decision drifted`);
  }

  const roots = publicRoots(publicDistribution);
  for (const capability of registry.capabilities) {
    const managed = managedClassifications.has(capability.classification);
    const contractStatus = capability.extensionContract.status;
    const boundary = capability.publicBoundary;
    if (contractStatus === 'versioned') {
      const publishedBoundary = capability.extensionContract.packageBoundary;
      if (publishedBoundary)
        for (const violation of publishedPackageBoundaryViolations(
          root,
          publicDistribution,
          publishedBoundary,
        ))
          violations.push(`${capability.id}: ${violation}`);
      if (!boundary) {
        violations.push(
          `${capability.id}: versioned extension contract requires a public boundary`,
        );
      } else if (!isInsideRoot(root, boundary.path)) {
        violations.push(`${capability.id}: public boundary escapes the repository`);
      } else {
        if (!isPublicPath(boundary.path, roots))
          violations.push(`${capability.id}: public boundary is not in the public distribution`);
        const metadata = statSync(resolve(root, boundary.path), { throwIfNoEntry: false });
        if (!metadata?.isFile()) {
          violations.push(
            `${capability.id}: public boundary file does not exist: ${boundary.path}`,
          );
        } else {
          const source = readFileSync(resolve(root, boundary.path), 'utf8');
          for (const symbol of boundary.symbols)
            if (!exportedSymbolPattern(symbol).test(source))
              violations.push(
                `${capability.id}: public boundary symbol is not exported: ${boundary.path}#${symbol}`,
              );
        }
      }
    } else {
      if (boundary)
        violations.push(
          `${capability.id}: not-yet-versioned extension contract must not declare a public boundary`,
        );
      if (!capability.extensionContract.missingContractReason?.trim())
        violations.push(
          `${capability.id}: not-yet-versioned extension contract requires a missing-contract reason`,
        );
      if (capability.lifecycle !== 'planned')
        violations.push(
          `${capability.id}: not-yet-versioned extension contract must remain planned`,
        );
      if (Object.values(capability.availability).includes('available'))
        violations.push(
          `${capability.id}: not-yet-versioned extension contract must not claim availability`,
        );
      if (capability.availability.selfHosted !== 'unavailable')
        violations.push(
          `${capability.id}: not-yet-versioned extension contract must remain unavailable to Self-Hosted`,
        );
    }

    if (managed) {
      if (capability.lifecycle === 'stable')
        violations.push(`${capability.id}: managed capability must not claim stable or GA status`);
      for (const [path, status] of Object.entries(capability.availability))
        if (status === 'available')
          violations.push(`${capability.id}: managed ${path} availability must not claim GA`);
      if (forbiddenPrivateReferences.test(JSON.stringify(capability)))
        violations.push(
          `${capability.id}: managed capability references a private source/import path`,
        );
    }

    if (
      ['apple-messages-for-business', 'rcs-messaging', 'whatsapp-messaging'].includes(
        capability.id,
      ) &&
      (capability.availability.selfHosted !== 'unavailable' ||
        !capability.notes.includes('versioned public rich-channel extension contract'))
    )
      violations.push(
        `${capability.id}: rich channel must remain unavailable to Self-Hosted until a versioned public contract exists`,
      );
  }

  const documentationPath = resolve(root, registry.documentation);
  const documentation = readFileSync(documentationPath, 'utf8');
  const expectedDocumentation = renderCapabilityRegistryDocumentation(registry);
  if (normalizeDocumentation(documentation) !== normalizeDocumentation(expectedDocumentation))
    violations.push(`${registry.documentation}: documentation does not match capability registry`);

  return violations;
}

export function validateCapabilityRegistry(registry, root, publicDistribution) {
  const manifest =
    publicDistribution ??
    JSON.parse(readFileSync(resolve(root, 'distribution/public-distribution.json'), 'utf8'));
  const violations = capabilityRegistryViolations(registry, root, manifest);
  if (violations.length > 0)
    throw new Error(
      `Capability registry validation failed:\n${violations.map((item) => `- ${item}`).join('\n')}`,
    );
  return registry;
}
