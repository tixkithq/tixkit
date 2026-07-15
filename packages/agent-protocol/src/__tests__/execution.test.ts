import { describe, expect, it } from 'vitest';
import {
  AGENT_PROTOCOL_VERSION,
  DurableAgentExecutionService,
  AgentExecutionConflictError,
  agentActionDigest,
  agentExecutionIdempotencyKey,
  validateAgentActionResultForAction,
  type AgentAction,
  type AgentApproval,
  type AgentAuditRecord,
  type AgentAuthorizationInput,
  type AgentExecution,
  type AgentExecutionStore,
} from '../index.js';

const now = new Date('2026-07-12T12:00:00.000Z');
const action: AgentAction = {
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
  payload: { readinessSnapshotSha256: 'a'.repeat(64) },
  idempotencyKey: 'agent-execution-2026-07-12-0001',
  expectedPolicyVersion: 3,
  preparedAt: now.toISOString(),
};
const digest = agentActionDigest(action);
const approval: AgentApproval = {
  id: 'approval_primary',
  tenantId: 'tenant_primary',
  actionDigest: digest,
  approverPrincipalId: 'user_approver',
  approverPermissionSnapshot: ['events:publish'],
  policyVersion: 3,
  approvedAt: now.toISOString(),
  expiresAt: '2026-07-12T12:05:00.000Z',
};

it('binds event.update execution results to exactly one approved version increment', () => {
  const updateAction: AgentAction = {
    ...action,
    kind: 'event.update',
    target: { ...action.target, apiOperation: 'events.update' },
    payload: {
      changePreviewSha256: 'b'.repeat(64),
      changes: { title: 'Updated' },
    },
  };
  expect(() =>
    validateAgentActionResultForAction(updateAction, {
      resourceId: 'evt_primary',
      resourceVersion: 8,
      status: 'updated',
    }),
  ).not.toThrow();
  for (const result of [
    { resourceId: 'evt_primary', resourceVersion: 7, status: 'updated' },
    { resourceId: 'evt_primary', resourceVersion: 9, status: 'updated' },
    { resourceId: 'evt_primary', resourceVersion: 8, status: 'published' },
    { resourceId: 'evt_other', resourceVersion: 8, status: 'updated' },
  ])
    expect(() => validateAgentActionResultForAction(updateAction, result)).toThrow();
});
const authorization: AgentAuthorizationInput & { approval: AgentApproval } = {
  principal: {
    id: 'agent_primary',
    kind: 'third_party',
    tenantId: 'tenant_primary',
    sponsorPrincipalId: 'user_sponsor',
    capabilities: ['events.execute'],
    maximumAutonomy: 'execute_with_approval',
    protocolVersion: AGENT_PROTOCOL_VERSION,
    state: 'active',
    registeredAt: '2026-07-01T00:00:00.000Z',
  },
  delegation: {
    id: 'delegation_primary',
    tenantId: 'tenant_primary',
    agentPrincipalId: 'agent_primary',
    sponsorPrincipalId: 'user_sponsor',
    capabilities: ['events.execute'],
    resourceScopes: ['event:evt_primary'],
    permissionSnapshot: ['events:publish'],
    issuedAt: '2026-07-01T00:00:00.000Z',
    expiresAt: '2026-08-01T00:00:00.000Z',
  },
  action,
  actionDigest: digest,
  sponsorPermissions: ['events:publish'],
  tenantAllowedActions: ['event.publish'],
  currentResourceVersion: 7,
  currentPolicyVersion: 3,
  now: now.toISOString(),
  approval,
};

class MemoryStore implements AgentExecutionStore {
  execution?: AgentExecution;
  approvalConsumed = false;
  audits: AgentAuditRecord[] = [];
  completeAllowed = true;
  effect?: { resourceId: string; resourceVersion: number; status: string };

  async reserveAndConsume(input: Parameters<AgentExecutionStore['reserveAndConsume']>[0]) {
    if (this.execution) return { created: false, execution: this.execution };
    if (this.approvalConsumed) throw new Error('approval already consumed');
    this.approvalConsumed = true;
    this.execution = input.execution;
    this.audits.push(...input.audit);
    return { created: true, execution: input.execution };
  }

