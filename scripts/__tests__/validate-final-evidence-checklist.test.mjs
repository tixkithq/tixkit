import assert from 'node:assert/strict';
import test from 'node:test';
import { validateFinalEvidenceChecklist } from '../validate-final-evidence-checklist.mjs';

const validChecklist = `# Final Completion Evidence Checklist

| ID | Gate | Status | Required evidence | Current evidence / blocker |
| -- | ---- | ------ | ----------------- | -------------------------- |
| C-035 | Hosted CI and branch protection | Blocking | Hosted GitHub Actions run URL, required check names, and branch protection proof. | Blocking: GitHub Actions billing limits still prevent hosted CI runners. |
| C-036 | Hosted Stripe provider gates | Blocking | Hosted \`Provider Tests (Stripe)\` run URL and Step Summary proving \`STRIPE_SECRET_KEY\`, \`STRIPE_WEBHOOK_SECRET\`, \`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY\`, and \`STRIPE_CONNECT_CLIENT_ID\` were configured in GitHub Actions, provider gates passed without skips, and secret values were redacted. | Blocking: hosted Stripe test-mode secrets are not configured. |
| C-037 | Hosted release dry-run and managed DR | Blocking | Hosted \`.github/workflows/release-dry-run.yml\` run URL plus managed Postgres backup/restore, managed MySQL backup/restore, restore-based migration rollback rehearsal, and RPO/RTO evidence. | Blocking: hosted release dry-run and managed database rehearsal require hosted runners. |
| C-069 | Public remote human-push protection | Blocking | Applied public remote ruleset/API proof blocking direct human pushes and showing the export GitHub App as the only bypass actor. | Blocking: local guardrails pass but have not been applied to the public remote. |
| C-071 | PayPal deferral | Deferred | Dated 2026-06-30 PayPal/payment-provider abstraction decision. | Deferred 2026-06-30 product decision remains documented. |
| C-082 | User-story matrix final proof | Blocking | Fresh hosted CI run URL validating 100% user-story test coverage via the traceability matrix, \`bun run test:scripts\`, \`docs/completion/user-story-test-matrix.md\`, \`Validated 146 user-story rows\`, and \`78 evidence paths\` without cached Turbo-only proof. | Blocking: local matrix passes; fresh hosted CI proof depends on C-035. |

Do not mark the active goal complete until every row above is either \`Complete\` with concrete proof or \`Deferred\` with a dated product decision accepted by the completion backlog.
`;

const matchingBacklog = `# Tixkit Completion Backlog

## Current Summary

- Total rows: 6.
- Status counts: Done 0, In progress 5, Open 0, Deferred 1, Partial 0.

## Task Ledger

| ID | Priority | Workstream | Status | Task | Evidence pointer |
| -- | -------- | ---------- | ------ | ---- | ---------------- |
| C-035 | P0 | WS0 | In progress | Hosted CI. | Hosted CI remains externally blocked by GitHub Actions billing/spending limits. |
| C-036 | P0 | WS9 | In progress | Stripe gates. | Needs hosted Stripe test-mode secrets and non-skipped provider gates in GitHub Actions. |
| C-037 | P0 | WS11 | In progress | Release and DR. | Needs hosted release dry-run plus managed database backup/restore and migration rollback rehearsal. |
| C-069 | P0 | WS0 | In progress | Public remote. | Close after applying the generated public remote ruleset with the export GitHub App as the only bypass actor. |
| C-071 | P1 | WS2 | Deferred | PayPal. | Deferred by dated 2026-06-30 product decision for PayPal. |
| C-082 | P0 | WS9 | In progress | Matrix. | Local traceability matrix validation and test:scripts pass; close after fresh hosted CI proof. |
`;

const matchingRunbook = `# Validation Runbook

Hosted CI proof (C-035, C-036):

- A hosted GitHub Actions run is green for \`Lint & Typecheck\`, \`Build\`, \`Unit Tests\`, \`Integration Tests (PostgreSQL)\`, \`Integration Tests (MySQL)\`, \`E2E Browser Matrix (chromium)\`, \`E2E Browser Matrix (firefox)\`, and \`E2E Browser Matrix (webkit)\`.
- The hosted \`Provider Tests (Stripe)\` job runs, did not skip, and proves Stripe provider gates with configured \`STRIPE_SECRET_KEY\`, \`STRIPE_WEBHOOK_SECRET\`, \`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY\`, and \`STRIPE_CONNECT_CLIENT_ID\`. The GitHub Step Summary shows the provider secret gate was available, the Stripe provider tests passed, and secret values were redacted.
- Branch protection for \`refs/heads/main\` requires pull-request and required-status-check rules for the documented check names.

Release and DR truth-up (C-037):

- \`.github/workflows/release-dry-run.yml\` runs green.
- Managed Postgres backup, managed Postgres restore, managed MySQL backup, managed MySQL restore, and restore-based rollback are rehearsed with RPO/RTO evidence in \`docs/production-deployment-guide.md\` and \`docs/incident-runbooks.md\`.

Final coverage and deferred provider gates (C-071, C-082):

- Deferred 2026-06-30 PayPal product decision remains documented.
- C-082 closes only after fresh hosted CI validates the committed suite, \`docs/completion/user-story-test-matrix.md\`, \`Validated 146 user-story rows\`, and \`78 evidence paths\` without cached Turbo-only proof.

Before creating or updating any public OSS remote:

- The ruleset has the export GitHub App as the only bypass actor.
`;

