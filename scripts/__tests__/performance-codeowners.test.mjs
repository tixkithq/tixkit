import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '../..');
const codeowners = readFileSync(resolve(root, '.github/CODEOWNERS'), 'utf8');

test('performance evidence code and deployment inputs require maintainer review', () => {
  const rules = new Map(
    codeowners
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const [pattern, ...owners] = line.split(/\s+/u);
        return [pattern, owners];
      }),
  );
  const protectedPatterns = [
    '/scripts/performance-*.mjs',
    '/scripts/performance-*.schema.json',
    '/scripts/__tests__/performance-*.test.mjs',
    '/performance-*.json',
    '/infra/compact/',
    '/infra/helm/tixkit/',
  ];

  for (const pattern of protectedPatterns) {
    assert.deepEqual(rules.get(pattern), ['@tixkithq/maintainers'], `${pattern} is not CODEOWNED`);
  }
});
