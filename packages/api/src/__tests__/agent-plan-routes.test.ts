import {
  AGENT_PLATFORM_PROTOCOL_VERSION,
  AGENT_PROTOCOL_VERSION,
  buildAgentPlanDefinition,
  type AgentPlanDefinition,
  type AgentPlanState,
} from '@tixkit/agent-protocol';
import type { Principal } from '@tixkit/domain';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import {
  agentPlanRoutes,
  type AgentPlanStore,
  type PersistedAgentPlan,
} from '../routes/modules/agent-plans.js';

const definition: AgentPlanDefinition = buildAgentPlanDefinition({
  id: 'plan_primary',
  protocolVersion: AGENT_PLATFORM_PROTOCOL_VERSION,
  tenantId: 'tenant_primary',
  agentPrincipalId: 'agent_primary',
  sponsorPrincipalId: 'user_sponsor',
  delegationGrantId: 'delegation_primary',
  purpose: 'Publish the reviewed event configuration',
  assumptions: [
    {
      id: 'assumption_launch_date',
      statement: 'The organizer confirmed the launch date.',
      provenanceType: 'user',
      verification: 'confirmed',
    },
  ],
  steps: [
    {
      id: 'step_publish',
      actionKind: 'event.publish',
      actionProtocolVersion: AGENT_PROTOCOL_VERSION,
      actionDigest: 'a'.repeat(64),
      dependsOnStepIds: [],
      projectedChanges: [
        {
          resourceType: 'event',
          resourceId: 'event_primary',
          operation: 'publish',
          beforeVersion: 7,
          projectedVersion: 8,
          previewSha256: 'b'.repeat(64),
        },
      ],
      costs: [],
      readinessImpact: {
        beforeSnapshotSha256: 'c'.repeat(64),
        projectedSnapshotSha256: 'd'.repeat(64),
        introducedReasonCodes: [],
        resolvedReasonCodes: ['event_unpublished'],
      },
      approvalRequirement: { mode: 'fresh_action', riskClass: 'high' },
      reversibility: { mode: 'none' },
    },
  ],
  createdAt: '2026-07-14T12:00:00.000Z',
  expiresAt: '2026-07-14T12:30:00.000Z',
});
const initialState: AgentPlanState = {
  planId: definition.id,
  planSha256: definition.planSha256,
  stateVersion: 1,
  status: 'prepared',
  stepStates: [{ stepId: 'step_publish', status: 'pending' }],
  updatedAt: '2026-07-14T12:00:01.000Z',
};
const persisted: PersistedAgentPlan = {
  definition,
  state: initialState,
  actionBindings: [{ stepId: 'step_publish', actionId: 'action_publish' }],
};
const transitioned: PersistedAgentPlan = {
  ...persisted,
  state: {
    ...initialState,
    stateVersion: 2,
    status: 'awaiting_approval',
    stepStates: [{ stepId: 'step_publish', status: 'awaiting_approval' }],
    updatedAt: '2026-07-14T12:00:02.000Z',
  },
};

function principal(type: Principal['type'] = 'agent'): Principal {
  return {
    id: type === 'agent' ? 'agent_primary' : 'user_sponsor',
    type,
    tenantId: 'tenant_primary',
    organizationIds: [],
    brandIds: [],
    eventIds: [],
    scopes: [],
  };
}

async function setup(input: { actor?: Principal; repository?: Partial<AgentPlanStore> } = {}) {
  const app = Fastify({ logger: false });
  const repository: AgentPlanStore = {
    create: vi.fn(async () => persisted),
    getForAgent: vi.fn(async () => persisted),
    getForSponsor: vi.fn(async () => persisted),
    transition: vi.fn(async () => transitioned),
    ...input.repository,
  };
  app.decorate('context', { db: {} } as never);
  app.addHook('onRequest', async (request) => {
    request.principal = input.actor ?? principal();
  });
  await app.register(agentPlanRoutes, { repository });
  await app.ready();
  return { app, repository };
}

