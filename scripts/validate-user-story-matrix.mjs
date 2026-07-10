#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import process from 'node:process';

const DEFAULT_MATRIX_PATH = 'docs/completion/user-story-test-matrix.md';
const DEFAULT_BACKLOG_PATH = 'docs/completion/backlog.md';
const ALLOWED_STATUSES = new Set(['Covered', 'Partial', 'Missing', 'Deferred', 'Managed']);
const ALLOWED_LAYERS = new Set(['U', 'I', 'C', 'E', 'P', 'L', 'S', 'A']);
const SUMMARY_HEADER = 'Persona group';
const STORY_ID_PATTERN = /^US-[A-Z]+-\d{3}$/;
const PERSONA_PREFIX_PATTERN = /\((US-[A-Z]+)\)$/;
const REQUIRED_STORY_SCOPE_HASH =
  'd38cade4da6cd9159013f084ca01bc38b7cb329b40a33c45d1ac2e6146e09b8a';
const REQUIRED_PERSONA_STORY_COUNTS = new Map([
  ['Organizer / Admin', 30],
  ['Buyer / Attendee', 21],
  ['Scanner / Door Staff', 8],
  ['Box-office Operator (Phase 5)', 7],
  ['Developer / Integrator', 14],
  ['Marketer / Messaging', 11],
  ['Content Editor (Phase 6)', 12],
  ['Finance / Reporting', 11],
  ['Tenant / Platform Admin', 8],
  ['Privacy / Compliance', 5],
  ['Self-hoster / Operator', 12],
  ['Widget / Embed', 7],
]);
const REQUIRED_STORY_IDS = new Set([
  'US-ORG-001',
  'US-ORG-002',
  'US-ORG-003',
  'US-ORG-004',
  'US-ORG-005',
  'US-ORG-006',
  'US-ORG-007',
  'US-ORG-008',
  'US-ORG-009',
  'US-ORG-010',
  'US-ORG-011',
  'US-ORG-012',
  'US-ORG-013',
  'US-ORG-014',
  'US-ORG-015',
  'US-ORG-016',
  'US-ORG-017',
  'US-ORG-018',
  'US-ORG-019',
  'US-ORG-020',
  'US-ORG-021',
  'US-ORG-022',
  'US-ORG-023',
  'US-ORG-024',
  'US-ORG-025',
  'US-ORG-026',
  'US-ORG-027',
  'US-ORG-028',
  'US-ORG-029',
  'US-ORG-030',
  'US-BUY-001',
  'US-BUY-002',
  'US-BUY-003',
  'US-BUY-004',
  'US-BUY-005',
  'US-BUY-006',
  'US-BUY-007',
  'US-BUY-008',
  'US-BUY-009',
  'US-BUY-010',
  'US-BUY-011',
  'US-BUY-012',
  'US-BUY-013',
  'US-BUY-014',
  'US-BUY-015',
  'US-BUY-016',
  'US-BUY-017',
  'US-BUY-018',
  'US-BUY-019',
  'US-BUY-020',
  'US-BUY-021',
  'US-SCAN-001',
  'US-SCAN-002',
  'US-SCAN-003',
  'US-SCAN-004',
  'US-SCAN-005',
  'US-SCAN-006',
  'US-SCAN-007',
  'US-SCAN-008',
  'US-POS-001',
  'US-POS-002',
  'US-POS-003',
  'US-POS-004',
  'US-POS-005',
  'US-POS-006',
  'US-POS-007',
  'US-DEV-001',
  'US-DEV-002',
  'US-DEV-003',
  'US-DEV-004',
  'US-DEV-005',
  'US-DEV-006',
  'US-DEV-007',
  'US-DEV-008',
  'US-DEV-009',
  'US-DEV-010',
  'US-DEV-011',
  'US-DEV-012',
  'US-DEV-013',
  'US-DEV-014',
  'US-MSG-001',
  'US-MSG-002',
  'US-MSG-003',
  'US-MSG-004',
  'US-MSG-005',
  'US-MSG-006',
  'US-MSG-007',
  'US-MSG-008',
  'US-MSG-009',
  'US-MSG-010',
  'US-MSG-011',
  'US-CNT-001',
  'US-CNT-002',
  'US-CNT-003',
  'US-CNT-004',
  'US-CNT-005',
  'US-CNT-006',
  'US-CNT-007',
  'US-CNT-008',
  'US-CNT-009',
  'US-CNT-010',
  'US-CNT-011',
  'US-CNT-012',
  'US-RPT-001',
  'US-RPT-002',
  'US-RPT-003',
  'US-RPT-004',
  'US-RPT-005',
  'US-RPT-006',
  'US-RPT-007',
  'US-RPT-008',
  'US-RPT-009',
  'US-RPT-010',
  'US-RPT-011',
  'US-TEN-001',
  'US-TEN-002',
  'US-TEN-003',
  'US-TEN-004',
  'US-TEN-005',
  'US-TEN-006',
  'US-TEN-007',
  'US-TEN-008',
  'US-PRV-001',
  'US-PRV-002',
  'US-PRV-003',
  'US-PRV-004',
  'US-PRV-005',
  'US-OPS-001',
  'US-OPS-002',
  'US-OPS-003',
  'US-OPS-004',
  'US-OPS-005',
  'US-OPS-006',
  'US-OPS-007',
  'US-OPS-008',
  'US-OPS-009',
  'US-OPS-010',
  'US-OPS-011',
  'US-OPS-012',
  'US-WID-001',
  'US-WID-002',
  'US-WID-003',
  'US-WID-004',
  'US-WID-005',
  'US-WID-006',
  'US-WID-007',
]);
const REQUIRED_EXCEPTION_STORY_STATUSES = new Map([
  ['US-BUY-004', 'Deferred'],
  ['US-POS-007', 'Managed'],
  ['US-RPT-011', 'Managed'],
]);
const REQUIRED_EXCEPTION_STORY_EVIDENCE = new Map([
  ['US-BUY-004', [/2026-06-30/, /PayPal/i, /C-071/, /new product decision/i]],
  [
    'US-POS-007',
    [/2026-06-30/, /open-core/i, /managed-tier/i, /WS18/, /US-POS-001\.\.006/, /C-072/],
  ],
  ['US-RPT-011', [/2026-06-30/, /PayPal|multi-provider/i, /C-071/, /open-core/i, /managed-tier/i]],
]);
const DATED_DECISION_PATTERN = /\b20\d{2}-\d{2}-\d{2}\b/;
const COMPLETION_ID_PATTERN = /\bC-\d{3}\b/g;
const FILE_LIKE_TOKEN_PATTERN =
  /(?:\.(?:go|mjs|rs|ts|tsx|yml|yaml|dart|swift|kt)$|\.(?:spec|test|integration)\.)/;
