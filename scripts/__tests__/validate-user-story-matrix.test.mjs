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
| US-BUY-002 | PayPal checkout | U,I,C,E,S,P | Deferred | Deferred 2026-06-30 product decision in C-071. |
`;

const knownCompletionIds = extractCompletionBacklogIds(`
| C-001 | P0 | WS9 | Done | Proof. | Evidence. |
| C-071 | P1 | WS2 | Deferred | PayPal. | Deferred by dated 2026-06-30 product decision. |
`);
const completionStatuses = extractCompletionBacklogStatuses(`
| C-001 | P0 | WS9 | Done | Proof. | Evidence. |
| C-071 | P1 | WS2 | Deferred | PayPal. | Deferred by dated 2026-06-30 product decision. |
`);
const packageScripts = { 'iac:lint': 'helm lint infra/helm/tixkit' };
const fixturePersonaStoryCounts = new Map([['Buyer / Attendee', 2]]);
const fixtureStoryIds = new Set(['US-BUY-001', 'US-BUY-002']);
const fixtureExceptionStoryStatuses = new Map([['US-BUY-002', 'Deferred']]);
const fixtureExceptionStoryEvidence = new Map([['US-BUY-002', [/2026-06-30/, /C-071/]]]);

function validateFixtureMatrix(markdown, options = {}) {
  return validateUserStoryMatrix(markdown, {
    knownCompletionIds,
    completionStatuses,
    requiredPersonaStoryCounts: fixturePersonaStoryCounts,
    requiredStoryIds: fixtureStoryIds,
    requiredStoryScopeHash: null,
    requiredExceptionStoryStatuses: fixtureExceptionStoryStatuses,
    requiredExceptionStoryEvidence: fixtureExceptionStoryEvidence,
    ...options,
  });
}

test('validateUserStoryMatrix accepts a consistent fully-covered matrix', () => {
  const result = validateFixtureMatrix(validMatrix, {
    knownCompletionIds,
    completionStatuses,
    packageScripts,
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.storyRows.length, 2);
});

test('validateUserStoryMatrix rejects missing coverage and stale summary counts', () => {
  const result = validateFixtureMatrix(
    validMatrix
      .replace(
        '| Buyer / Attendee | 2 | 1 | 0 | 0 | 1 |',
        '| Buyer / Attendee | 2 | 2 | 0 | 0 | 0 |',
      )
      .replace(
        '| US-BUY-001 | Complete checkout | U,I,E,A | Covered | Covered by C-001 and `e2e/checkout-paid-capture-workflow.spec.ts`. |',
        '| US-BUY-001 | Complete checkout | U,I,E,A | Missing | - |',
      ),
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

test('validateUserStoryMatrix rejects malformed summary counts', () => {
  const result = validateFixtureMatrix(
    validMatrix.replace(
      '| Buyer / Attendee | 2 | 1 | 0 | 0 | 1 |',
      '| Buyer / Attendee | two | 1 | 0 | 0 | 1 |',
    ),
  );

  assert.deepEqual(result.errors, [
    'Buyer / Attendee: summary stories must be a non-negative integer',
    'Buyer / Attendee: required persona summary stories=NaN must stay 2',
    'Buyer / Attendee summary stories=NaN does not match story rows 2',
  ]);
});

test('validateUserStoryMatrix rejects malformed summary rows', () => {
  const result = validateFixtureMatrix(
    validMatrix.replace(
      '| Buyer / Attendee | 2 | 1 | 0 | 0 | 1 |',
      '| Buyer / Attendee | 2 | 1 | 0 | 0 |',
    ),
  );

  assert.ok(
    result.errors.some((error) =>
      /^Malformed matrix row: line \d+: summary row must have 6 columns$/.test(error),
    ),
  );
  assert.ok(result.errors.includes('Buyer / Attendee: required persona summary row is missing'));
});

test('validateUserStoryMatrix rejects blank summary persona labels', () => {
  const result = validateFixtureMatrix(
    validMatrix.replace('| Buyer / Attendee | 2 | 1 | 0 | 0 | 1 |', '|  | 2 | 1 | 0 | 0 | 1 |'),
  );

  assert.ok(result.errors.includes('Summary row persona must not be empty'));
  assert.ok(result.errors.includes('Buyer / Attendee: required persona summary row is missing'));
});

test('validateUserStoryMatrix rejects malformed total summary rows', () => {
  const result = validateFixtureMatrix(
    validMatrix.replace(
      '| **Total** | **2** | **1** | **0** | **0** | **1** |',
      '| **Total** | **2** | **1** | **0** | **0** |',
    ),
  );

  assert.ok(
    result.errors.some((error) =>
      /^Malformed matrix row: line \d+: summary row must have 6 columns$/.test(error),
    ),
  );
  assert.ok(result.errors.includes('Total summary row is missing'));
});

test('validateUserStoryMatrix rejects noncanonical total summary labels', () => {
  const result = validateFixtureMatrix(
    validMatrix.replace(
      '| **Total** | **2** | **1** | **0** | **0** | **1** |',
      '| Total | **2** | **1** | **0** | **0** | **1** |',
    ),
  );

  assert.ok(
    result.errors.some((error) =>
      /^Malformed matrix row: line \d+: total summary row must use \*\*Total\*\* label$/.test(
        error,
      ),
    ),
  );
  assert.ok(result.errors.includes('Total summary row is missing'));
});

test('validateUserStoryMatrix rejects negative total summary counts', () => {
  const result = validateFixtureMatrix(
    validMatrix.replace(
      '| **Total** | **2** | **1** | **0** | **0** | **1** |',
      '| **Total** | **2** | **-1** | **0** | **0** | **1** |',
    ),
  );

  assert.deepEqual(result.errors, [
    'Total: summary covered must be a non-negative integer',
    'Total summary covered=-1 does not match story rows 1',
  ]);
});

test('validateUserStoryMatrix rejects impossible persona summary bucket totals', () => {
  const result = validateFixtureMatrix(
    validMatrix.replace(
      '| Buyer / Attendee | 2 | 1 | 0 | 0 | 1 |',
      '| Buyer / Attendee | 2 | 2 | 0 | 0 | 1 |',
    ),
  );

  assert.deepEqual(result.errors, [
    'Buyer / Attendee: summary status buckets total 3 must equal stories 2',
    'Buyer / Attendee summary covered=2 does not match story rows 1',
  ]);
});

test('validateUserStoryMatrix rejects impossible total summary bucket totals', () => {
  const result = validateFixtureMatrix(
    validMatrix.replace(
      '| **Total** | **2** | **1** | **0** | **0** | **1** |',
      '| **Total** | **2** | **1** | **1** | **0** | **1** |',
    ),
  );

  assert.deepEqual(result.errors, [
    'Total: summary status buckets total 3 must equal stories 2',
    'Total summary partial=1 does not match story rows 0',
  ]);
});

test('validateUserStoryMatrix rejects duplicate user-story ids', () => {
  const result = validateFixtureMatrix(
    validMatrix
      .replace(
        '| Buyer / Attendee | 2 | 1 | 0 | 0 | 1 |',
        '| Buyer / Attendee | 2 | 2 | 0 | 0 | 0 |',
      )
      .replace(
        '| **Total** | **2** | **1** | **0** | **0** | **1** |',
        '| **Total** | **2** | **2** | **0** | **0** | **0** |',
      )
      .replace(
        '| US-BUY-002 | PayPal checkout | U,I,C,E,S,P | Deferred | Deferred 2026-06-30 product decision in C-071. |',
        '| US-BUY-001 | PayPal checkout | U,I,C,E,S,P | Covered | Covered by C-001 and `e2e/checkout-paid-capture-workflow.spec.ts`. |',
      ),
  );

  assert.deepEqual(result.errors, [
    'US-BUY-001: duplicate user-story id',
    'US-BUY-002: required user-story row is missing',
  ]);
});

test('validateUserStoryMatrix rejects story ids outside the persona section prefix', () => {
  const result = validateFixtureMatrix(
    validMatrix.replace('US-BUY-001 | Complete checkout', 'US-ORG-001 | Complete checkout'),
    {
      knownCompletionIds,
      completionStatuses,
      requiredStoryIds: new Set(['US-ORG-001', 'US-BUY-002']),
    },
  );

  assert.deepEqual(result.errors, ['US-ORG-001: user-story id must use section prefix US-BUY']);
});

test('validateUserStoryMatrix rejects empty user-story text', () => {
  const result = validateFixtureMatrix(
    validMatrix.replace('US-BUY-001 | Complete checkout | U,I,E,A', 'US-BUY-001 |  | U,I,E,A'),
    { knownCompletionIds, completionStatuses },
  );

  assert.deepEqual(result.errors, ['US-BUY-001: user story must not be empty']);
});

test('validateUserStoryMatrix rejects malformed user-story rows', () => {
  const result = validateFixtureMatrix(
    validMatrix.replace(
      '| US-BUY-001 | Complete checkout | U,I,E,A | Covered | Covered by C-001 and `e2e/checkout-paid-capture-workflow.spec.ts`. |',
      '| US-BUY-001 | Complete checkout | U,I,E,A | Covered |',
    ),
  );

  assert.ok(
    result.errors.some((error) =>
      /^Malformed matrix row: line \d+: user-story row must have at least 5 columns$/.test(error),
    ),
  );
  assert.ok(result.errors.includes('US-BUY-001: required user-story row is missing'));
});

test('validateUserStoryMatrix rejects persona sections without story id prefixes', () => {
  const result = validateFixtureMatrix(
    validMatrix.replace('## Buyer / Attendee (US-BUY)', '## Buyer / Attendee'),
  );

  assert.deepEqual(result.errors, [
    'US-BUY-001: persona section must declare a user-story prefix',
    'US-BUY-002: persona section must declare a user-story prefix',
  ]);
});

test('validateUserStoryMatrix rejects missing required story ids in fixture scope', () => {
  const result = validateFixtureMatrix(
    validMatrix
      .replace(
        '| Buyer / Attendee | 2 | 1 | 0 | 0 | 1 |',
        '| Buyer / Attendee | 1 | 0 | 0 | 0 | 1 |',
      )
      .replace(
        '| US-BUY-001 | Complete checkout | U,I,E,A | Covered | Covered by C-001 and `e2e/checkout-paid-capture-workflow.spec.ts`. |\n',
        '',
      ),
  );

  assert.deepEqual(result.errors, [
    'US-BUY-001: required user-story row is missing',
    'Buyer / Attendee: required persona summary stories=1 must stay 2',
    'Buyer / Attendee: required persona story rows=1 must stay 2',
    'Total summary stories=2 does not match story rows 1',
    'Total summary covered=1 does not match story rows 0',
  ]);
});

test('validateUserStoryMatrix rejects unexpected story ids outside fixture scope', () => {
  const result = validateFixtureMatrix(
    validMatrix.replace('US-BUY-001 | Complete checkout', 'US-BUY-999 | Complete checkout'),
  );

  assert.deepEqual(result.errors, [
    'US-BUY-001: required user-story row is missing',
    'US-BUY-999: unexpected user-story id outside required scope',
  ]);
});

test('validateUserStoryMatrix rejects summary rows without story rows', () => {
  const result = validateFixtureMatrix(
    validMatrix.replace(
      '| Buyer / Attendee | 2 | 1 | 0 | 0 | 1 |',
      '| Buyer / Attendee | 2 | 1 | 0 | 0 | 1 |\n| Stray Persona | 0 | 0 | 0 | 0 | 0 |',
    ),
  );

  assert.deepEqual(result.errors, ['Stray Persona: summary row has no user-story rows']);
});

test('validateUserStoryMatrix rejects duplicate persona summary rows', () => {
  const result = validateFixtureMatrix(
    validMatrix.replace(
      '| Buyer / Attendee | 2 | 1 | 0 | 0 | 1 |',
      '| Buyer / Attendee | 2 | 1 | 0 | 0 | 1 |\n| Buyer / Attendee | 2 | 1 | 0 | 0 | 1 |',
    ),
  );

  assert.deepEqual(result.errors, ['Buyer / Attendee: duplicate summary row']);
});

test('validateUserStoryMatrix rejects duplicate total summary rows', () => {
  const result = validateFixtureMatrix(
    validMatrix.replace(
      '| **Total** | **2** | **1** | **0** | **0** | **1** |',
      '| **Total** | **2** | **1** | **0** | **0** | **1** |\n| **Total** | **2** | **1** | **0** | **0** | **1** |',
    ),
  );

  assert.deepEqual(result.errors, ['Total: duplicate summary row']);
});

test('validateUserStoryMatrix rejects persona summary rows after total', () => {
  const result = validateFixtureMatrix(
    validMatrix.replace(
      '| Buyer / Attendee | 2 | 1 | 0 | 0 | 1 |\n| **Total** | **2** | **1** | **0** | **0** | **1** |',
      '| **Total** | **2** | **1** | **0** | **0** | **1** |\n| Buyer / Attendee | 2 | 1 | 0 | 0 | 1 |',
    ),
  );

  assert.deepEqual(result.errors, ['Buyer / Attendee: summary row must appear before Total']);
});

test('validateUserStoryMatrix rejects changed story text or layer scope by default', () => {
  const result = validateUserStoryMatrix(
    validMatrix.replace('Complete checkout | U,I,E,A', 'Complete checkout with upsells | U,I,E,A'),
    {
      knownCompletionIds,
      completionStatuses,
      requiredPersonaStoryCounts: fixturePersonaStoryCounts,
      requiredStoryIds: fixtureStoryIds,
      requiredExceptionStoryStatuses: fixtureExceptionStoryStatuses,
      requiredExceptionStoryEvidence: fixtureExceptionStoryEvidence,
    },
  );

  assert.equal(result.errors.length, 1);
  assert.match(
    result.errors[0],
    /^User-story scope hash [a-f0-9]{64} does not match required scope d38cade4da6cd9159013f084ca01bc38b7cb329b40a33c45d1ac2e6146e09b8a$/,
  );
});

test('validateUserStoryMatrix rejects covered rows with only prose evidence', () => {
  const result = validateFixtureMatrix(
    validMatrix.replace(
      'Covered by C-001 and `e2e/checkout-paid-capture-workflow.spec.ts`.',
      'unit tests, route integration, browser journey, and axe checks.',
    ),
    { knownCompletionIds, completionStatuses },
  );

  assert.deepEqual(result.errors, [
    'US-BUY-001: Covered rows must cite a concrete completion item, repo path, or package script',
    'US-BUY-001: Covered E-layer rows must cite a concrete e2e/ path or test:e2e package script',
  ]);
});

test('validateUserStoryMatrix rejects completion evidence without completion statuses', () => {
  const result = validateFixtureMatrix(
    validMatrix
      .replace(
        '| US-BUY-001 | Complete checkout | U,I,E,A | Covered |',
        '| US-BUY-001 | Complete checkout | C | Covered |',
      )
      .replace(
        'Covered by C-001 and `e2e/checkout-paid-capture-workflow.spec.ts`.',
        'Covered by C-001.',
      ),
    { completionStatuses: null },
  );

  assert.deepEqual(result.errors, [
    'US-BUY-001: Covered C-layer rows must cite contract/parity/OpenAPI/SDK evidence or a completed completion item',
  ]);
});

test('validateUserStoryMatrix rejects covered rows with only non-proof source paths', () => {
  const result = validateFixtureMatrix(
    validMatrix.replace(
      'Covered by C-001 and `e2e/checkout-paid-capture-workflow.spec.ts`.',
      'Covered by implementation notes in `packages/workflows/src/workflows/checkout.ts`.',
    ),
    { knownCompletionIds, completionStatuses },
  );

  assert.deepEqual(result.errors, [
    'US-BUY-001: Covered path evidence must cite a test, workflow, runbook, or proof script',
    'US-BUY-001: Covered E-layer rows must cite a concrete e2e/ path or test:e2e package script',
    'US-BUY-001: Covered A-layer rows must cite accessibility/axe evidence or a completed completion item',
    'US-BUY-001: Covered U-layer rows must cite unit/test-helper evidence or a completed completion item',
  ]);
});

test('validateUserStoryMatrix rejects duplicate required layers', () => {
  const result = validateFixtureMatrix(validMatrix.replace('U,I,E,A', 'U,I,U,E,A'), {
    knownCompletionIds,
    completionStatuses,
  });

  assert.deepEqual(result.errors, ['US-BUY-001: duplicate required layer U']);
});

test('validateUserStoryMatrix rejects empty required-layer entries', () => {
  const result = validateFixtureMatrix(validMatrix.replace('U,I,E,A', 'U,,I,E,A'), {
    knownCompletionIds,
    completionStatuses,
  });

  assert.deepEqual(result.errors, ['US-BUY-001: required layers must not contain empty entries']);
});

test('validateUserStoryMatrix rejects file-like code spans without repo-relative paths', () => {
  const result = validateFixtureMatrix(
    validMatrix.replace(
      '`e2e/checkout-paid-capture-workflow.spec.ts`',
      '`checkout-paid-capture-workflow.spec.ts`',
    ),
    { knownCompletionIds, completionStatuses },
  );

  assert.deepEqual(result.errors, [
    'US-BUY-001: file-like evidence token must be a repo-relative path: checkout-paid-capture-workflow.spec.ts',
    'US-BUY-001: Covered E-layer rows must cite a concrete e2e/ path or test:e2e package script',
  ]);
});

test('validateUserStoryMatrix rejects prose masquerading as code-span evidence', () => {
  const result = validateFixtureMatrix(
    validMatrix.replace(
      '`e2e/checkout-paid-capture-workflow.spec.ts`',
      '`unit tests, route integration, browser journey, and axe checks`',
    ),
    { knownCompletionIds, completionStatuses },
  );

  assert.deepEqual(result.errors, [
    'US-BUY-001: evidence code span must be a repo-relative path or runnable command: unit tests, route integration, browser journey, and axe checks',
    'US-BUY-001: Covered E-layer rows must cite a concrete e2e/ path or test:e2e package script',
  ]);
});

test('validateUserStoryMatrix rejects dropped required persona scope by default', () => {
  const result = validateUserStoryMatrix(validMatrix, { knownCompletionIds, completionStatuses });

  assert.ok(
    result.errors.some((error) =>
      /^User-story scope hash [a-f0-9]{64} does not match required scope d38cade4da6cd9159013f084ca01bc38b7cb329b40a33c45d1ac2e6146e09b8a$/.test(
        error,
      ),
    ),
  );
  assert.ok(result.errors.includes('Organizer / Admin: required persona summary row is missing'));
  assert.ok(
    result.errors.includes('Organizer / Admin: required persona story rows=0 must stay 30'),
  );
  assert.ok(result.errors.includes('Widget / Embed: required persona summary row is missing'));
  assert.ok(result.errors.includes('Widget / Embed: required persona story rows=0 must stay 7'));
});

test('validateUserStoryMatrix rejects deferred or managed rows without dated decisions', () => {
  const result = validateFixtureMatrix(
    validMatrix.replace(
      'Deferred 2026-06-30 product decision in C-071.',
      'Deferred product decision in C-071.',
    ),
  );

  assert.deepEqual(result.errors, [
    'US-BUY-002: exception evidence must match 2026-06-30',
    'US-BUY-002: Deferred rows must cite a dated decision',
  ]);
});

test('validateUserStoryMatrix rejects exception story status drift', () => {
  const result = validateFixtureMatrix(
    validMatrix
      .replace(
        '| Buyer / Attendee | 2 | 1 | 0 | 0 | 1 |',
        '| Buyer / Attendee | 2 | 2 | 0 | 0 | 0 |',
      )
      .replace(
        '| **Total** | **2** | **1** | **0** | **0** | **1** |',
        '| **Total** | **2** | **2** | **0** | **0** | **0** |',
      )
      .replace(
        '| US-BUY-002 | PayPal checkout | U,I,C,E,S,P | Deferred | Deferred 2026-06-30 product decision in C-071. |',
        '| US-BUY-002 | PayPal checkout | U,I,C,E,S,P | Covered | Covered by C-001 and `packages/domain/src/__tests__/validateTicketPurchase.test.ts`. |',
      ),
    {
      knownCompletionIds,
      completionStatuses,
      requiredExceptionStoryStatuses: new Map([['US-BUY-002', 'Deferred']]),
    },
  );

  assert.deepEqual(result.errors, [
    'US-BUY-002: exception story status must stay Deferred',
    'US-BUY-002: Covered E-layer rows must cite a concrete e2e/ path or test:e2e package script',
  ]);
});

test('validateUserStoryMatrix rejects unregistered deferred or managed stories', () => {
  const result = validateFixtureMatrix(validMatrix, {
    requiredExceptionStoryStatuses: new Map(),
    requiredExceptionStoryEvidence: new Map(),
  });

  assert.deepEqual(result.errors, [
    'US-BUY-002: Deferred story must be registered as an approved exception',
  ]);
});

test('validateUserStoryMatrix rejects approved exceptions without evidence requirements', () => {
  const result = validateFixtureMatrix(validMatrix, {
    requiredExceptionStoryEvidence: new Map(),
  });

  assert.deepEqual(result.errors, [
    'US-BUY-002: approved exception must declare evidence requirements',
  ]);
});

test('validateUserStoryMatrix rejects approved exceptions outside required story scope', () => {
  const result = validateFixtureMatrix(validMatrix, {
    requiredExceptionStoryStatuses: new Map([
      ['US-BUY-002', 'Deferred'],
      ['US-BUY-999', 'Deferred'],
    ]),
    requiredExceptionStoryEvidence: new Map([
      ['US-BUY-002', [/2026-06-30/, /C-071/]],
      ['US-BUY-999', [/2026-06-30/]],
    ]),
  });

  assert.deepEqual(result.errors, [
    'US-BUY-999: approved exception must be inside required story scope',
  ]);
});

test('validateUserStoryMatrix rejects invalid approved exception statuses', () => {
  const result = validateFixtureMatrix(validMatrix, {
    requiredExceptionStoryStatuses: new Map([['US-BUY-002', 'Covered']]),
  });

  assert.deepEqual(result.errors, [
    'US-BUY-002: approved exception status must be Deferred or Managed',
    'US-BUY-002: exception story status must stay Covered',
  ]);
});

test('validateUserStoryMatrix rejects unknown approved exception statuses', () => {
  const result = validateFixtureMatrix(validMatrix, {
    requiredExceptionStoryStatuses: new Map([['US-BUY-002', 'Skipped']]),
  });

  assert.deepEqual(result.errors, [
    'US-BUY-002: approved exception status is invalid: Skipped',
    'US-BUY-002: exception story status must stay Skipped',
  ]);
});

test('validateUserStoryMatrix rejects orphan exception evidence requirements', () => {
  const result = validateFixtureMatrix(validMatrix, {
    requiredExceptionStoryEvidence: new Map([
      ['US-BUY-002', [/2026-06-30/, /C-071/]],
      ['US-BUY-999', [/2026-06-30/]],
    ]),
  });

  assert.deepEqual(result.errors, [
    'US-BUY-999: exception evidence requirements have no approved status',
  ]);
});

test('validateUserStoryMatrix rejects non-RegExp exception evidence requirements', () => {
  const result = validateFixtureMatrix(validMatrix, {
    requiredExceptionStoryEvidence: new Map([['US-BUY-002', [/2026-06-30/, 'C-071']]]),
  });

  assert.deepEqual(result.errors, [
    'US-BUY-002: approved exception evidence requirement must be a RegExp: C-071',
  ]);
});

test('validateUserStoryMatrix rejects stateful exception evidence requirements', () => {
  const result = validateFixtureMatrix(validMatrix, {
    requiredExceptionStoryEvidence: new Map([['US-BUY-002', [/2026-06-30/g, /C-071/]]]),
  });

  assert.deepEqual(result.errors, [
    'US-BUY-002: approved exception evidence requirement must not use global or sticky flags: /2026-06-30/g',
  ]);
});

test('validateUserStoryMatrix rejects weak exception evidence', () => {
  const result = validateFixtureMatrix(
    validMatrix.replace(
      'Deferred 2026-06-30 product decision in C-071.',
      'Deferred 2026-06-30 product decision.',
    ),
  );

  assert.deepEqual(result.errors, [
    'US-BUY-002: exception evidence must match C-071',
    'US-BUY-002: Deferred rows must cite a concrete exception item, repo path, or package script',
  ]);
});

test('validateUserStoryMatrix rejects deferred or managed rows without concrete exception evidence', () => {
  const result = validateFixtureMatrix(
    validMatrix.replace(' product decision in C-071.', ' product decision.'),
  );

  assert.deepEqual(result.errors, [
    'US-BUY-002: exception evidence must match C-071',
    'US-BUY-002: Deferred rows must cite a concrete exception item, repo path, or package script',
  ]);
});

test('validateUserStoryMatrix rejects unknown completion backlog references when provided', () => {
  const result = validateFixtureMatrix(
    validMatrix.replace(
      'Covered by C-001 and `e2e/checkout-paid-capture-workflow.spec.ts`.',
      'Covered by C-999 plus unit, route, E2E, and axe proof in `e2e/checkout-paid-capture-workflow.spec.ts`.',
    ),
    { knownCompletionIds },
  );

  assert.deepEqual(result.errors, [
    'US-BUY-001: evidence references unknown completion backlog item C-999',
  ]);
});

test('validateUserStoryMatrix rejects unknown package scripts when provided', () => {
  const result = validateFixtureMatrix(
    validMatrix.replace('Covered by C-001', 'Covered by C-001 and `bun run missing:script`'),
    { knownCompletionIds, packageScripts },
  );

  assert.deepEqual(result.errors, [
    'US-BUY-001: evidence references unknown package script missing:script',
  ]);
});

test('validateUserStoryMatrix rejects covered rows that cite in-progress completion items', () => {
  const result = validateFixtureMatrix(
    validMatrix.replace(
      'Covered by C-001 and `e2e/checkout-paid-capture-workflow.spec.ts`.',
      'Covered by C-035 with unit tests and axe coverage in `e2e/admin-accessibility.spec.ts`.',
    ),
    {
      knownCompletionIds: extractCompletionBacklogIds(`
