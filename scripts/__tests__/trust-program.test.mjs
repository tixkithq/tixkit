import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  EXPECTED_TRUST_DECISIONS,
  EXPECTED_TRUST_CLAIMS,
  EXPECTED_TRUST_BLOCKERS,
  EXPECTED_TRUST_EVIDENCE,
  EXPECTED_TRUST_SURFACES,
  executeLocalTrustEvidence,
  renderTrustProgram,
  REQUIRED_TRUST_RECORDS,
  runBoundedTrustEvidenceCommand,
  trustDocumentationMatches,
  trustProgramViolations,
  trustSurfaceContentViolations,
  trustValidationCommandViolation,
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
  assert.deepEqual(
    program.surfaces.map(({ path, recordIds }) => [path, recordIds]),
    EXPECTED_TRUST_SURFACES,
  );
});

test('generated public matrix is exact and includes every trust record', () => {
  const rendered = renderTrustProgram(program);
  const documentation = readFileSync(resolve(root, program.documentation), 'utf8');
  assert.equal(trustDocumentationMatches(program, documentation), true);
  assert.match(rendered, /^\{\/\* trust-program:start \*\/\}/u);
  assert.doesNotMatch(rendered, /<!--/u);
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
    [
      (record) =>
        (record.validationCommands = [
          { argv: ['node', '--version'], cwd: '.', timeoutMs: 30_000 },
        ]),
      /accepted public artifacts/u,
    ],
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
      (candidate) => (candidate.records[0].lastVerified = '2026-07-21'),
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
  assert.equal(
    trustValidationCommandViolation(
      {
        argv: ['node', 'scripts/check-performance-budgets.mjs', '$PUBLISH_PROOF'],
        cwd: '.',
        timeoutMs: 1_000,
      },
      root,
    ),
    'validation command contains shell or environment expansion syntax',
  );
});

test('rejects omitted, unmapped, missing and renamed trust surfaces or evidence', () => {
  const omitted = structuredClone(program);
  omitted.surfaces.pop();
  assert.ok(
    trustProgramViolations(omitted, root, publicDistribution).includes(
      'accepted trust-bearing surface map drifted',
    ),
  );

  const unmapped = structuredClone(program);
  unmapped.surfaces[0].recordIds = ['invented-record'];
  const unmappedViolations = trustProgramViolations(unmapped, root, publicDistribution);
  assert.ok(unmappedViolations.includes('accepted trust-bearing surface map drifted'));
  assert.ok(
    unmappedViolations.includes(
      `${unmapped.surfaces[0].path}: mapped trust record does not exist: invented-record`,
    ),
  );

  for (const replacement of [
    'performance-budget.missing.json',
    '.github/workflows/performance-budget-missing.yml',
  ]) {
    const missing = structuredClone(program);
    const record = missing.records.find(({ id }) => id === 'performance-evidence');
    record.publicArtifacts[record.publicArtifacts.indexOf('performance-budgets.json')] =
      replacement;
    const violations = trustProgramViolations(missing, root, publicDistribution);
    assert.ok(violations.some((violation) => /accepted public artifacts/u.test(violation)));
    assert.ok(violations.some((violation) => /does not exist/u.test(violation)));
  }
});

test('requires every trust-bearing Markdown artifact to map back to its record', () => {
  for (const [path, recordId, replacementId] of [
    ['ARCHITECTURE.md', 'security-architecture', 'version-lifecycle'],
    ['docs/public/support.mdx', 'support-boundaries', 'managed-sla'],
  ]) {
    const candidate = structuredClone(program);
    candidate.surfaces.find((surface) => surface.path === path).recordIds = [replacementId];
    assert.ok(
      trustProgramViolations(candidate, root, publicDistribution).includes(
        `${recordId}: trust-bearing Markdown artifact is not mapped to its record: ${path}`,
      ),
    );
  }
});

test('requires managed privacy and support non-commitment disclosures', () => {
  for (const [path, disclosure] of [
    [
      'docs/public/reference/privacy-and-retention.mdx',
      'Managed Cloud controller, processor, retention, residency, transfer, and subprocessor commitments are not approved or published.',
    ],
    [
      'docs/public/reference/privacy-and-retention.mdx',
      'Self-Hosted operator choices do not create managed Cloud commitments.',
    ],
    [
      'docs/public/support.mdx',
      'Managed Cloud support plans and SLA commitments are not approved or published.',
    ],
    [
      'docs/public/support.mdx',
      'Self-Hosted support arrangements do not create managed Cloud support or SLA commitments.',
    ],
  ]) {
    const content = readFileSync(resolve(root, path), 'utf8');
    assert.ok(
      trustSurfaceContentViolations(path, content.replace(disclosure, '')).some((violation) =>
        /required trust disclosure is missing/u.test(violation),
      ),
    );
  }
});

