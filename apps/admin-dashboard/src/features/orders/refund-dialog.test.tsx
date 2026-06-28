import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { adminApi, type AdminOrderListItem } from '@/lib/api';

// Mock Radix Select with a native <select> so jsdom can interact with it.
// Radix Select uses PointerEvent APIs that jsdom does not support, preventing
// programmatic mode switching in tests. This mock preserves the same API
// (Select, SelectTrigger, SelectValue, SelectContent, SelectItem) while
// using a native select element that works in jsdom.
vi.mock('@/components/ui/select', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  const SelectContext = React.createContext<{
    value: string;
    onValueChange: (v: string) => void;
    items: { value: string; label: string }[];
    registerItem: (v: string, label: string) => void;
  } | null>(null);

  function Select({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (v: string) => void;
    children: React.ReactNode;
  }) {
    const [items, setItems] = React.useState<{ value: string; label: string }[]>([]);
    const registerItem = React.useCallback((v: string, label: string) => {
      setItems((prev: { value: string; label: string }[]) =>
        prev.find((i) => i.value === v) ? prev : [...prev, { value: v, label }],
      );
    }, []);
    return React.createElement(
      SelectContext.Provider,
      { value: { value, onValueChange, items, registerItem } },
      children,
    );
  }

  function SelectTrigger({
    className,
    ...props
  }: {
    className?: string;
    children?: React.ReactNode;
  }) {
    const ctx = React.useContext(SelectContext);
    return React.createElement(
      'select',
      {
        'data-testid': 'select-trigger',
        className,
        value: ctx?.value ?? '',
        onChange: (e: React.ChangeEvent<HTMLSelectElement>) => ctx?.onValueChange(e.target.value),
        ...props,
      },
      (ctx?.items ?? []).map((item) =>
        React.createElement('option', { key: item.value, value: item.value }, item.label),
      ),
    );
  }

  // Keep these tiny mock components inside the hoisted factory so the Radix
  // replacement remains self-contained for Vitest module mocking.
  // eslint-disable-next-line unicorn/consistent-function-scoping
  function SelectValue() {
    return null;
  }
  // eslint-disable-next-line unicorn/consistent-function-scoping
  function SelectContent({ children }: { children: React.ReactNode }) {
    return children;
  }
  function SelectItem({ value, children }: { value: string; children: React.ReactNode }) {
    const ctx = React.useContext(SelectContext);
    const registerItem = ctx?.registerItem;
    React.useEffect(() => {
      registerItem?.(value, String(children));
    }, [value, children, registerItem]);
    return null;
  }

  return { Select, SelectTrigger, SelectValue, SelectContent, SelectItem };
});

import { RefundDialog } from './refund-dialog';

const paidOrder: AdminOrderListItem = {
  id: 'ord_test_001',
  eventId: 'evt_demo_001',
  eventTitle: 'Test Event',
  buyerName: 'Test Buyer',
  buyerEmail: 'buyer@test.com',
  status: 'paid',
  totalCents: 10_000,
  refundedCents: 0,
  currency: 'USD',
  attendeeCount: 2,
  paymentProvider: 'stripe',
  createdAt: '2026-06-01T00:00:00.000Z',
  paidAt: '2026-06-01T00:05:00.000Z',
};

const partiallyRefundedOrder: AdminOrderListItem = {
  ...paidOrder,
  id: 'ord_test_002',
  status: 'partially_refunded',
  refundedCents: 4_000,
};

