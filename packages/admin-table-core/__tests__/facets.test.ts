import { describe, it, expect } from 'vitest';
import {
  computeSelectFacet,
  computeBooleanFacet,
  computeRangeFacet,
  computeDateRangeFacet,
} from '../src/index.js';

const rows: Array<Record<string, unknown>> = [
  { status: 'paid', totalCents: 1000, refundState: true, createdAt: '2026-01-01T00:00:00Z' },
  { status: 'paid', totalCents: 2000, refundState: false, createdAt: '2026-01-02T00:00:00Z' },
  { status: 'failed', totalCents: 500, refundState: false, createdAt: '2026-01-03T00:00:00Z' },
  { status: 'pending', totalCents: 3000, refundState: false, createdAt: '2026-01-04T00:00:00Z' },
  { status: 'paid', totalCents: 1500, refundState: true, createdAt: '2026-01-05T00:00:00Z' },
];

describe('computeSelectFacet', () => {
  it('counts option values', () => {
    const facet = computeSelectFacet(rows, 'status');
    expect(facet.total).toBe(5);
    const paidRow = facet.rows?.find((r) => r.value === 'paid');
    expect(paidRow?.total).toBe(3);
    const failedRow = facet.rows?.find((r) => r.value === 'failed');
    expect(failedRow?.total).toBe(1);
  });

  it('sorts by count descending', () => {
    const facet = computeSelectFacet(rows, 'status');
    expect(facet.rows?.[0].value).toBe('paid');
    expect(facet.rows?.[0].total).toBe(3);
  });

  it('skips null/undefined values', () => {
    const rowsWithNull = [
      { status: 'paid' },
      { status: null },
      { status: undefined },
      { other: 'x' },
    ];
    const facet = computeSelectFacet(rowsWithNull as Array<Record<string, unknown>>, 'status');
    expect(facet.total).toBe(4);
    const paidRow = facet.rows?.find((r) => r.value === 'paid');
    expect(paidRow?.total).toBe(1);
  });
});

describe('computeBooleanFacet', () => {
  it('counts true and false', () => {
    const facet = computeBooleanFacet(rows, 'refundState');
    expect(facet.total).toBe(5);
    const trueRow = facet.rows?.find((r) => r.value === true);
    const falseRow = facet.rows?.find((r) => r.value === false);
    expect(trueRow?.total).toBe(2);
    expect(falseRow?.total).toBe(3);
  });
});

describe('computeRangeFacet', () => {
  it('computes min and max', () => {
    const facet = computeRangeFacet(rows, 'totalCents');
    expect(facet.min).toBe(500);
    expect(facet.max).toBe(3000);
  });

  it('returns undefined min/max for empty rows', () => {
    const facet = computeRangeFacet([], 'totalCents');
    expect(facet.min).toBeUndefined();
    expect(facet.max).toBeUndefined();
  });

  it('skips non-numeric values', () => {
    const rowsWithString = [
      { amount: 100 },
      { amount: 'not a number' },
      { amount: 200 },
      { amount: null },
    ];
    const facet = computeRangeFacet(
      rowsWithString as Array<Record<string, unknown>>,
      'amount',
    );
    expect(facet.min).toBe(100);
    expect(facet.max).toBe(200);
  });
});

describe('computeDateRangeFacet', () => {
  it('computes min and max as timestamps', () => {
    const facet = computeDateRangeFacet(rows, 'createdAt');
    expect(facet.min).toBe(new Date('2026-01-01T00:00:00Z').getTime());
    expect(facet.max).toBe(new Date('2026-01-05T00:00:00Z').getTime());
  });

  it('returns undefined for empty rows', () => {
    const facet = computeDateRangeFacet([], 'createdAt');
    expect(facet.min).toBeUndefined();
    expect(facet.max).toBeUndefined();
  });
});
