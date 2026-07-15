import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  capabilityRegistryViolations,
  EXPECTED_CAPABILITY_DECISIONS,
  REQUIRED_CAPABILITY_DECISIONS,
  renderCapabilityRegistryDocumentation,
  validateCapabilityRegistry,
} from '../lib/capability-registry.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const registry = JSON.parse(
  readFileSync(resolve(root, 'distribution/capability-registry.json'), 'utf8'),
);
const publicDistribution = JSON.parse(
  readFileSync(resolve(root, 'distribution/public-distribution.json'), 'utf8'),
);

test('validates every required capability decision and its generated documentation', () => {
  assert.deepEqual(
    validateCapabilityRegistry(structuredClone(registry), root, publicDistribution),
    registry,
  );
  assert.deepEqual(
    registry.capabilities.map(({ id }) => id),
    REQUIRED_CAPABILITY_DECISIONS,
  );
  assert.deepEqual(Object.keys(EXPECTED_CAPABILITY_DECISIONS), REQUIRED_CAPABILITY_DECISIONS);
  assert.match(renderCapabilityRegistryDocumentation(registry), /managed-routing-intelligence/u);
});

test('renders every delivery obligation exactly once per capability', () => {
  const rows = renderCapabilityRegistryDocumentation(registry)
    .split('\n')
    .filter((line) => line.startsWith('| `'));
  assert.equal(rows.length, registry.capabilities.length);
  for (const row of rows) assert.equal(row.match(/consent=/gu)?.length, 1);
});

test('rejects missing, duplicate, unexpected, and unsorted decisions', () => {
  const missing = structuredClone(registry);
  missing.capabilities.shift();
  assert.ok(
    capabilityRegistryViolations(missing, root, publicDistribution).includes(
      'required capability decision is missing: apple-messages-for-business',
    ),
  );

  const duplicate = structuredClone(registry);
  duplicate.capabilities.splice(1, 0, structuredClone(duplicate.capabilities[0]));
  assert.ok(
    capabilityRegistryViolations(duplicate, root, publicDistribution).includes(
      'capability IDs must be unique',
    ),
  );

  const unexpected = structuredClone(registry);
  unexpected.capabilities[0].id = 'arbitrary-private-channel';
  assert.ok(
    capabilityRegistryViolations(unexpected, root, publicDistribution).includes(
      'unsupported capability decision: arbitrary-private-channel',
    ),
  );

  const unsorted = structuredClone(registry);
  unsorted.capabilities.reverse();
  assert.ok(
    capabilityRegistryViolations(unsorted, root, publicDistribution).includes(
      'capability IDs must be sorted lexicographically',
    ),
  );
});

test('requires existing public files and named exported symbols', () => {
  const missingFile = structuredClone(registry);
  missingFile.capabilities[1].publicBoundary.path = 'packages/domain/src/messaging/missing.ts';
  assert.ok(
    capabilityRegistryViolations(missingFile, root, publicDistribution).some((violation) =>
      violation.includes('public boundary file does not exist'),
    ),
  );

  const missingSymbol = structuredClone(registry);
  missingSymbol.capabilities[1].publicBoundary.symbols = ['UnpublishedMessagingBoundary'];
  assert.ok(
    capabilityRegistryViolations(missingSymbol, root, publicDistribution).some((violation) =>
      violation.includes('public boundary symbol is not exported'),
    ),
  );

  const nonPublic = structuredClone(registry);
  nonPublic.capabilities[1].publicBoundary.path =
    'docs/internal/architecture/open-core-operating-model.md';
  assert.ok(
    capabilityRegistryViolations(nonPublic, root, publicDistribution).some((violation) =>
      violation.includes('public boundary is not in the public distribution'),
    ),
  );
});

test('managed capabilities cannot expose private paths or claim GA availability', () => {
  const falseGa = structuredClone(registry);
  falseGa.capabilities[0].lifecycle = 'stable';
  falseGa.capabilities[0].availability.cloud = 'available';
  const falseGaViolations = capabilityRegistryViolations(falseGa, root, publicDistribution);
  assert.ok(
    falseGaViolations.some((violation) => violation.includes('must not claim stable or GA')),
  );
  assert.ok(falseGaViolations.some((violation) => violation.includes('must not claim GA')));

  const privateBoundary = structuredClone(registry);
  privateBoundary.capabilities[0].publicBoundary.path = 'packages/managed/src/apple-messages.ts';
  assert.ok(
    capabilityRegistryViolations(privateBoundary, root, publicDistribution).some((violation) =>
      violation.includes('references a private source/import path'),
    ),
  );
});

test('accepted decisions cannot bypass policy through valid reclassification or contract drift', () => {
  const bypass = structuredClone(registry);
  const managedEmail = bypass.capabilities.find(({ id }) => id === 'managed-email-operations');
  managedEmail.classification = 'shared-core';
  managedEmail.lifecycle = 'stable';
  managedEmail.availability = {
    cloud: 'available',
    platformApi: 'available',
    selfHosted: 'available',
  };
  const bypassViolations = capabilityRegistryViolations(bypass, root, publicDistribution);
  assert.ok(
    bypassViolations.includes('managed-email-operations: accepted classification decision drifted'),
  );
  assert.ok(
    bypassViolations.includes('managed-email-operations: accepted lifecycle decision drifted'),
  );
  assert.ok(
    bypassViolations.includes('managed-email-operations: accepted availability decision drifted'),
  );

  const boundaryDrift = structuredClone(registry);
  const boundary = boundaryDrift.capabilities.find(({ id }) => id === 'managed-email-operations');
  boundary.publicBoundary.symbols = ['SmsTransport'];
  assert.ok(
    capabilityRegistryViolations(boundaryDrift, root, publicDistribution).includes(
      'managed-email-operations: accepted publicBoundary decision drifted',
    ),
  );

  const obligationDrift = structuredClone(registry);
  const obligation = obligationDrift.capabilities.find(
    ({ id }) => id === 'managed-email-operations',
  );
  obligation.obligations.consent = 'not-applicable';
  assert.ok(
    capabilityRegistryViolations(obligationDrift, root, publicDistribution).includes(
      'managed-email-operations: accepted obligations decision drifted',
    ),
  );
});

test('rich channels stay unavailable to Self-Hosted without a versioned public contract', () => {
  const prematureExtension = structuredClone(registry);
  const whatsapp = prematureExtension.capabilities.find(({ id }) => id === 'whatsapp-messaging');
  whatsapp.availability.selfHosted = 'planned';
  assert.ok(
    capabilityRegistryViolations(prematureExtension, root, publicDistribution).some((violation) =>
      violation.includes('rich channel must remain unavailable to Self-Hosted'),
    ),
  );
});

test('closed schema rejects undeclared managed implementation fields', () => {
  const sourceLeak = structuredClone(registry);
  sourceLeak.capabilities[0].privateImport = '@tixkit-cloud/apple-messages';
  assert.throws(
    () => validateCapabilityRegistry(sourceLeak, root, publicDistribution),
    /privateImport is not allowed/u,
  );
});

test('documentation drift is a validation failure', () => {
  const drifted = structuredClone(registry);
  drifted.capabilities[0].notes = 'Changed without updating documentation.';
  assert.ok(
    capabilityRegistryViolations(drifted, root, publicDistribution).includes(
      'docs/public/reference/capabilities-and-integrations.mdx: documentation does not match capability registry',
    ),
  );
});
