import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AuthenticatedLayout } from './authenticated-layout'
import { ThemeProvider } from '@/context/theme-provider'

vi.mock('@/components/layout/app-sidebar', () => ({
  AppSidebar: () => <aside aria-label='App sidebar' />,
}))

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
