#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import process from 'node:process';

const DEFAULT_LEDGER_PATH = 'docs/completion/high-care-proof-ledger.md';
const EXPECTED_BACKLOG_IDS = [
  'C-091',
  'C-092',
  'C-093',
  'C-094',
  'C-095',
  'C-096',
  'C-097',
  'C-098',
];
const ALLOWED_STATUSES = new Set(['Covered', 'Partial', 'Missing', 'Deferred', 'Managed']);
const DATE_PATTERN = /^20\d{2}-\d{2}-\d{2}$/;
const WORKSTREAM_PATTERN = /^WS\d+$/;

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

function parseWorkstreams(value) {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function parseHighCareLedger(markdown) {
  const summaryRows = [];
  const detailRows = [];
  let currentTable = null;

  for (const line of markdown.split(/\r?\n/)) {
    const cells = splitMarkdownRow(line);
    if (!cells || isSeparatorRow(cells)) continue;

    if (cells[0] === 'Backlog' && cells[1] === 'Surface') {
      currentTable = 'summary';
      continue;
    }
    if (cells[0] === 'Backlog' && cells[1] === 'Current invariant') {
      currentTable = 'details';
      continue;
    }

    if (currentTable === 'summary' && cells.length === 6 && /^C-\d{3}$/.test(cells[0])) {
      summaryRows.push({
        backlog: cells[0],
        surface: cells[1],
        status: cells[2],
        evidenceDate: cells[3],
        ownerWorkstreams: cells[4],
        nextAction: cells[5],
      });
    } else if (currentTable === 'details' && cells.length === 6 && /^C-\d{3}$/.test(cells[0])) {
      detailRows.push({
        backlog: cells[0],
        currentInvariant: cells[1],
        primaryFailureModes: cells[2],
        requiredProofLayers: cells[3],
        currentBlocker: cells[4],
        nextAction: cells[5],
      });
    }
  }

  return { summaryRows, detailRows };
}

function hasMeaningfulText(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.trim() !== '-';
}

export function validateHighCareLedger(markdown) {
  const { summaryRows, detailRows } = parseHighCareLedger(markdown);
  const errors = [];

  if (summaryRows.length === 0) {
    errors.push('Summary table is missing');
  }
  if (detailRows.length === 0) {
    errors.push('Surface Details table is missing');
  }

  const summaryById = new Map();
  const detailById = new Map();

  for (const row of summaryRows) {
    if (summaryById.has(row.backlog)) {
      errors.push(`${row.backlog}: duplicate Summary row`);
    }
    summaryById.set(row.backlog, row);

    if (!ALLOWED_STATUSES.has(row.status)) {
      errors.push(`${row.backlog}: invalid Summary status ${row.status}`);
    }
    if (!DATE_PATTERN.test(row.evidenceDate)) {
      errors.push(`${row.backlog}: Summary evidence date must be YYYY-MM-DD`);
    }
    const owners = parseWorkstreams(row.ownerWorkstreams);
    if (owners.length === 0 || owners.some((owner) => !WORKSTREAM_PATTERN.test(owner))) {
      errors.push(`${row.backlog}: Summary owner workstreams must list WS### owners`);
    }
    if (!hasMeaningfulText(row.nextAction)) {
      errors.push(`${row.backlog}: Summary next action must not be empty`);
    }
  }

  for (const row of detailRows) {
    if (detailById.has(row.backlog)) {
      errors.push(`${row.backlog}: duplicate Surface Details row`);
    }
    detailById.set(row.backlog, row);

    for (const [field, label] of [
      ['currentInvariant', 'current invariant'],
      ['primaryFailureModes', 'primary failure modes'],
      ['requiredProofLayers', 'required proof layers'],
      ['currentBlocker', 'current blocker'],
      ['nextAction', 'next action'],
    ]) {
      if (!hasMeaningfulText(row[field])) {
        errors.push(`${row.backlog}: Surface Details ${label} must not be empty`);
      }
    }
  }

  for (const id of EXPECTED_BACKLOG_IDS) {
    if (!summaryById.has(id)) {
      errors.push(`${id}: missing Summary row`);
    }
    if (!detailById.has(id)) {
      errors.push(`${id}: missing Surface Details row`);
    }
  }

  for (const id of summaryById.keys()) {
    if (!EXPECTED_BACKLOG_IDS.includes(id)) {
      errors.push(`${id}: unexpected Summary row outside C-091..C-098`);
    }
    if (!detailById.has(id)) {
      errors.push(`${id}: Summary row has no matching Surface Details row`);
    }
  }

  for (const id of detailById.keys()) {
    if (!EXPECTED_BACKLOG_IDS.includes(id)) {
      errors.push(`${id}: unexpected Surface Details row outside C-091..C-098`);
    }
    if (!summaryById.has(id)) {
      errors.push(`${id}: Surface Details row has no matching Summary row`);
    }
  }

  for (const id of EXPECTED_BACKLOG_IDS) {
    const summary = summaryById.get(id);
    const detail = detailById.get(id);
    if (
      summary &&
      detail &&
      ALLOWED_STATUSES.has(summary.status) &&
      summary.status !== 'Covered' &&
      /^none\.?$/iu.test(detail.currentBlocker.trim())
    ) {
      errors.push(`${id}: non-Covered Summary status requires a concrete current blocker`);
    }
    if (summary && detail && summary.nextAction !== detail.nextAction) {
      errors.push(`${id}: Summary next action does not match Surface Details next action`);
    }
  }

  return { errors, summaryRows, detailRows };
}

function parseArgs(argv) {
  const args = { path: DEFAULT_LEDGER_PATH };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--path') {
      index += 1;
      if (index >= argv.length) throw new Error('--path requires a value');
      args.path = argv[index];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  const { path } = parseArgs(argv);
  const markdown = await readFile(path, 'utf8');
  const { errors, summaryRows } = validateHighCareLedger(markdown);
  if (errors.length > 0) {
    throw new Error(
      `High-care proof ledger validation failed:\n${errors.map((error) => `- ${error}`).join('\n')}`,
    );
  }
  console.log(`Validated ${summaryRows.length} high-care ledger rows in ${path}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