const c035CompleteEvidence =
  'https://github.com/tixkit/tixkit/actions/runs/987654321 plus rulesets/98765 branch protection API proof for refs/heads/main requiring pull-request and required-status-check rules for Lint & Typecheck, Build, Unit Tests, Integration Tests (PostgreSQL), Integration Tests (MySQL), E2E Browser Matrix (chromium), E2E Browser Matrix (firefox), and E2E Browser Matrix (webkit).';
const c082CompleteEvidence =
  'Fresh hosted CI https://github.com/tixkit/tixkit/actions/runs/987654321 Unit Tests validates 100% user-story test coverage via the traceability matrix, `bun run test:scripts`, `docs/completion/user-story-test-matrix.md`, `Validated 146 user-story rows`, and `78 evidence paths` output without cached Turbo-only proof.';
const c082RequiredEvidence =
  'Fresh hosted CI run URL validating 100% user-story test coverage via the traceability matrix, `bun run test:scripts`, `docs/completion/user-story-test-matrix.md`, `Validated 146 user-story rows`, and `78 evidence paths` without cached Turbo-only proof.';
const c082BlockingRow = `| C-082 | User-story matrix final proof | Blocking | ${c082RequiredEvidence} | Blocking: local matrix passes; fresh hosted CI proof depends on C-035. |`;

test('validateFinalEvidenceChecklist accepts the current blocking checklist', () => {
  const result = validateFinalEvidenceChecklist(validChecklist, {
    backlogMarkdown: matchingBacklog,
  });

  assert.deepEqual(result.errors, []);
  assert.equal(result.rows.length, 6);
});

test('validateFinalEvidenceChecklist accepts checklist, backlog, and runbook in sync', () => {
  const result = validateFinalEvidenceChecklist(validChecklist, {
    backlogMarkdown: matchingBacklog,
    validationRunbookMarkdown: matchingRunbook,
  });

  assert.deepEqual(result.errors, []);
});

test('validateFinalEvidenceChecklist rejects checklist status drift from backlog', () => {
  const result = validateFinalEvidenceChecklist(
    validChecklist.replace(
      c082BlockingRow,
      `| C-082 | User-story matrix final proof | Complete | ${c082RequiredEvidence} | ${c082CompleteEvidence} |`,
    ),
    { backlogMarkdown: matchingBacklog },
  );

  assert.deepEqual(result.errors, [
    'C-082: checklist status Complete does not match completion backlog status In progress',
  ]);
});

test('validateFinalEvidenceChecklist accepts complete rows when backlog is done and proof exists', () => {
  const doneBacklog = matchingBacklog
    .replace('Done 0, In progress 5', 'Done 1, In progress 4')
    .replace('| C-035 | P0 | WS0 | In progress |', '| C-035 | P0 | WS0 | Done |');
  const result = validateFinalEvidenceChecklist(
    validChecklist.replace(
      '| C-035 | Hosted CI and branch protection | Blocking | Hosted GitHub Actions run URL, required check names, and branch protection proof. | Blocking: GitHub Actions billing limits still prevent hosted CI runners. |',
      `| C-035 | Hosted CI and branch protection | Complete | Hosted GitHub Actions run URL, required check names, and branch protection proof. | ${c035CompleteEvidence} |`,
    ),
    { backlogMarkdown: doneBacklog },
  );

  assert.deepEqual(result.errors, []);
});

test('validateFinalEvidenceChecklist rejects missing required gate rows', () => {
  const result = validateFinalEvidenceChecklist(validChecklist.replace(`${c082BlockingRow}\n`, ''));

  assert.deepEqual(result.errors, ['C-082: missing final evidence row']);
});

test('validateFinalEvidenceChecklist rejects malformed required gate ids', () => {
  const result = validateFinalEvidenceChecklist(
    validChecklist.replace(c082BlockingRow, c082BlockingRow.replace('C-082', 'C082')),
  );

  assert.equal(result.errors.length, 2);
  assert.ok(
    result.errors.some((error) =>
      /^Malformed final evidence row: line \d+: final evidence row id must use C-### format: C082$/.test(
        error,
      ),
    ),
  );
  assert.ok(result.errors.includes('C-082: missing final evidence row'));
});

test('validateFinalEvidenceChecklist rejects malformed required gate rows', () => {
  const result = validateFinalEvidenceChecklist(
    validChecklist.replace(
      c082BlockingRow,
      '| C-082 | User-story matrix final proof | Blocking | Missing current evidence column |',
    ),
  );

  assert.equal(result.errors.length, 2);
  assert.ok(
    result.errors.some((error) =>
      /^Malformed final evidence row: line \d+: final evidence row C-082 must have 5 columns$/.test(
        error,
      ),
    ),
  );
  assert.ok(result.errors.includes('C-082: missing final evidence row'));
});

test('validateFinalEvidenceChecklist rejects final evidence rows with extra columns', () => {
  const result = validateFinalEvidenceChecklist(
    validChecklist.replace(
      c082BlockingRow,
      `${c082BlockingRow.replace(/ \\|$/, ' | Extra proof drift |')}`,
    ),
  );

  assert.equal(result.errors.length, 2);
  assert.ok(
    result.errors.some((error) =>
      /^Malformed final evidence row: line \d+: final evidence row C-082 must have 5 columns$/.test(
        error,
      ),
    ),
  );
  assert.ok(result.errors.includes('C-082: missing final evidence row'));
});

