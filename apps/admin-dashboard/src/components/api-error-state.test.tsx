import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiErrorState } from './api-error-state';

describe('ApiErrorState', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('surfaces and copies request IDs for non-auth failures', () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    render(
      <ApiErrorState
        error={{
          code: 'internal_error',
          message: 'Something failed',
          status: 500,
          requestId: 'req_admin_123',
        }}
      />,
    );

    expect(screen.getByText('Request ID: req_admin_123')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Copy request ID' }));

    expect(writeText).toHaveBeenCalledWith('req_admin_123');
  });

  it('does not expose request IDs on auth failures', () => {
    render(
      <ApiErrorState
        error={{
          code: 'forbidden',
          message: 'Forbidden',
          status: 403,
          requestId: 'req_auth_hidden',
        }}
      />,
    );

    expect(screen.queryByText(/req_auth_hidden/)).not.toBeInTheDocument();
  });
});
