import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionGuard } from './permission-guard';

const permissionState = vi.hoisted(() => ({
  allowed: false,
  loading: false,
  error: null as Error | null,
  retry: vi.fn(),
}));

vi.mock('@/context/permission-provider', () => ({
  usePermissions: () => ({
    can: () => permissionState.allowed,
    loading: permissionState.loading,
    error: permissionState.error,
    retry: permissionState.retry,
  }),
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

describe('PermissionGuard', () => {
  beforeEach(() => {
    permissionState.allowed = false;
    permissionState.loading = false;
    permissionState.error = null;
    permissionState.retry.mockReset();
  });

  it('keeps protected content hidden while permissions load', () => {
    permissionState.loading = true;
    render(
      <PermissionGuard required="events.write">
        <span>Protected content</span>
      </PermissionGuard>,
    );

    expect(screen.queryByText('Protected content')).not.toBeInTheDocument();
    expect(screen.queryByText('Access denied')).not.toBeInTheDocument();
  });

  it('distinguishes permission lookup failure and recovers through an explicit retry', () => {
    permissionState.error = new Error('permission service unavailable');
    const view = render(
      <PermissionGuard required="events.write">
        <span>Protected content</span>
      </PermissionGuard>,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Access could not be verified');
    expect(screen.queryByText('Access denied')).not.toBeInTheDocument();
    expect(screen.queryByText('Protected content')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry access check' }));
    expect(permissionState.retry).toHaveBeenCalledTimes(1);

    permissionState.error = null;
    permissionState.loading = true;
    view.rerender(
      <PermissionGuard required="events.write">
        <span>Protected content</span>
      </PermissionGuard>,
    );
    expect(screen.queryByText('Access denied')).not.toBeInTheDocument();

    permissionState.loading = false;
    permissionState.allowed = true;
    view.rerender(
      <PermissionGuard required="events.write">
        <span>Protected content</span>
      </PermissionGuard>,
    );
    expect(screen.getByText('Protected content')).toBeInTheDocument();
  });

  it('renders a denial only after permissions resolve', () => {
    render(
      <PermissionGuard required="events.write">
        <span>Protected content</span>
      </PermissionGuard>,
    );

    expect(screen.getByText('Access denied')).toBeInTheDocument();
    expect(screen.queryByText('Protected content')).not.toBeInTheDocument();
  });

  it('renders protected content when the requirement is satisfied', () => {
    permissionState.allowed = true;
    render(
      <PermissionGuard required="events.write">
        <span>Protected content</span>
      </PermissionGuard>,
    );

    expect(screen.getByText('Protected content')).toBeInTheDocument();
    expect(screen.queryByText('Access denied')).not.toBeInTheDocument();
  });
});
