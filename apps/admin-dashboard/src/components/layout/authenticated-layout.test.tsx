import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ThemeProvider } from '@/context/theme-provider'

vi.mock('@/components/layout/app-sidebar', () => ({
  AppSidebar: () => <aside aria-label='App sidebar' />,
}))

vi.mock('@/components/layout/scope-selector', () => ({
  ScopeSelector: () => <div aria-label='Scope selector' />,
}))

vi.mock('@/context/permission-provider', () => ({
  PermissionProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  usePermissions: () => ({
    permissions: [],
    can: () => true,
    loading: false,
    error: null,
  }),
}))

vi.mock('@/context/bootstrap-provider', () => ({
  BootstrapProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

import { AuthenticatedLayout } from './authenticated-layout'

function renderLayout() {
  return render(
    <ThemeProvider>
      <AuthenticatedLayout>
        <main>Dashboard content</main>
      </AuthenticatedLayout>
    </ThemeProvider>
  )
}

describe('AuthenticatedLayout', () => {
  it('renders dashboard content with command menu inside permission context', () => {
    renderLayout()

    expect(screen.getByText('Dashboard content')).toBeInTheDocument()
  })
})