  async claim(input: Parameters<AgentExecutionStore['claim']>[0]) {
    if (
      !this.execution ||
      this.execution.id !== input.executionId ||
      this.execution.tenantId !== input.tenantId
    )
      return null;
    if (['succeeded', 'compensated'].includes(this.execution.state)) return this.execution;
    if (this.execution.state === 'failed' && !this.effect) return this.execution;
    this.execution = {
      ...this.execution,
      state: 'running',
      fenceToken: this.execution.fenceToken + 1,
      leaseOwner: input.workerId,
      leaseExpiresAt: '2026-07-12T12:05:00.000Z',
    };
    this.audits.push(input.audit);
    return this.execution;
  }

  async complete(input: Parameters<AgentExecutionStore['complete']>[0]) {
    if (
      !this.completeAllowed ||
      !this.execution ||
      this.execution.fenceToken !== input.expectedRevision.fenceToken ||
      this.execution.leaseOwner !== input.expectedRevision.leaseOwner
    )
      return false;
    this.execution = input.execution;
    this.audits.push(input.audit);
    return true;
  }

  async recoverEffect() {
    return this.effect;
  }
}

function harness(store = new MemoryStore(), current: Record<string, unknown> = {}) {
  let executionId = 0;
  let auditId = 0;
  const invocations: Array<Record<string, unknown>> = [];
  const service = new DurableAgentExecutionService(
    store,
    {
      async invoke(input) {
        invocations.push(input);
        return {
          resourceId: input.resourceId,
          resourceVersion: input.expectedResourceVersion + 1,
          status: 'published',
        };
      },
    },
    { now: () => now },
    {
      executionId: () => `execution_${++executionId}`,
      auditId: () => `agent_audit_${++auditId}`,
    },
    {
      async load({ execution }) {
        return {
          ...authorization,
          approval,
          approvalExecutionId: execution.id,
          riskPolicyAllowed: true,
          observedAt: now.toISOString(),
          ...current,
        };
      },
    },
  );
  return { service, store, invocations };
}