test('validateFinalEvidenceChecklist rejects blank final evidence cells', () => {
  const result = validateFinalEvidenceChecklist(
    validChecklist.replace(
      c082BlockingRow,
      `| C-082 |  | Blocking | ${c082RequiredEvidence} | Blocking: local matrix passes; fresh hosted CI proof depends on C-035. |`,
    ),
  );

  assert.deepEqual(result.errors, ['C-082: gate must not be empty']);
});

test('validateFinalEvidenceChecklist rejects non-done backlog rows missing from the checklist', () => {
  const expandedBacklog = matchingBacklog
    .replace('Total rows: 6.', 'Total rows: 7.')
    .replace('Done 0, In progress 5', 'Done 0, In progress 6')
    .replace(
      '| C-082 | P0 | WS9 | In progress | Matrix. | Local traceability matrix validation and test:scripts pass; close after fresh hosted CI proof. |',
      '| C-082 | P0 | WS9 | In progress | Matrix. | Local traceability matrix validation and test:scripts pass; close after fresh hosted CI proof. |\n| C-099 | P0 | WS9 | In progress | New final blocker. | Needs hosted proof. |',
    );
  const result = validateFinalEvidenceChecklist(validChecklist, {
    backlogMarkdown: expandedBacklog,
  });

  assert.deepEqual(result.errors, [
    'C-099: non-Done completion backlog row is missing from final evidence checklist',
  ]);
});

test('validateFinalEvidenceChecklist rejects checklist rows without backlog scope', () => {
  const expandedChecklist = validChecklist.replace(
    c082BlockingRow,
    `${c082BlockingRow}\n| C-099 | Extra gate | Blocking | Hosted proof. | Blocking: needs hosted proof. |`,
  );
  const result = validateFinalEvidenceChecklist(expandedChecklist, {
    backlogMarkdown: matchingBacklog,
  });

  assert.deepEqual(result.errors, [
    'C-099: final evidence row has no matching completion backlog item',
  ]);
});

test('validateFinalEvidenceChecklist rejects done backlog rows in the final checklist', () => {
  const expandedChecklist = validChecklist.replace(
    c082BlockingRow,
    `${c082BlockingRow}\n| C-099 | Extra done gate | Complete | Hosted proof. | https://github.com/tixkit/tixkit/actions/runs/987654321 proof. |`,
  );
  const expandedBacklog = matchingBacklog
    .replace('Total rows: 6.', 'Total rows: 7.')
    .replace('Done 0, In progress 5', 'Done 1, In progress 5')
    .replace(
      '| C-082 | P0 | WS9 | In progress | Matrix. | Local traceability matrix validation and test:scripts pass; close after fresh hosted CI proof. |',
      '| C-082 | P0 | WS9 | In progress | Matrix. | Local traceability matrix validation and test:scripts pass; close after fresh hosted CI proof. |\n| C-099 | P3 | WS9 | Done | Already closed. | Done; no final external blocker remains. |',
    );
  const result = validateFinalEvidenceChecklist(expandedChecklist, {
    backlogMarkdown: expandedBacklog,
  });

  assert.deepEqual(result.errors, [
    'C-099: Done completion backlog rows do not belong in final evidence checklist',
  ]);
});

test('validateFinalEvidenceChecklist rejects complete rows without external proof', () => {
  const result = validateFinalEvidenceChecklist(
    validChecklist.replace(
      '| C-035 | Hosted CI and branch protection | Blocking | Hosted GitHub Actions run URL, required check names, and branch protection proof. | Blocking: GitHub Actions billing limits still prevent hosted CI runners. |',
      '| C-035 | Hosted CI and branch protection | Complete | Hosted GitHub Actions run URL, required check names, and branch protection proof. | Local scripts pass; blocked by hosted runners. |',
    ),
  );

  assert.deepEqual(result.errors, [
    'C-035: Complete rows must cite concrete external proof',
    'C-035: Complete evidence does not prove https:\\/\\/github\\.com\\/\\S+\\/actions\\/runs\\/\\d+',
    'C-035: Complete evidence does not prove branch protection API|rulesets?\\/\\d+',
    'C-035: Complete evidence does not prove refs\\/heads\\/main|main branch',
    'C-035: Complete evidence does not prove pull-request',
    'C-035: Complete evidence does not prove required-status-check|required status checks',
    'C-035: Complete evidence does not prove Lint & Typecheck',
    'C-035: Complete evidence does not prove Build',
    'C-035: Complete evidence does not prove Unit Tests',
    'C-035: Complete evidence does not prove Integration Tests \\(PostgreSQL\\)',
    'C-035: Complete evidence does not prove Integration Tests \\(MySQL\\)',
    'C-035: Complete evidence does not prove E2E Browser Matrix \\(chromium\\)',
    'C-035: Complete evidence does not prove E2E Browser Matrix \\(firefox\\)',
    'C-035: Complete evidence does not prove E2E Browser Matrix \\(webkit\\)',
    'C-035: Complete rows must not retain blocking language',
  ]);
});

