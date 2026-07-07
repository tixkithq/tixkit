import assert from 'node:assert/strict';
import test from 'node:test';
import { validateHighCareLedger } from '../validate-high-care-ledger.mjs';

function makeLedger(overrides = {}) {
  const rows = Array.from({ length: 8 }, (_, index) => {
    const id = `C-${String(91 + index).padStart(3, '0')}`;
    const nextAction = overrides[`${id}:nextAction`] ?? `Rerun ${id} proof after related changes.`;
    return {
      id,
      surface: `${id} surface`,
      status: overrides[`${id}:status`] ?? 'Covered',
      date: overrides[`${id}:date`] ?? '2026-06-30',
      owners: overrides[`${id}:owners`] ?? 'WS0, WS9',
      nextAction,
      detailNextAction: overrides[`${id}:detailNextAction`] ?? nextAction,
    };
  });

  return `# High-Care Platform Proof Ledger

## Summary

| Backlog | Surface | Status | Evidence date | Owner workstreams | Next action |
| ------- | ------- | ------ | ------------- | ----------------- | ----------- |
${rows.map((row) => `| ${row.id} | ${row.surface} | ${row.status} | ${row.date} | ${row.owners} | ${row.nextAction} |`).join('\n')}

## Surface Details

| Backlog | Current invariant | Primary failure modes | Required proof layers | Current blocker | Next action |
| ------- | ----------------- | --------------------- | --------------------- | --------------- | ----------- |
${rows.map((row) => `| ${row.id} | Invariant. | Failure mode. | Unit and browser proof. | None. | ${row.detailNextAction} |`).join('\n')}
`;
}

test('validateHighCareLedger accepts complete C-091..C-098 coverage rows', () => {
  const result = validateHighCareLedger(makeLedger());
  assert.deepEqual(result.errors, []);
  assert.equal(result.summaryRows.length, 8);
});

test('validateHighCareLedger rejects stale statuses and malformed dates', () => {
  const result = validateHighCareLedger(
    makeLedger({
      'C-093:status': 'Partial',
      'C-094:date': 'June 30',
      'C-095:owners': 'none',
    }),
  );

  assert.deepEqual(result.errors, [
    'C-093: high-care Summary status must be Covered or the backlog must be reopened',
    'C-094: Summary evidence date must be YYYY-MM-DD',
    'C-095: Summary owner workstreams must list WS### owners',
  ]);
});

test('validateHighCareLedger rejects summary/detail drift', () => {
  const result = validateHighCareLedger(
    makeLedger({
      'C-096:detailNextAction': 'Different next action.',
    }),
  );

  assert.deepEqual(result.errors, [
    'C-096: Summary next action does not match Surface Details next action',
  ]);
});
