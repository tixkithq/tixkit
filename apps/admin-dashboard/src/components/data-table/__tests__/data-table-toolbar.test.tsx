import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AdminTableQuery, TableSchema } from '@tixkit/admin-table-core';
import { DataTableToolbar } from '@/components/data-table/data-table-toolbar';

const schema: TableSchema = {
  id: 'orders',
  primaryKey: 'id',
  defaultSort: { field: 'createdAt', direction: 'desc' },
  columns: [
    {
      id: 'buyerEmail',
      type: 'text',
      label: 'Buyer Email',
      sortable: false,
      filterable: true,
      filterType: 'text',
      facet: false,
      sheet: false,
      hiddenByDefault: false,
    },
    {
      id: 'status',
      type: 'enum',
      label: 'Status',
      sortable: true,
      filterable: true,
      filterType: 'select',
      facet: true,
      sheet: false,
      hiddenByDefault: false,
      options: ['paid', 'pending'],
    },
  ],
  maxPageSize: 100,
  defaultPageSize: 25,
  searchableFields: ['buyerEmail'],
  facetFields: ['status'],
};

function renderToolbar(initialQuery: AdminTableQuery) {
  let query = initialQuery;
  const onQueryChange = vi.fn((updater: (prev: AdminTableQuery) => AdminTableQuery) => {
    query = updater(query);
  });

  const view = render(
    <DataTableToolbar
      schema={schema}
      query={query}
      onQueryChange={onQueryChange}
      facets={{ status: { rows: [{ value: 'paid', total: 3 }] } }}
    />,
  );

  return { ...view, getQuery: () => query, onQueryChange };
}

describe('DataTableToolbar', () => {
  it('clears cursor state when search changes', () => {
    vi.useFakeTimers();
    const { getQuery } = renderToolbar({
      cursor: 'cursor_page_2',
      direction: 'next',
      search: 'old',
      limit: 25,
    });

    fireEvent.change(screen.getByLabelText('Search by buyer email…'), {
      target: { value: 'alice@example.com' },
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(getQuery()).toEqual({
      cursor: undefined,
      direction: undefined,
      search: 'alice@example.com',
      limit: 25,
    });
    vi.useRealTimers();
  });

  it('clears cursor state when a select filter changes', async () => {
    const { getQuery } = renderToolbar({
      cursor: 'cursor_page_2',
      direction: 'prev',
      limit: 25,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Filter by Status' }));
    await waitFor(() => expect(screen.getByText('paid')).toBeInTheDocument());
    fireEvent.click(screen.getByText('paid'));

    expect(getQuery()).toEqual({
      cursor: undefined,
      direction: undefined,
      limit: 25,
      filters: { status: { type: 'select', values: ['paid'] } },
    });
  });

  it('clears cursor state when filters are reset', () => {
    const { getQuery } = renderToolbar({
      cursor: 'cursor_page_2',
      direction: 'next',
      search: 'alice',
      sort: [{ field: 'createdAt', direction: 'desc' }],
      filters: { status: { type: 'select', values: ['paid'] } },
      limit: 25,
    });

    fireEvent.click(screen.getByRole('button', { name: /reset/i }));

    expect(getQuery()).toEqual({
      cursor: undefined,
      direction: undefined,
      filters: undefined,
      search: undefined,
      sort: undefined,
      limit: 25,
    });
  });
});