test('validateFinalEvidenceChecklist rejects generic proof for row-specific complete gates', () => {
  const result = validateFinalEvidenceChecklist(
    validChecklist.replace(
      '| C-036 | Hosted Stripe provider gates | Blocking | Hosted `Provider Tests (Stripe)` run URL and Step Summary proving `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, and `STRIPE_CONNECT_CLIENT_ID` were configured in GitHub Actions, provider gates passed without skips, and secret values were redacted. | Blocking: hosted Stripe test-mode secrets are not configured. |',
      '| C-036 | Hosted Stripe provider gates | Complete | Hosted `Provider Tests (Stripe)` run URL and Step Summary proving `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, and `STRIPE_CONNECT_CLIENT_ID` were configured in GitHub Actions, provider gates passed without skips, and secret values were redacted. | https://github.com/tixkit/tixkit/actions/runs/987654321 plus generic branch protection API proof. |',
    ),
  );

  assert.deepEqual(result.errors, [
    'C-036: Complete evidence does not prove Provider Tests \\(Stripe\\)',
    'C-036: Complete evidence does not prove provider-secrets available=true|all CI-managed test-mode secrets configured|no missing CI-managed test-mode secrets',
    'C-036: Complete evidence does not prove STRIPE_SECRET_KEY',
    'C-036: Complete evidence does not prove STRIPE_WEBHOOK_SECRET',
    'C-036: Complete evidence does not prove NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY',
    'C-036: Complete evidence does not prove STRIPE_CONNECT_CLIENT_ID',
    'C-036: Complete evidence does not prove Stripe provider tests passed',
    'C-036: Complete evidence does not prove Run direct Stripe provider workflow test|Direct Stripe create\\/confirm\\/refund activity validation ran',
    'C-036: Complete evidence does not prove Run hosted Stripe Elements browser test|Hosted Stripe Elements checkout\\/refund browser validation ran',
    'C-036: Complete evidence does not prove Run Stripe Connect provider test|Stripe Connect account creation\\/status refresh validation ran',
    'C-036: Complete evidence does not prove did not skip|non-skipped',
    'C-036: Complete evidence does not prove secret values redacted|masked secret values|no secret values',
  ]);
});

test('validateFinalEvidenceChecklist rejects blocking rows that already contain external proof', () => {
  const result = validateFinalEvidenceChecklist(
    validChecklist.replace(
      '| C-035 | Hosted CI and branch protection | Blocking | Hosted GitHub Actions run URL, required check names, and branch protection proof. | Blocking: GitHub Actions billing limits still prevent hosted CI runners. |',
      '| C-035 | Hosted CI and branch protection | Blocking | Hosted GitHub Actions run URL, required check names, and branch protection proof. | Blocking: https://github.com/tixkit/tixkit/actions/runs/987654321 is available but status was not advanced. |',
    ),
  );

  assert.deepEqual(result.errors, [
    'C-035: non-complete rows must not contain concrete external proof',
    'C-035: non-complete rows must document the current blocker or deferral',
  ]);
});

test('validateFinalEvidenceChecklist accepts complete rows with concrete proof', () => {
  const result = validateFinalEvidenceChecklist(
    validChecklist.replace(
      '| C-035 | Hosted CI and branch protection | Blocking | Hosted GitHub Actions run URL, required check names, and branch protection proof. | Blocking: GitHub Actions billing limits still prevent hosted CI runners. |',
      `| C-035 | Hosted CI and branch protection | Complete | Hosted GitHub Actions run URL, required check names, and branch protection proof. | ${c035CompleteEvidence} |`,
    ),
  );

  assert.deepEqual(result.errors, []);
});

test('validateFinalEvidenceChecklist rejects placeholder external proof URLs', () => {
  const result = validateFinalEvidenceChecklist(
    validChecklist.replace(
      '| C-035 | Hosted CI and branch protection | Blocking | Hosted GitHub Actions run URL, required check names, and branch protection proof. | Blocking: GitHub Actions billing limits still prevent hosted CI runners. |',
      '| C-035 | Hosted CI and branch protection | Complete | Hosted GitHub Actions run URL, required check names, and branch protection proof. | https://github.com/acme/tixkit/actions/runs/123456789 plus rulesets/98765 branch protection API proof for refs/heads/main requiring pull-request and required-status-check rules for Lint & Typecheck, Build, Unit Tests, Integration Tests (PostgreSQL), Integration Tests (MySQL), E2E Browser Matrix (chromium), E2E Browser Matrix (firefox), and E2E Browser Matrix (webkit). |',
    ),
  );

  assert.deepEqual(result.errors, [
    'C-035: current evidence must not use placeholder proof (placeholder GitHub owner)',
  ]);
});

test('validateFinalEvidenceChecklist rejects C-035 completion without main branch protection rules', () => {
  const result = validateFinalEvidenceChecklist(
    validChecklist.replace(
      '| C-035 | Hosted CI and branch protection | Blocking | Hosted GitHub Actions run URL, required check names, and branch protection proof. | Blocking: GitHub Actions billing limits still prevent hosted CI runners. |',
      '| C-035 | Hosted CI and branch protection | Complete | Hosted GitHub Actions run URL, required check names, and branch protection proof. | https://github.com/tixkit/tixkit/actions/runs/987654321 plus rulesets/98765 branch protection API proof requiring Lint & Typecheck, Build, Unit Tests, Integration Tests (PostgreSQL), Integration Tests (MySQL), E2E Browser Matrix (chromium), E2E Browser Matrix (firefox), and E2E Browser Matrix (webkit). |',
    ),
  );

  assert.deepEqual(result.errors, [
    'C-035: Complete evidence does not prove refs\\/heads\\/main|main branch',
    'C-035: Complete evidence does not prove pull-request',
    'C-035: Complete evidence does not prove required-status-check|required status checks',
  ]);
});