test('rejects affirmative managed privacy and SLA claims while allowing explicit denials', () => {
  for (const [path, claim] of [
    [
      'docs/public/reference/privacy-and-retention.mdx',
      'Managed Cloud is the controller for all customer data.',
    ],
    ['docs/public/reference/privacy-and-retention.mdx', 'Managed Cloud data remains in eu-west-1.'],
    [
      'docs/public/reference/privacy-and-retention.mdx',
      'Managed Cloud data residency is in Europe.',
    ],
    [
      'docs/public/reference/privacy-and-retention.mdx',
      'Managed Cloud subprocessors include Example Corp.',
    ],
    ['docs/public/support.mdx', 'Managed Cloud guarantees a 99.9% SLA.'],
    [
      'docs/public/reference/privacy-and-retention.mdx',
      'Tixkit Cloud is the processor for customer data.',
    ],
    [
      'docs/public/reference/privacy-and-retention.mdx',
      'Tixkit Cloud data residency is in Europe.',
    ],
    [
      'docs/public/reference/privacy-and-retention.mdx',
      'Our subprocessors for Managed Cloud include Example Corp.',
    ],
    ['docs/public/support.mdx', 'Tixkit Cloud provides enterprise support.'],
    ['docs/public/support.mdx', 'Managed Cloud comes with enterprise support.'],
    [
      'docs/public/reference/privacy-and-retention.mdx',
      'Managed Cloud does not act as controller and is the processor.',
    ],
    [
      'docs/public/reference/privacy-and-retention.mdx',
      'Tixkit Cloud residency is not in the United States and is in Europe.',
    ],
    [
      'docs/public/reference/privacy-and-retention.mdx',
      'Managed Cloud uses no domestic subprocessors and uses Example Corp as an international subprocessor.',
    ],
    ['docs/public/support.mdx', 'Managed Cloud support is not free and includes a guaranteed SLA.'],
    [
      'docs/public/reference/privacy-and-retention.mdx',
      'Managed Cloud residency is not in the United States and will be in Europe.',
    ],
    [
      'docs/public/support.mdx',
      'Managed Cloud does not provide support today and will guarantee an SLA at launch.',
    ],
    [
      'docs/public/reference/privacy-and-retention.mdx',
      'Managed Cloud uses no subprocessors today and may use Example Corp tomorrow.',
    ],
    [
      'docs/public/reference/privacy-and-retention.mdx',
      'Managed Cloud is not the controller and can act as processor.',
    ],
    ['docs/public/support.mdx', 'Managed Cloud offers support with no extra fee.'],
    ['docs/public/support.mdx', 'Managed Cloud provides support without additional charge.'],
    [
      'docs/public/support.mdx',
      'Managed Cloud does not provide support today and eventually will guarantee an SLA.',
    ],
    [
      'docs/public/reference/privacy-and-retention.mdx',
      'Managed Cloud is not the controller and should act as processor.',
    ],
    ['docs/public/support.mdx', 'Managed Cloud provides no support outside business hours.'],
    [
      'docs/public/reference/privacy-and-retention.mdx',
      'Managed Cloud stores no customer data outside Europe.',
    ],
    [
      'docs/public/reference/privacy-and-retention.mdx',
      'Managed Cloud uses no subprocessors outside the EU.',
    ],
    ['docs/public/support.mdx', 'Managed Cloud is private beta. It provides enterprise support.'],
    [
      'docs/public/reference/privacy-and-retention.mdx',
      'Tixkit Cloud is private beta. It acts as the processor for customer data.',
    ],
    [
      'docs/public/support.mdx',
      'Managed Cloud provides support because Self-Hosted operators do not provide support.',
    ],
    [
      'docs/public/reference/privacy-and-retention.mdx',
      'Managed Cloud hosts customer records in Europe.',
    ],
    [
      'docs/public/reference/privacy-and-retention.mdx',
      'Tixkit Cloud handles personal information in the United States.',
    ],
    [
      'docs/public/reference/privacy-and-retention.mdx',
      'Managed Cloud transfers customer data to the United States.',
    ],
    [
      'docs/public/reference/privacy-and-retention.mdx',
      'Tixkit Cloud sends personal information outside Europe.',
    ],
    [
      'docs/public/reference/privacy-and-retention.mdx',
      'Managed Cloud deletes customer records after 30 days.',
    ],
    ['docs/public/support.mdx', 'Managed Cloud guarantees email assistance during business hours.'],
  ]) {
    const content = `${readFileSync(resolve(root, path), 'utf8')}\n${claim}`;
    assert.ok(
      trustSurfaceContentViolations(path, content).some((violation) =>
        /pending trust decision/u.test(violation),
      ),
      `expected managed policy claim to be rejected: ${claim}`,
    );
  }

  for (const [path, denial] of [
    [
      'docs/public/reference/privacy-and-retention.mdx',
      'Managed Cloud is not the controller and does not store data in a promised region.',
    ],
    ['docs/public/support.mdx', 'Managed Cloud does not guarantee support or an SLA.'],
    [
      'docs/public/reference/privacy-and-retention.mdx',
      'Managed Cloud never stores customer data.',
    ],
    ['docs/public/support.mdx', 'Managed Cloud never provides enterprise support.'],
    ['docs/public/support.mdx', 'Managed Cloud currently provides no support.'],
    ['docs/public/reference/privacy-and-retention.mdx', 'Managed Cloud uses no subprocessors.'],
    [
      'docs/public/support.mdx',
      'Managed Cloud is experimental; Self-Hosted support is provided by operators.',
    ],
    [
      'docs/public/reference/privacy-and-retention.mdx',
      'Managed Cloud is experimental; Self-Hosted operators choose their subprocessors.',
    ],
    [
      'docs/public/reference/privacy-and-retention.mdx',
      'Tixkit Cloud is private beta, but Self-Hosted data remains on operator infrastructure.',
    ],
    [
      'docs/public/support.mdx',
      'Tixkit Cloud is private beta and Self-Hosted support is provided by operators.',
    ],
    [
      'docs/public/reference/privacy-and-retention.mdx',
      'Managed Cloud is experimental while operators choose their subprocessors.',
    ],
    [
      'docs/public/support.mdx',
      'Managed Cloud is experimental whereas Self-Hosted support is provided by operators.',
    ],
    [
      'docs/public/support.mdx',
      'Managed Cloud is experimental because Self-Hosted operators provide support.',
    ],
    ['docs/public/support.mdx', 'Managed Cloud does not currently provide support.'],
    ['docs/public/support.mdx', 'Managed Cloud does not offer any support.'],
    [
      'docs/public/reference/privacy-and-retention.mdx',
      'Managed Cloud does not store any customer data.',
    ],
    [
      'docs/public/reference/privacy-and-retention.mdx',
      'Managed Cloud does not use third-party subprocessors.',
    ],
    ['docs/public/support.mdx', 'Managed Cloud does not guarantee 24/7 support.'],
    [
      'docs/public/reference/privacy-and-retention.mdx',
      'Managed Cloud does not use external subprocessors.',
    ],
    [
      'docs/public/reference/privacy-and-retention.mdx',
      'Managed Cloud does not store personal data.',
    ],
    ['docs/public/reference/privacy-and-retention.mdx', "Managed Cloud isn't the controller."],
    [
      'docs/public/reference/privacy-and-retention.mdx',
      'Managed Cloud is neither the controller nor the processor.',
    ],
    ['docs/public/support.mdx', 'Managed Cloud does not guarantee email assistance.'],
  ]) {
    const content = `${readFileSync(resolve(root, path), 'utf8')}\n${denial}`;
    assert.equal(
      trustSurfaceContentViolations(path, content).some((violation) =>
        /pending trust decision/u.test(violation),
      ),
      false,
      `expected explicit denial to remain allowed: ${denial}`,
    );
  }
});

