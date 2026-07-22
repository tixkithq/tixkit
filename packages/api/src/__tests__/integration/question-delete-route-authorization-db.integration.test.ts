import Fastify, { type FastifyInstance } from 'fastify';
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

function questionDeleteContract() {
  const contract = EVENT_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS.find(
    (candidate) => candidate.operationId === 'deleteQuestionsByQuestionId',
  );
  if (!contract) throw new Error('question delete authorization contract missing');
  return contract;
}

const questionDelete = questionDeleteContract();
const suffix = ulid().slice(-10).toLowerCase();
const tenantA = `tnt_qdel_a_${suffix}`;
const tenantB = `tnt_qdel_b_${suffix}`;
const organizationA = `org_qdel_a_${suffix}`;
const organizationAScoped = `org_qdel_scope_${suffix}`;
const organizationB = `org_qdel_b_${suffix}`;
const brandA = `brd_qdel_a_${suffix}`;
const brandAScoped = `brd_qdel_scope_${suffix}`;
const brandB = `brd_qdel_b_${suffix}`;
const actorId = `usr_qdel_${suffix}`;
const questionHard = `q_qdel_hard_${suffix}`;
const questionHistorical = `q_qdel_history_${suffix}`;
const questionDependentSource = `q_qdel_source_${suffix}`;
const questionDependent = `q_qdel_dependent_${suffix}`;
const questionScoped = `q_qdel_scoped_${suffix}`;
const questionForeign = `q_qdel_foreign_${suffix}`;
const questionRace = `q_qdel_race_${suffix}`;
const questionPatchRace = `q_qdel_patch_race_${suffix}`;
const questionIds = [
  questionHard,
  questionHistorical,
  questionDependentSource,
  questionDependent,
  questionScoped,
  questionForeign,
  questionRace,
  questionPatchRace,
];
const checkoutId = `cs_qdel_history_${suffix}`;

let app: FastifyInstance;
let db: Database;
let previousDriver: string | undefined;
let activePrincipal: Principal;
let basePrincipal: Principal;
let eventA: string;
let eventAScoped: string;
let eventB: string;
let checkpoint: AppContext['questionDeleteCheckpoint'];

async function insertTenant(id: string): Promise<void> {
  const now = new Date('2026-07-22T12:00:00.000Z');
  await db
    .insertInto('tenants')
    .values({ id, name: id, status: 'active', plan: 'test', created_at: now, updated_at: now })
    .execute();
}

async function insertOrganization(id: string, tenantId: string): Promise<void> {
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

async function insertBrand(id: string, tenantId: string, organizationId: string): Promise<void> {
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
    venue: { name: 'Question deletion authorization hall' },
  });
  return event.id;
}

async function insertQuestion(
  id: string,
  eventId: string,
  conditionalVisibility: string | null = null,
): Promise<void> {
  const now = new Date('2026-07-22T12:00:00.000Z');
  await db
    .insertInto('questions')
    .values({
      id,
      event_id: eventId,
      ticket_type_id: null,
      type: 'text',
      label: id,
      description: null,
      required: false,
      applies_to: 'buyer',
      options: null,
      placeholder: null,
      validation_pattern: null,
      conditional_visibility: conditionalVisibility,
      status: 'active',
      is_hidden: false,
      hidden_at: null,
      deleted_at: null,
      sort_order: 0,
      is_consent_field: false,
      consent_text: null,
      consent_version: null,
      created_at: now,
      updated_at: now,
    })
    .execute();
}

async function resetQuestions(): Promise<void> {
  await db.deleteFrom('checkout_sessions').where('id', '=', checkoutId).execute();
  await db.deleteFrom('questions').where('id', 'in', questionIds).execute();
  await insertQuestion(questionHard, eventA);
  await insertQuestion(questionHistorical, eventA);
  await insertQuestion(questionDependentSource, eventA);
  await insertQuestion(
    questionDependent,
    eventA,
    JSON.stringify({ field: questionDependentSource, operator: 'equals', value: 'yes' }),
  );
  await insertQuestion(questionScoped, eventAScoped);
  await insertQuestion(questionForeign, eventB);
  await insertQuestion(questionPatchRace, eventA);
}

