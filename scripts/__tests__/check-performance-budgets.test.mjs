import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  assertValidPerformanceBudgetConfig,
  evaluateBudgets,
} from '../check-performance-budgets.mjs';

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

test('binds Lighthouse budgets to the expected route and pinned tool version', (context) => {
  const root = mkdtempSync(join(tmpdir(), 'tixkit-lighthouse-budget-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(
    join(root, 'report.json'),
    JSON.stringify({
      requestedUrl: 'http://localhost:3201/e/evt_1',
      finalDisplayedUrl: 'http://localhost:3201/e/evt_1',
      lighthouseVersion: '12.8.2',
      categories: { performance: { score: 0.9 } },
      audits: { 'largest-contentful-paint': { numericValue: 2_000 } },
    }),
  );
  const budget = {
    label: 'event page',
    path: 'report.json',
    expectedUrlPattern: '^http://localhost:3201/e/[A-Za-z0-9_-]+$',
    lighthouseVersion: '12.8.2',
    minPerformanceScore: 0.8,
    audits: [
      {
        label: 'largest contentful paint',
        id: 'largest-contentful-paint',
        maxNumericValue: 2_500,
        unit: 'ms',
      },
    ],
  };

  const passing = evaluateBudgets({ lighthouseReports: [budget] }, { root });
  assert.equal(
    passing.every(({ ok }) => ok),
    true,
    passing.map(({ line }) => line).join('\n'),
  );
  assert.match(passing[0].line, /PASS event page identity/u);

  writeFileSync(
    join(root, 'report.json'),
    JSON.stringify({
      requestedUrl: 'http://localhost:3202/dashboard',
      finalDisplayedUrl: 'http://localhost:3202/dashboard',
      lighthouseVersion: '13.0.0',
      categories: { performance: { score: 1 } },
      audits: { 'largest-contentful-paint': { numericValue: 1 } },
    }),
  );
  const mismatched = evaluateBudgets({ lighthouseReports: [budget] }, { root });
  assert.equal(mismatched.filter(({ ok }) => !ok).length, 3);
  assert.match(mismatched[0].line, /requestedUrl does not match/u);
  assert.match(mismatched[1].line, /finalDisplayedUrl does not match/u);
  assert.match(mismatched[2].line, /Lighthouse version 13\.0\.0 does not equal 12\.8\.2/u);

  for (const field of ['requestedUrl', 'finalDisplayedUrl']) {
    const report = {
      requestedUrl: 'http://localhost:3201/e/evt_1',
      finalDisplayedUrl: 'http://localhost:3201/e/evt_1',
      lighthouseVersion: '12.8.2',
      categories: { performance: { score: 1 } },
      audits: { 'largest-contentful-paint': { numericValue: 1 } },
    };
    delete report[field];
    writeFileSync(join(root, 'report.json'), JSON.stringify(report));
    const missingUrl = evaluateBudgets({ lighthouseReports: [budget] }, { root });
    assert.equal(
      missingUrl.some(({ ok }) => !ok),
      true,
    );
    assert.match(missingUrl[0].line, new RegExp(`${field} does not match`, 'u'));
  }
});

test('rejects malformed or non-budget Lighthouse configuration before reading reports', () => {
  const base = {
    label: 'event page',
    path: 'missing-report.json',
    expectedUrlPattern: '^https://events\\.example/e/[a-z0-9]+$',
    lighthouseVersion: '12.8.2',
    minPerformanceScore: 0.8,
  };
  const hostile = [
    { ...base, minPerformanceScore: undefined },
    { ...base, minPerformaceScore: 0.9 },
    { ...base, expectedUrlPattern: '[' },
    { ...base, lighthouseVersion: undefined },
    { ...base, lighthouseVersion: '12.8' },
  ];

  for (const report of hostile) {
    assert.throws(
      () => assertValidPerformanceBudgetConfig({ lighthouseReports: [report] }),
      /Invalid performance budget config/u,
    );
  }
});
