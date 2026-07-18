import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import { AuditLogRepository, createDb, EventRepository, type Database } from '@tixkit/db';
import { ALL_PERMISSIONS, type Principal } from '@tixkit/domain';
import { ulid } from 'ulid';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { registerErrorHandler, type AppContext } from '../../app.js';
import { questionRoutes } from '../../routes/modules/questions.js';
import {
  describeWithIntegrationDatabase,
  integrationDatabaseUrl,
  restoreDatabaseDriver,
  setIntegrationDatabaseDriver,
} from './integration-database.js';
import { EVENT_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS } from './route-authorization-contracts.js';

function questionReorderContract() {
  const contract = EVENT_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS.find(
    (candidate) => candidate.operationId === 'postEventsByEventIdQuestionsReorder',
  );
  if (!contract) throw new Error('question reorder authorization contract missing');
  return contract;
}

const reorderContract = questionReorderContract();

const suffix = ulid().slice(-10).toLowerCase();
const tenantA = `tnt_qreo_auth_a_${suffix}`;
const tenantB = `tnt_qreo_auth_b_${suffix}`;
const organizationA = `org_qreo_auth_a_${suffix}`;
const organizationAScoped = `org_qreo_auth_scope_${suffix}`;
const organizationB = `org_qreo_auth_b_${suffix}`;
const brandA = `brd_qreo_auth_a_${suffix}`;
const brandAScoped = `brd_qreo_auth_scope_${suffix}`;
const brandB = `brd_qreo_auth_b_${suffix}`;
const actorId = `usr_qreo_auth_${suffix}`;

let app: FastifyInstance;
let db: Database;
let previousDriver: string | undefined;
let activePrincipal: Principal;
let basePrincipal: Principal;
let eventA: string;
let eventAScoped: string;
let eventB: string;

const questionAFirst = `q_qreo_first_${suffix}`;
const questionASecond = `q_qreo_second_${suffix}`;
const questionAHidden = `q_qreo_hidden_${suffix}`;
const questionScoped = `q_qreo_scoped_${suffix}`;
const questionForeign = `q_qreo_foreign_${suffix}`;
const allQuestionIds = [
  questionAFirst,
  questionASecond,
  questionAHidden,
  questionScoped,
  questionForeign,
];

const questionReorderCheckpoint = vi.fn(
  async (_input: { stage: 'before_transaction'; eventId: string }) => undefined,
);

type ReorderItem = Readonly<{ id: string; sortOrder: number }>;

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
    venue: { name: 'Question reorder authorization hall' },
  });
  return event.id;
}

async function insertQuestion(
  id: string,
  eventId: string,
  sortOrder: number,
  hidden = false,
): Promise<void> {
  const now = new Date('2026-07-17T12:00:00.000Z');
  await db
    .insertInto('questions')
    .values({
      id,
      event_id: eventId,
      ticket_type_id: null,
      type: 'text',
      label: `Question ${id}`,
      description: null,
      required: false,
      applies_to: 'buyer',
      options: null,
      placeholder: null,
      validation_pattern: null,
      conditional_visibility: null,
      status: hidden ? 'hidden' : 'active',
      is_hidden: hidden,
      hidden_at: hidden ? now : null,
      deleted_at: null,
      sort_order: sortOrder,
      is_consent_field: false,
      consent_text: null,
      consent_version: null,
      created_at: now,
      updated_at: now,
    })
    .execute();
}

function auditDiff(value: unknown): Record<string, unknown> {
  return (typeof value === 'string' ? JSON.parse(value) : value) as Record<string, unknown>;
}

function revisionMillis(value: Date | string | null): number {
  expect(value).not.toBeNull();
  return value instanceof Date ? value.getTime() : new Date(value!).getTime();
}

async function clearQuestionReorderEvidence(): Promise<void> {
  await db
    .deleteFrom('audit_logs')
    .where('actor_id', '=', actorId)
    .where('action', '=', 'event.questions.reordered')
    .execute();
  const now = new Date('2026-07-17T12:00:00.000Z');
  for (const [id, sortOrder] of [
    [questionAFirst, 0],
    [questionASecond, 1],
    [questionAHidden, 2],
    [questionScoped, 0],
    [questionForeign, 0],
  ] as const) {
    // eslint-disable-next-line no-await-in-loop -- deterministic cross-dialect fixture reset.
    await db
      .updateTable('questions')
      .set({ sort_order: sortOrder, updated_at: now })
      .where('id', '=', id)
      .execute();
  }
}

