import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getEventColumns } from './columns';
import { EventsTable } from './events-table';

const permissionsMock = vi.hoisted(() => ({
  can: vi.fn(),
}));

const eventRows = vi.hoisted(() => ({
  current: [] as Array<Record<string, unknown>>,
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

vi.mock('@/hooks/use-admin-table-data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-admin-table-data')>();
  return {
    ...actual,
    useAdminTableData: () => ({
      data: eventRows.current,
      items: [],
      loading: false,
      error: undefined,
      refetch: vi.fn(),
      isFetching: false,
      isPlaceholderData: false,
    }),
  };
});

vi.mock('@/components/data-table', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/data-table')>();
  return {
    ...actual,
    useUrlTableState: () => ({
      query: {},
      setQuery: vi.fn(),
      updateQuery: vi.fn(),
      resetFilters: vi.fn(),
      hasActiveFilters: false,
    }),
    DataTable: ({
      data,
      renderRowSheet,
      toolbarActions,
      emptyState,
    }: {
      data?: Array<Record<string, unknown>>;
      renderRowSheet?: (row?: Record<string, unknown>) => React.ReactNode;
      toolbarActions?: React.ReactNode;
      emptyState?: React.ReactNode;
    }) => (
      <section>
        <div data-testid="toolbar-actions">{toolbarActions}</div>
        <div data-testid="empty-state">{emptyState}</div>
        <div data-testid="row-sheet">{renderRowSheet?.(data?.[0])}</div>
      </section>
    ),
  };
});

vi.mock('./authenticated-event-image', () => ({
  AuthenticatedEventImage: ({
    source,
  }: {
    source?: {
      url: string;
      altText: string;
      width: number;
      height: number;
    } | null;
  }) =>
    source ? (
      <img src={source.url} alt={source.altText} width={source.width} height={source.height} />
    ) : (
      <span data-testid="event-image-fallback" />
    ),
}));

beforeEach(() => {
  permissionsMock.can.mockImplementation((permission?: string) => permission === 'events.write');
  eventRows.current = [];
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

  it('renders the optimized thumbnail in the event title cell', () => {
    const columns = getEventColumns();
    const titleColumn = columns.find(
      (column) => (column as unknown as { accessorKey?: string }).accessorKey === 'title',
    );
    const cell = titleColumn?.cell as unknown as (context: {
      row: { original: Record<string, unknown> };
    }) => React.ReactNode;

    render(
      cell({
        row: {
          original: {
            id: 'evt_1',
            title: 'Rooftop Showcase',
            thumbnail: {
              renditionId: 'emr_cover',
              role: 'cover',
              variant: 'card',
              altText: 'Rooftop stage at sunset',
              width: 480,
              height: 270,
              checksumSha256: 'a'.repeat(64),
              url: '/v1/events/evt_1/media/renditions/emr_cover',
            },
          },
        },
      }),
    );

    const thumbnail = screen.getByRole('img', {
      name: 'Rooftop stage at sunset',
    });
    expect(thumbnail).toHaveAttribute('src', '/v1/events/evt_1/media/renditions/emr_cover');
    expect(screen.getByRole('link', { name: 'Rooftop Showcase' })).toBeInTheDocument();
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

    expect(screen.queryByRole('link', { name: 'Create event' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('create-event-drawer')).not.toBeInTheDocument();
    expect(screen.getByText('No events yet')).toBeInTheDocument();
    expect(
      screen.getByText('Events will appear here once your workspace starts publishing them.'),
    ).toBeInTheDocument();
  });

  it('shows create affordances for event writers', () => {
    permissionsMock.can.mockImplementation((permission?: string) => permission === 'events.write');

    render(<EventsTable />);

    expect(screen.getAllByRole('link', { name: 'Create event' })).toHaveLength(2);
    expect(screen.getAllByRole('link', { name: 'Create event' })[0]).toHaveAttribute(
      'href',
      '/events/new',
    );
    expect(screen.queryByTestId('create-event-drawer')).not.toBeInTheDocument();
  });

  it('renders row sheet gross sales as currency', () => {
    eventRows.current = [
      {
        id: 'evt_1',
        title: 'Rooftop Showcase',
        status: 'published',
        startsAt: '2026-08-15T20:30:00.000Z',
        venueName: 'Skyline Hall',
        city: 'Chicago',
        ticketsSold: 42,
        grossSalesCents: 123456,
        currency: 'USD',
      },
    ];

    render(<EventsTable />);

    const rowSheet = screen.getByTestId('row-sheet');
    expect(rowSheet).toHaveTextContent('Gross Sales');
    const grossSalesLabel = screen.getByText('Gross Sales');
    expect(grossSalesLabel.nextElementSibling).toHaveTextContent('$1,234.56');
    expect(grossSalesLabel.nextElementSibling).not.toHaveTextContent('Aug 15, 2026');
  });
});
