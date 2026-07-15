import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// Mock adminApi before importing DashboardView
const mockListEvents = vi.fn();
const mockListOrders = vi.fn();
const mockGetWorkspaceReadiness = vi.fn().mockResolvedValue({
  ok: true,
  data: {
    tenantId: 'tnt_1',
    organizationId: 'org_1',
    brandId: 'brd_1',
    generatedAt: new Date(0).toISOString(),
    paymentMode: 'capture',
    complete: false,
    steps: [],
    actionFeed: [
      {
        id: 'workspace:payment_path',
        stepId: 'payment_path',
        severity: 'critical',
        owner: 'finance',
        deadlineAt: null,
        status: 'blocked',
        reasonCodes: ['payment_path_missing'],
        actionId: 'configure_payments',
        requiredPermission: 'billing.write',
        updatedAt: null,
      },
    ],
  },
});
const mockCan = vi.fn<(permission: string) => boolean>(() => true);

vi.mock('@/lib/api', () => ({
  adminApi: {
    listEvents: (...args: unknown[]) => mockListEvents(...args),
    listOrders: (...args: unknown[]) => mockListOrders(...args),
    getWorkspaceReadiness: (...args: unknown[]) => mockGetWorkspaceReadiness(...args),
  },
}));

vi.mock('@/features/events/authenticated-event-image', () => ({
  AuthenticatedEventImage: ({
    source,
  }: {
    source?: {
      url: string;
      altText: string;
      width: number;
      height: number;
    } | null;
  }) =>
    source ? (
      <img src={source.url} alt={source.altText} width={source.width} height={source.height} />
    ) : (
      <span data-testid="event-image-fallback" />
    ),
}));

vi.mock('@/context/bootstrap-provider', () => ({
  useBootstrap: () => ({
    organizations: [],
    brands: [],
    organizationId: 'org_1',
    brandId: 'brd_1',
    availableBrands: [],
    setOrganizationId: vi.fn(),
    setBrandId: vi.fn(),
    loading: false,
    error: null,
  }),
}));

vi.mock('@/context/permission-provider', () => ({
  usePermissions: () => ({ can: mockCan, loading: false, error: null }),
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
          thumbnail: {
            renditionId: 'emr_cover',
            role: 'cover' as const,
            variant: 'card' as const,
            altText: 'Audience watching Test Event',
            width: 480,
            height: 270,
            checksumSha256: 'a'.repeat(64),
            url: '/v1/events/evt_1/media/renditions/emr_cover',
          },
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
    mockCan.mockReturnValue(true);
  });

  it('renders the optimized recent-event thumbnail with intrinsic dimensions', async () => {
    mockListEvents.mockResolvedValue(makeEvents());
    mockListOrders.mockResolvedValue(makeEmpty());

    render(<DashboardView />);

    const thumbnail = await screen.findByRole('img', {
      name: 'Audience watching Test Event',
    });
    expect(thumbnail).toHaveAttribute('src', '/v1/events/evt_1/media/renditions/emr_cover');
    expect(thumbnail).toHaveAttribute('width', '480');
    expect(thumbnail).toHaveAttribute('height', '270');
  });

  it('renders the server-prioritized action owner, severity, deadline, and remediation', async () => {
    mockListEvents.mockResolvedValue(makeEmpty());
    mockListOrders.mockResolvedValue(makeEmpty());

    render(<DashboardView />);

    expect(await screen.findByText(/Critical · Owner: Finance · No fixed deadline/)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Resolve Prepare the payment path' })).toHaveAttribute(
      'href',
      '/settings/payments',
    );
  });

  it('fails closed with an actionable retry when an incomplete mixed-version response has no feed', async () => {
    mockGetWorkspaceReadiness.mockResolvedValueOnce({
      ok: true,
      data: {
        tenantId: 'tnt_1',
        organizationId: 'org_1',
        brandId: 'brd_1',
        generatedAt: new Date(0).toISOString(),
        paymentMode: 'capture',
        complete: false,
        steps: [],
      },
    });
    mockListEvents.mockResolvedValue(makeEmpty());
    mockListOrders.mockResolvedValue(makeEmpty());

    render(<DashboardView />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/actions are unavailable/i);
    expect(screen.getByRole('button', { name: /retry workspace actions/i })).toBeEnabled();
  });

  it('does not request orders without orders.read', async () => {
    mockCan.mockImplementation((permission) => permission !== 'orders.read');
    mockListEvents.mockResolvedValue(makeEmpty());

    render(<DashboardView />);

    await screen.findByText(/no events yet/i);
    expect(mockListOrders).not.toHaveBeenCalled();
    expect(screen.getByText(/orders access is required/i)).toBeVisible();
    expect(screen.queryByText(/no orders yet/i)).not.toBeInTheDocument();
  });

  it('renders an owner handoff without a remediation link when permission is denied', async () => {
    mockGetWorkspaceReadiness.mockResolvedValueOnce({
      ok: true,
      data: {
        tenantId: 'tnt_1',
        organizationId: 'org_1',
        brandId: 'brd_1',
        generatedAt: new Date(0).toISOString(),
        paymentMode: 'capture',
        complete: false,
        steps: [],
        actionFeed: [
          {
            id: 'workspace:payment_path',
            stepId: 'payment_path',
            severity: 'critical',
            owner: 'finance',
            deadlineAt: null,
            status: 'blocked',
            reasonCodes: ['payment_path_missing', 'permission_required'],
            actionId: null,
            requiredPermission: 'billing.write',
            updatedAt: null,
          },
        ],
      },
    });
    mockListEvents.mockResolvedValue(makeEmpty());
    mockListOrders.mockResolvedValue(makeEmpty());

    render(<DashboardView />);

    expect(await screen.findByText('Finance action required')).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Resolve Prepare the payment path' })).toBeNull();
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
