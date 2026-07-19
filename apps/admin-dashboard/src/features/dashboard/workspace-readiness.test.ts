import { describe, expect, it } from 'vitest';
import type { AdminWorkspaceReadiness } from '@/lib/api';
import {
  workspaceReadinessCollapseStorageKey,
  workspaceActionRoute,
  workspaceReadinessViewModel,
} from './workspace-readiness';

function readiness(
  statuses: AdminWorkspaceReadiness['steps'][number]['status'][],
): AdminWorkspaceReadiness {
  const stepIds = ['workspace_selection', 'brand_identity', 'payment_path'] as const;
  return {
    tenantId: 'tnt_test',
    organizationId: 'org_test',
    brandId: 'brd_test',
    generatedAt: '2026-07-10T12:00:00.000Z',
    paymentMode: 'capture',
    complete: statuses.every((status) => status === 'complete' || status === 'not_applicable'),
    actionFeed: [],
    steps: statuses.map((status, index) => ({
      id: stepIds[index]!,
      status,
      priority: index === 2 ? 'recommended' : 'required',
      reasonCodes: status === 'blocked' ? ['permission_required'] : [],
      actionId: status === 'complete' ? null : 'configure_brand',
      requiredPermission: status === 'blocked' ? 'settings.write' : null,
      updatedAt: null,
      acknowledgedAt: null,
      acknowledgementValid: null,
    })),
  };
}

describe('workspaceReadinessViewModel', () => {
  it('routes only to settings surfaces that can resolve the readiness action', () => {
    expect(workspaceActionRoute('select_workspace')).toBe('/settings/workspace');
    expect(workspaceActionRoute('configure_brand')).toBe('/settings/branding');
    expect(workspaceActionRoute('configure_payments')).toBe('/settings/payments');
    expect(workspaceActionRoute('manage_team')).toBe('/settings/members');
    expect(workspaceActionRoute('configure_legal')).toBe('/settings/branding');
    expect(workspaceActionRoute('configure_sender')).toBeUndefined();
    expect(workspaceActionRoute(null)).toBeUndefined();
  });

  it('scopes collapse preferences to the organization and brand', () => {
    expect(workspaceReadinessCollapseStorageKey('org_1', 'brd_1')).not.toBe(
      workspaceReadinessCollapseStorageKey('org_1', 'brd_2'),
    );
  });
  it('counts complete and not-applicable steps and selects the next required action', () => {
    const result = workspaceReadinessViewModel(
      readiness(['complete', 'incomplete', 'not_applicable']),
    );
    expect(result).toMatchObject({
      completeCount: 2,
      totalCount: 3,
      percent: 67,
    });
    expect(result.nextStep?.status).toBe('incomplete');
  });

  it('prioritizes blocked required steps over recommended work', () => {
    expect(
      workspaceReadinessViewModel(readiness(['complete', 'blocked', 'incomplete'])).nextStep
        ?.status,
    ).toBe('blocked');
  });

  it('has no next step when every step is complete or not applicable', () => {
    expect(
      workspaceReadinessViewModel(readiness(['complete', 'not_applicable'])).nextStep,
    ).toBeUndefined();
  });
});
