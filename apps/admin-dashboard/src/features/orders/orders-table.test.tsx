import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getOrderColumns } from './columns';
import { OrdersTable } from './orders-table';

const permissionsMock = vi.hoisted(() => ({
  can: vi.fn(),
}));

const adminDataState = vi.hoisted(() => ({
  data: { items: [] as unknown[] },
  loading: false,
  error: null as unknown,
  refetch: vi.fn(),
}));

const capturedDeps = vi.hoisted(() => ({ current: [] as React.DependencyList }));

vi.mock('@/context/permission-provider', () => ({
  usePermissions: () => permissionsMock,
}));

vi.mock('@/hooks/use-admin-data', () => ({
  useAdminData: (_fetcher: () => Promise<unknown>, deps: React.DependencyList) => {
    capturedDeps.current = deps;
    return adminDataState;
  },
}));

vi.mock('@/hooks/use-debounced-search', () => ({
  useDebouncedValue: <T,>(value: T): T => value,
}));

vi.mock('@/components/data-table/data-table', () => ({
  DataTable: ({
    onServerSearch,
    serverSearchValue,
    serverSearchLoading,
    emptyState,
  }: {
    onServerSearch?: (value: string) => void;
    serverSearchValue?: string;
    serverSearchLoading?: boolean;
    emptyState?: React.ReactNode;
  }) => (
    <section>
      <input
        data-testid="server-search-input"
        value={serverSearchValue ?? ''}
        onChange={(e) => onServerSearch?.(e.target.value)}
        aria-busy={serverSearchLoading}
      />
      <div data-testid="empty-state">{emptyState}</div>
    </section>
  ),
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

describe('OrdersTable server-side search', () => {
  beforeEach(() => {
    adminDataState.data = { items: [] };
    adminDataState.loading = false;
    adminDataState.error = null;
    adminDataState.refetch.mockClear();
    permissionsMock.can.mockImplementation((p?: string) => p === 'orders.write' || p === 'refunds.write');
    capturedDeps.current = [];
  });

  it('passes onServerSearch to DataTable for server-backed search', () => {
    render(<OrdersTable />);
    expect(screen.getByTestId('server-search-input')).toBeInTheDocument();
  });

  it('passes serverSearchLoading to DataTable during fetch', () => {
    adminDataState.data = { items: [{ id: 'ord_1' }] };
    adminDataState.loading = true;
    render(<OrdersTable />);
    expect(screen.getByTestId('server-search-input')).toHaveAttribute('aria-busy', 'true');
  });

  it('updates debounced search deps when user types', () => {
    render(<OrdersTable />);
    fireEvent.change(screen.getByTestId('server-search-input'), { target: { value: 'test@example.com' } });
    expect(capturedDeps.current).toContain('test@example.com');
  });

  it('shows no-matching-orders empty state when search has input', () => {
    render(<OrdersTable />);
    fireEvent.change(screen.getByTestId('server-search-input'), { target: { value: 'xyz' } });
    expect(screen.getByText('No matching orders')).toBeInTheDocument();
    expect(screen.getByText('Try a different search term.')).toBeInTheDocument();
  });
});
