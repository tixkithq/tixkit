import { describe, expect, it } from 'vitest';
import {
  AGENT_PROTOCOL_VERSION,
  DurableAgentExecutionService,
  AgentExecutionConflictError,
  agentActionDigest,
  type AgentAction,
  type AgentApproval,
  type AgentAuditRecord,
  type AgentAuthorizationInput,
  type AgentExecution,
  type AgentExecutionStore,
} from '../index.js';

const now = new Date('2026-07-12T12:00:00.000Z');
const action: AgentAction = {
  id: 'action_primary', protocolVersion: AGENT_PROTOCOL_VERSION,
  agentPrincipalId: 'agent_primary', sponsorPrincipalId: 'user_sponsor',
  delegationGrantId: 'delegation_primary', kind: 'event.publish',
  autonomy: 'execute_with_approval', target: { tenantId: 'tenant_primary',
    resourceType: 'event', resourceId: 'evt_primary', resourceVersion: 7,
    apiOperation: 'events.publish' }, payload: { visibility: 'public' },
  idempotencyKey: 'agent-execution-2026-07-12-0001', expectedPolicyVersion: 3,
  preparedAt: now.toISOString(),
};
const digest = agentActionDigest(action);
const approval: AgentApproval = {
  id: 'approval_primary', tenantId: 'tenant_primary', actionDigest: digest,
  approverPrincipalId: 'user_approver', approverPermissionSnapshot: ['events:publish'],
  policyVersion: 3, approvedAt: now.toISOString(), expiresAt: '2026-07-12T12:05:00.000Z',
};
const authorization: AgentAuthorizationInput & { approval: AgentApproval } = {
  principal: { id: 'agent_primary', kind: 'third_party', tenantId: 'tenant_primary',
    sponsorPrincipalId: 'user_sponsor', capabilities: ['events.execute'],
    maximumAutonomy: 'execute_with_approval', protocolVersion: AGENT_PROTOCOL_VERSION,
    state: 'active', registeredAt: '2026-07-01T00:00:00.000Z' },
  delegation: { id: 'delegation_primary', tenantId: 'tenant_primary',
    agentPrincipalId: 'agent_primary', sponsorPrincipalId: 'user_sponsor',
    capabilities: ['events.execute'], resourceScopes: ['event:evt_primary'],
    permissionSnapshot: ['events:publish'], issuedAt: '2026-07-01T00:00:00.000Z',
    expiresAt: '2026-08-01T00:00:00.000Z' },
  action, actionDigest: digest, sponsorPermissions: ['events:publish'],
  tenantAllowedActions: ['event.publish'], currentResourceVersion: 7,
  currentPolicyVersion: 3, now: now.toISOString(), approval,
};

class MemoryStore implements AgentExecutionStore {
  execution?: AgentExecution;
  approvalConsumed = false;
  audits: AgentAuditRecord[] = [];
  completeAllowed = true;

  async reserveAndConsume(input: Parameters<AgentExecutionStore['reserveAndConsume']>[0]) {
    if (this.execution) return { created: false, execution: this.execution };
    if (this.approvalConsumed) throw new Error('approval already consumed');
    this.approvalConsumed = true;
    this.execution = input.execution;
    this.audits.push(...input.audit);
    return { created: true, execution: input.execution };
  }

  async claim(input: Parameters<AgentExecutionStore['claim']>[0]) {
    if (!this.execution || this.execution.id !== input.executionId ||
      this.execution.tenantId !== input.tenantId) return null;
    if (this.execution.state === 'succeeded') return this.execution;
    this.execution = { ...this.execution, state: 'running', fenceToken: this.execution.fenceToken + 1,
      leaseOwner: input.workerId, leaseExpiresAt: '2026-07-12T12:05:00.000Z' };
    this.audits.push(input.audit);
    return this.execution;
  }

  async complete(input: Parameters<AgentExecutionStore['complete']>[0]) {
    if (!this.completeAllowed || !this.execution ||
      this.execution.fenceToken !== input.expectedRevision.fenceToken ||
      this.execution.leaseOwner !== input.expectedRevision.leaseOwner) return false;
    this.execution = input.execution;
    this.audits.push(input.audit);
    return true;
  }
}

function harness(store = new MemoryStore()) {
  let executionId = 0;
  let auditId = 0;
  const invocations: Array<Record<string, unknown>> = [];
  const service = new DurableAgentExecutionService(store, {
    async invoke(input) { invocations.push(input); return { resourceId: input.resourceId,
      resourceVersion: input.expectedResourceVersion + 1, status: 'published' }; },
  }, { now: () => now }, {
    executionId: () => `execution_${++executionId}`,
    auditId: () => `agent_audit_${++auditId}`,
  });
  return { service, store, invocations };
}

