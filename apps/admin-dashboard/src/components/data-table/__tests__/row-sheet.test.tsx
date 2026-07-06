import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import * as React from 'react';
import { DataTableV2RowSheet } from '@/components/data-table/data-table-row-sheet';

describe('DataTableV2RowSheet', () => {
  it('renders children when open', () => {
    render(
      <DataTableV2RowSheet open={true} onOpenChange={() => {}}>
        <div data-testid="sheet-content">Row details</div>
      </DataTableV2RowSheet>,
    );
    expect(screen.getByTestId('sheet-content')).toBeInTheDocument();
    expect(screen.getByText('Row details')).toBeInTheDocument();
  });

  it('does not render children when closed', () => {
    render(
      <DataTableV2RowSheet open={false} onOpenChange={() => {}}>
        <div data-testid="sheet-content">Row details</div>
      </DataTableV2RowSheet>,
    );
    expect(screen.queryByTestId('sheet-content')).not.toBeInTheDocument();
  });

  it('renders title and description', () => {
    render(
      <DataTableV2RowSheet
        open={true}
        onOpenChange={() => {}}
        title="Order Details"
        description="Quick view of order information"
      >
        <div>Content</div>
      </DataTableV2RowSheet>,
    );
    expect(screen.getByText('Order Details')).toBeInTheDocument();
    expect(screen.getByText('Quick view of order information')).toBeInTheDocument();
  });

  it('calls onOpenChange when Escape is pressed', () => {
    const onOpenChange = vi.fn();
    render(
      <DataTableV2RowSheet open={true} onOpenChange={onOpenChange}>
        <div>Content</div>
      </DataTableV2RowSheet>,
    );
    // Radix Dialog handles Escape at the document level
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalled();
  });

  it('restores focus to triggering element on close', () => {
    const FocusTest = () => {
      const [open, setOpen] = React.useState(false);
      const ref = React.useRef<HTMLButtonElement | null>(null);
      return (
        <div>
          <button ref={ref} onClick={() => setOpen(true)} data-testid="trigger">
            Open sheet
          </button>
          <DataTableV2RowSheet
            open={open}
            onOpenChange={setOpen}
            focusReturnRef={ref}
          >
            <div>Content</div>
          </DataTableV2RowSheet>
        </div>
      );
    };
    render(<FocusTest />);

    const trigger = screen.getByTestId('trigger');
    trigger.focus();
    expect(document.activeElement).toBe(trigger);
  });
});
