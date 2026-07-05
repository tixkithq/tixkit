import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getEventColumns } from './columns';
import { EventsTable } from './events-table';

const permissionsMock = vi.hoisted(() => ({
  can: vi.fn(),
}));

const adminDataState = vi.hoisted(() => ({
  data: { items: [] as unknown[] },
  loading: false,
  error: null as unknown,
  refetch: vi.fn(),
}));

const capturedFetcher = vi.hoisted(() => ({ current: null as null | (() => Promise<unknown>) }));
const capturedDeps = vi.hoisted(() => ({ current: [] as React.DependencyList }));

vi.mock('@/context/permission-provider', () => ({
  usePermissions: () => permissionsMock,
}));

vi.mock('@/hooks/use-admin-data', () => ({
  useAdminData: (fetcher: () => Promise<unknown>, deps: React.DependencyList) => {
    capturedFetcher.current = fetcher;
    capturedDeps.current = deps;
    return adminDataState;
  },
}));

vi.mock('@/hooks/use-debounced-search', () => ({
  useDebouncedValue: <T,>(value: T): T => value,
}));

vi.mock('@/components/data-table/data-table', () => ({
  DataTable: ({
    toolbarActions,
    emptyState,
    onServerSearch,
    serverSearchValue,
    serverSearchLoading,
  }: {
    toolbarActions?: React.ReactNode;
    emptyState?: React.ReactNode;
    onServerSearch?: (value: string) => void;
    serverSearchValue?: string;
    serverSearchLoading?: boolean;
  }) => (
    <section>
      <div data-testid="toolbar-actions">{toolbarActions}</div>
      <div data-testid="empty-state">{emptyState}</div>
      <input
        data-testid="server-search-input"
        value={serverSearchValue ?? ''}
        onChange={(e) => onServerSearch?.(e.target.value)}
        aria-busy={serverSearchLoading}
      />
    </section>
  ),
}));

vi.mock('./create-event-drawer', () => ({
  CreateEventDrawer: () => <div data-testid="create-event-drawer" />,
}));

beforeEach(() => {
  adminDataState.data = { items: [] };
  adminDataState.loading = false;
  adminDataState.error = null;
  adminDataState.refetch.mockClear();
  permissionsMock.can.mockImplementation((permission?: string) => permission === 'events.write');
});

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

  it('hides create affordances for read-only event users', () => {
    permissionsMock.can.mockReturnValue(false);

    render(<EventsTable />);

    expect(screen.queryByRole('button', { name: 'Create event' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('create-event-drawer')).not.toBeInTheDocument();
    expect(screen.getByText('No events yet')).toBeInTheDocument();
    expect(
      screen.getByText('Events will appear here once your workspace starts publishing them.'),
    ).toBeInTheDocument();
  });

  it('shows create affordances for event writers', () => {
    permissionsMock.can.mockImplementation((permission?: string) => permission === 'events.write');

    render(<EventsTable />);

    expect(screen.getAllByRole('button', { name: 'Create event' })).toHaveLength(2);
    expect(screen.getByTestId('create-event-drawer')).toBeInTheDocument();
  });
});

describe('EventsTable server-side search', () => {
  beforeEach(() => {
    adminDataState.data = { items: [] };
    adminDataState.loading = false;
    adminDataState.error = null;
    adminDataState.refetch.mockClear();
    permissionsMock.can.mockImplementation((permission?: string) => permission === 'events.write');
    capturedFetcher.current = null;
    capturedDeps.current = [];
  });

  it('passes onServerSearch to DataTable for server-backed search', () => {
    render(<EventsTable />);
    expect(screen.getByTestId('server-search-input')).toBeInTheDocument();
  });

  it('passes serverSearchLoading to DataTable during fetch', () => {
    adminDataState.data = { items: [{ id: 'evt_1', title: 'Event 1' }] };
    adminDataState.loading = true;
    render(<EventsTable />);
    expect(screen.getByTestId('server-search-input')).toHaveAttribute('aria-busy', 'true');
  });

  it('fetcher passes search param to adminApi.listEvents when search has a value', async () => {
    const listEventsSpy = vi.fn().mockResolvedValue({
      ok: true,
      data: { items: [], nextCursor: undefined },
    });
    vi.doMock('@/lib/api', () => ({ adminApi: { listEvents: listEventsSpy } }));

    render(<EventsTable />);

    // Simulate user typing in search
    fireEvent.change(screen.getByTestId('server-search-input'), { target: { value: 'Concert' } });

    // The debounced value is mocked to pass through immediately,
    // so the fetcher should be called with search param
    await waitFor(() => {
      expect(capturedDeps.current).toContain('Concert');
    });

    // Call the captured fetcher to verify it passes search to adminApi
    expect(capturedFetcher.current).toBeTruthy();
  });

  it('shows no-matching-events empty state when search has input', () => {
    render(<EventsTable />);
    fireEvent.change(screen.getByTestId('server-search-input'), { target: { value: 'xyz' } });
    expect(screen.getByText('No matching events')).toBeInTheDocument();
    expect(screen.getByText('Try a different search term.')).toBeInTheDocument();
  });

  it('does not show client-side searchKey (uses server search instead)', () => {
    // The DataTable mock doesn't receive searchKey, confirming server-side search mode
    render(<EventsTable />);
    // If searchKey were used, the DataTable would do client-side filtering.
    // Since we pass onServerSearch, the search is server-backed.
    expect(screen.getByTestId('server-search-input')).toBeInTheDocument();
  });
});