describe('RefundDialog', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders dialog title and refundable balance when open', () => {
    render(<RefundDialog order={paidOrder} open onOpenChange={vi.fn()} onSuccess={vi.fn()} />);
    expect(screen.getByText(/Refund order ord_test_001/)).toBeInTheDocument();
    const description = screen.getByText(/Refundable:/);
    expect(description.textContent).toContain('$100.00');
  });

  it('does not render when closed', () => {
    render(
      <RefundDialog order={paidOrder} open={false} onOpenChange={vi.fn()} onSuccess={vi.fn()} />,
    );
    expect(screen.queryByText(/Refund order ord_test_001/)).not.toBeInTheDocument();
  });

  it('shows already-refunded and remaining amounts for partially refunded orders', () => {
    render(
      <RefundDialog
        order={partiallyRefundedOrder}
        open
        onOpenChange={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );
    const description = screen.getByText(/Already refunded:/);
    expect(description.textContent).toContain('$40.00');
    expect(description.textContent).toContain('$60.00');
  });

  it('renders refund type selector with full and partial options', () => {
    render(<RefundDialog order={paidOrder} open onOpenChange={vi.fn()} onSuccess={vi.fn()} />);
    // The refund type Select trigger shows "Full refund" by default.
    expect(screen.getByText(/Full refund/)).toBeInTheDocument();
  });

  it('renders voidTickets and restoreInventory switches with defaults', () => {
    render(<RefundDialog order={paidOrder} open onOpenChange={vi.fn()} onSuccess={vi.fn()} />);
    const voidSwitch = screen.getByRole('switch', { name: /Void tickets/ });
    const restoreSwitch = screen.getByRole('switch', { name: /Restore inventory/ });
    // voidTickets defaults to true (checked).
    expect(voidSwitch).toHaveAttribute('data-state', 'checked');
    // restoreInventory defaults to false (unchecked).
    expect(restoreSwitch).toHaveAttribute('data-state', 'unchecked');
  });

  it('disables submit when reason is empty', () => {
    render(<RefundDialog order={paidOrder} open onOpenChange={vi.fn()} onSuccess={vi.fn()} />);
    const confirmButton = screen.getByText(/Refund \$100.00/).closest('button');
    expect(confirmButton).toBeDisabled();
  });

  it('enables submit after entering a reason in full refund mode', async () => {
    render(<RefundDialog order={paidOrder} open onOpenChange={vi.fn()} onSuccess={vi.fn()} />);
    const reasonTextarea = screen.getByPlaceholderText(/Describe the refund reason/);
    fireEvent.change(reasonTextarea, { target: { value: 'Customer request' } });
    const confirmButton = screen.getByText(/Refund \$100.00/).closest('button');
    await waitFor(() => {
      expect(confirmButton).not.toBeDisabled();
    });
  });

  it('calls refundOrder with full refund (no amountCents) and fires onSuccess', async () => {
    const spy = vi.spyOn(adminApi, 'refundOrder').mockResolvedValue({
      ok: true,
      data: {
        orderId: 'ord_test_001',
        refundAmount: 10_000,
        status: 'pending',
        message: 'Refund workflow started',
      },
    });
    const onOpenChange = vi.fn();
    const onSuccess = vi.fn();

    render(
      <RefundDialog order={paidOrder} open onOpenChange={onOpenChange} onSuccess={onSuccess} />,
    );

    const reasonTextarea = screen.getByPlaceholderText(/Describe the refund reason/);
    fireEvent.change(reasonTextarea, { target: { value: 'requested_by_customer' } });

    const confirmButton = screen.getByText(/Refund \$100.00/).closest('button')!;
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith(
        'ord_test_001',
        expect.objectContaining({
          reason: 'requested_by_customer',
          voidTickets: true,
          restoreInventory: false,
        }),
      );
    });
    expect(spy.mock.calls[0][1].amountCents).toBeUndefined();
    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalled();
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it('passes voidTickets and restoreInventory options to refundOrder', async () => {
    const spy = vi.spyOn(adminApi, 'refundOrder').mockResolvedValue({
      ok: true,
      data: {
        orderId: 'ord_test_001',
        refundAmount: 10_000,
        status: 'pending',
        message: 'Refund workflow started',
      },
    });

    render(<RefundDialog order={paidOrder} open onOpenChange={vi.fn()} onSuccess={vi.fn()} />);

    const reasonTextarea = screen.getByPlaceholderText(/Describe the refund reason/);
    fireEvent.change(reasonTextarea, { target: { value: 'fraudulent' } });

    // Toggle voidTickets off and restoreInventory on.
    const voidSwitch = screen.getByRole('switch', { name: /Void tickets/ });
    fireEvent.click(voidSwitch);

    const restoreSwitch = screen.getByRole('switch', { name: /Restore inventory/ });
    fireEvent.click(restoreSwitch);

    const confirmButton = screen.getByText(/Refund \$100.00/).closest('button')!;
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith(
        'ord_test_001',
        expect.objectContaining({
          voidTickets: false,
          restoreInventory: true,
        }),
      );
    });
  });

  it('displays API error message without fake success', async () => {
    vi.spyOn(adminApi, 'refundOrder').mockResolvedValue({
      ok: false,
      error: { code: 'not_refundable', message: 'Order is not in a refundable state' },
    });

    const onOpenChange = vi.fn();
    const onSuccess = vi.fn();

    render(
      <RefundDialog order={paidOrder} open onOpenChange={onOpenChange} onSuccess={onSuccess} />,
    );

    const reasonTextarea = screen.getByPlaceholderText(/Describe the refund reason/);
    fireEvent.change(reasonTextarea, { target: { value: 'requested_by_customer' } });

    const confirmButton = screen.getByText(/Refund \$100.00/).closest('button')!;
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(screen.getByText('Order is not in a refundable state')).toBeInTheDocument();
    });
    // Dialog should NOT close and onSuccess should NOT fire.
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('resets form state when reopened for a different order', () => {
    const { rerender } = render(
      <RefundDialog order={paidOrder} open onOpenChange={vi.fn()} onSuccess={vi.fn()} />,
    );

    // Enter a reason.
    const reasonTextarea = screen.getByPlaceholderText(/Describe the refund reason/);
    fireEvent.change(reasonTextarea, { target: { value: 'old reason' } });

    // Re-render with a different order (dialog still open).
    rerender(
      <RefundDialog
        order={partiallyRefundedOrder}
        open
        onOpenChange={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );

    // Reason should be reset.
    const updatedTextarea = screen.getByPlaceholderText(
      /Describe the refund reason/,
    ) as HTMLTextAreaElement;
    expect(updatedTextarea.value).toBe('');
  });
});

