import { createHash, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { jsonSchemaViolations } from './public-distribution.mjs';

export const REQUIRED_TRUST_RECORDS = Object.freeze([
  'cloud-status',
  'data-residency',
  'dr-evidence',
  'incident-history',
  'independent-assessments',
  'managed-sla',
  'performance-evidence',
  'privacy-roles',
  'release-provenance',
  'security-architecture',
  'signed-sbom',
  'subprocessors',
  'support-boundaries',
  'version-lifecycle',
  'vulnerability-response',
]);

export const EXPECTED_TRUST_SURFACES = Object.freeze([
  ['SECURITY.md', ['security-architecture', 'version-lifecycle', 'vulnerability-response']],
  ['SUPPORT.md', ['managed-sla', 'support-boundaries']],
  ['docs/public/operations/incidents.mdx', ['cloud-status', 'incident-history']],
  [
    'docs/public/reference/api-release-train.mdx',
    ['release-provenance', 'signed-sbom', 'version-lifecycle'],
  ],
  [
    'docs/public/reference/api-versions.mdx',
    ['release-provenance', 'signed-sbom', 'version-lifecycle'],
  ],
  ['docs/public/reference/performance.mdx', ['performance-evidence']],
  ['docs/public/reference/trust.mdx', REQUIRED_TRUST_RECORDS],
  ['docs/public/self-hosting/backups-and-restore.mdx', ['dr-evidence']],
  ['docs/public/self-hosting/observability.mdx', ['performance-evidence']],
]);

function validationCommand(argv, timeoutMs) {
  return { argv, cwd: '.', timeoutMs };
}

export const EXPECTED_TRUST_DECISIONS = Object.freeze({
  'cloud-status': ['service-surface', 'managed-cloud', 'not-yet-offered'],
  'data-residency': ['policy', 'managed-cloud', 'pending-policy-decision'],
  'dr-evidence': ['evidence', 'self-hosted', 'locally-proven'],
  'incident-history': ['service-surface', 'managed-cloud', 'not-yet-offered'],
  'independent-assessments': ['evidence', 'public-core', 'pending-external-proof'],
  'managed-sla': ['policy', 'managed-cloud', 'pending-policy-decision'],
  'performance-evidence': ['evidence', 'public-core', 'locally-proven'],
  'privacy-roles': ['policy', 'managed-cloud', 'pending-policy-decision'],
  'release-provenance': ['evidence', 'public-core', 'locally-proven'],
  'security-architecture': ['policy', 'public-core', 'published'],
  'signed-sbom': ['evidence', 'public-core', 'locally-proven'],
  subprocessors: ['policy', 'managed-cloud', 'pending-policy-decision'],
  'support-boundaries': ['policy', 'public-core', 'published'],
  'version-lifecycle': ['policy', 'public-core', 'pending-policy-decision'],
  'vulnerability-response': ['policy', 'public-core', 'pending-policy-decision'],
});

export const EXPECTED_TRUST_CLAIMS = Object.freeze({
  'cloud-status': 'No public Tixkit Cloud status page is offered.',
  'data-residency': 'Managed Cloud residency and transfer commitments are not published.',
  'dr-evidence':
    'Self-Hosted DR contracts and rehearsal tooling are locally validated; no hosted or production DR receipt is published.',
  'incident-history': 'No public Tixkit Cloud incident history is offered.',
  'independent-assessments':
    'No independent security assessment or remediation summary has been published.',
  'managed-sla': 'Managed support plans and SLA commitments are not published.',
  'performance-evidence':
    'Performance budgets, decline-separated payment signals and trusted single-host regression, trend, capacity, fault and soak workflow contracts are locally validated; no hosted or production result is published.',
  'privacy-roles':
    'Managed Cloud controller, processor and retention responsibilities are not published.',
  'release-provenance':
    'Public release provenance generation and consumer verification are locally tested workflow contracts; no approved public release receipt exists.',
  'security-architecture':
    'The public architecture and security boundaries are documented without depending on private Cloud source.',
  'signed-sbom':
    'SBOM generation and attestation-consumer checks are locally tested workflow contracts; no approved hosted release verification receipt exists.',
  subprocessors: 'A managed Cloud subprocessor list is not published.',
  'support-boundaries':
    'Public repository support is best effort and has no guaranteed response or resolution time.',
  'version-lifecycle': 'A product-wide supported-version and end-of-life policy is not published.',
  'vulnerability-response':
    'Vulnerability acknowledgement, triage and remediation targets are not approved.',
});

export const EXPECTED_TRUST_BLOCKERS = Object.freeze({
  'cloud-status':
    'Tixkit Cloud is not generally available and no production status surface has been launched.',
  'data-residency':
    'Product, infrastructure, privacy and legal review must approve the managed residency policy.',
  'dr-evidence':
    'A protected hosted rehearsal with retained RPO and RTO evidence is still required.',
  'incident-history': 'No generally available managed service or public status history exists.',
  'independent-assessments':
    'An independent assessor must complete the work and approve a public summary.',
  'managed-sla':
    'Commercial, operational and legal owners must approve managed support commitments.',
  'performance-evidence':
    'Supported-profile capacity, approved service objectives, routed-alert proof and hosted production evidence remain incomplete.',
  'privacy-roles': 'The managed operating model requires product, privacy and legal approval.',
  'release-provenance':
    'The protected public release workflow has not published an approved release.',
  'security-architecture': null,
  'signed-sbom': 'Hosted verification requires an approved immutable public release.',
  subprocessors: 'The managed vendor inventory and legal review are incomplete.',
  'support-boundaries': null,
  'version-lifecycle':
    'Release, product and security owners must approve lifecycle windows before the first public release.',
  'vulnerability-response':
    'Security and maintainer owners must approve severity-based response targets.',
});

export const EXPECTED_TRUST_EVIDENCE = Object.freeze({
  'cloud-status': [[], []],
  'data-residency': [[], []],
  'dr-evidence': [
    [
      'docs/public/self-hosting/backups-and-restore.mdx',
      'infra/scripts/production-backup.sh',
      'infra/scripts/production-restore.sh',
      'scripts/__tests__/dr-safety.test.mjs',
      'scripts/__tests__/production-dr.integration.test.mjs',
      'scripts/verify-production-rehearsal.mjs',
    ],
    [
      validationCommand(
        [
          'node',
          '--test',
          '--test-name-pattern',
          '^(?!adapter timeout).*',
          'scripts/__tests__/production-rehearsal.test.mjs',
        ],
        120_000,
      ),
    ],
  ],
  'incident-history': [[], []],
  'independent-assessments': [[], []],
  'managed-sla': [[], []],
  'performance-evidence': [
    [
      '.github/workflows/performance-capacity.yml',
      '.github/workflows/performance-fault.yml',
      '.github/workflows/performance-nightly.yml',
      '.github/workflows/performance-soak.yml',
      '.github/workflows/performance-temporal-fault.yml',
      'apps/checkout/src/__tests__/web-vitals-reporter.test.tsx',
      'apps/checkout/src/app/layout.tsx',
      'apps/checkout/src/components/web-vitals-reporter.tsx',
      'docs/public/reference/performance.mdx',
      'docs/public/self-hosting/observability.mdx',
      'infra/helm/tixkit/templates/_helpers.tpl',
      'infra/helm/tixkit/templates/monitoring.yaml',
      'infra/helm/tixkit/values.yaml',
      'packages/api/src/__tests__/observability.test.ts',
      'packages/api/src/__tests__/rum-observability.test.ts',
      'packages/api/src/observability.ts',
      'packages/api/src/routes/modules/rum.ts',
      'packages/api/src/routes/modules/tenant.ts',
      'packages/api/src/routes/registry.ts',
      'packages/provider-clients/src/__tests__/index.test.ts',
      'packages/provider-clients/src/__tests__/stripe.test.ts',
      'packages/provider-clients/src/index.ts',
      'packages/provider-clients/src/stripe.ts',
      'packages/shared/src/__tests__/observability.test.ts',
      'packages/shared/src/observability.ts',
      'packages/workflows/src/__tests__/observability.test.ts',
      'packages/workflows/src/activities/checkout.ts',
      'packages/workflows/src/activities/refund.ts',
      'packages/workflows/src/observability.ts',
      'performance-budgets.json',
      'performance-capacity.trusted.json',
      'performance-faults.trusted.json',
      'performance-scenarios.nightly.json',
      'performance-soak.trusted.json',
      'performance-temporal-fault.trusted.json',
      'performance-trends.trusted.json',
      'scripts/__tests__/check-performance-budgets.test.mjs',
      'scripts/__tests__/helm-production-profile.test.mjs',
      'scripts/check-performance-budgets.mjs',
      'scripts/performance-capacity.mjs',
      'scripts/performance-fault.mjs',
      'scripts/performance-scenario.mjs',
      'scripts/performance-soak.mjs',
      'scripts/performance-temporal-fault.mjs',
      'scripts/performance-trends.mjs',
    ],
    [
      validationCommand(
        ['node', '--test', 'scripts/__tests__/check-performance-budgets.test.mjs'],
        30_000,
      ),
      validationCommand(
        [
          'node',
          '--test',
          'scripts/__tests__/performance-capacity.test.mjs',
          'scripts/__tests__/performance-evidence.test.mjs',
          'scripts/__tests__/performance-fault.test.mjs',
          'scripts/__tests__/performance-scenario.test.mjs',
          'scripts/__tests__/performance-soak.test.mjs',
          'scripts/__tests__/performance-temporal-fault.test.mjs',
          'scripts/__tests__/performance-trends.test.mjs',
        ],
        120_000,
      ),
    ],
  ],
  'privacy-roles': [[], []],
  'release-provenance': [
    [
      'docs/public/reference/api-release-train.mdx',
      'docs/public/reference/api-versions.mdx',
      'scripts/verify-public-api-release.mjs',
    ],
    [
      validationCommand(
        ['node', '--test', 'scripts/__tests__/public-release-verifier.test.mjs'],
        120_000,
      ),
    ],
  ],
  'security-architecture': [['ARCHITECTURE.md', 'SECURITY.md'], []],
  'signed-sbom': [
    ['.github/workflows/public-artifact-release.yml', 'scripts/validate-staged-public-release.mjs'],
    [
      validationCommand(
        [
          'node',
          '--test',
          '--test-name-pattern',
          'release workflow resumes staged bytes',
          'scripts/__tests__/cloud-core-consumer.test.mjs',
        ],
        120_000,
      ),
    ],
  ],
  subprocessors: [[], []],
  'support-boundaries': [['SUPPORT.md', 'docs/public/support.mdx'], []],
  'version-lifecycle': [[], []],
  'vulnerability-response': [[], []],
});

const DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_EVIDENCE_OUTPUT_BYTES = 1024 * 1024;
const ALLOWED_EVIDENCE_EXECUTABLES = new Set(['node']);

const SURFACE_REQUIRED_DISCLOSURES = Object.freeze({
  'SECURITY.md': [
    'does not promise a fixed service-level agreement',
    'No product-wide supported-version or end-of-life window is approved or published.',
  ],
  'SUPPORT.md': [
    'Public issue support is best effort and does not carry a guaranteed response or resolution time.',
  ],
  'docs/public/operations/incidents.mdx': [
    'This Self-Hosted runbook is not a Tixkit Cloud status page or public managed incident history.',
  ],
  'docs/public/reference/api-release-train.mdx': [
    'No product-wide supported-version or deprecation window is approved or published.',
    'no approved public release receipt exists',
  ],
  'docs/public/reference/api-versions.mdx': [
    'No product-wide supported-version, end-of-life, or deprecation window is approved or published',
  ],
  'docs/public/reference/performance.mdx': [
    'The trend implementation is locally validated, but no hosted trend artifact is claimed',
    'A committed executable workflow is not a hosted soak result',
  ],
  'docs/public/reference/trust.mdx': [
    'it does not mean a hosted production run occurred',
    'are not generally available',
    'A keyring supplied by the same untrusted party as the receipt does not establish trust.',
    'does not execute the named semantic evidence validator',
  ],
  'docs/public/self-hosting/backups-and-restore.mdx': [
    'This is real local provider proof, not production-like Kubernetes',
  ],
  'docs/public/self-hosting/observability.mdx': [
    'do not claim abuse resistance, an SLO or representative user experience',
    'A rendered `ServiceMonitor` alone is not runtime proof.',
  ],
});

const FORBIDDEN_SURFACE_CLAIMS = Object.freeze([
  /current and immediately previous versions remain supported/iu,
  /(?:acknowledge|triage|remediat\w*)[^.\n]{0,80}\bwithin\s+\d/iu,
  /https?:\/\/(?:status\.)?tixkit\.(?:com|dev)/iu,
]);

function parseCalendarDate(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return null;
  const timestamp = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const date = new Date(timestamp);
  return date.toISOString().slice(0, 10) === value ? timestamp : null;
}

function isInsideRoot(root, candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.includes('\0')) {
    return false;
  }
  const rootPath = resolve(root);
  const candidatePath = resolve(rootPath, candidate);
  const path = relative(rootPath, candidatePath);
  return path !== '..' && !path.startsWith(`..${sep}`) && !path.startsWith('/');
}

