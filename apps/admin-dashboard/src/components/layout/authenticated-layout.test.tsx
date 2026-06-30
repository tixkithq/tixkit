import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '@/context/theme-provider';

vi.mock('@/components/layout/app-sidebar', () => ({
  AppSidebar: () => <aside aria-label="App sidebar" />,
}));

vi.mock('@/context/permission-provider', () => ({
  PermissionProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  usePermissions: () => ({
    permissions: [],
    can: () => true,
    loading: false,
    error: null,
  }),
}));

vi.mock('@/context/bootstrap-provider', () => ({
  BootstrapProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/layout/scope-selector', () => ({
  ScopeSelector: ({ className }: { className?: string }) => (
    <nav aria-label="Workspace scope" className={className}>
      Workspace Tixkit Dev
    </nav>
  ),
}));

import { AuthenticatedLayout } from './authenticated-layout';

function renderLayout() {
  return render(
    <ThemeProvider>
      <AuthenticatedLayout headerActions={<button type="button">Header action</button>}>
        <main>Dashboard content</main>
      </AuthenticatedLayout>
    </ThemeProvider>,
  );
}

describe('AuthenticatedLayout', () => {
  it('renders dashboard content with command menu inside permission context', () => {
    renderLayout();

    expect(screen.getByText('Dashboard content')).toBeInTheDocument();
  });

  it('keeps workspace scope and header actions in the top header', () => {
    renderLayout();

    const header = screen.getByRole('banner');
    expect(header).toContainElement(screen.getByRole('button', { name: 'Toggle Sidebar' }));
    expect(header).toContainElement(screen.getByRole('navigation', { name: 'Workspace scope' }));
    expect(header).toContainElement(screen.getByRole('button', { name: 'Header action' }));
    expect(header).not.toContainElement(screen.getByRole('complementary', { name: 'App sidebar' }));
    expect(screen.getByRole('complementary', { name: 'App sidebar' })).toBeInTheDocument();
  });
});
