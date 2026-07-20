import Fastify from 'fastify';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { AGENT_PROTOCOL_VERSION } from '@tixkit/agent-protocol';
import { AgentExecutionRepository, createDb, type Database } from '@tixkit/db';
import { registerErrorHandler, type AppContext } from '../../app.js';
import { ClerkAuthService } from '../../auth/clerk.js';
import { oauthTokenRoutes } from '../../routes/modules/oauth.js';
import {
  describeWithIntegrationDatabase,
  integrationDatabaseUrl,
  restoreDatabaseDriver,
  setIntegrationDatabaseDriver,
} from './integration-database.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describeWithIntegrationDatabase('agent OAuth protocol issuance locking', () => {
  let app: ReturnType<typeof Fastify>;
  let db: Database;
  let previousDriver: string | undefined;

  const suffix = Math.random().toString(16).slice(2, 10);
  const tenantId = `tnt_ao_${suffix}`;
  const organizationId = `org_ao_${suffix}`;
  const agentPrincipalId = `agt_ao_${suffix}`;
  const applicationId = `oapp_ao_${suffix}`;
  const clientId = `agent_oauth_${suffix}`;
  const clientSecret = `agent_secret_${suffix}`;
  const sponsorId = `usr_ao_${suffix}`;

  beforeAll(async () => {
    previousDriver = setIntegrationDatabaseDriver();
    db = createDb(integrationDatabaseUrl());
    const now = new Date();
    await db
      .insertInto('tenants')
      .values({
        id: tenantId,
        name: `Agent OAuth protocol ${suffix}`,
        status: 'active',
        plan: 'test',
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto('organizations')
      .values({
        id: organizationId,
        tenant_id: tenantId,
        name: `Agent OAuth protocol ${suffix}`,
        slug: `agent-oauth-${suffix}`,
        clerk_organization_id: null,
        box_office_settings: '{}',
        status: 'active',
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto('user_profiles')
      .values({
        id: sponsorId,
        tenant_id: tenantId,
        clerk_user_id: `clerk_${sponsorId}`,
        email: `${sponsorId}@example.test`,
        first_name: null,
        last_name: null,
        avatar_url: null,
        status: 'active',
        last_seen_at: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto('permission_grants')
      .values({
        id: `pg_${suffix}`,
        tenant_id: tenantId,
        principal_type: 'user',
        principal_id: sponsorId,
        permission: 'developers.write',
        scope_type: 'tenant',
        scope_id: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto('agent_principals')
      .values({
        id: agentPrincipalId,
        tenant_id: tenantId,
        kind: 'third_party',
        sponsor_principal_id: sponsorId,
        capabilities: '["events.read"]',
        maximum_autonomy: 'read',
        protocol_version: AGENT_PROTOCOL_VERSION,
        state: 'active',
        registered_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto('oauth_applications')
      .values({
        id: applicationId,
        tenant_id: tenantId,
        organization_id: organizationId,
        name: `Agent OAuth ${suffix}`,
        client_id: clientId,
        client_secret_hash: createHash('sha256').update(clientSecret).digest('hex'),
        redirect_uris: '[]',
        scopes: '["agent.invoke"]',
        subject_type: 'agent',
        agent_principal_id: agentPrincipalId,
        status: 'active',
        created_at: now,
        updated_at: now,
      })
      .execute();

    app = Fastify();
    app.decorate('context', { db } as AppContext);
    await app.register(oauthTokenRoutes);
    registerErrorHandler(app);
  });

  afterAll(async () => {
    await app?.close();
    await db?.destroy();
    restoreDatabaseDriver(previousDriver);
  });

  it('rejects issuance after a concurrent protocol change without persisting a token', async () => {
    const locked = deferred();
    const release = deferred();
    const mutation = db.transaction().execute(async (transaction) => {
      await transaction
        .selectFrom('agent_principals')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .where('id', '=', agentPrincipalId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      locked.resolve();
      await release.promise;
      await transaction
        .updateTable('agent_principals')
        .set({ protocol_version: '2026-07-01', updated_at: new Date() })
        .where('tenant_id', '=', tenantId)
        .where('id', '=', agentPrincipalId)
        .execute();
    });
    await locked.promise;

    const responsePromise = app.inject({
      method: 'POST',
      url: '/oauth/token',
      payload: {
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      },
    });
    release.resolve();
    await mutation;
    const response = await responsePromise;

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: 'Unauthorized',
      message: 'Invalid agent client credentials',
    });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers.pragma).toBe('no-cache');
    const tokenCount = await db
      .selectFrom('oauth_access_tokens')
      .select(({ fn }) => fn.countAll().as('count'))
      .where('oauth_application_id', '=', applicationId)
      .executeTakeFirstOrThrow();
    expect(Number(tokenCount.count)).toBe(0);
    await db
      .updateTable('agent_principals')
      .set({ protocol_version: AGENT_PROTOCOL_VERSION, updated_at: new Date() })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', agentPrincipalId)
      .execute();
  });

  it('invalidates an issued token immediately after transactional principal revocation', async () => {
    const rawToken = `tk_aat_${suffix}`;
    const now = new Date();
    await db
      .insertInto('oauth_access_tokens')
      .values({
        id: `oat_revoke_${suffix}`,
        oauth_application_id: applicationId,
        refresh_token_id: null,
        tenant_id: tenantId,
        organization_id: organizationId,
        token_hash: createHash('sha256').update(rawToken).digest('hex'),
        scopes: '["agent.invoke"]',
        subject_type: 'agent',
        subject_id: agentPrincipalId,
        expires_at: new Date(now.getTime() + 600_000),
        revoked_at: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    const auth = new ClerkAuthService('sk_test_agent_protocol', db);
    await expect(
      auth.authenticateAgentAccessToken({
        headers: { authorization: `Bearer ${rawToken}` },
      } as never),
    ).resolves.toMatchObject({ principal: { type: 'agent', id: agentPrincipalId } });

    await expect(
      new AgentExecutionRepository(db).revokePrincipal({
        tenantId,
        principalId: agentPrincipalId,
        audit: {
          id: `agent_revoke_${suffix}`,
          actorPrincipalId: sponsorId,
          reasonCode: 'PLATFORM_AGENT_PRINCIPAL_REVOKE',
          idempotencyKey: `agent-principal-revoke-${suffix}`,
        },
      }),
    ).resolves.toBe(true);
    await expect(
      auth.authenticateAgentAccessToken({
        headers: { authorization: `Bearer ${rawToken}` },
      } as never),
    ).rejects.toThrow('Invalid, expired, or revoked agent access token');
    expect(
      await db
        .selectFrom('oauth_access_tokens')
        .select('revoked_at')
        .where('id', '=', `oat_revoke_${suffix}`)
        .executeTakeFirstOrThrow(),
    ).toEqual({ revoked_at: null });
  });
});