test('validateFinalEvidenceChecklist accepts C-036 completion with all provider gates named', () => {
  const result = validateFinalEvidenceChecklist(
    validChecklist.replace(
      '| C-036 | Hosted Stripe provider gates | Blocking | Hosted `Provider Tests (Stripe)` run URL and Step Summary proving `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, and `STRIPE_CONNECT_CLIENT_ID` were configured in GitHub Actions, provider gates passed without skips, and secret values were redacted. | Blocking: hosted Stripe test-mode secrets are not configured. |',
      '| C-036 | Hosted Stripe provider gates | Complete | Hosted `Provider Tests (Stripe)` run URL and Step Summary proving `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, and `STRIPE_CONNECT_CLIENT_ID` were configured in GitHub Actions, provider gates passed without skips, and secret values were redacted. | https://github.com/tixkit/tixkit/actions/runs/987654321 Provider Tests (Stripe) Step Summary: provider-secrets available=true, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY, and STRIPE_CONNECT_CLIENT_ID were configured. Stripe provider tests passed. Direct Stripe create/confirm/refund activity validation ran. Hosted Stripe Elements checkout/refund browser validation ran. Stripe Connect account creation/status refresh validation ran. Provider gates were non-skipped and secret values redacted. |',
    ),
  );

  assert.deepEqual(result.errors, []);
});

test('validateFinalEvidenceChecklist rejects C-036 completion without secret-gate and redaction proof', () => {
  const result = validateFinalEvidenceChecklist(
    validChecklist.replace(
      '| C-036 | Hosted Stripe provider gates | Blocking | Hosted `Provider Tests (Stripe)` run URL and Step Summary proving `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, and `STRIPE_CONNECT_CLIENT_ID` were configured in GitHub Actions, provider gates passed without skips, and secret values were redacted. | Blocking: hosted Stripe test-mode secrets are not configured. |',
      '| C-036 | Hosted Stripe provider gates | Complete | Hosted `Provider Tests (Stripe)` run URL and Step Summary proving `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, and `STRIPE_CONNECT_CLIENT_ID` were configured in GitHub Actions, provider gates passed without skips, and secret values were redacted. | https://github.com/tixkit/tixkit/actions/runs/987654321 Provider Tests (Stripe) Step Summary: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY, and STRIPE_CONNECT_CLIENT_ID were present. Stripe provider tests passed. Direct Stripe create/confirm/refund activity validation ran. Hosted Stripe Elements checkout/refund browser validation ran. Stripe Connect account creation/status refresh validation ran. Provider gates were non-skipped. |',
    ),
  );

  assert.deepEqual(result.errors, [
    'C-036: Complete evidence does not prove provider-secrets available=true|all CI-managed test-mode secrets configured|no missing CI-managed test-mode secrets',
    'C-036: Complete evidence does not prove secret values redacted|masked secret values|no secret values',
  ]);
});

test('validateFinalEvidenceChecklist rejects raw secret values in current evidence', () => {
  const result = validateFinalEvidenceChecklist(
    validChecklist.replace(
      '| C-036 | Hosted Stripe provider gates | Blocking | Hosted `Provider Tests (Stripe)` run URL and Step Summary proving `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, and `STRIPE_CONNECT_CLIENT_ID` were configured in GitHub Actions, provider gates passed without skips, and secret values were redacted. | Blocking: hosted Stripe test-mode secrets are not configured. |',
      '| C-036 | Hosted Stripe provider gates | Complete | Hosted `Provider Tests (Stripe)` run URL and Step Summary proving `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, and `STRIPE_CONNECT_CLIENT_ID` were configured in GitHub Actions, provider gates passed without skips, and secret values were redacted. | https://github.com/tixkit/tixkit/actions/runs/987654321 Provider Tests (Stripe) Step Summary: provider-secrets available=true, STRIPE_SECRET_KEY=sk_test_1234567890abcdef1234567890abcdef, STRIPE_WEBHOOK_SECRET, NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY, and STRIPE_CONNECT_CLIENT_ID were configured. Stripe provider tests passed. Direct Stripe create/confirm/refund activity validation ran. Hosted Stripe Elements checkout/refund browser validation ran. Stripe Connect account creation/status refresh validation ran. Provider gates were non-skipped and secret values redacted. |',
    ),
  );

  assert.deepEqual(result.errors, [
    'C-036: current evidence must not include raw secret value (Stripe secret key)',
  ]);
});

test('validateFinalEvidenceChecklist rejects raw GitHub tokens in current evidence', () => {
  const result = validateFinalEvidenceChecklist(
    validChecklist.replace(
      '| C-069 | Public remote human-push protection | Blocking | Applied public remote ruleset/API proof blocking direct human pushes and showing the export GitHub App as the only bypass actor. | Blocking: local guardrails pass but have not been applied to the public remote. |',
      '| C-069 | Public remote human-push protection | Blocking | Applied public remote ruleset/API proof blocking direct human pushes and showing the export GitHub App as the only bypass actor. | Blocking: local guardrails pass but GITHUB_TOKEN=gho_1234567890abcdef1234567890abcdef1234 was pasted into the evidence. |',
    ),
  );

  assert.deepEqual(result.errors, [
    'C-069: current evidence must not include raw secret value (GitHub token)',
    'C-069: non-complete rows must document the current blocker or deferral',
  ]);
});