function secureRegularFile(root, candidate) {
  if (!isInsideRoot(root, candidate)) return { reason: 'lexical-escape' };
  const candidatePath = resolve(root, candidate);
  const metadata = lstatSync(candidatePath, { throwIfNoEntry: false });
  if (!metadata) return { reason: 'missing' };
  if (!metadata.isFile() || metadata.isSymbolicLink()) return { reason: 'not-regular' };
  try {
    const rootPath = realpathSync(root);
    const realPath = realpathSync(candidatePath);
    const location = relative(rootPath, realPath);
    if (location === '..' || location.startsWith(`..${sep}`) || location.startsWith('/')) {
      return { reason: 'symlink-escape' };
    }
    return { path: realPath };
  } catch {
    return { reason: 'missing' };
  }
}

function publicRoots(manifest) {
  return new Set([
    ...manifest.source.rootDirectories,
    ...manifest.source.applications,
    ...manifest.source.packages,
    ...manifest.source.documentation,
  ]);
}

function isPublicPath(path, manifest, roots) {
  return (
    manifest.source.rootFiles.includes(path) ||
    [...roots].some((entry) => path === entry || path.startsWith(`${entry}/`))
  );
}

function schemaViolations(program, schema) {
  return jsonSchemaViolations(program, schema).map(
    (violation) => `trust program schema ${violation}`,
  );
}