describe('agent plan routes', () => {
  it('derives the agent actor and idempotency boundary when creating a plan', async () => {
    const { app, repository } = await setup();
    const response = await app.inject({
      method: 'POST',
      url: '/agent/plans',
      headers: { 'idempotency-key': 'agent-plan-route-create-0001' },
      payload: { definition, actionBindings: persisted.actionBindings },
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(repository.create).toHaveBeenCalledWith({
      definition,
      actionBindings: persisted.actionBindings,
      actor: { type: 'agent', tenantId: 'tenant_primary', principalId: 'agent_primary' },
      idempotencyKey: 'agent-plan-route-create-0001',
    });
    expect(response.json()).toEqual(persisted);
    await app.close();
  });

  it('rejects human creation and invalid or digest-mismatched definitions before persistence', async () => {
    const { app: human, repository: humanRepository } = await setup({ actor: principal('user') });
    const humanResponse = await human.inject({
      method: 'POST',
      url: '/agent/plans',
      headers: { 'idempotency-key': 'agent-plan-route-create-0002' },
      payload: { definition, actionBindings: persisted.actionBindings },
    });
    expect(humanResponse.statusCode).toBe(403);
    expect(humanRepository.create).not.toHaveBeenCalled();
    await human.close();

    const { app, repository } = await setup();
    const response = await app.inject({
      method: 'POST',
      url: '/agent/plans',
      headers: { 'idempotency-key': 'agent-plan-route-create-0003' },
      payload: {
        definition: { ...definition, planSha256: 'f'.repeat(64) },
        actionBindings: persisted.actionBindings,
      },
    });
    expect(response.statusCode).toBe(400);
    expect(repository.create).not.toHaveBeenCalled();
    await app.close();
  });

  it('conceals a same-tenant storage identity collision as a bounded conflict', async () => {
    const { app } = await setup({
      repository: {
        create: vi.fn(async () => {
          throw new Error('AGENT_PLAN_ID_CONFLICT');
        }),
      },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/agent/plans',
      headers: { 'idempotency-key': 'agent-plan-route-collision-0001' },
      payload: { definition, actionBindings: persisted.actionBindings },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: 'Conflict',
      message: 'Agent plan identifier is already in use',
    });
    await app.close();
  });

  it('scopes reads to the authenticated agent or exact human sponsor', async () => {
    const { app: agentApp, repository: agentRepository } = await setup();
    const agentResponse = await agentApp.inject({
      method: 'GET',
      url: '/agent/plans/plan_primary',
    });
    expect(agentResponse.statusCode).toBe(200);
    expect(agentResponse.headers['cache-control']).toBe('no-store');
    expect(agentRepository.getForAgent).toHaveBeenCalledWith({
      tenantId: 'tenant_primary',
      agentPrincipalId: 'agent_primary',
      planId: 'plan_primary',
    });
    await agentApp.close();

    const { app: sponsorApp, repository: sponsorRepository } = await setup({
      actor: principal('user'),
    });
    const sponsorResponse = await sponsorApp.inject({
      method: 'GET',
      url: '/agent/plans/plan_primary',
    });
    expect(sponsorResponse.statusCode).toBe(200);
    expect(sponsorRepository.getForSponsor).toHaveBeenCalledWith({
      tenantId: 'tenant_primary',
      sponsorPrincipalId: 'user_sponsor',
      planId: 'plan_primary',
    });
    await sponsorApp.close();
  });

  it('conceals missing and actor-denied plans and rejects non-agent/non-human callers', async () => {
    const { app: missing } = await setup({ repository: { getForAgent: vi.fn() } });
    const missingResponse = await missing.inject({
      method: 'GET',
      url: '/agent/plans/plan_primary',
    });
    expect(missingResponse.statusCode).toBe(404);
    await missing.close();

    const { app: denied } = await setup({
      repository: {
        transition: vi.fn(async () => {
          throw new Error('AGENT_PLAN_ACTOR_DENIED');
        }),
      },
    });
    const deniedResponse = await denied.inject({
      method: 'POST',
      url: '/agent/plans/plan_primary/transitions',
      headers: { 'idempotency-key': 'agent-plan-route-denied-0001' },
      payload: {
        expectedStateVersion: 1,
        status: 'awaiting_approval',
        stepStates: [{ stepId: 'step_publish', status: 'awaiting_approval' }],
        reasonCode: 'approval_requested',
      },
    });
    expect(deniedResponse.statusCode).toBe(404);
    await denied.close();

    const { app: service } = await setup({ actor: principal('api_key') });
    const serviceResponse = await service.inject({
      method: 'GET',
      url: '/agent/plans/plan_primary',
    });
    expect(serviceResponse.statusCode).toBe(403);
    await service.close();
  });

  it('derives transition identity and sends only versioned typed state to the repository', async () => {
    const { app, repository } = await setup({ actor: principal('user') });
    const response = await app.inject({
      method: 'POST',
      url: '/agent/plans/plan_primary/transitions',
      headers: { 'idempotency-key': 'agent-plan-route-transition-0001' },
      payload: {
        expectedStateVersion: 1,
        status: 'awaiting_approval',
        stepStates: [{ stepId: 'step_publish', status: 'awaiting_approval' }],
        reasonCode: 'approval_requested',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(repository.transition).toHaveBeenCalledWith({
      tenantId: 'tenant_primary',
      planId: 'plan_primary',
      expectedStateVersion: 1,
      status: 'awaiting_approval',
      stepStates: [{ stepId: 'step_publish', status: 'awaiting_approval' }],
      actor: { type: 'user', tenantId: 'tenant_primary', principalId: 'user_sponsor' },
      reasonCode: 'approval_requested',
      idempotencyKey: 'agent-plan-route-transition-0001',
    });
    await app.close();
  });

  it('rejects malformed state and idempotency material before transition', async () => {
    const { app, repository } = await setup();
    const response = await app.inject({
      method: 'POST',
      url: '/agent/plans/plan_primary/transitions',
      headers: { 'idempotency-key': 'short' },
      payload: {
        expectedStateVersion: 0,
        status: 'succeeded',
        stepStates: [],
        reasonCode: 'INVALID REASON',
      },
    });
    expect(response.statusCode).toBe(400);
    expect(repository.transition).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    ['AGENT_PLAN_STATE_CONFLICT', 'Agent plan state version changed'],
    ['AGENT_PLAN_LIFETIME_INVALID', 'Agent plan lifetime is no longer valid'],
    [
      'AGENT_PLAN_EXECUTION_APPROVAL_BINDING_INVALID',
      'Agent plan approval and execution evidence no longer match',
    ],
  ])('maps %s to a bounded transition conflict', async (repositoryError, expectedMessage) => {
    const { app } = await setup({
      repository: {
        transition: vi.fn(async () => {
          throw new Error(repositoryError);
        }),
      },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/agent/plans/plan_primary/transitions',
      headers: { 'idempotency-key': `agent-plan-route-${repositoryError.toLowerCase()}` },
      payload: {
        expectedStateVersion: 1,
        status: 'awaiting_approval',
        stepStates: [{ stepId: 'step_publish', status: 'awaiting_approval' }],
        reasonCode: 'approval_requested',
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'Conflict', message: expectedMessage });
    await app.close();
  });

  it('maps idempotency reuse with different intent to the shared conflict response', async () => {
    const { app } = await setup({
      repository: {
        transition: vi.fn(async () => {
          throw new Error('AGENT_PLAN_IDEMPOTENCY_CONFLICT');
        }),
      },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/agent/plans/plan_primary/transitions',
      headers: { 'idempotency-key': 'agent-plan-route-idempotency-0001' },
      payload: {
        expectedStateVersion: 1,
        status: 'awaiting_approval',
        stepStates: [{ stepId: 'step_publish', status: 'awaiting_approval' }],
        reasonCode: 'approval_requested',
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'Conflict' });
    await app.close();
  });
});
