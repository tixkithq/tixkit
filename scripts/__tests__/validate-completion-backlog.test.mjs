import assert from 'node:assert/strict';
import test from 'node:test';
import { validateCompletionBacklog } from '../validate-completion-backlog.mjs';

const validBacklog = `# Tixkit Completion Backlog

## Current Summary

- Total rows: 3.
- Status counts: Done 1, In progress 1, Open 0, Deferred 1, Partial 0.

## Non-Done Items

| ID | Priority | Workstream | Status | Task | Next action / acceptance focus |
| -- | -------- | ---------- | ------ | ---- | ------------------------------ |
| C-002 | P0 | WS9 | In progress | Hosted CI proof. | Needs hosted CI. |
| C-003 | P1 | WS2 | Deferred | PayPal. | Deferred 2026-06-30. |

## Task Ledger

| ID | Priority | Workstream | Status | Task | Evidence pointer |
| -- | -------- | ---------- | ------ | ---- | ---------------- |
| C-001 | P0 | WS1 | Done | Local proof. | Done. |
| C-002 | P0 | WS9 | In progress | Hosted CI proof. | Needs hosted CI. |
| C-003 | P1 | WS2 | Deferred | PayPal. | Deferred 2026-06-30. |
`;

test('validateCompletionBacklog accepts matching summary and non-done rows', () => {
  const result = validateCompletionBacklog(validBacklog);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ledgerRows.length, 3);
});

test('validateCompletionBacklog rejects stale counts and done rows in non-done table', () => {
  const result = validateCompletionBacklog(
    validBacklog
      .replace('Done 1, In progress 1', 'Done 2, In progress 0')
      .replace(
        '| C-002 | P0 | WS9 | In progress | Hosted CI proof. | Needs hosted CI. |',
        '| C-001 | P0 | WS1 | Done | Local proof. | Done. |',
      ),
  );

  assert.deepEqual(result.errors, [
    'Current Summary Done=2 does not match Task Ledger 1',
    'Current Summary In progress=0 does not match Task Ledger 1',
    'C-001: Done row must not appear in Non-Done Items',
    'C-002: non-Done Task Ledger row is missing from Non-Done Items',
  ]);
});

test('validateCompletionBacklog rejects non-done rows that disagree with the task ledger', () => {
  const result = validateCompletionBacklog(
    validBacklog.replace(
      '| C-002 | P0 | WS9 | In progress | Hosted CI proof. | Needs hosted CI. |',
      '| C-002 | P0 | WS9 | Open | Different task. | Needs hosted CI. |',
    ),
  );

  assert.deepEqual(result.errors, [
    'C-002: Non-Done status Open does not match Task Ledger In progress',
    'C-002: Non-Done task does not match Task Ledger task',
  ]);
});

test('validateCompletionBacklog rejects weak evidence for critical hosted gates', () => {
  const backlog = `# Tixkit Completion Backlog

## Current Summary

- Total rows: 6.
- Status counts: Done 0, In progress 5, Open 0, Deferred 1, Partial 0.

## Non-Done Items

| ID | Priority | Workstream | Status | Task | Next action / acceptance focus |
| -- | -------- | ---------- | ------ | ---- | ------------------------------ |
| C-035 | P0 | WS0 | In progress | Hosted CI. | Local scripts pass. |
| C-036 | P0 | WS9 | In progress | Stripe gates. | Provider tests pass locally. |
| C-037 | P0 | WS11 | In progress | Release and DR. | Local release rehearsal only. |
| C-069 | P0 | WS0 | In progress | Public remote. | Local guardrail generated. |
| C-071 | P1 | WS2 | Deferred | PayPal. | Deferred. |
| C-082 | P0 | WS9 | In progress | Matrix. | Local matrix validation only. |

## Task Ledger

| ID | Priority | Workstream | Status | Task | Evidence pointer |
| -- | -------- | ---------- | ------ | ---- | ---------------- |
| C-035 | P0 | WS0 | In progress | Hosted CI. | Local scripts pass. |
| C-036 | P0 | WS9 | In progress | Stripe gates. | Provider tests pass locally. |
| C-037 | P0 | WS11 | In progress | Release and DR. | Local release rehearsal only. |
| C-069 | P0 | WS0 | In progress | Public remote. | Local guardrail generated. |
| C-071 | P1 | WS2 | Deferred | PayPal. | Deferred. |
| C-082 | P0 | WS9 | In progress | Matrix. | Local matrix validation only. |
`;

  const result = validateCompletionBacklog(backlog);

  assert.deepEqual(result.errors, [
    'C-035: evidence must cite Trusted CI on EPYC and branch protection',
    'C-036: evidence must cite trusted-runner Stripe secrets and non-skipped provider gates',
    'C-037: evidence must cite trusted release dry-run, lab backup/restore, and migration rollback rehearsal',
    'C-069: evidence must cite public remote ruleset application with the export GitHub App as the only bypass actor',
    'C-071: evidence must cite dated PayPal deferral decision',
    'C-082: evidence must cite local matrix validation plus fresh Trusted CI proof',
    'C-035: evidence must cite Trusted CI on EPYC and branch protection',
    'C-036: evidence must cite trusted-runner Stripe secrets and non-skipped provider gates',
    'C-037: evidence must cite trusted release dry-run, lab backup/restore, and migration rollback rehearsal',
    'C-069: evidence must cite public remote ruleset application with the export GitHub App as the only bypass actor',
    'C-071: evidence must cite dated PayPal deferral decision',
    'C-082: evidence must cite local matrix validation plus fresh Trusted CI proof',
  ]);
});
