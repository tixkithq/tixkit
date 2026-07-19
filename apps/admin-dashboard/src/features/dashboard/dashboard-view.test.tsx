import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

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
const defaultDashboardFeed = {
  ok: true as const,
  data: {
    tenantId: 'tnt_1',
    organizationId: 'org_1',
    brandId: 'brd_1',
    evaluationVersion: 1 as const,
    generatedAt: '2027-01-01T00:00:00.000Z',
    expiresAt: '2027-01-01T00:05:00.000Z',
    nextCursor: null,
    actions: [
      {
        id: 'event:evt_1:unpublished',
        sourceType: 'event_launch' as const,
        resource: {
          type: 'event' as const,
          organizationId: 'org_1',
          brandId: 'brd_1',
          eventId: 'evt_1',
          eventVersion: 1,
          eventTitle: 'Test Event',
        },
        severity: 'critical' as const,
        owner: 'organizer' as const,
        deadlineAt: '2027-01-01T00:00:00.000Z',
        deadlinePolicy: 'event_start' as const,
        overdue: false,
        occurrenceCount: 1,
        reasonCode: 'event_unpublished' as const,
        remediation: {
          id: 'continue_event_setup' as const,
          readinessActionId: 'view_event' as const,
          requiredPermission: 'events.write' as const,
          canRemediate: true,
          availability: 'available' as const,
        },
        staleness: {
          state: 'current' as const,
          consistency: 'repeatable_read' as const,
          evaluatedAt: '2027-01-01T00:00:00.000Z',
          expiresAt: '2027-01-01T00:05:00.000Z',
          sourceUpdatedAt: '2026-12-31T00:00:00.000Z',
          sourceVersion: 1,
          evidenceRevision: 'a'.repeat(64),
        },
      },
    ],
  },
};
const mockGetDashboardActions = vi.fn().mockResolvedValue(defaultDashboardFeed);
const mockCan = vi.fn<(permission: string) => boolean>(() => true);
const mockPermissionState = {
  loading: false,
  error: null as Error | null,
  retry: vi.fn(),
};