test('validateFinalEvidenceChecklist accepts C-037 completion with managed DR proof', () => {
  const result = validateFinalEvidenceChecklist(
    validChecklist.replace(
      '| C-037 | Hosted release dry-run and managed DR | Blocking | Hosted `.github/workflows/release-dry-run.yml` run URL plus managed Postgres backup/restore, managed MySQL backup/restore, restore-based migration rollback rehearsal, and RPO/RTO evidence. | Blocking: hosted release dry-run and managed database rehearsal require hosted runners. |',
      '| C-037 | Hosted release dry-run and managed DR | Complete | Hosted `.github/workflows/release-dry-run.yml` run URL plus managed Postgres backup/restore, managed MySQL backup/restore, restore-based migration rollback rehearsal, and RPO/RTO evidence. | https://github.com/tixkit/tixkit/actions/runs/987654321 proves `.github/workflows/release-dry-run.yml`, managed Postgres backup, managed Postgres restore, managed MySQL backup, managed MySQL restore, restore-based rollback, migration rollback rehearsal, RPO/RTO, `docs/production-deployment-guide.md`, and `docs/incident-runbooks.md`. |',
    ),
  );

  assert.deepEqual(result.errors, []);
});

test('validateFinalEvidenceChecklist rejects C-035 completion without required check names', () => {
  const result = validateFinalEvidenceChecklist(
    validChecklist.replace(
      '| C-035 | Hosted CI and branch protection | Blocking | Hosted GitHub Actions run URL, required check names, and branch protection proof. | Blocking: GitHub Actions billing limits still prevent hosted CI runners. |',
      '| C-035 | Hosted CI and branch protection | Complete | Hosted GitHub Actions run URL, required check names, and branch protection proof. | https://github.com/tixkit/tixkit/actions/runs/987654321 plus branch protection API proof for refs/heads/main requiring pull-request and required-status-check rules. |',
    ),
  );

  assert.deepEqual(result.errors, [
    'C-035: Complete evidence does not prove Lint & Typecheck',
    'C-035: Complete evidence does not prove Build',
    'C-035: Complete evidence does not prove Unit Tests',
    'C-035: Complete evidence does not prove Integration Tests \\(PostgreSQL\\)',
    'C-035: Complete evidence does not prove Integration Tests \\(MySQL\\)',
    'C-035: Complete evidence does not prove E2E Browser Matrix \\(chromium\\)',
    'C-035: Complete evidence does not prove E2E Browser Matrix \\(firefox\\)',
    'C-035: Complete evidence does not prove E2E Browser Matrix \\(webkit\\)',
  ]);
});

test('validateFinalEvidenceChecklist rejects C-037 completion with generic DR proof', () => {
  const result = validateFinalEvidenceChecklist(
    validChecklist.replace(
      '| C-037 | Hosted release dry-run and managed DR | Blocking | Hosted `.github/workflows/release-dry-run.yml` run URL plus managed Postgres backup/restore, managed MySQL backup/restore, restore-based migration rollback rehearsal, and RPO/RTO evidence. | Blocking: hosted release dry-run and managed database rehearsal require hosted runners. |',
      '| C-037 | Hosted release dry-run and managed DR | Complete | Hosted `.github/workflows/release-dry-run.yml` run URL plus managed Postgres backup/restore, managed MySQL backup/restore, restore-based migration rollback rehearsal, and RPO/RTO evidence. | https://github.com/tixkit/tixkit/actions/runs/987654321 proves `.github/workflows/release-dry-run.yml`, managed database backup, restore, migration rollback, and RPO/RTO. |',
    ),
  );

  assert.deepEqual(result.errors, [
    'C-037: Complete evidence does not prove managed Postgres',
    'C-037: Complete evidence does not prove managed MySQL',
    'C-037: Complete evidence does not prove managed Postgres[^,.;|]*backup|Postgres backup',
    'C-037: Complete evidence does not prove managed Postgres[^,.;|]*restore|Postgres restore',
    'C-037: Complete evidence does not prove managed MySQL[^,.;|]*backup|MySQL backup',
    'C-037: Complete evidence does not prove managed MySQL[^,.;|]*restore|MySQL restore',
    'C-037: Complete evidence does not prove restore-based rollback|restore based rollback',
    'C-037: Complete evidence does not prove docs\\/production-deployment-guide\\.md',
    'C-037: Complete evidence does not prove docs\\/incident-runbooks\\.md',
  ]);
});

test('validateFinalEvidenceChecklist rejects C-037 completion without per-database restore proof', () => {
  const result = validateFinalEvidenceChecklist(
    validChecklist.replace(
      '| C-037 | Hosted release dry-run and managed DR | Blocking | Hosted `.github/workflows/release-dry-run.yml` run URL plus managed Postgres backup/restore, managed MySQL backup/restore, restore-based migration rollback rehearsal, and RPO/RTO evidence. | Blocking: hosted release dry-run and managed database rehearsal require hosted runners. |',
      '| C-037 | Hosted release dry-run and managed DR | Complete | Hosted `.github/workflows/release-dry-run.yml` run URL plus managed Postgres backup/restore, managed MySQL backup/restore, restore-based migration rollback rehearsal, and RPO/RTO evidence. | https://github.com/tixkit/tixkit/actions/runs/987654321 proves `.github/workflows/release-dry-run.yml`, managed Postgres backup, managed MySQL backup, restore-based rollback, migration rollback rehearsal, RPO/RTO, `docs/production-deployment-guide.md`, and `docs/incident-runbooks.md`. |',
    ),
  );

  assert.deepEqual(result.errors, [
    'C-037: Complete evidence does not prove managed Postgres[^,.;|]*restore|Postgres restore',
    'C-037: Complete evidence does not prove managed MySQL[^,.;|]*restore|MySQL restore',
  ]);
});

