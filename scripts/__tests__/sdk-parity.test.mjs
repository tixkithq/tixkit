import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { validateSdkParity } from '../lib/sdk-parity.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'tixkit-sdk-parity-'));
  const catalog = [
    {
      id: 'example',
      packageName: '@tixkit/example',
      packagePath: 'packages/example',
      sourceFiles: ['packages/example/src.ts'],
      requiredExports: ['ExampleClient'],
      guidePath: 'docs/example.mdx',
      route: '/sdks/example',
      demoDependency: '@tixkit/example',
    },
  ];
  const registry = [
    {
      id: 'example',
      packageName: '@tixkit/example',
      apiVersion: '2026-01-01',
      supportStatus: 'beta',
      install: 'bun add @tixkit/example',
      initialization: 'new ExampleClient()',
      firstRequest: 'client.list()',
      demoPath: 'apps/example',
      docRouteId: 'example',
    },
  ];
  for (const dir of ['packages/example', 'docs', 'apps/example'])
    mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(
    join(root, 'packages/example/package.json'),
    JSON.stringify({ name: '@tixkit/example' }),
  );
  writeFileSync(join(root, 'packages/example/README.md'), 'API version 2026-01-01');
  writeFileSync(
    join(root, 'packages/example/src.ts'),
    "export const API_VERSION = '2026-01-01'; export class ExampleClient {}",
  );
  writeFileSync(
    join(root, 'docs/example.mdx'),
    '---\nstatus: beta\n---\n<SdkGuide sdkId="example" />\n@tixkit/example\napps/example',
  );
  writeFileSync(
    join(root, 'apps/example/package.json'),
    JSON.stringify({
      dependencies: { '@tixkit/example': 'workspace:*' },
      scripts: { typecheck: 'tsc' },
    }),
  );
  return { root, catalog, registry, docRoutes: { example: '/sdks/example' } };
}

test('accepts a synchronized package, guide, registry, route, export, and demo', () => {
  assert.deepEqual(validateSdkParity(fixture()).failures, []);
});

test('reports registry route, version, support, package, export, and demo drift together', () => {
  const input = fixture();
  input.registry[0] = {
    ...input.registry[0],
    packageName: '@tixkit/wrong',
    apiVersion: 'old',
    supportStatus: 'preview',
    initialization: 'no export',
  };
  input.docRoutes.example = '/wrong';
  writeFileSync(join(input.root, 'apps/example/package.json'), JSON.stringify({ scripts: {} }));
  const failures = validateSdkParity(input).failures.join('\n');
  for (const expected of [
    'registry package',
    'registry API version',
    'unsupported support status',
    'resolves to /wrong',
    'snippets do not exercise',
    'demo does not depend',
    'missing a typecheck',
  ])
    assert.match(failures, new RegExp(expected));
});

test('reports entries missing from either side of the shared matrix', () => {
  const input = fixture();
  input.registry.push({ ...input.registry[0], id: 'orphan' });
  input.catalog.push({ ...input.catalog[0], id: 'missing' });
  const failures = validateSdkParity(input).failures.join('\n');
  assert.match(failures, /orphan has no parity catalog definition/);
  assert.match(failures, /missing: missing from shared SDK snippet registry/);
});
