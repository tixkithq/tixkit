import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { AuditLogRepository, createDb, EventRepository, type Database } from '@tixkit/db';
import type { Principal } from '@tixkit/domain';
import { ulid } from 'ulid';
import { registerErrorHandler, type AppContext } from '../../app.js';
import { questionRoutes } from '../../routes/modules/questions.js';
import {
  describeWithIntegrationDatabase,
  integrationDatabaseDriver,
  integrationDatabaseUrl,
  restoreDatabaseDriver,
  setIntegrationDatabaseDriver,
} from './integration-database.js';
import { EVENT_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS } from './route-authorization-contracts.js';

const contract = EVENT_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS.find(
  (candidate) => candidate.operationId === 'patchQuestionsByQuestionId',
)!;

type QuestionAuditDiff = {
  after: { consentVersion?: string; label?: string };
  before: { consentVersion?: string; label?: string };
  changedFields: string[];
  noOp: boolean;
  sensitiveChanges: { consentTextChanged?: boolean };
};

function parseAudit(value: unknown): QuestionAuditDiff {
  return (typeof value === 'string' ? JSON.parse(value) : value) as QuestionAuditDiff;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describeWithIntegrationDatabase('question update route authorization matrix', () => {
  let app: FastifyInstance;
  let db: Database;
  let previousDriver: string | undefined;
  let principal: Principal;
  let checkpoint: AppContext['questionUpdateCheckpoint'];
  const suffix = ulid().slice(-10).toLowerCase();
  const tenantId = `tnt_qu_${suffix}`;
  const foreignTenantId = `tnt_qu_f_${suffix}`;
  const organizationId = `org_qu_${suffix}`;
  const foreignOrganizationId = `org_qu_f_${suffix}`;
  const brandId = `brd_qu_${suffix}`;
  const foreignBrandId = `brd_qu_f_${suffix}`;
  const questionId = `q_qu_${suffix}`;
  const sourceQuestionId = `q_qu_source_${suffix}`;
  const foreignQuestionId = `q_qu_foreign_${suffix}`;
  const inventoryPoolId = `ip_qu_${suffix}`;
  const foreignInventoryPoolId = `ip_qu_f_${suffix}`;
  const ticketTypeId = `tt_qu_${suffix}`;
  const foreignTicketTypeId = `tt_qu_f_${suffix}`;
  const actorId = `usr_qu_${suffix}`;
  let eventId: string;
  let foreignEventId: string;
  const basePrincipal: Principal = {
    type: 'user',
    id: actorId,
    tenantId,
    organizationIds: [organizationId],
    scopes: ['events.write'],
  };

  async function insertQuestion(
    id: string,
    event: string,
    overrides: Record<string, unknown> = {},
  ) {
    const now = new Date('2026-07-22T12:00:00.000Z');
    await db
      .insertInto('questions')
      .values({
        id,
        event_id: event,
        ticket_type_id: null,
        type: 'text',
        label: id,
        description: null,
        required: false,
        applies_to: 'buyer',
        options: null,
        placeholder: null,
        validation_pattern: null,
        conditional_visibility: null,
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
        ...overrides,
      })
      .execute();
  }

  async function invoke(id: string, body: Record<string, unknown>) {
    return app.inject({ method: 'PATCH', url: `/questions/${id}`, payload: body });
  }

  async function insertTicketType(id: string, event: string, inventoryPoolId: string) {
    const now = new Date('2026-07-22T12:00:00.000Z');
    await db
      .insertInto('ticket_types')
      .values({
        id,
        event_id: event,
        name: id,
        description: null,
        kind: 'standard',
        status: 'active',
        visibility: 'public',
        currency: 'USD',
        price_cents: 0,
        minimum_price_cents: null,
        sales_start_at: null,
        sales_end_at: null,
        min_per_order: 1,
        max_per_order: 10,
        inventory_pool_id: inventoryPoolId,
        sort_order: 0,
        requires_access_code: false,
        access_code_hint: null,
        event_occurrence_id: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
  }

  beforeAll(async () => {
    previousDriver = setIntegrationDatabaseDriver();
    db = createDb(integrationDatabaseUrl());
    const now = new Date('2026-07-22T12:00:00.000Z');
    await db
      .insertInto('tenants')
      .values([
        {
          id: tenantId,
          name: tenantId,
          status: 'active',
          plan: 'test',
          created_at: now,
          updated_at: now,
        },
        {
          id: foreignTenantId,
          name: foreignTenantId,
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
          name: organizationId,
          slug: `qu-${suffix}`,
          clerk_organization_id: null,
          box_office_settings: '{}',
          status: 'active',
          created_at: now,
          updated_at: now,
        },
        {
          id: foreignOrganizationId,
          tenant_id: foreignTenantId,
          name: foreignOrganizationId,
          slug: `qu-f-${suffix}`,
          clerk_organization_id: null,
          box_office_settings: '{}',
          status: 'active',
          created_at: now,
          updated_at: now,
        },
      ])
      .execute();
    await db
      .insertInto('brands')
      .values([
        {
          id: brandId,
          tenant_id: tenantId,
          organization_id: organizationId,
          name: brandId,
          slug: `qu-${suffix}`,
          status: 'active',
          theme: '{}',
          legal_urls: '{}',
          white_label: false,
          created_at: now,
          updated_at: now,
        },
        {
          id: foreignBrandId,
          tenant_id: foreignTenantId,
          organization_id: foreignOrganizationId,
          name: foreignBrandId,
          slug: `qu-f-${suffix}`,
          status: 'active',
          theme: '{}',
          legal_urls: '{}',
          white_label: false,
          created_at: now,
          updated_at: now,
        },
      ])
      .execute();
    eventId = (
      await new EventRepository(db).create({
        tenantId,
        organizationId,
        brandId,
        slug: `question-update-${suffix}`,
        title: 'Question update',
        currency: 'USD',
        timezone: 'UTC',
        startsAt: new Date('2027-01-01T18:00:00.000Z'),
        endsAt: new Date('2027-01-01T20:00:00.000Z'),
        venue: { name: 'Question venue' },
      })
    ).id;
    foreignEventId = (
      await new EventRepository(db).create({
        tenantId: foreignTenantId,
        organizationId: foreignOrganizationId,
        brandId: foreignBrandId,
        slug: `question-update-f-${suffix}`,
        title: 'Foreign question update',
        currency: 'USD',
        timezone: 'UTC',
        startsAt: new Date('2027-01-01T18:00:00.000Z'),
        endsAt: new Date('2027-01-01T20:00:00.000Z'),
        venue: { name: 'Foreign question venue' },
      })
    ).id;
    await db
      .insertInto('inventory_pools')
      .values([
        {
          id: inventoryPoolId,
          event_id: eventId,
          name: inventoryPoolId,
          total_capacity: 100,
          hold_ttl_seconds: 600,
          created_at: now,
          updated_at: now,
        },
        {
          id: foreignInventoryPoolId,
          event_id: foreignEventId,
          name: foreignInventoryPoolId,
          total_capacity: 100,
          hold_ttl_seconds: 600,
          created_at: now,
          updated_at: now,
        },
      ])
      .execute();
    app = Fastify({ logger: false, genReqId: () => `req_qu_${suffix}` });
    app.decorate('context', {
      db,
      questionUpdateCheckpoint: (
        input: Parameters<NonNullable<AppContext['questionUpdateCheckpoint']>>[0],
      ) => checkpoint?.(input),
    } as AppContext);
    app.addHook('onRequest', async (request) => {
      request.principal = principal;
    });
    registerErrorHandler(app);
    await app.register(questionRoutes);
    await app.ready();
  });

  beforeEach(async () => {
    principal = {
      ...basePrincipal,
      organizationIds: [...basePrincipal.organizationIds],
      scopes: [...basePrincipal.scopes],
    };
    checkpoint = undefined;
    vi.restoreAllMocks();
    await db.deleteFrom('audit_logs').where('tenant_id', '=', tenantId).execute();
    await db
      .deleteFrom('questions')
      .where('id', 'in', [questionId, sourceQuestionId, foreignQuestionId])
      .execute();
    await db
      .deleteFrom('ticket_types')
      .where('id', 'in', [ticketTypeId, foreignTicketTypeId])
      .execute();
    await insertQuestion(questionId, eventId);
    await insertQuestion(sourceQuestionId, eventId);
    await insertQuestion(foreignQuestionId, foreignEventId);
    await insertTicketType(ticketTypeId, eventId, inventoryPoolId);
    await insertTicketType(foreignTicketTypeId, foreignEventId, foreignInventoryPoolId);
  });

  afterAll(async () => {
    try {
      await app?.close();
      await db
        ?.deleteFrom('audit_logs')
        .where('tenant_id', 'in', [tenantId, foreignTenantId])
        .execute();
      await db
        ?.deleteFrom('questions')
        .where('id', 'in', [questionId, sourceQuestionId, foreignQuestionId])
        .execute();
      await db
        ?.deleteFrom('ticket_types')
        .where('id', 'in', [ticketTypeId, foreignTicketTypeId])
        .execute();
      await db
        ?.deleteFrom('inventory_pools')
        .where('id', 'in', [inventoryPoolId, foreignInventoryPoolId])
        .execute();
      await db?.deleteFrom('events').where('id', 'in', [eventId, foreignEventId]).execute();
      await db?.deleteFrom('brands').where('id', 'in', [brandId, foreignBrandId]).execute();
      await db
        ?.deleteFrom('organizations')
        .where('id', 'in', [organizationId, foreignOrganizationId])
        .execute();
      await db?.deleteFrom('tenants').where('id', 'in', [tenantId, foreignTenantId]).execute();
    } finally {
      await db?.destroy();
      restoreDatabaseDriver(previousDriver);
    }
  });

  it('binds the executable tenant/event update contract', () => {
    expect(contract).toMatchObject({
      method: 'PATCH',
      path: '/questions/{questionId}',
      authorizedControl: { required: true, status: 200 },
      deniedBoundaries: ['tenant', 'organization', 'brand', 'event'],
      permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
    });
  });

  it('updates a question with a truthful sanitized atomic audit and revision', async () => {
    const publicRevision = new Date('2030-01-01T00:00:00.000Z');
    await db
      .updateTable('events')
      .set({ public_revision: publicRevision })
      .where('id', '=', eventId)
      .execute();
    const beforeRevision = await db
      .selectFrom('events')
      .select(['version', 'public_revision'])
      .where('id', '=', eventId)
      .executeTakeFirstOrThrow();
    const response = await invoke(questionId, {
      label: 'Updated question',
      required: true,
      placeholder: `sentinel-${suffix}`,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      id: questionId,
      label: 'Updated question',
      required: true,
    });
    const audit = await db
      .selectFrom('audit_logs')
      .select(['action', 'resource_id', 'diff_summary'])
      .where('tenant_id', '=', tenantId)
      .executeTakeFirstOrThrow();
    expect(audit).toMatchObject({ action: 'question.updated', resource_id: questionId });
    expect(parseAudit(audit.diff_summary)).toMatchObject({ noOp: false });
    expect(
      await db
        .selectFrom('questions')
        .select('placeholder')
        .where('id', '=', questionId)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ placeholder: `sentinel-${suffix}` });
    expect(JSON.stringify(audit.diff_summary)).not.toContain(`sentinel-${suffix}`);
    const afterRevision = await db
      .selectFrom('events')
      .select(['version', 'public_revision'])
      .where('id', '=', eventId)
      .executeTakeFirstOrThrow();
    expect(Number(afterRevision.version)).toBe(Number(beforeRevision.version) + 1);
    if (!beforeRevision.public_revision || !afterRevision.public_revision) {
      throw new Error('Expected material question update to retain an event public revision');
    }
    expect(afterRevision.public_revision.getTime()).toBe(
      beforeRevision.public_revision.getTime() +
        (integrationDatabaseDriver() === 'mysql' ? 1_000 : 1),
    );
  });

  it('checks permission before parsing and conceals foreign questions byte-for-byte', async () => {
    principal = { ...basePrincipal, scopes: [] };
    expect((await invoke(questionId, { unexpected: true })).statusCode).toBe(403);
    principal = basePrincipal;
    expect((await invoke(questionId, { unexpected: true })).statusCode).toBe(400);
    const missing = await invoke(`q_missing_${suffix}`, { label: 'x' });
    const foreign = await invoke(foreignQuestionId, { label: 'x' });
    principal = { ...basePrincipal, organizationIds: [] };
    const wrongOrganization = await invoke(questionId, { label: 'x' });
    principal = { ...basePrincipal, brandIds: ['brd_wrong_scope'] };
    const wrongBrand = await invoke(questionId, { label: 'x' });
    principal = { ...basePrincipal, eventIds: ['evt_wrong_scope'] };
    const wrongEvent = await invoke(questionId, { label: 'x' });
    expect(missing.statusCode).toBe(404);
    expect(foreign.statusCode).toBe(404);
    for (const response of [foreign, wrongOrganization, wrongBrand, wrongEvent]) {
      expect(response.statusCode).toBe(404);
      expect(response.body).toBe(missing.body);
    }
  });

  it.each([
    ['permission', (current: Principal) => (current.scopes = []), 403],
    ['organization', (current: Principal) => (current.organizationIds = []), 404],
    ['brand', (current: Principal) => (current.brandIds = ['brd_other']), 404],
    ['event', (current: Principal) => (current.eventIds = ['evt_other']), 404],
    ['tenant', (current: Principal) => (current.tenantId = foreignTenantId), 404],
  ])('revalidates post-lock %s scope changes', async (name, mutate, expectedStatus) => {
    checkpoint = (input) => {
      if (input.stage === 'after_question_lock') mutate(principal);
    };
    const response = await invoke(questionId, { label: `post-lock-${name}` });
    expect(response.statusCode).toBe(expectedStatus);
    expect(
      await db
        .selectFrom('questions')
        .select('label')
        .where('id', '=', questionId)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ label: questionId });
  });

  it('does not contend on a held foreign conditional-source lock before failing provenance', async () => {
    await db.transaction().execute(async (trx) => {
      await trx
        .selectFrom('questions')
        .select('id')
        .where('id', '=', foreignQuestionId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const response = await Promise.race([
        invoke(questionId, {
          conditionalVisibility: { field: foreignQuestionId, operator: 'equals', value: 'x' },
        }),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('FOREIGN_DEPENDENCY_PRECHECK_BLOCKED')), 1_000);
        }),
      ]);
      expect(response.statusCode).toBe(400);
    });
  });

  it('does not contend on a held foreign ticket-type lock before rejecting provenance', async () => {
    await db.transaction().execute(async (trx) => {
      await trx
        .selectFrom('ticket_types')
        .select('id')
        .where('id', '=', foreignTicketTypeId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const response = await Promise.race([
        invoke(questionId, { ticketTypeId: foreignTicketTypeId }),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('FOREIGN_TICKET_TYPE_PRECHECK_BLOCKED')), 1_000);
        }),
      ]);
      expect(response.statusCode).toBe(404);
      expect(
        await db
          .selectFrom('questions')
          .select('ticket_type_id')
          .where('id', '=', questionId)
          .executeTakeFirstOrThrow(),
      ).toMatchObject({ ticket_type_id: null });
      expect(
        await db.selectFrom('audit_logs').select('id').where('tenant_id', '=', tenantId).execute(),
      ).toHaveLength(0);
    });
  });

  it('does not seek a once-local ticket type by foreign primary key after reparenting', async () => {
    const eventLocked = deferred();
    const release = deferred();
    checkpoint = async (input) => {
      if (input.stage !== 'after_event_lock') return;
      eventLocked.resolve();
      await release.promise;
    };
    const responsePromise = invoke(questionId, { ticketTypeId });
    await eventLocked.promise;
    await db
      .updateTable('ticket_types')
      .set({ event_id: foreignEventId, inventory_pool_id: foreignInventoryPoolId })
      .where('id', '=', ticketTypeId)
      .execute();
    await db.transaction().execute(async (trx) => {
      await trx
        .selectFrom('ticket_types')
        .select('id')
        .where('id', '=', ticketTypeId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      release.resolve();
      const response = await Promise.race([
        responsePromise,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('REPARENTED_FOREIGN_TICKET_TYPE_BLOCKED')), 1_000);
        }),
      ]);
      expect(response.statusCode).toBe(404);
    });
    expect(
      await db
        .selectFrom('questions')
        .select('ticket_type_id')
        .where('id', '=', questionId)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ ticket_type_id: null });
    expect(
      await db.selectFrom('audit_logs').select('id').where('tenant_id', '=', tenantId).execute(),
    ).toHaveLength(0);
  });

  it('fails closed when a preflighted ticket type is deleted after event lock', async () => {
    let deleted = false;
    checkpoint = async (input) => {
      if (input.stage === 'after_event_lock' && !deleted) {
        deleted = true;
        await db.deleteFrom('ticket_types').where('id', '=', ticketTypeId).execute();
      }
    };
    expect((await invoke(questionId, { ticketTypeId })).statusCode).toBe(404);
    expect(
      await db
        .selectFrom('questions')
        .select('ticket_type_id')
        .where('id', '=', questionId)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ ticket_type_id: null });
    expect(
      await db.selectFrom('audit_logs').select('id').where('tenant_id', '=', tenantId).execute(),
    ).toHaveLength(0);
  });

  it('does not seek a once-local dependency by foreign primary key after reparenting', async () => {
    const eventLocked = deferred();
    const release = deferred();
    checkpoint = async (input) => {
      if (input.stage !== 'after_event_lock') return;
      eventLocked.resolve();
      await release.promise;
    };
    const responsePromise = invoke(questionId, {
      conditionalVisibility: { field: sourceQuestionId, operator: 'equals', value: 'x' },
    });
    await eventLocked.promise;
    await db
      .updateTable('questions')
      .set({ event_id: foreignEventId })
      .where('id', '=', sourceQuestionId)
      .execute();
    await db.transaction().execute(async (trx) => {
      await trx
        .selectFrom('questions')
        .select('id')
        .where('id', '=', sourceQuestionId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      release.resolve();
      const response = await Promise.race([
        responsePromise,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('REPARENTED_FOREIGN_DEPENDENCY_BLOCKED')), 1_000);
        }),
      ]);
      expect(response.statusCode).toBe(400);
    });
  });

  it('does not seek a once-local main question by foreign primary key after reparenting', async () => {
    const eventLocked = deferred();
    const release = deferred();
    checkpoint = async (input) => {
      if (input.stage !== 'after_event_lock') return;
      eventLocked.resolve();
      await release.promise;
    };
    const responsePromise = invoke(questionId, { label: 'reparented-main' });
    await eventLocked.promise;
    await db
      .updateTable('questions')
      .set({ event_id: foreignEventId })
      .where('id', '=', questionId)
      .execute();
    await db.transaction().execute(async (trx) => {
      await trx
        .selectFrom('questions')
        .select('id')
        .where('id', '=', questionId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      release.resolve();
      const response = await Promise.race([
        responsePromise,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('REPARENTED_FOREIGN_MAIN_BLOCKED')), 1_000);
        }),
      ]);
      expect(response.statusCode).toBe(404);
    });
  });

  it.each([
    [
      'hidden',
      async () =>
        db
          .updateTable('questions')
          .set({ is_hidden: true })
          .where('id', '=', sourceQuestionId)
          .execute(),
      400,
    ],
    [
      'deleted',
      async () => db.deleteFrom('questions').where('id', '=', sourceQuestionId).execute(),
      400,
    ],
  ])('fails closed when a dependency is %s after event lock', async (_name, mutate, status) => {
    let mutated = false;
    checkpoint = async (input) => {
      if (input.stage === 'after_event_lock' && !mutated) {
        mutated = true;
        await mutate();
      }
    };
    const response = await invoke(questionId, {
      conditionalVisibility: { field: sourceQuestionId, operator: 'equals', value: 'x' },
    });
    expect(response.statusCode, response.body).toBe(status);
    expect(
      await db
        .selectFrom('questions')
        .select('conditional_visibility')
        .where('id', '=', questionId)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ conditional_visibility: null });
  });

  it('fails closed when the main question disappears after preflight', async () => {
    checkpoint = async (input) => {
      if (input.stage === 'after_event_lock') {
        await db.deleteFrom('questions').where('id', '=', questionId).execute();
      }
    };
    expect((await invoke(questionId, { label: 'deleted-main' })).statusCode).toBe(404);
  });

  it('serializes concurrent disjoint patches so both locked-current changes persist', async () => {
    const arrived = deferred();
    let arrivals = 0;
    checkpoint = async (input) => {
      if (input.stage !== 'before_event_lock') return;
      arrivals += 1;
      if (arrivals === 2) arrived.resolve();
      await arrived.promise;
    };
    const [label, placeholder] = await Promise.all([
      invoke(questionId, { label: 'Concurrent label' }),
      invoke(questionId, { placeholder: 'Concurrent placeholder' }),
    ]);
    expect([label.statusCode, placeholder.statusCode]).toEqual([200, 200]);
    expect(arrivals).toBeGreaterThanOrEqual(2);
    expect(
      await db
        .selectFrom('questions')
        .select(['label', 'placeholder'])
        .where('id', '=', questionId)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ label: 'Concurrent label', placeholder: 'Concurrent placeholder' });
    expect(
      await db
        .selectFrom('audit_logs')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .where('action', '=', 'question.updated')
        .execute(),
    ).toHaveLength(2);
  });

  it('serializes same-field writes into contiguous truthful audit transitions', async () => {
    const arrived = deferred();
    let arrivals = 0;
    checkpoint = async (input) => {
      if (input.stage !== 'before_event_lock') return;
      arrivals += 1;
      if (arrivals === 2) arrived.resolve();
      await arrived.promise;
    };
    const [first, second] = await Promise.all([
      invoke(questionId, { label: 'Same field first' }),
      invoke(questionId, { label: 'Same field second' }),
    ]);
    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
    const audits = await db
      .selectFrom('audit_logs')
      .select(['id', 'diff_summary'])
      .where('tenant_id', '=', tenantId)
      .where('action', '=', 'question.updated')
      .execute();
    expect(audits).toHaveLength(2);
    const diffs = audits.map((audit) => parseAudit(audit.diff_summary));
    const earlier = diffs.find((diff) => diff.before.label === questionId)!;
    const later = diffs.find((diff) => diff.before.label === earlier.after.label)!;
    expect(later.before.label).toBe(earlier.after.label);
    expect(['Same field first', 'Same field second']).toContain(earlier.after.label);
    expect(['Same field first', 'Same field second']).toContain(later.after.label);
    expect(
      await db
        .selectFrom('questions')
        .select('label')
        .where('id', '=', questionId)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ label: later.after.label });
  });

  it('recomputes concurrent consent changes from the locked current version', async () => {
    await db
      .updateTable('questions')
      .set({
        type: 'checkbox',
        is_consent_field: true,
        consent_text: 'Base consent',
        consent_version: '1',
      })
      .where('id', '=', questionId)
      .execute();
    const arrived = deferred();
    let arrivals = 0;
    checkpoint = async (input) => {
      if (input.stage !== 'before_event_lock') return;
      arrivals += 1;
      if (arrivals === 2) arrived.resolve();
      await arrived.promise;
    };
    const [v2, v3] = await Promise.all([
      invoke(questionId, { consentText: 'Consent v2', consentVersion: '2' }),
      invoke(questionId, { consentText: 'Consent v3', consentVersion: '3' }),
    ]);
    expect([v2.statusCode, v3.statusCode]).toEqual([200, 200]);
    const diffs = (
      await db
        .selectFrom('audit_logs')
        .select('diff_summary')
        .where('tenant_id', '=', tenantId)
        .where('action', '=', 'question.updated')
        .execute()
    ).map((audit) => parseAudit(audit.diff_summary));
    expect(diffs).toHaveLength(2);
    const first = diffs.find((diff) => diff.before.consentVersion === '1')!;
    const second = diffs.find((diff) => diff.before.consentVersion === first.after.consentVersion)!;
    expect([first.after.consentVersion, second.after.consentVersion].sort()).toEqual(['2', '3']);
    expect(second.before.consentVersion).toBe(first.after.consentVersion);
    const current = await db
      .selectFrom('questions')
      .select(['consent_text', 'consent_version'])
      .where('id', '=', questionId)
      .executeTakeFirstOrThrow();
    expect(current.consent_version).toBe(second.after.consentVersion);
    expect(current.consent_text).toBe(`Consent v${second.after.consentVersion}`);
    expect(diffs.every((diff) => diff.sensitiveChanges.consentTextChanged === true)).toBe(true);
    expect(diffs.map((diff) => diff.changedFields)).toEqual(
      expect.arrayContaining([
        expect.arrayContaining(['consentText', 'consentVersion']),
        expect.arrayContaining(['consentText', 'consentVersion']),
      ]),
    );
  });

  it('validates locked conditional and consent state, including no-op behavior', async () => {
    await db
      .updateTable('questions')
      .set({ is_hidden: true })
      .where('id', '=', sourceQuestionId)
      .execute();
    expect(
      (
        await invoke(questionId, {
          conditionalVisibility: { field: sourceQuestionId, operator: 'equals', value: 'yes' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await invoke(questionId, {
          type: 'waiver',
          isConsentField: true,
          consentText: 'Agree',
          consentVersion: '1',
        })
      ).statusCode,
    ).toBe(200);
    expect((await invoke(questionId, { consentText: 'Changed' })).statusCode).toBe(400);
    expect((await invoke(questionId, {})).statusCode).toBe(400);
    const noOp = await invoke(questionId, { label: questionId });
    expect(noOp.statusCode).toBe(200);
    expect(
      parseAudit(
        (
          await db
            .selectFrom('audit_logs')
            .select('diff_summary')
            .where('tenant_id', '=', tenantId)
            .orderBy('id', 'desc')
            .executeTakeFirstOrThrow()
        ).diff_summary,
      ),
    ).toMatchObject({ noOp: true });
  });

  it('rejects explicit options when changing to a non-option type without mutation', async () => {
    await db
      .updateTable('questions')
      .set({ type: 'select', options: JSON.stringify(['Standard']) })
      .where('id', '=', questionId)
      .execute();
    const beforeQuestion = await db
      .selectFrom('questions')
      .select(['type', 'options'])
      .where('id', '=', questionId)
      .executeTakeFirstOrThrow();
    const beforeRevision = await db
      .selectFrom('events')
      .select('public_revision')
      .where('id', '=', eventId)
      .executeTakeFirstOrThrow();
    expect((await invoke(questionId, { type: 'text', options: ['VIP'] })).statusCode).toBe(400);
    expect(
      await db
        .selectFrom('questions')
        .select(['type', 'options'])
        .where('id', '=', questionId)
        .executeTakeFirstOrThrow(),
    ).toEqual(beforeQuestion);
    expect(
      await db
        .selectFrom('events')
        .select('public_revision')
        .where('id', '=', eventId)
        .executeTakeFirstOrThrow(),
    ).toEqual(beforeRevision);
    expect(
      await db.selectFrom('audit_logs').select('id').where('tenant_id', '=', tenantId).execute(),
    ).toHaveLength(0);
  });

  it('retries exactly retryable conflicts and rolls creation back when audit fails', async () => {
    let attempts = 0;
    checkpoint = (input) => {
      if (input.stage === 'before_event_lock') {
        attempts += 1;
        if (attempts < 2) throw Object.assign(new Error('retry'), { code: '40001' });
      }
    };
    expect((await invoke(questionId, { label: 'Retried' })).statusCode).toBe(200);
    expect(attempts).toBe(2);
    attempts = 0;
    checkpoint = (input) => {
      if (input.stage === 'before_event_lock') {
        attempts += 1;
        throw Object.assign(new Error('nonretry'), { code: 'XX000' });
      }
    };
    expect((await invoke(questionId, { label: 'Nonretry' })).statusCode).toBe(500);
    expect(attempts).toBe(1);
    attempts = 0;
    checkpoint = (input) => {
      if (input.stage === 'before_event_lock') {
        attempts += 1;
        throw Object.assign(new Error('exhausted'), { code: '40001' });
      }
    };
    expect((await invoke(questionId, { label: 'Exhausted' })).statusCode).toBe(500);
    expect(attempts).toBe(3);
    checkpoint = undefined;
    const beforeQuestion = await db
      .selectFrom('questions')
      .select(['label', 'placeholder', 'updated_at'])
      .where('id', '=', questionId)
      .executeTakeFirstOrThrow();
    const beforeEvent = await db
      .selectFrom('events')
      .select('public_revision')
      .where('id', '=', eventId)
      .executeTakeFirstOrThrow();
    vi.spyOn(AuditLogRepository.prototype, 'create').mockRejectedValueOnce(
      new Error('audit unavailable'),
    );
    expect(
      (await invoke(questionId, { label: 'Rollback', placeholder: 'rollback-sentinel' }))
        .statusCode,
    ).toBe(500);
    expect(
      await db
        .selectFrom('questions')
        .select(['label', 'placeholder', 'updated_at'])
        .where('id', '=', questionId)
        .executeTakeFirstOrThrow(),
    ).toEqual(beforeQuestion);
    expect(
      await db
        .selectFrom('events')
        .select('public_revision')
        .where('id', '=', eventId)
        .executeTakeFirstOrThrow(),
    ).toEqual(beforeEvent);
    expect(
      await db
        .selectFrom('audit_logs')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .where('action', '=', 'question.updated')
        .execute(),
    ).toHaveLength(1);
  });

  it('fails closed when a structurally deletable event disappears after question preflight', async () => {
    checkpoint = async (input) => {
      if (input.stage !== 'before_event_lock') return;
      await db.deleteFrom('questions').where('id', 'in', [questionId, sourceQuestionId]).execute();
      await db.deleteFrom('ticket_types').where('id', '=', ticketTypeId).execute();
      await db.deleteFrom('inventory_pools').where('id', '=', inventoryPoolId).execute();
      await db.deleteFrom('events').where('id', '=', eventId).execute();
    };
    expect((await invoke(questionId, { label: 'deleted-event' })).statusCode).toBe(404);
  });
});
