import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getEventColumns } from './columns';
import { EventsTable } from './events-table';

const permissionsMock = vi.hoisted(() => ({
  can: vi.fn(),
}));

const adminDataState = vi.hoisted(() => ({
  data: { items: [] },
  loading: false,
  error: null as Error | null,
  refetch: vi.fn(),
}));

vi.mock('@/context/permission-provider', () => ({
  usePermissions: () => permissionsMock,
}));

vi.mock('@/hooks/use-admin-data', () => ({
  useAdminData: () => adminDataState,
}));

vi.mock('@/components/data-table/data-table', () => ({
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
