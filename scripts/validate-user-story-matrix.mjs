#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import process from 'node:process';

const DEFAULT_MATRIX_PATH = 'docs/completion/user-story-test-matrix.md';
const DEFAULT_BACKLOG_PATH = 'docs/completion/backlog.md';
const ALLOWED_STATUSES = new Set(['Covered', 'Partial', 'Missing', 'Deferred', 'Managed']);
const ALLOWED_LAYERS = new Set(['U', 'I', 'C', 'E', 'P', 'L', 'S', 'A']);
const SUMMARY_HEADER = 'Persona group';
const STORY_ID_PATTERN = /^US-[A-Z]+-\d{3}$/;
const DATED_DECISION_PATTERN = /\b20\d{2}-\d{2}-\d{2}\b/;
const COMPLETION_ID_PATTERN = /\bC-\d{3}\b/g;
const PATH_PREFIXES = [
  '.github/',
  'apps/',
  'docs/',
  'e2e/',
  'infra/',
  'packages/',
  'scripts/',
];
const PATH_EXTENSIONS = new Set([
  '.go',
  '.mjs',
  '.rs',
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
  let currentPersona = null;
  let currentTable = null;

  for (const line of lines) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const title = heading[1];
      currentPersona =
        title === 'Summary' || title === 'Maintenance' ? null : normalizePersonaName(title);
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

    if (currentTable === 'summary' && cells.length === 6 && cells[0] !== '**Total**') {
      summaryRows.push({
        persona: cells[0],
        stories: Number(cells[1]),
        covered: Number(cells[2]),
        partial: Number(cells[3]),
        missing: Number(cells[4]),
        deferredOrManaged: Number(cells[5]),
      });
    } else if (currentTable === 'summary' && cells[0] === '**Total**') {
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
        id: cells[0],
        story: cells[1],
        requiredLayers: cells[2],
        status: cells[3],
        evidence: cells.slice(4).join(' | '),
      });
    }
  }

  return { summaryRows, storyRows };
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
      errors.push(`${label} summary ${key}=${expected[key]} does not match story rows ${actual[key]}`);
    }
  }
}

function unique(values) {
  return [...new Set(values)];
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

function hasDirectBrowserEvidence(evidence, references) {
  return (
    /\b(?:E2E|e2e|Playwright|browser|Chromium|Firefox|WebKit)\b/.test(evidence) ||
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

function hasCompletedCompletionEvidence(references, completionStatuses) {
  if (references.completionIds.length === 0) {
    return false;
  }

  if (!completionStatuses) {
    return true;
  }

  return references.completionIds.some((completionId) => completionStatuses.get(completionId) === 'Done');
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
  const { summaryRows, storyRows } = parseUserStoryMatrix(markdown);
  const knownCompletionIds = options.knownCompletionIds ?? null;
  const completionStatuses = options.completionStatuses ?? null;
  const packageScripts = options.packageScripts ?? null;
  const errors = [];

  if (summaryRows.length === 0) {
    errors.push('Summary table is missing');
  }
  if (storyRows.length === 0) {
    errors.push('No user-story rows found');
  }

  const seenIds = new Set();
  for (const row of storyRows) {
    if (!STORY_ID_PATTERN.test(row.id)) {
      errors.push(`${row.id}: invalid user-story id`);
    }
    if (seenIds.has(row.id)) {
      errors.push(`${row.id}: duplicate user-story id`);
    }
    seenIds.add(row.id);

    if (!ALLOWED_STATUSES.has(row.status)) {
      errors.push(`${row.id}: invalid status ${row.status}`);
    }
    if (row.status === 'Partial' || row.status === 'Missing') {
      errors.push(`${row.id}: applicable stories must not remain ${row.status}`);
    }
    if (!row.evidence || row.evidence === '-') {
      errors.push(`${row.id}: evidence cell must not be empty`);
    }
    const layers = row.requiredLayers
      .split(',')
      .map((layer) => layer.trim())
      .filter(Boolean);
    if (layers.length === 0) {
      errors.push(`${row.id}: required layers must not be empty`);
    }
    for (const layer of layers) {
      if (!ALLOWED_LAYERS.has(layer)) {
        errors.push(`${row.id}: invalid required layer ${layer}`);
      }
    }
    if ((row.status === 'Deferred' || row.status === 'Managed') && !DATED_DECISION_PATTERN.test(row.evidence)) {
      errors.push(`${row.id}: ${row.status} rows must cite a dated decision`);
    }

    const references = collectEvidenceReferences(row.evidence);
    const { completionIds, packageScripts: evidencePackageScripts } = references;
    if (
      row.status === 'Covered' &&
      layers.includes('E') &&
      !hasDirectBrowserEvidence(row.evidence, references) &&
      !hasCompletedCompletionEvidence(references, completionStatuses)
    ) {
      errors.push(`${row.id}: Covered E-layer rows must cite E2E/browser evidence or a completed completion item`);
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
    if (knownCompletionIds) {
      for (const completionId of completionIds) {
        if (!knownCompletionIds.has(completionId)) {
          errors.push(`${row.id}: evidence references unknown completion backlog item ${completionId}`);
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

  const summaryByPersona = new Map(summaryRows.map((row) => [row.persona, row]));
  const storyPersonas = new Set(storyRows.map((row) => row.persona));
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
    throw new Error(`User-story matrix validation failed:\n${errors.map((error) => `- ${error}`).join('\n')}`);
  }
  console.log(`Validated ${storyRows.length} user-story rows and ${referencedPaths.length} evidence paths in ${path}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
