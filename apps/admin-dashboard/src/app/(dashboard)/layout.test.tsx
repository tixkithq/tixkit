import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  getPrincipal: vi.fn(),
  redirect: vi.fn(),
}))

vi.mock('@clerk/nextjs/server', () => ({
  auth: mocks.auth,
}))

vi.mock('next/navigation', () => ({
  redirect: mocks.redirect,
}))

vi.mock('@/lib/api', () => ({
  adminApi: {
    getPrincipal: mocks.getPrincipal,
  },
  getAdminApiBaseUrl: () => 'http://localhost:4100',
}))

vi.mock('@/components/layout/authenticated-layout', () => ({
  AuthenticatedLayout: ({ children }: { children: React.ReactNode }) => (
    <div data-testid='authenticated-layout'>{children}</div>
  ),
}))

vi.mock('@/components/layout/header', () => ({
  Header: ({ children }: { children: React.ReactNode }) => (
    <header data-testid='header'>{children}</header>
  ),
}))

vi.mock('@/components/layout/main', () => ({
  Main: ({ children }: { children: React.ReactNode }) => (
    <main data-testid='main'>{children}</main>
  ),
}))

vi.mock('@/components/search', () => ({
  Search: () => <div data-testid='search' />,
}))

vi.mock('@/components/theme-switch', () => ({
  ThemeSwitch: () => <div data-testid='theme-switch' />,
}))

vi.mock('@/components/config-drawer', () => ({
  ConfigDrawer: () => <div data-testid='config-drawer' />,
}))

vi.mock('@/components/profile-dropdown', () => ({
  ProfileDropdown: () => <div data-testid='profile-dropdown' />,
}))

vi.mock('@/components/navigation-progress', () => ({
  NavigationProgress: () => <div data-testid='navigation-progress' />,
}))

import DashboardLayout from './layout'

const originalClerkPublishableKey = process.env.CLERK_PUBLISHABLE_KEY
const originalNextPublicClerkPublishableKey =
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY

function enableClerk() {
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_valid'
  delete process.env.CLERK_PUBLISHABLE_KEY
}

function disableClerk() {
  delete process.env.CLERK_PUBLISHABLE_KEY
  delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
}

function restoreClerkEnv() {
  if (originalClerkPublishableKey === undefined) {
    delete process.env.CLERK_PUBLISHABLE_KEY
  } else {
    process.env.CLERK_PUBLISHABLE_KEY = originalClerkPublishableKey
  }

  if (originalNextPublicClerkPublishableKey === undefined) {
    delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
  } else {
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY =
      originalNextPublicClerkPublishableKey
  }
}

describe('DashboardLayout auth handoff', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.redirect.mockImplementation((url: string) => {
      throw new Error(`redirect:${url}`)
    })
    disableClerk()
  })

  afterEach(() => {
    restoreClerkEnv()
  })

  it('renders the dashboard shell without Clerk in local dev mode', async () => {
    const element = await DashboardLayout({
      children: <div data-testid='dashboard-child'>Dashboard</div>,
    })

    render(element)

    expect(mocks.auth).not.toHaveBeenCalled()
    expect(mocks.getPrincipal).not.toHaveBeenCalled()
    expect(screen.getByTestId('authenticated-layout')).toBeInTheDocument()
    expect(screen.getByTestId('dashboard-child')).toBeInTheDocument()
  })

  it('redirects signed-out Clerk users to sign-in before calling the GateKit API', async () => {
    enableClerk()
    mocks.auth.mockResolvedValue({
      userId: null,
      getToken: vi.fn(),
    })

    await expect(
      DashboardLayout({
        children: <div />,
      }),
    ).rejects.toThrow('redirect:/sign-in')

    expect(mocks.getPrincipal).not.toHaveBeenCalled()
  })

  it('allows signed-in Clerk users when the GateKit principal resolves', async () => {
    enableClerk()
    const getToken = vi.fn().mockResolvedValue('clerk_session_jwt')
    mocks.auth.mockResolvedValue({
      userId: 'clerk_user_1',
      getToken,
    })
    mocks.getPrincipal.mockResolvedValue({
      ok: true,
      data: {
        tenantId: 'tnt_1',
        organizationIds: ['org_1'],
        permissions: ['events.read', 'orders.read'],
      },
    })

    const element = await DashboardLayout({
      children: <div data-testid='dashboard-child'>Dashboard</div>,
    })
    render(element)

    expect(getToken).toHaveBeenCalledTimes(1)
    expect(mocks.getPrincipal).toHaveBeenCalledWith('clerk_session_jwt')
    expect(mocks.redirect).not.toHaveBeenCalled()
    expect(screen.getByTestId('dashboard-child')).toBeInTheDocument()
  })

  it('redirects signed-in Clerk users when GateKit identity sync has not created a principal', async () => {
    enableClerk()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.auth.mockResolvedValue({
      userId: 'clerk_user_missing_profile',
      getToken: vi.fn().mockResolvedValue('clerk_session_jwt'),
    })
    mocks.getPrincipal.mockResolvedValue({
      ok: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'User profile not found. Identity sync may be pending.',
        status: 401,
      },
    })

    try {
      await expect(
        DashboardLayout({
          children: <div />,
        }),
      ).rejects.toThrow('redirect:/sign-in?error=unauthorized')

      expect(mocks.getPrincipal).toHaveBeenCalledWith('clerk_session_jwt')
      expect(errorSpy).toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('renders an API unavailable state instead of redirecting when the API cannot be reached', async () => {
    enableClerk()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.auth.mockResolvedValue({
      userId: 'clerk_user_1',
      getToken: vi.fn().mockResolvedValue('clerk_session_jwt'),
    })
    mocks.getPrincipal.mockResolvedValue({
      ok: false,
      error: {
        code: 'network_error',
        message: 'fetch failed',
      },
    })

    try {
      const element = await DashboardLayout({
        children: <div data-testid='dashboard-child'>Dashboard</div>,
      })
      render(element)

      expect(mocks.redirect).not.toHaveBeenCalled()
      expect(
        screen.getByText('Dashboard cannot reach the local API'),
      ).toBeInTheDocument()
      expect(screen.getByText('http://localhost:4100')).toBeInTheDocument()
      expect(screen.getByText('fetch failed')).toBeInTheDocument()
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('fails closed when Clerk returns a session without a usable token', async () => {
    enableClerk()
    mocks.auth.mockResolvedValue({
      userId: 'clerk_user_1',
      getToken: vi.fn().mockResolvedValue(null),
    })
    mocks.getPrincipal.mockResolvedValue({
      ok: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Missing or invalid authorization header',
        status: 401,
      },
    })

    await expect(
      DashboardLayout({
        children: <div />,
      }),
    ).rejects.toThrow('redirect:/sign-in?error=unauthorized')

    expect(mocks.getPrincipal).toHaveBeenCalledWith(undefined)
  })
})
