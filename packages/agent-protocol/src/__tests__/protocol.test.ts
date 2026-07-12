import { describe, expect, it } from 'vitest';
import {
  AGENT_PROTOCOL_VERSION,
  AgentProtocolValidationError,
  agentActionDigest,
  authorizeAgentAction,
  buildAgentPlan,
  canonicalAgentJson,
  consumeApprovedAgentAction,
  validateAgentDelegation,
  validateAgentPrincipal,
  type AgentAction,
  type AgentApproval,
  type AgentAuthorizationInput,
  type AgentDelegationGrant,
  type AgentPrincipal,
  type CampaignSendPayload,
} from '../protocol.js';

const now = '2026-07-12T12:00:00.000Z';
const principal: AgentPrincipal = {
  id: 'agent_primary',
  kind: 'third_party',
  tenantId: 'tenant_primary',
  sponsorPrincipalId: 'user_sponsor',
  capabilities: ['events.read', 'events.execute'],
  maximumAutonomy: 'execute_with_approval',
  protocolVersion: AGENT_PROTOCOL_VERSION,
  state: 'active',
  registeredAt: '2026-07-01T00:00:00.000Z',
};
const delegation: AgentDelegationGrant = {
  id: 'delegation_primary',
  tenantId: 'tenant_primary',
  agentPrincipalId: 'agent_primary',
  sponsorPrincipalId: 'user_sponsor',
  capabilities: ['events.read', 'events.execute'],
  resourceScopes: ['event:evt_primary'],
  permissionSnapshot: ['events:read', 'events:publish'],
  issuedAt: '2026-07-01T00:00:00.000Z',
  expiresAt: '2026-08-01T00:00:00.000Z',
};
function action(overrides: Partial<AgentAction> = {}): AgentAction {
  return {
    id: 'action_primary',
    protocolVersion: AGENT_PROTOCOL_VERSION,
    agentPrincipalId: 'agent_primary',
    sponsorPrincipalId: 'user_sponsor',
    delegationGrantId: 'delegation_primary',
    kind: 'event.publish',
    autonomy: 'execute_with_approval',
    target: {
      tenantId: 'tenant_primary',
      resourceType: 'event',
      resourceId: 'evt_primary',
      resourceVersion: 7,
      apiOperation: 'events.publish',
    },
    payload: { publication: { visibility: 'public' } },
    idempotencyKey: 'agent-action-2026-07-12-0001',
    expectedPolicyVersion: 3,
    preparedAt: now,
    ...overrides,
  };
}
function approval(actionDigest: string): AgentApproval {
  return {
    id: 'approval_primary',
    tenantId: 'tenant_primary',
    actionDigest,
    approverPrincipalId: 'user_approver',
    approverPermissionSnapshot: ['events:publish'],
    policyVersion: 3,
    approvedAt: now,
    expiresAt: '2026-07-12T12:05:00.000Z',
  };
}
function authorization(item: AgentAction = action()): AgentAuthorizationInput {
  const digest = agentActionDigest(item);
  return {
    principal,
    delegation,
    action: item,
    actionDigest: digest,
    sponsorPermissions: ['events:read', 'events:publish'],
    tenantAllowedActions: ['event.read', 'event.publish'],
    currentResourceVersion: 7,
    currentPolicyVersion: 3,
    now,
    approval: item.kind === 'event.read' ? undefined : approval(digest),
  };
}

