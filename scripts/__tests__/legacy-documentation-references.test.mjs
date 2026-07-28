import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkLegacyReferences } from '../docs/check-legacy-references.mjs';
import {
  findLegacyDocumentationReferences,
  isActiveRepositorySurface,
} from '../docs/lib/legacy-references.mjs';

test('rejects legacy documentation links on active runtime and contributor surfaces', () => {
  assert.deepEqual(
    findLegacyDocumentationReferences([
      { path: 'packages/example/README.md', content: 'See docs/api-reference.md.' },
      { path: 'apps/example/src/help.ts', content: "const guide = 'docs/webhook-guide.md';" },
      { path: 'docs/public/test.mdx', content: '[SDK](docs/sdk-guides/javascript.md)' },
    ]),
    [
      'packages/example/README.md:1: legacy documentation reference docs/api-reference.md; use docs/public or a typed public route',
      'apps/example/src/help.ts:1: legacy documentation reference docs/webhook-guide.md; use docs/public or a typed public route',
      'docs/public/test.mdx:1: legacy documentation reference docs/sdk-guides/; use docs/public or a typed public route',
    ],
  );
});

test('excludes private or historical documentation paths', () => {
  for (const path of [
    'docs/internal/audits/example.md',
    'docs/completion/backlog.md',
    'docs/old-plan.md',
    'implementation-plan.md',
  ]) {
    assert.equal(isActiveRepositorySurface(path), false, path);
  }
  assert.deepEqual(
    findLegacyDocumentationReferences([
      { path: 'docs/internal/audits/example.md', content: 'docs/api-reference.md' },
    ]),
    [],
  );
});

test('scans sanitized source exports that do not contain Git metadata', () => {
  const root = mkdtempSync(join(tmpdir(), 'tixkit-legacy-docs-'));
  try {
    mkdirSync(join(root, 'packages/example'), { recursive: true });
    writeFileSync(join(root, 'package.json'), '{}');
    writeFileSync(join(root, 'packages/example/README.md'), 'See docs/api-reference.md.');
    assert.deepEqual(checkLegacyReferences(root), [
      'packages/example/README.md:1: legacy documentation reference docs/api-reference.md; use docs/public or a typed public route',
    ]);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