describe('durable agent execution service', () => {
  it('atomically reserves one payload-bound execution and converges exact replays', async () => {
    const { service, store } = harness();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => service.reserve(authorization)),
    );
    expect(new Set(results.map(({ id }) => id)).size).toBe(1);
    expect(store.approvalConsumed).toBe(true);
    expect(store.audits.map(({ phase }) => phase)).toEqual(['prepared', 'authorized']);
  });

  it('rejects an idempotency replay bound to another action digest', async () => {
    const { service } = harness();
    await service.reserve(authorization);
    const changed = {
      ...action,
      payload: { readinessSnapshotSha256: 'b'.repeat(64) },
    };
    await expect(
      service.reserve({
        ...authorization,
        action: changed,
        actionDigest: agentActionDigest(changed),
        approval: { ...approval, actionDigest: agentActionDigest(changed) },
      }),
    ).rejects.toBeInstanceOf(AgentExecutionConflictError);
  });

  it('invokes only the registry-bound operation and commits exact-fence success with audit', async () => {
    const { service, store, invocations } = harness();
    const reserved = await service.reserve(authorization);
    const completed = await service.run({
      action,
      execution: reserved,
      workerId: 'worker_primary',
    });
    expect(completed).toMatchObject({
      state: 'succeeded',
      result: { status: 'published' },
    });
    expect(invocations).toEqual([
      expect.objectContaining({
        operation: 'events.publish',
        expectedResourceVersion: 7,
        idempotencyKey: agentExecutionIdempotencyKey(action),
        agentPrincipalId: 'agent_primary',
        sponsorPrincipalId: 'user_sponsor',
      }),
    ]);
    expect(store.audits.map(({ phase }) => phase)).toEqual([
      'prepared',
      'authorized',
      'started',
      'succeeded',
    ]);
  });

  it('fails closed when a stale fence cannot commit provider success', async () => {
    const { service, store } = harness();
    const reserved = await service.reserve(authorization);
    store.completeAllowed = false;
    await expect(
      service.run({ action, execution: reserved, workerId: 'worker_stale' }),
    ).rejects.toBeInstanceOf(AgentExecutionConflictError);
    expect(store.execution?.state).toBe('running');
  });

  it('lets a fenced successor recover an exact effect before stale resource authorization', async () => {
    const store = new MemoryStore();
    let authorizationLoads = 0;
    const service = new DurableAgentExecutionService(
      store,
      {
        async invoke() {
          store.effect = {
            resourceId: 'evt_primary',
            resourceVersion: 8,
            status: 'published',
          };
          return store.effect;
        },
      },
      { now: () => now },
      {
        executionId: () => 'execution_effect_recovery',
        auditId: () => `agent_audit_${store.audits.length}`,
      },
      {
        async load({ execution }) {
          authorizationLoads += 1;
          return {
            ...authorization,
            approval,
            approvalExecutionId: execution.id,
            riskPolicyAllowed: true,
            currentResourceVersion: authorizationLoads === 1 ? 7 : 8,
            observedAt: now.toISOString(),
          };
        },
      },
    );
    const reserved = await service.reserve(authorization);
    store.completeAllowed = false;
    await expect(
      service.run({
        action,
        execution: reserved,
        workerId: 'worker_lost_response',
      }),
    ).rejects.toBeInstanceOf(AgentExecutionConflictError);
    store.completeAllowed = true;
    await expect(
      service.run({
        action,
        execution: reserved,
        workerId: 'worker_successor',
      }),
    ).resolves.toMatchObject({
      state: 'succeeded',
      result: { resourceVersion: 8 },
    });
    expect(authorizationLoads).toBe(1);
    expect(store.audits.at(-1)?.phase).toBe('succeeded');
  });

  it('rejects a forged execution shell after authoritative claim without invocation', async () => {
    const { service, store, invocations } = harness();
    const reserved = await service.reserve(authorization);
    const forgedAction = {
      ...action,
      id: 'action_forged',
      payload: { readinessSnapshotSha256: 'b'.repeat(64) },
    };
    const forged = {
      ...reserved,
      actionDigest: agentActionDigest(forgedAction),
      actionId: forgedAction.id,
    };
    await expect(
      service.run({
        action: forgedAction,
        execution: forged,
        workerId: 'worker_forged',
      }),
    ).rejects.toBeInstanceOf(AgentExecutionConflictError);
    expect(store.execution?.actionId).toBe(action.id);
    expect(invocations).toHaveLength(0);
  });

  it('does not trust a forged terminal shell before reading durable state', async () => {
    const { service, invocations } = harness();
    const reserved = await service.reserve(authorization);
    const forged = {
      ...reserved,
      state: 'succeeded' as const,
      result: { resourceId: 'forged', resourceVersion: 999, status: 'forged' },
    };
    const completed = await service.run({
      action,
      execution: forged,
      workerId: 'worker_terminal',
    });
    expect(invocations).toHaveLength(1);
    expect(completed.result).toEqual({
      resourceId: 'evt_primary',
      resourceVersion: 8,
      status: 'published',
    });
  });

  it.each([
    { currentResourceVersion: 8 },
    { currentPolicyVersion: 4 },
    { sponsorPermissions: [] },
    { tenantAllowedActions: [] },
    { riskPolicyAllowed: false },
    { principal: { ...authorization.principal, capabilities: [] } },
    { delegation: { ...authorization.delegation, resourceScopes: [] } },
  ])('fails a reserved execution when current authorization narrows: %o', async (current) => {
    const { service, store, invocations } = harness(new MemoryStore(), current);
    const reserved = await service.reserve(authorization);
    await expect(
      service.run({
        action,
        execution: reserved,
        workerId: 'worker_changed_auth',
      }),
    ).resolves.toMatchObject({
      state: 'failed',
      failureCode: 'AGENT_AUTHORIZATION_CHANGED',
    });
    expect(invocations).toHaveLength(0);
    expect(store.audits.at(-1)).toMatchObject({ phase: 'failed' });
    expect(store.audits.at(-1)?.reasonCodes.length).toBeGreaterThan(0);
  });

  it('scopes execution idempotency to the agent principal', () => {
    expect(agentExecutionIdempotencyKey(action)).not.toBe(
      agentExecutionIdempotencyKey({
        ...action,
        agentPrincipalId: 'agent_other',
      }),
    );
    expect(agentExecutionIdempotencyKey(action)).toBe(agentExecutionIdempotencyKey({ ...action }));
  });

  it.each(['AGENT_AUTHORIZATION_CHANGED', 'AGENT_STATE_INVALID', 'AGENT_OPERATION_DENIED'])(
    'persists permanent authorization load failure %s',
    async (code) => {
      const store = new MemoryStore();
      const service = new DurableAgentExecutionService(
        store,
        {
          async invoke() {
            throw new Error('must not invoke');
          },
        },
        { now: () => now },
        {
          executionId: () => 'execution_permanent_load_failure',
          auditId: () => `agent_audit_${store.audits.length}`,
        },
        {
          async load() {
            throw Object.assign(new Error('authoritative state is invalid'), {
              code,
            });
          },
        },
      );
      const reserved = await service.reserve(authorization);
      await expect(
        service.run({
          action,
          execution: reserved,
          workerId: 'worker_permanent_failure',
        }),
      ).resolves.toMatchObject({
        state: 'failed',
        failureCode: 'AGENT_AUTHORIZATION_CHANGED',
      });
      expect(store.audits.at(-1)).toMatchObject({
        phase: 'failed',
        reasonCodes: [code.toLowerCase()],
      });
    },
  );

  it('leaves retryable authorization load failures resumable', async () => {
    const store = new MemoryStore();
    const service = new DurableAgentExecutionService(
      store,
      {
        async invoke() {
          throw new Error('must not invoke');
        },
      },
      { now: () => now },
      {
        executionId: () => 'execution_retryable_load_failure',
        auditId: () => `agent_audit_${store.audits.length}`,
      },
      {
        async load() {
          throw new Error('connection reset');
        },
      },
    );
    const reserved = await service.reserve(authorization);
    await expect(
      service.run({
        action,
        execution: reserved,
        workerId: 'worker_retryable_failure',
      }),
    ).rejects.toThrow('connection reset');
    expect(store.execution).toMatchObject({ state: 'running' });
    expect(store.audits.at(-1)?.phase).toBe('started');
  });

  it('rejects provider-shaped results with extra fields instead of persisting them', async () => {
    const store = new MemoryStore();
    const service = new DurableAgentExecutionService(
      store,
      {
        async invoke() {
          return {
            resourceId: 'evt_primary',
            resourceVersion: 8,
            status: 'published',
            providerSecret: 'sk_live_secret',
          };
        },
      },
      { now: () => now },
      {
        executionId: () => 'execution_unsafe_result',
        auditId: () => `agent_audit_${store.audits.length}`,
      },
      {
        async load({ execution }) {
          return {
            ...authorization,
            approval,
            approvalExecutionId: execution.id,
            riskPolicyAllowed: true,
            observedAt: now.toISOString(),
          };
        },
      },
    );
    const reserved = await service.reserve(authorization);
    await expect(
      service.run({
        action,
        execution: reserved,
        workerId: 'worker_unsafe_result',
      }),
    ).resolves.toMatchObject({
      state: 'failed',
      failureCode: 'AGENT_ACTION_FAILED',
    });
    expect(JSON.stringify(store.execution)).not.toContain('sk_live_secret');
    const oversizedStore = new MemoryStore();
    const oversizedService = new DurableAgentExecutionService(
      oversizedStore,
      {
        async invoke() {
          return {
            resourceId: 'evt_primary',
            resourceVersion: 8,
            status: `published_${'x'.repeat(2_000)}`,
          };
        },
      },
      { now: () => now },
      {
        executionId: () => 'execution_oversized_result',
        auditId: () => `agent_audit_${oversizedStore.audits.length}`,
      },
      {
        async load({ execution }) {
          return {
            ...authorization,
            approval,
            approvalExecutionId: execution.id,
            riskPolicyAllowed: true,
            observedAt: now.toISOString(),
          };
        },
      },
    );
    const oversizedReserved = await oversizedService.reserve(authorization);
    await expect(
      oversizedService.run({
        action,
        execution: oversizedReserved,
        workerId: 'worker_oversized_result',
      }),
    ).resolves.toMatchObject({ state: 'failed' });
    expect(JSON.stringify(oversizedStore.execution)).not.toContain('x'.repeat(200));
  });

  it.each([
    { resourceId: 'evt_other', resourceVersion: 8, status: 'published' },
    { resourceId: 'evt_primary', resourceVersion: 99, status: 'published' },
    { resourceId: 'evt_primary', resourceVersion: 8, status: 'draft' },
  ])('rejects action-bound tool output substitution: %o', async (unsafeResult) => {
    const store = new MemoryStore();
    const service = new DurableAgentExecutionService(
      store,
      {
        async invoke() {
          return unsafeResult;
        },
      },
      { now: () => now },
      {
        executionId: () => 'execution_substituted_result',
        auditId: () => `agent_audit_${store.audits.length}`,
      },
      {
        async load({ execution }) {
          return {
            ...authorization,
            approval,
            approvalExecutionId: execution.id,
            riskPolicyAllowed: true,
            observedAt: now.toISOString(),
          };
        },
      },
    );
    const reserved = await service.reserve(authorization);
    await expect(
      service.run({
        action,
        execution: reserved,
        workerId: 'worker_substituted_result',
      }),
    ).resolves.toMatchObject({
      state: 'failed',
      failureCode: 'AGENT_ACTION_FAILED',
    });
    expect(store.execution?.result).toBeUndefined();
  });

  it('treats a failed consequential execution as terminal and requires a fresh action approval', async () => {
    const { service, store, invocations } = harness();
    const reserved = await service.reserve(authorization);
    store.execution = { ...reserved, state: 'failed', failureCode: 'TIMEOUT' };
    await expect(
      service.run({
        action,
        execution: reserved,
        workerId: 'worker_failed_replay',
      }),
    ).resolves.toMatchObject({ state: 'failed', failureCode: 'TIMEOUT' });
    expect(invocations).toHaveLength(0);
    expect(store.audits.map(({ phase }) => phase)).toEqual(['prepared', 'authorized']);
  });

  it('reconciles an exact committed effect from failed to succeeded without invoking again', async () => {
    const { service, store, invocations } = harness();
    const reserved = await service.reserve(authorization);
    store.execution = { ...reserved, state: 'failed', failureCode: 'TIMEOUT' };
    store.effect = {
      resourceId: 'evt_primary',
      resourceVersion: 8,
      status: 'published',
    };
    await expect(
      service.run({
        action,
        execution: reserved,
        workerId: 'worker_failed_effect_recovery',
      }),
    ).resolves.toMatchObject({ state: 'succeeded', result: store.effect });
    expect(invocations).toHaveLength(0);
    expect(store.audits.map(({ phase }) => phase)).toEqual([
      'prepared',
      'authorized',
      'started',
      'succeeded',
    ]);
  });

  it.each([
    { resourceVersion: 8 },
    { resourceId: 'evt_primary', resourceVersion: 8 },
    { resourceId: null, resourceVersion: 8, status: 'published' },
    { resourceId: 'evt_primary', resourceVersion: 8, status: 9 },
  ])('rejects incomplete or untyped public results: %o', async (unsafeResult) => {
    const store = new MemoryStore();
    const service = new DurableAgentExecutionService(
      store,
      {
        async invoke() {
          return unsafeResult as never;
        },
      },
      { now: () => now },
      {
        executionId: () => 'execution_invalid_result',
        auditId: () => `agent_audit_${store.audits.length}`,
      },
      {
        async load({ execution }) {
          return {
            ...authorization,
            approval,
            approvalExecutionId: execution.id,
            riskPolicyAllowed: true,
            observedAt: now.toISOString(),
          };
        },
      },
    );
    const reserved = await service.reserve(authorization);
    await expect(
      service.run({
        action,
        execution: reserved,
        workerId: 'worker_invalid_result',
      }),
    ).resolves.toMatchObject({ state: 'failed' });
    expect(store.execution?.result).toBeUndefined();
  });

  it('persists bounded failure codes without provider detail', async () => {
    const store = new MemoryStore();
    const service = new DurableAgentExecutionService(
      store,
      {
        async invoke() {
          throw Object.assign(new Error('provider secret detail'), {
            code: 'TIMEOUT',
          });
        },
      },
      { now: () => now },
      {
        executionId: () => 'execution_failure',
        auditId: () => `agent_audit_${store.audits.length}`,
      },
      {
        async load({ execution }) {
          return {
            ...authorization,
            approval,
            approvalExecutionId: execution.id,
            riskPolicyAllowed: true,
            observedAt: now.toISOString(),
          };
        },
      },
    );
    const reserved = await service.reserve(authorization);
    await expect(
      service.run({ action, execution: reserved, workerId: 'worker_failure' }),
    ).resolves.toMatchObject({ state: 'failed', failureCode: 'TIMEOUT' });
    expect(JSON.stringify(store.execution)).not.toContain('provider secret detail');
  });
});
