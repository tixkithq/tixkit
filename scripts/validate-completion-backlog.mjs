#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import process from 'node:process';

const DEFAULT_BACKLOG_PATH = 'docs/completion/backlog.md';
const STATUS_KEYS = ['Done', 'In progress', 'Open', 'Deferred', 'Partial'];
const ID_PATTERN = /^C-\d{3}$/;

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

function parseStatusCounts(markdown) {
  const match = /Status counts:\s*([^\n.]+)\./.exec(markdown);
  if (!match) {
    return null;
  }

  const counts = Object.fromEntries(STATUS_KEYS.map((status) => [status, 0]));
  for (const part of match[1].split(',')) {
    const piece = part.trim();
    const status = STATUS_KEYS.find((candidate) => piece.startsWith(`${candidate} `));
    if (!status) continue;
    counts[status] = Number(piece.slice(status.length).trim());
  }
  return counts;
}

function parseTotalRows(markdown) {
  const match = /Total rows:\s*(\d+)\./.exec(markdown);
  return match ? Number(match[1]) : null;
}

export function parseCompletionBacklog(markdown) {
  const rows = [];
  let section = null;

  for (const line of markdown.split(/\r?\n/)) {
    if (line === '## Non-Done Items') {
      section = 'nonDone';
      continue;
    }
    if (line === '## Task Ledger') {
      section = 'ledger';
      continue;
    }
    if (line.startsWith('## ') && section === 'nonDone') {
      section = null;
    }

    const cells = splitMarkdownRow(line);
    if (!cells || isSeparatorRow(cells) || cells[0] === 'ID') {
      continue;
    }
    if (!ID_PATTERN.test(cells[0])) {
      continue;
    }

    rows.push({
      section,
      id: cells[0],
      priority: cells[1],
      workstream: cells[2],
      status: cells[3],
      task: cells[4],
      evidence: cells[5],
    });
  }

  return {
    totalRows: parseTotalRows(markdown),
    statusCounts: parseStatusCounts(markdown),
    nonDoneRows: rows.filter((row) => row.section === 'nonDone'),
    ledgerRows: rows.filter((row) => row.section === 'ledger'),
  };
}

function countStatuses(rows) {
  const counts = Object.fromEntries(STATUS_KEYS.map((status) => [status, 0]));
  for (const row of rows) {
    if (Object.hasOwn(counts, row.status)) {
      counts[row.status] += 1;
    }
  }
  return counts;
}

export function validateCompletionBacklog(markdown) {
  const { totalRows, statusCounts, nonDoneRows, ledgerRows } = parseCompletionBacklog(markdown);
  const errors = [];

  if (totalRows === null) {
    errors.push('Current Summary is missing Total rows');
  }
  if (statusCounts === null) {
    errors.push('Current Summary is missing Status counts');
  }
  if (ledgerRows.length === 0) {
    errors.push('Task Ledger contains no C-### rows');
  }

  const ledgerById = new Map();
  for (const row of ledgerRows) {
    if (!STATUS_KEYS.includes(row.status)) {
      errors.push(`${row.id}: invalid ledger status ${row.status}`);
    }
    if (ledgerById.has(row.id)) {
      errors.push(`${row.id}: duplicate Task Ledger row`);
    }
    ledgerById.set(row.id, row);
  }

  if (totalRows !== null && totalRows !== ledgerRows.length) {
    errors.push(`Current Summary total rows=${totalRows} does not match Task Ledger rows ${ledgerRows.length}`);
  }

  if (statusCounts) {
    const actualCounts = countStatuses(ledgerRows);
    for (const status of STATUS_KEYS) {
      if (statusCounts[status] !== actualCounts[status]) {
        errors.push(
          `Current Summary ${status}=${statusCounts[status]} does not match Task Ledger ${actualCounts[status]}`,
        );
      }
    }
  }

  const expectedNonDoneIds = new Set(
    ledgerRows.filter((row) => row.status !== 'Done').map((row) => row.id),
  );
  const seenNonDoneIds = new Set();
  for (const row of nonDoneRows) {
    const ledgerRow = ledgerById.get(row.id);
    if (!ledgerRow) {
      errors.push(`${row.id}: Non-Done row has no matching Task Ledger row`);
      continue;
    }
    if (row.status === 'Done') {
      errors.push(`${row.id}: Done row must not appear in Non-Done Items`);
    }
    if (row.status !== ledgerRow.status) {
      errors.push(`${row.id}: Non-Done status ${row.status} does not match Task Ledger ${ledgerRow.status}`);
    }
    if (row.task !== ledgerRow.task) {
      errors.push(`${row.id}: Non-Done task does not match Task Ledger task`);
    }
    if (seenNonDoneIds.has(row.id)) {
      errors.push(`${row.id}: duplicate Non-Done row`);
    }
    seenNonDoneIds.add(row.id);
  }

  for (const id of expectedNonDoneIds) {
    if (!seenNonDoneIds.has(id)) {
      errors.push(`${id}: non-Done Task Ledger row is missing from Non-Done Items`);
    }
  }

  return { errors, totalRows, statusCounts, nonDoneRows, ledgerRows };
}

function parseArgs(argv) {
  const args = { path: DEFAULT_BACKLOG_PATH };
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
  const { errors, ledgerRows } = validateCompletionBacklog(markdown);
  if (errors.length > 0) {
    throw new Error(`Completion backlog validation failed:\n${errors.map((error) => `- ${error}`).join('\n')}`);
  }
  console.log(`Validated ${ledgerRows.length} completion backlog rows in ${path}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
