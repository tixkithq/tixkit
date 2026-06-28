import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CheckInStatusBadge, EventStatusBadge } from './event-status-badge';

describe('status badges', () => {
  it('renders known status labels', () => {
    render(<EventStatusBadge status="published" />);

    expect(screen.getByText('Published')).toBeInTheDocument();
  });

  it('falls back for unexpected runtime statuses', () => {
    render(<CheckInStatusBadge status={'pending_review' as never} />);

    expect(screen.getByText('Pending Review')).toBeInTheDocument();
  });

  it('falls back for missing runtime statuses', () => {
    render(<CheckInStatusBadge status={undefined as never} />);

    expect(screen.getByText('Unknown')).toBeInTheDocument();
  });
});
