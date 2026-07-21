import Fastify from 'fastify';
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import {
  AuditLogRepository,
  BrandRepository,
  createDb,
  EventRepository,
  ScannerDeviceRepository,
  type Database,
} from '@tixkit/db';
import type { Principal } from '@tixkit/domain';
import { registerErrorHandler, type AppContext } from '../../app.js';
import { developerRoutes } from '../../routes/modules/developer.js';
import {
  describeWithIntegrationDatabase,
  integrationDatabaseUrl,
  restoreDatabaseDriver,
  setIntegrationDatabaseDriver,
} from './integration-database.js';
import { SCANNER_DEVICE_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS } from './route-authorization-contracts.js';

describeWithIntegrationDatabase('scanner device route authorization persistence', () => {
  let db: Database;
  let previousDriver: string | undefined;
  const suffix = Math.random().toString(16).slice(2, 10);
  const tenantId = `tnt_sd_${suffix}`;
  const otherTenantId = `tnt_sdo_${suffix}`;
  const organizationId = `org_sd_${suffix}`;
  const otherOrganizationId = `org_sdo_${suffix}`;
  const siblingOrganizationId = `org_sds_${suffix}`;
  let siblingEventId: string;

  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((complete) => {
      resolve = complete;
    });
    return { promise, resolve };
  }

  beforeAll(async () => {
    previousDriver = setIntegrationDatabaseDriver();
    db = createDb(integrationDatabaseUrl());
    const now = new Date();
    await db
      .insertInto('tenants')
      .values([
        {
          id: tenantId,
          name: `Scanner authorization ${suffix}`,
          status: 'active',
          plan: 'test',
          created_at: now,
          updated_at: now,
        },
        {
          id: otherTenantId,
          name: `Scanner authorization other ${suffix}`,
          status: 'active',
          plan: 'test',
          created_at: now,
          updated_at: now,
        },
      ])
      .execute();
    await db
      .insertInto('organizations')
      .values([
        {
          id: organizationId,
          tenant_id: tenantId,
          name: `Scanner authorization ${suffix}`,
          slug: `scanner-auth-${suffix}`,
          clerk_organization_id: null,
          box_office_settings: '{}',
          status: 'active',
          created_at: now,
          updated_at: now,
        },
        {
          id: otherOrganizationId,
          tenant_id: otherTenantId,
          name: `Scanner authorization other ${suffix}`,
          slug: `scanner-auth-other-${suffix}`,
          clerk_organization_id: null,
          box_office_settings: '{}',
          status: 'active',
          created_at: now,
          updated_at: now,
        },
        {
          id: siblingOrganizationId,
          tenant_id: tenantId,
          name: `Scanner authorization sibling ${suffix}`,
          slug: `scanner-auth-sibling-${suffix}`,
          clerk_organization_id: null,
          box_office_settings: '{}',
          status: 'active',
          created_at: now,
          updated_at: now,
        },
      ])
      .execute();
    await new BrandRepository(db).create({
      tenantId,
      organizationId: siblingOrganizationId,
      name: `Scanner sibling brand ${suffix}`,
      slug: `scanner-sibling-${suffix}`,
    });
    const siblingBrand = await db
      .selectFrom('brands')
      .select('id')
      .where('organization_id', '=', siblingOrganizationId)
      .executeTakeFirstOrThrow();
    siblingEventId = (
      await new EventRepository(db).create({
        tenantId,
        organizationId: siblingOrganizationId,
        brandId: siblingBrand.id,
        slug: `scanner-sibling-event-${suffix}`,
        title: `Scanner sibling event ${suffix}`,
        currency: 'USD',
        timezone: 'UTC',
        startsAt: new Date('2027-01-01T18:00:00.000Z'),
        endsAt: new Date('2027-01-01T22:00:00.000Z'),
        venue: { name: 'Scanner authorization hall' },
      })
    ).id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function routeApp(principalOverrides: Partial<Principal> = {}) {
    const app = Fastify();
    app.decorate('context', { db } as AppContext);
    app.addHook('preHandler', async (request) => {
      request.principal = {
        type: 'user',
        id: `usr_sd_${suffix}`,
        tenantId,
        organizationIds: [organizationId],
        scopes: ['developers.write', 'checkins.read', 'checkins.write'],
        ...principalOverrides,
      } satisfies Principal;
    });
    registerErrorHandler(app);
    await app.register(developerRoutes);
    return app;
  }

  afterAll(async () => {
    if (db) {
      await db
        .deleteFrom('audit_logs')
        .where('tenant_id', 'in', [tenantId, otherTenantId])
        .execute();
      await db
        .deleteFrom('scanner_devices')
        .where('tenant_id', 'in', [tenantId, otherTenantId])
        .execute();
      await db.deleteFrom('events').where('id', '=', siblingEventId).execute();
      await db.deleteFrom('brands').where('organization_id', '=', siblingOrganizationId).execute();
      await db
        .deleteFrom('organizations')
        .where('id', 'in', [organizationId, otherOrganizationId, siblingOrganizationId])
        .execute();
      await db.deleteFrom('tenants').where('id', 'in', [tenantId, otherTenantId]).execute();
      await db.destroy();
    }
    restoreDatabaseDriver(previousDriver);
  });

  it('creates and revokes through HTTP with hashed persistence and redacted fail-closed audit', async () => {
    const app = await routeApp();
    const name = `Authorized scanner ${suffix}`;
    const created = await app.inject({
      method: 'POST',
      url: '/scanner-devices',
      payload: { organizationId, name },
    });

    expect(created.statusCode, created.body).toBe(201);
    const body = created.json() as {
      deviceId: string;
      hashedSecret?: string;
      hashed_secret?: string;
      secret: string;
    };
    expect(body.secret).toMatch(/^[a-f0-9]{64}$/u);
    expect(body.hashedSecret).toBeUndefined();
    expect(body.hashed_secret).toBeUndefined();
    const persisted = await db
      .selectFrom('scanner_devices')
      .selectAll()
      .where('device_id', '=', body.deviceId)
      .executeTakeFirstOrThrow();
    expect(persisted).toMatchObject({
      tenant_id: tenantId,
      organization_id: organizationId,
      name,
      status: 'active',
    });
    expect(persisted.hashed_secret).toBe(createHash('sha256').update(body.secret).digest('hex'));
    expect(JSON.stringify(persisted)).not.toContain(body.secret);

    const createAudit = await db
      .selectFrom('audit_logs')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('resource_id', '=', persisted.id)
      .where('action', '=', 'scanner_device.created')
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(createAudit)).not.toContain(body.secret);
    expect(JSON.stringify(createAudit)).not.toContain(persisted.hashed_secret);

    const revoked = await app.inject({
      method: 'POST',
      url: `/scanner-devices/${body.deviceId}/revoke`,
    });
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect(revoked.json()).toEqual({ deviceId: body.deviceId, status: 'revoked' });
    expect(
      await db
        .selectFrom('scanner_devices')
        .select('status')
        .where('id', '=', persisted.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: 'revoked' });
    const losingRevoke = await app.inject({
      method: 'POST',
      url: `/scanner-devices/${body.deviceId}/revoke`,
    });
    expect(losingRevoke.statusCode, losingRevoke.body).toBe(404);
    expect(losingRevoke.json().error.code).toBe('NOT_FOUND');
    expect(
      await db
        .selectFrom('audit_logs')
        .select('action')
        .where('tenant_id', '=', tenantId)
        .where('resource_id', '=', persisted.id)
        .orderBy('created_at', 'asc')
        .execute(),
    ).toEqual([{ action: 'scanner_device.created' }, { action: 'scanner_device.revoked' }]);
    await app.close();
  });

  it('binds revocation to the exact id, tenant, organization, and active state', async () => {
    const repository = new ScannerDeviceRepository(db);
    const { record } = await repository.create({
      tenantId,
      organizationId,
      name: `Scoped revoke ${suffix}`,
      eventIds: [],
      scopes: ['checkins.read'],
    });
    const id = record.id as string;

    await expect(
      repository.revokeScoped({
        id: `missing_${suffix}`,
        tenantId,
        organizationId,
      }),
    ).resolves.toBe(0);
    await expect(
      repository.revokeScoped({ id, tenantId: otherTenantId, organizationId }),
    ).resolves.toBe(0);
    await expect(
      repository.revokeScoped({ id, tenantId, organizationId: otherOrganizationId }),
    ).resolves.toBe(0);
    expect(
      await db
        .selectFrom('scanner_devices')
        .select('status')
        .where('id', '=', id)
        .executeTakeFirst(),
    ).toEqual({ status: 'active' });

    await expect(repository.revokeScoped({ id, tenantId, organizationId })).resolves.toBe(1);
    await expect(repository.revokeScoped({ id, tenantId, organizationId })).resolves.toBe(0);
    expect(
      await db
        .selectFrom('scanner_devices')
        .select('status')
        .where('id', '=', id)
        .executeTakeFirst(),
    ).toEqual({ status: 'revoked' });
  });

  it('rejects cross-organization and cross-tenant creation without persistence', async () => {
    const multiOrganizationApp = await routeApp({
      organizationIds: [organizationId, siblingOrganizationId],
    });
    const crossOrganizationName = `Cross organization scanner ${suffix}`;
    const crossOrganization = await multiOrganizationApp.inject({
      method: 'POST',
      url: '/scanner-devices',
      payload: {
        organizationId,
        name: crossOrganizationName,
        eventIds: [siblingEventId],
      },
    });
    expect(crossOrganization.statusCode).toBe(404);
    await multiOrganizationApp.close();

    const systemApp = await routeApp({ type: 'system', id: `sys_sd_${suffix}` });
    const crossTenantName = `Cross tenant scanner ${suffix}`;
    const crossTenant = await systemApp.inject({
      method: 'POST',
      url: '/scanner-devices',
      payload: { organizationId: otherOrganizationId, name: crossTenantName },
    });
    expect(crossTenant.statusCode).toBe(404);
    await systemApp.close();

    const rows = await db
      .selectFrom('scanner_devices')
      .select('name')
      .where('name', 'in', [crossOrganizationName, crossTenantName])
      .execute();
    expect(rows).toEqual([]);
  });

  it('continues bounded event-scoped scans without exposing unscoped devices or starving later authorized rows', async () => {
    const listContract = SCANNER_DEVICE_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS.find(
      (contract) => contract.method === 'GET' && contract.path === '/scanner-devices',
    );
    expect(listContract).toMatchObject({
      operationId: 'getScannerDevices',
      deniedBoundaries: [],
      permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
      source: 'scanner-device-route-authorization-db.integration.test.ts',
    });

    const pageTenantId = `tnt_sdp_${suffix}`;
    const pageOrganizationId = `org_sdp_${suffix}`;
    const pageOtherOrganizationId = `org_sdp_other_${suffix}`;
    let allowedEventId = '';
    let otherEventId = '';
    let deniedEventId = '';
    const rowId = (index: number) => `pg_${suffix}_${String(index).padStart(4, '0')}`;
    const deviceId = (index: number) => `pgd_${suffix}_${String(index).padStart(4, '0')}`;
    const now = new Date();
    let permissionApp: Awaited<ReturnType<typeof routeApp>> | undefined;
    let scopedApp: Awaited<ReturnType<typeof routeApp>> | undefined;
    let corruptApp: Awaited<ReturnType<typeof routeApp>> | undefined;
    let brandApp: Awaited<ReturnType<typeof routeApp>> | undefined;
    let tenantReplayApp: Awaited<ReturnType<typeof routeApp>> | undefined;
    let scopeReplayApp: Awaited<ReturnType<typeof routeApp>> | undefined;

    try {
      await db
        .insertInto('tenants')
        .values({
          id: pageTenantId,
          name: `Scanner pagination ${suffix}`,
          status: 'active',
          plan: 'test',
          created_at: now,
          updated_at: now,
        })
        .execute();
      await db
        .insertInto('organizations')
        .values(
          [pageOrganizationId, pageOtherOrganizationId].map((id, index) => ({
            id,
            tenant_id: pageTenantId,
            name: `Scanner pagination ${index} ${suffix}`,
            slug: `scanner-pagination-${index}-${suffix}`,
            clerk_organization_id: null,
            box_office_settings: '{}',
            status: 'active',
            created_at: now,
            updated_at: now,
          })),
        )
        .execute();
      await new BrandRepository(db).create({
        tenantId: pageTenantId,
        organizationId: pageOrganizationId,
        name: `Scanner pagination allowed ${suffix}`,
        slug: `scanner-pagination-allowed-${suffix}`,
      });
      await new BrandRepository(db).create({
        tenantId: pageTenantId,
        organizationId: pageOtherOrganizationId,
        name: `Scanner pagination other ${suffix}`,
        slug: `scanner-pagination-other-${suffix}`,
      });
      await new BrandRepository(db).create({
        tenantId: pageTenantId,
        organizationId: pageOrganizationId,
        name: `Scanner pagination denied ${suffix}`,
        slug: `scanner-pagination-denied-${suffix}`,
      });
      const pageBrands = await db
        .selectFrom('brands')
        .select(['id', 'organization_id', 'slug'])
        .where('tenant_id', '=', pageTenantId)
        .execute();
      const allowedBrandId = pageBrands.find(
        (brand) => brand.slug === `scanner-pagination-allowed-${suffix}`,
      )!.id;
      const otherBrandId = pageBrands.find(
        (brand) => brand.slug === `scanner-pagination-other-${suffix}`,
      )!.id;
      const deniedBrandId = pageBrands.find(
        (brand) => brand.slug === `scanner-pagination-denied-${suffix}`,
      )!.id;
      allowedEventId = (
        await new EventRepository(db).create({
          tenantId: pageTenantId,
          organizationId: pageOrganizationId,
          brandId: allowedBrandId,
          slug: `scanner-pagination-allowed-event-${suffix}`,
          title: `Scanner pagination allowed ${suffix}`,
          currency: 'USD',
          timezone: 'UTC',
          startsAt: new Date('2027-02-01T18:00:00.000Z'),
          endsAt: new Date('2027-02-01T22:00:00.000Z'),
          venue: { name: 'Allowed hall' },
        })
      ).id;
      otherEventId = (
        await new EventRepository(db).create({
          tenantId: pageTenantId,
          organizationId: pageOtherOrganizationId,
          brandId: otherBrandId,
          slug: `scanner-pagination-other-event-${suffix}`,
          title: `Scanner pagination other ${suffix}`,
          currency: 'USD',
          timezone: 'UTC',
          startsAt: new Date('2027-02-02T18:00:00.000Z'),
          endsAt: new Date('2027-02-02T22:00:00.000Z'),
          venue: { name: 'Other hall' },
        })
      ).id;
      deniedEventId = (
        await new EventRepository(db).create({
          tenantId: pageTenantId,
          organizationId: pageOrganizationId,
          brandId: deniedBrandId,
          slug: `scanner-pagination-denied-event-${suffix}`,
          title: `Scanner pagination denied ${suffix}`,
          currency: 'USD',
          timezone: 'UTC',
          startsAt: new Date('2027-02-03T18:00:00.000Z'),
          endsAt: new Date('2027-02-03T22:00:00.000Z'),
          venue: { name: 'Denied hall' },
        })
      ).id;
      await db
        .insertInto('scanner_devices')
        .values([
          ...Array.from({ length: 502 }, (_, index) => ({
            id: rowId(index),
            tenant_id: pageTenantId,
            organization_id: pageOrganizationId,
            name: `Pagination scanner ${index}`,
            device_id: deviceId(index),
            hashed_secret: createHash('sha256').update(`${suffix}:${index}`).digest('hex'),
            event_ids: JSON.stringify(
              index === 0 ? [] : [index === 501 ? allowedEventId : deniedEventId],
            ),
            scopes: JSON.stringify(['checkins.read']),
            status: 'active',
            last_seen_at: null,
            created_at: now,
            updated_at: now,
          })),
          ...[
            [502, [otherEventId], pageOrganizationId],
            [503, [allowedEventId, deniedEventId], pageOrganizationId],
            [504, { malformed: true }, pageOrganizationId],
            [505, [otherEventId], pageOtherOrganizationId],
          ].map(([index, eventIds, rowOrganizationId]) => ({
            id: rowId(index as number),
            tenant_id: pageTenantId,
            organization_id: rowOrganizationId as string,
            name: `Pagination adversarial scanner ${index}`,
            device_id: deviceId(index as number),
            hashed_secret: createHash('sha256').update(`${suffix}:${index}`).digest('hex'),
            event_ids: JSON.stringify(eventIds),
            scopes: JSON.stringify(['checkins.read']),
            status: 'active',
            last_seen_at: null,
            created_at: now,
            updated_at: now,
          })),
        ])
        .execute();

      permissionApp = await routeApp({
        tenantId: pageTenantId,
        organizationIds: [pageOrganizationId],
        eventIds: [allowedEventId],
        scopes: ['checkins.read'],
      });
      const denied = await permissionApp.inject({
        method: 'GET',
        url: '/scanner-devices?limit=50',
      });
      expect(denied.statusCode, denied.body).toBe(403);
      expect(denied.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });

      scopedApp = await routeApp({
        tenantId: pageTenantId,
        organizationIds: [pageOrganizationId],
        eventIds: [allowedEventId],
      });
      const first = await scopedApp.inject({ method: 'GET', url: '/scanner-devices?limit=50' });
      expect(first.statusCode, first.body).toBe(200);
      const firstBody = first.json() as {
        items: unknown[];
        hasMore: boolean;
        nextCursor: string;
      };
      expect(firstBody.items).toEqual([]);
      expect(firstBody.hasMore).toBe(true);
      expect(firstBody.nextCursor).toMatch(/^sdsc1\./u);
      for (const inaccessibleValue of [
        rowId(499),
        deviceId(499),
        pageTenantId,
        pageOrganizationId,
        allowedEventId,
        deniedEventId,
      ]) {
        expect(firstBody.nextCursor).not.toContain(inaccessibleValue);
      }

      const tamperedParts = firstBody.nextCursor.split('.');
      const encryptedPart = tamperedParts[2]!;
      tamperedParts[2] = `${encryptedPart.startsWith('A') ? 'B' : 'A'}${encryptedPart.slice(1)}`;
      const tamperedCursor = tamperedParts.join('.');
      const tampered = await scopedApp.inject({
        method: 'GET',
        url: `/scanner-devices?limit=50&cursor=${encodeURIComponent(tamperedCursor)}`,
      });
      expect(tampered.statusCode, tampered.body).toBe(400);
      expect(tampered.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });

      tenantReplayApp = await routeApp({
        tenantId: otherTenantId,
        organizationIds: [otherOrganizationId],
        eventIds: [allowedEventId],
      });
      const tenantReplay = await tenantReplayApp.inject({
        method: 'GET',
        url: `/scanner-devices?limit=50&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
      });
      expect(tenantReplay.statusCode, tenantReplay.body).toBe(400);

      scopeReplayApp = await routeApp({
        tenantId: pageTenantId,
        organizationIds: [pageOrganizationId],
        eventIds: [deniedEventId],
      });
      const scopeReplay = await scopeReplayApp.inject({
        method: 'GET',
        url: `/scanner-devices?limit=50&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
      });
      expect(scopeReplay.statusCode, scopeReplay.body).toBe(400);

      const second = await scopedApp.inject({
        method: 'GET',
        url: `/scanner-devices?limit=50&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
      });
      expect(second.statusCode, second.body).toBe(200);
      expect(second.json()).toMatchObject({
        hasMore: false,
        nextCursor: null,
        items: [
          expect.objectContaining({
            id: rowId(501),
            organizationId: pageOrganizationId,
            eventIds: [allowedEventId],
          }),
        ],
      });
      expect(JSON.stringify(second.json())).not.toContain(rowId(0));
      expect(JSON.stringify(second.json())).not.toContain(rowId(502));
      expect(JSON.stringify(second.json())).not.toContain(rowId(503));
      expect(JSON.stringify(second.json())).not.toContain(rowId(504));
      expect(JSON.stringify(second.json())).not.toContain(rowId(505));

      brandApp = await routeApp({
        tenantId: pageTenantId,
        organizationIds: [pageOrganizationId],
        brandIds: [allowedBrandId],
      });
      const brandFirst = await brandApp.inject({ method: 'GET', url: '/scanner-devices?limit=50' });
      const brandCursor = brandFirst.json().nextCursor as string;
      const brandPage = await brandApp.inject({
        method: 'GET',
        url: `/scanner-devices?limit=50&cursor=${encodeURIComponent(brandCursor)}`,
      });
      expect(brandPage.statusCode, brandPage.body).toBe(200);
      expect(brandPage.json().items).toEqual([
        expect.objectContaining({ id: rowId(501), eventIds: [allowedEventId] }),
      ]);

      for (const deniedIndex of [0, 1, 503, 504]) {
        const response = await scopedApp.inject({
          method: 'POST',
          url: `/scanner-devices/${deviceId(deniedIndex)}/revoke`,
        });
        expect(response.statusCode, `${deniedIndex}: ${response.body}`).toBe(404);
        expect(response.json()).toMatchObject({
          error: {
            code: 'NOT_FOUND',
            message: `ScannerDevice not found: ${deviceId(deniedIndex)}`,
            details: { resource: 'ScannerDevice', id: deviceId(deniedIndex) },
          },
        });
        expect(response.body).not.toContain(pageOrganizationId);
        expect(response.body).not.toContain(pageOtherOrganizationId);
      }

      corruptApp = await routeApp({
        tenantId: pageTenantId,
        organizationIds: [pageOrganizationId, pageOtherOrganizationId],
        eventIds: [allowedEventId, otherEventId],
      });
      const corruptFirst = await corruptApp.inject({
        method: 'GET',
        url: '/scanner-devices?limit=50',
      });
      const corruptCursor = corruptFirst.json().nextCursor as string;
      const corruptList = await corruptApp.inject({
        method: 'GET',
        url: `/scanner-devices?limit=50&cursor=${encodeURIComponent(corruptCursor)}`,
      });
      expect(corruptList.statusCode, corruptList.body).toBe(200);
      expect(corruptList.json().items).toEqual([
        expect.objectContaining({
          id: rowId(501),
          organizationId: pageOrganizationId,
          eventIds: [allowedEventId],
        }),
        expect.objectContaining({
          id: rowId(505),
          organizationId: pageOtherOrganizationId,
          eventIds: [otherEventId],
        }),
      ]);
      const corruptRevoke = await corruptApp.inject({
        method: 'POST',
        url: `/scanner-devices/${deviceId(502)}/revoke`,
      });
      expect(corruptRevoke.statusCode, corruptRevoke.body).toBe(404);
      expect(corruptRevoke.json()).toMatchObject({
        error: {
          code: 'NOT_FOUND',
          message: `ScannerDevice not found: ${deviceId(502)}`,
          details: { resource: 'ScannerDevice', id: deviceId(502) },
        },
      });

      const eventLocked = deferred();
      const releaseEvent = deferred();
      const eventMove = db.transaction().execute(async (transaction) => {
        await transaction
          .selectFrom('events')
          .select('id')
          .where('id', '=', allowedEventId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        eventLocked.resolve();
        await releaseEvent.promise;
        await transaction
          .updateTable('events')
          .set({
            organization_id: pageOtherOrganizationId,
            brand_id: otherBrandId,
            updated_at: new Date(),
          })
          .where('id', '=', allowedEventId)
          .execute();
      });
      await eventLocked.promise;
      const staleRevokeRequest = scopedApp.inject({
        method: 'POST',
        url: `/scanner-devices/${deviceId(501)}/revoke`,
      });
      releaseEvent.resolve();
      await eventMove;
      const staleRevoke = await staleRevokeRequest;
      expect(staleRevoke.statusCode, staleRevoke.body).toBe(404);
      await db
        .updateTable('events')
        .set({
          organization_id: pageOrganizationId,
          brand_id: allowedBrandId,
          updated_at: new Date(),
        })
        .where('id', '=', allowedEventId)
        .execute();

      const allowedRevoke = await scopedApp.inject({
        method: 'POST',
        url: `/scanner-devices/${deviceId(501)}/revoke`,
      });
      expect(allowedRevoke.statusCode, allowedRevoke.body).toBe(200);
      expect(
        Number(
          (
            await db
              .selectFrom('scanner_devices')
              .select(({ fn }) => fn.countAll<number>().as('count'))
              .where('tenant_id', '=', pageTenantId)
              .executeTakeFirstOrThrow()
          ).count,
        ),
      ).toBe(506);
      expect(
        await db
          .selectFrom('scanner_devices')
          .select(['id', 'status'])
          .where('tenant_id', '=', pageTenantId)
          .where('id', 'in', [
            rowId(0),
            rowId(1),
            rowId(501),
            rowId(502),
            rowId(503),
            rowId(504),
            rowId(505),
          ])
          .orderBy('id', 'asc')
          .execute(),
      ).toEqual([
        { id: rowId(0), status: 'active' },
        { id: rowId(1), status: 'active' },
        { id: rowId(501), status: 'revoked' },
        { id: rowId(502), status: 'active' },
        { id: rowId(503), status: 'active' },
        { id: rowId(504), status: 'active' },
        { id: rowId(505), status: 'active' },
      ]);
    } finally {
      if (permissionApp) await permissionApp.close();
      if (scopedApp) await scopedApp.close();
      if (corruptApp) await corruptApp.close();
      if (brandApp) await brandApp.close();
      if (tenantReplayApp) await tenantReplayApp.close();
      if (scopeReplayApp) await scopeReplayApp.close();
      await db.deleteFrom('audit_logs').where('tenant_id', '=', pageTenantId).execute();
      await db.deleteFrom('scanner_devices').where('tenant_id', '=', pageTenantId).execute();
      await db.deleteFrom('events').where('tenant_id', '=', pageTenantId).execute();
      await db.deleteFrom('brands').where('tenant_id', '=', pageTenantId).execute();
      await db
        .deleteFrom('organizations')
        .where('id', 'in', [pageOrganizationId, pageOtherOrganizationId])
        .execute();
      await db.deleteFrom('tenants').where('id', '=', pageTenantId).execute();
    }
  });

  it('persists no scanner or audit mutation for every declared HTTP denial boundary', async () => {
    const repository = new ScannerDeviceRepository(db);
    const primaryDevice = await repository.create({
      tenantId,
      organizationId,
      name: `Denied revoke primary ${suffix}`,
      eventIds: [],
      scopes: ['checkins.read'],
    });
    const siblingDevice = await repository.create({
      tenantId,
      organizationId: siblingOrganizationId,
      name: `Denied revoke sibling ${suffix}`,
      eventIds: [siblingEventId],
      scopes: ['checkins.read'],
    });
    const primaryRecord = primaryDevice.record as { device_id: string; id: string };
    const siblingRecord = siblingDevice.record as { device_id: string; id: string };
    const createCases: Array<{
      expectedStatus: number;
      label: string;
      payload: { eventIds?: string[]; name: string; organizationId: string };
      principal: Partial<Principal>;
    }> = [
      {
        expectedStatus: 403,
        label: 'permission',
        payload: { organizationId, name: `Denied create permission ${suffix}` },
        principal: { scopes: ['checkins.read'] },
      },
      {
        expectedStatus: 404,
        label: 'organization',
        payload: {
          organizationId: siblingOrganizationId,
          name: `Denied create organization ${suffix}`,
        },
        principal: {},
      },
      {
        expectedStatus: 404,
        label: 'brand',
        payload: {
          organizationId: siblingOrganizationId,
          name: `Denied create brand ${suffix}`,
          eventIds: [siblingEventId],
        },
        principal: {
          organizationIds: [organizationId, siblingOrganizationId],
          brandIds: [`brand_unrelated_${suffix}`],
        },
      },
      {
        expectedStatus: 404,
        label: 'event',
        payload: {
          organizationId: siblingOrganizationId,
          name: `Denied create event ${suffix}`,
          eventIds: [siblingEventId],
        },
        principal: {
          organizationIds: [organizationId, siblingOrganizationId],
          eventIds: [`event_unrelated_${suffix}`],
        },
      },
    ];
    const scannerCountBefore = await db
      .selectFrom('scanner_devices')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .where('tenant_id', '=', tenantId)
      .executeTakeFirstOrThrow();
    const auditCountBefore = await db
      .selectFrom('audit_logs')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .where('tenant_id', 'in', [tenantId, otherTenantId])
      .executeTakeFirstOrThrow();

    for (const testCase of createCases) {
      const app = await routeApp(testCase.principal);
      const response = await app.inject({
        method: 'POST',
        url: '/scanner-devices',
        payload: testCase.payload,
      });
      expect(response.statusCode, `${testCase.label}: ${response.body}`).toBe(
        testCase.expectedStatus,
      );
      await app.close();
    }

    const revokeCases: Array<{
      deviceId: string;
      expectedStatus: number;
      label: string;
      principal: Partial<Principal>;
    }> = [
      {
        deviceId: primaryRecord.device_id,
        expectedStatus: 403,
        label: 'permission',
        principal: { scopes: ['checkins.read'] },
      },
      {
        deviceId: primaryRecord.device_id,
        expectedStatus: 404,
        label: 'tenant',
        principal: { type: 'system', tenantId: otherTenantId, organizationIds: [] },
      },
      {
        deviceId: primaryRecord.device_id,
        expectedStatus: 404,
        label: 'organization',
        principal: { organizationIds: [siblingOrganizationId] },
      },
      {
        deviceId: siblingRecord.device_id,
        expectedStatus: 404,
        label: 'brand',
        principal: {
          organizationIds: [organizationId, siblingOrganizationId],
          brandIds: [`brand_unrelated_${suffix}`],
        },
      },
      {
        deviceId: siblingRecord.device_id,
        expectedStatus: 404,
        label: 'event',
        principal: {
          organizationIds: [organizationId, siblingOrganizationId],
          eventIds: [`event_unrelated_${suffix}`],
        },
      },
    ];

    for (const testCase of revokeCases) {
      const app = await routeApp(testCase.principal);
      const response = await app.inject({
        method: 'POST',
        url: `/scanner-devices/${testCase.deviceId}/revoke`,
      });
      expect(response.statusCode, `${testCase.label}: ${response.body}`).toBe(
        testCase.expectedStatus,
      );
      if (testCase.expectedStatus === 404) {
        expect(response.json()).toMatchObject({
          error: {
            code: 'NOT_FOUND',
            message: `ScannerDevice not found: ${testCase.deviceId}`,
            details: { resource: 'ScannerDevice', id: testCase.deviceId },
          },
        });
        expect(response.body).not.toContain(organizationId);
        expect(response.body).not.toContain(siblingOrganizationId);
      }
      await app.close();
    }

    const scannerCountAfter = await db
      .selectFrom('scanner_devices')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .where('tenant_id', '=', tenantId)
      .executeTakeFirstOrThrow();
    const auditCountAfter = await db
      .selectFrom('audit_logs')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .where('tenant_id', 'in', [tenantId, otherTenantId])
      .executeTakeFirstOrThrow();
    expect(Number(scannerCountAfter.count)).toBe(Number(scannerCountBefore.count));
    expect(Number(auditCountAfter.count)).toBe(Number(auditCountBefore.count));
    expect(
      await db
        .selectFrom('scanner_devices')
        .select(['id', 'status'])
        .where('id', 'in', [primaryRecord.id, siblingRecord.id])
        .orderBy('id', 'asc')
        .execute(),
    ).toEqual([primaryRecord.id, siblingRecord.id].sort().map((id) => ({ id, status: 'active' })));
  });

  it('allows exactly one concurrent HTTP revocation and writes exactly one audit record', async () => {
    const { record } = await new ScannerDeviceRepository(db).create({
      tenantId,
      organizationId,
      name: `Concurrent revoke ${suffix}`,
      eventIds: [],
      scopes: ['checkins.read'],
    });
    const persisted = record as { device_id: string; id: string };
    const app = await routeApp();

    const responses = await Promise.all([
      app.inject({ method: 'POST', url: `/scanner-devices/${persisted.device_id}/revoke` }),
      app.inject({ method: 'POST', url: `/scanner-devices/${persisted.device_id}/revoke` }),
    ]);

    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 404]);
    expect(
      await db
        .selectFrom('scanner_devices')
        .select('status')
        .where('id', '=', persisted.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: 'revoked' });
    const revokeAuditCount = await db
      .selectFrom('audit_logs')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .where('tenant_id', '=', tenantId)
      .where('resource_id', '=', persisted.id)
      .where('action', '=', 'scanner_device.revoked')
      .executeTakeFirstOrThrow();
    expect(Number(revokeAuditCount.count)).toBe(1);
    await app.close();
  });

  it('revalidates the exact event organization after a concurrent committed change', async () => {
    const locked = deferred();
    const release = deferred();
    const mutation = db.transaction().execute(async (transaction) => {
      await transaction
        .selectFrom('events')
        .select('id')
        .where('id', '=', siblingEventId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      locked.resolve();
      await release.promise;
      await transaction
        .updateTable('events')
        .set({ organization_id: organizationId, updated_at: new Date() })
        .where('id', '=', siblingEventId)
        .execute();
    });
    await locked.promise;
    const app = await routeApp({ organizationIds: [organizationId, siblingOrganizationId] });
    const name = `Concurrent event move ${suffix}`;
    const request = app.inject({
      method: 'POST',
      url: '/scanner-devices',
      payload: { organizationId: siblingOrganizationId, name, eventIds: [siblingEventId] },
    });
    release.resolve();
    await mutation;
    const response = await request;

    expect(response.statusCode).toBe(404);
    expect(
      await db
        .selectFrom('scanner_devices')
        .select('id')
        .where('name', '=', name)
        .executeTakeFirst(),
    ).toBeUndefined();
    await db
      .updateTable('events')
      .set({ organization_id: siblingOrganizationId, updated_at: new Date() })
      .where('id', '=', siblingEventId)
      .execute();
    await app.close();
  });

  it('rolls back creation when the required audit insert fails', async () => {
    vi.spyOn(AuditLogRepository.prototype, 'create').mockRejectedValueOnce(
      new Error('injected scanner create audit failure'),
    );
    const app = await routeApp();
    const name = `Audit rollback create ${suffix}`;
    const response = await app.inject({
      method: 'POST',
      url: '/scanner-devices',
      payload: { organizationId, name },
    });

    expect(response.statusCode).toBe(500);
    const remaining = await db
      .selectFrom('scanner_devices')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .where('tenant_id', '=', tenantId)
      .where('organization_id', '=', organizationId)
      .where('name', '=', name)
      .executeTakeFirstOrThrow();
    expect(Number(remaining.count)).toBe(0);
    await app.close();
  });

  it('rolls back revocation when the required audit insert fails', async () => {
    const repository = new ScannerDeviceRepository(db);
    const { record } = await repository.create({
      tenantId,
      organizationId,
      name: `Audit rollback revoke ${suffix}`,
      eventIds: [],
      scopes: ['checkins.read'],
    });
    const id = record.id as string;
    const deviceId = record.device_id as string;
    vi.spyOn(AuditLogRepository.prototype, 'create').mockRejectedValueOnce(
      new Error('injected scanner revoke audit failure'),
    );
    const app = await routeApp();
    const response = await app.inject({
      method: 'POST',
      url: `/scanner-devices/${deviceId}/revoke`,
    });

    expect(response.statusCode).toBe(500);
    expect(
      await db
        .selectFrom('scanner_devices')
        .select('status')
        .where('id', '=', id)
        .executeTakeFirst(),
    ).toEqual({ status: 'active' });
    await app.close();
  });
});
