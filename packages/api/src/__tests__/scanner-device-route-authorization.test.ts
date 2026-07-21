import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ScannerDeviceRepository } from '@tixkit/db';
import type { Principal } from '@tixkit/domain';
import { registerErrorHandler } from '../app.js';
import { developerRoutes } from '../routes/modules/developer.js';
import { SCANNER_DEVICE_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS } from './integration/route-authorization-contracts.js';

const { writeAuditLog } = vi.hoisted(() => ({
  writeAuditLog: vi.fn(async (..._arguments: unknown[]) => undefined),
}));

vi.mock('../auth/audit.js', () => ({ writeAuditLog }));

const tenantId = 'tenant_scanner_auth_01';
const organizationId = 'org_scanner_auth_01';
const eventId = 'event_scanner_auth_01';
const brandId = 'brand_scanner_auth_01';
const deviceRowId = 'scanner_row_auth_01';
const deviceId = 'scanner_device_auth_01';
const rawSecret = 'a'.repeat(64);
const hashedSecret = 'b'.repeat(64);

const storedDevice = {
  id: deviceRowId,
  tenant_id: tenantId,
  organization_id: organizationId,
  name: 'Front gate',
  device_id: deviceId,
  hashed_secret: hashedSecret,
  event_ids: JSON.stringify([eventId]),
  scopes: JSON.stringify(['checkins.read', 'checkins.write']),
  status: 'active',
  last_seen_at: null,
  created_at: new Date('2026-07-16T12:00:00.000Z'),
  updated_at: new Date('2026-07-16T12:00:00.000Z'),
};

const storedEvent = {
  id: eventId,
  tenant_id: tenantId,
  organization_id: organizationId,
  brand_id: brandId,
};

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    type: 'user',
    id: 'user_scanner_admin',
    tenantId,
    organizationIds: [organizationId],
    scopes: ['developers.write', 'checkins.read', 'checkins.write'],
    ...overrides,
  };
}

function database(
  input: {
    device?: Record<string, unknown>;
    event?: Record<string, unknown>;
  } = {},
) {
  const rowsByTable: Record<string, Record<string, unknown>[]> = {
    events: input.event === undefined ? [storedEvent] : [input.event],
    organizations: [{ id: organizationId, tenant_id: tenantId }],
    scanner_devices: input.device === undefined ? [storedDevice] : [input.device],
  };
  const db = {
    transaction: vi.fn(() => ({
      execute: <T>(operation: (transaction: typeof db) => Promise<T>) => operation(db),
    })),
    selectFrom(table: string) {
      const predicates: Array<[string, string, unknown]> = [];
      const query = {
        select(_selection: unknown) {
          return query;
        },
        selectAll() {
          return query;
        },
        where(column: string, operator: string, value: unknown) {
          predicates.push([column, operator, value]);
          return query;
        },
        forUpdate() {
          return query;
        },
        orderBy() {
          return query;
        },
        async execute() {
          return (rowsByTable[table] ?? []).filter((row) =>
            predicates.every(([column, operator, value]) => {
              if (operator === '=') return row[column] === value;
              if (operator === 'in') return Array.isArray(value) && value.includes(row[column]);
              throw new Error(`Unsupported test operator: ${operator}`);
            }),
          );
        },
        async executeTakeFirst() {
          return (await query.execute())[0];
        },
      };
      return query;
    },
  };
  return db;
}

async function testApp(
  activePrincipal: Principal,
  input: { device?: Record<string, unknown>; event?: Record<string, unknown> } = {},
) {
  const db = database(input);
  const app = Fastify();
  app.decorate('context', { db } as never);
  app.addHook('preHandler', async (request) => {
    request.principal = activePrincipal;
  });
  registerErrorHandler(app);
  await app.register(developerRoutes);
  return { app, db };
}