const PATH_PREFIXES = ['.github/', 'apps/', 'docs/', 'e2e/', 'infra/', 'packages/', 'scripts/'];
const PATH_EXTENSIONS = new Set([
  '.dart',
  '.go',
  '.kt',
  '.mjs',
  '.rs',
  '.swift',
  '.spec.ts',
  '.test.ts',
  '.test.tsx',
  '.ts',
  '.tsx',
  '.yml',
]);

function normalizePersonaName(value) {
  return value.replace(/\s+\(US-[A-Z]+\)$/, '');
}

function splitMarkdownRow(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null;

  const cells = [];
  let current = '';
  let inCode = false;
  for (let index = 1; index < trimmed.length - 1; index += 1) {
    const char = trimmed[index];
    if (char === '`') {
      inCode = !inCode;
      current += char;
    } else if (char === '|' && !inCode) {
      cells.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

function isSeparatorRow(cells) {
  return cells.every((cell) => /^:?-{2,}:?$/.test(cell));
}

export function parseUserStoryMatrix(markdown) {
  const lines = markdown.split(/\r?\n/);
  const summaryRows = [];
  const storyRows = [];
  const malformedRows = [];
  let currentPersona = null;
  let currentPersonaPrefix = null;
  let currentTable = null;

  for (const [index, line] of lines.entries()) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const title = heading[1];
      const personaPrefix = PERSONA_PREFIX_PATTERN.exec(title)?.[1] ?? null;
      currentPersona =
        title === 'Summary' || title === 'Maintenance' ? null : normalizePersonaName(title);
      currentPersonaPrefix = currentPersona ? personaPrefix : null;
      currentTable = null;
      continue;
    }

    const cells = splitMarkdownRow(line);
    if (!cells) {
      continue;
    }
    if (isSeparatorRow(cells)) {
      continue;
    }

    if (cells[0] === SUMMARY_HEADER) {
      currentTable = 'summary';
      continue;
    }
    if (cells[0] === 'ID' && cells[1] === 'User story') {
      currentTable = 'stories';
      continue;
    }

    if (
      currentTable === 'summary' &&
      cells.length === 6 &&
      cells[0] !== '**Total**' &&
      cells[0].replace(/\*/g, '') !== 'Total'
    ) {
      summaryRows.push({
        persona: cells[0],
        stories: Number(cells[1]),
        covered: Number(cells[2]),
        partial: Number(cells[3]),
        missing: Number(cells[4]),
        deferredOrManaged: Number(cells[5]),
      });
    } else if (
      currentTable === 'summary' &&
      cells.length === 6 &&
      cells[0] !== '**Total**' &&
      cells[0].replace(/\*/g, '') === 'Total'
    ) {
      malformedRows.push(`line ${index + 1}: total summary row must use **Total** label`);
    } else if (currentTable === 'summary' && cells.length === 6 && cells[0] === '**Total**') {
      summaryRows.push({
        persona: 'Total',
        stories: Number(cells[1].replace(/\*/g, '')),
        covered: Number(cells[2].replace(/\*/g, '')),
        partial: Number(cells[3].replace(/\*/g, '')),
        missing: Number(cells[4].replace(/\*/g, '')),
        deferredOrManaged: Number(cells[5].replace(/\*/g, '')),
      });
    } else if (currentTable === 'stories' && cells.length >= 5) {
      storyRows.push({
        persona: currentPersona,
        personaPrefix: currentPersonaPrefix,
        id: cells[0],
        story: cells[1],
        requiredLayers: cells[2],
        status: cells[3],
        evidence: cells.slice(4).join(' | '),
      });
    } else if (currentTable === 'summary') {
      malformedRows.push(`line ${index + 1}: summary row must have 6 columns`);
    } else if (currentTable === 'stories') {
      malformedRows.push(`line ${index + 1}: user-story row must have at least 5 columns`);
    }
  }

  return { malformedRows, summaryRows, storyRows };
}

function countByStatus(rows) {
  return rows.reduce(
    (counts, row) => {
      counts.stories += 1;
      if (row.status === 'Covered') counts.covered += 1;
      if (row.status === 'Partial') counts.partial += 1;
      if (row.status === 'Missing') counts.missing += 1;
      if (row.status === 'Deferred' || row.status === 'Managed') counts.deferredOrManaged += 1;
      return counts;
    },
    { stories: 0, covered: 0, partial: 0, missing: 0, deferredOrManaged: 0 },
  );
}

function compareCounts(label, expected, actual, errors) {
  for (const key of ['stories', 'covered', 'partial', 'missing', 'deferredOrManaged']) {
    if (expected[key] !== actual[key]) {
      errors.push(
        `${label} summary ${key}=${expected[key]} does not match story rows ${actual[key]}`,
      );
    }
  }
}

function validateSummaryCounts(summary, errors) {
  if (!summary.persona.trim()) {
    errors.push('Summary row persona must not be empty');
  }
  for (const key of ['stories', 'covered', 'partial', 'missing', 'deferredOrManaged']) {
    if (!Number.isInteger(summary[key]) || summary[key] < 0) {
      errors.push(`${summary.persona}: summary ${key} must be a non-negative integer`);
    }
  }

  const countsAreValid = ['stories', 'covered', 'partial', 'missing', 'deferredOrManaged'].every(
    (key) => Number.isInteger(summary[key]) && summary[key] >= 0,
  );
  if (!countsAreValid) {
    return;
  }

  const statusTotal =
    summary.covered + summary.partial + summary.missing + summary.deferredOrManaged;
  if (statusTotal !== summary.stories) {
    errors.push(
      `${summary.persona}: summary status buckets total ${statusTotal} must equal stories ${summary.stories}`,
    );
  }
}

function unique(values) {
  return [...new Set(values)];
}

function computeStoryScopeHash(storyRows) {
  const payload = storyRows
    .map((row) => [row.id, row.story, row.requiredLayers].join('\t'))
    .sort()
    .join('\n');
  return createHash('sha256').update(payload).digest('hex');
}

function normalizePath(path) {
  return normalize(path).replaceAll(sep, '/');
}

function stripTokenPunctuation(token) {
  return token
    .replace(/^[("'[]+/, '')
    .replace(/[)"'\],.;:]+$/, '')
    .replace(/^\.\/+/, '');
}

function isRepoRelativePath(token) {
  if (!PATH_PREFIXES.some((prefix) => token.startsWith(prefix))) {
    return false;
  }

  return PATH_EXTENSIONS.has(extname(token)) || !token.split('/').at(-1)?.includes('.');
}

function collectPackageScriptReferences(evidence) {
  const scripts = [];
  const matches = evidence.matchAll(/`([^`\n]+)`/g);

  for (const match of matches) {
    const command = match[1];
    const scriptMatches = command.matchAll(/\bbun\s+run\s+([A-Za-z0-9:_-]+)/g);
    for (const scriptMatch of scriptMatches) {
      if (!scriptMatch[1].startsWith('-')) {
        scripts.push(scriptMatch[1]);
      }
    }
  }

  return unique(scripts);
}

function collectUnverifiedFileLikeCodeSpans(evidence) {
  const unverified = [];
  const codeSpans = evidence.matchAll(/`([^`\n]+)`/g);

  for (const match of codeSpans) {
    const code = match[1].replace(/[<>]/g, '');
    for (const rawToken of code.split(/\s+/)) {
      const token = normalizePath(stripTokenPunctuation(rawToken));
      if (
        token.length > 0 &&
        !token.startsWith('../') &&
        !token.includes('=') &&
        FILE_LIKE_TOKEN_PATTERN.test(token) &&
        !isRepoRelativePath(token)
      ) {
        unverified.push(token);
      }
    }
  }

  return unique(unverified);
}

function isSupportedEvidenceCodeSpan(code) {
  const cleaned = code.replace(/[<>]/g, '');
  const tokens = cleaned
    .split(/\s+/)
    .map((rawToken) => normalizePath(stripTokenPunctuation(rawToken)))
    .filter(Boolean);

  if (tokens.some(isRepoRelativePath)) {
    return true;
  }
  if (tokens.some((token) => FILE_LIKE_TOKEN_PATTERN.test(token))) {
    return true;
  }

  return /\bbun\s+run\b|\bnode\s+|(?:^|\s)[A-Z][A-Z0-9_]+=[^\s]+/.test(code);
}

function collectUnsupportedEvidenceCodeSpans(evidence) {
  const unsupported = [];
  const codeSpans = evidence.matchAll(/`([^`\n]+)`/g);

  for (const match of codeSpans) {
    if (!isSupportedEvidenceCodeSpan(match[1])) {
      unsupported.push(match[1]);
    }
  }

  return unique(unsupported);
}

function hasDirectBrowserEvidence(evidence, references) {
  return (
    references.pathReferences.some((path) => path.startsWith('e2e/')) ||
    references.packageScripts.some((script) => script.startsWith('test:e2e'))
  );
}

function hasDirectAccessibilityEvidence(evidence, references) {
  return (
    /\b(?:accessibility|a11y|axe|keyboard|WCAG|screen reader|landmark|focus)\b/i.test(evidence) ||
    references.pathReferences.some(
      (path) =>
        path === 'e2e/admin-accessibility.spec.ts' ||
        path.includes('accessibility') ||
        path.includes('a11y'),
    )
  );
}

function hasDirectContractEvidence(evidence, references) {
  return (
    /\b(?:contract|parity|OpenAPI|SDK|schema|generated client|generated types|workflow|CI|matrix|vector|vectors|cross-SDK|release dry-run)\b/i.test(
      evidence,
    ) ||
    references.pathReferences.some((path) =>
      /openapi|sdk|contract|parity|workflow|generated-client|release-dry-run/i.test(path),
    )
  );
}

function hasDirectUnitEvidence(evidence, references) {
  return (
    /\b(?:unit|vitest|node --test|test:unit|domain|model|helper|SDK|api-auth|permission-provider|transport|adapter|validator|schema|snapshot|render|parser|format|service|client|fixture|fixtures|seed|tests?)\b/i.test(
      evidence,
    ) ||
    references.pathReferences.some(
      (path) =>
        /(?:^|\/)(__tests__|test|tests)\/|\.test\.|\.spec\./i.test(path) &&
        !/integration|e2e|playwright|route-presence/i.test(path),
    ) ||
    references.packageScripts.some((script) => /(^|:)test($|:)|unit|typecheck|lint/i.test(script))
  );
}

function hasDirectIntegrationEvidence(evidence, references) {
  return (
    /\b(?:integration|route|routes|repository|repositories|DB|database|Kysely|workflow|activity|Temporal|provider|adapter|webhook|worker|E2E|e2e|persisted|persistence|SSE|download|redirect|auth|OAuth|permission|consent|suppression|transport|scanner|checkout|API|SDK|seed|iac|dr:)\b/i.test(
      evidence,
    ) ||
    references.pathReferences.some((path) =>
      /integration|routes?|repository|db|database|workflows?|activities?|provider|adapter|webhook|worker|e2e|sdk/i.test(
        path,
      ),
    ) ||
    references.packageScripts.some((script) => /iac|dr|e2e|integration/i.test(script))
  );
}

function hasDirectPropertyEvidence(evidence, references) {
  return (
    /\b(?:property|fuzz|generated|generative|case matrix|vector|vectors|allocation cases|hash matrix|parity matrix|safe merge|Radar|risk-engine)\b/i.test(
      evidence,
    ) || references.pathReferences.some((path) => path.includes('sdk-parity-matrix'))
  );
}

function hasDirectSecurityEvidence(evidence, references) {
  return (
    /\b(?:security|tenant|isolation|permission|permissions|auth|scope|scoped|scoping|forgery|signature|HMAC|CSP|XSS|consent|suppression|risk|fraud|fail-closed|abuse|rate limit|idempotent|replay|secret|token)\b/i.test(
      evidence,
    ) ||
    references.pathReferences.some((path) =>
      /tenant|security|auth|permission|scope|rate-limit|abuse|webhook|risk|fraud|consent|suppression|xss|csp/i.test(
        path,
      ),
    )
  );
}

function hasDirectLoadEvidence(evidence, references) {
  return (
    /\b(?:load|concurrency|concurrent|burst|SLO|performance|p95|stress|capacity|race|oversell|FIFO|rate limit|bounded heap|bulk|probe|probes)\b/i.test(
      evidence,
    ) ||
    references.pathReferences.some((path) =>
      /load|concurrency|performance|rate-limit|bulk|hot-query|lighthouse/i.test(path),
    )
  );
}

function hasCompletedCompletionEvidence(references, completionStatuses) {
  if (references.completionIds.length === 0) {
    return false;
  }

  if (!completionStatuses) {
    return false;
  }

  return references.completionIds.some(
    (completionId) => completionStatuses.get(completionId) === 'Done',
  );
}

function isTestOrProofPath(path) {
  return (
    path.startsWith('.github/workflows/') ||
    path.startsWith('e2e/') ||
    path.startsWith('infra/scripts/') ||
    path.includes('/__tests__/') ||
    path.includes('/test/') ||
    path.includes('/tests/') ||
    path.includes('/Tests/') ||
    /\.(?:test|spec)\.[A-Za-z0-9]+$/.test(path) ||
    /_test\.go$/.test(path) ||
    /Test\.kt$/.test(path) ||
    /TixkitIOSTests\.swift$/.test(path) ||
    /sdk-parity-matrix\.mjs$/.test(path) ||
    /(?:production-validation-harness|production-deployment-guide|incident-runbooks)\.md$/.test(
      path,
    )
  );
}

export function collectEvidenceReferences(evidence) {
  const completionIds = unique(evidence.match(COMPLETION_ID_PATTERN) ?? []);
  const pathReferences = [];
  const codeSpans = evidence.matchAll(/`([^`\n]+)`/g);

  for (const match of codeSpans) {
    const code = match[1].replace(/[<>]/g, '');
    for (const rawToken of code.split(/\s+/)) {
      const token = normalizePath(stripTokenPunctuation(rawToken));
      if (
        token.length > 0 &&
        !token.startsWith('../') &&
        !token.includes('=') &&
        isRepoRelativePath(token)
      ) {
        pathReferences.push(token);
      }
    }
  }

  return {
    completionIds,
    pathReferences: unique(pathReferences),
    packageScripts: collectPackageScriptReferences(evidence),
  };
}

export function extractCompletionBacklogIds(backlogMarkdown) {
  return new Set(backlogMarkdown.match(COMPLETION_ID_PATTERN) ?? []);
}

export function extractCompletionBacklogStatuses(backlogMarkdown) {
  const statuses = new Map();

  for (const line of backlogMarkdown.split(/\r?\n/)) {
    const match = /^\| (C-\d{3}) \| [^|]+ \| [^|]+ \| ([^|]+) \|/.exec(line);
    if (match) {
      statuses.set(match[1], match[2].trim());
    }
  }

  return statuses;
}

export function validateUserStoryMatrix(markdown, options = {}) {
  const { malformedRows, summaryRows, storyRows } = parseUserStoryMatrix(markdown);
  const knownCompletionIds = options.knownCompletionIds ?? null;
  const completionStatuses = options.completionStatuses ?? null;
  const packageScripts = options.packageScripts ?? null;
  const requiredPersonaStoryCounts =
    options.requiredPersonaStoryCounts ?? REQUIRED_PERSONA_STORY_COUNTS;
  const requiredStoryIds = options.requiredStoryIds ?? REQUIRED_STORY_IDS;
  const requiredStoryScopeHash =
    options.requiredStoryScopeHash === undefined
      ? REQUIRED_STORY_SCOPE_HASH
      : options.requiredStoryScopeHash;
  const requiredExceptionStoryStatuses =
    options.requiredExceptionStoryStatuses ?? REQUIRED_EXCEPTION_STORY_STATUSES;
  const requiredExceptionStoryEvidence =
    options.requiredExceptionStoryEvidence ?? REQUIRED_EXCEPTION_STORY_EVIDENCE;
  const errors = [];
  for (const malformedRow of malformedRows) {
    errors.push(`Malformed matrix row: ${malformedRow}`);
  }

  if (summaryRows.length === 0) {
    errors.push('Summary table is missing');
  }
  if (storyRows.length === 0) {
    errors.push('No user-story rows found');
  }
  if (requiredStoryScopeHash !== null) {
    const actualStoryScopeHash = computeStoryScopeHash(storyRows);
    if (actualStoryScopeHash !== requiredStoryScopeHash) {
      errors.push(
        `User-story scope hash ${actualStoryScopeHash} does not match required scope ${requiredStoryScopeHash}`,
      );
    }
  }
  for (const exceptionId of requiredExceptionStoryStatuses.keys()) {
    if (!requiredStoryIds.has(exceptionId)) {
      errors.push(`${exceptionId}: approved exception must be inside required story scope`);
    }
    const exceptionStatus = requiredExceptionStoryStatuses.get(exceptionId);
    if (!ALLOWED_STATUSES.has(exceptionStatus)) {
      errors.push(`${exceptionId}: approved exception status is invalid: ${exceptionStatus}`);
    } else if (exceptionStatus !== 'Deferred' && exceptionStatus !== 'Managed') {
      errors.push(`${exceptionId}: approved exception status must be Deferred or Managed`);
    }
    const evidencePatterns = requiredExceptionStoryEvidence.get(exceptionId);
    if (!Array.isArray(evidencePatterns) || evidencePatterns.length === 0) {
      errors.push(`${exceptionId}: approved exception must declare evidence requirements`);
    } else {
      for (const pattern of evidencePatterns) {
        if (!(pattern instanceof RegExp)) {
          errors.push(
            `${exceptionId}: approved exception evidence requirement must be a RegExp: ${String(pattern)}`,
          );
        } else if (pattern.global || pattern.sticky) {
          errors.push(
            `${exceptionId}: approved exception evidence requirement must not use global or sticky flags: ${pattern}`,
          );
        }
      }
    }
  }
  for (const exceptionId of requiredExceptionStoryEvidence.keys()) {
    if (!requiredExceptionStoryStatuses.has(exceptionId)) {
      errors.push(`${exceptionId}: exception evidence requirements have no approved status`);
    }
  }

  const seenIds = new Set();
  for (const row of storyRows) {
    if (!STORY_ID_PATTERN.test(row.id)) {
      errors.push(`${row.id}: invalid user-story id`);
    }
    if (!row.story.trim()) {
      errors.push(`${row.id}: user story must not be empty`);
    }
    if (!row.persona) {
      errors.push(`${row.id}: user-story row must be inside a persona section`);
    } else if (!row.personaPrefix) {
      errors.push(`${row.id}: persona section must declare a user-story prefix`);
    }
    if (row.personaPrefix && !row.id.startsWith(`${row.personaPrefix}-`)) {
      errors.push(`${row.id}: user-story id must use section prefix ${row.personaPrefix}`);
    }
    if (seenIds.has(row.id)) {
      errors.push(`${row.id}: duplicate user-story id`);
    }
    seenIds.add(row.id);

    if (!ALLOWED_STATUSES.has(row.status)) {
      errors.push(`${row.id}: invalid status ${row.status}`);
    }
    const requiredExceptionStatus = requiredExceptionStoryStatuses.get(row.id);
    if (requiredExceptionStatus && row.status !== requiredExceptionStatus) {
      errors.push(`${row.id}: exception story status must stay ${requiredExceptionStatus}`);
    }
    if (
      (row.status === 'Deferred' || row.status === 'Managed') &&
      !requiredExceptionStoryStatuses.has(row.id)
    ) {
      errors.push(`${row.id}: ${row.status} story must be registered as an approved exception`);
    }
    if (requiredExceptionStatus && row.status === requiredExceptionStatus) {
      const requiredExceptionEvidence = requiredExceptionStoryEvidence.get(row.id) ?? [];
      for (const pattern of requiredExceptionEvidence) {
        if (!(pattern instanceof RegExp)) {
          continue;
        }
        if (!pattern.test(row.evidence)) {
          errors.push(`${row.id}: exception evidence must match ${pattern.source}`);
        }
      }
    }
    if (row.status === 'Partial' || row.status === 'Missing') {
      errors.push(`${row.id}: applicable stories must not remain ${row.status}`);
    }
    if (!row.evidence || row.evidence === '-') {
      errors.push(`${row.id}: evidence cell must not be empty`);
    }
    const rawLayers = row.requiredLayers.split(',').map((layer) => layer.trim());
    const layers = rawLayers.filter(Boolean);
    if (layers.length === 0) {
      errors.push(`${row.id}: required layers must not be empty`);
    }
    if (rawLayers.some((layer) => layer.length === 0)) {
      errors.push(`${row.id}: required layers must not contain empty entries`);
    }
    const seenLayers = new Set();
    for (const layer of layers) {
      if (!ALLOWED_LAYERS.has(layer)) {
        errors.push(`${row.id}: invalid required layer ${layer}`);
      }
      if (seenLayers.has(layer)) {
        errors.push(`${row.id}: duplicate required layer ${layer}`);
      }
      seenLayers.add(layer);
    }
    if (
      (row.status === 'Deferred' || row.status === 'Managed') &&
      !DATED_DECISION_PATTERN.test(row.evidence)
    ) {
      errors.push(`${row.id}: ${row.status} rows must cite a dated decision`);
    }

    const references = collectEvidenceReferences(row.evidence);
    const { completionIds, packageScripts: evidencePackageScripts } = references;
    for (const token of collectUnverifiedFileLikeCodeSpans(row.evidence)) {
      errors.push(`${row.id}: file-like evidence token must be a repo-relative path: ${token}`);
    }
    for (const token of collectUnsupportedEvidenceCodeSpans(row.evidence)) {
      errors.push(
        `${row.id}: evidence code span must be a repo-relative path or runnable command: ${token}`,
      );
    }
    if (
      row.status === 'Covered' &&
      completionIds.length === 0 &&
      references.pathReferences.length === 0 &&
      references.packageScripts.length === 0
    ) {
      errors.push(
        `${row.id}: Covered rows must cite a concrete completion item, repo path, or package script`,
      );
    }
    if (
      row.status === 'Covered' &&
      !hasCompletedCompletionEvidence(references, completionStatuses) &&
      references.pathReferences.length > 0 &&
      !references.pathReferences.some(isTestOrProofPath) &&
      references.packageScripts.length === 0
    ) {
      errors.push(
        `${row.id}: Covered path evidence must cite a test, workflow, runbook, or proof script`,
      );
    }
    if (
      (row.status === 'Deferred' || row.status === 'Managed') &&
      completionIds.length === 0 &&
      references.pathReferences.length === 0 &&
      references.packageScripts.length === 0
    ) {
      errors.push(
        `${row.id}: ${row.status} rows must cite a concrete exception item, repo path, or package script`,
      );
    }
    if (
      row.status === 'Covered' &&
      layers.includes('E') &&
      !hasDirectBrowserEvidence(row.evidence, references)
    ) {
      errors.push(
        `${row.id}: Covered E-layer rows must cite a concrete e2e/ path or test:e2e package script`,
      );
    }
    if (
      row.status === 'Covered' &&
      layers.includes('A') &&
      !hasDirectAccessibilityEvidence(row.evidence, references) &&
      !hasCompletedCompletionEvidence(references, completionStatuses)
    ) {
      errors.push(
        `${row.id}: Covered A-layer rows must cite accessibility/axe evidence or a completed completion item`,
      );
    }
    if (
      row.status === 'Covered' &&
      layers.includes('C') &&
      !hasDirectContractEvidence(row.evidence, references) &&
      !hasCompletedCompletionEvidence(references, completionStatuses)
    ) {
      errors.push(
        `${row.id}: Covered C-layer rows must cite contract/parity/OpenAPI/SDK evidence or a completed completion item`,
      );
    }
    if (
      row.status === 'Covered' &&
      layers.includes('U') &&
      !hasDirectUnitEvidence(row.evidence, references) &&
      !hasCompletedCompletionEvidence(references, completionStatuses)
    ) {
      errors.push(
        `${row.id}: Covered U-layer rows must cite unit/test-helper evidence or a completed completion item`,
      );
    }
    if (
      row.status === 'Covered' &&
      layers.includes('I') &&
      !hasDirectIntegrationEvidence(row.evidence, references) &&
      !hasCompletedCompletionEvidence(references, completionStatuses)
    ) {
      errors.push(
        `${row.id}: Covered I-layer rows must cite integration/route/workflow/provider evidence or a completed completion item`,
      );
    }
    if (
      row.status === 'Covered' &&
      layers.includes('P') &&
      !hasDirectPropertyEvidence(row.evidence, references) &&
      !hasCompletedCompletionEvidence(references, completionStatuses)
    ) {
      errors.push(
        `${row.id}: Covered P-layer rows must cite property/fuzz/vector evidence or a completed completion item`,
      );
    }
    if (
      row.status === 'Covered' &&
      layers.includes('S') &&
      !hasDirectSecurityEvidence(row.evidence, references) &&
      !hasCompletedCompletionEvidence(references, completionStatuses)
    ) {
      errors.push(
        `${row.id}: Covered S-layer rows must cite security/tenant-isolation evidence or a completed completion item`,
      );
    }
    if (
      row.status === 'Covered' &&
      layers.includes('L') &&
      !hasDirectLoadEvidence(row.evidence, references) &&
      !hasCompletedCompletionEvidence(references, completionStatuses)
    ) {
      errors.push(
        `${row.id}: Covered L-layer rows must cite load/concurrency evidence or a completed completion item`,
      );
    }
    if (knownCompletionIds) {
      for (const completionId of completionIds) {
        if (!knownCompletionIds.has(completionId)) {
          errors.push(
            `${row.id}: evidence references unknown completion backlog item ${completionId}`,
          );
        }
      }
    }
    if (completionStatuses) {
      for (const completionId of completionIds) {
        const completionStatus = completionStatuses.get(completionId);
        if (row.status === 'Covered' && completionStatus && completionStatus !== 'Done') {
          errors.push(
            `${row.id}: Covered evidence must not depend on ${completionId} while it is ${completionStatus}`,
          );
        }
      }
    }
    if (packageScripts) {
      for (const script of evidencePackageScripts) {
        if (typeof packageScripts[script] !== 'string') {
          errors.push(`${row.id}: evidence references unknown package script ${script}`);
        }
      }
    }
  }

  const seenSummaryPersonas = new Set();
  let hasSeenTotalSummary = false;
  for (const summary of summaryRows) {
    validateSummaryCounts(summary, errors);
    if (hasSeenTotalSummary && summary.persona !== 'Total') {
      errors.push(`${summary.persona}: summary row must appear before Total`);
    }
    if (seenSummaryPersonas.has(summary.persona)) {
      errors.push(`${summary.persona}: duplicate summary row`);
    }
    seenSummaryPersonas.add(summary.persona);
    if (summary.persona === 'Total') {
      hasSeenTotalSummary = true;
    }
  }

  const summaryByPersona = new Map(summaryRows.map((row) => [row.persona, row]));
  const storyPersonas = new Set(storyRows.map((row) => row.persona));
  for (const summary of summaryRows) {
    if (summary.persona !== 'Total' && !storyPersonas.has(summary.persona)) {
      errors.push(`${summary.persona}: summary row has no user-story rows`);
    }
  }
  for (const requiredStoryId of requiredStoryIds) {
    if (!seenIds.has(requiredStoryId)) {
      errors.push(`${requiredStoryId}: required user-story row is missing`);
    }
  }
  for (const row of storyRows) {
    if (!requiredStoryIds.has(row.id)) {
      errors.push(`${row.id}: unexpected user-story id outside required scope`);
    }
  }
  for (const [persona, expectedStories] of requiredPersonaStoryCounts) {
    const personaRows = storyRows.filter((row) => row.persona === persona);
    const summary = summaryByPersona.get(persona);
    if (!summary) {
      errors.push(`${persona}: required persona summary row is missing`);
    } else if (summary.stories !== expectedStories) {
      errors.push(
        `${persona}: required persona summary stories=${summary.stories} must stay ${expectedStories}`,
      );
    }
    if (personaRows.length !== expectedStories) {
      errors.push(
        `${persona}: required persona story rows=${personaRows.length} must stay ${expectedStories}`,
      );
    }
  }
  for (const persona of storyPersonas) {
    const summary = summaryByPersona.get(persona);
    if (!summary) {
      errors.push(`${persona}: missing summary row`);
      continue;
    }
    compareCounts(
      persona,
      summary,
      countByStatus(storyRows.filter((row) => row.persona === persona)),
      errors,
    );
  }

  const total = summaryByPersona.get('Total');
  if (!total) {
    errors.push('Total summary row is missing');
  } else {
    compareCounts('Total', total, countByStatus(storyRows), errors);
  }

  return { errors, summaryRows, storyRows };
}

async function readPackageScripts(rootDir) {
  const packageJson = JSON.parse(await readFile(join(rootDir, 'package.json'), 'utf8'));
  return packageJson.scripts ?? {};
}

async function pathExists(rootDir, relativePath) {
  try {
    await stat(join(rootDir, relativePath));
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

export async function validateUserStoryMatrixFiles({
  rootDir = process.cwd(),
  matrixPath = DEFAULT_MATRIX_PATH,
  backlogPath = DEFAULT_BACKLOG_PATH,
} = {}) {
  const absoluteRoot = resolve(rootDir);
  const markdown = await readFile(join(absoluteRoot, matrixPath), 'utf8');
  const backlogMarkdown = await readFile(join(absoluteRoot, backlogPath), 'utf8');
  const knownCompletionIds = extractCompletionBacklogIds(backlogMarkdown);
  const completionStatuses = extractCompletionBacklogStatuses(backlogMarkdown);
  const packageScripts = await readPackageScripts(absoluteRoot);
  const result = validateUserStoryMatrix(markdown, {
    knownCompletionIds,
    completionStatuses,
    packageScripts,
  });
  const errors = [...result.errors];
  const referencedPaths = [];

  for (const row of result.storyRows) {
    const { pathReferences } = collectEvidenceReferences(row.evidence);
    for (const relativePath of pathReferences) {
      referencedPaths.push(relativePath);
      if (!(await pathExists(absoluteRoot, relativePath))) {
        errors.push(`${row.id}: evidence references missing path ${relativePath}`);
      }
    }
  }

  return { ...result, errors, referencedPaths: unique(referencedPaths) };
}

function parseArgs(argv) {
  const args = { path: DEFAULT_MATRIX_PATH, backlogPath: DEFAULT_BACKLOG_PATH };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--path') {
      index += 1;
      if (index >= argv.length) throw new Error('--path requires a value');
      args.path = argv[index];
    } else if (arg === '--backlog') {
      index += 1;
      if (index >= argv.length) throw new Error('--backlog requires a value');
      args.backlogPath = argv[index];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  const { path, backlogPath } = parseArgs(argv);
  const { errors, storyRows, referencedPaths } = await validateUserStoryMatrixFiles({
    matrixPath: path,
    backlogPath,
  });
  if (errors.length > 0) {
    throw new Error(
      `User-story matrix validation failed:\n${errors.map((error) => `- ${error}`).join('\n')}`,
    );
  }
  console.log(
    `Validated ${storyRows.length} user-story rows and ${referencedPaths.length} evidence paths in ${path}`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
