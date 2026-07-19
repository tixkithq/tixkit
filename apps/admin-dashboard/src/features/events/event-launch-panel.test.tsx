import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventLaunchPanel, eventReadinessReasonText } from './event-launch-panel';
import type { AdminEventLaunchReadiness } from '@/lib/api';

const usePermissionsMock = vi.hoisted(() => vi.fn());

vi.mock('@/context/permission-provider', () => ({
  usePermissions: usePermissionsMock,
}));

function readiness(): AdminEventLaunchReadiness {
  return {
    tenantId: 'tnt_1',
    organizationId: 'org_1',
    brandId: 'brd_1',
    eventId: 'evt_1',
    eventVersion: 1,
    generatedAt: new Date(0).toISOString(),
    paymentMode: 'capture',
    published: false,
    launchable: false,
    requiredBlockers: [],
    recommendedWarnings: [],
    steps: [
      {
        id: 'basics_schedule',
        status: 'complete',
        priority: 'required',
        reasonCodes: ['event_basics_valid'],
        actionId: 'edit_event_basics',
        requiredPermission: 'events.write',
        updatedAt: null,
        acknowledgedAt: null,
        acknowledgementValid: null,
      },
      {
        id: 'sellable_tickets',
        status: 'incomplete',
        priority: 'required',
        reasonCodes: ['sellable_ticket_missing'],
        actionId: 'manage_tickets',
        requiredPermission: 'tickets.write',
        updatedAt: null,
        acknowledgedAt: null,
        acknowledgementValid: null,
      },
      {
        id: 'payment_readiness',
        status: 'blocked',
        priority: 'required',
        reasonCodes: ['payment_capture_mode_paid_unsupported', 'permission_required'],
        actionId: null,
        requiredPermission: 'billing.write',
        updatedAt: null,
        acknowledgedAt: null,
        acknowledgementValid: null,
      },
    ],
  };
}

describe('EventLaunchPanel', () => {
  beforeEach(() => {
    usePermissionsMock.mockReturnValue({
      can: vi.fn(() => true),
      loading: false,
      error: null,
    });
  });

  it('renders progress, a permission-aware next action, and blocked remediation', () => {
    render(<EventLaunchPanel eventId="evt_1" readiness={readiness()} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('value', '33');
    expect(screen.getByRole('link', { name: 'Continue setup' })).toHaveAttribute(
      'href',
      '/events/evt_1/tickets',
    );
    expect(screen.getByText(/paid events cannot launch/i)).toBeInTheDocument();
    expect(
      screen.getByText(/A teammate with the required permission must complete this step/),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Sellable tickets' })).toHaveAttribute(
      'href',
      '/events/evt_1/tickets',
    );
  });

  it('skips denied remediation and selects the next permitted setup action', () => {
    const value = readiness();
    value.steps.splice(2, 0, {
      id: 'preview_review',
      status: 'incomplete',
      priority: 'required',
      reasonCodes: ['preview_review_required'],
      actionId: 'review_preview',
      requiredPermission: 'events.write',
      updatedAt: null,
      acknowledgedAt: null,
      acknowledgementValid: null,
    });
    usePermissionsMock.mockReturnValue({
      can: vi.fn((permission: string) => permission === 'events.write'),
      loading: false,
      error: null,
    });

    render(<EventLaunchPanel eventId="evt_1" readiness={value} />);

    expect(screen.getByRole('link', { name: 'Continue setup' })).toHaveAttribute(
      'href',
      '/events/evt_1/preview',
    );
    expect(screen.queryByRole('link', { name: 'Open Sellable tickets' })).not.toBeInTheDocument();
    expect(
      screen.getByText('A teammate with the required permission must complete this action.'),
    ).toBeInTheDocument();
  });

  it('suppresses every mutating remediation when all required permissions are denied', () => {
    usePermissionsMock.mockReturnValue({
      can: vi.fn(() => false),
      loading: false,
      error: null,
    });

    render(<EventLaunchPanel eventId="evt_1" readiness={readiness()} />);

    expect(screen.queryByRole('link', { name: 'Continue setup' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^Open / })).not.toBeInTheDocument();
    expect(
      screen.getByText('A teammate with the required permission must complete this action.'),
    ).toBeInTheDocument();
  });

  it('announces unresolved and failed access checks while remediation stays fail-closed', () => {
    usePermissionsMock.mockReturnValue({
      can: vi.fn(() => false),
      loading: true,
      error: null,
    });

    const loadingView = render(<EventLaunchPanel eventId="evt_1" readiness={readiness()} />);

    expect(screen.getByText('Checking access for this action…')).toHaveAttribute('role', 'status');
    expect(screen.queryByRole('link', { name: 'Continue setup' })).not.toBeInTheDocument();
    loadingView.unmount();

    usePermissionsMock.mockReturnValue({
      can: vi.fn(() => false),
      loading: false,
      error: 'permission service unavailable',
    });
    render(<EventLaunchPanel eventId="evt_1" readiness={readiness()} />);

    expect(screen.getByText('Access could not be verified for this action.')).toHaveAttribute(
      'role',
      'alert',
    );
    expect(screen.queryByRole('link', { name: 'Continue setup' })).not.toBeInTheDocument();
  });

  it('keeps remediation without a permission requirement available during permission failure', () => {
    const value = readiness();
    value.steps[1] = { ...value.steps[1]!, requiredPermission: null };
    usePermissionsMock.mockReturnValue({
      can: vi.fn(() => false),
      loading: false,
      error: 'permission service unavailable',
    });

    render(<EventLaunchPanel eventId="evt_1" readiness={value} />);

    expect(screen.getByRole('link', { name: 'Continue setup' })).toHaveAttribute(
      'href',
      '/events/evt_1/tickets',
    );
    expect(screen.getByRole('link', { name: 'Open Sellable tickets' })).toBeInTheDocument();
  });

  it.each([
    [
      'checkout_consent',
      'review_checkout',
      'Checkout questions or consent language changed after the last review.',
    ],
    [
      'preview_review',
      'review_preview',
      'Event details, tickets, add-ons, or published content changed after the last preview review.',
    ],
  ] as const)('explains what invalidated a stale %s acknowledgement', (id, actionId, copy) => {
    const value = readiness();
    value.steps = [
      {
        id,
        status: 'incomplete',
        priority: 'recommended',
        reasonCodes: ['acknowledgement_stale'],
        actionId,
        requiredPermission: 'events.write',
        updatedAt: null,
        acknowledgedAt: new Date(0).toISOString(),
        acknowledgementValid: false,
      },
    ];

    render(<EventLaunchPanel eventId="evt_1" readiness={value} />);

    expect(screen.getByText(new RegExp(copy))).toBeInTheDocument();
  });

  it('uses the safe fallback for a malformed prototype-key reason', () => {
    expect(eventReadinessReasonText(readiness().steps[1]!, 'constructor' as never)).toBe(
      'This launch check needs attention. Open its settings to review and correct the current configuration.',
    );
  });
});
