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
  const dashboardActionService = { getFeed: vi.fn() };
  app.decorate('context', {
    db: eventDb(event),
    readinessServiceFactory: () => readinessService,
    dashboardActionServiceFactory: () => dashboardActionService,
  } as unknown as AppContext);
  app.addHook('onRequest', async (request) => {
    request.principal = principal;
  });
  registerErrorHandler(app);
  await app.register(readinessRoutes);
  return { app, readinessService, dashboardActionService };
}

const event = {
  id: 'evt_1',
  tenant_id: 'tnt_1',
  organization_id: 'org_1',
  brand_id: 'brd_1',
};

describe('readiness route authorization', () => {
  it('rejects reads before computing readiness when events.read is absent', async () => {
    const { app, readinessService, dashboardActionService } = await createApp({
      type: 'user',
      id: 'usr_1',
      tenantId: 'tnt_1',
      organizationIds: ['org_1'],
      scopes: [],
    });
    const response = await app.inject({ method: 'GET', url: '/events/evt_1/launch-readiness' });
    expect(response.statusCode).toBe(403);
    expect(readinessService.getEventLaunchReadiness).not.toHaveBeenCalled();
    const feedResponse = await app.inject({
      method: 'GET',
      url: '/organizations/org_1/dashboard-actions?brandId=brd_1',
    });
    expect(feedResponse.statusCode).toBe(403);
    expect(dashboardActionService.getFeed).not.toHaveBeenCalled();
    await app.close();
  });

  it('projects scoped dashboard pagination through the server action service', async () => {
    const { app, dashboardActionService } = await createApp(
      {
        type: 'user',
        id: 'usr_1',
        tenantId: 'tnt_1',
        organizationIds: ['org_1'],
        brandIds: ['brd_1'],
        eventIds: ['evt_1'],
        scopes: ['events.read', 'checkins.write'],
      },
      event,
    );
    dashboardActionService.getFeed.mockResolvedValue({
      tenantId: 'tnt_1',
      organizationId: 'org_1',
      brandId: 'brd_1',
      evaluationVersion: 1,
      generatedAt: '2027-01-01T00:00:00.000Z',
      expiresAt: '2027-01-01T00:05:00.000Z',
      nextCursor: null,
      actions: [],
    });

    const response = await app.inject({
      method: 'GET',
      url: '/organizations/org_1/dashboard-actions?brandId=brd_1&limit=10',
    });

    expect(response.statusCode).toBe(200);
    expect(dashboardActionService.getFeed).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tnt_1',
        organizationId: 'org_1',
        brandId: 'brd_1',
        eventIds: ['evt_1'],
        limit: 10,
      }),
    );
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
