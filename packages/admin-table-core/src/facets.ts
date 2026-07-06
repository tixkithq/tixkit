/**
 * Facet metadata helpers.
 *
 * These helpers compute facet metadata (option counts, min/max ranges) from
 * rows. They are used by the server after the three-pass strategy so range
 * facets do not collapse themselves.
 *
 * See TBL-021 in the implementation plan for the three-pass strategy.
 */

import type { AdminTableFacet } from './query.js';

/**
 * Compute option counts for an enum/status select field.
 */
export function computeSelectFacet(
  rows: Array<Record<string, unknown>>,
  field: string,
): AdminTableFacet {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const raw = row[field];
    if (raw === null || raw === undefined) continue;
    const value = String(raw);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return {
    rows: Array.from(counts.entries())
      .map(([value, total]) => ({ value, total }))
      .toSorted((a, b) => b.total - a.total),
    total: rows.length,
  };
}

/**
 * Compute counts for a boolean field (true vs false).
 */
export function computeBooleanFacet(
  rows: Array<Record<string, unknown>>,
  field: string,
): AdminTableFacet {
  let trueCount = 0;
  let falseCount = 0;
  for (const row of rows) {
    if (row[field]) {
      trueCount++;
    } else {
      falseCount++;
    }
  }
  return {
    rows: [
      { value: true, total: trueCount },
      { value: false, total: falseCount },
    ],
    total: rows.length,
  };
}

/**
 * Compute min/max range for a numeric or date field.
 */
export function computeRangeFacet(
  rows: Array<Record<string, unknown>>,
  field: string,
): AdminTableFacet {
  let min: number | undefined;
  let max: number | undefined;
  for (const row of rows) {
    const raw = row[field];
    if (raw === null || raw === undefined) continue;
    const value = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(value)) continue;
    if (min === undefined || value < min) min = value;
    if (max === undefined || value > max) max = value;
  }
  return { min, max };
}

/**
 * Compute a date-range facet (min/max as ISO timestamp numbers).
 */
export function computeDateRangeFacet(
  rows: Array<Record<string, unknown>>,
  field: string,
): AdminTableFacet {
  let min: number | undefined;
  let max: number | undefined;
  for (const row of rows) {
    const raw = row[field];
    if (raw === null || raw === undefined) continue;
    const ts = typeof raw === 'number' ? raw : new Date(raw as string).getTime();
    if (!Number.isFinite(ts)) continue;
    if (min === undefined || ts < min) min = ts;
    if (max === undefined || ts > max) max = ts;
  }
  return { min, max };
}
