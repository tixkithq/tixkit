import assert from 'node:assert/strict';
import test from 'node:test';
import { validateValidationRunbookContent } from '../validate-validation-runbook.mjs';

const packageScripts = {
  build: 'turbo run build',
  'export:oss': 'node scripts/export-oss.mjs',
  'guardrails:public-remote': 'node scripts/public-remote-guardrails.mjs',
  'validate:public-remote-guardrails':
    'node scripts/public-remote-guardrails.mjs --check fixture.json',
  'validate:final-evidence-checklist': 'node scripts/validate-final-evidence-checklist.mjs',
  'validate:user-story-matrix': 'node scripts/validate-user-story-matrix.mjs',
  'test:unit': 'turbo run test:unit && bun run test:scripts',
  'test:scripts':
    'node --test scripts/__tests__/*.test.mjs && bun run validate:final-evidence-checklist && bun run validate:user-story-matrix',
};

const ciWorkflowText = `name: CI

jobs:
  unit-tests:
    name: Unit Tests
    runs-on: ubuntu-latest
    steps:
      - run: bun run test:unit
`;

const validRunbook = `# Tixkit Validation Runbook

## Prerequisites

Use \`docs/completion/backlog.md\`.

## Baseline Safety Checks

\`\`\`bash
git status --short
bun run export:oss -- --out /tmp/tixkit-oss-export
\`\`\`

## Core Validation Matrix

\`\`\`bash
bun run build
bun run format:check
bun run typecheck
bun run lint
bun run test
git diff --check
\`\`\`

Hosted CI proof:

- A hosted GitHub Actions run is green.
- Branch protection for \`refs/heads/main\` requires pull-request and required-status-check rules for the documented check names.
- The hosted \`Provider Tests (Stripe)\` job runs (does not skip) with \`STRIPE_SECRET_KEY\`, \`STRIPE_WEBHOOK_SECRET\`, \`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY\`, and \`STRIPE_CONNECT_CLIENT_ID\`.
- \`.github/workflows/release-dry-run.yml\` runs green on hosted CI.
- Managed DR proof covers Managed Postgres backup, managed Postgres restore, managed MySQL backup, managed MySQL restore, restore-based rollback, RPO/RTO, \`docs/public/self-hosting/deployment.mdx\`, and \`docs/public/operations/incidents.mdx\`.
- Deferred 2026-06-30 PayPal product decision remains documented.
- C-082 closes only after fresh hosted CI validates the committed suite, \`docs/completion/user-story-test-matrix.md\`, \`Validated 146 user-story rows\`, and \`133 evidence paths\` without cached Turbo-only proof.

## Open-Core Export Validation Gates (C-061..C-070)

Generate rules with \`PUBLIC_EXPORT_GITHUB_APP_ID=<integration-id> bun run guardrails:public-remote -- --print\`, verify with \`bun run validate:public-remote-guardrails\`, and apply with \`GITHUB_TOKEN=<admin-token> PUBLIC_EXPORT_GITHUB_APP_ID=<integration-id> bun run guardrails:public-remote -- --apply <owner>/<public-repo>\`.

The public remote ruleset keeps the export GitHub App as the only bypass actor.

## Final Completion Evidence

The final completion note must include:

- Validation that \`docs/completion/final-evidence-checklist.md\` passes \`bun run validate:final-evidence-checklist\`.
- Git status summary.
- Infrastructure status.
- Migration status for Postgres and MySQL.
- Full command list run and pass/fail results.
- Any skipped tests and why they are acceptable or still blocking.
- Browser artifacts summary: screenshots, axe, no-console.
- Remaining risks or explicit deferrals.
`;

