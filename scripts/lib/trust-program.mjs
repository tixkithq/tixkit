import { createHash, timingSafeEqual } from 'node:crypto';
import { lstatSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
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
    'Bundle and trusted single-host regression evidence are locally validated; no production capacity, soak, fault or RUM proof is published.',
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
    'Supported-profile capacity and hosted production evidence remain incomplete.',
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
    ['docs/public/self-hosting/backups-and-restore.mdx', 'scripts/verify-production-rehearsal.mjs'],
    ['node --test scripts/__tests__/production-rehearsal.test.mjs'],
  ],
  'incident-history': [[], []],
  'independent-assessments': [[], []],
  'managed-sla': [[], []],
  'performance-evidence': [
    ['docs/public/reference/performance.mdx', 'performance-budgets.json'],
    ['bun run check:performance-budgets'],
  ],
  'privacy-roles': [[], []],
  'release-provenance': [
    ['docs/public/reference/api-release-train.mdx', 'scripts/verify-public-api-release.mjs'],
    ['node --test scripts/__tests__/public-release-verifier.test.mjs'],
  ],
  'security-architecture': [['ARCHITECTURE.md', 'SECURITY.md'], []],
  'signed-sbom': [
    ['.github/workflows/public-artifact-release.yml', 'scripts/validate-staged-public-release.mjs'],
    ['node --test scripts/__tests__/cloud-core-consumer.test.mjs'],
  ],
  subprocessors: [[], []],
  'support-boundaries': [['SUPPORT.md', 'docs/public/support.mdx'], []],
  'version-lifecycle': [[], []],
  'vulnerability-response': [[], []],
});

const DAY_MS = 24 * 60 * 60 * 1_000;

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
  ].some((pattern) => pattern.test(value));
}

export function renderTrustProgram(program) {
  const lines = [
    '<!-- trust-program:start -->',
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
  lines.push('<!-- trust-program:end -->');
  return `${lines.join('\n')}\n`;
}

function normalizedTrustTable(value) {
  const matches = [
    ...value.matchAll(/<!-- trust-program:start -->([\s\S]*?)<!-- trust-program:end -->/gu),
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
      if (!isInsideRoot(root, path)) {
        violations.push(`${record.id}: public artifact escapes the repository: ${path}`);
        continue;
      }
      if (!isPublicPath(path, publicDistribution, roots))
        violations.push(`${record.id}: artifact is not in the public distribution: ${path}`);
      if (!statSync(resolve(root, path), { throwIfNoEntry: false })?.isFile())
        violations.push(`${record.id}: public artifact does not exist: ${path}`);
    }
    for (const evidence of record.immutableEvidence ?? []) {
      if (!isInsideRoot(root, evidence.path)) {
        violations.push(`${record.id}: immutable evidence escapes the repository`);
        continue;
      }
      if (!isPublicPath(evidence.path, publicDistribution, roots))
        violations.push(`${record.id}: immutable evidence is not in the public distribution`);
      const evidencePath = resolve(root, evidence.path);
      const file = lstatSync(evidencePath, { throwIfNoEntry: false });
      if (!file?.isFile() || file.isSymbolicLink()) {
        violations.push(`${record.id}: immutable evidence must be a regular non-symlink file`);
        continue;
      }
      const actual = createHash('sha256').update(readFileSync(evidencePath)).digest();
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
    for (const command of record.validationCommands ?? [])
      if (/[\n\r;&|><`$]/u.test(command))
        violations.push(`${record.id}: validation command contains shell composition`);
  }

  const documentation = readFileSync(resolve(root, program.documentation), 'utf8');
  if (!trustDocumentationMatches(program, documentation))
    violations.push('trust documentation table does not match the registry');
  return violations;
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
