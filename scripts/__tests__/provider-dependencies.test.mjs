import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  providerDependencyViolations,
  renderProviderDependencyInventory,
} from '../lib/provider-dependencies.mjs';
import { loadProviderIntegrationRegistry } from '../lib/provider-integration-registry.mjs';

const repositoryRoot = resolve(import.meta.dirname, '../..');

function write(root, path, value) {
  const absolute = resolve(root, path);
  mkdirSync(resolve(absolute, '..'), { recursive: true });
  writeFileSync(
    absolute,
    typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`,
  );
}

function fixture({
  apiDependencyClass = 'devDependencies',
  sourcePath = 'packages/provider-clients/src/client.ts',
  rogueDependencyClass,
} = {}) {
  const root = mkdtempSync(resolve(tmpdir(), 'tixkit-provider-dependencies-'));
  const registry = {
    dependencyAuditPackages: [
      'packages/api/package.json',
      'packages/email-transport/package.json',
      'packages/provider-clients/package.json',
    ],
    nonProviderDependencies: [],
    integrations: [
      {
        id: 'mystery-contained-sdk',
        allowedImports: [
          {
            package: 'mystery-sdk',
            paths: [
              'packages/api/src/__tests__/provider.integration.test.ts',
              'packages/provider-clients/src/client.ts',
            ],
          },
        ],
        allowedDependencies: [
          {
            package: 'mystery-sdk',
            packagePath: 'packages/api/package.json',
            dependencyClass: 'devDependencies',
          },
          {
            package: 'mystery-sdk',
            packagePath: 'packages/provider-clients/package.json',
            dependencyClass: 'dependencies',
          },
        ],
      },
    ],
  };
  write(root, 'packages/api/package.json', {
    name: '@tixkit/api',
    [apiDependencyClass]: { 'mystery-sdk': '1.0.0' },
  });
  write(
    root,
    'packages/api/src/__tests__/provider.integration.test.ts',
    "import Provider from 'mystery-sdk';\nvoid Provider;\n",
  );
  write(root, 'packages/provider-clients/package.json', {
    name: '@tixkit/provider-clients',
    dependencies: { 'mystery-sdk': '1.0.0' },
  });
  write(root, 'packages/email-transport/package.json', {
    name: '@tixkit/email-transport',
    ...(rogueDependencyClass ? { [rogueDependencyClass]: { 'rogue-sdk': '1.0.0' } } : {}),
  });
  write(root, sourcePath, "import Provider from 'mystery-sdk';\nvoid Provider;\n");
  return { registry, root };
}

test('checked-in manifests and provider SDK imports match the registry', () => {
  const registry = loadProviderIntegrationRegistry(repositoryRoot);
  assert.deepEqual(providerDependencyViolations(repositoryRoot, registry), []);
  const inventory = renderProviderDependencyInventory(repositoryRoot, registry);
  assert.ok(
    inventory.some(({ dependency, usage }) => dependency === 'stripe' && usage === 'runtime'),
  );
  assert.ok(inventory.some(({ dependency, usage }) => dependency === 'stripe' && usage === 'test'));
  assert.ok(
    inventory.every(
      ({ classifications, dependencyClass, integrationIds, integrationOwners }) =>
        classifications.length > 0 &&
        dependencyClass !== 'undeclared' &&
        integrationIds.length > 0 &&
        integrationOwners.length > 0,
    ),
  );
  const stripeRuntimeImport = inventory.find(
    ({ dependency, importPath }) =>
      dependency === 'stripe' && importPath === 'packages/provider-clients/src/stripe.ts',
  );
  assert.deepEqual(stripeRuntimeImport?.classifications, ['contained-sdk', 'runtime-boundary']);
  assert.deepEqual(stripeRuntimeImport?.integrationIds, [
    'stripe-server-gateway',
    'stripe-webhook-verification',
  ]);
  assert.deepEqual(
    inventory,
    structuredClone(inventory).sort((a, b) =>
      `${a.dependency}\0${a.importPath}`.localeCompare(`${b.dependency}\0${b.importPath}`),
    ),
  );
});

test('rejects production-only test SDKs and unclassified dependencies in either class', () => {
  const productionTest = fixture({
    apiDependencyClass: 'dependencies',
    rogueDependencyClass: 'dependencies',
  });
  try {
    const violations = providerDependencyViolations(productionTest.root, productionTest.registry);
    assert.ok(violations.some((violation) => violation.includes('not approved in dependencies')));
    assert.ok(
      violations.some((violation) =>
        violation.includes('production-scoped but imported only by tests'),
      ),
    );
    assert.ok(
      violations.some((violation) =>
        violation.includes('unclassified production dependency rogue-sdk'),
      ),
    );
  } finally {
    rmSync(productionTest.root, { recursive: true, force: true });
  }

  const devTest = fixture({ rogueDependencyClass: 'devDependencies' });
  try {
    write(
      devTest.root,
      'packages/email-transport/src/__tests__/rogue.test.ts',
      "import Rogue from 'rogue-sdk';\nvoid Rogue;\n",
    );
    assert.ok(
      providerDependencyViolations(devTest.root, devTest.registry).some((violation) =>
        violation.includes('unclassified development dependency rogue-sdk'),
      ),
    );
  } finally {
    rmSync(devTest.root, { recursive: true, force: true });
  }
});

test('rejects SDK imports outside approved paths and missing direct dependencies', () => {
  const misplaced = fixture({ sourcePath: 'packages/provider-clients/src/hidden.ts' });
  try {
    assert.ok(
      providerDependencyViolations(misplaced.root, misplaced.registry).some((violation) =>
        violation.includes('import is outside registry-approved paths'),
      ),
    );
  } finally {
    rmSync(misplaced.root, { recursive: true, force: true });
  }

  const dynamic = fixture();
  try {
    write(
      dynamic.root,
      'packages/api/src/__tests__/unapproved.test.ts',
      "const vendor = 'mystery-' + 'sdk'; await import(vendor);\n",
    );
    write(
      dynamic.root,
      'packages/api/src/__tests__/unapproved-require.test.ts',
      "import { createRequire } from 'node:module'; const load = createRequire(import.meta.url); load('mystery-sdk');\n",
    );
    write(
      dynamic.root,
      'packages/api/provider.integration.test.ts',
      "await import(String('mystery-sdk'));\n",
    );
    const violations = providerDependencyViolations(dynamic.root, dynamic.registry);
    assert.ok(
      violations.some((violation) => violation.includes('unapproved.test.ts')),
      violations.join('\n'),
    );
    assert.ok(
      violations.some((violation) => violation.includes('unapproved-require.test.ts')),
      violations.join('\n'),
    );
    assert.ok(
      violations.some((violation) => violation.includes('provider.integration.test.ts')),
      violations.join('\n'),
    );
  } finally {
    rmSync(dynamic.root, { recursive: true, force: true });
  }

  const missing = fixture();
  try {
    write(missing.root, 'packages/api/package.json', { name: '@tixkit/api' });
    const violations = providerDependencyViolations(missing.root, missing.registry);
    assert.ok(violations.some((violation) => violation.includes('approved dependency is missing')));
    assert.ok(
      violations.some((violation) => violation.includes('without a direct package dependency')),
    );
  } finally {
    rmSync(missing.root, { recursive: true, force: true });
  }
});