function containsUnsupportedClaim(value) {
  return [
    /\b\d+(?:\.\d+)?%\s*(?:uptime|availability|SLA)\b/iu,
    /\b(?:RPO|RTO)\s*(?:of|[:=])?\s*\d/iu,
    /\b(?:SOC\s*2|ISO\s*27001|PCI\s*DSS)\s*(?:certified|compliant|attested)?\b/iu,
    /\b(?:us|eu|ap|ca|sa|me|af)-(?:central|east|west|north|south)-\d\b/iu,
  ].some((pattern) => hasAffirmativeMatch(value, pattern));
}

function hasAffirmativeMatch(value, pattern) {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const matcher = new RegExp(pattern.source, flags);
  for (const match of value.matchAll(matcher)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const sentenceStart = Math.max(
      value.lastIndexOf('.', start - 1),
      value.lastIndexOf('!', start - 1),
      value.lastIndexOf('?', start - 1),
      value.lastIndexOf('\n', start - 1),
    );
    const endings = [
      value.indexOf('.', end),
      value.indexOf('!', end),
      value.indexOf('?', end),
      value.indexOf('\n', end),
    ].filter((index) => index >= 0);
    const sentenceEnd = endings.length === 0 ? value.length : Math.min(...endings) + 1;
    const sentence = value.slice(sentenceStart + 1, sentenceEnd);
    const relativeStart = start - sentenceStart - 1;
    const relativeEnd = relativeStart + match[0].length;
    const prefix = sentence.slice(Math.max(0, relativeStart - 120), relativeStart);
    const suffix = sentence.slice(relativeEnd, relativeEnd + 120);
    const deniedBefore =
      /\b(?:cannot|can't|do not|does not|is not|isn't|never|no|not|without)\b[^.;!?]*$/iu.test(
        prefix,
      ) && !/\b(?:but|however|yet)\b[^.;!?]*$/iu.test(prefix);
    const deniedAfter =
      /^\s*(?:is|are|was|were|has|have)?\s*(?:not|never)\s+(?:available|claimed|offered|proven|published|supported)/iu.test(
        suffix,
      );
    if (!deniedBefore && !deniedAfter) return true;
  }
  return false;
}

