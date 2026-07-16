import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  discoverWorkspacePackageManifests,
  providerIntegrationRegistryViolations,
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

test('schema fails closed on incomplete classifications and unsafe diagnostic policy', () => {
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  const mutations = [
    (candidate) => delete candidate.integrations[0].retryOwner,
    (candidate) => (candidate.integrations[0].classification = 'sdk-if-convenient'),
    (candidate) => (candidate.integrations[0].diagnosticPolicy.rawBodies = 'allowed'),
    (candidate) => (candidate.integrations[0].reviewDate = 'later'),
    (candidate) => (candidate.integrations[0].allowedDependencies[0].extra = true),
  ];
  for (const mutate of mutations) {
    const candidate = structuredClone(registry);
    mutate(candidate);
    assert.equal(validate(candidate), false, 'unsafe registry mutation was accepted');
    assert.ok(validate.errors?.length);
  }
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

  const misplacedOwner = structuredClone(registry);
  misplacedOwner.integrations[0].ownerPackages = ['packages/unowned/package.json'];
  assert.ok(
    providerIntegrationRegistryViolations(misplacedOwner, root, { checkPaths: false }).some(
      (violation) => violation.includes('owner package is not dependency-audited'),
    ),
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
  direct.allowedImports.push({ package: 'resend', paths: ['packages/provider-clients/src/**'] });
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
