import type { MigrationIssue } from '../../index.js';

export type ParsedCsv = {
  delimiter: string;
  headers: readonly string[];
  rows: readonly Readonly<Record<string, string>>[];
};

const candidates = [',', ';', '\t', '|'] as const;

export const GENERIC_CSV_LIMITS = Object.freeze({
  maxBytes: 10 * 1024 * 1024,
  maxRows: 100_000,
  maxColumns: 256,
  maxHeaderCharacters: 160,
  maxCellCharacters: 65_536,
  maxDocuments: 32,
});

export function assertGenericCsvByteSize(byteSize: number): void {
  if (!Number.isSafeInteger(byteSize) || byteSize < 0)
    throw new RangeError('CSV byte size must be a non-negative safe integer');
  if (byteSize > GENERIC_CSV_LIMITS.maxBytes)
    throw new RangeError(`CSV exceeds the ${GENERIC_CSV_LIMITS.maxBytes}-byte limit`);
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function parseRecords(content: string, delimiter: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  const input = content.replace(/^\uFEFF/u, '');
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index] as string;
    if (quoted) {
      if (character === '"' && input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else field += character;
      continue;
    }
    if (character === '"' && field.length === 0) quoted = true;
    else if (character === delimiter) {
      record.push(field);
      field = '';
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && input[index + 1] === '\n') index += 1;
      record.push(field);
      records.push(record);
      record = [];
      field = '';
    } else field += character;
  }
  if (quoted) throw new SyntaxError('CSV contains an unterminated quoted field');
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records.filter((values) => values.some((value) => value.length > 0));
}

export function detectCsvDelimiter(content: string): (typeof candidates)[number] {
  assertGenericCsvByteSize(utf8ByteLength(content));
  const header = content.replace(/^\uFEFF/u, '').split(/\r?\n/u, 1)[0] ?? '';
  const headerBest = candidates
    .map((delimiter) => ({ delimiter, score: header.split(delimiter).length - 1 }))
    .reduce((best, candidate) => (candidate.score > best.score ? candidate : best));
  if (headerBest.score > 0) return headerBest.delimiter;
  const scores = candidates.map((delimiter) => {
    try {
      const records = parseRecords(content, delimiter).slice(0, 20);
      const widths = records.map((record) => record.length);
      const width = widths[0] ?? 0;
      const consistent = width > 1 && widths.every((candidate) => candidate === width);
      return { delimiter, score: consistent ? width * records.length : 0 };
    } catch {
      return { delimiter, score: -1 };
    }
  });
  return scores.reduce((best, candidate) => (candidate.score > best.score ? candidate : best))
    .delimiter;
}

export function parseCsv(content: string, delimiter = detectCsvDelimiter(content)): ParsedCsv {
  assertGenericCsvByteSize(utf8ByteLength(content));
  const records = parseRecords(content, delimiter);
  const rawHeaders = records.shift() ?? [];
  if (rawHeaders.length > GENERIC_CSV_LIMITS.maxColumns)
    throw new RangeError(`CSV exceeds the ${GENERIC_CSV_LIMITS.maxColumns}-column limit`);
  if (records.length > GENERIC_CSV_LIMITS.maxRows)
    throw new RangeError(`CSV exceeds the ${GENERIC_CSV_LIMITS.maxRows}-row limit`);
  const headers = rawHeaders.map((header) => header.trim());
  if (headers.every((header) => header.length === 0))
    throw new SyntaxError('CSV header is required');
  if (new Set(headers).size !== headers.length) throw new SyntaxError('CSV headers must be unique');
  if (headers.some((header) => header.length === 0))
    throw new SyntaxError('CSV headers cannot be empty');
  if (headers.some((header) => header.length > GENERIC_CSV_LIMITS.maxHeaderCharacters))
    throw new RangeError(
      `CSV headers cannot exceed ${GENERIC_CSV_LIMITS.maxHeaderCharacters} characters`,
    );
  const rows = records.map((values, rowIndex) => {
    if (values.length !== headers.length)
      throw new SyntaxError(
        `CSV row ${rowIndex + 2} has ${values.length} fields; expected ${headers.length}`,
      );
    if (values.some((value) => value.length > GENERIC_CSV_LIMITS.maxCellCharacters))
      throw new RangeError(
        `CSV row ${rowIndex + 2} contains a cell exceeding ${GENERIC_CSV_LIMITS.maxCellCharacters} characters`,
      );
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']));
  });
  return { delimiter, headers, rows };
}

export function csvSyntaxIssue(error: unknown, sourcePosition: string): MigrationIssue {
  return {
    code: 'CSV_SYNTAX_INVALID',
    severity: 'fatal',
    message: error instanceof Error ? error.message : 'CSV parsing failed',
    sourcePosition,
  };
}
