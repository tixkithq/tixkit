import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const bootstrapState = vi.hoisted(() => ({
  value: {
    organizations: [{ id: 'org_1', name: 'Tixkit Dev' }],
    brands: [{ id: 'brd_1', organizationId: 'org_1', name: 'Tixkit Dev', theme: {} }],
    availableBrands: [{ id: 'brd_1', organizationId: 'org_1', name: 'Tixkit Dev', theme: {} }],
    organizationId: 'org_1',
    brandId: 'brd_1',
    setOrganizationId: vi.fn(),
    setBrandId: vi.fn(),
    loading: false,
    error: null,
  },
}));

const sidebarState = vi.hoisted(() => ({
  isMobile: false,
  state: 'expanded' as 'expanded' | 'collapsed',
  toggleSidebar: vi.fn(),
}));

vi.mock('@/context/bootstrap-provider', () => ({
  useBootstrap: () => bootstrapState.value,
}));

vi.mock('@/components/ui/sidebar', () => ({
  SidebarMenu: ({ children }: { children: React.ReactNode }) => <ul>{children}</ul>,
  SidebarMenuItem: ({ children }: { children: React.ReactNode }) => <li>{children}</li>,
  useSidebar: () => sidebarState,
}));

import { WorkspaceSwitcher } from './workspace-switcher';

beforeEach(() => {
  sidebarState.isMobile = false;
  sidebarState.state = 'expanded';
  bootstrapState.value = {
    organizations: [{ id: 'org_1', name: 'Tixkit Dev' }],
    brands: [{ id: 'brd_1', organizationId: 'org_1', name: 'Tixkit Dev', theme: {} }],
    availableBrands: [{ id: 'brd_1', organizationId: 'org_1', name: 'Tixkit Dev', theme: {} }],
    organizationId: 'org_1',
    brandId: 'brd_1',
    setOrganizationId: vi.fn(),
    setBrandId: vi.fn(),
    loading: false,
    error: null,
  };
});

describe('WorkspaceSwitcher', () => {
  it('shows the workspace and brand names in expanded mode', () => {
    render(<WorkspaceSwitcher />);

    // Workspace and brand share the same name in the default fixture.
    expect(screen.getAllByText('Tixkit Dev').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('button', { name: /collapse sidebar/i })).toBeInTheDocument();
  });

  it('renders a switcher dropdown trigger when multiple workspaces or brands exist', () => {
    bootstrapState.value = {
      ...bootstrapState.value,
      organizations: [
        { id: 'org_1', name: 'Tixkit Dev' },
        { id: 'org_2', name: 'Tour Ops' },
      ],
      brands: [
        { id: 'brd_1', organizationId: 'org_1', name: 'Tixkit Dev', theme: {} },
        { id: 'brd_2', organizationId: 'org_1', name: 'Festival Brand', theme: {} },
      ],
      availableBrands: [
        { id: 'brd_1', organizationId: 'org_1', name: 'Tixkit Dev', theme: {} },
        { id: 'brd_2', organizationId: 'org_1', name: 'Festival Brand', theme: {} },
      ],
    };

    render(<WorkspaceSwitcher />);

    expect(screen.getByRole('button', { name: /switch workspace and brand/i })).toBeInTheDocument();
  });

  it('shows static info (no dropdown) when there is only one workspace and one brand', () => {
    render(<WorkspaceSwitcher />);

    expect(
      screen.queryByRole('button', { name: /switch workspace and brand/i }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByText('Tixkit Dev').length).toBeGreaterThanOrEqual(1);
  });

  it('shows a brand logo when available', () => {
    bootstrapState.value = {
      ...bootstrapState.value,
      brands: [
        {
          id: 'brd_1',
          organizationId: 'org_1',
          name: 'Festival Brand',
          theme: { logoUrl: 'https://example.test/logo.png' },
        },
      ],
      availableBrands: [
        {
          id: 'brd_1',
          organizationId: 'org_1',
          name: 'Festival Brand',
          theme: { logoUrl: 'https://example.test/logo.png' },
        },
      ],
    };

    const { container } = render(<WorkspaceSwitcher />);

    const img = container.querySelector('img') as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.src).toBe('https://example.test/logo.png');
  });

  it('shows a loading label while bootstrap is loading', () => {
    bootstrapState.value = { ...bootstrapState.value, loading: true };
    render(<WorkspaceSwitcher />);

    expect(screen.getByText('Loading workspace...')).toBeInTheDocument();
  });
});
