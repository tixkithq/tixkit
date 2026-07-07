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
      .replace('| C-002 | P0 | WS9 | In progress | Hosted CI proof. | Needs hosted CI. |', '| C-001 | P0 | WS1 | Done | Local proof. | Done. |'),
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
