import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/context/layout-provider', () => ({
  useLayout: () => ({
    collapsible: 'icon',
    variant: 'sidebar',
  }),
}));

vi.mock('@/components/ui/sidebar', () => ({
  Sidebar: ({ children }: { children: React.ReactNode }) => (
    <aside aria-label="Sidebar navigation">{children}</aside>
  ),
  SidebarContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sidebar-content">{children}</div>
  ),
  SidebarFooter: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sidebar-footer">{children}</div>
  ),
  SidebarHeader: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sidebar-header">{children}</div>
  ),
  SidebarRail: () => <div data-testid="sidebar-rail" />,
}));

vi.mock('@/config/nav', () => ({
  sidebarData: {
    navGroups: [{ title: 'Operate', items: [] }],
  },
}));

vi.mock('./app-title', () => ({
  AppTitle: () => <div>Tixkit Admin</div>,
}));

vi.mock('./nav-group', () => ({
  NavGroup: ({ title }: { title: string }) => <div>{title}</div>,
}));

vi.mock('./nav-user', () => ({
  NavUser: () => <div>Current user</div>,
}));

vi.mock('./scope-selector', () => ({
  ScopeSelector: ({ className }: { className?: string }) => (
    <nav aria-label="Workspace scope" className={className}>
      Workspace Tixkit Dev
    </nav>
  ),
}));

import { AppSidebar } from './app-sidebar';

describe('AppSidebar', () => {
  it('renders workspace scope under the app title in the sidebar header', () => {
    render(<AppSidebar />);

    const header = screen.getByTestId('sidebar-header');
    expect(header).toContainElement(screen.getByText('Tixkit Admin'));
    expect(header).toContainElement(screen.getByRole('navigation', { name: 'Workspace scope' }));
  });
});
