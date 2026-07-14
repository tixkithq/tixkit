import {
  AGENT_PROTOCOL_VERSION,
  type AgentDelegationGrant,
  type AgentPrincipal,
} from '@tixkit/agent-protocol';
import type { Principal } from '@tixkit/domain';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerErrorHandler } from '../app.js';
import {
  agentControlRoutes,
  type AgentControlRouteOptions,
  type AgentControlStore,
} from '../routes/modules/agent-control.js';

const tenantId = 'tenant_agent_route_01';
const sponsorId = 'user_agent_sponsor_01';
const now = new Date('2026-07-14T12:00:00.000Z');
const idempotencyKey = 'agent-route-idempotency-0001';

function sponsor(overrides: Partial<Principal> = {}): Principal {
  return {
    type: 'user',
    id: sponsorId,
    tenantId,
    organizationIds: ['org_agent_route_01'],
    scopes: ['developers.write', 'events.read', 'events.write'],
    ...overrides,
  };
}

function store(overrides: Partial<AgentControlStore> = {}): AgentControlStore {
  return {
    assertControlActor: vi.fn(async () => undefined),
    registerPrincipal: vi.fn(async (principal) => ({
      ...principal,
      registeredAt: now.toISOString(),
    })),
    getPrincipal: vi.fn(async () => undefined),
    revokePrincipal: vi.fn(async () => true),
    grantDelegation: vi.fn(async (delegation) => ({
      ...delegation,
      permissionSnapshot: ['events:read'],
      issuedAt: now.toISOString(),
    })),
    getDelegation: vi.fn(async () => undefined),
    revokeDelegation: vi.fn(async () => true),
    ...overrides,
  };
}

async function testApp(
  principal: Principal,
  repository: AgentControlStore,
  options: Omit<AgentControlRouteOptions, 'repository' | 'now'> = {},
) {
  const app = Fastify({ logger: false, genReqId: () => 'req_agent_control' });
  app.decorate('context', { db: {} } as never);
  app.addHook('preHandler', async (request) => {
    request.principal = principal;
  });
  registerErrorHandler(app);
  await app.register(agentControlRoutes, {
    ...options,
    repository,
    now: () => now,
  });
  return app;
}

const registration = {
  id: 'organizer_helper',
  kind: 'third_party' as const,
  capabilities: ['events.read'] as const,
  maximumAutonomy: 'read' as const,
};

