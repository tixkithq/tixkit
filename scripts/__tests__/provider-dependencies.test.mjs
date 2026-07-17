import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  buildProviderDependencyInventoryArtifact,
  providerDependencyInventory,
  providerDependencyViolations,
  renderProviderDependencyInventory,
  validateProviderDependencyInventoryArtifact,
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
        classification: 'contained-sdk',
        ownerPackages: ['packages/provider-clients/package.json'],
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
  write(root, 'distribution/provider-integration-registry.json', registry);
  writeFileSync(
    resolve(root, 'distribution/provider-dependency-inventory.schema.json'),
    readFileSync(resolve(repositoryRoot, 'distribution/provider-dependency-inventory.schema.json')),
  );
  return { registry, root };
}

test('checked-in manifests and provider SDK imports match the registry', () => {
  const registry = loadProviderIntegrationRegistry(repositoryRoot);
  const audit = providerDependencyInventory(repositoryRoot, registry);
  assert.deepEqual(providerDependencyViolations(repositoryRoot, registry, audit), []);
  const inventory = renderProviderDependencyInventory(repositoryRoot, registry, audit);
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

test('dependency inventory is schema-valid, deterministic, and rejects stale or tampered data', () => {
  const inventoryFixture = fixture();
  try {
    const artifact = buildProviderDependencyInventoryArtifact(
      inventoryFixture.root,
      inventoryFixture.registry,
    );
    assert.equal(artifact.schemaVersion, 1);
    assert.equal(artifact.imports.length, 2);
    assert.deepEqual(
      validateProviderDependencyInventoryArtifact(
        inventoryFixture.root,
        artifact,
        inventoryFixture.registry,
      ),
      artifact,
    );

    const stale = structuredClone(artifact);
    stale.imports.pop();
    assert.throws(
      () =>
        validateProviderDependencyInventoryArtifact(
          inventoryFixture.root,
          stale,
          inventoryFixture.registry,
        ),
      /inventory is stale or tampered/u,
    );

    const tampered = structuredClone(artifact);
    tampered.registry.sha256 = '0'.repeat(64);
    assert.throws(
      () =>
        validateProviderDependencyInventoryArtifact(
          inventoryFixture.root,
          tampered,
          inventoryFixture.registry,
        ),
      /inventory is stale or tampered/u,
    );

    const invalid = structuredClone(artifact);
    invalid.schemaVersion = 2;
    assert.throws(
      () =>
        validateProviderDependencyInventoryArtifact(
          inventoryFixture.root,
          invalid,
          inventoryFixture.registry,
        ),
      /inventory schema violations/u,
    );
  } finally {
    rmSync(inventoryFixture.root, { recursive: true, force: true });
  }
});

test('CLI writer is byte-identical to the checked inventory for exact CI cmp', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'tixkit-provider-inventory-cmp-'));
  const generatedPath = resolve(root, 'inventory.json');
  try {
    execFileSync(
      process.execPath,
      ['scripts/validate-provider-dependencies.mjs', '--write', generatedPath],
      { cwd: repositoryRoot, stdio: 'pipe' },
    );
    execFileSync('cmp', [
      resolve(repositoryRoot, 'distribution/provider-dependency-inventory.json'),
      generatedPath,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
  const misplaced = fixture({
    sourcePath: 'packages/provider-clients/src/hidden.ts',
  });
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
    write(
      dynamic.root,
      'packages/api/src/__tests__/split-binding.test.ts',
      "const prefix = 'mystery-'; const suffix = 'sdk'; await import(prefix + suffix);\n",
    );
    write(
      dynamic.root,
      'packages/api/src/__tests__/split-template.test.ts',
      "const prefix = 'mystery-'; await import(`${prefix}sdk`);\n",
    );
    write(
      dynamic.root,
      'packages/api/src/__tests__/multiline-bare.test.ts',
      "import\n'mystery-sdk';\n",
    );
    write(
      dynamic.root,
      'packages/api/src/__tests__/multiline-from.test.ts',
      "import { Provider }\nfrom\n'mystery-sdk';\nvoid Provider;\n",
    );
    write(
      dynamic.root,
      'packages/api/src/__tests__/multiline-import-equals.test.ts',
      "import Provider = require(\n'mystery-sdk'\n);\nvoid Provider;\n",
    );
    write(
      dynamic.root,
      'packages/api/src/__tests__/computed-require.test.ts',
      "module['requ' + 'ire']('mystery-sdk');\n",
    );
    const longComment = `/*${'x'.repeat(700)}*/`;
    write(
      dynamic.root,
      'packages/api/src/__tests__/comment-gap-bare.test.ts',
      `import ${longComment} 'mystery-sdk';\n`,
    );
    write(
      dynamic.root,
      'packages/api/src/__tests__/comment-gap-from.test.ts',
      `import { Provider } from ${longComment} 'mystery-sdk';\nvoid Provider;\n`,
    );
    write(
      dynamic.root,
      'packages/api/src/__tests__/aliased-module.test.ts',
      "const mod = module; mod['requ' + 'ire']('mystery-sdk');\n",
    );
    write(
      dynamic.root,
      'packages/api/src/__tests__/destructured-module.test.ts',
      "const { require: load } = module; load('mystery-sdk');\n",
    );
    write(
      dynamic.root,
      'packages/api/src/__tests__/assigned-module.test.ts',
      "let mod; mod = module; mod['requ' + 'ire']('mystery-sdk');\n",
    );
    write(
      dynamic.root,
      'packages/api/src/__tests__/assigned-destructured-module.test.ts',
      "let load; ({ require: load } = module); load('mystery-sdk');\n",
    );
    write(
      dynamic.root,
      'packages/api/src/__tests__/conditional-module.test.ts',
      "const mod = enabled ? module : fallback; mod['requ' + 'ire']('mystery-sdk');\n",
    );
    write(
      dynamic.root,
      'packages/api/src/__tests__/array-module.test.ts',
      "const mod = [module][0]; mod['requ' + 'ire']('mystery-sdk');\n",
    );
    write(
      dynamic.root,
      'packages/api/src/__tests__/comment-semicolon-import.test.ts',
      "import { Provider /* ; */ } from 'mystery-sdk';\nvoid Provider;\n",
    );
    write(
      dynamic.root,
      'packages/api/src/__tests__/comment-semicolon-export.test.ts',
      "export { Provider /* ; */ } from 'mystery-sdk';\n",
    );
    write(
      dynamic.root,
      'packages/api/src/__tests__/url-string-before-import.test.ts',
      "const documentation = 'https://example.test/path'; import 'mystery-sdk'; void documentation;\n",
    );
    write(
      dynamic.root,
      'packages/api/src/__tests__/literal-dynamic-import.test.ts',
      "const Provider = (await import('mystery-sdk')).default; void Provider;\n",
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
    assert.ok(
      violations.some((violation) => violation.includes('split-binding.test.ts')),
      violations.join('\n'),
    );
    assert.ok(
      violations.some((violation) => violation.includes('split-template.test.ts')),
      violations.join('\n'),
    );
    for (const path of [
      'multiline-bare.test.ts',
      'multiline-from.test.ts',
      'multiline-import-equals.test.ts',
      'computed-require.test.ts',
      'comment-gap-bare.test.ts',
      'comment-gap-from.test.ts',
      'aliased-module.test.ts',
      'destructured-module.test.ts',
      'assigned-module.test.ts',
      'assigned-destructured-module.test.ts',
      'conditional-module.test.ts',
      'array-module.test.ts',
      'comment-semicolon-import.test.ts',
      'comment-semicolon-export.test.ts',
      'url-string-before-import.test.ts',
      'literal-dynamic-import.test.ts',
    ]) {
      assert.ok(
        violations.some((violation) => violation.includes(path)),
        `${path}:\n${violations.join('\n')}`,
      );
    }
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
