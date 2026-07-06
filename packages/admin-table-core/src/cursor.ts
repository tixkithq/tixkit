/**
 * Cursor pagination utilities.
 *
 * Cursor format: `v{version}.{base64url(JSON)}`
 *
 * The JSON payload carries the ordered sort field values and the primary key
 * tie-breaker. The version prefix lets the server reject cursors from
 * incompatible schema versions.
 *
 * Cursors are opaque to clients (clients treat them as strings, not parsed).
 * No signing key or encryption is required; tenant scope and permissions are
 * enforced server-side regardless of cursor content.
 *
 * See Decision 10 in the implementation plan.
 */

import type { SortDirection } from './query.js';

export interface CursorSortEntry {
  /** Schema field id. */
  field: string;
  direction: SortDirection;
  /** Sort value from the last row on the current page. */
  value: string | number;
}

export interface CursorPayload {
  /** Schema version. */
  v: number;
  /** Ordered sort entries matching the query sort. */
  s: Array<{ f: string; d: SortDirection; v: string | number }>;
  /** Primary key value (tie-breaker). */
  id: string;
}

export const DEFAULT_CURSOR_VERSION = 1;

// ---------------------------------------------------------------------------
// base64url encode/decode (universal: Node and browser)
// ---------------------------------------------------------------------------

export function base64urlEncode(input: string): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(input, 'utf8').toString('base64url');
  }
  const b64 = globalThis.btoa(unescape(encodeURIComponent(input)));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64urlDecode(input: string): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(input, 'base64url').toString('utf8');
  }
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  return decodeURIComponent(escape(globalThis.atob(padded)));
}

// ---------------------------------------------------------------------------
// Cursor encode/decode
// ---------------------------------------------------------------------------

/**
 * Encode a cursor from the last row's sort values and primary key.
 */
export function encodeCursor(
  sortEntries: CursorSortEntry[],
  id: string,
  version: number = DEFAULT_CURSOR_VERSION,
): string {
  const payload: CursorPayload = {
    v: version,
    s: sortEntries.map((e) => ({ f: e.field, d: e.direction, v: e.value })),
    id,
  };
  const json = JSON.stringify(payload);
  return `v${version}.${base64urlEncode(json)}`;
}

/**
 * Decode and validate a cursor string.
 *
 * @throws CursorError if the cursor is malformed or version-incompatible.
 */
export function decodeCursor(
  cursor: string,
  expectedVersion?: number,
): CursorPayload {
  const dotIndex = cursor.indexOf('.');
  if (dotIndex === -1) {
    throw new CursorError('Invalid cursor: missing version prefix');
  }

  const versionPart = cursor.slice(0, dotIndex);
  const b64Part = cursor.slice(dotIndex + 1);

  const versionMatch = /^v(\d+)$/.exec(versionPart);
  if (!versionMatch) {
    throw new CursorError('Invalid cursor: malformed version prefix');
  }
  const version = Number(versionMatch[1]);

  if (expectedVersion !== undefined && version !== expectedVersion) {
    throw new CursorError(
      `Cursor version mismatch: expected v${expectedVersion}, got v${version}`,
      { receivedVersion: version, expectedVersion },
    );
  }

  let json: string;
  try {
    json = base64urlDecode(b64Part);
  } catch {
    throw new CursorError('Invalid cursor: base64url decode failed');
  }

  let payload: CursorPayload;
  try {
    payload = JSON.parse(json) as CursorPayload;
  } catch {
    throw new CursorError('Invalid cursor: JSON parse failed');
  }

  if (typeof payload.v !== 'number' || payload.v !== version) {
    throw new CursorError('Cursor version mismatch between prefix and payload');
  }

  if (!Array.isArray(payload.s) || typeof payload.id !== 'string') {
    throw new CursorError('Invalid cursor: missing sort entries or id');
  }

  return payload;
}

// ---------------------------------------------------------------------------
// Cursor error
// ---------------------------------------------------------------------------

export class CursorError extends Error {
  readonly receivedVersion?: number;
  readonly expectedVersion?: number;

  constructor(
    message: string,
    details?: { receivedVersion?: number; expectedVersion?: number },
  ) {
    super(message);
    this.name = 'CursorError';
    if (details) {
      this.receivedVersion = details.receivedVersion;
      this.expectedVersion = details.expectedVersion;
    }
  }
}

/**
 * Type guard for CursorError.
 */
export function isCursorError(error: unknown): error is CursorError {
  return error instanceof CursorError;
}