test('rejects pending-state escalation and future verification across mapped public surfaces', () => {
  const security = readFileSync(resolve(root, 'SECURITY.md'), 'utf8');
  assert.ok(
    trustSurfaceContentViolations(
      'SECURITY.md',
      `${security}\nThe current and immediately previous versions remain supported.`,
    ).some((violation) => /pending trust decision/u.test(violation)),
  );
  assert.ok(
    trustSurfaceContentViolations(
      'SECURITY.md',
      `${security}\nCritical reports are acknowledged within 24 hours.`,
    ).some((violation) => /pending trust decision/u.test(violation)),
  );
  assert.ok(
    trustSurfaceContentViolations(
      'docs/public/reference/performance.mdx',
      'Production is proven at 99.99% uptime.',
    ).some((violation) => /unsupported numeric/u.test(violation)),
  );
  assert.ok(
    trustSurfaceContentViolations(
      'docs/public/operations/incidents.mdx',
      'Live at https://status.tixkit.com',
    ).some((violation) => /pending trust decision/u.test(violation)),
  );
  assert.ok(
    trustSurfaceContentViolations(
      'docs/public/reference/trust.mdx',
      '---\nlast_verified: 2999-01-01\n---',
      Date.UTC(2026, 6, 16),
    ).some((violation) => /must not be in the future/u.test(violation)),
  );

  const trust = readFileSync(resolve(root, 'docs/public/reference/trust.mdx'), 'utf8');
  for (const disclosure of [
    'No hosted production DR receipt or trusted public keyring is currently published.',
    'The result is only `eligibleForReview`.',
  ]) {
    assert.ok(
      trustSurfaceContentViolations(
        'docs/public/reference/trust.mdx',
        trust.replace(disclosure, ''),
      ).some((violation) => /required trust disclosure is missing/u.test(violation)),
    );
  }
});

