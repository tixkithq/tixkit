import Fastify, { type FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { AuditLogRepository, createDb, type Database } from '@tixkit/db';
import type { Principal } from '@tixkit/domain';
import { ulid } from 'ulid';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { registerErrorHandler, type AppContext } from '../../app.js';
import { privacyRoutes } from '../../routes/modules/privacy.js';
import { hashRequest } from '../../services/idempotency.js';
import {
  describeWithIntegrationDatabase,
  integrationDatabaseDriver,
  integrationDatabaseUrl,
  restoreDatabaseDriver,
  setIntegrationDatabaseDriver,
} from './integration-database.js';

type PrivacyRequestCheckpoint = Readonly<{
  stage: 'before_transaction' | 'after_transaction_before_workflow';
  requestId: string;
  requestType: 'export' | 'erasure';
}>;

const runId = ulid().slice(-10).toLowerCase();
const tenantA = `tnt_privacy_a_${runId}`;
const tenantB = `tnt_privacy_b_${runId}`;
const organizationA = `org_privacy_a_${runId}`;
const organizationScoped = `org_privacy_scope_${runId}`;
const organizationSwap = `org_privacy_swap_${runId}`;
const organizationB = `org_privacy_b_${runId}`;
const brandA = `brd_privacy_a_${runId}`;
const brandScoped = `brd_privacy_scope_${runId}`;
const brandSwap = `brd_privacy_swap_${runId}`;
const actorId = `usr_privacy_${runId}`;
const alternateActorId = `usr_privacy_alt_${runId}`;
const keyPrefix = `privacy-erasure-${runId}`;
const privateEmail = `privacy-private-${runId}@example.test`;
const privateSubjectId = `buyer-private-${runId}`;

let app: FastifyInstance;
let db: Database;
let previousDriver: string | undefined;
let activePrincipal: Principal;
let basePrincipal: Principal;
let checkpointImplementation: (
  input: PrivacyRequestCheckpoint,
) => void | Promise<void> = async () => undefined;
let startImplementation: (input: { requestId: string }) => void | Promise<void> = async () =>
  undefined;

const privacyRequestWriteCheckpoint = vi.fn((input: PrivacyRequestCheckpoint) =>
  checkpointImplementation(input),
);
const startPrivacyRequest = vi.fn((input: { requestId: string }) => startImplementation(input));

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    type: 'user',
    id: actorId,
    tenantId: tenantA,
    organizationIds: [organizationA],
    scopes: ['settings.write'],
    ...overrides,
  };
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

function erasurePayload(
  overrides: Partial<{
    organizationId: string;
    brandId: string;
    subjectType: 'buyer' | 'attendee';
    subjectId: string;
    subjectEmail: string;
  }> = {},
): Record<string, string> {
  return {
    organizationId: organizationA,
    brandId: brandA,
    subjectType: 'buyer',
    subjectId: privateSubjectId,
    subjectEmail: privateEmail,
    ...overrides,
  };
}

async function invokeErasure(key: string, payload: Record<string, string> = erasurePayload()) {
  return app.inject({
    method: 'POST',
    url: '/privacy/erasures',
    headers: { 'idempotency-key': key },
    payload,
  });
}

async function invokeExport(key: string, payload: Record<string, string> = erasurePayload()) {
  return app.inject({
    method: 'POST',
    url: '/privacy/data-exports',
    headers: { 'idempotency-key': key },
    payload,
  });
}

function legacyPrivacyRequestId(key: string, payload: Record<string, string>): string {
  const requestHash = hashRequest({ requestType: 'erasure', ...payload });
  const digest = createHash('sha256')
    .update(tenantA)
    .update('\0')
    .update(key)
    .update('\0')
    .update(requestHash)
    .digest('hex')
    .slice(0, 26);
  return `prv_${digest}`;
}

async function seedLegacyPrivacyRequest(
  key: string,
  status: 'pending' | 'completed',
): Promise<{ id: string; requestHash: string }> {
  const payload = erasurePayload();
  const requestHash = hashRequest({ requestType: 'erasure', ...payload });
  const id = legacyPrivacyRequestId(key, payload);
  await db
    .insertInto('privacy_requests')
    .values({
      id,
      tenant_id: tenantA,
      organization_id: organizationA,
      brand_id: brandA,
      request_type: 'erasure',
      subject_type: 'buyer',
      subject_id: privateSubjectId,
      subject_email: privateEmail,
      status,
      requested_by: actorId,
      result: status === 'completed' ? '{}' : null,
      error: null,
      created_at: new Date(),
      completed_at: status === 'completed' ? new Date() : null,
    })
    .execute();
  return { id, requestHash };
}

