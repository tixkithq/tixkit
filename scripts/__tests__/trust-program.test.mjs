import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  EXPECTED_TRUST_DECISIONS,
  EXPECTED_TRUST_CLAIMS,
  EXPECTED_TRUST_BLOCKERS,
  EXPECTED_TRUST_EVIDENCE,
  renderTrustProgram,
  REQUIRED_TRUST_RECORDS,
  trustDocumentationMatches,
  trustProgramViolations,
  validateTrustProgram,
} from '../lib/trust-program.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const program = JSON.parse(readFileSync(resolve(root, 'distribution/trust-program.json'), 'utf8'));
const schema = JSON.parse(
  readFileSync(resolve(root, 'distribution/trust-program.schema.json'), 'utf8'),
);
const publicDistribution = JSON.parse(
  readFileSync(resolve(root, 'distribution/public-distribution.json'), 'utf8'),
);

test('strict schema and semantic validator accept the honest trust inventory', () => {
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
  assert.equal(validate(program), true, JSON.stringify(validate.errors));
  assert.deepEqual(
    validateTrustProgram(structuredClone(program), root, publicDistribution),
    program,
  );
  assert.deepEqual(
    program.records.map(({ id }) => id),
    REQUIRED_TRUST_RECORDS,
  );
  assert.deepEqual(Object.keys(EXPECTED_TRUST_DECISIONS).sort(), REQUIRED_TRUST_RECORDS);
  assert.deepEqual(Object.keys(EXPECTED_TRUST_CLAIMS).sort(), REQUIRED_TRUST_RECORDS);
  assert.deepEqual(Object.keys(EXPECTED_TRUST_BLOCKERS).sort(), REQUIRED_TRUST_RECORDS);
  assert.deepEqual(Object.keys(EXPECTED_TRUST_EVIDENCE).sort(), REQUIRED_TRUST_RECORDS);
});

test('generated public matrix is exact and includes every trust record', () => {
  const rendered = renderTrustProgram(program);
  const documentation = readFileSync(resolve(root, program.documentation), 'utf8');
  assert.equal(trustDocumentationMatches(program, documentation), true);
  assert.equal(rendered.split('\n').filter((line) => line.startsWith('| `')).length, 15);
});

test('rejects missing, duplicate, unexpected, and unsorted trust decisions', () => {
  const mutations = [
    [(candidate) => candidate.records.shift(), /required trust record is missing/u],
    [
      (candidate) => candidate.records.splice(1, 0, structuredClone(candidate.records[0])),
      /trust record IDs must be unique/u,
    ],
    [
      (candidate) => (candidate.records[0].id = 'invented-certification'),
      /unsupported trust record/u,
    ],
    [(candidate) => candidate.records.reverse(), /sorted lexicographically/u],
  ];
  for (const [mutate, expected] of mutations) {
    const candidate = structuredClone(program);
    mutate(candidate);
    assert.ok(
      trustProgramViolations(candidate, root, publicDistribution).some((violation) =>
        expected.test(violation),
      ),
    );
  }
});

test('rejects missing, internal, and repository-escaping public artifacts', () => {
  const mutations = [
    ['docs/public/reference/missing-trust-proof.mdx', /does not exist/u],
    ['docs/internal/architecture/open-core-operating-model.md', /not in the public distribution/u],
    ['../outside.md', /escapes the repository/u],
  ];
  for (const [path, expected] of mutations) {
    const candidate = structuredClone(program);
    candidate.records.find(({ id }) => id === 'security-architecture').publicArtifacts = [path];
    assert.ok(
      trustProgramViolations(candidate, root, publicDistribution).some((violation) =>
        expected.test(violation),
      ),
    );
  }
});

test('fails closed on policy, service, and local-proof claim escalation', () => {
  const mutations = [
    [
      'version-lifecycle',
      (record) => (record.state = 'published'),
      /accepted kind, scope, or state decision drifted/u,
    ],
    [
      'managed-sla',
      (record) => (record.claim = 'A 24-hour managed SLA is guaranteed.'),
      /accepted public claim drifted/u,
    ],
    [
      'data-residency',
      (record) => (record.claim = 'Managed data remains in the EU.'),
      /accepted public claim drifted/u,
    ],
    [
      'cloud-status',
      (record) => (record.claim = 'Live at https://status.example.test'),
      /must not imply a live URL/u,
    ],
    [
      'performance-evidence',
      (record) =>
        (record.claim = 'Production capacity is proven with 99.99% uptime and RTO 10 minutes.'),
      /unsupported numeric, regional, or assessment claim/u,
    ],
    [
      'signed-sbom',
      (record) => (record.claim = 'The hosted release is independently proven.'),
      /local evidence must explicitly deny hosted proof/u,
    ],
    [
      'independent-assessments',
      (record) => (record.claim = 'An independent assessment is complete.'),
      /must deny published proof/u,
    ],
  ];
  for (const [id, mutate, expected] of mutations) {
    const candidate = structuredClone(program);
    mutate(candidate.records.find((record) => record.id === id));
    assert.ok(
      trustProgramViolations(candidate, root, publicDistribution).some((violation) =>
        expected.test(violation),
      ),
    );
  }
});