test('validateFinalEvidenceChecklist accepts C-069 completion with applied public ruleset proof', () => {
  const result = validateFinalEvidenceChecklist(
    validChecklist.replace(
      '| C-069 | Public remote human-push protection | Blocking | Applied public remote ruleset/API proof blocking direct human pushes and showing the export GitHub App as the only bypass actor. | Blocking: local guardrails pass but have not been applied to the public remote. |',
      '| C-069 | Public remote human-push protection | Complete | Applied public remote ruleset/API proof blocking direct human pushes and showing the export GitHub App as the only bypass actor. | rulesets/12345 API proof for refs/heads/main shows active update, deletion, non-fast-forward, pull-request, required-status-check rules, the export GitHub App as the only bypass actor, and no human bypass actors. |',
    ),
  );

  assert.deepEqual(result.errors, []);
});

test('validateFinalEvidenceChecklist rejects C-069 completion without branch and human-bypass proof', () => {
  const result = validateFinalEvidenceChecklist(
    validChecklist.replace(
      '| C-069 | Public remote human-push protection | Blocking | Applied public remote ruleset/API proof blocking direct human pushes and showing the export GitHub App as the only bypass actor. | Blocking: local guardrails pass but have not been applied to the public remote. |',
      '| C-069 | Public remote human-push protection | Complete | Applied public remote ruleset/API proof blocking direct human pushes and showing the export GitHub App as the only bypass actor. | rulesets/12345 API proof shows active update, deletion, non-fast-forward, pull-request, required-status-check rules and the export GitHub App as the only bypass actor. |',
    ),
  );

  assert.deepEqual(result.errors, [
    'C-069: Complete evidence does not prove refs\\/heads\\/main',
    'C-069: Complete evidence does not prove no human bypass actors|without human bypass actors',
  ]);
});

test('validateFinalEvidenceChecklist rejects C-082 completion without row-count validator proof', () => {
  const result = validateFinalEvidenceChecklist(
    validChecklist.replace(
      c082BlockingRow,
      `| C-082 | User-story matrix final proof | Complete | ${c082RequiredEvidence} | Fresh hosted CI https://github.com/tixkit/tixkit/actions/runs/987654321 validates 100% user-story test coverage via the traceability matrix, \`bun run test:scripts\`, and \`docs/completion/user-story-test-matrix.md\` without cached Turbo-only proof. |`,
    ),
  );

  assert.deepEqual(result.errors, [
    'C-082: Complete evidence does not prove Unit Tests',
    'C-082: Complete evidence does not prove Validated 146 user-story rows',
    'C-082: Complete evidence does not prove 78 evidence paths',
  ]);
});

test('validateFinalEvidenceChecklist rejects C-082 completion with only cached proof', () => {
  const result = validateFinalEvidenceChecklist(
    validChecklist.replace(
      c082BlockingRow,
      `| C-082 | User-story matrix final proof | Complete | ${c082RequiredEvidence} | Fresh hosted CI https://github.com/tixkit/tixkit/actions/runs/987654321 Unit Tests validates 100% user-story test coverage via the traceability matrix, \`bun run test:scripts\`, \`docs/completion/user-story-test-matrix.md\`, \`Validated 146 user-story rows\`, and \`78 evidence paths\` output. |`,
    ),
  );

  assert.deepEqual(result.errors, [
    'C-082: Complete evidence does not prove without cached Turbo-only proof|no cached Turbo-only proof|cache disabled|turbo --force',
  ]);
});

test('validateFinalEvidenceChecklist rejects rows that lose backlog scope', () => {
  const result = validateFinalEvidenceChecklist(
    validChecklist.replace(
      '| C-069 | Public remote human-push protection | Blocking | Applied public remote ruleset/API proof blocking direct human pushes and showing the export GitHub App as the only bypass actor. | Blocking: local guardrails pass but have not been applied to the public remote. |',
      '| C-069 | Repository settings | Blocking | Applied settings proof showing the export GitHub App as the only bypass actor. | Blocking: local guardrails pass but have not been applied yet. |',
    ),
    { backlogMarkdown: matchingBacklog },
  );

  assert.deepEqual(result.errors, [
    'C-069: final evidence row does not preserve backlog scope direct human pushes|human-push|public remote',
    'C-069: required evidence does not name public remote ruleset|ruleset\\/API proof',
    'C-069: non-complete rows must document the current blocker or deferral',
  ]);
});

