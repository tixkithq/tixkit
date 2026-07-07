import assert from 'node:assert/strict';
import test from 'node:test';
import { validateValidationRunbookContent } from '../validate-validation-runbook.mjs';

const packageScripts = {
  build: 'turbo run build',
  'export:oss': 'node scripts/export-oss.mjs',
  'guardrails:public-remote': 'node scripts/public-remote-guardrails.mjs',
  'validate:public-remote-guardrails': 'node scripts/public-remote-guardrails.mjs --check fixture.json',
  'test:scripts': 'node --test scripts/__tests__/*.test.mjs',
};

const validRunbook = `# Tixkit Validation Runbook

## Prerequisites

Use \`docs/completion/backlog.md\`.

## Baseline Safety Checks

\`\`\`bash
git status --short
graphify query "docs/completion/backlog.md scripts/export-oss.mjs .github/workflows/ci.yml" --budget 5000
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

## Open-Core Export Validation Gates (C-061..C-070)

Generate rules with \`PUBLIC_EXPORT_GITHUB_APP_ID=<integration-id> bun run guardrails:public-remote -- --print\`, verify with \`bun run validate:public-remote-guardrails\`, and apply with \`GITHUB_TOKEN=<admin-token> PUBLIC_EXPORT_GITHUB_APP_ID=<integration-id> bun run guardrails:public-remote -- --apply <owner>/<public-repo>\`.

## Final Completion Evidence

The final completion note must include:

- Git status summary.
- Infrastructure status.
- Migration status for Postgres and MySQL.
- Full command list run and pass/fail results.
- Any skipped tests and why they are acceptable or still blocking.
- Browser artifacts summary: screenshots, axe, no-console.
- Remaining risks or explicit deferrals.
- Confirmation that an anchored Graphify query was used for navigation and \`graphify update .\` was run after code changes.
`;

test('validateValidationRunbookContent accepts required sections, scripts, commands, and evidence bullets', () => {
  const result = validateValidationRunbookContent(validRunbook, packageScripts);

  assert.deepEqual(result.errors, []);
  assert.ok(result.referencedPaths.includes('docs/completion/backlog.md'));
  assert.ok(result.referencedPaths.includes('scripts/export-oss.mjs'));
  assert.ok(result.referencedPaths.includes('.github/workflows/ci.yml'));
});

test('validateValidationRunbookContent rejects missing final evidence and missing package scripts', () => {
  const result = validateValidationRunbookContent(
    validRunbook.replace('- Infrastructure status.\n', ''),
    { ...packageScripts, 'guardrails:public-remote': undefined },
  );

  assert.deepEqual(result.errors, [
    'Final Completion Evidence is missing: Infrastructure status.',
    'package.json is missing required script: guardrails:public-remote',
  ]);
});

test('validateValidationRunbookContent rejects missing public remote guardrail credentials', () => {
  const result = validateValidationRunbookContent(
    validRunbook
      .replaceAll('PUBLIC_EXPORT_GITHUB_APP_ID=<integration-id>', 'PUBLIC_EXPORT_GITHUB_APP_ID=12345')
      .replace('GITHUB_TOKEN=<admin-token>', 'GITHUB_TOKEN=token'),
    packageScripts,
  );

  assert.deepEqual(result.errors, [
    'Public remote guardrail commands must document PUBLIC_EXPORT_GITHUB_APP_ID=<integration-id>',
    'Public remote guardrail apply command must document GITHUB_TOKEN=<admin-token>',
  ]);
});
