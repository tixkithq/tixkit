import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  getPrincipal: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock('@clerk/nextjs/server', () => ({
  auth: mocks.auth,
}));

vi.mock('next/navigation', () => ({
  redirect: mocks.redirect,
}));

vi.mock('@/lib/api-server', () => ({
  getServerPrincipal: mocks.getPrincipal,
  getServerAdminApiBaseUrl: () => 'http://localhost:4100',
}));

vi.mock('@/components/layout/authenticated-layout', () => ({
  AuthenticatedLayout: ({
    children,
    headerActions,
  }: {
    children: React.ReactNode;
    headerActions?: React.ReactNode;
  }) => (
    <div data-testid="authenticated-layout">
      <header data-testid="header-actions">{headerActions}</header>
      {children}
    </div>
  ),
}));

vi.mock('@/components/layout/main', () => ({
  Main: ({ children }: { children: React.ReactNode }) => <main data-testid="main">{children}</main>,
}));

vi.mock('@/components/search', () => ({
  Search: () => <div data-testid="search" />,
}));

vi.mock('@/components/theme-switch', () => ({
  ThemeSwitch: () => <div data-testid="theme-switch" />,
}));

vi.mock('@/components/config-drawer', () => ({
  ConfigDrawer: () => <div data-testid="config-drawer" />,
}));

vi.mock('@/components/profile-dropdown', () => ({
  ProfileDropdown: () => <div data-testid="profile-dropdown" />,
}));

vi.mock('@/components/navigation-progress', () => ({
  NavigationProgress: () => <div data-testid="navigation-progress" />,
}));

import DashboardLayout from './layout';

const originalClerkPublishableKey = process.env.CLERK_PUBLISHABLE_KEY;
const originalNextPublicClerkPublishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
const originalAuthProvider = process.env.AUTH_PROVIDER;
const originalNextPublicAuthProvider = process.env.NEXT_PUBLIC_AUTH_PROVIDER;
const originalE2eLocalAdminAuth = process.env.E2E_LOCAL_ADMIN_AUTH;

function enableClerk() {
  vi.stubEnv('AUTH_PROVIDER', 'clerk');
  vi.stubEnv('CLERK_PUBLISHABLE_KEY', 'pk_test_valid');
  vi.stubEnv('CLERK_SECRET_KEY', 'sk_test_valid');
  vi.stubEnv('API_BASE_URL', 'https://admin.example.test');
  vi.stubEnv('TIXKIT_CHECKOUT_URL', 'https://checkout.example.test');
  vi.stubEnv('S3_PUBLIC_ENDPOINT', 'https://media.example.test');
}

function disableClerk() {
  delete process.env.AUTH_PROVIDER;
  delete process.env.NEXT_PUBLIC_AUTH_PROVIDER;
  delete process.env.CLERK_PUBLISHABLE_KEY;
  delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  delete process.env.E2E_LOCAL_ADMIN_AUTH;
}

function restoreClerkEnv() {
  if (originalClerkPublishableKey === undefined) {
    delete process.env.CLERK_PUBLISHABLE_KEY;
  } else {
    process.env.CLERK_PUBLISHABLE_KEY = originalClerkPublishableKey;
  }

  if (originalNextPublicClerkPublishableKey === undefined) {
    delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  } else {
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = originalNextPublicClerkPublishableKey;
  }

  if (originalAuthProvider === undefined) {
    delete process.env.AUTH_PROVIDER;
  } else {
    process.env.AUTH_PROVIDER = originalAuthProvider;
  }

  if (originalNextPublicAuthProvider === undefined) {
    delete process.env.NEXT_PUBLIC_AUTH_PROVIDER;
  } else {
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = originalNextPublicAuthProvider;
  }

  if (originalE2eLocalAdminAuth === undefined) {
    delete process.env.E2E_LOCAL_ADMIN_AUTH;
  } else {
    process.env.E2E_LOCAL_ADMIN_AUTH = originalE2eLocalAdminAuth;
  }
}

