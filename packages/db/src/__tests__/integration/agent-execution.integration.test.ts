import {
  AGENT_PROTOCOL_VERSION,
  agentExecutionIdempotencyKey,
  type AgentApproval,
  type AgentAuditRecord,
  type AgentDelegationGrant,
  type AgentExecution,
  type AgentPrincipal,
} from '@tixkit/agent-protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../../client.js';
import { runMigrations, truncateAllData } from '../../migrate.js';
import { AgentOAuthCredentialsMigration } from '../../migrations/0081_agent_oauth_credentials.js';
import {
  AgentExecutionRepository,
  BrandRepository,
  EventRepository,
  OrganizationRepository,
  TenantRepository,
} from '../../repositories/index.js';

type DriverCase = { driver: 'postgres' | 'mysql' | 'mssql'; url: string };
let scopedEventId = 'event_test';
const requestedDriver = process.env.DB_INTEGRATION_DRIVER;
const driverCases: DriverCase[] = [
  { driver: 'postgres', url: process.env.DATABASE_URL ?? '' },
  { driver: 'mysql', url: process.env.DATABASE_URL_MYSQL ?? '' },
  { driver: 'mssql', url: process.env.DATABASE_URL_MSSQL ?? '' },
].filter(
  (candidate) =>
    candidate.url.length > 0 && (!requestedDriver || candidate.driver === requestedDriver),
) as DriverCase[];

if (driverCases.length === 0)
  it.skip('agent execution integration (database URLs are not configured)', () => {});

