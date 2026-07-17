import Fastify, { type FastifyInstance } from 'fastify';
import {
  AuditLogRepository,
  createDb,
  EventRepository,
  ProductCategoryRepository,
  ProductRepository,
  type Database,
} from '@tixkit/db';
import { ALL_PERMISSIONS, type Principal } from '@tixkit/domain';
import { ulid } from 'ulid';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerErrorHandler, type AppContext } from '../../app.js';
import { serializeProduct, serializeProductCategory } from '../../http/contracts.js';
import { ticketingRoutes } from '../../routes/modules/ticketing.js';
import {
  describeWithIntegrationDatabase,
  integrationDatabaseDriver,
  integrationDatabaseUrl,
  restoreDatabaseDriver,
  setIntegrationDatabaseDriver,
} from './integration-database.js';
import { EVENT_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS } from './route-authorization-contracts.js';

function productCatalogContract(operationId: string) {
  const contract = EVENT_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS.find(
    (candidate) => candidate.operationId === operationId,
  );
  if (!contract) throw new Error(`product catalog authorization contract ${operationId} missing`);
  return contract;
}

const categoryContract = productCatalogContract('postEventsByEventIdProductCategories');
const productContract = productCatalogContract('postEventsByEventIdProducts');

const suffix = ulid().slice(-10).toLowerCase();
const tenantA = `tnt_pcat_auth_a_${suffix}`;
const tenantB = `tnt_pcat_auth_b_${suffix}`;
const organizationA = `org_pcat_auth_a_${suffix}`;
const organizationAScoped = `org_pcat_auth_scope_${suffix}`;
const organizationB = `org_pcat_auth_b_${suffix}`;
const brandA = `brd_pcat_auth_a_${suffix}`;
const brandAScoped = `brd_pcat_auth_scope_${suffix}`;
const brandB = `brd_pcat_auth_b_${suffix}`;
const actorId = `usr_pcat_auth_${suffix}`;

let app: FastifyInstance;
let db: Database;
let previousDriver: string | undefined;
let activePrincipal: Principal;
let basePrincipal: Principal;
let eventA: string;
let eventAScoped: string;
let eventB: string;
let categoryA: string;
let categoryAScoped: string;
let categoryB: string;

type ProductConfigurationOperation = 'product_category_create' | 'product_create';

const productConfigurationCheckpoint = vi.fn(
  async (_input: {
    stage: 'before_transaction';
    operation: ProductConfigurationOperation;
    eventId: string;
  }) => undefined,
);

async function insertTenant(id: string, name: string): Promise<void> {
  const now = new Date('2026-07-17T12:00:00.000Z');
  await db
    .insertInto('tenants')
    .values({ id, name, status: 'active', plan: 'test', created_at: now, updated_at: now })
    .execute();
}

async function insertOrganization(id: string, tenantId: string, name: string): Promise<void> {
  const now = new Date('2026-07-17T12:00:00.000Z');
  await db
    .insertInto('organizations')
    .values({
      id,
      tenant_id: tenantId,
      name,
      slug: `${id}-slug`,
      clerk_organization_id: null,
      box_office_settings: '{}',
      status: 'active',
      created_at: now,
      updated_at: now,
    })
    .execute();
}

