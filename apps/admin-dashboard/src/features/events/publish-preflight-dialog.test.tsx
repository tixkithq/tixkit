import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';
import type { AdminEventLaunchReadiness, AdminReadinessStep } from '@/lib/api';
import { PublishPreflightDialog } from './publish-preflight-dialog';

function staleStep(
  id: 'checkout_consent' | 'preview_review',
  priority: 'required' | 'recommended',
): AdminReadinessStep {
  return {
    id,
    status: 'incomplete',
    priority,
    reasonCodes: ['acknowledgement_stale'],
    actionId: id === 'checkout_consent' ? 'review_checkout' : 'review_preview',
    requiredPermission: 'events.write',
    updatedAt: null,
    acknowledgedAt: new Date(0).toISOString(),
    acknowledgementValid: false,
  };
}

describe('PublishPreflightDialog readiness copy', () => {
  it('uses contextual stale-acknowledgement copy for blockers and recommendations', () => {
    const checkout = staleStep('checkout_consent', 'required');
    const preview = staleStep('preview_review', 'recommended');
    const readiness: AdminEventLaunchReadiness = {
      tenantId: 'tnt_1',
      organizationId: 'org_1',
      brandId: 'brd_1',
      eventId: 'evt_1',
      eventVersion: 1,
      generatedAt: new Date(0).toISOString(),
      paymentMode: 'capture',
      launchable: false,
      published: false,
      requiredBlockers: [checkout],
      recommendedWarnings: [preview],
      steps: [checkout, preview],
    };

    render(
      <PublishPreflightDialog
        open
        onOpenChange={vi.fn()}
        eventId="evt_1"
        readiness={readiness}
        onPublished={vi.fn()}
      />,
    );

    expect(
      screen.getByText(/Checkout questions or consent language changed after the last review/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Event details, tickets, add-ons, or published content changed/),
    ).toBeInTheDocument();
  });
});