async function insertHistoricalCheckout(): Promise<void> {
  const now = new Date('2026-07-22T12:00:00.000Z');
  await db
    .insertInto('checkout_sessions')
    .values({
      id: checkoutId,
      tenant_id: tenantA,
      event_id: eventA,
      brand_id: brandA,
      status: 'open',
      hold_id: `hld_qdel_${suffix}`,
      currency: 'USD',
      cart: JSON.stringify({ answers: { [questionHistorical]: 'saved answer' } }),
      buyer: JSON.stringify({ email: 'question-delete@example.test' }),
      quote: JSON.stringify({ totalCents: 0 }),
      expires_at: new Date('2027-01-01T18:30:00.000Z'),
      idempotency_key: `idem_qdel_${suffix}`,
      success_url: null,
      cancel_url: null,
      order_id: null,
      client_token: `client_qdel_${suffix}`,
      payment_intent_id: null,
      created_at: now,
      updated_at: now,
    })
    .execute();
}

function revisionMillis(value: Date | string | null): number {
  expect(value).not.toBeNull();
  return value instanceof Date ? value.getTime() : new Date(value!).getTime();
}

function auditDiff(value: unknown): Record<string, unknown> {
  return (typeof value === 'string' ? JSON.parse(value) : value) as Record<string, unknown>;
}

async function snapshot() {
  const [events, questions, audits] = await Promise.all([
    db
      .selectFrom('events')
      .select(['id', 'tenant_id', 'organization_id', 'brand_id', 'version', 'public_revision'])
      .where('id', 'in', [eventA, eventAScoped, eventB])
      .orderBy('id')
      .execute(),
    db
      .selectFrom('questions')
      .select([
        'id',
        'event_id',
        'status',
        'is_hidden',
        'hidden_at',
        'deleted_at',
        'conditional_visibility',
      ])
      .where('id', 'in', questionIds)
      .orderBy('id')
      .execute(),
    db
      .selectFrom('audit_logs')
      .select([
        'tenant_id',
        'organization_id',
        'brand_id',
        'actor_type',
        'actor_id',
        'action',
        'resource_type',
        'resource_id',
        'diff_summary',
      ])
      .where('actor_id', '=', actorId)
      .where('action', '=', 'event.question.deleted')
      .orderBy('resource_id')
      .execute(),
  ]);
  return { events, questions, audits };
}

function eventFrom(snapshotValue: Awaited<ReturnType<typeof snapshot>>, eventId: string) {
  return snapshotValue.events.find((event) => event.id === eventId)!;
}

function deleteQuestion(questionId: string) {
  return app.inject({
    method: questionDelete.method,
    url: questionDelete.path.replace('{questionId}', questionId),
  });
}