// Partial refund mode tests using PointerEvent polyfill for Radix Select.
describe('RefundDialog partial refund mode', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('switches to partial mode, enters amount, and submits with amountCents', async () => {
    const spy = vi.spyOn(adminApi, 'refundOrder').mockResolvedValue({
      ok: true,
      data: {
        orderId: 'ord_test_001',
        refundAmount: 5_000,
        status: 'pending',
        message: 'Refund workflow started',
      },
    });
    const onOpenChange = vi.fn();
    const onSuccess = vi.fn();

    render(
      <RefundDialog order={paidOrder} open onOpenChange={onOpenChange} onSuccess={onSuccess} />,
    );

    // Switch to partial mode using the native select mock (first select = refund type).
    const selectTriggers = screen.getAllByTestId('select-trigger') as HTMLSelectElement[];
    fireEvent.change(selectTriggers[0], { target: { value: 'partial' } });

    // Wait for the amount input to appear.
    await waitFor(() => {
      expect(screen.getByPlaceholderText('0.00')).toBeInTheDocument();
    });

    // Enter a partial amount ($50.00 = 5000 cents).
    const amountInput = screen.getByPlaceholderText('0.00');
    fireEvent.change(amountInput, { target: { value: '50.00' } });

    // Enter a reason.
    const reasonTextarea = screen.getByPlaceholderText(/Describe the refund reason/);
    fireEvent.change(reasonTextarea, { target: { value: 'requested_by_customer' } });

    // Submit.
    const confirmButton = screen.getByRole('button', { name: /Refund/ });
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith(
        'ord_test_001',
        expect.objectContaining({
          amountCents: 5_000,
          reason: 'requested_by_customer',
          voidTickets: true,
          restoreInventory: false,
        }),
      );
    });
    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalled();
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it('validates partial amount cannot exceed remaining refundable balance', async () => {
    render(
      <RefundDialog
        order={partiallyRefundedOrder}
        open
        onOpenChange={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );

    // Switch to partial mode.
    const selectTriggers = screen.getAllByTestId('select-trigger') as HTMLSelectElement[];
    fireEvent.change(selectTriggers[0], { target: { value: 'partial' } });

    await waitFor(() => {
      expect(screen.getByPlaceholderText('0.00')).toBeInTheDocument();
    });

    // Enter an amount exceeding the refundable balance ($60.00 remaining, enter $70.00).
    const amountInput = screen.getByPlaceholderText('0.00');
    fireEvent.change(amountInput, { target: { value: '70.00' } });

    // Enter a reason.
    const reasonTextarea = screen.getByPlaceholderText(/Describe the refund reason/);
    fireEvent.change(reasonTextarea, { target: { value: 'requested_by_customer' } });

    // Should show validation error about exceeding balance.
    await waitFor(() => {
      expect(
        screen.getByText(/cannot exceed the remaining refundable balance/),
      ).toBeInTheDocument();
    });

    // Confirm button should be disabled.
    const confirmButton = screen.getByRole('button', { name: /Refund/ });
    expect(confirmButton).toBeDisabled();
  });

  it('validates partial amount must be greater than zero', async () => {
    render(<RefundDialog order={paidOrder} open onOpenChange={vi.fn()} onSuccess={vi.fn()} />);

    // Switch to partial mode.
    const selectTriggers = screen.getAllByTestId('select-trigger') as HTMLSelectElement[];
    fireEvent.change(selectTriggers[0], { target: { value: 'partial' } });

    await waitFor(() => {
      expect(screen.getByPlaceholderText('0.00')).toBeInTheDocument();
    });

    // Enter zero amount.
    const amountInput = screen.getByPlaceholderText('0.00');
    fireEvent.change(amountInput, { target: { value: '0' } });

    // Enter a reason.
    const reasonTextarea = screen.getByPlaceholderText(/Describe the refund reason/);
    fireEvent.change(reasonTextarea, { target: { value: 'requested_by_customer' } });

    // Should show validation error about zero amount.
    await waitFor(() => {
      expect(screen.getByText(/must be greater than zero/)).toBeInTheDocument();
    });
  });
});
