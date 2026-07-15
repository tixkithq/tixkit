import {
  AGENT_PROTOCOL_VERSION,
  AgentExecutionConflictError,
  type AgentAction,
  type AgentExecutionEvidence,
} from '@tixkit/agent-protocol';
import type { Principal } from '@tixkit/domain';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import {
  agentActionRoutes,
  type AgentActionRouteService,
} from '../routes/modules/agent-actions.js';
import type {
  PreparedAgentAction,
  PreparedAgentEventPrepareAction,
  PreparedAgentEventReadAction,
  PreparedAgentReadinessAction,
} from '../services/agent-actions.js';

const action = {
  id: 'act_primary',
  protocolVersion: AGENT_PROTOCOL_VERSION,
  agentPrincipalId: 'agent_primary',
  sponsorPrincipalId: 'user_sponsor',
  delegationGrantId: 'dlg_primary',
  kind: 'event.publish',
  autonomy: 'execute_with_approval',
  target: {
    tenantId: 'tenant_primary',
    resourceType: 'event' as const,
    resourceId: 'event_primary',
    resourceVersion: 7,
    apiOperation: 'events.publish' as const,
  },
  payload: { readinessSnapshotSha256: 'a'.repeat(64) },
  idempotencyKey: 'agent-action-route-0001',
  expectedPolicyVersion: 3,
  preparedAt: '2026-07-14T12:00:00.000Z',
} satisfies AgentAction;
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
const readinessPrepared: PreparedAgentReadinessAction = {
  action: {
    ...action,
    id: `act_${'e'.repeat(48)}`,
    kind: 'readiness.read',
    autonomy: 'read',
    target: { ...action.target, apiOperation: 'events.readiness.get' },
  },
  actionDigest: 'd'.repeat(64),
  expiresAt: '2026-07-14T12:15:00.000Z',
  authorization: {
    allowed: true,
    eligibleForApproval: false,
    reasons: [],
    snapshotSha256: 'c'.repeat(64),
    checkedAt: '2026-07-14T12:00:00.000Z',
  },
  dryRun: {
    launchable: true,
    readinessSnapshotSha256: 'a'.repeat(64),
    blockingReasonCodes: [],
  },
  result: {
    resourceId: 'event_primary',
    resourceVersion: 7,
    status: 'ready',
    readinessSnapshotSha256: 'a'.repeat(64),
    generatedAt: '2026-07-14T12:00:00.000Z',
    published: false,
    blockerReasonCodes: [],
    warningReasonCodes: [],
  },
  resultSha256: 'f'.repeat(64),
};
const eventReadPrepared: PreparedAgentEventReadAction = {
  action: {
    ...action,
    id: `act_${'7'.repeat(48)}`,
    kind: 'event.read',
    autonomy: 'read',
    target: { ...action.target, apiOperation: 'events.get' },
    payload: { eventSnapshotSha256: '8'.repeat(64) },
  },
  actionDigest: '9'.repeat(64),
  expiresAt: '2026-07-14T12:15:00.000Z',
  authorization: {
    allowed: true,
    eligibleForApproval: false,
    reasons: [],
    snapshotSha256: 'c'.repeat(64),
    checkedAt: '2026-07-14T12:00:00.000Z',
  },
  result: {
    resourceId: 'event_primary',
    resourceVersion: 7,
    eventSnapshotSha256: '8'.repeat(64),
    observedAt: '2026-07-14T12:00:00.000Z',
    event: {
      title: 'Summer Showcase',
      description: 'Organizer-authored event details.',
      status: 'draft',
      currency: 'USD',
      timezone: 'America/Chicago',
      startsAt: '2026-07-14T12:00:00.000Z',
      endsAt: '2026-07-14T12:30:00.000Z',
      visibility: 'unlisted',
      capacity: 500,
      minimumAge: null,
    },
    untrustedContentPaths: ['event.title', 'event.description'],
  },
  resultSha256: '6'.repeat(64),
};
const eventPreparePrepared: PreparedAgentEventPrepareAction = {
  action: {
    ...action,
    id: `act_${'4'.repeat(48)}`,
    kind: 'event.prepare',
    autonomy: 'prepare',
    target: { ...action.target, apiOperation: 'events.prepare' },
    payload: {
      changePreviewSha256: '3'.repeat(64),
      changes: { description: 'Prepared description', title: 'Prepared title' },
    },
  },
  actionDigest: '2'.repeat(64),
  expiresAt: '2026-07-14T12:15:00.000Z',
  authorization: {
    allowed: true,
    eligibleForApproval: false,
    reasons: [],
    snapshotSha256: '1'.repeat(64),
    checkedAt: '2026-07-14T12:00:00.000Z',
  },
  result: {
    resourceId: 'event_primary',
    resourceVersion: 7,
    changePreviewSha256: '3'.repeat(64),
    observedAt: '2026-07-14T12:00:00.000Z',
    changedFields: ['description', 'title'],
    before: { description: null, title: 'Original title' },
    after: { description: 'Prepared description', title: 'Prepared title' },
    untrustedContentPaths: [
      'before.description',
      'after.description',
      'before.title',
      'after.title',
    ],
  },
  resultSha256: '0'.repeat(64),
};
const executionEvidence: AgentExecutionEvidence = {
  execution: {
    id: `exec_${'f'.repeat(48)}`,
    tenantId: 'tenant_primary',
    actionId: `act_${'d'.repeat(48)}`,
    actionDigest: 'b'.repeat(64),
    agentPrincipalId: 'agent_primary',
    sponsorPrincipalId: 'user_primary',
    delegationGrantId: 'dlg_primary',
    approvalId: `apr_${'e'.repeat(48)}`,
    idempotencyKey: '1'.repeat(64),
    requestFingerprint: '2'.repeat(64),
    state: 'succeeded',
    resourceVersion: 7,
    policyVersion: 3,
    fenceToken: 1,
    result: { resourceId: 'event_primary', resourceVersion: 8, status: 'published' },
    createdAt: '2026-07-14T12:02:00.000Z',
    updatedAt: '2026-07-14T12:02:01.000Z',
  },
  audit: (['prepared', 'authorized', 'started', 'succeeded'] as const).map((phase, index) => ({
    id: `aaud_${String(index + 1).repeat(48)}`,
    tenantId: 'tenant_primary',
    agentPrincipalId: 'agent_primary',
    sponsorPrincipalId: 'user_primary',
    delegationGrantId: 'dlg_primary',
    actionId: `act_${'d'.repeat(48)}`,
    actionDigest: 'b'.repeat(64),
    approvalId: `apr_${'e'.repeat(48)}`,
    phase,
    idempotencyKey: '1'.repeat(64),
    resourceVersion: 7,
    occurredAt: `2026-07-14T12:02:0${index}.000Z`,
    reasonCodes: [],
  })),
};

