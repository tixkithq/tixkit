import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Principal } from '@tixkit/domain';
import type { PortableExportService } from '../services/portable-export.js';
import type { PortableHistoricalAuthorizationService } from '../services/portable-export-authorization.js';

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

async function testApp(input: {
  principal: Principal;
  service: PortableExportService;
  authorizationService?: PortableHistoricalAuthorizationService;
}) {
  const app = Fastify();
  app.decorate('context', { db: {} } as never);
  app.addHook('preHandler', async (request) => {
    request.principal = input.principal;
  });
  registerErrorHandler(app);
  await app.register(portabilityRoutes, {
    exportService: input.service,
    authorizationService: input.authorizationService,
  });
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
      service: { exportConfiguration, exportHistorical: vi.fn() },
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
        service: { exportConfiguration, exportHistorical: vi.fn() },
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
      service: { exportConfiguration, exportHistorical: vi.fn() },
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

  it('forwards exact-parent delta lineage and a final cutover receipt', async () => {
    const bytes = new TextEncoder().encode('{"portable":"delta"}');
    const exportConfiguration = vi.fn(async () => ({
      jobId: 'pex_route_delta_01',
      bundleId: 'bundle_route_delta_01',
      bytes,
    }));
    const app = await testApp({
      principal: principal(),
      service: { exportConfiguration, exportHistorical: vi.fn() },
    });
    const cutoverFreeze = {
      frozenAt: '2026-07-17T12:00:00.000Z',
      receiptSha256: 'a'.repeat(64),
    };
    const response = await app.inject({
      method: 'POST',
      url: '/portable-delta-exports',
      headers: { 'idempotency-key': 'route-final-delta' },
      payload: {
        organizationId,
        parentExportJobId: 'pex_route_parent_01',
        cutoverFreeze,
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(exportConfiguration).toHaveBeenCalledWith({
      tenantId,
      organizationId,
      requestedBy: 'user_portability_admin',
      idempotencyKey: 'route-final-delta',
      parentExportJobId: 'pex_route_parent_01',
      cutoverFreeze,
    });
    await app.close();
  });

  it('rejects a cutover receipt without a delta parent', async () => {
    const exportConfiguration = vi.fn();
    const app = await testApp({
      principal: principal(),
      service: { exportConfiguration, exportHistorical: vi.fn() },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/portable-exports',
      headers: { 'idempotency-key': 'route-invalid-cutover' },
      payload: {
        organizationId,
        cutoverFreeze: {
          frozenAt: '2026-07-17T12:00:00.000Z',
          receiptSha256: 'a'.repeat(64),
        },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(exportConfiguration).not.toHaveBeenCalled();
    await app.close();
  });

  it('requires and forwards a principal-bound authorization for historical export', async () => {
    const bytes = new TextEncoder().encode('{"historical":true}');
    const exportHistorical = vi.fn(async () => ({
      jobId: 'pex_historical_01',
      bundleId: 'bundle_historical_01',
      bytes,
    }));
    const service = { exportConfiguration: vi.fn(), exportHistorical };
    const app = await testApp({ principal: principal(), service });
    const missing = await app.inject({
      method: 'POST',
      url: '/portable-exports',
      headers: { 'idempotency-key': 'historical-missing' },
      payload: { organizationId, mode: 'historical' },
    });
    expect(missing.statusCode).toBe(400);
    const response = await app.inject({
      method: 'POST',
      url: '/portable-exports',
      headers: { 'idempotency-key': 'historical-valid' },
      payload: {
        organizationId,
        mode: 'historical',
        authorizationId: 'pexa_route_authorization_01',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(exportHistorical).toHaveBeenCalledWith({
      tenantId,
      organizationId,
      requestedBy: 'user_portability_admin',
      idempotencyKey: 'historical-valid',
      authorizationId: 'pexa_route_authorization_01',
    });
    expect(writeAuditLog).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ action: 'portability.export.historical' }),
    );
    await app.close();
  });

  it('grants and revokes historical authorization only through the control service', async () => {
    const authorization = {
      authorizationId: 'pexa_route_authorization_01',
      tenantId,
      organizationId,
      scope: 'tenant-historical-portability' as const,
      grantedByPrincipalId: 'user_portability_admin',
      grantedAt: '2026-07-13T06:00:00.000Z',
      expiresAt: '2026-07-13T06:10:00.000Z',
    };
    const grant = vi.fn(async () => authorization);
    const revoke = vi.fn(async () => undefined);
    const authorizationService = { grant, revoke };
    const service = { exportConfiguration: vi.fn(), exportHistorical: vi.fn() };
    const app = await testApp({ principal: principal(), service, authorizationService });
    const granted = await app.inject({
      method: 'POST',
      url: '/portable-export-authorizations',
      payload: { organizationId, expiresAt: authorization.expiresAt },
    });
    expect(granted.statusCode).toBe(201);
    expect(granted.json()).toEqual(authorization);
    expect(grant).toHaveBeenCalledWith({
      tenantId,
      organizationId,
      principalId: 'user_portability_admin',
      expiresAt: new Date(authorization.expiresAt),
    });
    const revoked = await app.inject({
      method: 'POST',
      url: `/portable-export-authorizations/${authorization.authorizationId}/revoke`,
      payload: { organizationId },
    });
    expect(revoked.statusCode).toBe(204);
    const replayedRevocation = await app.inject({
      method: 'POST',
      url: `/portable-export-authorizations/${authorization.authorizationId}/revoke`,
      payload: { organizationId },
    });
    expect(replayedRevocation.statusCode).toBe(204);
    expect(revoke).toHaveBeenCalledWith({
      tenantId,
      organizationId,
      principalId: 'user_portability_admin',
      authorizationId: authorization.authorizationId,
    });
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(writeAuditLog).toHaveBeenCalledTimes(3);
    await app.close();
  });

  it('denies non-user authorization and maps stale authorization to conflict', async () => {
    const service = {
      exportConfiguration: vi.fn(),
      exportHistorical: vi.fn(async () => {
        throw new Error('PORTABLE_EXPORT_AUTHORIZATION_EXPIRED');
      }),
    };
    const systemApp = await testApp({
      principal: principal({ type: 'system' }),
      service,
      authorizationService: { grant: vi.fn(), revoke: vi.fn() },
    });
    const denied = await systemApp.inject({
      method: 'POST',
      url: '/portable-export-authorizations',
      payload: { organizationId, expiresAt: '2026-07-13T06:10:00.000Z' },
    });
    expect(denied.statusCode).toBe(403);
    await systemApp.close();

    const app = await testApp({ principal: principal(), service });
    const conflict = await app.inject({
      method: 'POST',
      url: '/portable-exports',
      headers: { 'idempotency-key': 'historical-expired' },
      payload: {
        organizationId,
        mode: 'historical',
        authorizationId: 'pexa_expired_01',
      },
    });
    expect(conflict.statusCode).toBe(409);
    expect(writeAuditLog).not.toHaveBeenCalled();
    await app.close();
  });
});
