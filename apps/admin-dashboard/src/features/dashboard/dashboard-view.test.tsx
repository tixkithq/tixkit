import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// Mock adminApi before importing DashboardView
const mockListEvents = vi.fn();
const mockListOrders = vi.fn();

vi.mock('@/lib/api', () => ({
  adminApi: {
    listEvents: (...args: unknown[]) => mockListEvents(...args),
    listOrders: (...args: unknown[]) => mockListOrders(...args),
  },
}));

vi.mock('@/context/bootstrap-provider', () => ({
  useBootstrap: () => ({
    organizations: [],
    brands: [],
    organizationId: undefined,
    brandId: undefined,
    availableBrands: [],
    setOrganizationId: vi.fn(),
    setBrandId: vi.fn(),
    loading: false,
    error: null,
  }),
}));

vi.mock('@/lib/auth', () => ({
  hasClerkKey: () => false,
  LOCAL_DEV_USER: { name: 'Dev', email: 'dev@localhost', imageUrl: null },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/',
}));

// Mock the lazy-loaded CreateEventDrawer to avoid dynamic import issues
vi.mock('@/features/events/create-event-drawer', () => ({
  CreateEventDrawer: () => null,
}));

import { DashboardView } from './dashboard-view';

function makeEvents() {
  return {
    ok: true as const,
    data: {
      items: [
        {
          id: 'evt_1',
          title: 'Test Event',
          slug: 'test-event',
          status: 'published' as const,
          startsAt: '2026-07-01T19:00:00Z',
          endsAt: '2026-07-01T23:00:00Z',
          timezone: 'UTC',
          venueName: 'Test Venue',
          city: 'Test City',
          currency: 'USD',
          grossSalesCents: 100000,
          ticketsSold: 50,
          capacity: 200,
          checkIns: 10,
          updatedAt: '2026-06-01T00:00:00Z',
        },
      ],
      total: 1,
    },
  };
}

function makeOrders() {
  return {
    ok: true as const,
    data: {
      items: [
        {
          id: 'ord_1',
          eventId: 'evt_1',
          eventTitle: 'Test Event',
          buyerName: 'Alice',
          buyerEmail: 'alice@test.com',
          status: 'paid' as const,
          totalCents: 5000,
          refundedCents: 0,
          currency: 'USD',
          attendeeCount: 2,
          paymentProvider: 'stripe' as const,
          createdAt: '2026-06-01T00:00:00Z',
        },
      ],
      total: 1,
    },
  };
}

function makeError(status: number, code: string, message: string) {
  return {
    ok: false as const,
    error: { code, message, status },
  };
}

function makeEmpty() {
  return {
    ok: true as const,
    data: { items: [], total: 0 },
  };
}

describe('DashboardView error states', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows error state on 401', async () => {
    mockListEvents.mockResolvedValue(
      makeError(401, 'UNAUTHORIZED', 'Missing or invalid authorization header'),
    );
    mockListOrders.mockResolvedValue(
      makeError(401, 'UNAUTHORIZED', 'Missing or invalid authorization header'),
    );

    render(<DashboardView />);

    await waitFor(() => {
      expect(screen.getAllByText(/authentication required/i).length).toBeGreaterThan(0);
    });
  });

  it('shows error state on 403', async () => {
    mockListEvents.mockResolvedValue(makeError(403, 'FORBIDDEN', 'User account is suspended'));
    mockListOrders.mockResolvedValue(makeError(403, 'FORBIDDEN', 'User account is suspended'));

    render(<DashboardView />);

    await waitFor(() => {
      expect(screen.getAllByText(/authentication required/i).length).toBeGreaterThan(0);
    });
  });

  it('shows error state on 500', async () => {
    mockListEvents.mockResolvedValue(
      makeError(500, 'INTERNAL_ERROR', 'An internal error occurred'),
    );
    mockListOrders.mockResolvedValue(
      makeError(500, 'INTERNAL_ERROR', 'An internal error occurred'),
    );

    render(<DashboardView />);

    await waitFor(() => {
      expect(screen.getAllByText(/server error/i).length).toBeGreaterThan(0);
    });
  });

  it('shows loading state initially', async () => {
    mockListEvents.mockReturnValue(new Promise(() => {})); // never resolves
    mockListOrders.mockReturnValue(new Promise(() => {}));

    const { container } = render(<DashboardView />);

    await waitFor(() => {
      // Skeletons are rendered as divs with animate-pulse.
      expect(container.querySelectorAll('[class*="animate"]').length).toBeGreaterThan(0);
    });
  });

  it('shows empty state when API returns no events', async () => {
    mockListEvents.mockResolvedValue(makeEmpty());
    mockListOrders.mockResolvedValue(makeEmpty());

    render(<DashboardView />);

    await waitFor(() => {
      expect(screen.getByText(/no events yet/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/no orders yet/i)).toBeInTheDocument();
  });

  it('shows populated data when API returns events and orders', async () => {
    mockListEvents.mockResolvedValue(makeEvents());
    mockListOrders.mockResolvedValue(makeOrders());

    render(<DashboardView />);

    await waitFor(() => {
      expect(screen.getByText('Test Event')).toBeInTheDocument();
    });
    expect(screen.getByText('Alice')).toBeInTheDocument();
  });

  it('shows error state for events but populated orders', async () => {
    mockListEvents.mockResolvedValue(
      makeError(500, 'INTERNAL_ERROR', 'An internal error occurred'),
    );
    mockListOrders.mockResolvedValue(makeOrders());

    render(<DashboardView />);

    await waitFor(() => {
      expect(screen.getAllByText(/server error/i).length).toBeGreaterThan(0);
    });
    // Orders should still show
    expect(screen.getByText('Alice')).toBeInTheDocument();
  });
});
