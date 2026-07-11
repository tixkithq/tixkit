import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@tixkit/db';
import type { Principal } from '@tixkit/domain';
import type { AppContext } from '../app.js';
import { registerErrorHandler } from '../app.js';
import { readinessRoutes } from '../routes/modules/readiness.js';

function eventDb(event: Record<string, unknown> | undefined): Database {
  return {
    selectFrom: () => {
      const query = {
        selectAll: () => query,
        where: () => query,
        executeTakeFirst: async () => event,
      };
      return query;
    },
  } as unknown as Database;
}

async function createApp(principal: Principal, event?: Record<string, unknown>) {
  const app = Fastify();
  const readinessService = {
    getEventLaunchReadiness: vi.fn(),
    getWorkspaceReadiness: vi.fn(),
    acknowledgementSubject: vi.fn(),
  };
  app.decorate('context', {
    db: eventDb(event),
    readinessServiceFactory: () => readinessService,
  } as unknown as AppContext);
  app.addHook('onRequest', async (request) => {
    request.principal = principal;
  });
  registerErrorHandler(app);
  await app.register(readinessRoutes);
  return { app, readinessService };
}

const event = {
  id: 'evt_1',
  tenant_id: 'tnt_1',
  organization_id: 'org_1',
  brand_id: 'brd_1',
};

describe('readiness route authorization', () => {
  it('rejects reads before computing readiness when events.read is absent', async () => {
    const { app, readinessService } = await createApp({
      type: 'user',
      id: 'usr_1',
      tenantId: 'tnt_1',
      organizationIds: ['org_1'],
      scopes: [],
    });
    const response = await app.inject({ method: 'GET', url: '/events/evt_1/launch-readiness' });
    expect(response.statusCode).toBe(403);
    expect(readinessService.getEventLaunchReadiness).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects acknowledgement writes before loading the event when events.write is absent', async () => {
    const { app, readinessService } = await createApp({
      type: 'user',
      id: 'usr_1',
      tenantId: 'tnt_1',
      organizationIds: ['org_1'],
      scopes: ['events.read'],
    });
    const response = await app.inject({
      method: 'POST',
      url: '/events/evt_1/readiness-acknowledgements/preview_review',
    });
    expect(response.statusCode).toBe(403);
    expect(readinessService.acknowledgementSubject).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    [{ tenantId: 'tnt_other', organizationIds: ['org_1'], brandIds: ['brd_1'] }, 404],
    [{ tenantId: 'tnt_1', organizationIds: ['org_other'], brandIds: ['brd_1'] }, 404],
    [{ tenantId: 'tnt_1', organizationIds: ['org_1'], brandIds: ['brd_other'] }, 404],
  ] as const)('rejects tenant, organization, and brand scope mismatches', async (scope, status) => {
    const { app, readinessService } = await createApp(
      {
        type: 'user',
        id: 'usr_1',
        tenantId: scope.tenantId,
        organizationIds: [...scope.organizationIds],
        brandIds: [...scope.brandIds],
        scopes: ['events.read'],
      },
      event,
    );
    const response = await app.inject({ method: 'GET', url: '/events/evt_1/launch-readiness' });
    expect(response.statusCode).toBe(status);
    expect(readinessService.getEventLaunchReadiness).not.toHaveBeenCalled();
    await app.close();
  });
});
