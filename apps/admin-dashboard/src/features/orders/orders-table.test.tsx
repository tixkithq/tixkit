import { describe, expect, it, vi } from 'vitest';
import { getOrderColumns } from './columns';

describe('Orders table columns', () => {
  it('generates columns with expected IDs', () => {
    const columns = getOrderColumns();
    const ids = columns.map((c) => c.id);
    expect(ids).toContain('select');
    expect(ids).toContain('actions');
  });

  it('has buyerEmail column for search', () => {
    const columns = getOrderColumns();
    const buyerCol = columns.find(
      (c) => (c as unknown as { accessorKey?: string }).accessorKey === 'buyerEmail',
    );
    expect(buyerCol).toBeDefined();
  });

  it('has totalCents column', () => {
    const columns = getOrderColumns();
    const totalCol = columns.find(
      (c) => (c as unknown as { accessorKey?: string }).accessorKey === 'totalCents',
    );
    expect(totalCol).toBeDefined();
  });

  it('has status column', () => {
    const columns = getOrderColumns();
    const statusCol = columns.find(
      (c) => (c as unknown as { accessorKey?: string }).accessorKey === 'status',
    );
    expect(statusCol).toBeDefined();
  });

  it('select column is not sortable', () => {
    const columns = getOrderColumns();
    const selectCol = columns.find((c) => c.id === 'select');
    expect(selectCol?.enableSorting).toBe(false);
  });

  it('accepts onRefetch callback', () => {
    const onRefetch = vi.fn();
    const columns = getOrderColumns(onRefetch);
    expect(columns.length).toBeGreaterThan(0);
  });
});