describe('DashboardLayout auth handoff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.redirect.mockImplementation((url: string) => {
      throw new Error(`redirect:${url}`);
    });
    disableClerk();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    restoreClerkEnv();
  });

  it('renders the dashboard shell without Clerk in local dev mode', async () => {
    vi.stubEnv('NODE_ENV', 'development');

    const element = await DashboardLayout({
      children: <div data-testid="dashboard-child">Dashboard</div>,
    });

    render(element);

    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.getPrincipal).not.toHaveBeenCalled();
    expect(screen.getByTestId('authenticated-layout')).toBeInTheDocument();
    expect(screen.getByTestId('header-actions')).toContainElement(screen.getByTestId('search'));
    expect(screen.getByTestId('header-actions')).toContainElement(
      screen.getByTestId('theme-switch'),
    );
    expect(screen.getByTestId('header-actions')).toContainElement(
      screen.getByTestId('config-drawer'),
    );
    expect(screen.getByTestId('header-actions')).toContainElement(
      screen.getByTestId('profile-dropdown'),
    );
    expect(screen.getByTestId('dashboard-child')).toBeInTheDocument();
  });

  it('fails closed when Clerk is expected but no usable key is configured', async () => {
    vi.stubEnv('NODE_ENV', 'production');

    const element = await DashboardLayout({
      children: <div data-testid="dashboard-child">Dashboard</div>,
    });

    render(element);

    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.getPrincipal).not.toHaveBeenCalled();
    expect(screen.queryByTestId('authenticated-layout')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dashboard-child')).not.toBeInTheDocument();
    expect(screen.getByText('Dashboard authentication is not configured')).toBeInTheDocument();
  });

  it('fails closed with explicit e2e local admin auth outside development', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    process.env.AUTH_PROVIDER = 'dev';
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = 'dev';
    process.env.E2E_LOCAL_ADMIN_AUTH = '1';

    const element = await DashboardLayout({
      children: <div data-testid="dashboard-child">Dashboard</div>,
    });

    render(element);

    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.getPrincipal).not.toHaveBeenCalled();
    expect(screen.queryByTestId('authenticated-layout')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dashboard-child')).not.toBeInTheDocument();
    expect(screen.getByText('Dashboard authentication is not configured')).toBeInTheDocument();
  });

  it('redirects signed-out Clerk users to sign-in before calling the Tixkit API', async () => {
    enableClerk();
    mocks.auth.mockResolvedValue({
      userId: null,
      getToken: vi.fn(),
    });

    await expect(
      DashboardLayout({
        children: <div />,
      }),
    ).rejects.toThrow('redirect:/sign-in');

    expect(mocks.getPrincipal).not.toHaveBeenCalled();
  });

  it('allows signed-in Clerk users when the Tixkit principal resolves', async () => {
    enableClerk();
    const getToken = vi.fn().mockResolvedValue('clerk_session_jwt');
    mocks.auth.mockResolvedValue({
      userId: 'clerk_user_1',
      getToken,
    });
    mocks.getPrincipal.mockResolvedValue({
      ok: true,
      data: {
        tenantId: 'tnt_1',
        organizationIds: ['org_1'],
        permissions: ['events.read', 'orders.read'],
      },
    });

    const element = await DashboardLayout({
      children: <div data-testid="dashboard-child">Dashboard</div>,
    });
    render(element);

    expect(getToken).toHaveBeenCalledTimes(1);
    expect(mocks.getPrincipal).toHaveBeenCalledWith('clerk_session_jwt');
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(screen.getByTestId('dashboard-child')).toBeInTheDocument();
  });

  it('resolves the server principal without a document global', async () => {
    enableClerk();
    vi.stubGlobal('document', undefined);
    mocks.auth.mockResolvedValue({
      userId: 'clerk_user_1',
      getToken: vi.fn().mockResolvedValue('server_token'),
    });
    mocks.getPrincipal.mockResolvedValue({
      ok: true,
      data: {
        tenantId: 'tnt_1',
        organizationIds: ['org_1'],
        permissions: ['events.read'],
      },
    });
    await DashboardLayout({ children: <div /> });
    expect(mocks.getPrincipal).toHaveBeenCalledWith('server_token');
  });

  it('redirects door-only staff to the kiosk surface', async () => {
    enableClerk();
    mocks.auth.mockResolvedValue({
      userId: 'clerk_door_user',
      getToken: vi.fn().mockResolvedValue('clerk_session_jwt'),
    });
    mocks.getPrincipal.mockResolvedValue({
      ok: true,
      data: {
        tenantId: 'tnt_1',
        organizationIds: ['org_1'],
        permissions: ['events.read', 'attendees.read', 'checkins.read', 'checkins.write'],
      },
    });

    await expect(
      DashboardLayout({
        children: <div />,
      }),
    ).rejects.toThrow('redirect:/kiosk');
  });

  it('keeps organizers on the dashboard shell', async () => {
    enableClerk();
    mocks.auth.mockResolvedValue({
      userId: 'clerk_org_user',
      getToken: vi.fn().mockResolvedValue('clerk_session_jwt'),
    });
    mocks.getPrincipal.mockResolvedValue({
      ok: true,
      data: {
        tenantId: 'tnt_1',
        organizationIds: ['org_1'],
        permissions: [
          'events.read',
          'events.write',
          'checkins.read',
          'checkins.write',
          'orders.read',
        ],
      },
    });

    const element = await DashboardLayout({
      children: <div data-testid="dashboard-child">Dashboard</div>,
    });
    render(element);

    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(screen.getByTestId('dashboard-child')).toBeInTheDocument();
  });

  it('redirects signed-in Clerk users when Tixkit identity sync has not created a principal', async () => {
    enableClerk();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.auth.mockResolvedValue({
      userId: 'clerk_user_missing_profile',
      getToken: vi.fn().mockResolvedValue('clerk_session_jwt'),
    });
    mocks.getPrincipal.mockResolvedValue({
      ok: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'User profile not found. Identity sync may be pending.',
        status: 401,
      },
    });

    try {
      await expect(
        DashboardLayout({
          children: <div />,
        }),
      ).rejects.toThrow('redirect:/sign-in?error=unauthorized');

      expect(mocks.getPrincipal).toHaveBeenCalledWith('clerk_session_jwt');
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('renders an API unavailable state instead of redirecting when the API cannot be reached', async () => {
    enableClerk();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.auth.mockResolvedValue({
      userId: 'clerk_user_1',
      getToken: vi.fn().mockResolvedValue('clerk_session_jwt'),
    });
    mocks.getPrincipal.mockResolvedValue({
      ok: false,
      error: {
        code: 'network_error',
        message: 'fetch failed',
      },
    });

    try {
      const element = await DashboardLayout({
        children: <div data-testid="dashboard-child">Dashboard</div>,
      });
      render(element);

      expect(mocks.redirect).not.toHaveBeenCalled();
      expect(screen.getByText('Dashboard cannot reach the local API')).toBeInTheDocument();
      expect(screen.getByText('http://localhost:4100')).toBeInTheDocument();
      expect(screen.getByText('fetch failed')).toBeInTheDocument();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('fails closed when Clerk returns a session without a usable token', async () => {
    enableClerk();
    mocks.auth.mockResolvedValue({
      userId: 'clerk_user_1',
      getToken: vi.fn().mockResolvedValue(null),
    });
    mocks.getPrincipal.mockResolvedValue({
      ok: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Missing or invalid authorization header',
        status: 401,
      },
    });

    await expect(
      DashboardLayout({
        children: <div />,
      }),
    ).rejects.toThrow('redirect:/sign-in?error=unauthorized');

    expect(mocks.getPrincipal).not.toHaveBeenCalled();
  });
});