function approval(tenantId: string): AgentApproval {
  return {
    id: 'approval_test',
    tenantId,
    actionDigest: 'a'.repeat(64),
    approverPrincipalId: 'user_actor',
    approverPermissionSnapshot: ['events:write'],
    policyVersion: 7,
    approvedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
}

async function persistApproval(db: Database, value: AgentApproval): Promise<void> {
  await db
    .insertInto('agent_approvals')
    .values({
      id: value.id,
      tenant_id: value.tenantId,
      action_id: null,
      action_digest: value.actionDigest,
      plan_sha256: value.planSha256 ?? null,
      approver_principal_id: value.approverPrincipalId,
      approver_permission_snapshot: JSON.stringify(value.approverPermissionSnapshot),
      policy_version: value.policyVersion,
      approved_at: new Date(value.approvedAt),
      expires_at: new Date(value.expiresAt),
      revoked_at: value.revokedAt ? new Date(value.revokedAt) : null,
      consumed_at: value.consumedAt ? new Date(value.consumedAt) : null,
      consumed_execution_id: null,
    })
    .execute();
}

async function revokePersistedApproval(db: Database, tenantId: string, approvalId: string) {
  await db
    .updateTable('agent_approvals')
    .set({ revoked_at: new Date() })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', approvalId)
    .executeTakeFirstOrThrow();
}

function principal(tenantId: string): AgentPrincipal {
  return {
    id: 'agent_test',
    tenantId,
    kind: 'third_party',
    sponsorPrincipalId: 'user_actor',
    capabilities: ['events.execute'],
    maximumAutonomy: 'execute_with_approval',
    protocolVersion: AGENT_PROTOCOL_VERSION,
    state: 'active',
    registeredAt: new Date(Date.now() - 120_000).toISOString(),
  };
}

function delegation(tenantId: string): AgentDelegationGrant {
  return {
    id: 'delegation_test',
    tenantId,
    agentPrincipalId: 'agent_test',
    sponsorPrincipalId: 'user_actor',
    capabilities: ['events.execute'],
    resourceScopes: [`event:${scopedEventId}`],
    permissionSnapshot: ['events:write'],
    issuedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
}

function execution(tenantId: string, id = 'execution_test'): AgentExecution {
  const now = new Date().toISOString();
  return {
    id,
    tenantId,
    actionId: 'action_test',
    actionDigest: 'a'.repeat(64),
    agentPrincipalId: 'agent_test',
    sponsorPrincipalId: 'user_actor',
    delegationGrantId: 'delegation_test',
    approvalId: 'approval_test',
    idempotencyKey: 'agent-execution-test',
    requestFingerprint: 'b'.repeat(64),
    state: 'reserved',
    resourceVersion: 4,
    policyVersion: 7,
    fenceToken: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function audit(
  item: AgentExecution,
  id: string,
  phase: AgentAuditRecord['phase'],
): AgentAuditRecord {
  return {
    id,
    tenantId: item.tenantId,
    agentPrincipalId: item.agentPrincipalId,
    sponsorPrincipalId: item.sponsorPrincipalId,
    delegationGrantId: item.delegationGrantId,
    actionId: item.actionId,
    actionDigest: item.actionDigest,
    approvalId: item.approvalId,
    phase,
    idempotencyKey: item.idempotencyKey,
    resourceVersion: item.resourceVersion,
    occurredAt: new Date().toISOString(),
    reasonCodes: [],
  };
}

function controlAudit(id: string) {
  return {
    id,
    actorPrincipalId: 'user_actor',
    reasonCode: 'TEST_AUTHORIZATION',
    idempotencyKey: `agent-control-${id}-2026`,
  };
}

describe.sequential.each(driverCases)('agent execution persistence: $driver', ({ driver, url }) => {
  let db: Database;
  let tenantId: string;
  let organizationId: string;

  beforeAll(async () => {
    process.env.DB_DRIVER = driver;
    await runMigrations(url);
    db = createDb(url);
    await truncateAllData(db);
    tenantId = (await new TenantRepository(db).create({ name: `Agent ${driver}` })).id;
    const organization = await new OrganizationRepository(db).create({
      tenantId,
      name: `Agent ${driver} organization`,
      slug: `agent-${driver}-organization`,
    });
    organizationId = organization.id;
    const brand = await new BrandRepository(db).create({
      tenantId,
      organizationId: organization.id,
      name: `Agent ${driver} brand`,
      slug: `agent-${driver}-brand`,
    });
    scopedEventId = (
      await new EventRepository(db).create({
        tenantId,
        organizationId: organization.id,
        brandId: brand.id,
        slug: `agent-${driver}-event`,
        title: `Agent ${driver} event`,
        currency: 'USD',
        timezone: 'America/Chicago',
        startsAt: new Date('2027-01-01T18:00:00.000Z'),
      })
    ).id;
    const now = new Date();
    await db
      .insertInto('user_profiles')
      .values([
        {
          id: 'user_actor',
          tenant_id: tenantId,
          clerk_user_id: `clerk_agent_${driver}`,
          email: `agent-${driver}@example.test`,
          first_name: null,
          last_name: null,
          avatar_url: null,
          status: 'active' as const,
          last_seen_at: null,
          created_at: now,
          updated_at: now,
        },
        {
          id: 'user_other',
          tenant_id: tenantId,
          clerk_user_id: `clerk_agent_other_${driver}`,
          email: `agent-other-${driver}@example.test`,
          first_name: null,
          last_name: null,
          avatar_url: null,
          status: 'active' as const,
          last_seen_at: null,
          created_at: now,
          updated_at: now,
        },
      ])
      .execute();
    await db
      .insertInto('permission_grants')
      .values([
        ...['developers.write', 'events.read', 'events.write'].map((permission, index) => ({
          id: `pg_agent_control_${index}`,
          tenant_id: tenantId,
          principal_type: 'user' as const,
          principal_id: 'user_actor',
          permission,
          scope_type: 'tenant' as const,
          scope_id: null,
          created_at: now,
          updated_at: now,
        })),
        {
          id: 'pg_agent_control_other',
          tenant_id: tenantId,
          principal_type: 'user' as const,
          principal_id: 'user_other',
          permission: 'developers.write',
          scope_type: 'tenant' as const,
          scope_id: null,
          created_at: now,
          updated_at: now,
        },
      ])
      .execute();
    await db
      .insertInto('organization_members')
      .values({
        id: 'member_agent_control',
        tenant_id: tenantId,
        organization_id: organization.id,
        user_id: 'user_actor',
        role: 'owner',
        invited_at: now,
        accepted_at: now,
        created_at: now,
        updated_at: now,
      })
      .execute();
  });

  afterAll(async () => {
    await db?.destroy();
  });

  it('creates, replays, and revokes sponsor-bound agent OAuth credentials atomically', async () => {
    const repository = new AgentExecutionRepository(db);
    const agentPrincipal = { ...principal(tenantId), id: 'agent_oauth_test' };
    await repository.registerPrincipal(agentPrincipal, controlAudit('oauth_register'));
    const input = {
      tenantId,
      organizationId,
      agentPrincipalId: agentPrincipal.id,
      applicationId: `oapp_${'a'.repeat(27)}`,
      clientId: `tk_agent_${'a'.repeat(48)}`,
      name: 'Agent OAuth integration client',
      audit: controlAudit('oauth_create'),
    };

    const created = await repository.createAgentOAuthClient(input);
    expect(created).toMatchObject({
      id: input.applicationId,
      agentPrincipalId: agentPrincipal.id,
      organizationId,
      scope: 'agent.invoke',
      status: 'active',
    });
    expect(created.clientSecret).toMatch(/^tk_agent_secret_/u);
    const stored = await db
      .selectFrom('oauth_applications')
      .selectAll()
      .where('id', '=', input.applicationId)
      .executeTakeFirstOrThrow();
    expect(stored.client_secret_hash).not.toBe(created.clientSecret);
    expect(stored).toMatchObject({
      tenant_id: tenantId,
      subject_type: 'agent',
      agent_principal_id: agentPrincipal.id,
    });
    expect(typeof stored.scopes === 'string' ? JSON.parse(stored.scopes) : stored.scopes).toEqual([
      'agent.invoke',
    ]);
    expect(
      typeof stored.redirect_uris === 'string'
        ? JSON.parse(stored.redirect_uris)
        : stored.redirect_uris,
    ).toEqual([]);

    const replay = await repository.createAgentOAuthClient(input);
    expect(replay).not.toHaveProperty('clientSecret');
    expect(replay.clientId).toBe(created.clientId);
    const createAudit = await db
      .selectFrom('agent_control_events')
      .select(['target_type', 'target_id', 'operation', 'outcome'])
      .where('tenant_id', '=', tenantId)
      .where('idempotency_key', '=', input.audit.idempotencyKey)
      .executeTakeFirstOrThrow();
    expect(createAudit).toEqual({
      target_type: 'oauth_client',
      target_id: input.applicationId,
      operation: 'register',
      outcome: 'applied',
    });

    const tokenNow = new Date();
    await db
      .insertInto('oauth_access_tokens')
      .values({
        id: 'oat_agent_revoke_test',
        oauth_application_id: input.applicationId,
        refresh_token_id: null,
        tenant_id: tenantId,
        organization_id: organizationId,
        token_hash: 'a'.repeat(64),
        scopes: '["agent.invoke"]',
        subject_type: 'agent',
        subject_id: agentPrincipal.id,
        expires_at: new Date(tokenNow.getTime() + 600_000),
        revoked_at: null,
        created_at: tokenNow,
        updated_at: tokenNow,
      })
      .execute();
    await expect(
      repository.revokeAgentOAuthClient({
        tenantId,
        agentPrincipalId: agentPrincipal.id,
        applicationId: input.applicationId,
        audit: controlAudit('oauth_revoke'),
      }),
    ).resolves.toBe(true);
    const revokedToken = await db
      .selectFrom('oauth_access_tokens')
      .select('revoked_at')
      .where('id', '=', 'oat_agent_revoke_test')
      .executeTakeFirstOrThrow();
    expect(revokedToken.revoked_at).not.toBeNull();

    await expect(AgentOAuthCredentialsMigration.down!(db)).rejects.toThrow(
      'AGENT_OAUTH_CREDENTIALS_ROLLBACK_UNSAFE',
    );
    await db.deleteFrom('oauth_access_tokens').where('id', '=', 'oat_agent_revoke_test').execute();
    await db.deleteFrom('oauth_applications').where('id', '=', input.applicationId).execute();
    await AgentOAuthCredentialsMigration.down!(db);
    const legacyNow = new Date();
    await db
      .insertInto('oauth_applications')
      .values({
        id: 'oapp_legacy_backfill',
        tenant_id: tenantId,
        organization_id: organizationId,
        name: 'Legacy OAuth app',
        client_id: `legacy_backfill_${driver}`,
        client_secret_hash: 'b'.repeat(64),
        redirect_uris: '[]',
        scopes: '["events.read"]',
        status: 'active',
        created_at: legacyNow,
        updated_at: legacyNow,
      } as never)
      .execute();
    await db
      .insertInto('oauth_access_tokens')
      .values({
        id: 'oat_legacy_backfill',
        oauth_application_id: 'oapp_legacy_backfill',
        refresh_token_id: null,
        tenant_id: tenantId,
        organization_id: organizationId,
        token_hash: 'c'.repeat(64),
        scopes: '["events.read"]',
        expires_at: new Date(legacyNow.getTime() + 600_000),
        revoked_at: null,
        created_at: legacyNow,
        updated_at: legacyNow,
      } as never)
      .execute();
    await AgentOAuthCredentialsMigration.up!(db);
    await expect(
      db
        .selectFrom('oauth_applications')
        .select(['subject_type', 'agent_principal_id'])
        .where('id', '=', 'oapp_legacy_backfill')
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ subject_type: 'resource_owner', agent_principal_id: null });
    await expect(
      db
        .selectFrom('oauth_access_tokens')
        .select(['id', 'subject_type', 'subject_id'])
        .where('id', '=', 'oat_legacy_backfill')
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      id: 'oat_legacy_backfill',
      subject_type: 'resource_owner',
      subject_id: 'oat_legacy_backfill',
    });
    await db.deleteFrom('oauth_access_tokens').where('id', '=', 'oat_legacy_backfill').execute();
    await db.deleteFrom('oauth_applications').where('id', '=', 'oapp_legacy_backfill').execute();
  });

  it('atomically consumes one approval and converges concurrent idempotent reservations', async () => {
    const repository = new AgentExecutionRepository(db);
    const approved = approval(tenantId);
    const sharedPreparationKey = 'shared-agent-preparation-key-2026';
    const reserved = {
      ...execution(tenantId),
      idempotencyKey: agentExecutionIdempotencyKey({
        agentPrincipalId: 'agent_test',
        idempotencyKey: sharedPreparationKey,
      }),
    };
    const registeredPrincipal = principal(tenantId);
    const grantedDelegation = delegation(tenantId);
    const persistedPrincipal = await repository.registerPrincipal(
      registeredPrincipal,
      controlAudit('register_test'),
    );
    const persistedDelegation = await repository.grantDelegation(
      grantedDelegation,
      controlAudit('grant_test'),
    );
    expect(persistedPrincipal.registeredAt).not.toBe(registeredPrincipal.registeredAt);
    expect(persistedDelegation.issuedAt).not.toBe(grantedDelegation.issuedAt);
    expect(persistedDelegation.permissionSnapshot).toEqual(['events:publish', 'events:write']);
    await expect(repository.getDelegation(tenantId, grantedDelegation.id)).resolves.toEqual(
      persistedDelegation,
    );
    await expect(
      repository.registerPrincipal(registeredPrincipal, controlAudit('register_test')),
    ).resolves.toEqual(persistedPrincipal);
    await expect(
      repository.registerPrincipal(registeredPrincipal, controlAudit('register_duplicate_ref')),
    ).rejects.toThrow('AGENT_CONTROL_REFERENCE_CONFLICT');
    await expect(
      repository.grantDelegation(grantedDelegation, controlAudit('grant_test')),
    ).resolves.toEqual(persistedDelegation);
    await expect(
      repository.grantDelegation(grantedDelegation, controlAudit('grant_duplicate_ref')),
    ).rejects.toThrow('AGENT_CONTROL_REFERENCE_CONFLICT');
    await expect(
      repository.grantDelegation(
        {
          ...delegation(tenantId),
          id: 'delegation_excessive_ttl',
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000 + 5_000).toISOString(),
        },
        controlAudit('grant_excessive_ttl'),
      ),
    ).rejects.toThrow('AGENT_DELEGATION_EXPIRY_INVALID');
    await expect(
      repository.grantDelegation(
        {
          ...delegation(tenantId),
          id: 'delegation_foreign_scope',
          resourceScopes: ['event:event_from_another_tenant'],
        },
        controlAudit('grant_foreign_scope'),
      ),
    ).rejects.toThrow('AGENT_DELEGATION_SCOPE_DENIED');
    await db
      .updateTable('organization_members')
      .set({ accepted_at: null })
      .where('id', '=', 'member_agent_control')
      .execute();
    await expect(
      repository.grantDelegation(
        { ...delegation(tenantId), id: 'delegation_without_membership' },
        controlAudit('grant_without_membership'),
      ),
    ).rejects.toThrow('AGENT_DELEGATION_SCOPE_DENIED');
    await db
      .updateTable('organization_members')
      .set({ accepted_at: new Date() })
      .where('id', '=', 'member_agent_control')
      .execute();
    await db
      .updateTable('permission_grants')
      .set({ permission: 'reports.read' })
      .where('id', '=', 'pg_agent_control_2')
      .execute();
    await expect(
      repository.grantDelegation(
        { ...delegation(tenantId), id: 'delegation_without_live_permission' },
        controlAudit('grant_without_live_permission'),
      ),
    ).rejects.toThrow('AGENT_CONTROL_SPONSOR_PERMISSION_DENIED');
    await db
      .updateTable('permission_grants')
      .set({ permission: 'events.write' })
      .where('id', '=', 'pg_agent_control_2')
      .execute();
    await expect(
      repository.registerPrincipal(
        { ...principal(tenantId), id: 'agent_wrong_sponsor', sponsorPrincipalId: 'user_other' },
        controlAudit('register_wrong_sponsor'),
      ),
    ).rejects.toThrow('AGENT_CONTROL_SPONSOR_MISMATCH');
    await expect(
      repository.registerPrincipal(
        { ...principal(tenantId), id: 'agent_substitution' },
        controlAudit('register_test'),
      ),
    ).rejects.toThrow('AGENT_CONTROL_IDEMPOTENCY_CONFLICT');
    await expect(
      repository.registerPrincipal(
        { ...principal(tenantId), id: 'agent_denied' },
        { ...controlAudit('register_denied'), actorPrincipalId: 'user_missing' },
      ),
    ).rejects.toThrow('AGENT_CONTROL_ACTOR_DENIED');
    await db
      .updateTable('permission_grants')
      .set({ permission: 'reports.read' })
      .where('id', '=', 'pg_agent_control_0')
      .execute();
    await expect(
      repository.registerPrincipal(
        { ...principal(tenantId), id: 'agent_permission_denied' },
        controlAudit('register_permission_denied'),
      ),
    ).rejects.toThrow('AGENT_CONTROL_ACTOR_DENIED');
    await expect(
      repository.registerPrincipal(registeredPrincipal, controlAudit('register_test')),
    ).rejects.toThrow('AGENT_CONTROL_ACTOR_DENIED');
    await expect(
      repository.grantDelegation(grantedDelegation, controlAudit('grant_test')),
    ).rejects.toThrow('AGENT_CONTROL_ACTOR_DENIED');
    await db
      .updateTable('permission_grants')
      .set({ permission: 'developers.write' })
      .where('id', '=', 'pg_agent_control_0')
      .execute();
    const concurrentPrincipal = { ...principal(tenantId), id: 'agent_concurrent' };
    await expect(
      Promise.all(
        Array.from({ length: 8 }, () =>
          repository.registerPrincipal(concurrentPrincipal, controlAudit('register_concurrent')),
        ),
      ),
    ).resolves.toHaveLength(8);
    const concurrentDelegation = {
      ...delegation(tenantId),
      id: 'delegation_concurrent',
      agentPrincipalId: concurrentPrincipal.id,
    };
    await expect(
      Promise.all(
        Array.from({ length: 8 }, () =>
          repository.grantDelegation(concurrentDelegation, controlAudit('grant_concurrent')),
        ),
      ),
    ).resolves.toHaveLength(8);
    const substitutions = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) =>
        repository.registerPrincipal(
          { ...principal(tenantId), id: index % 2 === 0 ? 'agent_race_a' : 'agent_race_b' },
          controlAudit('register_race_substitution'),
        ),
      ),
    );
    expect(substitutions.filter(({ status }) => status === 'fulfilled')).toHaveLength(4);
    expect(substitutions.filter(({ status }) => status === 'rejected')).toHaveLength(4);
    await expect(
      repository.grantDelegation(
        { ...delegation(tenantId), id: 'delegation_excess', capabilities: ['refunds.execute'] },
        controlAudit('grant_excess'),
      ),
    ).rejects.toThrow('AGENT_DELEGATION_CAPABILITY_UNSUPPORTED');
    expect(
      await db
        .selectFrom('agent_control_events')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .execute(),
    ).toHaveLength(5);
    await persistApproval(db, approved);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        repository.reserveAndConsume({
          execution: { ...reserved, id: `execution_${index}` },
          approval: approved,
          requiredApproverPermission: 'events:write',
          now: new Date().toISOString(),
          audit: [
            audit(reserved, `prepared_${index}`, 'prepared'),
            audit(reserved, `authorized_${index}`, 'authorized'),
          ],
        }),
      ),
    );
    const executionIds = new Set(results.map((result) => result.execution.id));
    expect(executionIds.size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    const substitutedApproval = { ...approved, id: 'approval_substitution' };
    const substitutedExecution = {
      ...reserved,
      id: 'execution_substitution',
      approvalId: substitutedApproval.id,
    };
    await persistApproval(db, substitutedApproval);
    await expect(
      repository.reserveAndConsume({
        execution: substitutedExecution,
        approval: substitutedApproval,
        requiredApproverPermission: 'events:write',
        now: new Date().toISOString(),
        audit: [
          audit(substitutedExecution, 'prepared_substitution', 'prepared'),
          audit(substitutedExecution, 'authorized_substitution', 'authorized'),
        ],
      }),
    ).rejects.toThrow('AGENT_EXECUTION_IDEMPOTENCY_CONFLICT');
    expect(
      await db
        .selectFrom('agent_approvals')
        .select('consumed_at')
        .where('tenant_id', '=', tenantId)
        .where('id', '=', substitutedApproval.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ consumed_at: null });
    const secondAgentApproval = { ...approved, id: 'approval_second_agent' };
    const secondAgentExecution = {
      ...reserved,
      id: 'execution_second_agent',
      agentPrincipalId: concurrentPrincipal.id,
      delegationGrantId: concurrentDelegation.id,
      approvalId: secondAgentApproval.id,
      idempotencyKey: agentExecutionIdempotencyKey({
        agentPrincipalId: concurrentPrincipal.id,
        idempotencyKey: sharedPreparationKey,
      }),
      requestFingerprint: 'c'.repeat(64),
    };
    expect(secondAgentExecution.idempotencyKey).not.toBe(reserved.idempotencyKey);
    await persistApproval(db, secondAgentApproval);
    await expect(
      repository.reserveAndConsume({
        execution: secondAgentExecution,
        approval: secondAgentApproval,
        requiredApproverPermission: 'events:write',
        now: new Date().toISOString(),
        audit: [
          audit(secondAgentExecution, 'prepared_second_agent', 'prepared'),
          audit(secondAgentExecution, 'authorized_second_agent', 'authorized'),
        ],
      }),
    ).resolves.toMatchObject({
      created: true,
      execution: { id: secondAgentExecution.id, agentPrincipalId: concurrentPrincipal.id },
    });
    const storedApproval = await db
      .selectFrom('agent_approvals')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('id', '=', approved.id)
      .executeTakeFirstOrThrow();
    const executionId = [...executionIds][0]!;
    expect(storedApproval.consumed_execution_id).toBe(executionId);
    expect(
      await db
        .selectFrom('agent_audit_events')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .execute(),
    ).toHaveLength(2);
  });

  it('enforces tenant scope, live leases, increasing fences, and exact completion ownership', async () => {
    const repository = new AgentExecutionRepository(db);
    const persisted = await db
      .selectFrom('agent_executions')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('approval_id', '=', 'approval_test')
      .executeTakeFirstOrThrow();
    const claimAuthority = await db
      .selectFrom('agent_executions as execution')
      .innerJoin('agent_principals as principal', (join) =>
        join
          .onRef('principal.tenant_id', '=', 'execution.tenant_id')
          .onRef('principal.id', '=', 'execution.agent_principal_id'),
      )
      .innerJoin('agent_delegations as delegation', (join) =>
        join
          .onRef('delegation.tenant_id', '=', 'execution.tenant_id')
          .onRef('delegation.id', '=', 'execution.delegation_grant_id'),
      )
      .innerJoin('agent_approvals as approval', (join) =>
        join
          .onRef('approval.tenant_id', '=', 'execution.tenant_id')
          .onRef('approval.id', '=', 'execution.approval_id'),
      )
      .select([
        'principal.state as principal_state',
        'principal.sponsor_principal_id as principal_sponsor_id',
        'delegation.agent_principal_id as delegation_principal_id',
        'delegation.sponsor_principal_id as delegation_sponsor_id',
        'delegation.revoked_at as delegation_revoked_at',
        'delegation.issued_at as delegation_issued_at',
        'delegation.expires_at as delegation_expires_at',
        'approval.revoked_at as approval_revoked_at',
        'approval.consumed_execution_id as approval_execution_id',
      ])
      .where('execution.tenant_id', '=', tenantId)
      .where('execution.id', '=', persisted.id)
      .executeTakeFirstOrThrow();
    expect(claimAuthority).toMatchObject({
      principal_state: 'active',
      principal_sponsor_id: 'user_actor',
      delegation_principal_id: 'agent_test',
      delegation_sponsor_id: 'user_actor',
      delegation_revoked_at: null,
      approval_revoked_at: null,
      approval_execution_id: persisted.id,
    });
    expect(new Date(claimAuthority.delegation_issued_at).getTime()).toBeLessThanOrEqual(Date.now());
    expect(new Date(claimAuthority.delegation_expires_at).getTime()).toBeGreaterThan(Date.now());
    const source = execution(tenantId, persisted.id);
    const claimed = await repository.claim({
      tenantId,
      executionId: persisted.id,
      workerId: 'worker_one',
      audit: audit(source, 'started_test', 'started'),
    });
    expect(claimed).toMatchObject({ state: 'running', fenceToken: 1, leaseOwner: 'worker_one' });
    await expect(
      repository.claim({
        tenantId,
        executionId: persisted.id,
        workerId: 'worker_two',
        audit: audit(source, 'started_other', 'started'),
      }),
    ).resolves.toBeNull();
    await expect(
      repository.claim({
        tenantId: 'tenant_missing',
        executionId: 'execution_0',
        workerId: 'worker_one',
        audit: audit(source, 'started_wrong_tenant', 'started'),
      }),
    ).resolves.toBeNull();
    const completed = {
      ...claimed!,
      state: 'succeeded' as const,
      result: { eventId: 'event_test' },
    };
    await expect(
      repository.complete({
        execution: completed,
        expectedRevision: { fenceToken: 0, leaseOwner: 'worker_one' },
        audit: audit(completed, 'succeeded_stale', 'succeeded'),
      }),
    ).resolves.toBe(false);
    await expect(
      repository.complete({
        execution: completed,
        expectedRevision: { fenceToken: 1, leaseOwner: 'worker_one' },
        audit: audit(completed, 'succeeded_test', 'succeeded'),
      }),
    ).resolves.toBe(true);
    const stored = await db
      .selectFrom('agent_executions')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('id', '=', persisted.id)
      .executeTakeFirstOrThrow();
    expect(stored).toMatchObject({
      state: 'succeeded',
      lease_owner: null,
      result: JSON.stringify({ eventId: 'event_test' }),
    });
    expect(
      await db
        .selectFrom('agent_audit_events')
        .select('phase')
        .where('tenant_id', '=', tenantId)
        .where('execution_id', '=', persisted.id)
        .execute(),
    ).toHaveLength(4);
    await expect(
      db
        .updateTable('agent_audit_events')
        .set({ phase: 'failed' })
        .where('id', '=', 'succeeded_test')
        .execute(),
    ).rejects.toThrow(/immutable/u);
    await expect(
      db.deleteFrom('agent_audit_events').where('id', '=', 'succeeded_test').execute(),
    ).rejects.toThrow(/immutable/u);
  });

  it('returns contract-valid evidence only after exact scope and rejects corrupt or excessive state', async () => {
    const repository = new AgentExecutionRepository(db);
    const exactPrincipal = {
      ...principal(tenantId),
      id: `agt_${'a'.repeat(48)}`,
    };
    const exactDelegation = {
      ...delegation(tenantId),
      id: `dlg_${'b'.repeat(48)}`,
      agentPrincipalId: exactPrincipal.id,
    };
    await repository.registerPrincipal(exactPrincipal, controlAudit('register_evidence'));
    await repository.grantDelegation(exactDelegation, controlAudit('grant_evidence'));
    const exactApproval = {
      ...approval(tenantId),
      id: `apr_${'c'.repeat(48)}`,
      actionDigest: 'd'.repeat(64),
    };
    await persistApproval(db, exactApproval);
    const exactExecution: AgentExecution = {
      ...execution(tenantId, `exec_${'e'.repeat(48)}`),
      actionId: `act_${'f'.repeat(48)}`,
      actionDigest: exactApproval.actionDigest,
      agentPrincipalId: exactPrincipal.id,
      delegationGrantId: exactDelegation.id,
      approvalId: exactApproval.id,
      idempotencyKey: '1'.repeat(64),
      requestFingerprint: '2'.repeat(64),
    };
    await repository.reserveAndConsume({
      execution: exactExecution,
      approval: exactApproval,
      requiredApproverPermission: 'events:write',
      now: new Date().toISOString(),
      audit: [
        audit(exactExecution, `aaud_${'1'.repeat(48)}`, 'prepared'),
        audit(exactExecution, `aaud_${'2'.repeat(48)}`, 'authorized'),
      ],
    });
    const claimed = await repository.claim({
      tenantId,
      executionId: exactExecution.id,
      workerId: 'worker_evidence',
      audit: audit(exactExecution, `aaud_${'3'.repeat(48)}`, 'started'),
    });
    expect(claimed).toBeTruthy();
    const completed = {
      ...claimed!,
      state: 'succeeded' as const,
      result: { resourceId: scopedEventId, resourceVersion: 5, status: 'published' as const },
    };
    await expect(
      repository.complete({
        execution: completed,
        expectedRevision: {
          fenceToken: claimed!.fenceToken,
          leaseOwner: claimed!.leaseOwner!,
        },
        audit: audit(completed, `aaud_${'4'.repeat(48)}`, 'succeeded'),
      }),
    ).resolves.toBe(true);

    const agentScope = {
      tenantId,
      executionId: exactExecution.id,
      actionId: exactExecution.actionId,
      agentPrincipalId: exactPrincipal.id,
    };
    await expect(repository.getExecutionEvidence(agentScope)).resolves.toMatchObject({
      execution: { id: exactExecution.id, state: 'succeeded' },
      audit: [
        { phase: 'prepared' },
        { phase: 'authorized' },
        { phase: 'started' },
        { phase: 'succeeded' },
      ],
    });
    await expect(
      repository.getExecutionEvidence({
        tenantId,
        executionId: exactExecution.id,
        actionId: exactExecution.actionId,
        sponsorPrincipalId: 'user_actor',
      }),
    ).resolves.toBeTruthy();
    await expect(
      repository.getExecutionEvidence({
        ...agentScope,
        agentPrincipalId: `agt_${'9'.repeat(48)}`,
      }),
    ).resolves.toBeUndefined();
    await expect(
      repository.getExecutionEvidence({
        ...agentScope,
        actionId: `act_${'9'.repeat(48)}`,
      }),
    ).resolves.toBeUndefined();

    const raceApproval = {
      ...approval(tenantId),
      id: `apr_${'5'.repeat(48)}`,
      actionDigest: '6'.repeat(64),
    };
    await persistApproval(db, raceApproval);
    const raceExecution: AgentExecution = {
      ...exactExecution,
      id: `exec_${'7'.repeat(48)}`,
      actionId: `act_${'8'.repeat(48)}`,
      actionDigest: raceApproval.actionDigest,
      approvalId: raceApproval.id,
      idempotencyKey: '3'.repeat(64),
      requestFingerprint: '4'.repeat(64),
      state: 'reserved',
      fenceToken: 0,
      result: undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await repository.reserveAndConsume({
      execution: raceExecution,
      approval: raceApproval,
      requiredApproverPermission: 'events:write',
      now: new Date().toISOString(),
      audit: [
        audit(raceExecution, `aaud_${'5'.repeat(48)}`, 'prepared'),
        audit(raceExecution, `aaud_${'6'.repeat(48)}`, 'authorized'),
      ],
    });
    const raceScope = {
      tenantId,
      executionId: raceExecution.id,
      actionId: raceExecution.actionId,
      agentPrincipalId: exactPrincipal.id,
    };
    let inspectionSettled = false;
    let inspection:
      | Promise<Awaited<ReturnType<typeof repository.getExecutionEvidence>>>
      | undefined;
    await db.transaction().execute(async (tx) => {
      await tx
        .selectFrom('agent_executions')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .where('id', '=', raceExecution.id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      inspection = repository.getExecutionEvidence(raceScope).finally(() => {
        inspectionSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(inspectionSettled).toBe(false);
      const now = new Date();
      await tx
        .updateTable('agent_executions')
        .set({
          state: 'running',
          fence_token: 1,
          lease_owner: 'worker_evidence_race',
          lease_expires_at: new Date(now.getTime() + 300_000),
          updated_at: now,
        })
        .where('tenant_id', '=', tenantId)
        .where('id', '=', raceExecution.id)
        .executeTakeFirstOrThrow();
      await tx
        .insertInto('agent_audit_events')
        .values({
          id: `aaud_${'7'.repeat(48)}`,
          tenant_id: tenantId,
          execution_id: raceExecution.id,
          agent_principal_id: raceExecution.agentPrincipalId,
          sponsor_principal_id: raceExecution.sponsorPrincipalId,
          delegation_grant_id: raceExecution.delegationGrantId,
          action_id: raceExecution.actionId,
          action_digest: raceExecution.actionDigest,
          plan_sha256: null,
          approval_id: raceExecution.approvalId,
          phase: 'started',
          idempotency_key: raceExecution.idempotencyKey,
          resource_version: raceExecution.resourceVersion,
          occurred_at: now,
          reason_codes: '[]',
          immutable: true,
        })
        .execute();
    });
    await expect(inspection!).resolves.toMatchObject({
      execution: { id: raceExecution.id, state: 'running', fenceToken: 1 },
      audit: [{ phase: 'prepared' }, { phase: 'authorized' }, { phase: 'started' }],
    });
    await db
      .updateTable('agent_executions')
      .set({
        state: 'reserved',
        fence_token: 0,
        lease_owner: null,
        lease_expires_at: null,
        updated_at: new Date(),
      })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', raceExecution.id)
      .execute();
    await expect(repository.getExecutionEvidence(raceScope)).rejects.toThrow(
      'AGENT_AUDIT_SEQUENCE_INVALID',
    );

    await db
      .updateTable('agent_executions')
      .set({ state: 'unexpected' })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', exactExecution.id)
      .execute();
    await expect(repository.getExecutionEvidence(agentScope)).rejects.toThrow(
      'AGENT_EXECUTION_EVIDENCE_INVALID',
    );
    await expect(
      repository.getExecutionEvidence({
        ...agentScope,
        agentPrincipalId: `agt_${'9'.repeat(48)}`,
      }),
    ).resolves.toBeUndefined();
    await db
      .updateTable('agent_executions')
      .set({ state: 'succeeded', result: null })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', exactExecution.id)
      .execute();
    await expect(repository.getExecutionEvidence(agentScope)).rejects.toThrow(
      'AGENT_EXECUTION_STATE_INVALID',
    );
    await db
      .updateTable('agent_executions')
      .set({
        state: 'succeeded',
        result: JSON.stringify({ ...completed.result, internalSecret: 'must-not-escape' }),
      })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', exactExecution.id)
      .execute();
    await expect(repository.getExecutionEvidence(agentScope)).rejects.toThrow(
      'AGENT_EXECUTION_RESULT_INVALID',
    );
    await db
      .updateTable('agent_executions')
      .set({ state: 'compensated', result: null, failure_code: 'BAD_COMPENSATION' })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', exactExecution.id)
      .execute();
    await expect(repository.getExecutionEvidence(agentScope)).rejects.toThrow(
      'AGENT_EXECUTION_STATE_INVALID',
    );
    await db
      .updateTable('agent_executions')
      .set({
        state: 'succeeded',
        result: JSON.stringify(completed.result),
        failure_code: null,
      })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', exactExecution.id)
      .execute();

    const extraAudit = Array.from({ length: 97 }, (_, index) => ({
      id: `aaud_${(index + 10).toString(16).padStart(48, '0')}`,
      tenant_id: tenantId,
      execution_id: exactExecution.id,
      agent_principal_id: exactExecution.agentPrincipalId,
      sponsor_principal_id: exactExecution.sponsorPrincipalId,
      delegation_grant_id: exactExecution.delegationGrantId,
      action_id: exactExecution.actionId,
      action_digest: exactExecution.actionDigest,
      plan_sha256: null,
      approval_id: exactExecution.approvalId,
      phase: 'started',
      idempotency_key: exactExecution.idempotencyKey,
      resource_version: exactExecution.resourceVersion,
      occurred_at: new Date(completed.updatedAt),
      reason_codes: '[]',
      immutable: true,
    }));
    await db.insertInto('agent_audit_events').values(extraAudit).execute();
    await expect(repository.getExecutionEvidence(agentScope)).rejects.toThrow(
      'AGENT_AUDIT_LIMIT_EXCEEDED',
    );
    await expect(
      repository.getExecutionEvidence({
        ...agentScope,
        agentPrincipalId: `agt_${'9'.repeat(48)}`,
      }),
    ).resolves.toBeUndefined();
  });

  it('blocks claims after approval and delegation revocation', async () => {
    const repository = new AgentExecutionRepository(db);
    const revokedApproval = { ...approval(tenantId), id: 'approval_revoked' };
    const approvalExecution = {
      ...execution(tenantId, 'execution_approval_revoked'),
      approvalId: revokedApproval.id,
      idempotencyKey: 'agent-execution-approval-revoked',
    };
    await persistApproval(db, revokedApproval);
    await repository.reserveAndConsume({
      execution: approvalExecution,
      approval: revokedApproval,
      requiredApproverPermission: 'events:write',
      now: new Date().toISOString(),
      audit: [
        audit(approvalExecution, 'prepared_approval_revoked', 'prepared'),
        audit(approvalExecution, 'authorized_approval_revoked', 'authorized'),
      ],
    });
    await revokePersistedApproval(db, tenantId, revokedApproval.id);
    await expect(
      repository.claim({
        tenantId,
        executionId: approvalExecution.id,
        workerId: 'worker_approval_revoked',
        audit: audit(approvalExecution, 'started_approval_revoked', 'started'),
      }),
    ).resolves.toBeNull();

    const revokedDelegation = { ...delegation(tenantId), id: 'delegation_revoked' };
    await repository.grantDelegation(revokedDelegation, controlAudit('grant_revocable'));
    const delegationApproval = { ...approval(tenantId), id: 'approval_delegation_revoked' };
    const delegationExecution = {
      ...execution(tenantId, 'execution_delegation_revoked'),
      delegationGrantId: revokedDelegation.id,
      approvalId: delegationApproval.id,
      idempotencyKey: 'agent-execution-delegation-revoked',
    };
    await persistApproval(db, delegationApproval);
    await repository.reserveAndConsume({
      execution: delegationExecution,
      approval: delegationApproval,
      requiredApproverPermission: 'events:write',
      now: new Date().toISOString(),
      audit: [
        audit(delegationExecution, 'prepared_delegation_revoked', 'prepared'),
        audit(delegationExecution, 'authorized_delegation_revoked', 'authorized'),
      ],
    });
    await expect(
      Promise.all(
        Array.from({ length: 8 }, () =>
          repository.revokeDelegation({
            tenantId,
            delegationId: revokedDelegation.id,
            audit: controlAudit('revoke_delegation'),
          }),
        ),
      ),
    ).resolves.toEqual(Array(8).fill(true));
    await expect(
      repository.claim({
        tenantId,
        executionId: delegationExecution.id,
        workerId: 'worker_delegation_revoked',
        audit: audit(delegationExecution, 'started_delegation_revoked', 'started'),
      }),
    ).resolves.toBeNull();
  });

  it('revokes principals and all delegations atomically before execution claim', async () => {
    const repository = new AgentExecutionRepository(db);
    await expect(
      repository.revokeDelegation({
        tenantId,
        delegationId: 'delegation_test',
        audit: {
          ...controlAudit('revoke_delegation_wrong_sponsor'),
          actorPrincipalId: 'user_other',
        },
      }),
    ).rejects.toThrow('AGENT_CONTROL_SPONSOR_MISMATCH');
    const secondApproval = { ...approval(tenantId), id: 'approval_revocation' };
    const secondExecution = {
      ...execution(tenantId, 'execution_revocation'),
      approvalId: secondApproval.id,
      idempotencyKey: 'agent-execution-revocation',
    };
    await persistApproval(db, secondApproval);
    await repository.reserveAndConsume({
      execution: secondExecution,
      approval: secondApproval,
      requiredApproverPermission: 'events:write',
      now: new Date().toISOString(),
      audit: [
        audit(secondExecution, 'prepared_revocation', 'prepared'),
        audit(secondExecution, 'authorized_revocation', 'authorized'),
      ],
    });
    await expect(
      Promise.all(
        Array.from({ length: 8 }, () =>
          repository.revokePrincipal({
            tenantId,
            principalId: 'agent_test',
            audit: controlAudit('revoke_test'),
          }),
        ),
      ),
    ).resolves.toEqual(Array(8).fill(true));
    await expect(
      repository.claim({
        tenantId,
        executionId: secondExecution.id,
        workerId: 'worker_revoked',
        audit: audit(secondExecution, 'started_revoked', 'started'),
      }),
    ).resolves.toBeNull();
    expect((await repository.getPrincipal(tenantId, 'agent_test'))?.state).toBe('revoked');
    const storedDelegation = await db
      .selectFrom('agent_delegations')
      .select('revoked_at')
      .where('tenant_id', '=', tenantId)
      .where('id', '=', 'delegation_test')
      .executeTakeFirstOrThrow();
    expect(storedDelegation.revoked_at).not.toBeNull();
    expect(
      await db
        .selectFrom('agent_audit_events')
        .select('id')
        .where('execution_id', '=', secondExecution.id)
        .execute(),
    ).toHaveLength(2);
    const controlEvents = await db
      .selectFrom('agent_control_events')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .execute();
    expect(controlEvents).toHaveLength(9);
    expect(controlEvents.find(({ id }) => id === 'revoke_test')).toMatchObject({
      actor_principal_id: 'user_actor',
      operation: 'revoke',
      target_id: 'agent_test',
      reason_code: 'TEST_AUTHORIZATION',
    });
    await expect(
      db
        .updateTable('agent_control_events')
        .set({ reason_code: 'TAMPERED' })
        .where('id', '=', 'revoke_test')
        .execute(),
    ).rejects.toThrow(/immutable/u);
    await expect(
      db.deleteFrom('agent_control_events').where('id', '=', 'revoke_test').execute(),
    ).rejects.toThrow(/immutable/u);
  });
});