export function renderTrustProgram(program) {
  const lines = [
    '{/* trust-program:start */}',
    '| Trust record | Scope | State | Current claim | Public artifacts / blocker |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const record of program.records) {
    const references = record.publicArtifacts.map((path) => `\`${path}\``).join('<br />');
    const detail = [references, record.blocker ? `Blocker: ${record.blocker}` : '']
      .filter(Boolean)
      .join('<br />');
    lines.push(
      `| \`${record.id}\` | ${record.scope} | ${record.state} | ${record.claim} | ${detail} |`,
    );
  }
  lines.push('{/* trust-program:end */}');
  return `${lines.join('\n')}\n`;
}

function normalizedTrustTable(value) {
  const matches = [
    ...value.matchAll(
      /\{\/\* trust-program:start \*\/\}([\s\S]*?)\{\/\* trust-program:end \*\/\}/gu,
    ),
  ];
  if (matches.length !== 1) return null;
  return matches[0][1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|'))
    .filter((line) => !/^\|(?:\s*:?-+:?\s*\|)+$/u.test(line))
    .map((line) =>
      line
        .slice(1, -1)
        .split('|')
        .map((cell) => cell.trim())
        .join('|'),
    )
    .join('\n');
}

export function trustDocumentationMatches(program, documentation) {
  const expected = normalizedTrustTable(renderTrustProgram(program));
  const actual = normalizedTrustTable(documentation);
  return expected !== null && actual === expected;
}

export function trustProgramViolations(program, root, publicDistribution) {
  const schema = JSON.parse(
    readFileSync(resolve(root, 'distribution/trust-program.schema.json'), 'utf8'),
  );
  const violations = schemaViolations(program, schema);
  if (violations.length > 0) return violations;

  const ids = program.records.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) violations.push('trust record IDs must be unique');
  if (ids.some((id, index) => id !== [...ids].sort()[index]))
    violations.push('trust record IDs must be sorted lexicographically');
  for (const id of REQUIRED_TRUST_RECORDS)
    if (!ids.includes(id)) violations.push(`required trust record is missing: ${id}`);
  for (const id of ids)
    if (!REQUIRED_TRUST_RECORDS.includes(id)) violations.push(`unsupported trust record: ${id}`);

  if (
    JSON.stringify(program.surfaces.map(({ path, recordIds }) => [path, recordIds])) !==
    JSON.stringify(EXPECTED_TRUST_SURFACES)
  ) {
    violations.push('accepted trust-bearing surface map drifted');
  }

  const asOf = parseCalendarDate(program.asOf);
  if (asOf === null) violations.push('trust program asOf must be a real calendar date');
  else if (asOf > Date.now()) violations.push('trust program asOf must not be in the future');
  else if (Date.now() - asOf > program.maxRecordAgeDays * DAY_MS)
    violations.push('trust program snapshot exceeds the declared freshness window');

  const roots = publicRoots(publicDistribution);
  for (const record of program.records) {
    const expected = EXPECTED_TRUST_DECISIONS[record.id];
    if (
      expected &&
      JSON.stringify([record.kind, record.scope, record.state]) !== JSON.stringify(expected)
    ) {
      violations.push(`${record.id}: accepted kind, scope, or state decision drifted`);
    }
    if (EXPECTED_TRUST_CLAIMS[record.id] && record.claim !== EXPECTED_TRUST_CLAIMS[record.id])
      violations.push(`${record.id}: accepted public claim drifted`);
    if (
      Object.hasOwn(EXPECTED_TRUST_BLOCKERS, record.id) &&
      (record.blocker ?? null) !== EXPECTED_TRUST_BLOCKERS[record.id]
    )
      violations.push(`${record.id}: accepted public blocker drifted`);
    const expectedEvidence = EXPECTED_TRUST_EVIDENCE[record.id];
    if (
      expectedEvidence &&
      JSON.stringify([record.publicArtifacts, record.validationCommands ?? []]) !==
        JSON.stringify(expectedEvidence)
    )
      violations.push(`${record.id}: accepted public artifacts or validation commands drifted`);
    if ((record.immutableEvidence?.length ?? 0) > 0)
      violations.push(`${record.id}: immutable evidence is not approved for this trust snapshot`);
    const lastVerified = parseCalendarDate(record.lastVerified);
    if (lastVerified === null) violations.push(`${record.id}: lastVerified is not a real date`);
    else if (asOf !== null) {
      if (lastVerified > asOf) violations.push(`${record.id}: lastVerified is after asOf`);
      if (asOf - lastVerified > program.maxRecordAgeDays * DAY_MS)
        violations.push(`${record.id}: lastVerified exceeds the declared freshness window`);
    }
    for (const path of record.publicArtifacts) {
      const artifact = secureRegularFile(root, path);
      if (artifact.reason === 'lexical-escape') {
        violations.push(`${record.id}: public artifact escapes the repository: ${path}`);
        continue;
      }
      if (!isPublicPath(path, publicDistribution, roots))
        violations.push(`${record.id}: artifact is not in the public distribution: ${path}`);
      if (artifact.reason === 'missing')
        violations.push(`${record.id}: public artifact does not exist: ${path}`);
      else if (artifact.reason === 'not-regular')
        violations.push(
          `${record.id}: public artifact must be a regular non-symlink file: ${path}`,
        );
      else if (artifact.reason === 'symlink-escape')
        violations.push(`${record.id}: public artifact escapes through a parent symlink: ${path}`);
    }
    for (const evidence of record.immutableEvidence ?? []) {
      if (!isInsideRoot(root, evidence.path)) {
        violations.push(`${record.id}: immutable evidence escapes the repository`);
        continue;
      }
      if (!isPublicPath(evidence.path, publicDistribution, roots))
        violations.push(`${record.id}: immutable evidence is not in the public distribution`);
      const evidenceFile = secureRegularFile(root, evidence.path);
      if (evidenceFile.reason) {
        violations.push(`${record.id}: immutable evidence must be a regular non-symlink file`);
        continue;
      }
      const actual = createHash('sha256').update(readFileSync(evidenceFile.path)).digest();
      const expectedHash = Buffer.from(evidence.sha256, 'hex');
      if (expectedHash.length !== actual.length || !timingSafeEqual(actual, expectedHash))
        violations.push(`${record.id}: immutable evidence checksum mismatch`);
    }
    const text = `${record.claim}\n${record.blocker ?? ''}`;
    if (containsUnsupportedClaim(text))
      violations.push(`${record.id}: unsupported numeric, regional, or assessment claim`);
    if (
      record.state === 'locally-proven' &&
      (!/(?:local|workflow)/iu.test(record.claim) ||
        !/(?:no|not)\s+(?:approved\s+)?(?:hosted|production|public)/iu.test(record.claim))
    ) {
      violations.push(`${record.id}: local evidence must explicitly deny hosted proof`);
    }
    if (
      record.state === 'pending-external-proof' &&
      !/(?:no|not).*(?:published|completed|available)/iu.test(record.claim)
    ) {
      violations.push(`${record.id}: pending external evidence must deny published proof`);
    }
    if (
      record.state === 'not-yet-offered' &&
      (!/(?:no public|not .*offered)/iu.test(record.claim) || /https?:\/\//iu.test(text))
    ) {
      violations.push(`${record.id}: unavailable managed surface must not imply a live URL`);
    }
    for (const command of record.validationCommands ?? []) {
      const commandViolation = trustValidationCommandViolation(command, root);
      if (commandViolation) violations.push(`${record.id}: ${commandViolation}`);
    }
  }

  for (const surface of program.surfaces) {
    const surfaceFile = secureRegularFile(root, surface.path);
    if (surfaceFile.reason === 'lexical-escape') {
      violations.push(`trust-bearing surface escapes the repository: ${surface.path}`);
      continue;
    }
    if (!isPublicPath(surface.path, publicDistribution, roots))
      violations.push(`trust-bearing surface is not in the public distribution: ${surface.path}`);
    if (surfaceFile.reason === 'missing') {
      violations.push(`trust-bearing surface does not exist: ${surface.path}`);
      continue;
    }
    if (surfaceFile.reason === 'not-regular') {
      violations.push(`trust-bearing surface must be a regular non-symlink file: ${surface.path}`);
      continue;
    }
    if (surfaceFile.reason === 'symlink-escape') {
      violations.push(`trust-bearing surface escapes through a parent symlink: ${surface.path}`);
      continue;
    }
    for (const recordId of surface.recordIds)
      if (!ids.includes(recordId))
        violations.push(`${surface.path}: mapped trust record does not exist: ${recordId}`);
    violations.push(
      ...trustSurfaceContentViolations(surface.path, readFileSync(surfaceFile.path, 'utf8')),
    );
  }

  const documentationFile = secureRegularFile(root, program.documentation);
  if (
    documentationFile.path &&
    !trustDocumentationMatches(program, readFileSync(documentationFile.path, 'utf8'))
  )
    violations.push('trust documentation table does not match the registry');
  return violations;
}

const NODE_SCRIPT_PATTERN = /^scripts\/[a-zA-Z0-9_./-]+\.mjs$/u;
const NODE_TEST_PATTERN = /^scripts\/[a-zA-Z0-9_./-]+\.test\.mjs$/u;

export function trustValidationCommandViolation(command, root) {
  const [executable, ...args] = command.argv;
  if (!ALLOWED_EVIDENCE_EXECUTABLES.has(executable))
    return 'validation command executable is not allowlisted';
  if (command.cwd !== '.') return 'validation command cwd must be the repository root';
  if (args.some((argument) => /[\p{Cc};&|><`$]/u.test(argument)))
    return 'validation command contains shell or environment expansion syntax';
  let targets;
  if (args[0] === '--test') {
    let targetIndex = 1;
    if (args[1] === '--test-name-pattern') {
      const pattern = args[2];
      if (!pattern || pattern.length > 256 || /[\p{Cc};&|><`$]/u.test(pattern)) {
        return 'validation command test-name pattern is unsafe';
      }
      targetIndex = 3;
    }
    targets = args.slice(targetIndex);
    if (targets.length === 0 || targets.some((target) => !NODE_TEST_PATTERN.test(target))) {
      return 'validation command must use exact node --test file arguments';
    }
  } else if (args.length === 1 && NODE_SCRIPT_PATTERN.test(args[0])) {
    targets = args;
  } else {
    return 'validation command must use an exact node script or node --test shape';
  }
  for (const target of targets) {
    const file = secureRegularFile(root, target);
    if (file.reason === 'lexical-escape') return 'validation command path escapes the repository';
    if (file.reason === 'missing') return `validation command path does not exist: ${target}`;
    if (file.reason === 'not-regular')
      return `validation command path must be a regular non-symlink file: ${target}`;
    if (file.reason === 'symlink-escape')
      return `validation command path escapes through a parent symlink: ${target}`;
  }
  return null;
}

