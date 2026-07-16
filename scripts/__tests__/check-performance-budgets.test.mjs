import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateBudgets } from '../check-performance-budgets.mjs';

test('rejects duplicate Next.js route identities instead of manufacturing independent evidence', () => {
  const results = evaluateBudgets(
    {
      nextRoutes: [
        { label: 'guide', appDir: 'apps/docs', route: '/[...slug]', maxBytes: 550_000 },
        { label: 'reference', appDir: './apps/docs/', route: '[...slug]/', maxBytes: 550_000 },
      ],
    },
    { root: '/missing-performance-budget-fixture' },
  );

  assert.equal(results.length, 2);
  assert.match(results[0].line, /missing \.next build manifests/u);
  assert.deepEqual(results[1], {
    ok: false,
    line: 'FAIL reference: duplicate Next.js route budget apps/docs:/[...slug]',
  });
});
