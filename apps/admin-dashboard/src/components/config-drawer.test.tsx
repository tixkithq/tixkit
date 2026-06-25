import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ConfigDrawer } from './config-drawer'

// Mock the sidebar context
vi.mock('@/components/ui/sidebar', () => ({
  useSidebar: () => ({
    open: true,
    setOpen: vi.fn(),
    state: 'expanded',
    isMobile: false,
    setOpenMobile: vi.fn(),
  }),
}))

// Mock theme provider
vi.mock('@/context/theme-provider', () => ({
  useTheme: () => ({
    theme: 'system',
    setTheme: vi.fn(),
    defaultTheme: 'system',
    resolvedTheme: 'light',
    resetTheme: vi.fn(),
  }),
}))

// Mock direction provider
vi.mock('@/context/direction-provider', () => ({
  useDirection: () => ({
    dir: 'ltr',
    setDir: vi.fn(),
    defaultDir: 'ltr',
    resetDir: vi.fn(),
  }),
}))

// Mock layout provider
vi.mock('@/context/layout-provider', () => ({
  useLayout: () => ({
    variant: 'inset',
    setVariant: vi.fn(),
    defaultVariant: 'inset',
    collapsible: 'icon',
    setCollapsible: vi.fn(),
    defaultCollapsible: 'icon',
    resetLayout: vi.fn(),
  }),
}))

// Mock the custom icons
vi.mock('@/assets/custom/icon-dir', () => ({
  IconDir: () => null,
}))
vi.mock('@/assets/custom/icon-layout-compact', () => ({
  IconLayoutCompact: () => null,
}))
vi.mock('@/assets/custom/icon-layout-default', () => ({
  IconLayoutDefault: () => null,
}))
vi.mock('@/assets/custom/icon-layout-full', () => ({
  IconLayoutFull: () => null,
}))
vi.mock('@/assets/custom/icon-sidebar-floating', () => ({
  IconSidebarFloating: () => null,
}))
vi.mock('@/assets/custom/icon-sidebar-inset', () => ({
  IconSidebarInset: () => null,
}))
vi.mock('@/assets/custom/icon-sidebar-sidebar', () => ({
  IconSidebarSidebar: () => null,
}))
vi.mock('@/assets/custom/icon-theme-dark', () => ({
  IconThemeDark: () => null,
}))
vi.mock('@/assets/custom/icon-theme-light', () => ({
  IconThemeLight: () => null,
}))
vi.mock('@/assets/custom/icon-theme-system', () => ({
  IconThemeSystem: () => null,
}))

describe('ConfigDrawer', () => {
  it('renders the settings trigger button', () => {
    render(<ConfigDrawer />)
    const trigger = screen.getByRole('button', {
      name: /open theme settings/i,
    })
    expect(trigger).toBeInTheDocument()
  })

  it('opens the drawer when trigger is clicked', async () => {
    render(<ConfigDrawer />)
    const trigger = screen.getByRole('button', {
      name: /open theme settings/i,
    })
    fireEvent.click(trigger)
    await waitFor(() => {
      expect(screen.getByText('Theme Settings')).toBeInTheDocument()
    })
  })

  it('shows theme, sidebar, layout, and direction sections', async () => {
    render(<ConfigDrawer />)
    fireEvent.click(
      screen.getByRole('button', { name: /open theme settings/i })
    )
    await waitFor(() => {
      expect(screen.getByText('Theme')).toBeInTheDocument()
      expect(screen.getByText('Direction')).toBeInTheDocument()
    })
  })

  it('has a reset button', async () => {
    render(<ConfigDrawer />)
    fireEvent.click(
      screen.getByRole('button', { name: /open theme settings/i })
    )
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /reset all settings/i })
      ).toBeInTheDocument()
    })
  })
})
