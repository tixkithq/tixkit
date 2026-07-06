import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  TextCell,
  BadgeCell,
  BooleanCell,
  CodeCell,
  MoneyCell,
  NumberCell,
  StatusCell,
  TimestampCell,
} from '@/components/data-table/cells';

describe('TextCell', () => {
  it('renders text value', () => {
    render(<TextCell value="Hello world" />);
    expect(screen.getByText('Hello world')).toBeInTheDocument();
  });

  it('renders fallback for null', () => {
    render(<TextCell value={null} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('renders fallback for undefined', () => {
    render(<TextCell value={undefined} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('renders fallback for empty string', () => {
    render(<TextCell value="" />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('renders custom fallback', () => {
    render(<TextCell value={null} fallback="N/A" />);
    expect(screen.getByText('N/A')).toBeInTheDocument();
  });
});

describe('BadgeCell', () => {
  it('renders badge with value', () => {
    render(<BadgeCell value="active" />);
    expect(screen.getByText('active')).toBeInTheDocument();
  });

  it('renders fallback for null', () => {
    render(<BadgeCell value={null} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});

describe('BooleanCell', () => {
  it('renders check icon for true', () => {
    const { container } = render(<BooleanCell value={true} />);
    expect(container.querySelector('[aria-label="Yes"]')).toBeInTheDocument();
  });

  it('renders x icon for false', () => {
    const { container } = render(<BooleanCell value={false} />);
    expect(container.querySelector('[aria-label="No"]')).toBeInTheDocument();
  });

  it('renders fallback for null', () => {
    render(<BooleanCell value={null} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('renders custom labels', () => {
    render(<BooleanCell value={true} trueLabel="Refunded" falseLabel="Not Refunded" />);
    expect(screen.getByText('Refunded')).toBeInTheDocument();
  });
});

describe('CodeCell', () => {
  it('renders code value', () => {
    render(<CodeCell value="order_abc123" />);
    expect(screen.getByText('order_abc123')).toBeInTheDocument();
  });

  it('renders fallback for null', () => {
    render(<CodeCell value={null} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('truncates long values', () => {
    const longValue = 'a'.repeat(20);
    render(<CodeCell value={longValue} maxLength={10} />);
    const codeEl = screen.getByText(/a+…/);
    expect(codeEl).toBeInTheDocument();
  });

  it('preserves full value in title attribute', () => {
    const longValue = 'a'.repeat(20);
    render(<CodeCell value={longValue} maxLength={10} />);
    expect(screen.getByTitle(longValue)).toBeInTheDocument();
  });
});

describe('MoneyCell', () => {
  it('renders formatted currency', () => {
    render(<MoneyCell cents={1000} currency="USD" />);
    expect(screen.getByText(/\$10\.00/)).toBeInTheDocument();
  });

  it('renders fallback for null', () => {
    render(<MoneyCell cents={null} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});

describe('NumberCell', () => {
  it('renders formatted number', () => {
    render(<NumberCell value={12345} />);
    expect(screen.getByText('12,345')).toBeInTheDocument();
  });

  it('renders fallback for null', () => {
    render(<NumberCell value={null} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});

describe('StatusCell', () => {
  it('renders order status preset', () => {
    render(<StatusCell value="paid" domain="order" />);
    expect(screen.getByText('Paid')).toBeInTheDocument();
  });

  it('renders checkin status preset', () => {
    render(<StatusCell value="checked_in" domain="checkin" />);
    expect(screen.getByText('Checked In')).toBeInTheDocument();
  });

  it('renders fallback for null', () => {
    render(<StatusCell value={null} domain="order" />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('renders unknown status as capitalized badge', () => {
    render(<StatusCell value="custom_status" domain="order" />);
    expect(screen.getByText('custom status')).toBeInTheDocument();
  });
});

describe('TimestampCell', () => {
  it('renders formatted date', () => {
    render(<TimestampCell value="2026-01-15T10:00:00Z" />);
    expect(screen.getByText(/Jan/)).toBeInTheDocument();
    expect(screen.getByText(/15/)).toBeInTheDocument();
  });

  it('renders fallback for null', () => {
    render(<TimestampCell value={null} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('renders relative time when showRelative', () => {
    const recentDate = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    render(<TimestampCell value={recentDate} showRelative />);
    expect(screen.getByText(/5m ago/)).toBeInTheDocument();
  });
});