vi.mock('@/lib/api', () => ({
  adminApi: {
    listEvents: (...args: unknown[]) => mockListEvents(...args),
    listOrders: (...args: unknown[]) => mockListOrders(...args),
    getWorkspaceReadiness: (...args: unknown[]) => mockGetWorkspaceReadiness(...args),
    getDashboardActions: (...args: unknown[]) => mockGetDashboardActions(...args),
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
  usePermissions: () => ({ can: mockCan, ...mockPermissionState }),
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe('DashboardView error states', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockCan.mockReturnValue(true);
    mockPermissionState.loading = false;
    mockPermissionState.error = null;
    mockPermissionState.retry.mockReset();
  });

  it('renders the role-owned workspace action and finance remediation', async () => {
    mockListEvents.mockResolvedValue(makeEmpty());
    mockListOrders.mockResolvedValue(makeEmpty());

    render(<DashboardView />);

    expect(await screen.findByText(/Critical · Owner: Finance/)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Resolve Prepare the payment path' })).toHaveAttribute(
      'href',
      '/settings/payments',
    );
  });

  it('hands a workspace action to its owner when the viewer lacks remediation permission', async () => {
    mockCan.mockImplementation((permission) => permission !== 'billing.write');
    mockListEvents.mockResolvedValue(makeEmpty());
    mockListOrders.mockResolvedValue(makeEmpty());

    render(<DashboardView />);

    expect(await screen.findByText('Finance action required')).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Resolve Prepare the payment path' })).toBeNull();
  });

  it('requires settings access before linking workspace selection to its guarded destination', async () => {
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
            id: 'workspace:workspace_selection',
            stepId: 'workspace_selection',
            severity: 'critical',
            owner: 'organizer',
            deadlineAt: null,
            status: 'blocked',
            reasonCodes: ['organization_inactive'],
            actionId: 'select_workspace',
            requiredPermission: 'settings.write',
            updatedAt: null,
          },
        ],
      },
    });
    mockCan.mockImplementation((permission) => permission !== 'settings.write');
    mockListEvents.mockResolvedValue(makeEmpty());
    mockListOrders.mockResolvedValue(makeEmpty());
    const view = render(<DashboardView />);

    expect(await screen.findByText('Organizer action required')).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Resolve Confirm workspace context' })).toBeNull();

    mockCan.mockReturnValue(true);
    view.rerender(<DashboardView />);
    expect(screen.getByRole('link', { name: 'Resolve Confirm workspace context' })).toHaveAttribute(
      'href',
      '/settings/workspace',
    );
  });

  it('does not report an owner handoff while workspace action access is loading', async () => {
    mockPermissionState.loading = true;
    mockListEvents.mockResolvedValue(makeEmpty());
    mockListOrders.mockResolvedValue(makeEmpty());

    render(<DashboardView />);

    expect(await screen.findByText('Checking access…')).toBeVisible();
    expect(screen.queryByText('Finance action required')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Resolve Prepare the payment path' })).toBeNull();
  });

  it('distinguishes unavailable workspace action access from permission denial', async () => {
    mockPermissionState.error = new Error('permission service unavailable');
    mockListEvents.mockResolvedValue(makeEmpty());
    mockListOrders.mockResolvedValue(makeEmpty());

    const view = render(<DashboardView />);

    expect(
      (await screen.findByText('Action access could not be verified')).closest('[role="alert"]'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Finance action required')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Resolve Prepare the payment path' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry action access' }));
    expect(mockPermissionState.retry).toHaveBeenCalledTimes(1);

    mockPermissionState.error = null;
    mockPermissionState.loading = true;
    view.rerender(<DashboardView />);
    expect(screen.getByText('Checking access…')).toBeVisible();

    mockPermissionState.loading = false;
    view.rerender(<DashboardView />);
    expect(screen.getByRole('link', { name: 'Resolve Prepare the payment path' })).toBeVisible();
  });

  it('retries a failed workspace readiness request without hiding other dashboard data', async () => {
    mockGetWorkspaceReadiness
      .mockResolvedValueOnce(makeError(503, 'UNAVAILABLE', 'Workspace readiness is unavailable.'))
      .mockResolvedValueOnce({
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
    mockListEvents.mockResolvedValue(makeEmpty());
    mockListOrders.mockResolvedValue(makeEmpty());

    render(<DashboardView />);

    expect(await screen.findByText('Workspace readiness is unavailable.')).toBeVisible();
    expect(screen.getByText(/No events yet/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(
      await screen.findByRole('link', { name: 'Resolve Prepare the payment path' }),
    ).toHaveAttribute('href', '/settings/payments');
    expect(mockGetWorkspaceReadiness).toHaveBeenCalledTimes(2);
  });

  it('starts a completed workspace checklist collapsed while keeping it inspectable', async () => {
    mockGetWorkspaceReadiness.mockResolvedValueOnce({
      ok: true,
      data: {
        tenantId: 'tnt_1',
        organizationId: 'org_1',
        brandId: 'brd_1',
        generatedAt: new Date(0).toISOString(),
        paymentMode: 'capture',
        complete: true,
        steps: [
          {
            id: 'workspace_selection',
            status: 'complete',
            priority: 'required',
            reasonCodes: ['workspace_selected'],
            actionId: null,
            requiredPermission: null,
            updatedAt: null,
            acknowledgedAt: null,
            acknowledgementValid: null,
          },
        ],
        actionFeed: [],
      },
    });
    mockListEvents.mockResolvedValue(makeEmpty());
    mockListOrders.mockResolvedValue(makeEmpty());

    render(<DashboardView />);

    expect(await screen.findByText('Workspace setup complete')).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Expand' })).toHaveAttribute(
        'aria-expanded',
        'false',
      ),
    );
    expect(screen.queryByRole('list', { name: 'Prioritized workspace actions' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Expand' }));
    expect(screen.getByRole('list', { name: 'Workspace readiness details' })).toBeVisible();
    expect(screen.getByText('Confirm workspace context')).toBeVisible();
    expect(screen.getByText('Workspace context is selected.')).toBeVisible();
    expect(screen.getByText('Complete')).toBeVisible();
  });

  it('links legal readiness to its editable brand settings surface', async () => {
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
            id: 'workspace:legal_configuration',
            stepId: 'legal_configuration',
            severity: 'high',
            owner: 'support',
            deadlineAt: null,
            status: 'incomplete',
            reasonCodes: ['legal_configuration_missing'],
            actionId: 'configure_legal',
            requiredPermission: 'settings.write',
            updatedAt: null,
          },
        ],
      },
    });
    mockListEvents.mockResolvedValue(makeEmpty());
    mockListOrders.mockResolvedValue(makeEmpty());

    render(<DashboardView />);

    expect(
      await screen.findByRole('link', { name: 'Resolve Configure legal settings' }),
    ).toHaveAttribute('href', '/settings/branding');
  });

  it('hands sender verification to marketing without linking to an unrelated settings page', async () => {
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
            id: 'workspace:sender_identity',
            stepId: 'sender_identity',
            severity: 'medium',
            owner: 'marketing',
            deadlineAt: null,
            status: 'blocked',
            reasonCodes: ['sender_identity_missing'],
            actionId: 'configure_sender',
            requiredPermission: 'messages.write',
            updatedAt: null,
          },
        ],
      },
    });
    mockListEvents.mockResolvedValue(makeEmpty());
    mockListOrders.mockResolvedValue(makeEmpty());

    render(<DashboardView />);

    expect(await screen.findByText('Marketing action required')).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Resolve Verify sender identity' })).toBeNull();
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

    expect(await screen.findByText(/Finish launch and publish this event/)).toBeVisible();
    expect(screen.getByLabelText('critical action owned by Organizer')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Continue launch for Test Event' })).toHaveAttribute(
      'href',
      '/events/evt_1',
    );
  });

  it('fails closed with an actionable retry when an incomplete mixed-version response has no feed', async () => {
    mockGetDashboardActions.mockResolvedValueOnce({
      ok: true,
      data: {
        tenantId: 'tnt_1',
        organizationId: 'org_1',
        brandId: 'brd_1',
        evaluationVersion: 1,
        generatedAt: '2027-01-01T00:00:00.000Z',
        expiresAt: '2027-01-01T00:05:00.000Z',
        nextCursor: null,
      },
    });
    mockListEvents.mockResolvedValue(makeEmpty());
    mockListOrders.mockResolvedValue(makeEmpty());

    render(<DashboardView />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/actions are unavailable/i);
    expect(screen.getByRole('button', { name: /retry dashboard actions/i })).toBeEnabled();
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
    mockGetDashboardActions.mockResolvedValueOnce({
      ...defaultDashboardFeed,
      data: {
        ...defaultDashboardFeed.data,
        actions: [
          {
            ...defaultDashboardFeed.data.actions[0]!,
            remediation: {
              ...defaultDashboardFeed.data.actions[0]!.remediation,
              canRemediate: false,
              availability: 'permission_required' as const,
            },
          },
        ],
      },
    });
    mockListEvents.mockResolvedValue(makeEmpty());
    mockListOrders.mockResolvedValue(makeEmpty());

    render(<DashboardView />);

    expect(await screen.findByText('Organizer permission required')).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Continue launch for Test Event' })).toBeNull();
  });

  it('loads, deduplicates, and renders the next page from the same snapshot', async () => {
    mockGetDashboardActions
      .mockResolvedValueOnce({
        ...defaultDashboardFeed,
        data: { ...defaultDashboardFeed.data, nextCursor: 'cursor_2' },
      })
      .mockResolvedValueOnce({
        ...defaultDashboardFeed,
        data: {
          ...defaultDashboardFeed.data,
          actions: [
            defaultDashboardFeed.data.actions[0],
            {
              ...defaultDashboardFeed.data.actions[0],
              id: 'event:evt_2:unpublished',
              resource: {
                ...defaultDashboardFeed.data.actions[0]!.resource,
                eventId: 'evt_2',
                eventTitle: 'Second Event',
              },
            },
          ],
        },
      });
    mockListEvents.mockResolvedValue(makeEmpty());
    mockListOrders.mockResolvedValue(makeEmpty());

    render(<DashboardView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Load more actions' }));

    expect(await screen.findByText('Second Event')).toBeVisible();
    expect(screen.getAllByText('Test Event')).toHaveLength(1);
    expect(mockGetDashboardActions).toHaveBeenLastCalledWith('org_1', 'brd_1', {
      limit: 20,
      cursor: 'cursor_2',
    });
  });

  it('fails closed when a loaded page belongs to a different snapshot', async () => {
    mockGetDashboardActions
      .mockResolvedValueOnce({
        ...defaultDashboardFeed,
        data: { ...defaultDashboardFeed.data, nextCursor: 'cursor_2' },
      })
      .mockResolvedValueOnce({
        ...defaultDashboardFeed,
        data: {
          ...defaultDashboardFeed.data,
          generatedAt: '2027-01-01T00:01:00.000Z',
          actions: [],
        },
      });
    mockListEvents.mockResolvedValue(makeEmpty());
    mockListOrders.mockResolvedValue(makeEmpty());

    render(<DashboardView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Load more actions' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/snapshot changed/i);
    expect(screen.queryByRole('link', { name: 'Continue launch for Test Event' })).toBeNull();
  });

  it('disables pagination and asks for refresh when the snapshot is expired', async () => {
    mockGetDashboardActions.mockResolvedValueOnce({
      ...defaultDashboardFeed,
      data: {
        ...defaultDashboardFeed.data,
        generatedAt: '2020-01-01T00:00:00.000Z',
        expiresAt: '2020-01-01T00:05:00.000Z',
        nextCursor: 'expired_cursor',
      },
    });
    mockListEvents.mockResolvedValue(makeEmpty());
    mockListOrders.mockResolvedValue(makeEmpty());

    render(<DashboardView />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/snapshot expired/i);
    expect(screen.queryByRole('button', { name: 'Load more actions' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Continue launch for Test Event' })).toBeNull();
  });

  it('ignores an old pagination response after a refreshed snapshot arrives', async () => {
    const oldPage = deferred<typeof defaultDashboardFeed>();
    const freshFeed = {
      ...defaultDashboardFeed,
      data: {
        ...defaultDashboardFeed.data,
        generatedAt: '2027-01-01T00:01:00.000Z',
        expiresAt: '2027-01-01T00:06:00.000Z',
        actions: [
          {
            ...defaultDashboardFeed.data.actions[0]!,
            id: 'event:evt_fresh:unpublished',
            resource: {
              ...defaultDashboardFeed.data.actions[0]!.resource,
              eventId: 'evt_fresh',
              eventTitle: 'Fresh Event',
            },
          },
        ],
      },
    };
    mockGetDashboardActions
      .mockResolvedValueOnce({
        ...defaultDashboardFeed,
        data: { ...defaultDashboardFeed.data, nextCursor: 'cursor_2' },
      })
      .mockImplementationOnce(() => oldPage.promise)
      .mockResolvedValueOnce(freshFeed);
    mockListEvents.mockResolvedValue(makeEmpty());
    mockListOrders.mockResolvedValue(makeEmpty());

    render(<DashboardView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Load more actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('Fresh Event')).toBeVisible();

    await act(async () => {
      oldPage.resolve({
        ...defaultDashboardFeed,
        data: {
          ...defaultDashboardFeed.data,
          actions: [
            {
              ...defaultDashboardFeed.data.actions[0]!,
              id: 'event:evt_stale:unpublished',
              resource: {
                ...defaultDashboardFeed.data.actions[0]!.resource,
                eventId: 'evt_stale',
                eventTitle: 'Stale Event',
              },
            },
          ],
        },
      });
      await Promise.resolve();
    });

    expect(screen.queryByText('Stale Event')).toBeNull();
    expect(screen.getByText('Fresh Event')).toBeVisible();
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