test('validateValidationRunbookContent accepts required sections, scripts, commands, and evidence bullets', () => {
  const result = validateValidationRunbookContent(validRunbook, packageScripts, { ciWorkflowText });

  assert.deepEqual(result.errors, []);
  assert.ok(result.referencedPaths.includes('docs/completion/backlog.md'));
  assert.ok(result.referencedPaths.includes('docs/completion/final-evidence-checklist.md'));
  assert.ok(result.referencedPaths.includes('scripts/export-oss.mjs'));
  assert.ok(result.referencedPaths.includes('scripts/validate-final-evidence-checklist.mjs'));
  assert.ok(result.referencedPaths.includes('.github/workflows/ci.yml'));
});

test('validateValidationRunbookContent rejects missing final evidence and missing package scripts', () => {
  const result = validateValidationRunbookContent(
    validRunbook.replace('- Infrastructure status.\n', ''),
    { ...packageScripts, 'guardrails:public-remote': undefined },
    { ciWorkflowText },
  );

  assert.deepEqual(result.errors, [
    'Final Completion Evidence is missing: Infrastructure status.',
    'package.json is missing required script: guardrails:public-remote',
  ]);
});

test('validateValidationRunbookContent rejects missing public remote guardrail credentials', () => {
  const result = validateValidationRunbookContent(
    validRunbook
      .replaceAll(
        'PUBLIC_EXPORT_GITHUB_APP_ID=<integration-id>',
        'PUBLIC_EXPORT_GITHUB_APP_ID=12345',
      )
      .replace('GITHUB_TOKEN=<admin-token>', 'GITHUB_TOKEN=token'),
    packageScripts,
    { ciWorkflowText },
  );

  assert.deepEqual(result.errors, [
    'Public remote guardrail commands must document PUBLIC_EXPORT_GITHUB_APP_ID=<integration-id>',
    'Public remote guardrail apply command must document GITHUB_TOKEN=<admin-token>',
  ]);
});

test('validateValidationRunbookContent rejects missing external gate evidence', () => {
  const result = validateValidationRunbookContent(
    validRunbook
      .replace('- A hosted GitHub Actions run is green.\n', '')
      .replace('- Deferred 2026-06-30 PayPal product decision remains documented.\n', ''),
    packageScripts,
    { ciWorkflowText },
  );

  assert.deepEqual(result.errors, [
    'Missing required external gate evidence: hosted GitHub Actions run is green',
    'Missing required external gate evidence: Deferred 2026-06-30 PayPal',
  ]);
});

test('validateValidationRunbookContent rejects coverage gate package script drift', () => {
  const result = validateValidationRunbookContent(
    validRunbook,
    {
      ...packageScripts,
      'test:unit': 'turbo run test:unit',
      'test:scripts': 'node --test scripts/__tests__/*.test.mjs',
    },
    { ciWorkflowText },
  );

  assert.deepEqual(result.errors, [
    'package.json script test:scripts must include validate:user-story-matrix',
    'package.json script test:scripts must include validate:final-evidence-checklist',
    'package.json script test:unit must include test:scripts',
  ]);
});

test('validateValidationRunbookContent rejects CI workflow coverage gate drift', () => {
  const result = validateValidationRunbookContent(validRunbook, packageScripts, {
    ciWorkflowText: ciWorkflowText
      .replace('name: Unit Tests', 'name: Fast Tests')
      .replace('bun run test:unit', 'bun run lint'),
  });

  assert.deepEqual(result.errors, ['CI workflow must emit the Unit Tests status check']);
});

test('validateValidationRunbookContent rejects misplaced CI coverage gate command', () => {
  const result = validateValidationRunbookContent(validRunbook, packageScripts, {
    ciWorkflowText: `name: CI

jobs:
  unit-tests:
    name: Unit Tests
    runs-on: ubuntu-latest
    steps:
      - run: bun run lint
  coverage-proxy:
    name: Coverage Proxy
    runs-on: ubuntu-latest
    steps:
      - run: bun run test:unit
`,
  });

  assert.deepEqual(result.errors, [
    'CI workflow Unit Tests job must run the root test:unit or test:scripts coverage gate',
  ]);
});