export function trustSurfaceContentViolations(path, content, now = Date.now()) {
  const violations = [];
  for (const disclosure of SURFACE_REQUIRED_DISCLOSURES[path] ?? [])
    if (!content.includes(disclosure))
      violations.push(`${path}: required trust disclosure is missing`);
  if (containsUnsupportedClaim(content))
    violations.push(`${path}: unsupported numeric, regional, or assessment claim`);
  for (const pattern of FORBIDDEN_SURFACE_CLAIMS)
    if (hasAffirmativeMatch(content, pattern))
      violations.push(`${path}: public claim conflicts with a pending trust decision`);
  const lastVerified = /^last_verified:\s*(\d{4}-\d{2}-\d{2})\s*$/mu.exec(content)?.[1];
  if (lastVerified) {
    const verifiedAt = parseCalendarDate(lastVerified);
    if (verifiedAt === null) violations.push(`${path}: last_verified is not a real date`);
    else if (verifiedAt > now) violations.push(`${path}: last_verified must not be in the future`);
  }
  return violations;
}

function fixedEvidenceEnvironment() {
  return Object.freeze({
    CI: '1',
    NO_COLOR: '1',
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    TZ: 'UTC',
  });
}

function signalProcessGroup(child, signal) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

export function runBoundedTrustEvidenceCommand(command, root, options = {}) {
  const [, ...args] = command.argv;
  const spawnProcess = options.spawnProcess ?? spawn;
  const terminationGraceMs = options.terminationGraceMs ?? 1_000;
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawnProcess(process.execPath, args, {
      cwd: resolve(root),
      detached: process.platform !== 'win32',
      env: fixedEvidenceEnvironment(),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let outputBytes = 0;
    let terminationReason;
    let closeCode;
    let closeSignal;
    let settled = false;
    let killTimer;
    let deadline;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(killTimer);
      if (terminationReason) {
        rejectPromise(new Error(`local trust evidence command ${terminationReason}`));
      } else if (closeSignal || closeCode !== 0) {
        rejectPromise(new Error('local trust evidence command failed'));
      } else {
        resolvePromise();
      }
    };
    const terminate = (reason) => {
      if (terminationReason) return;
      terminationReason = reason;
      signalProcessGroup(child, 'SIGTERM');
      killTimer = setTimeout(() => {
        signalProcessGroup(child, 'SIGKILL');
        setTimeout(finish, 25);
      }, terminationGraceMs);
    };
    const consume = (chunk) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > MAX_EVIDENCE_OUTPUT_BYTES) terminate('exceeded output bounds');
    };
    child.stdout?.on('data', consume);
    child.stderr?.on('data', consume);
    child.once('error', () => {
      if (terminationReason) return;
      terminationReason = 'failed';
      finish();
    });
    child.once('close', (code, signal) => {
      closeCode = code;
      closeSignal = signal;
      if (!terminationReason) finish();
    });
    deadline = setTimeout(() => terminate('timed out'), command.timeoutMs);
    deadline.unref?.();
  });
}

export async function executeLocalTrustEvidence(program, root, options = {}) {
  validateTrustProgram(program, root, options.publicDistribution);
  const runner = options.runner ?? runBoundedTrustEvidenceCommand;
  let executed = 0;
  for (const record of program.records) {
    if (record.state !== 'locally-proven') continue;
    for (const command of record.validationCommands ?? []) {
      try {
        await runner(command, root);
      } catch (error) {
        const reason =
          error instanceof Error ? error.message : 'local trust evidence command failed';
        throw new Error(`${record.id}: ${reason}`, { cause: error });
      }
      executed += 1;
    }
  }
  return executed;
}

export function validateTrustProgram(program, root, publicDistribution) {
  const manifest =
    publicDistribution ??
    JSON.parse(readFileSync(resolve(root, 'distribution/public-distribution.json'), 'utf8'));
  const violations = trustProgramViolations(program, root, manifest);
  if (violations.length > 0)
    throw new Error(`trust program validation failed:\n${violations.join('\n')}`);
  return program;
}