describe('durable agent execution service', () => {
  it('atomically reserves one payload-bound execution and converges exact replays', async () => {
    const { service, store } = harness();
    const results = await Promise.all(Array.from({ length: 8 }, () => service.reserve(authorization)));
    expect(new Set(results.map(({ id }) => id)).size).toBe(1);
    expect(store.approvalConsumed).toBe(true);
    expect(store.audits.map(({ phase }) => phase)).toEqual(['prepared', 'authorized']);
  });

  it('rejects an idempotency replay bound to another action digest', async () => {
    const { service } = harness();
    await service.reserve(authorization);
    const changed = { ...action, payload: { visibility: 'private' } };
    await expect(service.reserve({ ...authorization, action: changed,
      actionDigest: agentActionDigest(changed), approval: { ...approval,
        actionDigest: agentActionDigest(changed) } })).rejects.toBeInstanceOf(AgentExecutionConflictError);
  });

  it('invokes only the registry-bound operation and commits exact-fence success with audit', async () => {
    const { service, store, invocations } = harness();
    const reserved = await service.reserve(authorization);
    const completed = await service.run({ action, execution: reserved, workerId: 'worker_primary' });
    expect(completed).toMatchObject({ state: 'succeeded', result: { status: 'published' } });
    expect(invocations).toEqual([expect.objectContaining({ operation: 'events.publish',
      expectedResourceVersion: 7, idempotencyKey: action.idempotencyKey,
      agentPrincipalId: 'agent_primary', sponsorPrincipalId: 'user_sponsor' })]);
    expect(store.audits.map(({ phase }) => phase)).toEqual([
      'prepared', 'authorized', 'started', 'succeeded',
    ]);
  });

  it('fails closed when a stale fence cannot commit provider success', async () => {
    const { service, store } = harness();
    const reserved = await service.reserve(authorization);
    store.completeAllowed = false;
    await expect(service.run({ action, execution: reserved, workerId: 'worker_stale' }))
      .rejects.toBeInstanceOf(AgentExecutionConflictError);
    expect(store.execution?.state).toBe('running');
  });

  it('rejects a forged execution shell after authoritative claim without invocation', async () => {
    const { service, store, invocations } = harness();
    const reserved = await service.reserve(authorization);
    const forgedAction = { ...action, id: 'action_forged', payload: { visibility: 'private' } };
    const forged = { ...reserved, actionDigest: agentActionDigest(forgedAction),
      actionId: forgedAction.id };
    await expect(service.run({ action: forgedAction, execution: forged,
      workerId: 'worker_forged' })).rejects.toBeInstanceOf(AgentExecutionConflictError);
    expect(store.execution?.actionId).toBe(action.id);
    expect(invocations).toHaveLength(0);
  });

  it('does not trust a forged terminal shell before reading durable state', async () => {
    const { service, invocations } = harness();
    const reserved = await service.reserve(authorization);
    const forged = { ...reserved, state: 'succeeded' as const,
      result: { resourceId: 'forged', resourceVersion: 999, status: 'forged' } };
    const completed = await service.run({ action, execution: forged, workerId: 'worker_terminal' });
    expect(invocations).toHaveLength(1);
    expect(completed.result).toEqual({ resourceId: 'evt_primary', resourceVersion: 8,
      status: 'published' });
  });

  it('rejects provider-shaped results with extra fields instead of persisting them', async () => {
    const store = new MemoryStore();
    const service = new DurableAgentExecutionService(store, {
      async invoke() { return { resourceId: 'evt_primary', resourceVersion: 8,
        status: 'published', providerSecret: 'sk_live_secret' }; },
    }, { now: () => now }, { executionId: () => 'execution_unsafe_result',
      auditId: () => `agent_audit_${store.audits.length}` });
    const reserved = await service.reserve(authorization);
    await expect(service.run({ action, execution: reserved, workerId: 'worker_unsafe_result' }))
      .resolves.toMatchObject({ state: 'failed', failureCode: 'AGENT_ACTION_FAILED' });
    expect(JSON.stringify(store.execution)).not.toContain('sk_live_secret');
    const oversizedStore = new MemoryStore();
    const oversizedService = new DurableAgentExecutionService(oversizedStore, {
      async invoke() { return { resourceId: 'evt_primary', resourceVersion: 8,
        status: `published_${'x'.repeat(2_000)}` }; },
    }, { now: () => now }, { executionId: () => 'execution_oversized_result',
      auditId: () => `agent_audit_${oversizedStore.audits.length}` });
    const oversizedReserved = await oversizedService.reserve(authorization);
    await expect(oversizedService.run({ action, execution: oversizedReserved,
      workerId: 'worker_oversized_result' })).resolves.toMatchObject({ state: 'failed' });
    expect(JSON.stringify(oversizedStore.execution)).not.toContain('x'.repeat(200));
  });

  it.each([
    { resourceVersion: 8 },
    { resourceId: 'evt_primary', resourceVersion: 8 },
    { resourceId: null, resourceVersion: 8, status: 'published' },
    { resourceId: 'evt_primary', resourceVersion: 8, status: 9 },
  ])('rejects incomplete or untyped public results: %o', async (unsafeResult) => {
    const store = new MemoryStore();
    const service = new DurableAgentExecutionService(store, {
      async invoke() { return unsafeResult as never; },
    }, { now: () => now }, { executionId: () => 'execution_invalid_result',
      auditId: () => `agent_audit_${store.audits.length}` });
    const reserved = await service.reserve(authorization);
    await expect(service.run({ action, execution: reserved, workerId: 'worker_invalid_result' }))
      .resolves.toMatchObject({ state: 'failed' });
    expect(store.execution?.result).toBeUndefined();
  });

  it('persists bounded failure codes without provider detail', async () => {
    const store = new MemoryStore();
    const service = new DurableAgentExecutionService(store, {
      async invoke() { throw Object.assign(new Error('provider secret detail'), { code: 'TIMEOUT' }); },
    }, { now: () => now }, { executionId: () => 'execution_failure',
      auditId: () => `agent_audit_${store.audits.length}` });
    const reserved = await service.reserve(authorization);
    await expect(service.run({ action, execution: reserved, workerId: 'worker_failure' }))
      .resolves.toMatchObject({ state: 'failed', failureCode: 'TIMEOUT' });
    expect(JSON.stringify(store.execution)).not.toContain('provider secret detail');
  });
});