async function evidenceSnapshot() {
  const [events, questions, audits] = await Promise.all([
    db
      .selectFrom('events')
      .select(['id', 'tenant_id', 'organization_id', 'brand_id', 'version', 'public_revision'])
      .where('id', 'in', [eventA, eventAScoped, eventB])
      .orderBy('id')
      .execute(),
    db
      .selectFrom('questions')
      .select(['id', 'event_id', 'sort_order', 'status', 'is_hidden', 'updated_at'])
      .where('id', 'in', allQuestionIds)
      .orderBy('id')
      .execute(),
    db
      .selectFrom('audit_logs')
      .selectAll()
      .where('actor_id', '=', actorId)
      .where('action', '=', 'event.questions.reordered')
      .orderBy('id')
      .execute(),
  ]);
  return { events, questions, audits };
}

function invokeReorder(targetEventId: string, questions: InjectOptions['payload']) {
  return app.inject({
    method: reorderContract.method,
    url: reorderContract.path.replace('{eventId}', targetEventId),
    payload: questions,
  });
}

function payload(items: readonly ReorderItem[]) {
  return { questions: items };
}

function eventFrom(snapshot: Awaited<ReturnType<typeof evidenceSnapshot>>, eventId: string) {
  return snapshot.events.find((event) => event.id === eventId)!;
}

function questionOrders(
  snapshot: Awaited<ReturnType<typeof evidenceSnapshot>>,
  ids: readonly string[],
) {
  return Object.fromEntries(
    snapshot.questions
      .filter((question) => ids.includes(question.id))
      .map((question) => [question.id, Number(question.sort_order)]),
  );
}

function visibleResponseItems(response: Awaited<ReturnType<FastifyInstance['inject']>>) {
  return (response.json() as { items: Array<{ id: string; sortOrder: number }> }).items.map(
    (question) => ({ id: question.id, sortOrder: question.sortOrder }),
  );
}

