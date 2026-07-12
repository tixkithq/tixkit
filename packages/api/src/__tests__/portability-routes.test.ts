import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Principal } from '@tixkit/domain';
import type { PortableExportService } from '../services/portable-export.js';

const { writeAuditLog } = vi.hoisted(() => ({
  writeAuditLog: vi.fn(async () => undefined),
}));
vi.mock('../auth/audit.js', () => ({ writeAuditLog }));

import { registerErrorHandler } from '../app.js';
import { portabilityRoutes } from '../routes/modules/portability.js';

const tenantId = 'tenant_portability_route_01';
const organizationId = 'org_portability_route_01';

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    type: 'user',
    id: 'user_portability_admin',
    tenantId,
    organizationIds: [organizationId],
    scopes: ['migrations.write'],
    ...overrides,
  };
}

async function testApp(input: { principal: Principal; service: PortableExportService }) {
  const app = Fastify();
  app.decorate('context', { db: {} } as never);
  app.addHook('preHandler', async (request) => {
    request.principal = input.principal;
  });
  registerErrorHandler(app);
  await app.register(portabilityRoutes, { exportService: input.service });
  return app;
}

describe('portable export route authorization and delivery', () => {
  beforeEach(() => writeAuditLog.mockClear());

  it.each([
    {
      name: 'missing permission',
      principal: principal({ scopes: ['migrations.read'] }),
      status: 403,
    },
    {
      name: 'different organization',
      principal: principal({ organizationIds: ['org_different_scope_01'] }),
      status: 404,
    },
    {
      name: 'event-scoped principal',
      principal: principal({ eventIds: ['event_scoped_01'] }),
      status: 403,
    },
    {
      name: 'brand-scoped principal',
      principal: principal({ brandIds: ['brand_scoped_01'] }),
      status: 403,
    },
  ])('denies $name before building or auditing', async ({ principal: deniedPrincipal, status }) => {
    const exportConfiguration = vi.fn();
    const app = await testApp({
      principal: deniedPrincipal,
      service: { exportConfiguration },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/portable-exports',
      headers: { 'idempotency-key': 'route-denial' },
      payload: { organizationId },
    });
    expect(response.statusCode).toBe(status);
    expect(exportConfiguration).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
    await app.close();
  });

  it.each(['', ' surrounded ', 'x'.repeat(256)])(
    'rejects malformed idempotency key %j before building',
    async (idempotencyKey) => {
      const exportConfiguration = vi.fn();
      const app = await testApp({
        principal: principal(),
        service: { exportConfiguration },
      });
      const response = await app.inject({
        method: 'POST',
        url: '/portable-exports',
        headers: { 'idempotency-key': idempotencyKey },
        payload: { organizationId },
      });
      expect(response.statusCode).toBe(400);
      expect(exportConfiguration).not.toHaveBeenCalled();
      await app.close();
    },
  );

  it('returns immutable bytes and audits every successful replay delivery', async () => {
    const bytes = new TextEncoder().encode('{"portable":true}');
    const exportConfiguration = vi.fn(async () => ({
      jobId: 'pex_route_01',
      bundleId: 'bundle_route_01',
      bytes,
    }));
    const app = await testApp({
      principal: principal(),
      service: { exportConfiguration },
    });
    for (let requestNumber = 0; requestNumber < 2; requestNumber += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/portable-exports',
        headers: { 'idempotency-key': 'route-replay' },
        payload: { organizationId },
      });
      expect(response.statusCode).toBe(200);
      expect(response.rawPayload).toEqual(Buffer.from(bytes));
      expect(response.headers['content-type']).toContain('application/vnd.tixkit.portable+json');
      expect(response.headers['x-tixkit-portable-job-id']).toBe('pex_route_01');
    }
    expect(exportConfiguration).toHaveBeenCalledTimes(2);
    expect(writeAuditLog).toHaveBeenCalledTimes(2);
    await app.close();
  });
});
