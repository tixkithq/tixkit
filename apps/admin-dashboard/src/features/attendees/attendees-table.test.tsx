import { describe, expect, it, vi } from 'vitest';
import { getAttendeeColumns } from './columns';

describe('Attendees table columns', () => {
  it('generates columns with expected IDs', () => {
    const columns = getAttendeeColumns();
    const ids = columns.map((c) => c.id);
    expect(ids).toContain('select');
    expect(ids).toContain('actions');
  });

  it('has name column for search', () => {
    const columns = getAttendeeColumns();
    const nameCol = columns.find(
      (c) => (c as unknown as { accessorKey?: string }).accessorKey === 'name',
    );
    expect(nameCol).toBeDefined();
  });

  it('has status column', () => {
    const columns = getAttendeeColumns();
    const statusCol = columns.find(
      (c) => (c as unknown as { accessorKey?: string }).accessorKey === 'status',
    );
    expect(statusCol).toBeDefined();
  });

  it('has checkInStatus column', () => {
    const columns = getAttendeeColumns();
    const checkInCol = columns.find(
      (c) => (c as unknown as { accessorKey?: string }).accessorKey === 'checkInStatus',
    );
    expect(checkInCol).toBeDefined();
  });

  it('has ticketTypeName column', () => {
    const columns = getAttendeeColumns();
    const ttCol = columns.find(
      (c) => (c as unknown as { accessorKey?: string }).accessorKey === 'ticketTypeName',
    );
    expect(ttCol).toBeDefined();
  });

  it('select column is not sortable', () => {
    const columns = getAttendeeColumns();
    const selectCol = columns.find((c) => c.id === 'select');
    expect(selectCol?.enableSorting).toBe(false);
  });

  it('accepts onEdit callback', () => {
    const onEdit = vi.fn();
    const columns = getAttendeeColumns(onEdit);
    expect(columns.length).toBeGreaterThan(0);
  });
});