async function privacyRows() {
  return db
    .selectFrom('privacy_requests')
    .selectAll()
    .where('requested_by', 'in', [actorId, alternateActorId])
    .orderBy('id', 'asc')
    .execute();
}

async function auditRows(requestType: 'erasure' | 'export' = 'erasure') {
  return db
    .selectFrom('audit_logs')
    .selectAll()
    .where('action', '=', `privacy.${requestType}.requested`)
    .where('actor_id', 'in', [actorId, alternateActorId])
    .orderBy('id', 'asc')
    .execute();
}

async function idempotencyRows() {
  return db
    .selectFrom('idempotency_records')
    .selectAll()
    .where('tenant_id', '=', tenantA)
    .where('key', 'like', `${keyPrefix}%`)
    .orderBy('id', 'asc')
    .execute();
}

async function expectNoEffects(): Promise<void> {
  expect(await privacyRows()).toEqual([]);
  expect(await auditRows('erasure')).toEqual([]);
  expect(await auditRows('export')).toEqual([]);
  expect(await idempotencyRows()).toEqual([]);
  expect(startPrivacyRequest).not.toHaveBeenCalled();
}

function databaseJson(value: unknown): Record<string, unknown> {
  return (typeof value === 'string' ? JSON.parse(value) : value) as Record<string, unknown>;
}

async function clearWrites(): Promise<void> {
  await db
    .deleteFrom('audit_logs')
    .where('action', 'in', ['privacy.erasure.requested', 'privacy.export.requested'])
    .where('actor_id', 'in', [actorId, alternateActorId])
    .execute();
  await db
    .deleteFrom('privacy_requests')
    .where('requested_by', 'in', [actorId, alternateActorId])
    .execute();
  await db
    .deleteFrom('idempotency_records')
    .where('tenant_id', '=', tenantA)
    .where('key', 'like', `${keyPrefix}%`)
    .execute();
}

async function cleanupFixture(): Promise<void> {
  await clearWrites();
  await db.deleteFrom('brands').where('id', 'in', [brandA, brandScoped, brandSwap]).execute();
  await db
    .deleteFrom('organizations')
    .where('id', 'in', [organizationA, organizationScoped, organizationSwap, organizationB])
    .execute();
  await db.deleteFrom('tenants').where('id', 'in', [tenantA, tenantB]).execute();
}