describe('agent protocol', () => {
  it('rejects invalid principals and delegations that exceed principal authority', () => {
    expect(() => validateAgentPrincipal(principal)).not.toThrow();
    expect(() => validateAgentPrincipal({ ...principal,
      capabilities: ['events.read', 'events.read'] })).toThrow(AgentProtocolValidationError);
    expect(() => validateAgentDelegation(delegation, principal)).not.toThrow();
    expect(() => validateAgentDelegation({ ...delegation,
      capabilities: ['refunds.execute'] }, principal)).toThrow(AgentProtocolValidationError);
    expect(() => validateAgentDelegation({ ...delegation,
      resourceScopes: ['*:*'] }, principal)).toThrow(AgentProtocolValidationError);
    expect(() => validateAgentDelegation({ ...delegation,
      expiresAt: delegation.issuedAt }, principal)).toThrow(AgentProtocolValidationError);
  });
  it('canonicalizes object ordering and binds every material action field', () => {
    expect(canonicalAgentJson({ z: 1, nested: { b: 2, a: 1 }, a: 3 })).toBe(
      '{"a":3,"nested":{"a":1,"b":2},"z":1}',
    );
    const first = action({ payload: { b: 2, a: 1 } });
    const reordered = action({ payload: { a: 1, b: 2 } });
    expect(agentActionDigest(first)).toBe(agentActionDigest(reordered));
    expect(
      agentActionDigest(action({ target: { ...action().target, resourceVersion: 8 } })),
    ).not.toBe(agentActionDigest(action()));
    expect(
      agentActionDigest(action({ payload: { publication: { visibility: 'private' } } })),
    ).not.toBe(agentActionDigest(action()));
  });

  it('authorizes only the complete permission intersection with fresh exact approval', () => {
    expect(authorizeAgentAction(authorization())).toMatchObject({
      allowed: true,
      consequential: true,
      requiresApproval: true,
      reasons: [],
    });
  });

  it('denies approval substitution, mutation, consumption, revocation and expiry', () => {
    const base = authorization();
    expect(authorizeAgentAction({ ...base, approval: approval('f'.repeat(64)) }).reasons).toContain(
      'approval_invalid',
    );
    expect(
      authorizeAgentAction({ ...base, approval: { ...base.approval!, consumedAt: now } }).reasons,
    ).toContain('approval_consumed');
    expect(
      authorizeAgentAction({ ...base, approval: { ...base.approval!, revokedAt: now } }).reasons,
    ).toContain('approval_revoked');
    expect(authorizeAgentAction({ ...base, now: '2026-07-12T12:05:00.000Z' }).reasons).toContain(
      'approval_expired',
    );
    const changed = action({ payload: { publication: { visibility: 'private' } } });
    expect(authorizeAgentAction({ ...base, action: changed }).reasons).toContain(
      'approval_invalid',
    );
  });

  it('fails closed for tenant, sponsor, capability, permission, scope, version and policy denial', () => {
    const base = authorization();
    const decision = authorizeAgentAction({
      ...base,
      principal: { ...principal, sponsorPrincipalId: 'user_other', capabilities: [] },
      delegation: {
        ...delegation,
        tenantId: 'tenant_other',
        resourceScopes: [],
        permissionSnapshot: [],
      },
      sponsorPermissions: [],
      tenantAllowedActions: [],
      currentResourceVersion: 8,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toEqual(
      expect.arrayContaining([
        'sponsor_mismatch',
        'tenant_mismatch',
        'capability_denied',
        'sponsor_permission_denied',
        'resource_scope_denied',
        'resource_version_changed',
        'tenant_policy_denied',
      ]),
    );
  });

  it('denies action attribution to another agent and invalidates approval on policy change', () => {
    const base = authorization();
    expect(
      authorizeAgentAction({ ...base, action: { ...base.action, agentPrincipalId: 'agent_other' } })
        .reasons,
    ).toContain('agent_identity_mismatch');
    expect(authorizeAgentAction({ ...base, currentPolicyVersion: 4 }).reasons).toContain(
      'policy_version_changed',
    );
  });

  it('permits a scoped read without manufacturing approval', () => {
    const read = action({
      kind: 'event.read',
      autonomy: 'read',
      payload: {},
      target: { ...action().target, apiOperation: 'events.get' },
    });
    expect(authorizeAgentAction(authorization(read))).toMatchObject({
      allowed: true,
      consequential: false,
      requiresApproval: false,
    });
  });

  it('requires consequential actions to use execute-with-approval autonomy', () => {
    expect(() => agentActionDigest(action({ autonomy: 'prepare' }))).toThrow(
      AgentProtocolValidationError,
    );
  });

  it('rejects direct database/provider operations and non-JSON or ambiguous numeric payloads', () => {
    expect(() =>
      agentActionDigest(
        action({ target: { ...action().target, apiOperation: 'database.update' } }),
      ),
    ).toThrow(AgentProtocolValidationError);
    expect(() => agentActionDigest(action({ payload: { amount: 1.5 } }))).toThrow(
      AgentProtocolValidationError,
    );
    expect(() => agentActionDigest(action({ payload: { secret: new Date() } as never }))).toThrow(
      AgentProtocolValidationError,
    );
  });

  it('binds action kind to protocol-owned capability, permission, resource and API operation', () => {
    expect(() =>
      agentActionDigest(
        action({ target: { ...action().target, apiOperation: 'orders.purchase' } }),
      ),
    ).toThrow(AgentProtocolValidationError);
    expect(() =>
      agentActionDigest(action({ target: { ...action().target, resourceType: 'order' } })),
    ).toThrow(AgentProtocolValidationError);
  });

  it('binds campaign approval to content, audience, exclusions, cost and compliance', () => {
    const campaign: CampaignSendPayload = {
      channel: 'email',
      contentVersion: 'content_v7',
      audienceSnapshotSha256: 'a'.repeat(64),
      exclusionSnapshotSha256: 'b'.repeat(64),
      complianceResultSha256: 'c'.repeat(64),
      scheduledAt: '2026-07-13T12:00:00.000Z',
      estimatedCostMinor: 2500,
      currency: 'USD',
    };
    const campaignAction = action({
      kind: 'campaign.send',
      payload: campaign,
      target: { ...action().target, apiOperation: 'campaigns.send' },
    });
    expect(
      agentActionDigest({ ...campaignAction, payload: { ...campaign, estimatedCostMinor: 2501 } }),
    ).not.toBe(agentActionDigest(campaignAction));
    expect(
      agentActionDigest({
        ...campaignAction,
        payload: { ...campaign, audienceSnapshotSha256: 'd'.repeat(64) },
      }),
    ).not.toBe(agentActionDigest(campaignAction));
    expect(() => agentActionDigest({ ...campaignAction, payload: {} })).toThrow(
      AgentProtocolValidationError,
    );
    expect(() =>
      agentActionDigest({ ...campaignAction, payload: { ...campaign, recipientIds: ['buyer_1'] } }),
    ).toThrow(AgentProtocolValidationError);
  });

  it('atomically consumes approval so concurrent execution has one winner', async () => {
    const base = authorization();
    let consumed = false;
    const approvalStore = {
      async consume(input: { consumedAt: string }) {
        if (consumed) return null;
        consumed = true;
        return { ...base.approval!, consumedAt: input.consumedAt };
      },
    };
    const results = await Promise.all([
      consumeApprovedAgentAction({ ...base, approvalStore, executionId: 'execution_primary' }),
      consumeApprovedAgentAction({ ...base, approvalStore, executionId: 'execution_secondary' }),
    ]);
    expect(results.filter(({ decision }) => decision.allowed)).toHaveLength(1);
    expect(results.find(({ decision }) => !decision.allowed)?.decision.reasons).toContain(
      'approval_consumed',
    );
  });

  it('rejects an authoritative consumed record that differs from the caller snapshot', async () => {
    const base = authorization();
    const result = await consumeApprovedAgentAction({
      ...base,
      executionId: 'execution_malicious',
      approvalStore: {
        async consume(input) {
          return {
            ...base.approval!,
            approverPermissionSnapshot: [],
            consumedAt: input.consumedAt,
          };
        },
      },
    });
    expect(result.decision).toMatchObject({ allowed: false, reasons: ['approval_invalid'] });
  });

  it('creates an immutable plan digest over ordered action digests', () => {
    const first = agentActionDigest(action());
    const second = agentActionDigest(
      action({ id: 'action_secondary', idempotencyKey: 'agent-action-2026-07-12-0002' }),
    );
    const plan = buildAgentPlan({
      id: 'plan_primary',
      protocolVersion: AGENT_PROTOCOL_VERSION,
      agentPrincipalId: 'agent_primary',
      tenantId: 'tenant_primary',
      purpose: 'Publish event',
      actionDigests: [first, second],
      createdAt: now,
      expiresAt: '2026-07-12T12:10:00.000Z',
    });
    expect(plan.planSha256).toMatch(/^[a-f0-9]{64}$/u);
    const { planSha256: _planSha256, ...planInput } = plan;
    expect(buildAgentPlan({ ...planInput, actionDigests: [second, first] }).planSha256).not.toBe(
      plan.planSha256,
    );
  });
});