test('rejects validation command path escape and non-allowlisted execution', () => {
  const escaped = structuredClone(program);
  escaped.records.find(({ id }) => id === 'dr-evidence').validationCommands[0].argv = [
    'node',
    'scripts/../../outside.mjs',
  ];
  assert.ok(
    trustProgramViolations(escaped, root, publicDistribution).includes(
      'dr-evidence: validation command path escapes the repository',
    ),
  );

  const executable = structuredClone(program);
  executable.records.find(({ id }) => id === 'dr-evidence').validationCommands[0].argv[0] = 'sh';
  assert.ok(
    trustProgramViolations(executable, root, publicDistribution).includes(
      'dr-evidence: validation command executable is not allowlisted',
    ),
  );
});

test('bounded local evidence execution invokes every declared command', async () => {
  const invocations = [];
  const executed = await executeLocalTrustEvidence(program, root, {
    publicDistribution,
    async runner(command, commandRoot) {
      invocations.push({ command, commandRoot });
    },
  });
  assert.equal(executed, 7);
  assert.equal(invocations.length, 7);
  for (const invocation of invocations) {
    assert.equal(invocation.command.argv[0], 'node');
    assert.equal(invocation.commandRoot, root);
  }
});

test('bounded local evidence execution rejects runner failures', async () => {
  for (const expected of [/command failed/u, /timed out/u, /output bounds/u]) {
    await assert.rejects(
      executeLocalTrustEvidence(program, root, {
        publicDistribution,
        runner: async () => {
          throw new Error(`local trust evidence ${expected.source.replace('\\s', ' ')}`);
        },
      }),
      expected,
    );
  }
});

test('forbidden trust claims allow explicit denials but reject affirmative claims', () => {
  const performance = readFileSync(resolve(root, 'docs/public/reference/performance.mdx'), 'utf8');
  assert.equal(
    trustSurfaceContentViolations(
      'docs/public/reference/performance.mdx',
      `${performance}\nDo not claim 99.99% uptime from this local contract.`,
    ).some((violation) => /unsupported numeric/u.test(violation)),
    false,
  );
  const incidents = readFileSync(resolve(root, 'docs/public/operations/incidents.mdx'), 'utf8');
  assert.equal(
    trustSurfaceContentViolations(
      'docs/public/operations/incidents.mdx',
      `${incidents}\nNo public status page is offered at https://status.tixkit.com.`,
    ).some((violation) => /pending trust decision/u.test(violation)),
    false,
  );
  assert.ok(
    trustSurfaceContentViolations(
      'docs/public/reference/performance.mdx',
      `${performance}\nProduction has 99.99% uptime.`,
    ).some((violation) => /unsupported numeric/u.test(violation)),
  );
});

test('validation argv accepts only exact node script and node test shapes', () => {
  const valid = program.records.find(({ id }) => id === 'performance-evidence').validationCommands;
  for (const command of valid) assert.equal(trustValidationCommandViolation(command, root), null);
  const hostile = [
    ['node', '-e', 'process.exit(0)'],
    ['node', '--eval=process.exit(0)'],
    ['node', '--import', 'scripts/lib/trust-program.mjs'],
    ['node', '--loader=../../outside.mjs', 'scripts/__tests__/trust-program.test.mjs'],
    ['node', '--require', 'scripts/lib/trust-program.mjs'],
    [
      'node',
      '--test',
      '--test-reporter=../../outside.mjs',
      'scripts/__tests__/trust-program.test.mjs',
    ],
    ['node', '--test', 'scripts/__tests__/trust-program.test.mjs', '--import=../../outside.mjs'],
  ];
  for (const argv of hostile) {
    assert.match(
      trustValidationCommandViolation({ argv, cwd: '.', timeoutMs: 1_000 }, root),
      /exact node|exact node --test/u,
    );
  }
});

