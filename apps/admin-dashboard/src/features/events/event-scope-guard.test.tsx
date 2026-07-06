import { render, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventScopeGuard } from './event-scope-guard';

const useAdminDataMock = vi.hoisted(() => vi.fn());
const useBootstrapMock = vi.hoisted(() => ({
  organizationId: 'org_other' as string | undefined,
  brandId: 'brd_other' as string | undefined,
  setOrganizationId: vi.fn(),
  setBrandId: vi.fn(),
}));
const routerMock = vi.hoisted(() => ({ replace: vi.fn() }));

vi.mock('@/hooks/use-admin-table-data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-admin-table-data')>();
  return {
    ...actual,
    useAdminQuery: useAdminDataMock,
  };
});

vi.mock('@/context/bootstrap-provider', () => ({
  useBootstrap: () => useBootstrapMock,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
}));

function makeEvent(overrides: Partial<{ organizationId: string; brandId: string }> = {}) {
  return {
    id: 'evt_1',
    title: 'Launch Night',
    slug: 'launch-night',
    status: 'published' as const,
    startsAt: '2026-07-04T19:00:00.000Z',
    timezone: 'UTC',
    visibility: 'public' as const,
    seo: { title: '', description: '' },
    currency: 'USD',
    grossSalesCents: 0,
    ticketsSold: 0,
    resalePolicy: { enabled: false, maxMultiplier: 1 },
    checkIns: 0,
    updatedAt: '2026-07-01T00:00:00.000Z',
    organizationId: 'org_1',
    brandId: 'brd_1',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useBootstrapMock.organizationId = 'org_other';
  useBootstrapMock.brandId = 'brd_other';
  useBootstrapMock.setOrganizationId.mockImplementation((id: string | undefined) => {
    useBootstrapMock.organizationId = id;
  });
  useBootstrapMock.setBrandId.mockImplementation((id: string | undefined) => {
    useBootstrapMock.brandId = id;
  });
  routerMock.replace.mockReset();
});

describe('EventScopeGuard', () => {
  it('renders children while the event is loading', () => {
    useAdminDataMock.mockReturnValue({ data: undefined, loading: true, error: undefined, refetch: vi.fn() });

    const { getByText } = render(
      <EventScopeGuard eventId="evt_1">
        <p>page content</p>
      </EventScopeGuard>,
    );

    expect(getByText('page content')).toBeInTheDocument();
  });

  it('auto-aligns scope to the event brand when it differs', async () => {
    const event = makeEvent();
    useAdminDataMock.mockReturnValue({ data: event, loading: false, error: undefined, refetch: vi.fn() });

    render(
      <EventScopeGuard eventId="evt_1">
        <p>page content</p>
      </EventScopeGuard>,
    );

    await waitFor(() => {
      expect(useBootstrapMock.setOrganizationId).toHaveBeenCalledWith('org_1');
      expect(useBootstrapMock.setBrandId).toHaveBeenCalledWith('brd_1');
    });
  });

  it('does not call setters when scope already matches', () => {
    useBootstrapMock.organizationId = 'org_1';
    useBootstrapMock.brandId = 'brd_1';
    const event = makeEvent();
    useAdminDataMock.mockReturnValue({ data: event, loading: false, error: undefined, refetch: vi.fn() });

    render(
      <EventScopeGuard eventId="evt_1">
        <p>page content</p>
      </EventScopeGuard>,
    );

    expect(useBootstrapMock.setOrganizationId).not.toHaveBeenCalled();
    expect(useBootstrapMock.setBrandId).not.toHaveBeenCalled();
  });

  it('redirects to /events when the scope is manually switched to a mismatched brand', async () => {
    const event = makeEvent();
    useAdminDataMock.mockReturnValue({ data: event, loading: false, error: undefined, refetch: vi.fn() });

    // First render: scope mismatches, auto-align is pending.
    const { rerender } = render(
      <EventScopeGuard eventId="evt_1">
        <p>page content</p>
      </EventScopeGuard>,
    );

    // Let auto-align settle: simulate the bootstrap state updating to the event's scope.
    await waitFor(() => {
      expect(useBootstrapMock.setBrandId).toHaveBeenCalledWith('brd_1');
    });
    useBootstrapMock.organizationId = 'org_1';
    useBootstrapMock.brandId = 'brd_1';

    rerender(
      <EventScopeGuard eventId="evt_1">
        <p>page content</p>
      </EventScopeGuard>,
    );

    // No redirect yet: scope matches after auto-align.
    expect(routerMock.replace).not.toHaveBeenCalled();

    // Simulate a manual switch to a different brand.
    useBootstrapMock.brandId = 'brd_other';
    rerender(
      <EventScopeGuard eventId="evt_1">
        <p>page content</p>
      </EventScopeGuard>,
    );

    await waitFor(() => {
      expect(routerMock.replace).toHaveBeenCalledWith('/events');
    });
  });

  it('does not redirect when the event lacks organization/brand ids', () => {
    const event = makeEvent({ organizationId: undefined, brandId: undefined });
    useAdminDataMock.mockReturnValue({ data: event, loading: false, error: undefined, refetch: vi.fn() });

    render(
      <EventScopeGuard eventId="evt_1">
        <p>page content</p>
      </EventScopeGuard>,
    );

    expect(useBootstrapMock.setOrganizationId).not.toHaveBeenCalled();
    expect(routerMock.replace).not.toHaveBeenCalled();
  });
});
