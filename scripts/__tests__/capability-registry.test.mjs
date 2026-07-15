import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
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
const registrySchema = JSON.parse(
  readFileSync(resolve(root, 'distribution/capability-registry.schema.json'), 'utf8'),
);
const publicDistribution = JSON.parse(
  readFileSync(resolve(root, 'distribution/public-distribution.json'), 'utf8'),
);

test('strict draft 2020-12 schema enforces extension-contract conditions', () => {
  const validate = new Ajv2020({ strict: true }).compile(registrySchema);
  assert.equal(validate(registry), true, JSON.stringify(validate.errors));
  assert.equal(registry.schemaVersion, 2);

  const mutations = [
    (candidate) => {
      candidate.capabilities[0].publicBoundary = {
        path: 'packages/domain/src/messaging/index.ts',
        symbols: ['SmsTransport'],
      };
    },
    (candidate) => {
      delete candidate.capabilities.find(({ id }) => id === 'generic-messaging-contracts')
        .publicBoundary;
    },
    (candidate) => {
      candidate.capabilities.find(
        ({ id }) => id === 'generic-messaging-contracts',
      ).extensionContract.missingContractReason = 'Must be rejected for a versioned contract.';
    },
    (candidate) => {
      candidate.capabilities[0].availability.cloud = 'available';
    },
    (candidate) => {
      candidate.capabilities[0].extensionContract.missingContractReason = '   ';
    },
    (candidate) => {
      candidate.schemaVersion = 1;
    },
  ];

  for (const mutate of mutations) {
    const candidate = structuredClone(registry);
    mutate(candidate);
    assert.equal(validate(candidate), false, 'conditional schema unexpectedly accepted mutation');
    assert.ok(validate.errors?.length);
  }

  const futureManagedBeta = structuredClone(registry);
  futureManagedBeta.capabilities[0].availability.cloud = 'private-beta';
  futureManagedBeta.capabilities[0].availability.platformApi = 'private-beta';
  assert.equal(validate(futureManagedBeta), true, JSON.stringify(validate.errors));
  assert.ok(
    capabilityRegistryViolations(futureManagedBeta, root, publicDistribution).some((violation) =>
      violation.includes('accepted availability decision drifted'),
    ),
  );
});

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

test('versioned extension contracts require an exported public boundary', () => {
  const missingBoundary = structuredClone(registry);
  const generic = missingBoundary.capabilities.find(
    ({ id }) => id === 'generic-messaging-contracts',
  );
  delete generic.publicBoundary;
  assert.throws(
    () => validateCapabilityRegistry(missingBoundary, root, publicDistribution),
    /publicBoundary is required by schema when extensionContract\.status is versioned/u,
  );

  const forbiddenReason = structuredClone(registry);
  const resend = forbiddenReason.capabilities.find(({ id }) => id === 'resend-email-adapter');
  resend.extensionContract.missingContractReason =
    'This reason must not decorate a versioned contract.';
  assert.throws(
    () => validateCapabilityRegistry(forbiddenReason, root, publicDistribution),
    /missingContractReason is forbidden by schema when extensionContract\.status is versioned/u,
  );
});

test('not-yet-versioned contracts require a reason and forbid boundary substitution', () => {
  const missingReason = structuredClone(registry);
  const apple = missingReason.capabilities.find(({ id }) => id === 'apple-messages-for-business');
  delete apple.extensionContract.missingContractReason;
  assert.throws(
    () => validateCapabilityRegistry(missingReason, root, publicDistribution),
    /missingContractReason is required by schema when extensionContract\.status is not-yet-versioned/u,
  );

  const substitutedBoundary = structuredClone(registry);
  const rcs = substitutedBoundary.capabilities.find(({ id }) => id === 'rcs-messaging');
  rcs.publicBoundary = {
    path: 'packages/domain/src/messaging/index.ts',
    symbols: ['SmsTransport'],
  };
  assert.throws(
    () => validateCapabilityRegistry(substitutedBoundary, root, publicDistribution),
    /publicBoundary is forbidden by schema when extensionContract\.status is not-yet-versioned/u,
  );

  const blankReason = structuredClone(registry);
  blankReason.capabilities.find(
    ({ id }) => id === 'apple-messages-for-business',
  ).extensionContract.missingContractReason = '   ';
  assert.throws(
    () => validateCapabilityRegistry(blankReason, root, publicDistribution),
    /missingContractReason must match/u,
  );
});

test('not-yet-versioned contracts cannot claim premature lifecycle or availability', () => {
  const premature = structuredClone(registry);
  const whatsapp = premature.capabilities.find(({ id }) => id === 'whatsapp-messaging');
  whatsapp.lifecycle = 'stable';
  whatsapp.availability.cloud = 'available';
  whatsapp.availability.platformApi = 'available';
  whatsapp.availability.selfHosted = 'planned';
  assert.throws(
    () => validateCapabilityRegistry(premature, root, publicDistribution),
    (error) => {
      assert.match(error.message, /lifecycle must equal "planned" by schema/u);
      assert.match(error.message, /availability\.cloud must not equal "available" by schema/u);
      assert.match(
        error.message,
        /availability\.platformApi must not equal "available" by schema/u,
      );
      assert.match(error.message, /availability\.selfHosted must equal "unavailable" by schema/u);
      return true;
    },
  );
});

test('managed capabilities cannot expose private paths or claim GA availability', () => {
  const falseGa = structuredClone(registry);
  const falseGaManagedEmail = falseGa.capabilities.find(
    ({ id }) => id === 'managed-email-operations',
  );
  falseGaManagedEmail.lifecycle = 'stable';
  falseGaManagedEmail.availability.cloud = 'available';
  const falseGaViolations = capabilityRegistryViolations(falseGa, root, publicDistribution);
  assert.ok(
    falseGaViolations.some((violation) => violation.includes('must not claim stable or GA')),
  );

  assert.ok(falseGaViolations.some((violation) => violation.includes('must not claim GA')));

  const privateBoundary = structuredClone(registry);
  const managedEmail = privateBoundary.capabilities.find(
    ({ id }) => id === 'managed-email-operations',
  );
  managedEmail.publicBoundary.path = 'packages/managed/src/email-operations.ts';
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
  assert.throws(
    () => validateCapabilityRegistry(prematureExtension, root, publicDistribution),
    /availability\.selfHosted must equal "unavailable" by schema/u,
  );
});

test('closed schema rejects undeclared managed implementation fields', () => {
  const sourceLeak = structuredClone(registry);
  sourceLeak.capabilities[0].privateImport = '@tixkit-cloud/apple-messages';
  assert.throws(
    () => validateCapabilityRegistry(sourceLeak, root, publicDistribution),
    /privateImport is not allowed/u,
  );

  const invalidExtensionStatus = structuredClone(registry);
  invalidExtensionStatus.capabilities[0].extensionContract.status = 'implicitly-versioned';
  assert.throws(
    () => validateCapabilityRegistry(invalidExtensionStatus, root, publicDistribution),
    /extensionContract\.status must be one of versioned, not-yet-versioned/u,
  );

  const undeclaredExtensionField = structuredClone(registry);
  undeclaredExtensionField.capabilities[0].extensionContract.privateSchema =
    '@tixkit-cloud/rich-channel';
  assert.throws(
    () => validateCapabilityRegistry(undeclaredExtensionField, root, publicDistribution),
    /extensionContract\.privateSchema is not allowed/u,
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
