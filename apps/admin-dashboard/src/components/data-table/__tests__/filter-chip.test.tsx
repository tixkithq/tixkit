import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DataTableV2FilterChip } from '@/components/data-table/data-table-filter-chip';

describe('DataTableV2FilterChip', () => {
  it('renders select filter chip', () => {
    render(
      <DataTableV2FilterChip
        label="Status"
        value={{ type: 'select', values: ['paid', 'failed'] }}
        onRemove={() => {}}
      />,
    );
    expect(screen.getByText('Status:')).toBeInTheDocument();
    expect(screen.getByText('paid, failed')).toBeInTheDocument();
  });

  it('renders boolean filter chip', () => {
    render(
      <DataTableV2FilterChip
        label="Refunded"
        value={{ type: 'boolean', value: true }}
        onRemove={() => {}}
      />,
    );
    expect(screen.getByText('Yes')).toBeInTheDocument();
  });

  it('renders text filter chip', () => {
    render(
      <DataTableV2FilterChip
        label="Email"
        value={{ type: 'text', value: 'test@test.com' }}
        onRemove={() => {}}
      />,
    );
    expect(screen.getByText('test@test.com')).toBeInTheDocument();
  });

  it('renders date range filter chip', () => {
    render(
      <DataTableV2FilterChip
        label="Created"
        value={{ type: 'date_range', from: '2026-01-01', to: '2026-02-01' }}
        onRemove={() => {}}
      />,
    );
    expect(screen.getByText(/from 2026-01-01/)).toBeInTheDocument();
    expect(screen.getByText(/to 2026-02-01/)).toBeInTheDocument();
  });

  it('renders number range filter chip', () => {
    render(
      <DataTableV2FilterChip
        label="Total"
        value={{ type: 'number_range', min: 100, max: 500 }}
        onRemove={() => {}}
      />,
    );
    expect(screen.getByText(/min 100/)).toBeInTheDocument();
    expect(screen.getByText(/max 500/)).toBeInTheDocument();
  });

  it('calls onRemove when remove button is clicked', async () => {
    const onRemove = vi.fn();
    render(
      <DataTableV2FilterChip
        label="Status"
        value={{ type: 'select', values: ['paid'] }}
        onRemove={onRemove}
      />,
    );
    fireEvent.click(screen.getByLabelText('Remove Status filter'));
    expect(onRemove).toHaveBeenCalledOnce();
  });

  it('returns null for empty text filter', () => {
    const { container } = render(
      <DataTableV2FilterChip
        label="Email"
        value={{ type: 'text', value: '' }}
        onRemove={() => {}}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});