function principal(type: Principal['type'] = 'agent'): Principal {
  return {
    id: type === 'agent' ? 'agent_primary' : 'user_primary',
    type,
    tenantId: 'tenant_primary',
    organizationIds: [],
    brandIds: [],
    eventIds: [],
    scopes: type === 'user' ? ['events.write'] : [],
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
    getForSponsor: vi.fn(async () => prepared),
    approve: vi.fn(async (input) => ({
      id: `apr_${'e'.repeat(48)}`,
      tenantId: input.tenantId,
      actionDigest: input.actionDigest,
      approverPrincipalId: input.approverPrincipalId,
      approverPermissionSnapshot: ['events:publish'],
      policyVersion: 3,
      approvedAt: '2026-07-14T12:01:00.000Z',
      expiresAt: '2026-07-14T12:06:00.000Z',
    })),
    revokeApproval: vi.fn(async (input) => ({
      id: input.approvalId,
      tenantId: input.tenantId,
      actionDigest: input.actionDigest,
      approverPrincipalId: input.sponsorPrincipalId,
      approverPermissionSnapshot: ['events:publish'],
      policyVersion: 3,
      approvedAt: '2026-07-14T12:01:00.000Z',
      expiresAt: '2026-07-14T12:06:00.000Z',
      revokedAt: '2026-07-14T12:02:00.000Z',
    })),
    execute: vi.fn(async (input) => ({
      id: `exec_${'f'.repeat(48)}`,
      tenantId: input.tenantId,
      actionId: input.actionId,
      actionDigest: input.actionDigest,
      agentPrincipalId: input.agentPrincipalId,
      sponsorPrincipalId: 'user_sponsor',
      delegationGrantId: 'dlg_primary',
      approvalId: input.approvalId,
      idempotencyKey: 'agent-action-route-0001',
      requestFingerprint: 'f'.repeat(64),
      state: 'succeeded' as const,
      resourceVersion: 8,
      policyVersion: 3,
      fenceToken: 1,
      result: { resourceId: 'event_primary', resourceVersion: 8, status: 'published' },
      createdAt: '2026-07-14T12:02:00.000Z',
      updatedAt: '2026-07-14T12:02:01.000Z',
    })),
    getExecutionForAgent: vi.fn(async () => executionEvidence),
    getExecutionForSponsor: vi.fn(async () => executionEvidence),
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

  it('accepts readiness.read without caller-supplied result or identity fields', async () => {
    const prepare = vi.fn(async () => readinessPrepared);
    const { app } = await setup({ service: { prepare } });
    const response = await app.inject({
      method: 'POST',
      url: '/agent/readiness',
      headers: { 'idempotency-key': 'agent-readiness-route-0001' },
      payload: {
        delegationGrantId: 'dlg_primary',
        resourceId: 'event_primary',
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(prepare).toHaveBeenCalledWith({
      tenantId: 'tenant_primary',
      agentPrincipalId: 'agent_primary',
      idempotencyKey: 'agent-readiness-route-0001',
      kind: 'readiness.read',
      delegationGrantId: 'dlg_primary',
      resourceId: 'event_primary',
    });
    expect(response.json()).toEqual(JSON.parse(JSON.stringify(readinessPrepared)));
    await app.close();
  });

  it('accepts event.read only through the dedicated direct-read route', async () => {
    const prepare = vi.fn(async () => eventReadPrepared);
    const { app } = await setup({ service: { prepare } });
    const response = await app.inject({
      method: 'POST',
      url: '/agent/events',
      headers: { 'idempotency-key': 'agent-event-read-route-0001' },
      payload: {
        delegationGrantId: 'dlg_primary',
        resourceId: 'event_primary',
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(prepare).toHaveBeenCalledWith({
      tenantId: 'tenant_primary',
      agentPrincipalId: 'agent_primary',
      idempotencyKey: 'agent-event-read-route-0001',
      kind: 'event.read',
      delegationGrantId: 'dlg_primary',
      resourceId: 'event_primary',
    });
    expect(response.json()).toEqual(JSON.parse(JSON.stringify(eventReadPrepared)));
    await app.close();
  });

  it('accepts strict event.prepare changes only through its direct preparation route', async () => {
    const prepare = vi.fn(async () => eventPreparePrepared);
    const { app } = await setup({ service: { prepare } });
    const response = await app.inject({
      method: 'POST',
      url: '/agent/event-preparations',
      headers: { 'idempotency-key': 'agent-event-prepare-route-0001' },
      payload: {
        delegationGrantId: 'dlg_primary',
        resourceId: 'event_primary',
        changes: { title: 'Prepared title', description: 'Prepared description' },
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(prepare).toHaveBeenCalledWith({
      tenantId: 'tenant_primary',
      agentPrincipalId: 'agent_primary',
      idempotencyKey: 'agent-event-prepare-route-0001',
      kind: 'event.prepare',
      delegationGrantId: 'dlg_primary',
      resourceId: 'event_primary',
      changes: { title: 'Prepared title', description: 'Prepared description' },
    });
    expect(response.json()).toEqual(JSON.parse(JSON.stringify(eventPreparePrepared)));

    for (const changes of [
      {},
      { status: 'published' },
      { title: 'Changed', extra: true },
      { venue: { address: { line1: 'Unsafe\u0000venue' } } },
      { externalUrl: `https://example.test/${'x'.repeat(2048)}` },
      { coverImageUrl: `https://example.test/${'x'.repeat(2048)}` },
      { seo: { imageUrl: `https://example.test/${'x'.repeat(2048)}` } },
    ]) {
      const invalid = await app.inject({
        method: 'POST',
        url: '/agent/event-preparations',
        headers: { 'idempotency-key': 'agent-event-prepare-invalid-0001' },
        payload: { delegationGrantId: 'dlg_primary', resourceId: 'event_primary', changes },
      });
      expect(invalid.statusCode).toBe(400);
    }
    expect(prepare).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('keeps event publish preparation closed to readiness requests', async () => {
    const { app, service } = await setup();
    const response = await app.inject({
      method: 'POST',
      url: '/agent/actions',
      headers: { 'idempotency-key': 'agent-readiness-wrong-route-0001' },
      payload: {
        kind: 'readiness.read',
        delegationGrantId: 'dlg_primary',
        resourceId: 'event_primary',
      },
    });
    expect(response.statusCode).toBe(400);
    expect(service.prepare).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns direct readiness evidence only from its dedicated retrieval route', async () => {
    const getForAgent = vi.fn(async () => readinessPrepared);
    const { app } = await setup({ service: { getForAgent } });
    const actionId = readinessPrepared.action.id;
    const readinessResponse = await app.inject({
      method: 'GET',
      url: `/agent/readiness/${actionId}`,
    });
    expect(readinessResponse.statusCode).toBe(200);
    expect(readinessResponse.headers['cache-control']).toBe('no-store');
    expect(readinessResponse.json()).toEqual(JSON.parse(JSON.stringify(readinessPrepared)));
    const publishResponse = await app.inject({
      method: 'GET',
      url: `/agent/actions/${actionId}`,
    });
    expect(publishResponse.statusCode).toBe(404);
    await app.close();
  });

  it('returns event.read evidence only from its dedicated retrieval route', async () => {
    const getForAgent = vi.fn(async () => eventReadPrepared);
    const { app } = await setup({ service: { getForAgent } });
    const actionId = eventReadPrepared.action.id;
    const eventResponse = await app.inject({
      method: 'GET',
      url: `/agent/events/${actionId}`,
    });
    expect(eventResponse.statusCode).toBe(200);
    expect(eventResponse.headers['cache-control']).toBe('no-store');
    expect(eventResponse.json()).toEqual(JSON.parse(JSON.stringify(eventReadPrepared)));
    expect(
      (await app.inject({ method: 'GET', url: `/agent/actions/${actionId}` })).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: 'GET', url: `/agent/readiness/${actionId}` })).statusCode,
    ).toBe(404);
    await app.close();
  });

  it('returns event.prepare evidence only from its dedicated retrieval route', async () => {
    const getForAgent = vi.fn(async () => eventPreparePrepared);
    const { app } = await setup({ service: { getForAgent } });
    const actionId = eventPreparePrepared.action.id;
    const response = await app.inject({
      method: 'GET',
      url: `/agent/event-preparations/${actionId}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual(JSON.parse(JSON.stringify(eventPreparePrepared)));
    expect(
      (await app.inject({ method: 'GET', url: `/agent/actions/${actionId}` })).statusCode,
    ).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/agent/events/${actionId}` })).statusCode).toBe(
      404,
    );
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

  it('lets the human sponsor load the exact action through live sponsor authorization', async () => {
    const getForSponsor = vi.fn(async () => prepared);
    const { app } = await setup({ actor: principal('user'), service: { getForSponsor } });
    const actionId = `act_${'d'.repeat(48)}`;
    const response = await app.inject({ method: 'GET', url: `/agent/actions/${actionId}` });
    expect(response.statusCode).toBe(200);
    expect(getForSponsor).toHaveBeenCalledWith({
      tenantId: 'tenant_primary',
      sponsorPrincipalId: 'user_primary',
      actionId,
    });
    await app.close();
  });

  it('requires a human, exact digest confirmation and idempotency for approval', async () => {
    const approve = vi.fn(async (input) => ({
      id: `apr_${'e'.repeat(48)}`,
      tenantId: input.tenantId,
      actionDigest: input.actionDigest,
      approverPrincipalId: input.approverPrincipalId,
      approverPermissionSnapshot: ['events:publish'],
      policyVersion: 3,
      approvedAt: '2026-07-14T12:01:00.000Z',
      expiresAt: '2026-07-14T12:06:00.000Z',
    }));
    const { app } = await setup({ actor: principal('user'), service: { approve } });
    const actionId = `act_${'d'.repeat(48)}`;
    const actionDigest = 'b'.repeat(64);
    const response = await app.inject({
      method: 'POST',
      url: `/agent/actions/${actionId}/approvals`,
      headers: {
        'idempotency-key': 'agent-action-approval-0001',
        'x-tixkit-confirmation': `approve:${actionId}:${actionDigest}`,
      },
      payload: { actionDigest },
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(approve).toHaveBeenCalledWith({
      tenantId: 'tenant_primary',
      approverPrincipalId: 'user_primary',
      actionId,
      actionDigest,
      idempotencyKey: 'agent-action-approval-0001',
    });
    await app.close();
  });

  it('binds a planned approval body and confirmation to the authoritative plan digest', async () => {
    const approve = vi.fn(async (input) => ({
      id: `apr_${'e'.repeat(48)}`,
      tenantId: input.tenantId,
      actionDigest: input.actionDigest,
      planSha256: input.planSha256,
      approverPrincipalId: input.approverPrincipalId,
      approverPermissionSnapshot: ['events:publish'],
      policyVersion: 3,
      approvedAt: '2026-07-14T12:01:00.000Z',
      expiresAt: '2026-07-14T12:06:00.000Z',
    }));
    const { app } = await setup({ actor: principal('user'), service: { approve } });
    const actionId = `act_${'d'.repeat(48)}`;
    const actionDigest = 'b'.repeat(64);
    const planSha256 = 'c'.repeat(64);
    const response = await app.inject({
      method: 'POST',
      url: `/agent/actions/${actionId}/approvals`,
      headers: {
        'idempotency-key': 'agent-plan-approval-0001',
        'x-tixkit-confirmation': `approve:${actionId}:${actionDigest}:${planSha256}`,
      },
      payload: { actionDigest, planSha256 },
    });
    expect(response.statusCode).toBe(201);
    expect(approve).toHaveBeenCalledWith({
      tenantId: 'tenant_primary',
      approverPrincipalId: 'user_primary',
      actionId,
      actionDigest,
      planSha256,
      idempotencyKey: 'agent-plan-approval-0001',
    });
    await app.close();
  });

  it('rejects agent approval and mismatched human confirmation before the service', async () => {
    const approve = vi.fn();
    const agentSetup = await setup({ service: { approve } });
    const actionId = `act_${'d'.repeat(48)}`;
    const actionDigest = 'b'.repeat(64);
    const agentResponse = await agentSetup.app.inject({
      method: 'POST',
      url: `/agent/actions/${actionId}/approvals`,
      headers: {
        'idempotency-key': 'agent-action-approval-0001',
        'x-tixkit-confirmation': `approve:${actionId}:${actionDigest}`,
      },
      payload: { actionDigest },
    });
    expect(agentResponse.statusCode).toBe(403);
    await agentSetup.app.close();

    const humanSetup = await setup({ actor: principal('user'), service: { approve } });
    const humanResponse = await humanSetup.app.inject({
      method: 'POST',
      url: `/agent/actions/${actionId}/approvals`,
      headers: {
        'idempotency-key': 'agent-action-approval-0001',
        'x-tixkit-confirmation': `approve:${actionId}:${'c'.repeat(64)}`,
      },
      payload: { actionDigest },
    });
    expect(humanResponse.statusCode).toBe(400);
    expect(approve).not.toHaveBeenCalled();
    await humanSetup.app.close();
  });

  it('lets the exact human sponsor revoke after permission loss with bound confirmation', async () => {
    const actor = { ...principal('user'), scopes: [] };
    const revokeApproval = vi.fn(async (input) => ({
      id: input.approvalId,
      tenantId: input.tenantId,
      actionDigest: input.actionDigest,
      approverPrincipalId: input.sponsorPrincipalId,
      approverPermissionSnapshot: ['events:publish'] as const,
      policyVersion: 3,
      approvedAt: '2026-07-14T12:01:00.000Z',
      expiresAt: '2026-07-14T12:06:00.000Z',
      revokedAt: '2026-07-14T12:02:00.000Z',
    }));
    const { app } = await setup({ actor, service: { revokeApproval } });
    const actionId = `act_${'d'.repeat(48)}`;
    const approvalId = `apr_${'e'.repeat(48)}`;
    const actionDigest = 'b'.repeat(64);
    const response = await app.inject({
      method: 'POST',
      url: `/agent/actions/${actionId}/approvals/${approvalId}/revoke`,
      headers: {
        'idempotency-key': 'agent-action-revocation-0001',
        'x-tixkit-confirmation': `revoke:${actionId}:${approvalId}:${actionDigest}`,
      },
      payload: { actionDigest },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(revokeApproval).toHaveBeenCalledWith({
      tenantId: 'tenant_primary',
      sponsorPrincipalId: 'user_primary',
      actionId,
      approvalId,
      actionDigest,
      idempotencyKey: 'agent-action-revocation-0001',
    });
    await app.close();
  });

  it('rejects agent revocation and mismatched confirmation before the service', async () => {
    const revokeApproval = vi.fn();
    const actionId = `act_${'d'.repeat(48)}`;
    const approvalId = `apr_${'e'.repeat(48)}`;
    const actionDigest = 'b'.repeat(64);
    const agentSetup = await setup({ service: { revokeApproval } });
    const denied = await agentSetup.app.inject({
      method: 'POST',
      url: `/agent/actions/${actionId}/approvals/${approvalId}/revoke`,
      headers: {
        'idempotency-key': 'agent-action-revocation-0001',
        'x-tixkit-confirmation': `revoke:${actionId}:${approvalId}:${actionDigest}`,
      },
      payload: { actionDigest },
    });
    expect(denied.statusCode).toBe(403);
    await agentSetup.app.close();

    const humanSetup = await setup({ actor: principal('user'), service: { revokeApproval } });
    const invalid = await humanSetup.app.inject({
      method: 'POST',
      url: `/agent/actions/${actionId}/approvals/${approvalId}/revoke`,
      headers: {
        'idempotency-key': 'agent-action-revocation-0001',
        'x-tixkit-confirmation': `revoke:${actionId}:${approvalId}:${'c'.repeat(64)}`,
      },
      payload: { actionDigest },
    });
    expect(invalid.statusCode).toBe(400);
    expect(revokeApproval).not.toHaveBeenCalled();
    await humanSetup.app.close();
  });

  it('executes only as the exact agent with approval-bound confirmation', async () => {
    const execute = vi.fn(async (input) => ({
      id: `exec_${'f'.repeat(48)}`,
      tenantId: input.tenantId,
      actionId: input.actionId,
      actionDigest: input.actionDigest,
      agentPrincipalId: input.agentPrincipalId,
      sponsorPrincipalId: 'user_sponsor',
      delegationGrantId: 'dlg_primary',
      approvalId: input.approvalId,
      idempotencyKey: 'agent-action-route-0001',
      requestFingerprint: 'f'.repeat(64),
      state: 'succeeded' as const,
      resourceVersion: 8,
      policyVersion: 3,
      fenceToken: 1,
      result: { resourceId: 'event_primary', resourceVersion: 8, status: 'published' },
      createdAt: '2026-07-14T12:02:00.000Z',
      updatedAt: '2026-07-14T12:02:01.000Z',
    }));
    const { app } = await setup({ service: { execute } });
    const actionId = `act_${'d'.repeat(48)}`;
    const approvalId = `apr_${'e'.repeat(48)}`;
    const actionDigest = 'b'.repeat(64);
    const response = await app.inject({
      method: 'POST',
      url: `/agent/actions/${actionId}/executions`,
      headers: {
        'idempotency-key': `execute:${actionId}:${approvalId}:${actionDigest}`,
        'x-tixkit-confirmation': `execute:${actionId}:${approvalId}:${actionDigest}`,
      },
      payload: { approvalId, actionDigest },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(execute).toHaveBeenCalledWith({
      tenantId: 'tenant_primary',
      agentPrincipalId: 'agent_primary',
      actionId,
      approvalId,
      actionDigest,
    });
    await app.close();
  });

  it('returns immutable execution audit evidence to the exact agent or sponsor', async () => {
    const actionId = `act_${'d'.repeat(48)}`;
    const executionId = `exec_${'f'.repeat(48)}`;
    const agentLookup = vi.fn(async () => executionEvidence);
    const agent = await setup({ service: { getExecutionForAgent: agentLookup } });
    const agentResponse = await agent.app.inject({
      method: 'GET',
      url: `/agent/actions/${actionId}/executions/${executionId}`,
    });
    expect(agentResponse.statusCode).toBe(200);
    expect(agentResponse.headers['cache-control']).toBe('no-store');
    expect(agentResponse.json()).toEqual(executionEvidence);
    expect(agentLookup).toHaveBeenCalledWith({
      tenantId: 'tenant_primary',
      agentPrincipalId: 'agent_primary',
      actionId,
      executionId,
    });
    await agent.app.close();

    const sponsorLookup = vi.fn(async () => executionEvidence);
    const sponsor = await setup({
      actor: { ...principal('user'), scopes: [] },
      service: { getExecutionForSponsor: sponsorLookup },
    });
    const sponsorResponse = await sponsor.app.inject({
      method: 'GET',
      url: `/agent/actions/${actionId}/executions/${executionId}`,
    });
    expect(sponsorResponse.statusCode).toBe(200);
    expect(sponsorLookup).toHaveBeenCalledWith({
      tenantId: 'tenant_primary',
      sponsorPrincipalId: 'user_primary',
      actionId,
      executionId,
    });
    await sponsor.app.close();
  });

  it('returns not found for execution evidence outside the caller scope', async () => {
    const { app } = await setup({
      service: { getExecutionForAgent: vi.fn(async () => undefined) },
    });
    const response = await app.inject({
      method: 'GET',
      url: `/agent/actions/act_${'d'.repeat(48)}/executions/exec_${'f'.repeat(48)}`,
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it('rejects human execution and changed agent confirmation before the service', async () => {
    const execute = vi.fn();
    const actionId = `act_${'d'.repeat(48)}`;
    const approvalId = `apr_${'e'.repeat(48)}`;
    const actionDigest = 'b'.repeat(64);
    const human = await setup({ actor: principal('user'), service: { execute } });
    const denied = await human.app.inject({
      method: 'POST',
      url: `/agent/actions/${actionId}/executions`,
      headers: {
        'idempotency-key': `execute:${actionId}:${approvalId}:${actionDigest}`,
        'x-tixkit-confirmation': `execute:${actionId}:${approvalId}:${actionDigest}`,
      },
      payload: { approvalId, actionDigest },
    });
    expect(denied.statusCode).toBe(403);
    await human.app.close();
    const agent = await setup({ service: { execute } });
    const invalid = await agent.app.inject({
      method: 'POST',
      url: `/agent/actions/${actionId}/executions`,
      headers: {
        'idempotency-key': `execute:${actionId}:${approvalId}:${actionDigest}`,
        'x-tixkit-confirmation': `execute:${actionId}:${approvalId}:${'c'.repeat(64)}`,
      },
      payload: { approvalId, actionDigest },
    });
    expect(invalid.statusCode).toBe(400);
    const ignoredPlanDigest = await agent.app.inject({
      method: 'POST',
      url: `/agent/actions/${actionId}/executions`,
      headers: {
        'idempotency-key': `execute:${actionId}:${approvalId}:${actionDigest}`,
        'x-tixkit-confirmation': `execute:${actionId}:${approvalId}:${actionDigest}`,
      },
      payload: { approvalId, actionDigest, planSha256: 'c'.repeat(64) },
    });
    expect(ignoredPlanDigest.statusCode).toBe(400);
    expect(execute).not.toHaveBeenCalled();
    await agent.app.close();
  });

  it('rejects missing and mismatched execution idempotency keys before the service', async () => {
    const execute = vi.fn();
    const actionId = `act_${'d'.repeat(48)}`;
    const approvalId = `apr_${'e'.repeat(48)}`;
    const actionDigest = 'b'.repeat(64);
    const confirmation = `execute:${actionId}:${approvalId}:${actionDigest}`;
    const { app } = await setup({ service: { execute } });

    const missing = await app.inject({
      method: 'POST',
      url: `/agent/actions/${actionId}/executions`,
      headers: { 'x-tixkit-confirmation': confirmation },
      payload: { approvalId, actionDigest },
    });
    expect(missing.statusCode).toBe(400);

    const mismatched = await app.inject({
      method: 'POST',
      url: `/agent/actions/${actionId}/executions`,
      headers: {
        'idempotency-key': `${confirmation}-changed`,
        'x-tixkit-confirmation': confirmation,
      },
      payload: { approvalId, actionDigest },
    });
    expect(mismatched.statusCode).toBe(400);
    expect(execute).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns conflict when approval or execution binding changes during reservation', async () => {
    const execute = vi.fn(async () => {
      throw new AgentExecutionConflictError('agent execution reservation conflicted');
    });
    const { app } = await setup({ service: { execute } });
    const actionId = `act_${'d'.repeat(48)}`;
    const approvalId = `apr_${'e'.repeat(48)}`;
    const actionDigest = 'b'.repeat(64);
    const response = await app.inject({
      method: 'POST',
      url: `/agent/actions/${actionId}/executions`,
      headers: {
        'idempotency-key': `execute:${actionId}:${approvalId}:${actionDigest}`,
        'x-tixkit-confirmation': `execute:${actionId}:${approvalId}:${actionDigest}`,
      },
      payload: { approvalId, actionDigest },
    });
    expect(response.statusCode).toBe(409);
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
