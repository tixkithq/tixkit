import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createDb, EventRepository, type Database } from '@tixkit/db';
import type { Principal } from '@tixkit/domain';
import { ulid } from 'ulid';
import { registerErrorHandler, type AppContext } from '../../app.js';
import { tenantRoutes } from '../../routes/modules/tenant.js';
import {
  describeWithIntegrationDatabase,
  integrationDatabaseUrl,
  restoreDatabaseDriver,
  setIntegrationDatabaseDriver,
} from './integration-database.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describeWithIntegrationDatabase('organization member route authorization matrix', () => {
  let app: FastifyInstance;
  let db: Database;
  let previousDriver: string | undefined;
  let principal: Principal;
  const startNotificationDelivery = vi.fn(async ({ jobId }: { jobId: string }) => ({
    workflowId: `notification:${jobId}`,
  }));

  const suffix = ulid().slice(-10).toLowerCase();
  const tenantId = `tnt_mem_${suffix}`;
  const organizationId = `org_mem_${suffix}`;
  const siblingOrganizationId = `org_mem_s_${suffix}`;
  const brandId = `brd_mem_${suffix}`;
  const siblingBrandId = `brd_mem_s_${suffix}`;
  let siblingEventId: string;
  const actorId = `usr_mem_a_${suffix}`;
  const actorMemberId = `mem_mem_a_${suffix}`;
  const actorSiblingMemberId = `mem_mem_as_${suffix}`;
  const secondActorId = `usr_mem_b_${suffix}`;
  const secondActorMemberId = `mem_mem_b_${suffix}`;
  const targetId = `usr_mem_t_${suffix}`;
  const targetMemberId = `mem_mem_t_${suffix}`;
  const actorGrantId = `pg_mem_a_${suffix}`;
  const actorSiblingGrantId = `pg_mem_as_${suffix}`;
  const secondActorGrantId = `pg_mem_b_${suffix}`;
  const targetGrantId = `pg_mem_t_${suffix}`;
  const basePrincipal: Principal = {
    type: 'user',
    id: actorId,
    tenantId,
    organizationIds: [organizationId],
    brandIds: [brandId],
    scopes: ['settings.write'],
  };

  beforeAll(async () => {
    previousDriver = setIntegrationDatabaseDriver();
    db = createDb(integrationDatabaseUrl());
    const now = new Date();
    await db
      .insertInto('tenants')
      .values({
        id: tenantId,
        name: 'Member route tenant',
        status: 'active',
        plan: 'test',
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto('organizations')
      .values([
        {
          id: organizationId,
          tenant_id: tenantId,
          name: 'Member route organization',
          slug: `member-route-${suffix}`,
          clerk_organization_id: null,
          box_office_settings: '{}',
          status: 'active',
          created_at: now,
          updated_at: now,
        },
        {
          id: siblingOrganizationId,
          tenant_id: tenantId,
          name: 'Member route sibling organization',
          slug: `member-route-sibling-${suffix}`,
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
          name: 'Member route brand',
          slug: `member-route-brand-${suffix}`,
          status: 'active',
          theme: '{}',
          support_url: null,
          legal_urls: '{}',
          white_label: false,
          payment_account_id: null,
          created_at: now,
          updated_at: now,
        },
        {
          id: siblingBrandId,
          tenant_id: tenantId,
          organization_id: siblingOrganizationId,
          name: 'Member route sibling brand',
          slug: `member-route-sibling-brand-${suffix}`,
          status: 'active',
          theme: '{}',
          support_url: null,
          legal_urls: '{}',
          white_label: false,
          payment_account_id: null,
          created_at: now,
          updated_at: now,
        },
      ])
      .execute();
    siblingEventId = (
      await new EventRepository(db).create({
        tenantId,
        organizationId: siblingOrganizationId,
        brandId: siblingBrandId,
        slug: `member-route-sibling-event-${suffix}`,
        title: 'Member route sibling event',
        currency: 'USD',
        timezone: 'UTC',
        startsAt: new Date('2027-01-01T00:00:00.000Z'),
      })
    ).id;
    await db
      .insertInto('user_profiles')
      .values([
        {
          id: actorId,
          tenant_id: tenantId,
          clerk_user_id: `clerk_${actorId}`,
          email: `actor-${suffix}@example.test`,
          first_name: 'Actor',
          last_name: 'Admin',
          avatar_url: null,
          status: 'active',
          last_seen_at: null,
          created_at: now,
          updated_at: now,
        },
        {
          id: secondActorId,
          tenant_id: tenantId,
          clerk_user_id: `clerk_${secondActorId}`,
          email: `actor-b-${suffix}@example.test`,
          first_name: 'Second',
          last_name: 'Admin',
          avatar_url: null,
          status: 'active',
          last_seen_at: null,
          created_at: now,
          updated_at: now,
        },
        {
          id: targetId,
          tenant_id: tenantId,
          clerk_user_id: `clerk_${targetId}`,
          email: `target-${suffix}@example.test`,
          first_name: 'Target',
          last_name: 'Member',
          avatar_url: null,
          status: 'active',
          last_seen_at: null,
          created_at: now,
          updated_at: now,
        },
      ])
      .execute();
    await db
      .insertInto('organization_members')
      .values([
        {
          id: actorMemberId,
          tenant_id: tenantId,
          organization_id: organizationId,
          user_id: actorId,
          role: 'admin',
          invited_at: now,
          accepted_at: now,
          created_at: now,
          updated_at: now,
        },
        {
          id: actorSiblingMemberId,
          tenant_id: tenantId,
          organization_id: siblingOrganizationId,
          user_id: actorId,
          role: 'admin',
          invited_at: now,
          accepted_at: now,
          created_at: now,
          updated_at: now,
        },
        {
          id: secondActorMemberId,
          tenant_id: tenantId,
          organization_id: organizationId,
          user_id: secondActorId,
          role: 'admin',
          invited_at: now,
          accepted_at: now,
          created_at: now,
          updated_at: now,
        },
        {
          id: targetMemberId,
          tenant_id: tenantId,
          organization_id: organizationId,
          user_id: targetId,
          role: 'viewer',
          invited_at: now,
          accepted_at: now,
          created_at: now,
          updated_at: now,
        },
      ])
      .execute();

    principal = basePrincipal;
    app = Fastify({ logger: false, genReqId: () => `req_mem_${suffix}` });
    app.decorate('context', {
      db,
      temporalClient: { startNotificationDelivery },
    } as unknown as AppContext);
    app.addHook('onRequest', async (request) => {
      request.principal = principal;
    });
    registerErrorHandler(app);
    await app.register(tenantRoutes);
    await app.ready();
  });

  beforeEach(async () => {
    principal = basePrincipal;
    startNotificationDelivery.mockReset();
    startNotificationDelivery.mockImplementation(async ({ jobId }: { jobId: string }) => ({
      workflowId: `notification:${jobId}`,
    }));
    const now = new Date();
    await db.deleteFrom('audit_logs').where('tenant_id', '=', tenantId).execute();
    await db.deleteFrom('idempotency_records').where('tenant_id', '=', tenantId).execute();
    await db
      .deleteFrom('permission_grants')
      .where('tenant_id', '=', tenantId)
      .where('principal_id', 'in', [actorId, secondActorId, targetId])
      .execute();
    await db
      .insertInto('permission_grants')
      .values([
        {
          id: actorGrantId,
          tenant_id: tenantId,
          principal_type: 'user',
          principal_id: actorId,
          permission: 'settings.write',
          scope_type: 'organization',
          scope_id: organizationId,
          organization_member_id: actorMemberId,
          created_at: now,
          updated_at: now,
        },
        {
          id: actorSiblingGrantId,
          tenant_id: tenantId,
          principal_type: 'user',
          principal_id: actorId,
          permission: 'settings.write',
          scope_type: 'organization',
          scope_id: siblingOrganizationId,
          organization_member_id: actorSiblingMemberId,
          created_at: now,
          updated_at: now,
        },
        {
          id: secondActorGrantId,
          tenant_id: tenantId,
          principal_type: 'user',
          principal_id: secondActorId,
          permission: 'settings.write',
          scope_type: 'organization',
          scope_id: organizationId,
          organization_member_id: secondActorMemberId,
          created_at: now,
          updated_at: now,
        },
        {
          id: targetGrantId,
          tenant_id: tenantId,
          principal_type: 'user',
          principal_id: targetId,
          permission: 'events.read',
          scope_type: 'organization',
          scope_id: organizationId,
          organization_member_id: targetMemberId,
          created_at: now,
          updated_at: now,
        },
      ])
      .execute();
    await db
      .updateTable('organization_members')
      .set({ role: 'viewer', accepted_at: now, updated_at: now })
      .where('id', '=', targetMemberId)
      .execute();
  });

  afterAll(async () => {
    try {
      if (app) await app.close();
      if (db) {
        await db.deleteFrom('audit_logs').where('tenant_id', '=', tenantId).execute();
        await db.deleteFrom('idempotency_records').where('tenant_id', '=', tenantId).execute();
        await db.deleteFrom('email_jobs').where('tenant_id', '=', tenantId).execute();
        await db.deleteFrom('permission_grants').where('tenant_id', '=', tenantId).execute();
        await db.deleteFrom('organization_members').where('tenant_id', '=', tenantId).execute();
        await db.deleteFrom('user_profiles').where('tenant_id', '=', tenantId).execute();
        await db.deleteFrom('events').where('id', '=', siblingEventId).execute();
        await db.deleteFrom('brands').where('id', 'in', [brandId, siblingBrandId]).execute();
        await db
          .deleteFrom('organizations')
          .where('id', 'in', [organizationId, siblingOrganizationId])
          .execute();
        await db.deleteFrom('tenants').where('id', '=', tenantId).execute();
      }
    } finally {
      if (db) await db.destroy();
      restoreDatabaseDriver(previousDriver);
    }
  });

  it('atomically replaces grants, audits, and replays the exact member update', async () => {
    const headers = { 'idempotency-key': `member-update-${suffix}-0001` };
    const payload = { role: 'door_staff_sales', brandIds: [brandId] };
    const first = await app.inject({
      method: 'PATCH',
      url: `/organizations/${organizationId}/members/${targetMemberId}`,
      headers,
      payload,
    });
    expect(first.statusCode, first.body).toBe(200);
    const replay = await app.inject({
      method: 'PATCH',
      url: `/organizations/${organizationId}/members/${targetMemberId}`,
      headers,
      payload,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());
    const grants = await db
      .selectFrom('permission_grants')
      .select(['permission', 'scope_type', 'scope_id'])
      .where('tenant_id', '=', tenantId)
      .where('principal_id', '=', targetId)
      .execute();
    expect(grants.length).toBeGreaterThan(1);
    expect(
      grants.every((grant) => grant.scope_type === 'brand' && grant.scope_id === brandId),
    ).toBe(true);
    expect(
      await db
        .selectFrom('audit_logs')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .where('action', '=', 'organization_member.role_updated')
        .execute(),
    ).toHaveLength(1);

    const changed = await app.inject({
      method: 'PATCH',
      url: `/organizations/${organizationId}/members/${targetMemberId}`,
      headers,
      payload: { role: 'viewer' },
    });
    expect(changed.statusCode).toBe(409);
  });

  it('atomically invites, audits, queues, and replays one scoped member', async () => {
    const email = `invited-${suffix}@example.test`;
    const headers = { 'idempotency-key': `member-invite-${suffix}-0001` };
    const payload = { email, role: 'door_staff', brandIds: [brandId] };
    const first = await app.inject({
      method: 'POST',
      url: `/organizations/${organizationId}/members/invitations`,
      headers,
      payload,
    });
    expect(first.statusCode, first.body).toBe(201);
    const replay = await app.inject({
      method: 'POST',
      url: `/organizations/${organizationId}/members/invitations`,
      headers,
      payload,
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(first.json());
    expect(startNotificationDelivery).toHaveBeenCalledTimes(1);
    const invitedProfile = await db
      .selectFrom('user_profiles')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('email', '=', email)
      .executeTakeFirstOrThrow();
    const invitedMember = await db
      .selectFrom('organization_members')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('organization_id', '=', organizationId)
      .where('user_id', '=', invitedProfile.id)
      .executeTakeFirstOrThrow();
    expect(
      await db
        .selectFrom('permission_grants')
        .select(['scope_id', 'organization_member_id'])
        .where('tenant_id', '=', tenantId)
        .where('principal_id', '=', invitedProfile.id)
        .execute(),
    ).toEqual(
      expect.arrayContaining([{ scope_id: brandId, organization_member_id: invitedMember.id }]),
    );
    expect(
      await db
        .selectFrom('audit_logs')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .where('action', '=', 'organization_member.invited')
        .execute(),
    ).toHaveLength(1);
    expect(
      await db
        .selectFrom('email_jobs')
        .select(['status', 'workflow_id'])
        .where('tenant_id', '=', tenantId)
        .where('to_email', '=', email)
        .execute(),
    ).toEqual([
      expect.objectContaining({
        status: 'queued',
        workflow_id: expect.any(String),
      }),
    ]);

    const changed = await app.inject({
      method: 'POST',
      url: `/organizations/${organizationId}/members/invitations`,
      headers,
      payload: { ...payload, role: 'viewer' },
    });
    expect(changed.statusCode).toBe(409);
  });

  it('binds raw idempotency keys across actors, organizations, members, and payloads', async () => {
    const updateKey = `member-update-${suffix}-binding`;
    const update = await app.inject({
      method: 'PATCH',
      url: `/organizations/${organizationId}/members/${targetMemberId}`,
      headers: { 'idempotency-key': updateKey },
      payload: { role: 'viewer' },
    });
    expect(update.statusCode, update.body).toBe(200);

    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/organizations/${organizationId}/members/${actorMemberId}`,
          headers: { 'idempotency-key': updateKey },
          payload: { role: 'admin' },
        })
      ).statusCode,
    ).toBe(409);
    principal = {
      ...basePrincipal,
      id: secondActorId,
      brandIds: [],
    };
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/organizations/${organizationId}/members/${targetMemberId}`,
          headers: { 'idempotency-key': updateKey },
          payload: { role: 'viewer' },
        })
      ).statusCode,
    ).toBe(409);
    principal = {
      ...basePrincipal,
      organizationIds: [organizationId, siblingOrganizationId],
      brandIds: [brandId, siblingBrandId],
    };
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/organizations/${siblingOrganizationId}/members/${targetMemberId}`,
          headers: { 'idempotency-key': updateKey },
          payload: { role: 'viewer' },
        })
      ).statusCode,
    ).toBe(409);

    principal = basePrincipal;
    const inviteKey = `member-invite-${suffix}-binding`;
    const invitePayload = {
      email: `binding-${suffix}@example.test`,
      role: 'viewer',
      brandIds: [brandId],
    };
    const invite = await app.inject({
      method: 'POST',
      url: `/organizations/${organizationId}/members/invitations`,
      headers: { 'idempotency-key': inviteKey },
      payload: invitePayload,
    });
    expect(invite.statusCode, invite.body).toBe(201);
    principal = {
      ...basePrincipal,
      id: secondActorId,
      brandIds: [],
    };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/organizations/${organizationId}/members/invitations`,
          headers: { 'idempotency-key': inviteKey },
          payload: invitePayload,
        })
      ).statusCode,
    ).toBe(409);
    principal = {
      ...basePrincipal,
      organizationIds: [organizationId, siblingOrganizationId],
      brandIds: [brandId, siblingBrandId],
    };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/organizations/${siblingOrganizationId}/members/invitations`,
          headers: { 'idempotency-key': inviteKey },
          payload: { ...invitePayload, brandIds: [siblingBrandId] },
        })
      ).statusCode,
    ).toBe(409);
    expect(startNotificationDelivery).toHaveBeenCalledTimes(1);
    expect(
      await db
        .selectFrom('audit_logs')
        .select('action')
        .where('tenant_id', '=', tenantId)
        .orderBy('action')
        .execute(),
    ).toEqual([
      { action: 'organization_member.invited' },
      { action: 'organization_member.role_updated' },
    ]);
  });

  it('rolls the complete invitation back when fail-closed audit persistence fails', async () => {
    const email = `audit-failure-${suffix}@example.test`;
    const response = await app.inject({
      method: 'POST',
      url: `/organizations/${organizationId}/members/invitations`,
      headers: {
        'idempotency-key': `member-invite-${suffix}-audit`,
        'user-agent': 'x'.repeat(600),
      },
      payload: { email, role: 'viewer' },
    });
    expect(response.statusCode).toBe(500);
    expect(
      await db
        .selectFrom('user_profiles')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .where('email', '=', email)
        .execute(),
    ).toHaveLength(0);
    expect(
      await db
        .selectFrom('email_jobs')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .where('to_email', '=', email)
        .execute(),
    ).toHaveLength(0);
    expect(
      await db
        .selectFrom('idempotency_records')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .execute(),
    ).toHaveLength(0);
    expect(startNotificationDelivery).not.toHaveBeenCalled();
  });

  it('retries a durable failed invitation handoff without duplicating effects', async () => {
    const email = `handoff-${suffix}@example.test`;
    const request = {
      method: 'POST' as const,
      url: `/organizations/${organizationId}/members/invitations`,
      headers: { 'idempotency-key': `member-invite-${suffix}-handoff` },
      payload: { email, role: 'viewer' },
    };
    startNotificationDelivery
      .mockRejectedValueOnce(new Error('Temporal unavailable'))
      .mockResolvedValueOnce({
        workflowId: `notification:recovered-${suffix}`,
      });
    const failed = await app.inject(request);
    expect(failed.statusCode).toBe(500);
    expect(
      await db
        .selectFrom('email_jobs')
        .select(['status', 'workflow_id'])
        .where('tenant_id', '=', tenantId)
        .where('to_email', '=', email)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: 'start_failed', workflow_id: null });
    const recovered = await app.inject(request);
    expect(recovered.statusCode, recovered.body).toBe(201);
    expect(startNotificationDelivery).toHaveBeenCalledTimes(2);
    expect(
      await db
        .selectFrom('organization_members')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .where(
          'user_id',
          '=',
          db
            .selectFrom('user_profiles')
            .select('id')
            .where('tenant_id', '=', tenantId)
            .where('email', '=', email),
        )
        .execute(),
    ).toHaveLength(1);
    expect(
      await db
        .selectFrom('audit_logs')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .where('action', '=', 'organization_member.invited')
        .execute(),
    ).toHaveLength(1);
  });

  it('lists members only after locked live membership and grant authorization', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/organizations/${organizationId}/members`,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().map((member: { id: string }) => member.id)).toEqual(
      expect.arrayContaining([actorMemberId, targetMemberId]),
    );

    await db.deleteFrom('permission_grants').where('id', '=', actorGrantId).execute();
    const denied = await app.inject({
      method: 'GET',
      url: `/organizations/${organizationId}/members`,
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.body).not.toContain(targetId);
    expect(denied.body).not.toContain(`target-${suffix}@example.test`);
  });

  it('rejects a stale bearer grant without member, grant, audit, or idempotency mutation', async () => {
    await db.deleteFrom('permission_grants').where('id', '=', actorGrantId).execute();
    const beforeMember = await db
      .selectFrom('organization_members')
      .select(['role', 'updated_at'])
      .where('id', '=', targetMemberId)
      .executeTakeFirstOrThrow();
    const beforeGrants = await db
      .selectFrom('permission_grants')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('principal_id', '=', targetId)
      .execute();
    const response = await app.inject({
      method: 'PATCH',
      url: `/organizations/${organizationId}/members/${targetMemberId}`,
      headers: { 'idempotency-key': `member-update-${suffix}-denied` },
      payload: { role: 'admin' },
    });
    expect(response.statusCode).toBe(403);
    expect(
      await db
        .selectFrom('organization_members')
        .select(['role', 'updated_at'])
        .where('id', '=', targetMemberId)
        .executeTakeFirstOrThrow(),
    ).toEqual(beforeMember);
    expect(
      await db
        .selectFrom('permission_grants')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('principal_id', '=', targetId)
        .execute(),
    ).toEqual(beforeGrants);
    expect(
      await db.selectFrom('audit_logs').select('id').where('tenant_id', '=', tenantId).execute(),
    ).toHaveLength(0);
    expect(
      await db
        .selectFrom('idempotency_records')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .execute(),
    ).toHaveLength(0);
  });

  it('fails closed across principal, tenant, organization, brand, event, and member boundaries', async () => {
    const mutationCount = async () => ({
      audits: Number(
        (
          await db
            .selectFrom('audit_logs')
            .select(({ fn }) => fn.countAll<number>().as('count'))
            .where('tenant_id', '=', tenantId)
            .executeTakeFirstOrThrow()
        ).count,
      ),
      emails: Number(
        (
          await db
            .selectFrom('email_jobs')
            .select(({ fn }) => fn.countAll<number>().as('count'))
            .where('tenant_id', '=', tenantId)
            .executeTakeFirstOrThrow()
        ).count,
      ),
      idempotency: Number(
        (
          await db
            .selectFrom('idempotency_records')
            .select(({ fn }) => fn.countAll<number>().as('count'))
            .where('tenant_id', '=', tenantId)
            .executeTakeFirstOrThrow()
        ).count,
      ),
    });
    const before = await mutationCount();
    const unknownOrganizationId = `org_missing_${suffix}`;

    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/organizations/${unknownOrganizationId}/members`,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/organizations/${siblingOrganizationId}/members`,
        })
      ).statusCode,
    ).toBe(404);

    principal = { ...basePrincipal, tenantId: `tnt_other_${suffix}` };
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/organizations/${organizationId}/members`,
        })
      ).statusCode,
    ).toBe(404);

    for (const principalType of ['api_key', 'agent', 'mobile_device'] as const) {
      principal = { ...basePrincipal, type: principalType };
      for (const request of [
        {
          method: 'POST' as const,
          url: `/organizations/${organizationId}/members/invitations`,
          headers: { 'idempotency-key': `member-invite-${suffix}-${principalType}` },
          payload: {
            email: `${principalType}-${suffix}@example.test`,
            role: 'viewer',
          },
        },
        {
          method: 'PATCH' as const,
          url: `/organizations/${organizationId}/members/${targetMemberId}`,
          headers: { 'idempotency-key': `member-update-${suffix}-${principalType}` },
          payload: { role: 'viewer' },
        },
      ]) {
        expect((await app.inject(request)).statusCode).toBe(403);
      }
    }

    principal = { ...basePrincipal, type: 'system', id: `system_${suffix}` };
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/organizations/${organizationId}/members`,
        })
      ).statusCode,
    ).toBe(200);

    principal = basePrincipal;
    for (const request of [
      {
        method: 'POST' as const,
        url: `/organizations/${organizationId}/members/invitations`,
        headers: { 'idempotency-key': `member-invite-${suffix}-brand` },
        payload: {
          email: `brand-denied-${suffix}@example.test`,
          role: 'viewer',
          brandIds: [siblingBrandId],
        },
      },
      {
        method: 'POST' as const,
        url: `/organizations/${organizationId}/members/invitations`,
        headers: { 'idempotency-key': `member-invite-${suffix}-event` },
        payload: {
          email: `event-denied-${suffix}@example.test`,
          role: 'viewer',
          eventIds: [siblingEventId],
        },
      },
      {
        method: 'PATCH' as const,
        url: `/organizations/${organizationId}/members/${actorSiblingMemberId}`,
        headers: { 'idempotency-key': `member-update-${suffix}-member` },
        payload: { role: 'viewer' },
      },
      {
        method: 'PATCH' as const,
        url: `/organizations/${organizationId}/members/${targetMemberId}`,
        headers: { 'idempotency-key': `member-update-${suffix}-brand` },
        payload: { role: 'viewer', brandIds: [siblingBrandId] },
      },
      {
        method: 'PATCH' as const,
        url: `/organizations/${organizationId}/members/${targetMemberId}`,
        headers: { 'idempotency-key': `member-update-${suffix}-event` },
        payload: { role: 'viewer', eventIds: [siblingEventId] },
      },
    ]) {
      expect((await app.inject(request)).statusCode).toBe(404);
    }
    expect(await mutationCount()).toEqual(before);
    expect(startNotificationDelivery).not.toHaveBeenCalled();
  });

  it('rolls role, grants, audit, and idempotency back when audit persistence fails', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/organizations/${organizationId}/members/${targetMemberId}`,
      headers: {
        'idempotency-key': `member-update-${suffix}-audit`,
        'user-agent': 'x'.repeat(600),
      },
      payload: { role: 'admin' },
    });
    expect(response.statusCode).toBe(500);
    expect(
      await db
        .selectFrom('organization_members')
        .select('role')
        .where('id', '=', targetMemberId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ role: 'viewer' });
    expect(
      await db
        .selectFrom('permission_grants')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .where('principal_id', '=', targetId)
        .execute(),
    ).toEqual([{ id: targetGrantId }]);
    expect(
      await db.selectFrom('audit_logs').select('id').where('tenant_id', '=', tenantId).execute(),
    ).toHaveLength(0);
    expect(
      await db
        .selectFrom('idempotency_records')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .execute(),
    ).toHaveLength(0);
  });

  it('serializes actor grant revocation before the member mutation', async () => {
    const locked = deferred();
    const release = deferred();
    const revocation = db.transaction().execute(async (transaction) => {
      await transaction
        .selectFrom('organizations')
        .select('id')
        .where('id', '=', organizationId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      await transaction.deleteFrom('permission_grants').where('id', '=', actorGrantId).execute();
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    const request = app.inject({
      method: 'PATCH',
      url: `/organizations/${organizationId}/members/${targetMemberId}`,
      headers: { 'idempotency-key': `member-update-${suffix}-revoke-race` },
      payload: { role: 'admin' },
    });
    release.resolve();
    await revocation;
    const response = await request;
    expect(response.statusCode).toBe(403);
    expect(
      await db
        .selectFrom('organization_members')
        .select('role')
        .where('id', '=', targetMemberId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ role: 'viewer' });
    expect(
      await db.selectFrom('audit_logs').select('id').where('tenant_id', '=', tenantId).execute(),
    ).toHaveLength(0);
  });

  it('rechecks a concurrent target owner promotion under the organization lock', async () => {
    const locked = deferred();
    const release = deferred();
    const promotion = db.transaction().execute(async (transaction) => {
      await transaction
        .selectFrom('organizations')
        .select('id')
        .where('id', '=', organizationId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable('organization_members')
        .set({ role: 'owner', updated_at: new Date() })
        .where('id', '=', targetMemberId)
        .execute();
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    const request = app.inject({
      method: 'PATCH',
      url: `/organizations/${organizationId}/members/${targetMemberId}`,
      headers: { 'idempotency-key': `member-update-${suffix}-owner-race` },
      payload: { role: 'viewer' },
    });
    release.resolve();
    await promotion;
    const response = await request;
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('Owner role cannot be changed');
    expect(
      await db
        .selectFrom('organization_members')
        .select('role')
        .where('id', '=', targetMemberId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ role: 'owner' });
    expect(
      await db.selectFrom('audit_logs').select('id').where('tenant_id', '=', tenantId).execute(),
    ).toHaveLength(0);
  });

  it('rejects self-admin scope narrowing without persistent effects', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/organizations/${organizationId}/members/${actorMemberId}`,
      headers: { 'idempotency-key': `member-update-${suffix}-self-scope` },
      payload: { role: 'admin', brandIds: [brandId] },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('scope down your own admin access');
    expect(
      await db
        .selectFrom('permission_grants')
        .select(['permission', 'scope_type', 'scope_id'])
        .where('id', '=', actorGrantId)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      permission: 'settings.write',
      scope_type: 'organization',
      scope_id: organizationId,
    });
    expect(
      await db.selectFrom('audit_logs').select('id').where('tenant_id', '=', tenantId).execute(),
    ).toHaveLength(0);
    expect(
      await db
        .selectFrom('idempotency_records')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .execute(),
    ).toHaveLength(0);
  });

  it('removes membership-owned grants after a scoped resource moves organizations', async () => {
    const first = await app.inject({
      method: 'PATCH',
      url: `/organizations/${organizationId}/members/${targetMemberId}`,
      headers: { 'idempotency-key': `member-update-${suffix}-moved-first` },
      payload: { role: 'door_staff', brandIds: [brandId] },
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(
      await db
        .selectFrom('permission_grants')
        .select('organization_member_id')
        .where('tenant_id', '=', tenantId)
        .where('principal_id', '=', targetId)
        .execute(),
    ).toEqual(expect.arrayContaining([{ organization_member_id: targetMemberId }]));

    await db
      .updateTable('brands')
      .set({ organization_id: siblingOrganizationId, updated_at: new Date() })
      .where('id', '=', brandId)
      .execute();
    try {
      const replacement = await app.inject({
        method: 'PATCH',
        url: `/organizations/${organizationId}/members/${targetMemberId}`,
        headers: {
          'idempotency-key': `member-update-${suffix}-moved-second`,
        },
        payload: { role: 'viewer' },
      });
      expect(replacement.statusCode, replacement.body).toBe(200);
      const grants = await db
        .selectFrom('permission_grants')
        .select(['scope_type', 'scope_id', 'organization_member_id'])
        .where('tenant_id', '=', tenantId)
        .where('principal_id', '=', targetId)
        .execute();
      expect(grants.some((grant) => grant.scope_id === brandId)).toBe(false);
      expect(grants.every((grant) => grant.organization_member_id === targetMemberId)).toBe(true);
    } finally {
      await db
        .updateTable('brands')
        .set({ organization_id: organizationId, updated_at: new Date() })
        .where('id', '=', brandId)
        .execute();
    }
  });
});