describeWithIntegrationDatabase('question reorder write route authorization matrix', () => {
  beforeAll(async () => {
    previousDriver = setIntegrationDatabaseDriver();
    db = createDb(integrationDatabaseUrl());

    await insertTenant(tenantA, 'Question reorder authorization tenant A');
    await insertTenant(tenantB, 'Question reorder authorization tenant B');
    await insertOrganization(organizationA, tenantA, 'Question reorder authorization org A');
    await insertOrganization(
      organizationAScoped,
      tenantA,
      'Question reorder authorization scoped org',
    );
    await insertOrganization(organizationB, tenantB, 'Question reorder authorization org B');
    await insertBrand(brandA, tenantA, organizationA, 'Question reorder authorization brand A');
    await insertBrand(
      brandAScoped,
      tenantA,
      organizationAScoped,
      'Question reorder authorization scoped brand',
    );
    await insertBrand(brandB, tenantB, organizationB, 'Question reorder authorization brand B');
    eventA = await createEvent(tenantA, organizationA, brandA, 'Allowed question reorder event');
    eventAScoped = await createEvent(
      tenantA,
      organizationAScoped,
      brandAScoped,
      'Scoped question reorder event',
    );
    eventB = await createEvent(tenantB, organizationB, brandB, 'Foreign question reorder event');
    await insertQuestion(questionAFirst, eventA, 0);
    await insertQuestion(questionASecond, eventA, 1);
    await insertQuestion(questionAHidden, eventA, 2, true);
    await insertQuestion(questionScoped, eventAScoped, 0);
    await insertQuestion(questionForeign, eventB, 0);

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
      questionReorderCheckpoint: (input: { stage: 'before_transaction'; eventId: string }) =>
        questionReorderCheckpoint(input),
    } as AppContext);
    app.addHook('onRequest', async (request) => {
      request.principal = activePrincipal;
    });
    registerErrorHandler(app);
    await app.register(questionRoutes);
    await app.ready();
  });

  beforeEach(async () => {
    activePrincipal = basePrincipal;
    questionReorderCheckpoint.mockReset();
    questionReorderCheckpoint.mockResolvedValue(undefined);
    await clearQuestionReorderEvidence();
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
      await cleanup(() =>
        db
          .deleteFrom('audit_logs')
          .where('actor_id', '=', actorId)
          .where('action', '=', 'event.questions.reordered')
          .execute(),
      );
      await cleanup(() => db.deleteFrom('questions').where('id', 'in', allQuestionIds).execute());
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
      throw new AggregateError(cleanupErrors, 'Failed to clean up question reorder proof');
    }
  });

  it('binds the immutable route contract to this executable proof', () => {
    expect(reorderContract).toMatchObject({
      authorizedControl: { status: 200 },
      deniedBoundaries: ['tenant', 'organization', 'brand', 'event'],
      method: 'POST',
      permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
      persistenceSource: 'question-reorder-route-authorization-db.integration.test.ts',
      source: 'question-reorder-route-authorization-db.integration.test.ts',
    });
  });

  it('persists the exact order with one monotonic revision and exact atomic audit', async () => {
    const before = await evidenceSnapshot();
    const eventBefore = eventFrom(before, eventA);
    const requested = [
      { id: questionASecond, sortOrder: 10 },
      { id: questionAFirst, sortOrder: 20 },
    ];

    const response = await invokeReorder(eventA, payload(requested));

    expect(response.statusCode, response.body).toBe(reorderContract.authorizedControl.status);
    expect(visibleResponseItems(response)).toEqual(requested);
    const after = await evidenceSnapshot();
    const eventAfter = eventFrom(after, eventA);
    expect(questionOrders(after, [questionAFirst, questionASecond])).toEqual({
      [questionAFirst]: 20,
      [questionASecond]: 10,
    });
    expect(Number(eventAfter.version)).toBe(Number(eventBefore.version) + 1);
    expect(revisionMillis(eventAfter.public_revision)).toBeGreaterThan(
      revisionMillis(eventBefore.public_revision),
    );
    expect(after.audits).toHaveLength(1);
    expect(after.audits[0]).toMatchObject({
      tenant_id: tenantA,
      organization_id: organizationA,
      brand_id: brandA,
      actor_type: 'user',
      actor_id: actorId,
      action: 'event.questions.reordered',
      resource_type: 'Event',
      resource_id: eventA,
    });
    expect(auditDiff(after.audits[0]!.diff_summary)).toEqual({
      before: [
        { id: questionAFirst, sortOrder: 0 },
        { id: questionASecond, sortOrder: 1 },
      ],
      after: [
        { id: questionAFirst, sortOrder: 20 },
        { id: questionASecond, sortOrder: 10 },
      ],
      previousVersion: Number(eventBefore.version),
      newVersion: Number(eventBefore.version) + 1,
    });
  });

  it.each([
    ['permission', () => ({ ...basePrincipal, scopes: [] }), () => eventA, 403, 'FORBIDDEN'],
    ['tenant', () => basePrincipal, () => eventB, 404, 'NOT_FOUND'],
    [
      'organization',
      () => ({ ...basePrincipal, organizationIds: [organizationA] }),
      () => eventAScoped,
      404,
      'NOT_FOUND',
    ],
    [
      'brand',
      () => ({
        ...basePrincipal,
        organizationIds: [organizationA, organizationAScoped],
        brandIds: [brandA],
      }),
      () => eventAScoped,
      404,
      'NOT_FOUND',
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
      404,
      'NOT_FOUND',
    ],
  ] as const)(
    'denies the %s boundary without event, question, revision, or audit mutation',
    async (_boundary, makePrincipal, targetEvent, status, code) => {
      activePrincipal = makePrincipal();
      const before = await evidenceSnapshot();
      const targetQuestion = targetEvent() === eventB ? questionForeign : questionScoped;

      const response = await invokeReorder(
        targetEvent(),
        payload([{ id: targetQuestion, sortOrder: 9 }]),
      );

      expect(response.statusCode, response.body).toBe(status);
      expect(response.json()).toMatchObject({ error: { code } });
      await expect(evidenceSnapshot()).resolves.toEqual(before);
    },
  );

  it('revalidates authorization against the locked event after a real scope swap', async () => {
    let checkpointSnapshot: Awaited<ReturnType<typeof evidenceSnapshot>> | undefined;
    questionReorderCheckpoint.mockImplementationOnce(async () => {
      await db
        .updateTable('events')
        .set({ organization_id: organizationAScoped, brand_id: brandAScoped })
        .where('id', '=', eventA)
        .execute();
      checkpointSnapshot = await evidenceSnapshot();
    });

    try {
      const response = await invokeReorder(eventA, payload([{ id: questionAFirst, sortOrder: 9 }]));
      expect(response.statusCode, response.body).toBe(404);
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

  it.each([
    [
      'duplicate ID',
      payload([
        { id: questionAFirst, sortOrder: 1 },
        { id: questionAFirst, sortOrder: 2 },
      ]),
      400,
      'VALIDATION_ERROR',
    ],
    [
      'missing question',
      payload([{ id: `q_qreo_missing_${suffix}`, sortOrder: 1 }]),
      404,
      'NOT_FOUND',
    ],
    ['foreign question', payload([{ id: questionForeign, sortOrder: 1 }]), 404, 'NOT_FOUND'],
    ['empty question list', payload([]), 400, 'VALIDATION_ERROR'],
    ['missing question list', {}, 400, 'VALIDATION_ERROR'],
    [
      'fractional sort order',
      payload([{ id: questionAFirst, sortOrder: 1.5 }]),
      400,
      'VALIDATION_ERROR',
    ],
    [
      'unknown root property',
      { ...payload([{ id: questionAFirst, sortOrder: 1 }]), unexpected: true },
      400,
      'VALIDATION_ERROR',
    ],
    [
      'unknown nested property',
      { questions: [{ id: questionAFirst, sortOrder: 1, unexpected: true }] },
      400,
      'VALIDATION_ERROR',
    ],
  ] as const)('rejects %s without persistence', async (_name, requestPayload, status, code) => {
    const before = await evidenceSnapshot();
    const response = await invokeReorder(eventA, requestPayload);
    expect(response.statusCode, response.body).toBe(status);
    expect(response.json()).toMatchObject({ error: { code } });
    await expect(evidenceSnapshot()).resolves.toEqual(before);
  });

  it('rolls back a real second-update database failure and permits an exact clean retry', async () => {
    const before = await evidenceSnapshot();
    const failed = await invokeReorder(
      eventA,
      payload([
        { id: questionAFirst, sortOrder: 11 },
        { id: questionASecond, sortOrder: 2_147_483_648 },
      ]),
    );
    expect(failed.statusCode).toBe(500);
    await expect(evidenceSnapshot()).resolves.toEqual(before);

    const retryPayload = payload([
      { id: questionAFirst, sortOrder: 11 },
      { id: questionASecond, sortOrder: 12 },
    ]);
    const retry = await invokeReorder(eventA, retryPayload);
    expect(retry.statusCode, retry.body).toBe(200);
    expect(visibleResponseItems(retry)).toEqual(retryPayload.questions);
    const after = await evidenceSnapshot();
    expect(questionOrders(after, [questionAFirst, questionASecond])).toEqual({
      [questionAFirst]: 11,
      [questionASecond]: 12,
    });
    expect(after.audits).toHaveLength(1);
  });

  it('rolls back an audit failure and permits an exact clean retry', async () => {
    const before = await evidenceSnapshot();
    const requested = payload([
      { id: questionASecond, sortOrder: 4 },
      { id: questionAFirst, sortOrder: 5 },
    ]);
    const failure = vi
      .spyOn(AuditLogRepository.prototype, 'create')
      .mockRejectedValueOnce(new Error('injected question reorder audit failure'));
    try {
      const failed = await invokeReorder(eventA, requested);
      expect(failed.statusCode).toBe(500);
      await expect(evidenceSnapshot()).resolves.toEqual(before);
    } finally {
      failure.mockRestore();
    }

    const retry = await invokeReorder(eventA, requested);
    expect(retry.statusCode, retry.body).toBe(200);
    expect(visibleResponseItems(retry)).toEqual(requested.questions);
    const after = await evidenceSnapshot();
    expect(after.audits).toHaveLength(1);
    expect(questionOrders(after, [questionAFirst, questionASecond])).toEqual({
      [questionAFirst]: 5,
      [questionASecond]: 4,
    });
  });

  it('reorders hidden questions atomically while omitting them from the response', async () => {
    const before = await evidenceSnapshot();
    const eventBefore = eventFrom(before, eventA);
    const response = await invokeReorder(
      eventA,
      payload([
        { id: questionAHidden, sortOrder: -5 },
        { id: questionAFirst, sortOrder: 8 },
      ]),
    );

    expect(response.statusCode, response.body).toBe(200);
    expect(visibleResponseItems(response)).toEqual([{ id: questionAFirst, sortOrder: 8 }]);
    expect(response.json()).toMatchObject({ hasMore: false });
    const after = await evidenceSnapshot();
    expect(questionOrders(after, [questionAFirst, questionAHidden])).toEqual({
      [questionAFirst]: 8,
      [questionAHidden]: -5,
    });
    expect(Number(eventFrom(after, eventA).version)).toBe(Number(eventBefore.version) + 1);
    expect(after.audits).toHaveLength(1);
    expect(auditDiff(after.audits[0]!.diff_summary)).toMatchObject({
      before: expect.arrayContaining([
        { id: questionAFirst, sortOrder: 0 },
        { id: questionAHidden, sortOrder: 2 },
      ]),
      after: expect.arrayContaining([
        { id: questionAFirst, sortOrder: 8 },
        { id: questionAHidden, sortOrder: -5 },
      ]),
    });
  });

  it('serializes concurrent distinct reorders into an exact two-transition chain', async () => {
    const before = await evidenceSnapshot();
    const eventBefore = eventFrom(before, eventA);
    const firstPayload = payload([
      { id: questionAFirst, sortOrder: 10 },
      { id: questionASecond, sortOrder: 20 },
    ]);
    const secondPayload = payload([
      { id: questionAFirst, sortOrder: 30 },
      { id: questionASecond, sortOrder: 40 },
    ]);

    const responses = await Promise.all([
      invokeReorder(eventA, firstPayload),
      invokeReorder(eventA, secondPayload),
    ]);

    expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
    expect(visibleResponseItems(responses[0]!)).toEqual(firstPayload.questions);
    expect(visibleResponseItems(responses[1]!)).toEqual(secondPayload.questions);
    const after = await evidenceSnapshot();
    const eventAfter = eventFrom(after, eventA);
    expect(Number(eventAfter.version)).toBe(Number(eventBefore.version) + 2);
    expect(revisionMillis(eventAfter.public_revision)).toBeGreaterThan(
      revisionMillis(eventBefore.public_revision),
    );
    expect(after.audits).toHaveLength(2);

    const transitions = after.audits.map((audit) => auditDiff(audit.diff_summary));
    const first = transitions.find(
      (transition) => transition.previousVersion === Number(eventBefore.version),
    )!;
    const second = transitions.find(
      (transition) => transition.previousVersion === Number(eventBefore.version) + 1,
    )!;
    expect(first.newVersion).toBe(Number(eventBefore.version) + 1);
    expect(second.newVersion).toBe(Number(eventBefore.version) + 2);
    expect(second.before).toEqual(first.after);
    expect([first.after, second.after]).toEqual(
      expect.arrayContaining([
        [
          { id: questionAFirst, sortOrder: 10 },
          { id: questionASecond, sortOrder: 20 },
        ],
        [
          { id: questionAFirst, sortOrder: 30 },
          { id: questionASecond, sortOrder: 40 },
        ],
      ]),
    );
    expect(questionOrders(after, [questionAFirst, questionASecond])).toEqual(
      Object.fromEntries(
        (second.after as ReorderItem[]).map((question) => [question.id, question.sortOrder]),
      ),
    );
  });
});
