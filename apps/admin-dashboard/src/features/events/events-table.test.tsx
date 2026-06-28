import { describe, expect, it, vi } from 'vitest';
import { getEventColumns } from './columns';

describe('Events table columns', () => {
  it('generates columns with expected IDs', () => {
    const columns = getEventColumns();
    const ids = columns.map((c) => c.id);
    expect(ids).toContain('select');
    expect(ids).toContain('actions');
  });

  it('title column has accessorKey', () => {
    const columns = getEventColumns();
    const titleCol = columns.find(
      (c) => (c as unknown as { accessorKey?: string }).accessorKey === 'title',
    );
    expect(titleCol).toBeDefined();
  });

  it('status column has accessorKey', () => {
    const columns = getEventColumns();
    const statusCol = columns.find(
      (c) => (c as unknown as { accessorKey?: string }).accessorKey === 'status',
    );
    expect(statusCol).toBeDefined();
  });

  it('select column is not sortable', () => {
    const columns = getEventColumns();
    const selectCol = columns.find((c) => c.id === 'select');
    expect(selectCol?.enableSorting).toBe(false);
  });

  it('actions column is not hideable', () => {
    const columns = getEventColumns();
    const actionsCol = columns.find((c) => c.id === 'actions');
    expect(actionsCol?.enableHiding).toBe(false);
  });

  it('accepts onEdit and onAction callbacks', () => {
    const onEdit = vi.fn();
    const onAction = vi.fn();
    const columns = getEventColumns(onEdit, onAction);
    expect(columns.length).toBeGreaterThan(0);
  });
});