test('artifacts, surfaces and command targets reject final and parent symlink escape', () => {
  const outside = mkdtempSync(resolve(tmpdir(), 'tixkit-trust-outside-'));
  const sandbox = mkdtempSync(resolve(root, 'scripts/__tests__/trust-symlink-test-'));
  try {
    writeFileSync(resolve(outside, 'outside.mjs'), 'export {};\n');
    symlinkSync(resolve(outside, 'outside.mjs'), resolve(sandbox, 'final.mjs'));
    mkdirSync(resolve(sandbox, 'parent'));
    symlinkSync(outside, resolve(sandbox, 'parent/link'));
    const finalPath = `${sandbox.slice(root.length + 1)}/final.mjs`;
    const parentPath = `${sandbox.slice(root.length + 1)}/parent/link/outside.mjs`;

    const artifact = structuredClone(program);
    artifact.records.find(({ id }) => id === 'performance-evidence').publicArtifacts[0] = finalPath;
    assert.ok(
      trustProgramViolations(artifact, root, publicDistribution).some((violation) =>
        /regular non-symlink/u.test(violation),
      ),
    );

    const surface = structuredClone(program);
    surface.surfaces[0].path = parentPath;
    assert.ok(
      trustProgramViolations(surface, root, publicDistribution).some((violation) =>
        /parent symlink/u.test(violation),
      ),
    );

    assert.match(
      trustValidationCommandViolation(
        { argv: ['node', parentPath], cwd: '.', timeoutMs: 1_000 },
        root,
      ),
      /parent symlink/u,
    );
  } finally {
    rmSync(sandbox, { force: true, recursive: true });
    rmSync(outside, { force: true, recursive: true });
  }
});

test('bounded runner uses fixed environment and kills a SIGTERM-resistant process group', async () => {
  const sandbox = mkdtempSync(resolve(root, 'scripts/__tests__/trust-process-test-'));
  const script = resolve(sandbox, 'resistant.mjs');
  const pidFile = resolve(sandbox, 'descendant.pid');
  const environmentFile = resolve(sandbox, 'environment.json');
  try {
    writeFileSync(
      script,
      `import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(environmentFile)},JSON.stringify(process.env));const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});writeFileSync(${JSON.stringify(pidFile)},String(child.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`,
    );
    process.env.TIXKIT_TRUST_SECRET = 'must-not-leak';
    await assert.rejects(
      runBoundedTrustEvidenceCommand(
        {
          argv: ['node', script.slice(root.length + 1)],
          cwd: '.',
          timeoutMs: 300,
        },
        root,
        { terminationGraceMs: 100 },
      ),
      /timed out/u,
    );
    const childEnvironment = JSON.parse(readFileSync(environmentFile, 'utf8'));
    assert.equal(childEnvironment.TIXKIT_TRUST_SECRET, undefined);
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(childEnvironment).filter(([key]) => key !== '__CF_USER_TEXT_ENCODING'),
      ),
      {
        CI: '1',
        NO_COLOR: '1',
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
        TZ: 'UTC',
      },
    );
    let descendantPid;
    for (let attempt = 0; attempt < 20 && descendantPid === undefined; attempt += 1) {
      try {
        descendantPid = Number(readFileSync(pidFile, 'utf8'));
      } catch {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
      }
    }
    assert.ok(Number.isSafeInteger(descendantPid));
    let descendantAlive = true;
    for (let attempt = 0; attempt < 40 && descendantAlive; attempt += 1) {
      try {
        process.kill(descendantPid, 0);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
      } catch (error) {
        if (error?.code !== 'ESRCH') throw error;
        descendantAlive = false;
      }
    }
    assert.equal(descendantAlive, false);
  } finally {
    delete process.env.TIXKIT_TRUST_SECRET;
    rmSync(sandbox, { force: true, recursive: true });
  }
});

test('bounded runner enforces one combined stdout and stderr ceiling', async () => {
  const sandbox = mkdtempSync(resolve(root, 'scripts/__tests__/trust-output-test-'));
  const script = resolve(sandbox, 'oversized.mjs');
  try {
    writeFileSync(
      script,
      "process.stdout.write('a'.repeat(600000));process.stderr.write('b'.repeat(600000));setInterval(()=>{},1000);\n",
    );
    await assert.rejects(
      runBoundedTrustEvidenceCommand(
        { argv: ['node', script.slice(root.length + 1)], cwd: '.', timeoutMs: 5_000 },
        root,
        { terminationGraceMs: 50 },
      ),
      /exceeded output bounds/u,
    );
  } finally {
    rmSync(sandbox, { force: true, recursive: true });
  }
});