test('fails closed when blocker prose implies an accepted commitment or hosted proof', () => {
  const mutations = [
    ['managed-sla', 'Commercial owners guarantee a 24-hour managed SLA.'],
    ['data-residency', 'Legal approved permanent EU-only residency.'],
    ['privacy-roles', 'Legal approved every managed privacy responsibility.'],
    ['performance-evidence', 'Hosted production capacity is proven.'],
  ];
  for (const [id, blocker] of mutations) {
    const candidate = structuredClone(program);
    candidate.records.find((record) => record.id === id).blocker = blocker;
    assert.ok(
      trustProgramViolations(candidate, root, publicDistribution).includes(
        `${id}: accepted public blocker drifted`,
      ),
    );
  }
});

test('fails closed when approved public artifacts or local validation commands drift', () => {
  const mutations = [
    [(record) => (record.validationCommands = ['node --version']), /accepted public artifacts/u],
    [(record) => delete record.validationCommands, /accepted public artifacts/u],
    [(record) => (record.publicArtifacts = ['SECURITY.md']), /accepted public artifacts/u],
    [(record) => record.publicArtifacts.pop(), /accepted public artifacts/u],
  ];
  for (const [mutate, expected] of mutations) {
    const candidate = structuredClone(program);
    mutate(candidate.records.find(({ id }) => id === 'performance-evidence'));
    assert.ok(
      trustProgramViolations(candidate, root, publicDistribution).some((violation) =>
        expected.test(violation),
      ),
    );
  }
});

test('verifies immutable evidence bytes and never permits evidence to escalate a claim', () => {
  const evidencePath = 'artifacts/api/2026-01-01/openapi.json';
  const evidenceBytes = readFileSync(resolve(root, evidencePath));
  const candidate = structuredClone(program);
  const record = candidate.records.find(({ id }) => id === 'performance-evidence');
  record.immutableEvidence = [
    { path: evidencePath, sha256: createHash('sha256').update(evidenceBytes).digest('hex') },
  ];
  assert.ok(
    trustProgramViolations(candidate, root, publicDistribution).includes(
      'performance-evidence: immutable evidence is not approved for this trust snapshot',
    ),
  );

  record.immutableEvidence[0].sha256 = '0'.repeat(64);
  assert.ok(
    trustProgramViolations(candidate, root, publicDistribution).includes(
      'performance-evidence: immutable evidence checksum mismatch',
    ),
  );

  record.immutableEvidence[0].sha256 = createHash('sha256').update(evidenceBytes).digest('hex');
  record.claim = 'A workflow locally proves 99.99% uptime; no production proof is published.';
  const violations = trustProgramViolations(candidate, root, publicDistribution);
  assert.ok(violations.includes('performance-evidence: accepted public claim drifted'));
  assert.ok(
    violations.includes('performance-evidence: unsupported numeric, regional, or assessment claim'),
  );
});

test('rejects missing and symlinked immutable evidence', () => {
  const candidate = structuredClone(program);
  const record = candidate.records.find(({ id }) => id === 'performance-evidence');
  record.immutableEvidence = [
    { path: 'artifacts/missing-trust-evidence.json', sha256: '0'.repeat(64) },
  ];
  assert.ok(
    trustProgramViolations(candidate, root, publicDistribution).includes(
      'performance-evidence: immutable evidence must be a regular non-symlink file',
    ),
  );

  const directory = mkdtempSync(resolve(root, 'artifacts/trust-evidence-test-'));
  const link = resolve(directory, 'evidence.json');
  try {
    symlinkSync(resolve(root, 'artifacts/api/2026-01-01/openapi.json'), link);
    record.immutableEvidence[0].path = link.slice(root.length + 1);
    assert.ok(
      trustProgramViolations(candidate, root, publicDistribution).includes(
        'performance-evidence: immutable evidence must be a regular non-symlink file',
      ),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects impossible, future-relative, and stale verification dates', () => {
  const mutations = [
    [(candidate) => (candidate.asOf = '2026-02-31'), /asOf must be a real calendar date/u],
    [
      (candidate) => (candidate.records[0].lastVerified = '2026-02-31'),
      /lastVerified is not a real date/u,
    ],
    [
      (candidate) => (candidate.records[0].lastVerified = '2026-07-16'),
      /lastVerified is after asOf/u,
    ],
    [
      (candidate) => (candidate.records[0].lastVerified = '2026-01-01'),
      /exceeds the declared freshness window/u,
    ],
  ];
  for (const [mutate, expected] of mutations) {
    const candidate = structuredClone(program);
    mutate(candidate);
    assert.ok(
      trustProgramViolations(candidate, root, publicDistribution).some((violation) =>
        expected.test(violation),
      ),
    );
  }

  const backdated = structuredClone(program);
  backdated.asOf = '2020-01-01';
  for (const record of backdated.records) record.lastVerified = '2020-01-01';
  assert.ok(
    trustProgramViolations(backdated, root, publicDistribution).includes(
      'trust program snapshot exceeds the declared freshness window',
    ),
  );
});

test('schema reserves not-yet-offered for managed Cloud and policy decisions for no evidence', () => {
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
  const wrongScope = structuredClone(program);
  wrongScope.records[0].scope = 'public-core';
  assert.equal(validate(wrongScope), false);

  const inventedEvidence = structuredClone(program);
  inventedEvidence.records.find(({ id }) => id === 'managed-sla').publicArtifacts = ['SUPPORT.md'];
  assert.equal(validate(inventedEvidence), false);
});

test('rejects shell-composed validation commands', () => {
  const candidate = structuredClone(program);
  candidate.records.find(({ id }) => id === 'performance-evidence').validationCommands = [
    'bun run check:performance-budgets && publish-proof',
  ];
  assert.ok(
    trustProgramViolations(candidate, root, publicDistribution).includes(
      'performance-evidence: validation command contains shell composition',
    ),
  );
});
