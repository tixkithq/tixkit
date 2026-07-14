import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { AppContext } from '../app.js';
import { registerErrorHandler } from '../app.js';
import { enforceAgentRouteAccess } from '../routes/registry.js';
import { agentSessionRoutes } from '../routes/modules/agent-session.js';

const agent = {
  type: 'agent' as const,
  id: 'agt_session_1',
  tenantId: 'tnt_session_1',
  organizationIds: [],
  scopes: [],
};

describe('agent route isolation', () => {
  it('denies agent principals by default and permits only explicit route opt-in', async () => {
    const app = Fastify({ logger: false });
    app.addHook('onRequest', async (request) => {
      request.principal = agent;
    });
    app.addHook('onRequest', enforceAgentRouteAccess);
    app.get('/generic', async () => ({ exposed: true }));
    app.get('/agent-only', { config: { agentAccess: true } }, async () => ({ allowed: true }));
    registerErrorHandler(app);

    const denied = await app.inject({ method: 'GET', url: '/generic' });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toMatchObject({
      code: 'FORBIDDEN',
      message: 'Agent principals cannot access this route',
    });
    const allowed = await app.inject({ method: 'GET', url: '/agent-only' });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toEqual({ allowed: true });
    await app.close();
  });

  it('returns a live agent session without deriving product permissions from its sponsor', async () => {
    const row = {
      id: agent.id,
      tenant_id: agent.tenantId,
      kind: 'third_party',
      sponsor_principal_id: 'usr_sponsor_1',
      capabilities: '["events.read","events.prepare"]',
      maximum_autonomy: 'prepare',
      protocol_version: '2026-07-01',
      state: 'active',
      registered_at: new Date('2026-07-01T00:00:00Z'),
      updated_at: new Date('2026-07-14T00:00:00Z'),
    };
    const query = {
      select: () => query,
      where: () => query,
      executeTakeFirst: async () => row,
    };
    const app = Fastify({ logger: false });
    app.decorate('context', {
      db: { selectFrom: () => query },
    } as unknown as AppContext);
    app.addHook('onRequest', async (request) => {
      request.principal = agent;
    });
    app.addHook('onRequest', enforceAgentRouteAccess);
    registerErrorHandler(app);
    await app.register(agentSessionRoutes);

    const response = await app.inject({ method: 'GET', url: '/agent/session' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      principal: {
        id: agent.id,
        tenantId: agent.tenantId,
        sponsorPrincipalId: 'usr_sponsor_1',
        capabilities: ['events.read', 'events.prepare'],
      },
      authentication: {
        grantType: 'client_credentials',
        scope: 'agent.invoke',
        productPermissions: [],
      },
      delegationRequired: true,
    });
    await app.close();
  });
});
