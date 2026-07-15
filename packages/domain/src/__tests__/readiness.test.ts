import { describe, expect, it } from 'vitest';
import {
  dashboardActionDeadlinePolicies,
  dashboardActionReasonCodes,
  dashboardActionSourceTypes,
  dashboardRemediationIds,
  eventLaunchReadinessStepIds,
  finalizeEventLaunchReadiness,
  humanAcknowledgementStepVersions,
  isHumanAcknowledgementStep,
  permissionAwareStep,
  readinessActionIds,
  readinessReasonCodes,
  readinessReasonCodeStepIds,
  readinessStatuses,
  workspaceReadinessStepIds,
} from '../readiness/index.js';

describe('readiness contracts', () => {
  it('keeps stable identifiers unique', () => {
    for (const values of [
      readinessStatuses,
      workspaceReadinessStepIds,
      eventLaunchReadinessStepIds,
      readinessReasonCodes,
      readinessActionIds,
      dashboardActionSourceTypes,
      dashboardActionReasonCodes,
      dashboardRemediationIds,
      dashboardActionDeadlinePolicies,
    ]) {
      expect(new Set(values).size).toBe(values.length);
    }
  });

  it.each(readinessReasonCodes)('maps reason code %s to at least one stable step', (reasonCode) => {
    expect(readinessReasonCodeStepIds[reasonCode].length).toBeGreaterThan(0);
  });

  it.each([...workspaceReadinessStepIds, ...eventLaunchReadinessStepIds])(
    'has at least one reason-code combination for step %s',
    (stepId) => {
      expect(
        readinessReasonCodes.some((reasonCode) =>
          (readinessReasonCodeStepIds[reasonCode] as readonly string[]).includes(stepId),
        ),
      ).toBe(true);
    },
  );

  it.each(['checkout_consent', 'preview_review'] as const)(
    'recognizes acknowledgement step %s',
    (stepId) => {
      expect(isHumanAcknowledgementStep(stepId)).toBe(true);
      expect(humanAcknowledgementStepVersions[stepId]).toBe(1);
    },
  );

  it('withholds actions the principal cannot perform', () => {
    expect(
      permissionAwareStep(
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
        new Set(['events.read']),
      ),
    ).toMatchObject({
      actionId: null,
      reasonCodes: ['sellable_ticket_missing', 'permission_required'],
    });
  });

  it.each(['complete', 'not_applicable'] as const)(
    'does not block publication for required %s steps',
    (status) => {
      const readiness = finalizeEventLaunchReadiness({
        tenantId: 'ten_1',
        organizationId: 'org_1',
        brandId: 'brd_1',
        eventId: 'evt_1',
        eventVersion: 1,
        generatedAt: new Date(0).toISOString(),
        paymentMode: 'capture',
        published: false,
        steps: [
          {
            id: 'payment_readiness',
            status,
            priority: 'required',
            reasonCodes: [status === 'complete' ? 'payment_ready' : 'payment_not_required'],
            actionId: 'configure_payments',
            requiredPermission: 'billing.write',
            updatedAt: null,
            acknowledgedAt: null,
            acknowledgementValid: null,
          },
        ],
      });
      expect(readiness.launchable).toBe(true);
      expect(readiness.requiredBlockers).toEqual([]);
    },
  );

  it.each(['incomplete', 'blocked'] as const)('blocks required %s steps', (status) => {
    const readiness = finalizeEventLaunchReadiness({
      tenantId: 'ten_1',
      organizationId: 'org_1',
      brandId: 'brd_1',
      eventId: 'evt_1',
      eventVersion: 1,
      generatedAt: new Date(0).toISOString(),
      paymentMode: 'capture',
      published: false,
      steps: [
        {
          id: 'sellable_tickets',
          status,
          priority: 'required',
          reasonCodes: ['sellable_ticket_missing'],
          actionId: 'manage_tickets',
          requiredPermission: 'tickets.write',
          updatedAt: null,
          acknowledgedAt: null,
          acknowledgementValid: null,
        },
      ],
    });
    expect(readiness.launchable).toBe(false);
    expect(readiness.requiredBlockers).toHaveLength(1);
  });
});
