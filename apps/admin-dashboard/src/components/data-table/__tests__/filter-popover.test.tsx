import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ColumnSpec, TableSchema } from '@tixkit/admin-table-core';
import { DataTableFilterPopover } from '@/components/data-table/data-table-filter-popover';

const selectColumn: ColumnSpec = {
  id: 'status',
  type: 'enum',
  label: 'Status',
  sortable: true,
  filterable: true,
  filterType: 'select',
  facet: true,
  sheet: false,
  hiddenByDefault: false,
  options: Array.from({ length: 200 }, (_, index) => `option_${index}`),
};

const schema: TableSchema = {
  id: 'orders',
  primaryKey: 'id',
  defaultSort: { field: 'createdAt', direction: 'desc' },
  columns: [selectColumn],
  maxPageSize: 100,
  defaultPageSize: 25,
  searchableFields: [],
  facetFields: ['status'],
};

describe('DataTableFilterPopover', () => {
  it('virtualizes long select option lists and still searches off-screen options', async () => {
    const onChange = vi.fn();
    render(
      <DataTableFilterPopover
        schema={schema}
        column={selectColumn}
        value={undefined}
        onChange={onChange}
        facet={{
          rows: [
            { value: 'option_0', total: 12 },
            { value: 'option_199', total: 3 },
          ],
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Filter by Status' }));

    await waitFor(() => expect(screen.getByText('option 0')).toBeInTheDocument());
    expect(screen.queryByText('option 199')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /option/i }).length).toBeLessThan(40);

    fireEvent.change(screen.getByPlaceholderText('Status'), { target: { value: '199' } });

    await waitFor(() => expect(screen.getByText('option 199')).toBeInTheDocument());
    fireEvent.click(screen.getByText('option 199'));

    expect(onChange).toHaveBeenCalledWith({ type: 'select', values: ['option_199'] });
  });
});