describe('scanner device route authorization contract', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    writeAuditLog.mockClear();
    vi.spyOn(ScannerDeviceRepository.prototype, 'create').mockResolvedValue({
      secret: rawSecret,
      record: storedDevice,
    });
    vi.spyOn(ScannerDeviceRepository.prototype, 'revokeScoped').mockResolvedValue(1);
  });

  it('is the exact executable source for the immutable C-123 contracts', () => {
    expect(SCANNER_DEVICE_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS).toEqual([
      expect.objectContaining({
        method: 'GET',
        operationId: 'getScannerDevices',
        path: '/scanner-devices',
        deniedBoundaries: [],
        permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
      }),
      expect.objectContaining({
        method: 'POST',
        operationId: 'postScannerDevices',
        path: '/scanner-devices',
        deniedBoundaries: ['organization', 'brand', 'event'],
        permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
      }),
      expect.objectContaining({
        method: 'POST',
        operationId: 'postScannerDevicesByDeviceIdRevoke',
        path: '/scanner-devices/{deviceId}/revoke',
        deniedBoundaries: ['tenant', 'organization', 'brand', 'event'],
        permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
      }),
    ]);
  });

  it.each(SCANNER_DEVICE_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS)(
    'returns the declared permission denial before lookup, persistence, transaction, or audit for $method $path',
    async (contract) => {
      const { app, db } = await testApp(principal({ scopes: ['checkins.read'] }));
      const response = await app.inject(
        contract.method === 'GET'
          ? { method: 'GET', url: '/scanner-devices' }
          : contract.path === '/scanner-devices'
            ? {
                method: 'POST',
                url: '/scanner-devices',
                payload: { organizationId, name: 'Denied scanner' },
              }
            : { method: 'POST', url: `/scanner-devices/${deviceId}/revoke` },
      );

      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('FORBIDDEN');
      expect(db.transaction).not.toHaveBeenCalled();
      expect(ScannerDeviceRepository.prototype.create).not.toHaveBeenCalled();
      expect(ScannerDeviceRepository.prototype.revokeScoped).not.toHaveBeenCalled();
      expect(writeAuditLog).not.toHaveBeenCalled();
      await app.close();
    },
  );

  it('returns 404 for an out-of-scope create organization without mutation', async () => {
    const { app, db } = await testApp(principal({ organizationIds: ['org_unrelated_01'] }));
    const response = await app.inject({
      method: 'POST',
      url: '/scanner-devices',
      payload: { organizationId, name: 'Denied scanner' },
    });

    expect(response.statusCode).toBe(404);
    expect(db.transaction).not.toHaveBeenCalled();
    expect(ScannerDeviceRepository.prototype.create).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    ['brand', { brandIds: ['brand_allowed_01'] }],
    ['event', { eventIds: ['event_allowed_01'] }],
  ])(
    'returns 404 for an out-of-scope create %s without mutation',
    async (_boundary, principalScope) => {
      const { app, db } = await testApp(principal(principalScope));
      const response = await app.inject({
        method: 'POST',
        url: '/scanner-devices',
        payload: { organizationId, name: 'Denied scanner', eventIds: [eventId] },
      });

      expect(response.statusCode).toBe(404);
      expect(db.transaction).toHaveBeenCalledTimes(1);
      expect(ScannerDeviceRepository.prototype.create).not.toHaveBeenCalled();
      expect(writeAuditLog).not.toHaveBeenCalled();
      await app.close();
    },
  );

  it.each([
    ['tenant', principal({ tenantId: 'tenant_alien_01' })],
    ['organization', principal({ organizationIds: ['org_alien_01'] })],
    ['brand', principal({ brandIds: ['brand_allowed_01'] })],
    ['event', principal({ eventIds: ['event_allowed_01'] })],
  ])('returns 404 for an out-of-scope revoke %s without mutation', async (_boundary, actor) => {
    const { app, db } = await testApp(actor);
    const response = await app.inject({
      method: 'POST',
      url: `/scanner-devices/${deviceId}/revoke`,
    });

    expect(response.statusCode).toBe(404);
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(ScannerDeviceRepository.prototype.revokeScoped).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
    await app.close();
  });

  it('creates and revokes authorized devices with one-time secret disclosure and redacted audit', async () => {
    const { app } = await testApp(principal());
    const created = await app.inject({
      method: 'POST',
      url: '/scanner-devices',
      payload: { organizationId, name: 'Front gate', eventIds: [eventId] },
    });

    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({ deviceId, secret: rawSecret, status: 'active' });
    expect(created.body).not.toContain(hashedSecret);
    expect(created.json()).not.toHaveProperty('hashedSecret');
    expect(created.json()).not.toHaveProperty('hashed_secret');

    const revoked = await app.inject({
      method: 'POST',
      url: `/scanner-devices/${deviceId}/revoke`,
    });
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect(revoked.json()).toEqual({ deviceId, status: 'revoked' });
    expect(ScannerDeviceRepository.prototype.revokeScoped).toHaveBeenCalledWith({
      id: deviceRowId,
      tenantId,
      organizationId,
    });
    expect(writeAuditLog).toHaveBeenCalledTimes(2);
    expect(writeAuditLog.mock.calls.map((call) => call[4])).toEqual([
      { failClosed: true },
      { failClosed: true },
    ]);
    expect(writeAuditLog.mock.calls.map((call) => call[3])).toEqual([
      expect.objectContaining({
        action: 'scanner_device.created',
        organizationId,
        resourceId: deviceRowId,
      }),
      expect.objectContaining({
        action: 'scanner_device.revoked',
        organizationId,
        resourceId: deviceRowId,
      }),
    ]);
    expect(JSON.stringify(writeAuditLog.mock.calls)).not.toContain(rawSecret);
    expect(JSON.stringify(writeAuditLog.mock.calls)).not.toContain(hashedSecret);
    await app.close();
  });

  it('returns 404 without audit when exact active-state revocation loses a race', async () => {
    vi.mocked(ScannerDeviceRepository.prototype.revokeScoped).mockResolvedValueOnce(0);
    const { app } = await testApp(principal());
    const response = await app.inject({
      method: 'POST',
      url: `/scanner-devices/${deviceId}/revoke`,
    });

    expect(response.statusCode).toBe(404);
    expect(writeAuditLog).not.toHaveBeenCalled();
    await app.close();
  });
});