describe('agent control routes', () => {
  it('registers an explicit tenant-namespaced principal with server-owned identity fields', async () => {
    const repository = store();
    const app = await testApp(sponsor(), repository);
    const response = await app.inject({
      method: 'POST',
      url: '/agent-principals',
      headers: { 'idempotency-key': idempotencyKey },
      payload: registration,
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body).toMatchObject({
      kind: 'third_party',
      tenantId,
      sponsorPrincipalId: sponsorId,
      protocolVersion: AGENT_PROTOCOL_VERSION,
      state: 'active',
      registeredAt: now.toISOString(),
    });
    expect(body.id).toMatch(/^agt_[a-f0-9]{48}$/u);
    expect(repository.registerPrincipal).toHaveBeenCalledWith(
      expect.objectContaining({
        id: body.id,
        tenantId,
        sponsorPrincipalId: sponsorId,
        registeredAt: '1970-01-01T00:00:00.000Z',
      }),
      expect.objectContaining({
        actorPrincipalId: sponsorId,
        reasonCode: 'PLATFORM_AGENT_PRINCIPAL_REGISTER',
        idempotencyKey,
      }),
    );
    await app.close();
  });

  it('namespaces the same client reference independently for each tenant and sponsor', async () => {
    const first = store();
    const second = store();
    const third = store();
    const firstApp = await testApp(sponsor(), first);
    const secondApp = await testApp(
      sponsor({ tenantId: 'tenant_agent_route_02', id: 'user_agent_sponsor_02' }),
      second,
    );
    const thirdApp = await testApp(sponsor({ id: 'user_agent_sponsor_03' }), third);
    const request = {
      method: 'POST' as const,
      url: '/agent-principals',
      headers: { 'idempotency-key': idempotencyKey },
      payload: registration,
    };
    const firstId = (await firstApp.inject(request)).json().id;
    const secondId = (await secondApp.inject(request)).json().id;
    const thirdId = (await thirdApp.inject(request)).json().id;
    expect(firstId).not.toBe(secondId);
    expect(firstId).not.toBe(thirdId);
    await firstApp.close();
    await secondApp.close();
    await thirdApp.close();
  });

  it.each([
    sponsor({ type: 'api_key' as never }),
    sponsor({ type: 'mobile_device' as never }),
    sponsor({ type: 'system' as never }),
    sponsor({ scopes: ['events.read', 'events.write'] }),
    sponsor({ eventIds: ['evt_scoped_01'] }),
    sponsor({ brandIds: ['brand_scoped_01'] }),
  ])('denies non-human, underprivileged, and resource-scoped actors', async (principal) => {
    const repository = store();
    const app = await testApp(principal, repository);
    const response = await app.inject({
      method: 'POST',
      url: '/agent-principals',
      headers: { 'idempotency-key': idempotencyKey },
      payload: registration,
    });
    expect(response.statusCode).toBe(403);
    expect(repository.registerPrincipal).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects server-owned fields, unsupported deployment kinds, and weak idempotency keys', async () => {
    const repository = store();
    const app = await testApp(sponsor(), repository);
    const serverOwned = await app.inject({
      method: 'POST',
      url: '/agent-principals',
      headers: { 'idempotency-key': idempotencyKey },
      payload: { ...registration, tenantId, registeredAt: now.toISOString() },
    });
    expect(serverOwned.statusCode).toBe(400);
    const selfHosted = await app.inject({
      method: 'POST',
      url: '/agent-principals',
      headers: { 'idempotency-key': idempotencyKey },
      payload: { ...registration, kind: 'self_hosted' },
    });
    expect(selfHosted.statusCode).toBe(403);
    const weakKey = await app.inject({
      method: 'POST',
      url: '/agent-principals',
      headers: { 'idempotency-key': 'short' },
      payload: registration,
    });
    expect(weakKey.statusCode).toBe(400);
    expect(repository.registerPrincipal).not.toHaveBeenCalled();
    await app.close();
  });

  it('rechecks tenant-wide database authorization before reading a sponsored principal', async () => {
    const principalId = `agt_${'a'.repeat(48)}`;
    const repository = store({
      assertControlActor: vi.fn(async () => {
        throw new Error('AGENT_CONTROL_ACTOR_DENIED');
      }),
      getPrincipal: vi.fn(async () => undefined),
    });
    const app = await testApp(sponsor(), repository);
    const response = await app.inject({ method: 'GET', url: `/agent-principals/${principalId}` });
    expect(response.statusCode).toBe(403);
    expect(repository.getPrincipal).not.toHaveBeenCalled();
    await app.close();
  });

  it('derives delegation authority and issuance in the repository contract', async () => {
    const principalId = `agt_${'a'.repeat(48)}`;
    const registeredPrincipal: AgentPrincipal = {
      id: principalId,
      tenantId,
      sponsorPrincipalId: sponsorId,
      kind: 'third_party',
      capabilities: ['events.read'],
      maximumAutonomy: 'read',
      protocolVersion: AGENT_PROTOCOL_VERSION,
      state: 'active',
      registeredAt: now.toISOString(),
    };
    const repository = store({
      getPrincipal: vi.fn(async () => registeredPrincipal),
    });
    const app = await testApp(sponsor(), repository);
    const response = await app.inject({
      method: 'POST',
      url: '/agent-delegations',
      headers: { 'idempotency-key': idempotencyKey },
      payload: {
        id: 'event_reader',
        agentPrincipalId: principalId,
        capabilities: ['events.read'],
        resourceScopes: ['event:event_agent_route_01'],
        expiresAt: '2026-07-15T12:00:00.000Z',
      },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as AgentDelegationGrant;
    expect(body.id).toMatch(/^dlg_[a-f0-9]{48}$/u);
    expect(body).toMatchObject({
      tenantId,
      sponsorPrincipalId: sponsorId,
      permissionSnapshot: ['events:read'],
      issuedAt: now.toISOString(),
    });
    expect(repository.grantDelegation).toHaveBeenCalledWith(
      expect.objectContaining({
        id: body.id,
        permissionSnapshot: [],
        issuedAt: '1970-01-01T00:00:00.000Z',
      }),
      expect.objectContaining({ reasonCode: 'PLATFORM_AGENT_DELEGATION_GRANT' }),
    );
    await app.close();
  });

  it('rejects forged delegation fields, excessive lifetime, and missing live capability grants', async () => {
    const repository = store();
    const app = await testApp(sponsor({ scopes: ['developers.write', 'events.read'] }), repository);
    const principalId = `agt_${'a'.repeat(48)}`;
    const forged = await app.inject({
      method: 'POST',
      url: '/agent-delegations',
      headers: { 'idempotency-key': idempotencyKey },
      payload: {
        id: 'event_writer',
        agentPrincipalId: principalId,
        capabilities: ['events.execute'],
        resourceScopes: ['event:event_agent_route_01'],
        permissionSnapshot: ['events:publish'],
        issuedAt: now.toISOString(),
        expiresAt: '2026-07-15T12:00:00.000Z',
      },
    });
    expect(forged.statusCode).toBe(400);
    const excessive = await app.inject({
      method: 'POST',
      url: '/agent-delegations',
      headers: { 'idempotency-key': idempotencyKey },
      payload: {
        id: 'event_reader',
        agentPrincipalId: principalId,
        capabilities: ['events.read'],
        resourceScopes: ['event:event_agent_route_01'],
        expiresAt: '2026-08-14T12:00:00.001Z',
      },
    });
    expect(excessive.statusCode).toBe(400);
    const denied = await app.inject({
      method: 'POST',
      url: '/agent-delegations',
      headers: { 'idempotency-key': idempotencyKey },
      payload: {
        id: 'event_writer',
        agentPrincipalId: principalId,
        capabilities: ['events.execute'],
        resourceScopes: ['event:event_agent_route_01'],
        expiresAt: '2026-07-15T12:00:00.000Z',
      },
    });
    expect(denied.statusCode).toBe(403);
    expect(repository.grantDelegation).not.toHaveBeenCalled();
    await app.close();
  });

  it('hides cross-sponsor principal and delegation resources during reads and revocation', async () => {
    const foreignPrincipal = {
      id: `agt_${'b'.repeat(48)}`,
      tenantId,
      sponsorPrincipalId: 'user_other_sponsor',
      kind: 'third_party' as const,
      capabilities: ['events.read'] as const,
      maximumAutonomy: 'read' as const,
      protocolVersion: AGENT_PROTOCOL_VERSION,
      state: 'active' as const,
      registeredAt: now.toISOString(),
    };
    const foreignDelegation: AgentDelegationGrant = {
      id: `dlg_${'c'.repeat(48)}`,
      tenantId,
      agentPrincipalId: foreignPrincipal.id,
      sponsorPrincipalId: 'user_other_sponsor',
      capabilities: ['events.read'],
      resourceScopes: ['event:event_agent_route_01'],
      permissionSnapshot: ['events:read'],
      issuedAt: now.toISOString(),
      expiresAt: '2026-07-15T12:00:00.000Z',
    };
    const repository = store({
      getPrincipal: vi.fn(async () => foreignPrincipal),
      getDelegation: vi.fn(async () => foreignDelegation),
    });
    const app = await testApp(sponsor(), repository);
    for (const request of [
      { method: 'GET' as const, url: `/agent-principals/${foreignPrincipal.id}` },
      {
        method: 'POST' as const,
        url: `/agent-principals/${foreignPrincipal.id}/revoke`,
        headers: { 'idempotency-key': idempotencyKey },
      },
      {
        method: 'POST' as const,
        url: `/agent-delegations/${foreignDelegation.id}/revoke`,
        headers: { 'idempotency-key': idempotencyKey },
      },
    ]) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(404);
    }
    expect(repository.revokePrincipal).not.toHaveBeenCalled();
    expect(repository.revokeDelegation).not.toHaveBeenCalled();
    await app.close();
  });

  it('maps repository authorization and idempotency changes to fail-closed responses', async () => {
    const conflictStore = store({
      registerPrincipal: vi.fn(async () => {
        throw new Error('AGENT_CONTROL_IDEMPOTENCY_CONFLICT');
      }),
    });
    const conflictApp = await testApp(sponsor(), conflictStore);
    const conflict = await conflictApp.inject({
      method: 'POST',
      url: '/agent-principals',
      headers: { 'idempotency-key': idempotencyKey },
      payload: registration,
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
    await conflictApp.close();

    const referenceStore = store({
      registerPrincipal: vi.fn(async () => {
        throw new Error('AGENT_CONTROL_REFERENCE_CONFLICT');
      }),
    });
    const referenceApp = await testApp(sponsor(), referenceStore);
    const referenceConflict = await referenceApp.inject({
      method: 'POST',
      url: '/agent-principals',
      headers: { 'idempotency-key': idempotencyKey },
      payload: registration,
    });
    expect(referenceConflict.statusCode).toBe(409);
    await referenceApp.close();

    const revokedStore = store({
      registerPrincipal: vi.fn(async () => {
        throw new Error('AGENT_CONTROL_ACTOR_DENIED');
      }),
    });
    const revokedApp = await testApp(sponsor(), revokedStore);
    const revoked = await revokedApp.inject({
      method: 'POST',
      url: '/agent-principals',
      headers: { 'idempotency-key': idempotencyKey },
      payload: registration,
    });
    expect(revoked.statusCode).toBe(403);
    await revokedApp.close();
  });
});
