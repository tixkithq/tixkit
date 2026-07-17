import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  dynamicNetworkTargetAllowed,
  discoverWorkspacePackageManifests,
  providerIntegrationRegistryViolations,
  registryAllowsDynamicNetworkTarget,
  validateProviderIntegrationRegistry,
} from '../lib/provider-integration-registry.mjs';

const root = resolve(import.meta.dirname, '../..');
const registry = JSON.parse(
  readFileSync(resolve(root, 'distribution/provider-integration-registry.json'), 'utf8'),
);
const schema = JSON.parse(
  readFileSync(resolve(root, 'distribution/provider-integration-registry.schema.json'), 'utf8'),
);

test('strict schema and semantic policy validate the checked-in provider registry', () => {
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  assert.equal(validate(registry), true, JSON.stringify(validate.errors));
  assert.deepEqual(
    validateProviderIntegrationRegistry(structuredClone(registry), schema, root),
    registry,
  );
  assert.deepEqual(providerIntegrationRegistryViolations(registry, root), []);
  assert.deepEqual(registry.dependencyAuditPackages, discoverWorkspacePackageManifests(root));
  assert.deepEqual(
    registry.integrations
      .filter(({ id }) => id.startsWith('stripe-'))
      .map(({ classification, id }) => [id, classification]),
    [
      ['stripe-browser-runtime', 'runtime-boundary'],
      ['stripe-server-gateway', 'contained-sdk'],
      ['stripe-webhook-verification', 'runtime-boundary'],
    ],
  );
});

test('schema fails closed on incomplete authorities and source-name policy', () => {
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  const mutations = [
    (candidate) => delete candidate.integrations[0].retryOwner,
    (candidate) => (candidate.integrations[0].classification = 'sdk-if-convenient'),
    (candidate) => (candidate.integrations[0].diagnosticPolicy.rawBodies = 'allowed'),
    (candidate) => (candidate.integrations[0].reviewDate = 'later'),
    (candidate) => (candidate.integrations[0].allowedDependencies[0].extra = true),
    (candidate) => delete candidate.transportExecutors[0].export,
    (candidate) => delete candidate.networkTargetAuthorities[0].issuer,
    (candidate) => delete candidate.networkTargetAuthorities[0].issuer.sha256,
    (candidate) => delete candidate.networkTargetAuthorities[0].allowedSinks,
    (candidate) => delete candidate.networkTargetAuthorities[0].outputShape,
    (candidate) => delete candidate.networkTargetAuthorities[0].runtimeEvidencePaths,
    (candidate) =>
      (candidate.nonProviderDynamicNetworkAllowances[0].allowedTargetSources = [
        'resolveAdminApiUrl',
      ]),
    (candidate) => delete candidate.nonProviderDynamicNetworkAllowances[0].allowedAuthorityIds,
    (candidate) => delete candidate.nonNetworkReceiverTypes[0].sha256,
    (candidate) => (candidate.nonNetworkReceiverTypes[0].allowedMethods = ['post']),
  ];
  for (const mutate of mutations) {
    const candidate = structuredClone(registry);
    mutate(candidate);
    assert.equal(validate(candidate), false, 'unsafe registry mutation was accepted');
    assert.ok(validate.errors?.length);
  }
});

