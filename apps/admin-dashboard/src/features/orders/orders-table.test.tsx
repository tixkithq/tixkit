import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getOrderColumns } from './columns';
import { OrdersTable } from './orders-table';

const permissionsMock = vi.hoisted(() => ({
  can: vi.fn(),
}));

const adminTableDataState = vi.hoisted(() => ({
  data: { items: [] as unknown[] } as Record<string, unknown> | undefined,
  items: [] as unknown[],
  loading: false,
  error: undefined as { code: string; message: string; status?: number } | undefined,
  refetch: vi.fn(),
  isFetching: false,
  isPlaceholderData: false,
}));

vi.mock('@/context/permission-provider', () => ({
  usePermissions: () => permissionsMock,
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

vi.mock('@/components/data-table/data-table', () => ({
  DataTableV2: ({
    emptyState,
    loading,
    error,
  }: {
    emptyState?: React.ReactNode;
    loading?: boolean;
    error?: { message: string };
  }) => (
    <section>
      {loading && <div data-testid="loading-skeleton">Loading...</div>}
      {error && <div data-testid="error-state">{error.message}</div>}
      <div data-testid="empty-state">{emptyState}</div>
    </section>
  ),
}));

vi.mock('@/components/data-table/stores/url-adapter', () => ({
  useUrlTableState: () => ({
    query: {},
    rejectedParams: [],
    updateQuery: vi.fn(),
    setQuery: vi.fn(),
    resetFilters: vi.fn(),
    hasRejectedParams: false,
  }),
}));

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

describe('OrdersTable with DataTableV2', () => {
  beforeEach(() => {
    adminTableDataState.data = { items: [] };
    adminTableDataState.items = [];
    adminTableDataState.loading = false;
    adminTableDataState.error = undefined;
    adminTableDataState.refetch.mockClear();
    permissionsMock.can.mockImplementation(
      (p?: string) => p === 'orders.write' || p === 'refunds.write',
    );
  });

  it('renders empty state when no orders', () => {
    render(<OrdersTable />);
    expect(screen.getByTestId('empty-state')).toBeInTheDocument();
    expect(screen.getByText('No orders yet')).toBeInTheDocument();
  });

  it('renders loading state during fetch', () => {
    adminTableDataState.loading = true;
    render(<OrdersTable />);
    expect(screen.getByTestId('loading-skeleton')).toBeInTheDocument();
  });

  it('renders error state when fetch fails', () => {
    adminTableDataState.error = { code: 'fetch_error', message: 'Network error' };
    render(<OrdersTable />);
    expect(screen.getByTestId('error-state')).toBeInTheDocument();
  });
});