| C-035 | P0 | WS9 | In progress | Hosted CI. | Pending. |
| C-071 | P1 | WS2 | Deferred | PayPal. | Deferred by dated 2026-06-30 product decision. |
`),
      completionStatuses: extractCompletionBacklogStatuses(`
| C-035 | P0 | WS9 | In progress | Hosted CI. | Pending. |
| C-071 | P1 | WS2 | Deferred | PayPal. | Deferred by dated 2026-06-30 product decision. |
`),
    },
  );

  assert.deepEqual(result.errors, [
    'US-BUY-001: Covered evidence must not depend on C-035 while it is In progress',
  ]);
});

test('validateUserStoryMatrix rejects covered E-layer rows without browser evidence', () => {
  const result = validateFixtureMatrix(
    validMatrix.replace(
      'Covered by C-001 and `e2e/checkout-paid-capture-workflow.spec.ts`.',
      'unit tests and route integration coverage with axe accessibility checks in `packages/domain/src/__tests__/validateTicketPurchase.test.ts`.',
    ),
    { knownCompletionIds, completionStatuses },
  );

  assert.deepEqual(result.errors, [
    'US-BUY-001: Covered E-layer rows must cite a concrete e2e/ path or test:e2e package script',
  ]);
});

test('validateUserStoryMatrix rejects covered A-layer rows without accessibility evidence', () => {
  const result = validateFixtureMatrix(
    validMatrix.replace(
      'Covered by C-001 and `e2e/checkout-paid-capture-workflow.spec.ts`.',
      '`packages/domain/src/__tests__/validateTicketPurchase.test.ts` and `e2e/checkout-paid-capture-workflow.spec.ts`.',
    ),
    { knownCompletionIds, completionStatuses },
  );

  assert.deepEqual(result.errors, [
    'US-BUY-001: Covered A-layer rows must cite accessibility/axe evidence or a completed completion item',
  ]);
});

test('validateUserStoryMatrix rejects covered C-layer rows without contract evidence', () => {
  const matrix = validMatrix
    .replace('U,I,E,A', 'U,I,C')
    .replace(
      'Covered by C-001 and `e2e/checkout-paid-capture-workflow.spec.ts`.',
      '`packages/domain/src/__tests__/validateTicketPurchase.test.ts` and `e2e/admin-accessibility.spec.ts`.',
    );
  const result = validateFixtureMatrix(matrix, { knownCompletionIds, completionStatuses });

  assert.deepEqual(result.errors, [
    'US-BUY-001: Covered C-layer rows must cite contract/parity/OpenAPI/SDK evidence or a completed completion item',
  ]);
});

test('validateUserStoryMatrix rejects covered U-layer rows without unit evidence', () => {
  const matrix = validMatrix
    .replace('U,I,E,A', 'U')
    .replace(
      'Covered by C-001 and `e2e/checkout-paid-capture-workflow.spec.ts`.',
      'browser journey coverage in `e2e/checkout-paid-capture-workflow.spec.ts`.',
    );
  const result = validateFixtureMatrix(matrix, { knownCompletionIds, completionStatuses });

  assert.deepEqual(result.errors, [
    'US-BUY-001: Covered U-layer rows must cite unit/test-helper evidence or a completed completion item',
  ]);
});

test('validateUserStoryMatrix rejects covered I-layer rows without integration evidence', () => {
  const matrix = validMatrix
    .replace('U,I,E,A', 'U,I')
    .replace(
      'Covered by C-001 and `e2e/checkout-paid-capture-workflow.spec.ts`.',
      'static copy snapshot in `packages/domain/src/__tests__/validateTicketPurchase.test.ts`.',
    );
  const result = validateFixtureMatrix(matrix, { knownCompletionIds, completionStatuses });

  assert.deepEqual(result.errors, [
    'US-BUY-001: Covered I-layer rows must cite integration/route/workflow/provider evidence or a completed completion item',
  ]);
});

test('validateUserStoryMatrix rejects covered P-layer rows without property evidence', () => {
  const matrix = validMatrix
    .replace('U,I,E,A', 'U,I,P')
    .replace(
      'Covered by C-001 and `e2e/checkout-paid-capture-workflow.spec.ts`.',
      '`packages/sdk-js/src/__tests__/index.test.ts`.',
    );
  const result = validateFixtureMatrix(matrix, { knownCompletionIds, completionStatuses });

  assert.deepEqual(result.errors, [
    'US-BUY-001: Covered P-layer rows must cite property/fuzz/vector evidence or a completed completion item',
  ]);
});

test('validateUserStoryMatrix rejects covered S-layer rows without security evidence', () => {
  const matrix = validMatrix
    .replace('U,I,E,A', 'U,I,S')
    .replace(
      'Covered by C-001 and `e2e/checkout-paid-capture-workflow.spec.ts`.',
      '`packages/domain/src/__tests__/validateTicketPurchase.test.ts` and `e2e/checkout-paid-capture-workflow.spec.ts`.',
    );
  const result = validateFixtureMatrix(matrix, { knownCompletionIds, completionStatuses });

  assert.deepEqual(result.errors, [
    'US-BUY-001: Covered S-layer rows must cite security/tenant-isolation evidence or a completed completion item',
  ]);
});

test('validateUserStoryMatrix rejects covered L-layer rows without load evidence', () => {
  const matrix = validMatrix
    .replace('U,I,E,A', 'U,I,L')
    .replace(
      'Covered by C-001 and `e2e/checkout-paid-capture-workflow.spec.ts`.',
      '`packages/domain/src/__tests__/validateTicketPurchase.test.ts` and `e2e/checkout-paid-capture-workflow.spec.ts`.',
    );
  const result = validateFixtureMatrix(matrix, { knownCompletionIds, completionStatuses });

  assert.deepEqual(result.errors, [
    'US-BUY-001: Covered L-layer rows must cite load/concurrency evidence or a completed completion item',
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