describeWithIntegrationDatabase('question delete write route authorization matrix', () => {
  beforeAll(async () => {
    previousDriver = setIntegrationDatabaseDriver();
    db = createDb(integrationDatabaseUrl());
    await insertTenant(tenantA);
    await insertTenant(tenantB);
    await insertOrganization(organizationA, tenantA);
    await insertOrganization(organizationAScoped, tenantA);
    await insertOrganization(organizationB, tenantB);
    await insertBrand(brandA, tenantA, organizationA);
    await insertBrand(brandAScoped, tenantA, organizationAScoped);
    await insertBrand(brandB, tenantB, organizationB);
    eventA = await createEvent(tenantA, organizationA, brandA, 'Allowed question deletion event');
    eventAScoped = await createEvent(
      tenantA,
      organizationAScoped,
      brandAScoped,
      'Scoped question deletion event',
    );
    eventB = await createEvent(tenantB, organizationB, brandB, 'Foreign question deletion event');
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
      questionDeleteCheckpoint: (
        input: Parameters<NonNullable<AppContext['questionDeleteCheckpoint']>>[0],
      ) => checkpoint?.(input),
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
    checkpoint = undefined;
    await db
      .deleteFrom('audit_logs')
      .where('actor_id', '=', actorId)
      .where('action', '=', 'event.question.deleted')
      .execute();
    await resetQuestions();
  });

  afterAll(async () => {
    const errors: unknown[] = [];
    const attempt = async (action: () => Promise<unknown>) => {
      try {
        await action();
      } catch (error) {
        errors.push(error);
      }
    };
    if (app) await attempt(() => app.close());
    if (db) {
      await attempt(() =>
        db.deleteFrom('checkout_sessions').where('id', '=', checkoutId).execute(),
      );
      await attempt(() => db.deleteFrom('audit_logs').where('actor_id', '=', actorId).execute());
      await attempt(() => db.deleteFrom('questions').where('id', 'in', questionIds).execute());
      for (const id of [eventA, eventAScoped, eventB]) {
        await attempt(() => db.deleteFrom('events').where('id', '=', id).execute());
      }
      for (const id of [brandA, brandAScoped, brandB]) {
        await attempt(() => db.deleteFrom('brands').where('id', '=', id).execute());
      }
      for (const id of [organizationA, organizationAScoped, organizationB]) {
        await attempt(() => db.deleteFrom('organizations').where('id', '=', id).execute());
      }
      for (const id of [tenantA, tenantB]) {
        await attempt(() => db.deleteFrom('tenants').where('id', '=', id).execute());
      }
      await attempt(() => db.destroy());
    }
    try {
      restoreDatabaseDriver(previousDriver);
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0)
      throw new AggregateError(errors, 'Failed to clean question delete proof');
  });

  it('binds the immutable route contract to this executable proof', () => {
    expect(questionDelete).toMatchObject({
      authorizedControl: { status: 204 },
      deniedBoundaries: ['tenant', 'organization', 'brand', 'event'],
      method: 'DELETE',
      permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
      persistenceSource: 'question-delete-route-authorization-db.integration.test.ts',
      resourceParameters: ['questionId'],
      source: 'question-delete-route-authorization-db.integration.test.ts',
    });
  });

  it('hard-deletes an authorized question with one revision and exact atomic audit', async () => {
    const before = await snapshot();
    const response = await deleteQuestion(questionHard);
    expect(response.statusCode, response.body).toBe(204);
    const after = await snapshot();
    expect(after.questions.find((question) => question.id === questionHard)).toBeUndefined();
    expect(Number(eventFrom(after, eventA).version)).toBe(
      Number(eventFrom(before, eventA).version) + 1,
    );
    expect(revisionMillis(eventFrom(after, eventA).public_revision)).toBeGreaterThan(
      revisionMillis(eventFrom(before, eventA).public_revision),
    );
    expect(after.audits).toEqual([
      expect.objectContaining({
        tenant_id: tenantA,
        organization_id: organizationA,
        brand_id: brandA,
        actor_type: 'user',
        actor_id: actorId,
        action: 'event.question.deleted',
        resource_type: 'Question',
        resource_id: questionHard,
      }),
    ]);
    expect(auditDiff(after.audits[0]!.diff_summary)).toEqual({ deletion: 'hard', eventId: eventA });
  });

  it('soft-deletes historical answers while retaining the question and audit atomically', async () => {
    await insertHistoricalCheckout();
    const before = await snapshot();
    const response = await deleteQuestion(questionHistorical);
    expect(response.statusCode, response.body).toBe(204);
    const after = await snapshot();
    const historicalQuestion = after.questions.find(
      (question) => question.id === questionHistorical,
    );
    expect(historicalQuestion?.status).toBe('hidden');
    expect(Boolean(historicalQuestion?.is_hidden)).toBe(true);
    expect(Number(eventFrom(after, eventA).version)).toBe(
      Number(eventFrom(before, eventA).version) + 1,
    );
    expect(after.audits[0]).toMatchObject({ resource_id: questionHistorical });
    expect(auditDiff(after.audits[0]!.diff_summary)).toEqual({ deletion: 'soft', eventId: eventA });
  });

  it('rejects active conditional dependents with no question, revision, or audit mutation', async () => {
    const before = await snapshot();
    const response = await deleteQuestion(questionDependentSource);
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'CONFLICT' } });
    await expect(snapshot()).resolves.toEqual(before);
  });

  it('denies missing permission before the checkpoint or database mutation', async () => {
    let checkpointCalled = false;
    checkpoint = async () => {
      checkpointCalled = true;
    };
    activePrincipal = { ...basePrincipal, scopes: [] };
    const before = await snapshot();
    const response = await deleteQuestion(questionHard);
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect(checkpointCalled).toBe(false);
    await expect(snapshot()).resolves.toEqual(before);
  });

  it.each([
    ['tenant', () => basePrincipal, questionForeign],
    [
      'organization',
      () => ({ ...basePrincipal, organizationIds: [organizationA] }),
      questionScoped,
    ],
    [
      'brand',
      () => ({
        ...basePrincipal,
        organizationIds: [organizationA, organizationAScoped],
        brandIds: [brandA],
      }),
      questionScoped,
    ],
    [
      'event',
      () => ({
        ...basePrincipal,
        organizationIds: [organizationA, organizationAScoped],
        brandIds: [brandA, brandAScoped],
        eventIds: [eventA],
      }),
      questionScoped,
    ],
  ] as const)(
    'conceals the %s boundary as the caller question identifier only',
    async (_boundary, makePrincipal, questionId) => {
      activePrincipal = makePrincipal();
      const before = await snapshot();
      const response = await deleteQuestion(questionId);
      expect(response.statusCode, response.body).toBe(404);
      expect(response.json()).toMatchObject({
        error: {
          code: 'NOT_FOUND',
          details: { id: questionId, resource: 'Question' },
          message: `Question not found: ${questionId}`,
        },
      });
      await expect(snapshot()).resolves.toEqual(before);
    },
  );

  it('revalidates the locked question event after a before-transaction reparent', async () => {
    checkpoint = async (input) => {
      if (input.stage !== 'before_transaction') return;
      await db
        .updateTable('questions')
        .set({ event_id: eventAScoped })
        .where('id', '=', questionHard)
        .execute();
    };
    const response = await deleteQuestion(questionHard);
    expect(response.statusCode, response.body).toBe(404);
    expect(response.json()).toMatchObject({
      error: {
        code: 'NOT_FOUND',
        details: { id: questionHard, resource: 'Question' },
        message: `Question not found: ${questionHard}`,
      },
    });
    expect(
      await db
        .selectFrom('questions')
        .select(['event_id'])
        .where('id', '=', questionHard)
        .executeTakeFirst(),
    ).toEqual({ event_id: eventAScoped });
    expect((await snapshot()).audits).toEqual([]);
  });

  it('holds the parent event lock until deletion commits so a competing child insert cannot land mid-transaction', async () => {
    let childCreateCompleted = false;
    let childCreate: Promise<{ body: string; json: () => unknown; statusCode: number }> | undefined;
    let childPatch: Promise<{ body: string; json: () => unknown; statusCode: number }> | undefined;
    checkpoint = async (input) => {
      if (input.stage !== 'before_audit') return;
      childCreate = app
        .inject({
          method: 'POST',
          url: `/events/${eventA}/questions`,
          payload: {
            type: 'text',
            label: questionRace,
            conditionalVisibility: {
              field: questionHard,
              operator: 'equals',
              value: 'race',
            },
          },
        })
        .then((response) => response);
      void childCreate.then(() => {
        childCreateCompleted = true;
      });
      childPatch = app
        .inject({
          method: 'PATCH',
          url: `/questions/${questionPatchRace}`,
          payload: {
            conditionalVisibility: {
              field: questionHard,
              operator: 'equals',
              value: 'race',
            },
          },
        })
        .then((response) => response);
      void childPatch.then(() => {
        childCreateCompleted = true;
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      expect(childCreateCompleted).toBe(false);
    };

    const response = await deleteQuestion(questionHard);
    expect(response.statusCode, response.body).toBe(204);
    if (!childCreate || !childPatch) throw new Error('competing question mutation was not started');
    const [competingResponse, patchResponse] = await Promise.all([childCreate, childPatch]);
    expect(childCreateCompleted).toBe(true);
    expect(competingResponse?.statusCode, competingResponse?.body).toBe(400);
    expect(competingResponse?.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    expect(patchResponse.statusCode, patchResponse.body).toBe(400);
    expect(patchResponse.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    expect(
      await db
        .selectFrom('questions')
        .select(['id'])
        .where('id', '=', questionRace)
        .executeTakeFirst(),
    ).toBeUndefined();
    expect(
      await db
        .selectFrom('questions')
        .select(['conditional_visibility'])
        .where('id', '=', questionPatchRace)
        .executeTakeFirst(),
    ).toEqual({ conditional_visibility: null });
  });

  it('rolls back the question and revision when the fail-closed audit write fails', async () => {
    const auditCreate = vi
      .spyOn(AuditLogRepository.prototype, 'create')
      .mockRejectedValueOnce(new Error('injected question delete audit failure'));
    const before = await snapshot();
    try {
      const failed = await deleteQuestion(questionHard);
      expect(failed.statusCode, failed.body).toBe(500);
      await expect(snapshot()).resolves.toEqual(before);

      const retried = await deleteQuestion(questionHard);
      expect(retried.statusCode, retried.body).toBe(204);
      const afterRetry = await snapshot();
      expect(afterRetry.questions.find((question) => question.id === questionHard)).toBeUndefined();
      expect(afterRetry.audits).toEqual([
        expect.objectContaining({
          tenant_id: tenantA,
          organization_id: organizationA,
          brand_id: brandA,
          actor_type: 'user',
          actor_id: actorId,
          action: 'event.question.deleted',
          resource_type: 'Question',
          resource_id: questionHard,
          diff_summary: expect.anything(),
        }),
      ]);
    } finally {
      auditCreate.mockRestore();
    }
  });
});
