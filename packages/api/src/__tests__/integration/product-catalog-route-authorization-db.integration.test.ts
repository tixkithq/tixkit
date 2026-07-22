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
const productPatchContract = productCatalogContract('patchProductsByProductId');
const categoryReadContract = productCatalogContract('getEventsByEventIdProductCategories');
const productReadContract = productCatalogContract('getEventsByEventIdProducts');

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
let productA: string;
let productAScoped: string;
let productB: string;

type ProductConfigurationOperation =
  | 'product_category_create'
  | 'product_create'
  | 'product_update';

const productConfigurationCheckpoint = vi.fn(
  async (_input: {
    stage: 'after_lock' | 'before_lock' | 'before_transaction';
    operation: ProductConfigurationOperation;
    eventId: string;
  }) => undefined,
);

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function isNowaitLockError(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
    const record = current as { cause?: unknown; code?: unknown; errno?: unknown };
    if (record.code === '55P03' || record.code === 'ER_LOCK_NOWAIT' || record.errno === 3572) {
      return true;
    }
    current = record.cause;
  }
  return false;
}

async function waitForEventWriteLock(database: Database, eventId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop -- NOWAIT polling proves the production writer owns the event lock.
      await database.transaction().execute(async (transaction) => {
        await transaction
          .selectFrom('events')
          .select('id')
          .where('id', '=', eventId)
          .forUpdate()
          .noWait()
          .executeTakeFirstOrThrow();
      });
    } catch (error) {
      if (isNowaitLockError(error)) return;
      throw error;
    }
    // eslint-disable-next-line no-await-in-loop -- bounded wait for the production writer to acquire the lock.
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for event ${eventId} write lock`);
}

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

function jsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function revisionMillis(value: Date | string | null): number {
  expect(value).not.toBeNull();
  return value instanceof Date ? value.getTime() : new Date(value!).getTime();
}

async function clearProductCatalogEvidence(): Promise<void> {
  await db
    .deleteFrom('audit_logs')
    .where('actor_id', '=', actorId)
    .where('action', 'in', ['product_category.created', 'product.created', 'product.updated'])
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
  productA = await seedProduct(eventA, categoryA, 'Allowed baseline product');
  productAScoped = await seedProduct(eventAScoped, categoryAScoped, 'Scoped baseline product');
  productB = await seedProduct(eventB, categoryB, 'Foreign baseline product');
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
      .where('action', 'in', ['product_category.created', 'product.created', 'product.updated'])
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

function invokeCategoryRead(targetEventId: string, cursor?: string) {
  const query = new URLSearchParams({ limit: '1' });
  if (cursor) query.set('cursor', cursor);
  return app.inject({
    method: categoryReadContract.method,
    url: `${categoryReadContract.path.replace('{eventId}', targetEventId)}?${query}`,
  });
}

function invokeProductRead(targetEventId: string, cursor?: string) {
  const query = new URLSearchParams({ limit: '1' });
  if (cursor) query.set('cursor', cursor);
  return app.inject({
    method: productReadContract.method,
    url: `${productReadContract.path.replace('{eventId}', targetEventId)}?${query}`,
  });
}

function invokeProduct(targetEventId: string, targetCategoryId: string, name?: string) {
  return app.inject({
    method: productContract.method,
    url: productContract.path.replace('{eventId}', targetEventId),
    payload: productPayload(targetCategoryId, name),
  });
}

function invokeProductPatch(
  targetProductId: string,
  payload: Record<string, unknown> = { name: 'Updated catalog product' },
) {
  return app.inject({
    method: productPatchContract.method,
    url: productPatchContract.path.replace('{productId}', targetProductId),
    payload,
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
    action: 'product_category.created' | 'product.created' | 'product.updated';
    before?: unknown;
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
  expect(auditDiff(audit.diff_summary)).toEqual({
    eventId: eventA,
    ...(expected.before === undefined ? {} : { before: expected.before }),
    after: expected.after,
  });
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
        stage: 'after_lock' | 'before_lock' | 'before_transaction';
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

  it('binds all five immutable route contracts to this executable proof', () => {
    for (const contract of [categoryReadContract, productReadContract]) {
      expect(contract).toMatchObject({
        authorizedControl: { status: 200 },
        deniedBoundaries: ['tenant', 'organization', 'brand', 'event'],
        permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
        source: 'product-catalog-route-authorization-db.integration.test.ts',
      });
    }
    for (const contract of [categoryContract, productContract]) {
      expect(contract).toMatchObject({
        authorizedControl: { status: 201 },
        deniedBoundaries: ['tenant', 'organization', 'brand', 'event'],
        permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
        source: 'product-catalog-route-authorization-db.integration.test.ts',
      });
    }
    expect(productPatchContract).toMatchObject({
      authorizedControl: { status: 200 },
      deniedBoundaries: ['tenant', 'organization', 'brand', 'event'],
      permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
      source: 'product-catalog-route-authorization-db.integration.test.ts',
    });
  });

  it('returns exact two-page event-scoped category and product collections', async () => {
    const secondCategoryId = await seedCategory(eventA, 'Allowed second read category');
    await seedProduct(eventA, secondCategoryId, 'Allowed second read product');
    const before = await evidenceSnapshot();
    const expectedCategories = before.categories
      .filter((category) => category.event_id === eventA)
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((category) => serializeProductCategory(category as Record<string, unknown>));
    const expectedProducts = before.products
      .filter((product) => product.event_id === eventA)
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((product) => serializeProduct(product as Record<string, unknown>));
    expect(expectedCategories).toHaveLength(2);
    expect(expectedProducts).toHaveLength(2);
    expect(expectedProducts.map((product) => product.id)).toContain(productA);
    const categoryQuery = vi.spyOn(ProductCategoryRepository.prototype, 'findByEvent');
    const productQuery = vi.spyOn(ProductRepository.prototype, 'findByEvent');

    try {
      const [firstCategoryResponse, firstProductResponse] = await Promise.all([
        invokeCategoryRead(eventA),
        invokeProductRead(eventA),
      ]);
      expect(firstCategoryResponse.statusCode, firstCategoryResponse.body).toBe(200);
      expect(firstProductResponse.statusCode, firstProductResponse.body).toBe(200);
      const [secondCategoryResponse, secondProductResponse] = await Promise.all([
        invokeCategoryRead(eventA, firstCategoryResponse.json().nextCursor),
        invokeProductRead(eventA, firstProductResponse.json().nextCursor),
      ]);

      expect(firstCategoryResponse.json()).toEqual({
        items: [expectedCategories[0]],
        nextCursor: expectedCategories[0]!.id,
        hasMore: true,
      });
      expect(secondCategoryResponse.json()).toEqual({
        items: [expectedCategories[1]],
        nextCursor: null,
        hasMore: false,
      });
      expect(firstProductResponse.json()).toEqual({
        items: [expectedProducts[0]],
        nextCursor: expectedProducts[0]!.id,
        hasMore: true,
      });
      expect(secondProductResponse.json()).toEqual({
        items: [expectedProducts[1]],
        nextCursor: null,
        hasMore: false,
      });
      expect(categoryQuery.mock.calls).toEqual([
        [eventA, 2, undefined],
        [eventA, 2, expectedCategories[0]!.id],
      ]);
      expect(productQuery.mock.calls).toEqual([
        [eventA, 2, undefined],
        [eventA, 2, expectedProducts[0]!.id],
      ]);
      for (const response of [
        firstCategoryResponse,
        secondCategoryResponse,
        firstProductResponse,
        secondProductResponse,
      ]) {
        expect(response.body).not.toContain(categoryAScoped);
        expect(response.body).not.toContain(categoryB);
        expect(response.body).not.toContain(productAScoped);
        expect(response.body).not.toContain(productB);
        expect(response.body).not.toContain('Scoped baseline');
        expect(response.body).not.toContain('Foreign baseline');
      }
      await expect(evidenceSnapshot()).resolves.toEqual(before);
    } finally {
      categoryQuery.mockRestore();
      productQuery.mockRestore();
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
    'denies the %s boundary for both reads and creates with exact catalog and audit snapshots',
    async (_boundary, makePrincipal, targetEvent, targetCategory, status) => {
      activePrincipal = makePrincipal();
      const eventId = targetEvent();
      const before = await evidenceSnapshot();
      const categoryQuery = vi.spyOn(ProductCategoryRepository.prototype, 'findByEvent');
      const productQuery = vi.spyOn(ProductRepository.prototype, 'findByEvent');

      try {
        const readResponses = [await invokeCategoryRead(eventId), await invokeProductRead(eventId)];
        expect(categoryQuery).not.toHaveBeenCalled();
        expect(productQuery).not.toHaveBeenCalled();
        for (const response of readResponses) expect(response.json()).not.toHaveProperty('items');

        const responses = [
          ...readResponses,
          await invokeCategory(eventId, 'Forbidden category'),
          await invokeProduct(eventId, targetCategory(), 'Forbidden product'),
        ];
        for (const response of responses) {
          expect(response.statusCode, response.body).toBe(status);
          expect(response.json()).toMatchObject({
            error: { code: status === 403 ? 'FORBIDDEN' : 'NOT_FOUND' },
          });
          expect(response.body).not.toContain(categoryAScoped);
          expect(response.body).not.toContain(categoryB);
          expect(response.body).not.toContain(productAScoped);
          expect(response.body).not.toContain(productB);
          expect(response.body).not.toContain('Scoped baseline');
          expect(response.body).not.toContain('Foreign baseline');
        }
        await expect(evidenceSnapshot()).resolves.toEqual(before);
      } finally {
        categoryQuery.mockRestore();
        productQuery.mockRestore();
      }
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

  it('updates a product atomically with a public revision and exact before-and-after audit', async () => {
    const before = await evidenceSnapshot();
    const beforeProduct = jsonValue(
      serializeProduct(
        before.products.find((product) => product.id === productA) as Record<string, unknown>,
      ),
    );
    const response = await invokeProductPatch(productA, {
      name: 'Updated catalog product',
      description: null,
      priceCents: 9_876,
      currency: 'GBP',
      categoryId: null,
      maxPerOrder: 8,
      availableFrom: '2027-07-01T13:15:30.000Z',
      availableUntil: '2027-08-31T22:45:15.000Z',
      status: 'inactive',
      sortOrder: 29,
    });
    expect(response.statusCode, response.body).toBe(200);
    const updated = response.json();
    expect(updated).toMatchObject({
      id: productA,
      eventId: eventA,
      name: 'Updated catalog product',
      priceCents: 9_876,
      currency: 'GBP',
      maxPerOrder: 8,
      availableFrom: '2027-07-01T13:15:30.000Z',
      availableUntil: '2027-08-31T22:45:15.000Z',
      status: 'inactive',
      sortOrder: 29,
    });
    expect(updated).not.toHaveProperty('description');
    expect(updated).not.toHaveProperty('categoryId');

    const after = await evidenceSnapshot();
    expectEventDelta(before, after, eventA, 1);
    expect(
      jsonValue(
        serializeProduct(
          after.products.find((product) => product.id === productA) as Record<string, unknown>,
        ),
      ),
    ).toEqual(updated);
    expect(after.audits).toHaveLength(1);
    expectExactAudit(after.audits[0]!, {
      action: 'product.updated',
      before: beforeProduct,
      after: updated,
      resourceId: productA,
      resourceType: 'Product',
    });
  });

  it.each([
    ['permission', () => ({ ...basePrincipal, scopes: [] }), () => productA, 403],
    ['tenant', () => basePrincipal, () => productB, 404],
    [
      'organization',
      () => ({ ...basePrincipal, organizationIds: [organizationA] }),
      () => productAScoped,
      404,
    ],
    [
      'brand',
      () => ({
        ...basePrincipal,
        organizationIds: [organizationA, organizationAScoped],
        brandIds: [brandA],
      }),
      () => productAScoped,
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
      () => productAScoped,
      404,
    ],
  ] as const)(
    'denies the %s boundary for product updates without checkpoint or persistence side effects',
    async (_boundary, makePrincipal, targetProduct, status) => {
      activePrincipal = makePrincipal();
      const before = await evidenceSnapshot();
      const response = await invokeProductPatch(targetProduct(), {
        name: 'Forbidden catalog update',
      });
      expect(response.statusCode, response.body).toBe(status);
      expect(response.json()).toMatchObject({
        error: { code: status === 403 ? 'FORBIDDEN' : 'NOT_FOUND' },
      });
      const target = targetProduct();
      if (status === 404) {
        expect(response.json()).toMatchObject({
          error: {
            message: `Product not found: ${target}`,
            details: { resource: 'Product', id: target },
          },
        });
      }
      for (const concealedProductId of [productAScoped, productB]) {
        if (concealedProductId !== target) {
          expect(response.body).not.toContain(concealedProductId);
        }
      }
      expect(response.body).not.toContain('Scoped baseline');
      expect(response.body).not.toContain('Foreign baseline');
      expect(productConfigurationCheckpoint).not.toHaveBeenCalled();
      await expect(evidenceSnapshot()).resolves.toEqual(before);
    },
  );

  it('rejects a category from another event without mutating the product, revision, or audit', async () => {
    const before = await evidenceSnapshot();
    const response = await invokeProductPatch(productA, { categoryId: categoryAScoped });
    expect(response.statusCode, response.body).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    await expect(evidenceSnapshot()).resolves.toEqual(before);
  });

  it.each([
    [
      'product',
      async () => {
        await db
          .updateTable('products')
          .set({ event_id: eventAScoped })
          .where('id', '=', productA)
          .execute();
      },
    ],
    [
      'category',
      async () => {
        await db
          .updateTable('product_categories')
          .set({ event_id: eventAScoped })
          .where('id', '=', categoryA)
          .execute();
      },
    ],
    [
      'event scope',
      async () => {
        await db
          .updateTable('events')
          .set({ organization_id: organizationAScoped, brand_id: brandAScoped })
          .where('id', '=', eventA)
          .execute();
      },
    ],
  ] as const)(
    'fails closed when the requested %s is reparented at the deterministic checkpoint',
    async (_resource, reparent) => {
      let checkpointSnapshot: Awaited<ReturnType<typeof evidenceSnapshot>> | undefined;
      productConfigurationCheckpoint.mockImplementationOnce(async () => {
        await reparent();
        checkpointSnapshot = await evidenceSnapshot();
      });

      try {
        const response = await invokeProductPatch(productA, {
          name: 'Race catalog update',
          categoryId: categoryA,
        });
        expect(response.statusCode, response.body).toBe(404);
        if (_resource === 'category') {
          expect(response.json()).toMatchObject({
            error: {
              code: 'NOT_FOUND',
              message: `ProductCategory not found: ${categoryA}`,
              details: { resource: 'ProductCategory', id: categoryA },
            },
          });
        } else {
          expect(response.json()).toMatchObject({
            error: {
              code: 'NOT_FOUND',
              message: `Product not found: ${productA}`,
              details: { resource: 'Product', id: productA },
            },
          });
        }
        expect(checkpointSnapshot).toBeDefined();
        await expect(evidenceSnapshot()).resolves.toEqual(checkpointSnapshot);
      } finally {
        if (_resource === 'event scope') {
          await db
            .updateTable('events')
            .set({ organization_id: organizationA, brand_id: brandA })
            .where('id', '=', eventA)
            .execute();
        }
      }
    },
  );

  it('rolls back product, public revision, and audit when its required audit write fails', async () => {
    const before = await evidenceSnapshot();
    const failure = vi
      .spyOn(AuditLogRepository.prototype, 'create')
      .mockRejectedValueOnce(new Error('injected product update audit failure'));
    try {
      const response = await invokeProductPatch(productA, {
        name: 'Audit rollback catalog update',
      });
      expect(response.statusCode, response.body).toBe(500);
      await expect(evidenceSnapshot()).resolves.toEqual(before);
    } finally {
      failure.mockRestore();
    }
  });

  it('serializes concurrent product updates into exact +2 public revision and audit evidence', async () => {
    const before = await evidenceSnapshot();
    const firstAfterLock = deferred();
    const secondBeforeLock = deferred();
    const releaseFirst = deferred();
    let afterLockCount = 0;
    let beforeLockCount = 0;
    let secondCompleted = false;
    productConfigurationCheckpoint.mockImplementation(async (input) => {
      if (input.operation !== 'product_update') return;
      if (input.stage === 'before_lock') {
        beforeLockCount += 1;
        if (beforeLockCount === 2) secondBeforeLock.resolve();
        return;
      }
      if (input.stage === 'before_transaction') return;
      afterLockCount += 1;
      if (afterLockCount === 1) {
        firstAfterLock.resolve();
        await releaseFirst.promise;
      }
    });

    const firstRequest = invokeProductPatch(productA, { name: 'Concurrent catalog update one' });
    await firstAfterLock.promise;
    const secondRequest = invokeProductPatch(productA, {
      name: 'Concurrent catalog update two',
    }).finally(() => {
      secondCompleted = true;
    });
    await secondBeforeLock.promise;
    await waitForEventWriteLock(db, eventA);
    expect(afterLockCount).toBe(1);
    expect(secondCompleted).toBe(false);
    releaseFirst.resolve();
    const [first, second] = await Promise.all([firstRequest, secondRequest]);
    expect([first.statusCode, second.statusCode], `${first.body}\n${second.body}`).toEqual([
      200, 200,
    ]);

    const after = await evidenceSnapshot();
    expectEventDelta(before, after, eventA, 2);
    expect(after.audits).toHaveLength(2);
    const auditsByName = new Map(
      after.audits.map((audit) => {
        const diff = auditDiff(audit.diff_summary);
        return [(diff.after as Record<string, unknown>).name, diff] as const;
      }),
    );
    const firstAudit = auditsByName.get('Concurrent catalog update one');
    const secondAudit = auditsByName.get('Concurrent catalog update two');
    if (!firstAudit || !secondAudit) {
      throw new Error('Expected both concurrent product update audit records');
    }
    expect(firstAudit.before).toEqual(
      jsonValue(
        serializeProduct(
          before.products.find((product) => product.id === productA) as Record<string, unknown>,
        ),
      ),
    );
    expect((firstAudit.after as Record<string, unknown>).name).toBe(
      'Concurrent catalog update one',
    );
    expect(secondAudit.before).toEqual(firstAudit.after);
    expect((secondAudit.after as Record<string, unknown>).name).toBe(
      'Concurrent catalog update two',
    );
    expect(
      jsonValue(
        serializeProduct(
          after.products.find((product) => product.id === productA) as Record<string, unknown>,
        ),
      ),
    ).toEqual(secondAudit.after);
  });

  it(`uses the selected ${integrationDatabaseDriver()} integration driver`, () => {
    expect(['postgres', 'mysql']).toContain(integrationDatabaseDriver());
  });
});
