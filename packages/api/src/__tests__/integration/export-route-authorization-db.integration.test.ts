import Fastify, { type FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createDb, EventRepository, type Database } from '@tixkit/db';
import { ALL_PERMISSIONS, type Principal } from '@tixkit/domain';
import { ulid } from 'ulid';
import { registerErrorHandler, type AppContext } from '../../app.js';
import { reportingRoutes } from '../../routes/modules/reporting.js';
import {
  describeWithIntegrationDatabase,
  integrationDatabaseDriver,
  integrationDatabaseUrl,
  restoreDatabaseDriver,
  setIntegrationDatabaseDriver,
} from './integration-database.js';
import { EXPORT_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS } from './route-authorization-contracts.js';

const contracts = new Map(
  EXPORT_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS.map((contract) => [contract.operationId, contract]),
);
function contract(operationId: string) {
  const result = contracts.get(operationId);
  if (!result) throw new Error(`Missing export authorization contract: ${operationId}`);
  return result;
}

const createContract = contract('postExports');
const statusContract = contract('getExportsByExportId');
const eventsContract = contract('getExportsByExportIdEvents');
const downloadContract = contract('getExportsByExportIdDownload');
const suffix = ulid().slice(-10).toLowerCase();
const tenantA = `tnt_exp_a_${suffix}`;
const tenantB = `tnt_exp_b_${suffix}`;
const organizationA = `org_exp_a_${suffix}`;
const organizationOther = `org_exp_o_${suffix}`;
const organizationB = `org_exp_b_${suffix}`;
const brandA = `brd_exp_a_${suffix}`;
const brandSibling = `brd_exp_s_${suffix}`;
const brandOther = `brd_exp_o_${suffix}`;
const brandB = `brd_exp_b_${suffix}`;
const actorId = `usr_exp_${suffix}`;
const exportA = `exp_a_${suffix}`;
const exportOrders = `exp_orders_${suffix}`;
const exportSales = `exp_sales_${suffix}`;
const exportTax = `exp_tax_${suffix}`;
const exportTickets = `exp_tickets_${suffix}`;
const exportScanLogs = `exp_scan_logs_${suffix}`;
const exportOtherOrganization = `exp_o_${suffix}`;
const exportSiblingBrand = `exp_s_${suffix}`;
const exportOtherEvent = `exp_e_${suffix}`;
const exportForeignTenant = `exp_f_${suffix}`;
const exportSystem = `exp_sys_${suffix}`;
const EXPORT_TYPES = [
  { exportId: exportA, type: 'attendees', permission: 'attendees.read' },
  { exportId: exportOrders, type: 'orders', permission: 'orders.read' },
  { exportId: exportSales, type: 'sales', permission: 'orders.read' },
  { exportId: exportTax, type: 'tax', permission: 'orders.read' },
  { exportId: exportTickets, type: 'tickets', permission: 'checkins.read' },
  { exportId: exportScanLogs, type: 'scan_logs', permission: 'checkins.read' },
] as const;
type ExportType = (typeof EXPORT_TYPES)[number]['type'];

