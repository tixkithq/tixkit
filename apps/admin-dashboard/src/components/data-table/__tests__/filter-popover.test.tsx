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
    expect(screen.getAllByRole('option', { name: /option/i }).length).toBeLessThan(40);

    fireEvent.change(screen.getByRole('textbox', { name: 'Search Status options' }), {
      target: { value: '199' },
    });

    await waitFor(() => expect(screen.getByText('option 199')).toBeInTheDocument());
    const option = screen.getByRole('option', { name: /option 199/i });
    expect(option).toHaveAttribute('aria-selected', 'false');
    fireEvent.click(option);

    expect(onChange).toHaveBeenCalledWith({ type: 'select', values: ['option_199'] });
  });

  it('navigates and selects across a virtualization boundary with the keyboard', async () => {
    const onChange = vi.fn();
    render(
      <DataTableFilterPopover
        schema={schema}
        column={selectColumn}
        value={undefined}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Filter by Status' }));
    const listbox = await screen.findByRole('listbox', { name: 'Status options' });
    listbox.focus();
    expect(screen.getByRole('option', { name: /option 0/i })).toHaveClass('bg-accent');
    fireEvent.keyDown(listbox, { key: 'End' });

    const lastOption = await screen.findByRole('option', { name: /option 199/i });
    expect(listbox).toHaveAttribute('aria-activedescendant', lastOption.id);
    expect(lastOption).toHaveClass('bg-accent');
    fireEvent.keyDown(listbox, { key: 'Enter' });

    expect(onChange).toHaveBeenCalledWith({ type: 'select', values: ['option_199'] });
  });
});
