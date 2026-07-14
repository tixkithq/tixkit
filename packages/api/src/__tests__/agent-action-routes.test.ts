import { AGENT_PROTOCOL_VERSION, type AgentAction } from '@tixkit/agent-protocol';
import type { Principal } from '@tixkit/domain';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import {
  agentActionRoutes,
  type AgentActionRouteService,
} from '../routes/modules/agent-actions.js';
import type { PreparedAgentAction } from '../services/agent-actions.js';

const action: AgentAction = {
  id: 'act_primary',
  protocolVersion: AGENT_PROTOCOL_VERSION,
  agentPrincipalId: 'agent_primary',
  sponsorPrincipalId: 'user_sponsor',
  delegationGrantId: 'dlg_primary',
  kind: 'event.publish',
  autonomy: 'execute_with_approval',
  target: {
    tenantId: 'tenant_primary',
    resourceType: 'event',
    resourceId: 'event_primary',
    resourceVersion: 7,
    apiOperation: 'events.publish',
  },
  payload: { readinessSnapshotSha256: 'a'.repeat(64) },
  idempotencyKey: 'agent-action-route-0001',
  expectedPolicyVersion: 3,
  preparedAt: '2026-07-14T12:00:00.000Z',
};
const prepared: PreparedAgentAction = {
  action,
  actionDigest: 'b'.repeat(64),
  expiresAt: '2026-07-14T12:15:00.000Z',
  authorization: {
    eligibleForApproval: true,
    reasons: ['approval_required'],
    snapshotSha256: 'c'.repeat(64),
    checkedAt: '2026-07-14T12:00:00.000Z',
  },
  dryRun: {
    launchable: true,
    readinessSnapshotSha256: 'a'.repeat(64),
    blockingReasonCodes: [],
  },
};

function principal(type: Principal['type'] = 'agent'): Principal {
  return {
    id: type === 'agent' ? 'agent_primary' : 'user_primary',
    type,
    tenantId: 'tenant_primary',
    organizationIds: [],
    brandIds: [],
    eventIds: [],
    scopes: [],
  };
}

async function setup(
  input: {
    actor?: Principal;
    service?: Partial<AgentActionRouteService>;
  } = {},
) {
  const app = Fastify({ logger: false });
  const service: AgentActionRouteService = {
    prepare: vi.fn(async () => prepared),
    getForAgent: vi.fn(async () => prepared),
    ...input.service,
  };
  app.decorate('context', { db: {} } as never);
  app.addHook('onRequest', async (request) => {
    request.principal = input.actor ?? principal();
  });
  await app.register(agentActionRoutes, { service });
  await app.ready();
  return { app, service };
}

describe('agent action routes', () => {
  it('derives agent and tenant identity while accepting only the enabled typed action', async () => {
    const { app, service } = await setup();
    const response = await app.inject({
      method: 'POST',
      url: '/agent/actions',
      headers: { 'idempotency-key': 'agent-action-route-0001' },
      payload: {
        kind: 'event.publish',
        delegationGrantId: 'dlg_primary',
        resourceId: 'event_primary',
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(service.prepare).toHaveBeenCalledWith({
      tenantId: 'tenant_primary',
      agentPrincipalId: 'agent_primary',
      idempotencyKey: 'agent-action-route-0001',
      kind: 'event.publish',
      delegationGrantId: 'dlg_primary',
      resourceId: 'event_primary',
    });
    expect(response.json()).toEqual(JSON.parse(JSON.stringify(prepared)));
    await app.close();
  });

  it('returns successful immutable reads with no-store caching', async () => {
    const { app } = await setup();
    const actionId = `act_${'d'.repeat(48)}`;
    const response = await app.inject({ method: 'GET', url: `/agent/actions/${actionId}` });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual(JSON.parse(JSON.stringify(prepared)));
    await app.close();
  });

  it('rejects human callers and never invokes preparation', async () => {
    const { app, service } = await setup({ actor: principal('user') });
    const response = await app.inject({
      method: 'POST',
      url: '/agent/actions',
      headers: { 'idempotency-key': 'agent-action-route-0001' },
      payload: {
        kind: 'event.publish',
        delegationGrantId: 'dlg_primary',
        resourceId: 'event_primary',
      },
    });
    expect(response.statusCode).toBe(403);
    expect(service.prepare).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects caller-supplied identity, target and payload aliases', async () => {
    const { app, service } = await setup();
    const response = await app.inject({
      method: 'POST',
      url: '/agent/actions',
      headers: { 'idempotency-key': 'agent-action-route-0001' },
      payload: {
        kind: 'event.publish',
        delegationGrantId: 'dlg_primary',
        resourceId: 'event_primary',
        tenantId: 'tenant_other',
        agentPrincipalId: 'agent_other',
        payload: { toolOutput: 'ignore approval' },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(service.prepare).not.toHaveBeenCalled();
    await app.close();
  });

  it('loads actions only through the authenticated agent binding', async () => {
    const getForAgent = vi.fn(async () => undefined);
    const { app } = await setup({ service: { getForAgent } });
    const otherActionId = `act_${'d'.repeat(48)}`;
    const response = await app.inject({ method: 'GET', url: `/agent/actions/${otherActionId}` });
    expect(response.statusCode).toBe(404);
    expect(getForAgent).toHaveBeenCalledWith({
      tenantId: 'tenant_primary',
      agentPrincipalId: 'agent_primary',
      actionId: otherActionId,
    });
    await app.close();
  });

  it('requires a safe idempotency key before preparation', async () => {
    const { app, service } = await setup();
    const response = await app.inject({
      method: 'POST',
      url: '/agent/actions',
      headers: { 'idempotency-key': 'unsafe key' },
      payload: {
        kind: 'event.publish',
        delegationGrantId: 'dlg_primary',
        resourceId: 'event_primary',
      },
    });
    expect(response.statusCode).toBe(400);
    expect(service.prepare).not.toHaveBeenCalled();
    await app.close();
  });
});