async function insertBrand(
  id: string,
  tenantId: string,
  organizationId: string,
  name: string,
): Promise<void> {
  const now = new Date('2026-07-17T12:00:00.000Z');
  await db
    .insertInto('brands')
    .values({
      id,
      tenant_id: tenantId,
      organization_id: organizationId,
      name,
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

async function createEvent(
  tenantId: string,
  organizationId: string,
  brandId: string,
  title: string,
): Promise<string> {
  const event = await new EventRepository(db).create({
    tenantId,
    organizationId,
    brandId,
    slug: `${title.toLowerCase().replaceAll(' ', '-')}-${suffix}`,
    title,
    currency: 'USD',
    timezone: 'UTC',
    startsAt: new Date('2027-01-01T18:00:00.000Z'),
    endsAt: new Date('2027-01-01T22:00:00.000Z'),
    venue: { name: 'Product catalog authorization hall' },
  });
  return event.id;
}

async function seedCategory(eventId: string, name: string): Promise<string> {
  const category = await new ProductCategoryRepository(db).create({
    eventId,
    name,
    sortOrder: 2,
  });
  return category.id;
}

async function seedProduct(eventId: string, categoryId: string, name: string): Promise<string> {
  const product = await new ProductRepository(db).create({
    eventId,
    categoryId,
    name,
    description: `${name} baseline description`,
    priceCents: 1_500,
    currency: 'USD',
    maxPerOrder: 4,
    availableFrom: new Date('2027-01-02T12:00:00.000Z'),
    availableUntil: new Date('2027-01-31T23:00:00.000Z'),
    status: 'active',
    sortOrder: 3,
  });
  return product.id;
}

function auditDiff(value: unknown): Record<string, unknown> {
  return (typeof value === 'string' ? JSON.parse(value) : value) as Record<string, unknown>;
}

function revisionMillis(value: Date | string | null): number {
  expect(value).not.toBeNull();
  return value instanceof Date ? value.getTime() : new Date(value!).getTime();
}

async function clearProductCatalogEvidence(): Promise<void> {
  await db
    .deleteFrom('audit_logs')
    .where('actor_id', '=', actorId)
    .where('action', 'in', ['product_category.created', 'product.created'])
    .execute();
  await db.deleteFrom('products').where('event_id', 'in', [eventA, eventAScoped, eventB]).execute();
  await db
    .deleteFrom('product_categories')
    .where('event_id', 'in', [eventA, eventAScoped, eventB])
    .execute();
}

async function seedBaselineCatalog(): Promise<void> {
  categoryA = await seedCategory(eventA, 'Allowed baseline category');
  categoryAScoped = await seedCategory(eventAScoped, 'Scoped baseline category');
  categoryB = await seedCategory(eventB, 'Foreign baseline category');
  await seedProduct(eventA, categoryA, 'Allowed baseline product');
  await seedProduct(eventAScoped, categoryAScoped, 'Scoped baseline product');
  await seedProduct(eventB, categoryB, 'Foreign baseline product');
}

async function evidenceSnapshot() {
  const [events, categories, products, audits] = await Promise.all([
    db
      .selectFrom('events')
      .select(['id', 'tenant_id', 'organization_id', 'brand_id', 'version', 'public_revision'])
      .where('id', 'in', [eventA, eventAScoped, eventB])
      .orderBy('id')
      .execute(),
    db
      .selectFrom('product_categories')
      .selectAll()
      .where('event_id', 'in', [eventA, eventAScoped, eventB])
      .orderBy('id')
      .execute(),
    db
      .selectFrom('products')
      .selectAll()
      .where('event_id', 'in', [eventA, eventAScoped, eventB])
      .orderBy('id')
      .execute(),
    db
      .selectFrom('audit_logs')
      .selectAll()
      .where('actor_id', '=', actorId)
      .where('action', 'in', ['product_category.created', 'product.created'])
      .orderBy('id')
      .execute(),
  ]);
  return { events, categories, products, audits };
}

function categoryPayload(name = 'Created product category') {
  return { name, sortOrder: 17 };
}

function productPayload(categoryId: string, name = 'Created catalog product') {
  return {
    name,
    description: `${name} exact description`,
    priceCents: 12_345,
    currency: 'EUR',
    categoryId,
    maxPerOrder: 7,
    availableFrom: '2027-05-01T13:15:30.000Z',
    availableUntil: '2027-06-30T22:45:15.000Z',
    status: 'inactive' as const,
    sortOrder: 23,
  };
}

function invokeCategory(targetEventId: string, name?: string) {
  return app.inject({
    method: categoryContract.method,
    url: categoryContract.path.replace('{eventId}', targetEventId),
    payload: categoryPayload(name),
  });
}

function invokeProduct(targetEventId: string, targetCategoryId: string, name?: string) {
  return app.inject({
    method: productContract.method,
    url: productContract.path.replace('{eventId}', targetEventId),
    payload: productPayload(targetCategoryId, name),
  });
}

function eventFrom(snapshot: Awaited<ReturnType<typeof evidenceSnapshot>>, eventId: string) {
  return snapshot.events.find((event) => event.id === eventId)!;
}

function expectEventDelta(
  before: Awaited<ReturnType<typeof evidenceSnapshot>>,
  after: Awaited<ReturnType<typeof evidenceSnapshot>>,
  eventId: string,
  expectedDelta: number,
): void {
  const beforeEvent = eventFrom(before, eventId);
  const afterEvent = eventFrom(after, eventId);
  expect(Number(afterEvent.version)).toBe(Number(beforeEvent.version) + expectedDelta);
  expect(revisionMillis(afterEvent.public_revision)).toBeGreaterThan(
    revisionMillis(beforeEvent.public_revision),
  );
}

function expectExactAudit(
  audit: Awaited<ReturnType<typeof evidenceSnapshot>>['audits'][number],
  expected: {
    action: 'product_category.created' | 'product.created';
    after: unknown;
    resourceId: string;
    resourceType: 'ProductCategory' | 'Product';
  },
): void {
  expect(audit).toMatchObject({
    tenant_id: tenantA,
    organization_id: organizationA,
    brand_id: brandA,
    actor_id: actorId,
    action: expected.action,
    resource_type: expected.resourceType,
    resource_id: expected.resourceId,
  });
  expect(auditDiff(audit.diff_summary)).toEqual({ eventId: eventA, after: expected.after });
}

describeWithIntegrationDatabase('product catalog write route authorization matrix', () => {
  beforeAll(async () => {
    previousDriver = setIntegrationDatabaseDriver();
    db = createDb(integrationDatabaseUrl());

    await insertTenant(tenantA, 'Product catalog authorization tenant A');
    await insertTenant(tenantB, 'Product catalog authorization tenant B');
    await insertOrganization(organizationA, tenantA, 'Product catalog authorization org A');
    await insertOrganization(
      organizationAScoped,
      tenantA,
      'Product catalog authorization scoped org',
    );
    await insertOrganization(organizationB, tenantB, 'Product catalog authorization org B');
    await insertBrand(brandA, tenantA, organizationA, 'Product catalog authorization brand A');
    await insertBrand(
      brandAScoped,
      tenantA,
      organizationAScoped,
      'Product catalog authorization scoped brand',
    );
    await insertBrand(brandB, tenantB, organizationB, 'Product catalog authorization brand B');
    eventA = await createEvent(tenantA, organizationA, brandA, 'Allowed product catalog event');
    eventAScoped = await createEvent(
      tenantA,
      organizationAScoped,
      brandAScoped,
      'Scoped product catalog event',
    );
    eventB = await createEvent(tenantB, organizationB, brandB, 'Foreign product catalog event');

    basePrincipal = {
      type: 'user',
      id: actorId,
      tenantId: tenantA,
      organizationIds: [organizationA],
      scopes: [...ALL_PERMISSIONS],
    };
    activePrincipal = basePrincipal;

    app = Fastify({ logger: false });
    app.decorate('context', {
      db,
      productConfigurationCheckpoint: (input: {
        stage: 'before_transaction';
        operation: ProductConfigurationOperation;
        eventId: string;
      }) => productConfigurationCheckpoint(input),
    } as AppContext);
    app.addHook('onRequest', async (request) => {
      request.principal = activePrincipal;
    });
    registerErrorHandler(app);
    await app.register(ticketingRoutes);
    await app.ready();
  });

  beforeEach(async () => {
    activePrincipal = basePrincipal;
    productConfigurationCheckpoint.mockReset();
    productConfigurationCheckpoint.mockResolvedValue(undefined);
    await clearProductCatalogEvidence();
    await seedBaselineCatalog();
  });

  afterAll(async () => {
    const cleanupErrors: unknown[] = [];
    const cleanup = async (action: () => Promise<unknown>) => {
      try {
        await action();
      } catch (error) {
        cleanupErrors.push(error);
      }
    };
    if (app) await cleanup(() => app.close());
    if (db) {
      await cleanup(clearProductCatalogEvidence);
      for (const eventId of [eventA, eventAScoped, eventB]) {
        await cleanup(() => db.deleteFrom('events').where('id', '=', eventId).execute());
      }
      for (const brandId of [brandA, brandAScoped, brandB]) {
        await cleanup(() => db.deleteFrom('brands').where('id', '=', brandId).execute());
      }
      for (const organizationId of [organizationA, organizationAScoped, organizationB]) {
        await cleanup(() =>
          db.deleteFrom('organizations').where('id', '=', organizationId).execute(),
        );
      }
      for (const tenantId of [tenantA, tenantB]) {
        await cleanup(() => db.deleteFrom('tenants').where('id', '=', tenantId).execute());
      }
      await cleanup(() => db.destroy());
    }
    try {
      restoreDatabaseDriver(previousDriver);
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'Failed to clean up product catalog proof');
    }
  });

  it('binds both immutable route contracts to this executable proof', () => {
    for (const contract of [categoryContract, productContract]) {
      expect(contract).toMatchObject({
        authorizedControl: { status: 201 },
        deniedBoundaries: ['tenant', 'organization', 'brand', 'event'],
        permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
        source: 'product-catalog-route-authorization-db.integration.test.ts',
      });
    }
  });

  it('persists exact category and product representations with atomic audits and revisions', async () => {
    const beforeCategory = await evidenceSnapshot();
    const categoryResponse = await invokeCategory(eventA);
    expect(categoryResponse.statusCode, categoryResponse.body).toBe(201);
    const createdCategory = categoryResponse.json();
    expect(createdCategory).toMatchObject({ eventId: eventA, ...categoryPayload() });

    const afterCategory = await evidenceSnapshot();
    expectEventDelta(beforeCategory, afterCategory, eventA, 1);
    expect(
      serializeProductCategory(
        afterCategory.categories.find((row) => row.id === createdCategory.id) as Record<
          string,
          unknown
        >,
      ),
    ).toEqual(createdCategory);
    expect(afterCategory.audits).toHaveLength(1);
    expectExactAudit(afterCategory.audits[0]!, {
      action: 'product_category.created',
      after: createdCategory,
      resourceId: createdCategory.id,
      resourceType: 'ProductCategory',
    });

    const beforeProduct = afterCategory;
    const productResponse = await invokeProduct(eventA, createdCategory.id);
    expect(productResponse.statusCode, productResponse.body).toBe(201);
    const createdProduct = productResponse.json();
    expect(createdProduct).toMatchObject({
      eventId: eventA,
      ...productPayload(createdCategory.id),
    });
    expect(createdProduct).toMatchObject({
      categoryId: createdCategory.id,
      currency: 'EUR',
      status: 'inactive',
      availableFrom: '2027-05-01T13:15:30.000Z',
      availableUntil: '2027-06-30T22:45:15.000Z',
    });

    const afterProduct = await evidenceSnapshot();
    expectEventDelta(beforeProduct, afterProduct, eventA, 1);
    expect(
      serializeProduct(
        afterProduct.products.find((row) => row.id === createdProduct.id) as Record<
          string,
          unknown
        >,
      ),
    ).toEqual(createdProduct);
    expect(afterProduct.audits).toHaveLength(2);
    expectExactAudit(
      afterProduct.audits.find((audit) => audit.resource_id === createdProduct.id)!,
      {
        action: 'product.created',
        after: createdProduct,
        resourceId: createdProduct.id,
        resourceType: 'Product',
      },
    );
  });

  describe.each([
    ['category', () => invokeCategory(eventA, 'Audit retry category')],
    ['product', () => invokeProduct(eventA, categoryA, 'Audit retry product')],
  ] as const)('%s audit transaction', (operation, invoke) => {
    it('rolls back the row and event revision on audit failure and permits a clean retry', async () => {
      const before = await evidenceSnapshot();
      const failure = vi
        .spyOn(AuditLogRepository.prototype, 'create')
        .mockRejectedValueOnce(new Error('injected product catalog audit failure'));
      try {
        const failed = await invoke();
        expect(failed.statusCode).toBe(500);
        await expect(evidenceSnapshot()).resolves.toEqual(before);
      } finally {
        failure.mockRestore();
      }

      const retry = await invoke();
      expect(retry.statusCode, retry.body).toBe(201);
      const afterRetry = await evidenceSnapshot();
      expectEventDelta(before, afterRetry, eventA, 1);
      expect(afterRetry.audits).toHaveLength(1);
      expect(afterRetry.audits[0]?.action).toBe(
        operation === 'category' ? 'product_category.created' : 'product.created',
      );
    });
  });

  it.each([
    ['permission', () => ({ ...basePrincipal, scopes: [] }), () => eventA, () => categoryA, 403],
    ['tenant', () => basePrincipal, () => eventB, () => categoryB, 404],
    [
      'organization',
      () => ({ ...basePrincipal, organizationIds: [organizationA] }),
      () => eventAScoped,
      () => categoryAScoped,
      404,
    ],
    [
      'brand',
      () => ({
        ...basePrincipal,
        organizationIds: [organizationA, organizationAScoped],
        brandIds: [brandA],
      }),
      () => eventAScoped,
      () => categoryAScoped,
      404,
    ],
    [
      'event',
      () => ({
        ...basePrincipal,
        organizationIds: [organizationA, organizationAScoped],
        brandIds: [brandA, brandAScoped],
        eventIds: [eventA],
      }),
      () => eventAScoped,
      () => categoryAScoped,
      404,
    ],
  ] as const)(
    'denies the %s boundary for both creates with exact catalog and audit snapshots',
    async (_boundary, makePrincipal, targetEvent, targetCategory, status) => {
      activePrincipal = makePrincipal();
      const eventId = targetEvent();
      const before = await evidenceSnapshot();

      const responses = [
        await invokeCategory(eventId, 'Forbidden category'),
        await invokeProduct(eventId, targetCategory(), 'Forbidden product'),
      ];
      for (const response of responses) {
        expect(response.statusCode, response.body).toBe(status);
        expect(response.json()).toMatchObject({
          error: { code: status === 403 ? 'FORBIDDEN' : 'NOT_FOUND' },
        });
      }
      await expect(evidenceSnapshot()).resolves.toEqual(before);
    },
  );

  it('returns 404 for a category belonging to another event without any mutation', async () => {
    const before = await evidenceSnapshot();
    const response = await invokeProduct(eventA, categoryAScoped, 'Cross-event product');
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    await expect(evidenceSnapshot()).resolves.toEqual(before);
  });

  describe.each([
    ['category', () => invokeCategory(eventA, 'Scope-race category')],
    ['product', () => invokeProduct(eventA, categoryA, 'Scope-race product')],
  ] as const)('%s locked scope revalidation', (_operation, invoke) => {
    it('fails closed after a real organization and brand swap at the checkpoint', async () => {
      let checkpointSnapshot: Awaited<ReturnType<typeof evidenceSnapshot>> | undefined;
      productConfigurationCheckpoint.mockImplementationOnce(async () => {
        await db
          .updateTable('events')
          .set({ organization_id: organizationAScoped, brand_id: brandAScoped })
          .where('id', '=', eventA)
          .execute();
        checkpointSnapshot = await evidenceSnapshot();
      });

      try {
        const response = await invoke();
        expect(response.statusCode).toBe(404);
        expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
        expect(checkpointSnapshot).toBeDefined();
        await expect(evidenceSnapshot()).resolves.toEqual(checkpointSnapshot);
      } finally {
        await db
          .updateTable('events')
          .set({ organization_id: organizationA, brand_id: brandA })
          .where('id', '=', eventA)
          .execute();
      }
    });
  });

  it('serializes concurrent category and product creates into exact +2 revision and audit evidence', async () => {
    const before = await evidenceSnapshot();
    const responses = await Promise.all([
      invokeCategory(eventA, 'Concurrent category'),
      invokeProduct(eventA, categoryA, 'Concurrent product'),
    ]);
    expect(responses.map((response) => response.statusCode)).toEqual([201, 201]);
    const createdCategory = responses[0]!.json();
    const createdProduct = responses[1]!.json();
    expect(createdCategory).toMatchObject({ eventId: eventA, name: 'Concurrent category' });
    expect(createdProduct).toMatchObject({
      eventId: eventA,
      categoryId: categoryA,
      name: 'Concurrent product',
    });

    const after = await evidenceSnapshot();
    expectEventDelta(before, after, eventA, 2);
    expect(after.categories).toHaveLength(before.categories.length + 1);
    expect(after.products).toHaveLength(before.products.length + 1);
    expect(
      serializeProductCategory(
        after.categories.find((row) => row.id === createdCategory.id) as Record<string, unknown>,
      ),
    ).toEqual(createdCategory);
    expect(
      serializeProduct(
        after.products.find((row) => row.id === createdProduct.id) as Record<string, unknown>,
      ),
    ).toEqual(createdProduct);
    expect(after.audits).toHaveLength(2);
    expectExactAudit(after.audits.find((audit) => audit.resource_id === createdCategory.id)!, {
      action: 'product_category.created',
      after: createdCategory,
      resourceId: createdCategory.id,
      resourceType: 'ProductCategory',
    });
    expectExactAudit(after.audits.find((audit) => audit.resource_id === createdProduct.id)!, {
      action: 'product.created',
      after: createdProduct,
      resourceId: createdProduct.id,
      resourceType: 'Product',
    });
  });

  it(`uses the selected ${integrationDatabaseDriver()} integration driver`, () => {
    expect(['postgres', 'mysql']).toContain(integrationDatabaseDriver());
  });
});
