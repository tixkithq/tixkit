import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AdminBreadcrumbs, getAdminBreadcrumbItems } from './admin-breadcrumbs';

const navigationMocks = vi.hoisted(() => ({
  pathname: '/',
}));

vi.mock('next/navigation', () => ({
  usePathname: () => navigationMocks.pathname,
}));

describe('getAdminBreadcrumbItems', () => {
  it('returns no breadcrumbs for top-level dashboard sections', () => {
    expect(getAdminBreadcrumbItems('/events')).toEqual([]);
    expect(getAdminBreadcrumbItems('/orders')).toEqual([]);
    expect(getAdminBreadcrumbItems('/settings')).toEqual([]);
    expect(getAdminBreadcrumbItems('/developer')).toEqual([]);
  });

  it('maps event subpages with explicit labels', () => {
    expect(getAdminBreadcrumbItems('/events/evt_1/checkout-form')).toEqual([
      { label: 'Events', href: '/events' },
      { label: 'Event', href: '/events/evt_1' },
      { label: 'Checkout Form' },
    ]);
    expect(getAdminBreadcrumbItems('/events/evt_1/schedule')).toEqual([
      { label: 'Events', href: '/events' },
      { label: 'Event', href: '/events/evt_1' },
      { label: 'Schedule' },
    ]);
    expect(getAdminBreadcrumbItems('/events/evt_1/marketing')).toEqual([
      { label: 'Events', href: '/events' },
      { label: 'Event', href: '/events/evt_1' },
      { label: 'Marketing' },
    ]);
  });

  it('maps editor content routes with content channel labels', () => {
    expect(getAdminBreadcrumbItems('/events/evt_1/content/email')).toEqual([
      { label: 'Events', href: '/events' },
      { label: 'Event', href: '/events/evt_1' },
      { label: 'Content' },
      { label: 'Email' },
    ]);
  });

  it('maps order, developer, and settings detail routes', () => {
    expect(getAdminBreadcrumbItems('/orders/order_1')).toEqual([
      { label: 'Orders', href: '/orders' },
      { label: 'Order' },
    ]);
    expect(getAdminBreadcrumbItems('/developer/api-keys')).toEqual([
      { label: 'Developer', href: '/developer' },
      { label: 'API Keys' },
    ]);
    expect(getAdminBreadcrumbItems('/settings/workspace')).toEqual([
      { label: 'Settings', href: '/settings' },
      { label: 'Workspace' },
    ]);
  });
});

describe('AdminBreadcrumbs', () => {
  it('renders nothing when the current route has no breadcrumb trail', () => {
    navigationMocks.pathname = '/events';

    const { container } = render(<AdminBreadcrumbs />);

    expect(container).toBeEmptyDOMElement();
  });

  it('renders the breadcrumb trail for a matched route', () => {
    navigationMocks.pathname = '/events/evt_1/tickets';

    render(<AdminBreadcrumbs />);

    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Events' })).toHaveAttribute('href', '/events');
    expect(screen.getByRole('link', { name: 'Event' })).toHaveAttribute('href', '/events/evt_1');
    expect(screen.getByText('Tickets')).toHaveAttribute('aria-current', 'page');
  });
});
