import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it } from 'vitest';
import { EventLaunchPanel } from './event-launch-panel';
import type { AdminEventLaunchReadiness } from '@/lib/api';

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
  it('renders progress, a permission-aware next action, and blocked remediation', () => {
    render(<EventLaunchPanel eventId="evt_1" readiness={readiness()} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('value', '33');
    expect(screen.getByRole('link', { name: 'Continue setup' })).toHaveAttribute(
      'href',
      '/events/evt_1/tickets',
    );
    expect(screen.getByText(/paid events cannot launch/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Sellable tickets' })).toHaveAttribute(
      'href',
      '/events/evt_1/tickets',
    );
  });
});
