/**
 * Minimal `.env` file parser that preserves comments, blank lines, and
 * unquoted/quoted values. It does not expand variable references; it returns the
 * raw key/value pairs exactly as written so that validation can report on
 * missing or placeholder values without mutating the file.
 */

export type ParsedEnvLine =
  | { type: 'entry'; key: string; value: string; raw: string }
  | { type: 'comment'; raw: string }
  | { type: 'blank'; raw: string };

export type ParsedEnvFile = {
  lines: ParsedEnvLine[];
  entries: Map<string, string>;
};

export function parseEnvFile(content: string): ParsedEnvFile {
  const lines: ParsedEnvLine[] = [];
  const entries = new Map<string, string>();

  for (const rawLine of content.split('\n')) {
    const trimmed = rawLine.trim();

    if (trimmed === '') {
      lines.push({ type: 'blank', raw: rawLine });
      continue;
    }

    if (trimmed.startsWith('#')) {
      lines.push({ type: 'comment', raw: rawLine });
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) {
      // Malformed line; keep as comment so it is preserved on rewrite.
      lines.push({ type: 'comment', raw: rawLine });
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1);

    // Strip inline comment if the value is not quoted. Quoted values may
    // contain `#` characters; we only strip comments when the value is bare.
    if (!/^\s*['"]/.test(value)) {
      const commentIndex = value.indexOf(' #');
      if (commentIndex !== -1) {
        value = value.slice(0, commentIndex);
      }
    }

    // Unwrap double quotes and single quotes.
    value = value.trim();
    if (value.length >= 2) {
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
    }

    entries.set(key, value);
    lines.push({ type: 'entry', key, value, raw: rawLine });
  }

  return { lines, entries };
}

export function serializeEnvFile(parsed: ParsedEnvFile): string {
  return parsed.lines.map((line) => line.raw).join('\n');
}

export function updateEnvValue(parsed: ParsedEnvFile, key: string, value: string): ParsedEnvFile {
  const existingIndex = parsed.lines.findIndex((line) => line.type === 'entry' && line.key === key);

  const newEntry: ParsedEnvLine = {
    type: 'entry',
    key,
    value,
    raw: `${key}=${value}`,
  };

  const lines = [...parsed.lines];
  if (existingIndex >= 0) {
    lines[existingIndex] = newEntry;
  } else {
    lines.push(newEntry);
  }

  const entries = new Map(parsed.entries);
  entries.set(key, value);

  return { lines, entries };
}

export function isPlaceholderValue(value: string): boolean {
  if (!value) return true;
  const trimmed = value.trim();
  if (trimmed === '') return true;
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) return true;
  if (trimmed === '***************************************') return true;
  if (trimmed === '************************************') return true;
  return false;
}