describeWithIntegrationDatabase(
  `privacy erasure route authorization and atomicity (${integrationDatabaseDriver()})`,
  () => {
    beforeAll(async () => {
      previousDriver = setIntegrationDatabaseDriver();
      db = createDb(integrationDatabaseUrl());
      await insertTenant(tenantA, 'Privacy authorization tenant A');
      await insertTenant(tenantB, 'Privacy authorization tenant B');
      await insertOrganization(organizationA, tenantA, 'Privacy authorization org A');
      await insertOrganization(organizationScoped, tenantA, 'Privacy authorization scoped org');
      await insertOrganization(organizationSwap, tenantA, 'Privacy authorization swap org');
      await insertOrganization(organizationB, tenantB, 'Privacy authorization org B');
      await insertBrand(brandA, tenantA, organizationA, 'Privacy authorization brand A');
      await insertBrand(brandScoped, tenantA, organizationA, 'Privacy authorization scoped brand');
      await insertBrand(brandSwap, tenantA, organizationA, 'Privacy authorization swap brand');

      basePrincipal = principal({ brandIds: [brandA, brandSwap] });
      activePrincipal = basePrincipal;
      app = Fastify({ logger: false });
      app.decorate('context', {
        db,
        temporalClient: { startPrivacyRequest },
        privacyRequestWriteCheckpoint,
      } as unknown as AppContext);
      app.addHook('onRequest', async (request) => {
        request.principal = activePrincipal;
      });
      registerErrorHandler(app);
      await app.register(privacyRoutes);
      await app.ready();
    }, 120_000);

    beforeEach(async () => {
      activePrincipal = basePrincipal;
      checkpointImplementation = async () => undefined;
      startImplementation = async () => undefined;
      privacyRequestWriteCheckpoint.mockClear();
      startPrivacyRequest.mockClear();
      vi.restoreAllMocks();
      await clearWrites();
      await db
        .updateTable('organizations')
        .set({ tenant_id: tenantA })
        .where('id', '=', organizationSwap)
        .execute();
      await db
        .updateTable('brands')
        .set({ organization_id: organizationA, tenant_id: tenantA })
        .where('id', '=', brandSwap)
        .execute();
    });

    afterAll(async () => {
      const errors: unknown[] = [];
      try {
        if (app) await app.close();
      } catch (error) {
        errors.push(error);
      }
      try {
        if (db) {
          await cleanupFixture();
          await db.destroy();
        }
      } catch (error) {
        errors.push(error);
      }
      try {
        restoreDatabaseDriver(previousDriver);
      } catch (error) {
        errors.push(error);
      }
      if (errors.length > 0) throw new AggregateError(errors, 'privacy proof cleanup failed');
    }, 120_000);

    it('queues one scoped erasure with one hash-only audit and stable workflow identity', async () => {
      const key = `${keyPrefix}-authorized`;
      const response = await invokeErasure(key);

      expect(response.statusCode).toBe(202);
      const body = response.json<Record<string, unknown>>();
      expect(body).toMatchObject({
        tenantId: tenantA,
        organizationId: organizationA,
        brandId: brandA,
        requestType: 'erasure',
        subjectType: 'buyer',
        subjectId: null,
        subjectEmail: null,
        status: 'pending',
        requestedBy: actorId,
      });

      const requests = await privacyRows();
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        id: body.id,
        tenant_id: tenantA,
        organization_id: organizationA,
        brand_id: brandA,
        request_type: 'erasure',
        subject_type: 'buyer',
        subject_id: privateSubjectId,
        subject_email: privateEmail,
        status: 'pending',
        requested_by: actorId,
      });

      const audits = await auditRows();
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        tenant_id: tenantA,
        organization_id: organizationA,
        brand_id: brandA,
        actor_id: actorId,
        action: 'privacy.erasure.requested',
        resource_type: 'PrivacyRequest',
        resource_id: body.id,
      });
      expect(databaseJson(audits[0]!.diff_summary)).toEqual({
        requestType: 'erasure',
        subjectType: 'buyer',
        subjectSha256: hashRequest({
          subjectType: 'buyer',
          subjectId: privateSubjectId,
          subjectEmail: privateEmail,
        }),
      });
      const serializedAudit = JSON.stringify(audits[0]);
      expect(serializedAudit).not.toContain(privateEmail);
      expect(serializedAudit).not.toContain(privateSubjectId);
      expect(startPrivacyRequest).toHaveBeenCalledTimes(1);
      expect(startPrivacyRequest).toHaveBeenCalledWith({ requestId: body.id });
      const idempotency = await idempotencyRows();
      expect(idempotency).toMatchObject([
        { key, tenant_id: tenantA, status: 'completed', response_status: 202 },
      ]);
      expect(idempotency[0]!.response_body).not.toContain(privateEmail);
      expect(idempotency[0]!.response_body).not.toContain(privateSubjectId);
      await db
        .updateTable('idempotency_records')
        .set({
          response_body: JSON.stringify({
            ...body,
            subjectId: privateSubjectId,
            subjectEmail: privateEmail,
          }),
        })
        .where('id', '=', idempotency[0]!.id)
        .execute();
      const replay = await invokeErasure(key);
      expect(replay.statusCode).toBe(202);
      expect(replay.json()).toMatchObject({ id: body.id, subjectId: null, subjectEmail: null });
      const rewrittenIdempotency = await idempotencyRows();
      expect(rewrittenIdempotency[0]!.response_body).not.toContain(privateEmail);
      expect(rewrittenIdempotency[0]!.response_body).not.toContain(privateSubjectId);
    });

    it('queues one scoped export with one hash-only audit and redacted replay state', async () => {
      const key = `${keyPrefix}-export-authorized`;
      const response = await invokeExport(key);

      expect(response.statusCode).toBe(202);
      const body = response.json<Record<string, unknown>>();
      expect(body).toMatchObject({
        tenantId: tenantA,
        organizationId: organizationA,
        brandId: brandA,
        requestType: 'export',
        subjectType: 'buyer',
        subjectId: null,
        subjectEmail: null,
        status: 'pending',
        requestedBy: actorId,
      });
      expect(await privacyRows()).toMatchObject([
        {
          id: body.id,
          request_type: 'export',
          subject_id: privateSubjectId,
          subject_email: privateEmail,
        },
      ]);
      const audits = await auditRows('export');
      expect(audits).toHaveLength(1);
      expect(databaseJson(audits[0]!.diff_summary)).toEqual({
        requestType: 'export',
        subjectType: 'buyer',
        subjectSha256: hashRequest({
          subjectType: 'buyer',
          subjectId: privateSubjectId,
          subjectEmail: privateEmail,
        }),
      });
      expect(JSON.stringify(audits[0])).not.toContain(privateEmail);
      expect(JSON.stringify(audits[0])).not.toContain(privateSubjectId);
      const idempotency = await idempotencyRows();
      expect(idempotency).toMatchObject([{ key, status: 'completed', response_status: 202 }]);
      expect(idempotency[0]!.response_body).not.toContain(privateEmail);
      expect(idempotency[0]!.response_body).not.toContain(privateSubjectId);
      expect(startPrivacyRequest).toHaveBeenCalledOnce();
      expect(startPrivacyRequest).toHaveBeenCalledWith({ requestId: body.id });
    });

    it.each([
      ['permission', () => principal({ scopes: [] }), erasurePayload(), 403, 'FORBIDDEN'],
      [
        'tenant',
        () => principal({ organizationIds: [organizationB], brandIds: undefined }),
        erasurePayload({ organizationId: organizationB, brandId: undefined }),
        404,
        'NOT_FOUND',
      ],
      [
        'organization',
        () => principal({ organizationIds: [organizationA], brandIds: undefined }),
        erasurePayload({ organizationId: organizationScoped, brandId: undefined }),
        404,
        'NOT_FOUND',
      ],
      [
        'brand',
        () => principal({ brandIds: [brandA] }),
        erasurePayload({ brandId: brandScoped }),
        404,
        'NOT_FOUND',
      ],
      [
        'event policy',
        () => principal({ eventIds: [`evt_privacy_${runId}`] }),
        erasurePayload(),
        403,
        'FORBIDDEN',
      ],
      [
        'brand scope requires brand',
        () => principal({ brandIds: [brandA] }),
        erasurePayload({ brandId: undefined }),
        403,
        'FORBIDDEN',
      ],
    ] as const)(
      'rejects the export %s denial before every persistent or workflow effect',
      async (_boundary, buildPrincipal, payload, status, code) => {
        activePrincipal = buildPrincipal();
        const response = await invokeExport(`${keyPrefix}-export-denial-${_boundary}`, payload);
        expect(response.statusCode).toBe(status);
        expect(response.json()).toMatchObject({ error: { code } });
        await expectNoEffects();
      },
    );

    it('sanitizes and rewrites a completed pre-actor-hash idempotency replay', async () => {
      const key = `${keyPrefix}-legacy-completed`;
      const legacy = await seedLegacyPrivacyRequest(key, 'completed');
      await db
        .insertInto('idempotency_records')
        .values({
          id: `idm_legacy_${runId}`,
          key,
          tenant_id: tenantA,
          request_hash: legacy.requestHash,
          response_status: 202,
          response_body: JSON.stringify({
            id: legacy.id,
            subjectId: privateSubjectId,
            subjectEmail: privateEmail,
            status: 'completed',
          }),
          status: 'completed',
          created_at: new Date(),
          expires_at: new Date(Date.now() + 86_400_000),
        })
        .execute();

      const replay = await invokeErasure(key);

      expect(replay.statusCode).toBe(202);
      expect(replay.json()).toMatchObject({
        id: legacy.id,
        subjectId: null,
        subjectEmail: null,
        status: 'completed',
      });
      const records = await idempotencyRows();
      expect(records[0]!.response_body).not.toContain(privateEmail);
      expect(records[0]!.response_body).not.toContain(privateSubjectId);
      expect(startPrivacyRequest).not.toHaveBeenCalled();
    });

    it('reuses and audits a pending pre-actor-hash intent whose reservation was lost', async () => {
      const key = `${keyPrefix}-legacy-pending`;
      const legacy = await seedLegacyPrivacyRequest(key, 'pending');

      const response = await invokeErasure(key);

      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({ id: legacy.id, subjectId: null, subjectEmail: null });
      expect(await privacyRows()).toHaveLength(1);
      expect(await auditRows()).toHaveLength(1);
      expect(startPrivacyRequest).toHaveBeenCalledOnce();
      expect(startPrivacyRequest).toHaveBeenCalledWith({ requestId: legacy.id });
      expect(await idempotencyRows()).toMatchObject([
        { key, request_hash: legacy.requestHash, status: 'completed' },
      ]);
    });

    it.each([
      ['permission', () => principal({ scopes: [] }), erasurePayload(), 403, 'FORBIDDEN'],
      [
        'tenant',
        () => principal({ organizationIds: [organizationB], brandIds: undefined }),
        erasurePayload({ organizationId: organizationB, brandId: undefined }),
        404,
        'NOT_FOUND',
      ],
      [
        'organization',
        () => principal({ organizationIds: [organizationA], brandIds: undefined }),
        erasurePayload({ organizationId: organizationScoped, brandId: undefined }),
        404,
        'NOT_FOUND',
      ],
      [
        'brand',
        () => principal({ brandIds: [brandA] }),
        erasurePayload({ brandId: brandScoped }),
        404,
        'NOT_FOUND',
      ],
      [
        'event policy',
        () => principal({ eventIds: [`evt_privacy_${runId}`] }),
        erasurePayload(),
        403,
        'FORBIDDEN',
      ],
      [
        'brand scope requires brand',
        () => principal({ brandIds: [brandA] }),
        erasurePayload({ brandId: undefined }),
        403,
        'FORBIDDEN',
      ],
    ] as const)(
      'rejects the %s denial before every persistent or workflow effect',
      async (_boundary, buildPrincipal, payload, status, code) => {
        activePrincipal = buildPrincipal();
        const response = await invokeErasure(`${keyPrefix}-denial-${_boundary}`, payload);
        expect(response.statusCode).toBe(status);
        expect(response.json()).toMatchObject({ error: { code } });
        await expectNoEffects();
      },
    );

    it.each([
      [
        'organization tenant',
        organizationSwap,
        undefined,
        async () => {
          await db
            .updateTable('organizations')
            .set({ tenant_id: tenantB })
            .where('id', '=', organizationSwap)
            .execute();
        },
      ],
      [
        'brand organization',
        organizationA,
        brandSwap,
        async () => {
          await db
            .updateTable('brands')
            .set({ organization_id: organizationScoped })
            .where('id', '=', brandSwap)
            .execute();
        },
      ],
    ] as const)(
      'rechecks a locked %s scope change after the optimistic authorization',
      async (label, organizationId, brandId, mutateScope) => {
        activePrincipal = principal({
          organizationIds: [organizationA, organizationSwap],
          brandIds: brandId ? [brandId] : undefined,
        });
        checkpointImplementation = async ({ stage, requestType }) => {
          if (stage === 'before_transaction' && requestType === 'erasure') await mutateScope();
        };

        const response = await invokeErasure(
          `${keyPrefix}-locked-${label}`,
          erasurePayload({ organizationId, brandId }),
        );
        expect(response.statusCode).toBe(404);
        expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
        expect(privacyRequestWriteCheckpoint).toHaveBeenCalledTimes(1);
        await expectNoEffects();
      },
    );

    it('rolls request, audit, and idempotency back when the required audit fails', async () => {
      vi.spyOn(AuditLogRepository.prototype, 'create').mockRejectedValueOnce(
        new Error('injected privacy audit failure'),
      );
      const response = await invokeErasure(`${keyPrefix}-audit-failure`);
      expect(response.statusCode).toBe(500);
      await expectNoEffects();
    });

    it('retains one pending audited intent across Temporal failure and exact retry', async () => {
      const key = `${keyPrefix}-temporal-retry`;
      startImplementation = vi
        .fn()
        .mockRejectedValueOnce(new Error('temporal unavailable'))
        .mockResolvedValueOnce(undefined);

      const failed = await invokeErasure(key);
      expect(failed.statusCode).toBe(500);
      const requestsAfterFailure = await privacyRows();
      const auditsAfterFailure = await auditRows();
      expect(requestsAfterFailure).toHaveLength(1);
      expect(auditsAfterFailure).toHaveLength(1);
      expect(await idempotencyRows()).toEqual([]);
      expect(startPrivacyRequest).toHaveBeenCalledTimes(1);

      await db
        .deleteFrom('audit_logs')
        .where('resource_type', '=', 'PrivacyRequest')
        .where('resource_id', '=', requestsAfterFailure[0]!.id)
        .execute();
      expect(await auditRows()).toEqual([]);

      const retried = await invokeErasure(key);
      expect(retried.statusCode).toBe(202);
      expect(retried.json()).toMatchObject({ id: requestsAfterFailure[0]!.id, status: 'pending' });
      expect(await privacyRows()).toHaveLength(1);
      expect(await auditRows()).toHaveLength(1);
      expect(startPrivacyRequest).toHaveBeenCalledTimes(2);
      expect(startPrivacyRequest).toHaveBeenNthCalledWith(1, {
        requestId: requestsAfterFailure[0]!.id,
      });
      expect(startPrivacyRequest).toHaveBeenNthCalledWith(2, {
        requestId: requestsAfterFailure[0]!.id,
      });
      expect(await idempotencyRows()).toMatchObject([{ key, status: 'completed' }]);
    });

    it('retains an audited intent when the process exits after commit and before dispatch', async () => {
      const key = `${keyPrefix}-post-commit-exit`;
      checkpointImplementation = async ({ stage }) => {
        if (stage === 'after_transaction_before_workflow') {
          throw new Error('injected process exit after commit');
        }
      };

      const failed = await invokeErasure(key);
      expect(failed.statusCode).toBe(500);
      expect(await privacyRows()).toHaveLength(1);
      expect(await auditRows()).toHaveLength(1);
      expect(await idempotencyRows()).toEqual([]);
      expect(startPrivacyRequest).not.toHaveBeenCalled();
    });

    it('rejects same-key actor and subject changes without additional effects', async () => {
      const key = `${keyPrefix}-identity`;
      const accepted = await invokeErasure(key);
      expect(accepted.statusCode).toBe(202);
      expect(startPrivacyRequest).toHaveBeenCalledTimes(1);

      activePrincipal = principal({ id: alternateActorId, brandIds: [brandA] });
      const changedActor = await invokeErasure(key);
      expect(changedActor.statusCode).toBe(409);
      expect(changedActor.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });

      activePrincipal = basePrincipal;
      const changedSubject = await invokeErasure(
        key,
        erasurePayload({ subjectEmail: `changed-${privateEmail}` }),
      );
      expect(changedSubject.statusCode).toBe(409);
      expect(changedSubject.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
      expect(await privacyRows()).toHaveLength(1);
      expect(await auditRows()).toHaveLength(1);
      expect(await idempotencyRows()).toHaveLength(1);
      expect(startPrivacyRequest).toHaveBeenCalledTimes(1);
    });

    it('serializes overlapping identical requests into one row, audit, start, and replay', async () => {
      const key = `${keyPrefix}-concurrency`;
      let releaseStart: (() => void) | undefined;
      const startBlocked = new Promise<void>((resolve) => {
        releaseStart = resolve;
      });
      let announceStart: (() => void) | undefined;
      const startReached = new Promise<void>((resolve) => {
        announceStart = resolve;
      });
      startImplementation = async () => {
        announceStart?.();
        await startBlocked;
      };

      const winner = invokeErasure(key);
      await startReached;
      const followers = Array.from({ length: 4 }, () => invokeErasure(key));
      releaseStart?.();
      const responses = await Promise.all([winner, ...followers]);

      expect(responses.map((response) => response.statusCode)).toEqual([202, 202, 202, 202, 202]);
      const ids = new Set(responses.map((response) => response.json<{ id: string }>().id));
      expect(ids.size).toBe(1);
      expect(await privacyRows()).toHaveLength(1);
      expect(await auditRows()).toHaveLength(1);
      expect(await idempotencyRows()).toMatchObject([{ key, status: 'completed' }]);
      expect(startPrivacyRequest).toHaveBeenCalledTimes(1);
    });
  },
);