test('dynamic network policy binds exact authority, sink, method, kind, and environment', () => {
  const path = 'apps/admin-dashboard/src/lib/export-jobs.ts';
  const target = {
    authorityId: 'admin-platform-api-url',
    kind: 'configured-tixkit-origin',
    method: 'GET',
    environmentVariables: [],
    outputShape: 'absolute-url-string-or-undefined',
  };
  assert.equal(registryAllowsDynamicNetworkTarget(registry, path, target), true);
  assert.equal(
    registryAllowsDynamicNetworkTarget(registry, 'apps/admin-dashboard/src/lib/scan-activity.ts', {
      ...target,
      method: 'POST',
    }),
    false,
    'an HTTP method outside the exact authority sink policy must fail',
  );
  assert.equal(
    registryAllowsDynamicNetworkTarget(registry, path, {
      ...target,
      authorityId: 'validated-webhook-delivery',
    }),
    false,
    'a different authority must not inherit authorization',
  );
  assert.equal(
    registryAllowsDynamicNetworkTarget(registry, path, {
      ...target,
      kind: 'validated-webhook-origin',
    }),
    false,
    'an authority kind mismatch must fail',
  );
  assert.equal(
    registryAllowsDynamicNetworkTarget(registry, path, {
      ...target,
      environmentVariables: ['ADMIN_API_URL'],
    }),
    false,
    'an unapproved environment variable must not inherit authorization',
  );
});

test('dynamic network target matching requires a registered exact issuer', () => {
  const allowance = registry.nonProviderDynamicNetworkAllowances.find(
    ({ path }) => path === 'packages/shared/src/observability.ts',
  );
  const authority = registry.networkTargetAuthorities.find(
    ({ id }) => id === 'prometheus-pushgateway-client',
  );
  assert.ok(allowance);
  assert.ok(authority);
  assert.equal(
    dynamicNetworkTargetAllowed(allowance, authority, {
      authorityId: authority.id,
      kind: authority.kind,
      method: 'POST',
      environmentVariables: [],
      outputShape: authority.outputShape,
    }),
    true,
  );
  assert.equal(
    dynamicNetworkTargetAllowed(allowance, authority, {
      authorityId: 'unregistered-spelling',
      method: 'POST',
      environmentVariables: [],
    }),
    false,
  );
  assert.equal(dynamicNetworkTargetAllowed(allowance, authority, undefined), false);

  const sdkAllowance = registry.nonProviderDynamicNetworkAllowances.find(
    ({ path: candidate }) => candidate === 'packages/sdk-js/src/index.ts',
  );
  const sdkAuthority = registry.networkTargetAuthorities.find(
    ({ id }) => id === 'sdk-js-request-url',
  );
  assert.equal(
    dynamicNetworkTargetAllowed(sdkAllowance, sdkAuthority, {
      authorityId: sdkAuthority.id,
      kind: sdkAuthority.kind,
      method: '*',
      outputShape: sdkAuthority.outputShape,
      environmentVariables: [],
    }),
    true,
  );
  assert.equal(
    dynamicNetworkTargetAllowed(allowance, authority, {
      authorityId: authority.id,
      kind: authority.kind,
      method: '*',
      outputShape: authority.outputShape,
      environmentVariables: [],
    }),
    false,
  );
});

