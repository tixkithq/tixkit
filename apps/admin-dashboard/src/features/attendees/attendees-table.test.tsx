import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAttendeeColumns } from './columns';
import { AttendeesTable } from './attendees-table';

const adminApiMock = vi.hoisted(() => ({
  createExport: vi.fn(),
  listAttendees: vi.fn(),
}));

const adminTableDataState = vi.hoisted(() => ({
  data: {
    items: [
      {
        id: 'att_1',
        name: 'Ada Lovelace',
        email: 'ada@test.com',
        status: 'registered',
        checkInStatus: 'not_checked_in',
      },
    ],
  } as Record<string, unknown> | undefined,
  loading: false,
  error: undefined as { code: string; message: string; status?: number } | undefined,
  refetch: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  adminApi: adminApiMock,
}));

vi.mock('@/context/bootstrap-provider', () => ({
  useBootstrap: () => ({
    organizations: [],
    brands: [],
    organizationId: undefined,
    brandId: undefined,
    availableBrands: [],
    setOrganizationId: vi.fn(),
    setBrandId: vi.fn(),
    loading: false,
    error: null,
  }),
}));

vi.mock('@/hooks/use-admin-table-data', () => ({
  useAdminTableData: () => adminTableDataState,
}));

vi.mock('@/components/data-table', () => ({
  DataTable: ({
    toolbarActions,
    emptyState,
  }: {
    toolbarActions?: React.ReactNode;
    emptyState?: React.ReactNode;
  }) => (
    <section>
      <div data-testid="toolbar-actions">{toolbarActions}</div>
      <div data-testid="empty-state">{emptyState}</div>
    </section>
  ),
  useUrlTableState: () => ({
    query: {},
    rejectedParams: [],
    updateQuery: vi.fn(),
    setQuery: vi.fn(),
    resetFilters: vi.fn(),
    hasRejectedParams: false,
  }),
}));

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

describe('AttendeesTable export contract', () => {
  beforeEach(() => {
    adminApiMock.createExport.mockClear();
    adminTableDataState.data = {
      items: [
        {
          id: 'att_1',
          name: 'Ada Lovelace',
          email: 'ada@test.com',
          status: 'registered',
          checkInStatus: 'not_checked_in',
        },
      ],
    };
    adminTableDataState.loading = false;
    adminTableDataState.error = undefined;
    adminTableDataState.refetch.mockClear();
  });

  it('does not expose the invalid tenant-wide attendees export action', () => {
    render(<AttendeesTable />);

    expect(screen.queryByRole('button', { name: /export/i })).not.toBeInTheDocument();
    expect(screen.getByTestId('toolbar-actions')).toBeEmptyDOMElement();
    expect(adminApiMock.createExport).not.toHaveBeenCalled();
  });
});
