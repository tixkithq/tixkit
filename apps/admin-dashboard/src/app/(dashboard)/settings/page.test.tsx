import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import SettingsLayout from './layout';
import SettingsPage from './page';

const permissionsMock = vi.hoisted(() => ({
  can: vi.fn(),
}));

const navigationMock = vi.hoisted(() => ({
  pathname: '/settings',
}));

vi.mock('@/context/permission-provider', () => ({
  usePermissions: () => permissionsMock,
}));

vi.mock('next/navigation', () => ({
  usePathname: () => navigationMock.pathname,
}));

describe('SettingsPage', () => {
  beforeEach(() => {
    permissionsMock.can.mockImplementation((permission?: string) => !permission);
  });

  it('uses workspace and members terminology with canonical settings routes', () => {
    render(<SettingsPage />);

    expect(screen.getByRole('link', { name: /Workspace/ })).toHaveAttribute(
      'href',
      '/settings/workspace',
    );
    expect(screen.getByRole('link', { name: /Members/ })).toHaveAttribute(
      'href',
      '/settings/members',
    );
    expect(screen.queryByRole('link', { name: /Organization/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Team/ })).not.toBeInTheDocument();
  });

  it('hides billing-gated settings cards without billing permission', () => {
    render(<SettingsPage />);

    expect(screen.queryByRole('link', { name: /Payments/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Billing/ })).not.toBeInTheDocument();
  });

  it('shows billing-gated settings cards with billing permission', () => {
    permissionsMock.can.mockReturnValue(true);

    render(<SettingsPage />);

    expect(screen.getByRole('link', { name: /Payments/ })).toHaveAttribute(
      'href',
      '/settings/payments',
    );
    expect(screen.getByRole('link', { name: /Billing/ })).toHaveAttribute(
      'href',
      '/settings/billing',
    );
  });
});

describe('SettingsLayout', () => {
  beforeEach(() => {
    permissionsMock.can.mockImplementation((permission?: string) => !permission);
    navigationMock.pathname = '/settings';
  });

  it('hides billing-gated local navigation without billing permission', () => {
    render(
      <SettingsLayout>
        <div>Settings content</div>
      </SettingsLayout>,
    );

    expect(screen.getByText('Settings content')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Payments/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Billing/ })).not.toBeInTheDocument();
  });

  it('shows billing-gated local navigation with billing permission', () => {
    permissionsMock.can.mockReturnValue(true);

    render(
      <SettingsLayout>
        <div>Settings content</div>
      </SettingsLayout>,
    );

    expect(screen.getByRole('link', { name: /Payments/ })).toHaveAttribute(
      'href',
      '/settings/payments',
    );
    expect(screen.getByRole('link', { name: /Billing/ })).toHaveAttribute(
      'href',
      '/settings/billing',
    );
  });
});