test('runtime network authorities enumerate only exact proven boundaries', () => {
  assert.deepEqual(
    registry.networkTargetAuthorities.map(({ id }) => id),
    [
      'admin-platform-api-url',
      'admin-server-api-url',
      'admin-upload-completion-url',
      'admin-upload-url',
      'api-explorer-request-url',
      'checkout-api-url',
      'checkout-headless-request-url',
      'checkout-public-widget-url',
      'checkout-rum-url',
      'checkout-server-api-url',
      'checkout-upload-completion-url',
      'checkout-upload-url',
      'contract-test-request-url',
      'developer-api-health-url',
      'migration-pinned-fetch',
      'migration-request-url',
      'prometheus-pushgateway-client',
      'provider-base-url',
      'provider-http-executor',
      'quickstart-health-url',
      'sdk-js-request-url',
      'validated-webhook-delivery',
      'widget-runtime-url',
    ],
  );
  assert.deepEqual(
    registry.nonProviderDynamicNetworkAllowances.map(({ path, allowedAuthorityIds }) => [
      path,
      allowedAuthorityIds,
    ]),
    [
      [
        'apps/admin-dashboard/src/features/developer/developer-console-guide.tsx',
        ['developer-api-health-url'],
      ],
      ['apps/admin-dashboard/src/lib/api-http.ts', ['admin-platform-api-url']],
      ['apps/admin-dashboard/src/lib/api-server.ts', ['admin-server-api-url']],
      ['apps/admin-dashboard/src/lib/api.ts', ['admin-upload-completion-url', 'admin-upload-url']],
      ['apps/admin-dashboard/src/lib/export-jobs.ts', ['admin-platform-api-url']],
      ['apps/admin-dashboard/src/lib/scan-activity.ts', ['admin-platform-api-url']],
      ['apps/checkout/public/tixkit-widget.js', ['checkout-public-widget-url']],
      ['apps/checkout/src/components/web-vitals-reporter.tsx', ['checkout-rum-url']],
      ['apps/checkout/src/lib/api-server.ts', ['checkout-server-api-url']],
      [
        'apps/checkout/src/lib/api.ts',
        ['checkout-api-url', 'checkout-upload-completion-url', 'checkout-upload-url'],
      ],
      ['apps/docs/src/components/api-explorer-target.ts', ['api-explorer-request-url']],
      ['packages/checkout-headless/src/index.ts', ['checkout-headless-request-url']],
      ['packages/cli/src/migration-jobs.ts', ['migration-request-url']],
      ['packages/cli/src/quickstart.ts', ['quickstart-health-url']],
      ['packages/contract-tests/src/runtime-target.ts', ['contract-test-request-url']],
      ['packages/sdk-js/src/index.ts', ['sdk-js-request-url']],
      ['packages/shared/src/observability.ts', ['prometheus-pushgateway-client']],
      ['packages/widget/src/index.ts', ['widget-runtime-url']],
      ['packages/workflows/src/activities/migration-preparation.ts', ['migration-pinned-fetch']],
      ['packages/workflows/src/activities/webhook-delivery.ts', ['validated-webhook-delivery']],
    ],
  );

  for (const authority of registry.networkTargetAuthorities) {
    assert.equal(
      authority.allowedSinks.some(({ path }) => path.includes('*')),
      false,
    );
    assert.equal(
      authority.runtimeEvidencePaths.some((path) => path.includes('*')),
      false,
    );
  }

  assert.deepEqual(registry.transportExecutors, [
    {
      path: 'packages/provider-clients/src/index.ts',
      export: 'executeProviderHttp',
      allowedCallPaths: ['packages/provider-clients/src/index.ts'],
      allowedAuthorityIds: ['provider-base-url'],
    },
  ]);
});

