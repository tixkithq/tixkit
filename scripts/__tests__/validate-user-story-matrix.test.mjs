import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectEvidenceReferences,
  extractCompletionBacklogIds,
  extractCompletionBacklogStatuses,
  validateUserStoryMatrix,
} from '../validate-user-story-matrix.mjs';

const validMatrix = `# User Story Test Traceability Matrix

## Summary

| Persona group | Stories | Covered | Partial | Missing | Deferred / Managed |
| ------------- | ------- | ------- | ------- | ------- | ------------------ |
| Buyer / Attendee | 2 | 1 | 0 | 0 | 1 |
| **Total** | **2** | **1** | **0** | **0** | **1** |

## Buyer / Attendee (US-BUY)

| ID | User story | Required layers | Status | Evidence / Gap |
| -- | ---------- | --------------- | ------ | -------------- |
| US-BUY-001 | Complete checkout | U,I,E,A | Covered | Covered by C-001 and \`e2e/checkout-paid-capture-workflow.spec.ts\`. |
| US-BUY-002 | PayPal checkout | U,I,C,E,S,P | Deferred | Deferred 2026-06-30 product decision. |
`;

const knownCompletionIds = extractCompletionBacklogIds('| C-001 | P0 | WS9 | Done | Proof. | Evidence. |');
const completionStatuses = extractCompletionBacklogStatuses('| C-001 | P0 | WS9 | Done | Proof. | Evidence. |');
const packageScripts = { 'iac:lint': 'helm lint infra/helm/tixkit' };

test('validateUserStoryMatrix accepts a consistent fully-covered matrix', () => {
  const result = validateUserStoryMatrix(validMatrix, {
    knownCompletionIds,
    completionStatuses,
    packageScripts,
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.storyRows.length, 2);
});

test('validateUserStoryMatrix rejects missing coverage and stale summary counts', () => {
  const result = validateUserStoryMatrix(
    validMatrix
      .replace('| Buyer / Attendee | 2 | 1 | 0 | 0 | 1 |', '| Buyer / Attendee | 2 | 2 | 0 | 0 | 0 |')
      .replace('| US-BUY-001 | Complete checkout | U,I,E,A | Covered | Covered by C-001 and `e2e/checkout-paid-capture-workflow.spec.ts`. |', '| US-BUY-001 | Complete checkout | U,I,E,A | Missing | - |'),
  );

  assert.deepEqual(result.errors, [
    'US-BUY-001: applicable stories must not remain Missing',
    'US-BUY-001: evidence cell must not be empty',
    'Buyer / Attendee summary covered=2 does not match story rows 0',
    'Buyer / Attendee summary missing=0 does not match story rows 1',
    'Buyer / Attendee summary deferredOrManaged=0 does not match story rows 1',
    'Total summary covered=1 does not match story rows 0',
    'Total summary missing=0 does not match story rows 1',
  ]);
});

test('validateUserStoryMatrix rejects deferred or managed rows without dated decisions', () => {
  const result = validateUserStoryMatrix(
    validMatrix.replace('Deferred 2026-06-30 product decision.', 'Deferred product decision.'),
  );

  assert.deepEqual(result.errors, ['US-BUY-002: Deferred rows must cite a dated decision']);
});

test('validateUserStoryMatrix rejects unknown completion backlog references when provided', () => {
  const result = validateUserStoryMatrix(
    validMatrix.replace('Covered by C-001', 'Covered by C-999'),
    { knownCompletionIds },
  );

  assert.deepEqual(result.errors, ['US-BUY-001: evidence references unknown completion backlog item C-999']);
});

test('validateUserStoryMatrix rejects unknown package scripts when provided', () => {
  const result = validateUserStoryMatrix(
    validMatrix.replace('Covered by C-001', 'Covered by C-001 and `bun run missing:script`'),
    { knownCompletionIds, packageScripts },
  );

  assert.deepEqual(result.errors, ['US-BUY-001: evidence references unknown package script missing:script']);
});

test('validateUserStoryMatrix rejects covered rows that cite in-progress completion items', () => {
  const result = validateUserStoryMatrix(
    validMatrix.replace(
      'Covered by C-001 and `e2e/checkout-paid-capture-workflow.spec.ts`.',
      'Covered by C-035 with axe coverage in `e2e/admin-accessibility.spec.ts`.',
    ),
    {
      knownCompletionIds: extractCompletionBacklogIds('| C-035 | P0 | WS9 | In progress | Hosted CI. | Pending. |'),
      completionStatuses: extractCompletionBacklogStatuses('| C-035 | P0 | WS9 | In progress | Hosted CI. | Pending. |'),
    },
  );

  assert.deepEqual(result.errors, [
    'US-BUY-001: Covered evidence must not depend on C-035 while it is In progress',
  ]);
});

test('validateUserStoryMatrix rejects covered E-layer rows without browser evidence', () => {
  const result = validateUserStoryMatrix(
    validMatrix.replace(
      'Covered by C-001 and `e2e/checkout-paid-capture-workflow.spec.ts`.',
      'axe accessibility coverage.',
    ),
    { knownCompletionIds, completionStatuses },
  );

  assert.deepEqual(result.errors, [
    'US-BUY-001: Covered E-layer rows must cite E2E/browser evidence or a completed completion item',
  ]);
});

test('validateUserStoryMatrix rejects covered A-layer rows without accessibility evidence', () => {
  const result = validateUserStoryMatrix(
    validMatrix.replace('Covered by C-001 and `e2e/checkout-paid-capture-workflow.spec.ts`.', '`e2e/checkout-paid-capture-workflow.spec.ts`.'),
    { knownCompletionIds, completionStatuses },
  );

  assert.deepEqual(result.errors, [
    'US-BUY-001: Covered A-layer rows must cite accessibility/axe evidence or a completed completion item',
  ]);
});

test('collectEvidenceReferences extracts completion ids and repo-relative paths from evidence commands', () => {
  const references = collectEvidenceReferences(
    'Covered by C-042 and `DB_DRIVER=postgres bun run test:e2e -- e2e/admin-content-event-page-persisted.spec.ts --project=chromium`, `bun run --filter @tixkit/db test:mssql`, plus `packages/openapi/src/__tests__/generated-client.test.ts`.',
  );

  assert.deepEqual(references.completionIds, ['C-042']);
  assert.deepEqual(references.pathReferences, [
    'e2e/admin-content-event-page-persisted.spec.ts',
    'packages/openapi/src/__tests__/generated-client.test.ts',
  ]);
  assert.deepEqual(references.packageScripts, ['test:e2e']);
});