describeWithIntegrationDatabase(`export route authorization DB parity (${integrationDatabaseDriver()})`, () => {
  let app: FastifyInstance;
  let db: Database;
  let previousDriver: string | undefined;
  let activePrincipal: Principal;
  let eventA: string;
  let eventOtherOrganization: string;
  let eventSiblingBrand: string;
  let eventOther: string;
  let eventForeign: string;
  const startExport = vi.fn(async () => undefined);
  const waitForExport = vi.fn(async () => undefined);

  function principal(overrides: Partial<Principal> = {}): Principal {
    return {
      type: 'user',
      id: actorId,
      tenantId: tenantA,
      organizationIds: [organizationA],
      brandIds: [brandA],
      scopes: [...ALL_PERMISSIONS],
      ...overrides,
    };
  }

  async function insertTenant(id: string) {
    const now = new Date('2026-07-22T12:00:00.000Z');
    await db
      .insertInto('tenants')
      .values({ id, name: id, status: 'active', plan: 'test', created_at: now, updated_at: now })
      .execute();
  }

  async function insertOrganization(id: string, tenantId: string) {
    const now = new Date('2026-07-22T12:00:00.000Z');
    await db
      .insertInto('organizations')
      .values({
        id,
        tenant_id: tenantId,
        name: id,
        slug: `${id}-slug`,
        clerk_organization_id: null,
        box_office_settings: '{}',
        status: 'active',
        created_at: now,
        updated_at: now,
      })
      .execute();
  }

  async function insertBrand(id: string, tenantId: string, organizationId: string) {
    const now = new Date('2026-07-22T12:00:00.000Z');
    await db
      .insertInto('brands')
      .values({
        id,
        tenant_id: tenantId,
        organization_id: organizationId,
        name: id,
        slug: `${id}-slug`,
        status: 'active',
        theme: '{}',
        support_url: null,
        legal_urls: '{}',
        white_label: false,
        payment_account_id: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
  }

  async function createEvent(tenantId: string, organizationId: string, brandId: string, label: string) {
    return (
      await new EventRepository(db).create({
        tenantId,
        organizationId,
        brandId,
        slug: `export-auth-${label}-${suffix}`,
        title: `Export authorization ${label}`,
        currency: 'USD',
        timezone: 'UTC',
        startsAt: new Date('2027-01-01T18:00:00.000Z'),
        endsAt: new Date('2027-01-01T22:00:00.000Z'),
        venue: { name: 'Export authorization hall' },
      })
    ).id;
  }

  async function insertExport(
    id: string,
    tenantId: string,
    eventId: string | null,
    type: ExportType = 'attendees',
  ) {
    const now = new Date('2026-07-22T12:00:00.000Z');
    await db
      .insertInto('export_jobs')
      .values({
        id,
        tenant_id: tenantId,
        event_id: eventId,
        type,
        format: 'csv',
        status: 'completed',
        file_url: `https://exports.example.test/${id}.csv`,
        requested_by: actorId,
        filters: null,
        created_at: now,
        completed_at: now,
      })
      .execute();
    await db
      .insertInto('export_job_events')
      .values({
        id: `eev_${id}`,
        tenant_id: tenantId,
        export_job_id: id,
        status: 'completed',
        payload: JSON.stringify({ exportId: id, status: 'completed' }),
        created_at: now,
      })
      .execute();
  }

  async function snapshot() {
    const [jobs, events, records] = await Promise.all([
      db.selectFrom('export_jobs').selectAll().where('tenant_id', '=', tenantA).orderBy('id').execute(),
      db
        .selectFrom('export_job_events')
        .selectAll()
        .where('tenant_id', '=', tenantA)
        .orderBy('id')
        .execute(),
      db
        .selectFrom('idempotency_records')
        .selectAll()
        .where('tenant_id', '=', tenantA)
        .orderBy('id')
        .execute(),
    ]);
    return { jobs, events, records };
  }

  async function cleanup() {
    if (!db) return;
    await db.deleteFrom('idempotency_records').where('tenant_id', 'in', [tenantA, tenantB]).execute();
    await db.deleteFrom('export_job_events').where('tenant_id', 'in', [tenantA, tenantB]).execute();
    await db.deleteFrom('export_jobs').where('tenant_id', 'in', [tenantA, tenantB]).execute();
    await db.deleteFrom('events').where('tenant_id', 'in', [tenantA, tenantB]).execute();
    await db.deleteFrom('brands').where('id', 'in', [brandA, brandSibling, brandOther, brandB]).execute();
    await db
      .deleteFrom('organizations')
      .where('id', 'in', [organizationA, organizationOther, organizationB])
      .execute();
    await db.deleteFrom('tenants').where('id', 'in', [tenantA, tenantB]).execute();
  }

  beforeAll(async () => {
    previousDriver = setIntegrationDatabaseDriver();
    db = createDb(integrationDatabaseUrl());
    await insertTenant(tenantA);
    await insertTenant(tenantB);
    await insertOrganization(organizationA, tenantA);
    await insertOrganization(organizationOther, tenantA);
    await insertOrganization(organizationB, tenantB);
    await insertBrand(brandA, tenantA, organizationA);
    await insertBrand(brandSibling, tenantA, organizationA);
    await insertBrand(brandOther, tenantA, organizationOther);
    await insertBrand(brandB, tenantB, organizationB);
    eventA = await createEvent(tenantA, organizationA, brandA, 'authorized');
    eventOtherOrganization = await createEvent(tenantA, organizationOther, brandOther, 'other-org');
    eventSiblingBrand = await createEvent(tenantA, organizationA, brandSibling, 'sibling-brand');
    eventOther = await createEvent(tenantA, organizationA, brandA, 'other-event');
    eventForeign = await createEvent(tenantB, organizationB, brandB, 'foreign');
    await insertExport(exportA, tenantA, eventA);
    await insertExport(exportOrders, tenantA, eventA, 'orders');
    await insertExport(exportSales, tenantA, eventA, 'sales');
    await insertExport(exportTax, tenantA, eventA, 'tax');
    await insertExport(exportTickets, tenantA, eventA, 'tickets');
    await insertExport(exportScanLogs, tenantA, eventA, 'scan_logs');
    await insertExport(exportOtherOrganization, tenantA, eventOtherOrganization);
    await insertExport(exportSiblingBrand, tenantA, eventSiblingBrand);
    await insertExport(exportOtherEvent, tenantA, eventOther);
    await insertExport(exportForeignTenant, tenantB, eventForeign);
    await insertExport(exportSystem, tenantA, null);
    activePrincipal = principal();
    app = Fastify({ logger: false });
    app.decorate('context', { db, temporalClient: { startExport, waitForExport } } as unknown as AppContext);
    app.addHook('preHandler', async (request) => {
      request.principal = activePrincipal;
    });
    registerErrorHandler(app);
    await app.register(reportingRoutes);
    await app.ready();
  }, 120_000);

  beforeEach(() => {
    activePrincipal = principal();
    startExport.mockClear();
    waitForExport.mockClear();
  });

  afterAll(async () => {
    try {
      if (app) await app.close();
    } finally {
      try {
        await cleanup();
      } finally {
        if (db) await db.destroy();
        restoreDatabaseDriver(previousDriver);
      }
    }
  }, 120_000);

  it('binds the executable matrix to all export lifecycle contracts', () => {
    expect([...contracts.values()]).toHaveLength(4);
    expect(createContract).toMatchObject({
      deniedBoundaries: ['tenant', 'organization', 'brand', 'event'],
      sideEffectAssertions: ['persistence', 'workflow'],
    });
    for (const read of [statusContract, eventsContract, downloadContract]) {
      expect(read).toMatchObject({
        deniedBoundaries: ['tenant', 'organization', 'brand', 'event'],
        permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
      });
    }
  });

  it.each(['user', 'api_key'] as const)(
    'serves each export lifecycle read to an authorized %s principal',
    async (type) => {
      activePrincipal = principal({ type });
      for (const exportType of EXPORT_TYPES) {
        const status = await app.inject({ method: 'GET', url: `/exports/${exportType.exportId}` });
        const events = await app.inject({
          method: 'GET',
          url: `/exports/${exportType.exportId}/events`,
        });
        const download = await app.inject({
          method: 'GET',
          url: `/exports/${exportType.exportId}/download`,
        });
        expect(status.statusCode, status.body).toBe(statusContract.authorizedControl.status);
        expect(status.json()).toMatchObject({
          exportId: exportType.exportId,
          type: exportType.type,
          status: 'completed',
        });
        expect(events.statusCode, events.body).toBe(eventsContract.authorizedControl.status);
        expect(events.body).toContain(exportType.exportId);
        expect(download.statusCode, download.body).toBe(downloadContract.authorizedControl.status);
        expect(download.headers.location).toContain(exportType.exportId);
      }
    },
  );

  it('conceals foreign tenant, organization, brand, event, null-event, and unknown exports identically', async () => {
    const ids = [
      exportForeignTenant,
      exportOtherOrganization,
      exportSiblingBrand,
      exportOtherEvent,
      exportSystem,
      `exp_missing_${suffix}`,
    ];
    activePrincipal = principal({ eventIds: [eventA] });
    for (const id of ids) {
      for (const suffixPath of ['', '/events', '/download']) {
        const response = await app.inject({ method: 'GET', url: `/exports/${id}${suffixPath}` });
        expect(response.statusCode, response.body).toBe(404);
        expect(response.json()).toEqual(
          expect.objectContaining({
            error: expect.objectContaining({
              code: 'NOT_FOUND',
              message: `ExportJob not found: ${id}`,
              details: { resource: 'ExportJob', id },
            }),
          }),
        );
        expect(response.body).not.toContain(eventForeign);
        expect(response.body).not.toContain(organizationOther);
        expect(response.body).not.toContain(brandSibling);
        expect(response.headers.location).toBeUndefined();
      }
    }
    expect(waitForExport).not.toHaveBeenCalled();
  });

  it('requires reports.read and every stored export type permission before all reads', async () => {
    const cases = [
      {
        exportId: exportA,
        principal: principal({
          scopes: [...ALL_PERMISSIONS].filter((permission) => permission !== 'reports.read'),
        }),
      },
      ...EXPORT_TYPES.map((exportType) => ({
        exportId: exportType.exportId,
        principal: principal({
          scopes: [...ALL_PERMISSIONS].filter((permission) => permission !== exportType.permission),
        }),
      })),
    ];
    for (const denied of cases) {
      activePrincipal = denied.principal;
      for (const suffixPath of ['', '/events', '/download']) {
        const response = await app.inject({
          method: 'GET',
          url: `/exports/${denied.exportId}${suffixPath}`,
        });
        expect(response.statusCode, response.body).toBe(403);
        expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
        expect(response.headers.location).toBeUndefined();
      }
    }
    expect(waitForExport).not.toHaveBeenCalled();
  });

  it('permits null-event exports only to a system principal', async () => {
    activePrincipal = principal({
      type: 'system',
      id: `sys_exp_${suffix}`,
      organizationIds: [],
      brandIds: undefined,
    });
    const response = await app.inject({ method: 'GET', url: `/exports/${exportSystem}` });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ exportId: exportSystem });
  });

  it('does not persist or enqueue exports for permission or resource denials', async () => {
    const before = await snapshot();
    const cases: Array<{ principal: Principal; eventId: string; status: 403 | 404 }> = [
      { principal: principal({ scopes: [] }), eventId: eventA, status: 403 },
      {
        principal: principal({
          scopes: [...ALL_PERMISSIONS].filter((permission) => permission !== 'attendees.read'),
        }),
        eventId: eventA,
        status: 403,
      },
      { principal: principal(), eventId: eventOtherOrganization, status: 404 },
      { principal: principal(), eventId: eventSiblingBrand, status: 404 },
      { principal: principal({ eventIds: [eventA] }), eventId: eventOther, status: 404 },
      { principal: principal(), eventId: eventForeign, status: 404 },
    ];
    for (const [index, testCase] of cases.entries()) {
      activePrincipal = testCase.principal;
      const response = await app.inject({
        method: 'POST',
        url: '/exports',
        headers: { 'idempotency-key': `export-auth-denied-${index}-${suffix}` },
        payload: { eventId: testCase.eventId, type: 'attendees', format: 'csv' },
      });
      expect(response.statusCode, response.body).toBe(testCase.status);
      expect(response.json()).toMatchObject({
        error: { code: testCase.status === 403 ? 'FORBIDDEN' : 'NOT_FOUND' },
      });
      if (testCase.status === 404) {
        expect(response.json()).toMatchObject({
          error: {
            message: `Event not found: ${testCase.eventId}`,
            details: { resource: 'Event', id: testCase.eventId },
          },
        });
        expect(response.body).not.toContain(organizationOther);
        expect(response.body).not.toContain(brandSibling);
      }
    }
    expect(await snapshot()).toEqual(before);
    expect(startExport).not.toHaveBeenCalled();
  });

  it('replays an exact idempotent export once and rejects a conflicting payload without a second effect', async () => {
    const idempotencyKey = `export-auth-allowed-${suffix}`;
    const request = {
      method: 'POST',
      url: '/exports',
      headers: { 'idempotency-key': idempotencyKey },
      payload: { eventId: eventA, type: 'attendees', format: 'csv' },
    } as const;
    const first = await app.inject(request);
    const replay = await app.inject(request);
    const conflict = await app.inject({
      ...request,
      payload: { eventId: eventA, type: 'orders', format: 'csv' },
    });
    expect(first.statusCode, first.body).toBe(createContract.authorizedControl.status);
    expect(replay.statusCode, replay.body).toBe(createContract.authorizedControl.status);
    expect(replay.json()).toEqual(first.json());
    expect(conflict.statusCode, conflict.body).toBe(409);
    expect(conflict.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
    const exportId = first.json().exportId as string;
    expect(startExport).toHaveBeenCalledTimes(1);
    expect(startExport).toHaveBeenCalledWith(
      expect.objectContaining({ exportId, tenantId: tenantA, type: 'attendees' }),
    );
    const [jobs, events, records] = await Promise.all([
      db.selectFrom('export_jobs').selectAll().where('id', '=', exportId).execute(),
      db
        .selectFrom('export_job_events')
        .selectAll()
        .where('export_job_id', '=', exportId)
        .execute(),
      db
        .selectFrom('idempotency_records')
        .selectAll()
        .where('tenant_id', '=', tenantA)
        .where('key', '=', idempotencyKey)
        .execute(),
    ]);
    expect(jobs).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ status: 'completed', response_status: 202 });
  });

  it('loads export authorization before any SSE subscription or download signing effect', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../../routes/modules/reporting.ts'), 'utf8');
    const sseRoute = source.indexOf("app.get('/exports/:exportId/events'");
    const downloadRoute = source.indexOf("app.get('/exports/:exportId/download'");
    const sseScopeLoad = source.indexOf('const exportJob = await loadScopedExportJob', sseRoute);
    const subscriber = source.indexOf('createExportEventSubscriber', sseRoute);
    const downloadScopeLoad = source.indexOf('const exportJob = await loadScopedExportJob', downloadRoute);
    const signer = source.indexOf('createScopedExportDownloadUrl', downloadRoute);

    expect(sseRoute).toBeGreaterThanOrEqual(0);
    expect(downloadRoute).toBeGreaterThan(sseRoute);
    expect(sseScopeLoad).toBeGreaterThan(sseRoute);
    expect(subscriber).toBeGreaterThan(sseScopeLoad);
    expect(downloadScopeLoad).toBeGreaterThan(downloadRoute);
    expect(signer).toBeGreaterThan(downloadScopeLoad);
  });

  it(`uses the selected ${integrationDatabaseDriver()} integration driver`, () => {
    expect(['postgres', 'mysql']).toContain(integrationDatabaseDriver());
  });
});