test('semantic validation rejects duplicate and internally inconsistent policy', () => {
  const duplicateHost = structuredClone(registry);
  duplicateHost.integrations
    .find(({ id }) => id === 'resend-messaging')
    .providerHosts.push('api.plivo.com');
  assert.ok(
    providerIntegrationRegistryViolations(duplicateHost, root).some((violation) =>
      violation.includes('classified by both'),
    ),
  );

  const wildcardExecutor = structuredClone(registry);
  wildcardExecutor.transportExecutors[0].path = 'packages/provider-clients/src/**';
  assert.ok(
    providerIntegrationRegistryViolations(wildcardExecutor, root, {
      checkPaths: false,
    }).some((violation) => violation.includes('must target an exact source file')),
  );

  const missingExecutorExport = structuredClone(registry);
  missingExecutorExport.transportExecutors[0].export = 'missingProviderTransportExecutor';
  assert.ok(
    providerIntegrationRegistryViolations(missingExecutorExport, root).some((violation) =>
      violation.includes('transport executor export does not exist'),
    ),
  );

  const wildcardDynamicAllowance = structuredClone(registry);
  wildcardDynamicAllowance.nonProviderDynamicNetworkAllowances[0].path = 'apps/**';
  assert.ok(
    providerIntegrationRegistryViolations(wildcardDynamicAllowance, root, {
      checkPaths: false,
    }).some((violation) => violation.includes('must target an exact file')),
  );

  const duplicateAuthorityId = structuredClone(registry);
  duplicateAuthorityId.networkTargetAuthorities[1].id =
    duplicateAuthorityId.networkTargetAuthorities[0].id;
  assert.ok(
    providerIntegrationRegistryViolations(duplicateAuthorityId, root, {
      checkPaths: false,
    }).some((violation) => violation.includes('duplicate network target authority id')),
  );

  const duplicateAuthorityIssuer = structuredClone(registry);
  duplicateAuthorityIssuer.networkTargetAuthorities[1].issuer =
    duplicateAuthorityIssuer.networkTargetAuthorities[0].issuer;
  assert.ok(
    providerIntegrationRegistryViolations(duplicateAuthorityIssuer, root, {
      checkPaths: false,
    }).some((violation) => violation.includes('duplicate network target authority issuer')),
  );

  const staleAuthorityDigest = structuredClone(registry);
  staleAuthorityDigest.networkTargetAuthorities[0].issuer.sha256 = '0'.repeat(64);
  assert.ok(
    providerIntegrationRegistryViolations(staleAuthorityDigest, root).some((violation) =>
      violation.includes('issuer digest is stale'),
    ),
  );

  const staleReceiverDigest = structuredClone(registry);
  staleReceiverDigest.nonNetworkReceiverTypes[0].sha256 = '0'.repeat(64);
  assert.ok(
    providerIntegrationRegistryViolations(staleReceiverDigest, root).some((violation) =>
      violation.includes('non-network receiver digest is stale'),
    ),
  );

  const wildcardAuthorityEvidence = structuredClone(registry);
  wildcardAuthorityEvidence.networkTargetAuthorities[0].runtimeEvidencePaths = [
    'apps/admin-dashboard/src/lib/**',
  ];
  assert.ok(
    providerIntegrationRegistryViolations(wildcardAuthorityEvidence, root, {
      checkPaths: false,
    }).some((violation) => violation.includes('network target authority evidence must be exact')),
  );

  const unknownAuthority = structuredClone(registry);
  unknownAuthority.nonProviderDynamicNetworkAllowances[0].allowedAuthorityIds = [
    'unknown-authority',
  ];
  assert.ok(
    providerIntegrationRegistryViolations(unknownAuthority, root, {
      checkPaths: false,
    }).some((violation) => violation.includes('references unknown authority')),
  );

  const blanketProviderPath = structuredClone(registry);
  blanketProviderPath.integrations.find(({ id }) => id === 'resend-messaging').allowedHostPaths = [
    'packages/provider-clients/src/**',
  ];
  assert.ok(
    providerIntegrationRegistryViolations(blanketProviderPath, root, {
      checkPaths: false,
    }).some((violation) => violation.includes('must target an exact transport executor')),
  );

  const misplacedOwner = structuredClone(registry);
  misplacedOwner.integrations[0].ownerPackages = ['packages/unowned/package.json'];
  assert.ok(
    providerIntegrationRegistryViolations(misplacedOwner, root, {
      checkPaths: false,
    }).some((violation) => violation.includes('owner package is not dependency-audited')),
  );

  const omittedManifest = structuredClone(registry);
  omittedManifest.dependencyAuditPackages = omittedManifest.dependencyAuditPackages.filter(
    (path) => path !== 'packages/email-transport/package.json',
  );
  assert.ok(
    providerIntegrationRegistryViolations(omittedManifest, root).some((violation) =>
      violation.includes('dependency audit omits workspace manifests'),
    ),
  );

  const directWithSdk = structuredClone(registry);
  const direct = directWithSdk.integrations.find(({ id }) => id === 'resend-messaging');
  direct.allowedImports.push({
    package: 'resend',
    paths: ['packages/provider-clients/src/**'],
  });
  direct.allowedDependencies.push({
    package: 'resend',
    packagePath: 'packages/provider-clients/package.json',
    dependencyClass: 'dependencies',
  });
  assert.ok(
    providerIntegrationRegistryViolations(directWithSdk, root).some((violation) =>
      violation.includes('direct-http integration must not declare a vendor SDK'),
    ),
  );
});