test('validateFinalEvidenceChecklist rejects runbook drift for final gates', () => {
  const result = validateFinalEvidenceChecklist(validChecklist, {
    backlogMarkdown: matchingBacklog,
    validationRunbookMarkdown: matchingRunbook.replace(
      '- C-082 closes only after fresh hosted CI validates the committed suite, `docs/completion/user-story-test-matrix.md`, `Validated 146 user-story rows`, and `78 evidence paths` without cached Turbo-only proof.',
      '- Local matrix validation is enough.',
    ),
  });

  assert.deepEqual(result.errors, [
    'C-082: validation runbook is missing final evidence proof term fresh hosted CI',
    'C-082: validation runbook is missing final evidence proof term user-story-test-matrix\\.md',
    'C-082: validation runbook is missing final evidence proof term Validated 146 user-story rows',
    'C-082: validation runbook is missing final evidence proof term 78 evidence paths',
    'C-082: validation runbook is missing final evidence proof term without cached Turbo-only proof|no cached Turbo-only proof|cache disabled|turbo --force',
  ]);
});

test('validateFinalEvidenceChecklist rejects C-035 runbook drift from exact hosted CI checks', () => {
  const result = validateFinalEvidenceChecklist(validChecklist, {
    backlogMarkdown: matchingBacklog,
    validationRunbookMarkdown: matchingRunbook
      .replace(
        '- A hosted GitHub Actions run is green for `Lint & Typecheck`, `Build`, `Unit Tests`, `Integration Tests (PostgreSQL)`, `Integration Tests (MySQL)`, `E2E Browser Matrix (chromium)`, `E2E Browser Matrix (firefox)`, and `E2E Browser Matrix (webkit)`.',
        '- A hosted GitHub Actions run is green for lint, typecheck, build, unit, integration, and browser tests.',
      )
      .replace(
        '- Branch protection for `refs/heads/main` requires pull-request and required-status-check rules for the documented check names.',
        '- Branch protection for `main` requires the documented check names.',
      ),
  });

  assert.deepEqual(result.errors, [
    'C-035: validation runbook is missing final evidence proof term Lint & Typecheck',
    'C-035: validation runbook is missing final evidence proof term Build',
    'C-035: validation runbook is missing final evidence proof term Unit Tests',
    'C-035: validation runbook is missing final evidence proof term Integration Tests \\(PostgreSQL\\)',
    'C-035: validation runbook is missing final evidence proof term Integration Tests \\(MySQL\\)',
    'C-035: validation runbook is missing final evidence proof term E2E Browser Matrix \\(chromium\\)',
    'C-035: validation runbook is missing final evidence proof term E2E Browser Matrix \\(firefox\\)',
    'C-035: validation runbook is missing final evidence proof term E2E Browser Matrix \\(webkit\\)',
    'C-035: validation runbook is missing final evidence proof term refs\\/heads\\/main',
    'C-035: validation runbook is missing final evidence proof term pull-request',
    'C-035: validation runbook is missing final evidence proof term required-status-check',
  ]);
});

test('validateFinalEvidenceChecklist rejects C-036 runbook drift from Stripe proof requirements', () => {
  const result = validateFinalEvidenceChecklist(validChecklist, {
    backlogMarkdown: matchingBacklog,
    validationRunbookMarkdown: matchingRunbook.replace(
      '- The hosted `Provider Tests (Stripe)` job runs, did not skip, and proves Stripe provider gates with configured `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, and `STRIPE_CONNECT_CLIENT_ID`. The GitHub Step Summary shows the provider secret gate was available, the Stripe provider tests passed, and secret values were redacted.',
      '- The hosted `Provider Tests (Stripe)` job runs and proves Stripe provider gates.',
    ),
  });

  assert.deepEqual(result.errors, [
    'C-036: validation runbook is missing final evidence proof term STRIPE_SECRET_KEY',
    'C-036: validation runbook is missing final evidence proof term STRIPE_WEBHOOK_SECRET',
    'C-036: validation runbook is missing final evidence proof term NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY',
    'C-036: validation runbook is missing final evidence proof term STRIPE_CONNECT_CLIENT_ID',
    'C-036: validation runbook is missing final evidence proof term GitHub Step Summary',
    'C-036: validation runbook is missing final evidence proof term provider secret gate was available',
    'C-036: validation runbook is missing final evidence proof term Stripe provider tests passed',
    'C-036: validation runbook is missing final evidence proof term secret values were redacted',
    'C-036: validation runbook is missing final evidence proof term does not skip|did not skip',
  ]);
});

test('validateFinalEvidenceChecklist rejects C-037 runbook drift from managed DR proof requirements', () => {
  const result = validateFinalEvidenceChecklist(validChecklist, {
    backlogMarkdown: matchingBacklog,
    validationRunbookMarkdown: matchingRunbook.replace(
      '- Managed Postgres backup, managed Postgres restore, managed MySQL backup, managed MySQL restore, and restore-based rollback are rehearsed with RPO/RTO evidence in `docs/production-deployment-guide.md` and `docs/incident-runbooks.md`.',
      '- Managed database backup and rollback are rehearsed.',
    ),
  });

  assert.deepEqual(result.errors, [
    'C-037: validation runbook is missing final evidence proof term managed Postgres backup',
    'C-037: validation runbook is missing final evidence proof term managed Postgres restore',
    'C-037: validation runbook is missing final evidence proof term managed MySQL backup',
    'C-037: validation runbook is missing final evidence proof term managed MySQL restore',
    'C-037: validation runbook is missing final evidence proof term restore-based rollback',
    'C-037: validation runbook is missing final evidence proof term RPO\\/RTO',
    'C-037: validation runbook is missing final evidence proof term docs\\/production-deployment-guide\\.md',
    'C-037: validation runbook is missing final evidence proof term docs\\/incident-runbooks\\.md',
  ]);
});
