import {
  AGENT_PROTOCOL_VERSION,
  type AgentApproval,
  type AgentAuditRecord,
  type AgentDelegationGrant,
  type AgentExecution,
  type AgentPrincipal,
} from '@tixkit/agent-protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../../client.js';
import { runMigrations, truncateAllData } from '../../migrate.js';
import { AgentExecutionRepository, TenantRepository } from '../../repositories/index.js';

type DriverCase = { driver: 'postgres' | 'mysql'; url: string };
const requestedDriver = process.env.DB_INTEGRATION_DRIVER;
const driverCases: DriverCase[] = [
  { driver: 'postgres', url: process.env.DATABASE_URL ?? '' },
  { driver: 'mysql', url: process.env.DATABASE_URL_MYSQL ?? '' },
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
    approverPrincipalId: 'organizer_test',
    approverPermissionSnapshot: ['events:write'],
    policyVersion: 7,
    approvedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
}

function principal(tenantId: string): AgentPrincipal {
  return {
    id: 'agent_test',
    tenantId,
    kind: 'third_party',
    sponsorPrincipalId: 'organizer_test',
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
    sponsorPrincipalId: 'organizer_test',
    capabilities: ['events.execute'],
    resourceScopes: ['event:event_test'],
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
    sponsorPrincipalId: 'organizer_test',
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

  beforeAll(async () => {
    process.env.DB_DRIVER = driver;
    await runMigrations(url);
    db = createDb(url);
    await truncateAllData(db);
    tenantId = (await new TenantRepository(db).create({ name: `Agent ${driver}` })).id;
    const now = new Date();
    await db
      .insertInto('user_profiles')
      .values({
        id: 'user_actor',
        tenant_id: tenantId,
        clerk_user_id: `clerk_agent_${driver}`,
        email: `agent-${driver}@example.test`,
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
        id: 'pg_agent_control',
        tenant_id: tenantId,
        principal_type: 'user',
        principal_id: 'user_actor',
        permission: 'developers.write',
        scope_type: 'tenant',
        scope_id: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
  });

  afterAll(async () => {
    await db?.destroy();
  });

  it('atomically consumes one approval and converges concurrent idempotent reservations', async () => {
    const repository = new AgentExecutionRepository(db);
    const approved = approval(tenantId);
    const reserved = execution(tenantId);
    const registeredPrincipal = principal(tenantId);
    const grantedDelegation = delegation(tenantId);
    await repository.registerPrincipal(registeredPrincipal, controlAudit('register_test'));
    await repository.grantDelegation(grantedDelegation, controlAudit('grant_test'));
    await expect(
      repository.registerPrincipal(registeredPrincipal, controlAudit('register_test')),
    ).resolves.toBeUndefined();
    await expect(
      repository.grantDelegation(grantedDelegation, controlAudit('grant_test')),
    ).resolves.toBeUndefined();
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
      .where('id', '=', 'pg_agent_control')
      .execute();
    await expect(
      repository.registerPrincipal(
        { ...principal(tenantId), id: 'agent_permission_denied' },
        controlAudit('register_permission_denied'),
      ),
    ).rejects.toThrow('AGENT_CONTROL_ACTOR_DENIED');
    await db
      .updateTable('permission_grants')
      .set({ permission: 'developers.write' })
      .where('id', '=', 'pg_agent_control')
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
    ).rejects.toThrow('agent delegation is invalid');
    expect(
      await db
        .selectFrom('agent_control_events')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .execute(),
    ).toHaveLength(5);
    await repository.recordApproval(approved);
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
      .executeTakeFirstOrThrow();
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

  it('blocks claims after approval and delegation revocation', async () => {
    const repository = new AgentExecutionRepository(db);
    const revokedApproval = { ...approval(tenantId), id: 'approval_revoked' };
    const approvalExecution = {
      ...execution(tenantId, 'execution_approval_revoked'),
      approvalId: revokedApproval.id,
      idempotencyKey: 'agent-execution-approval-revoked',
    };
    await repository.recordApproval(revokedApproval);
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
    await expect(
      Promise.all(
        Array.from({ length: 8 }, () =>
          repository.revokeApproval({
            tenantId,
            approvalId: revokedApproval.id,
            audit: controlAudit('revoke_approval'),
          }),
        ),
      ),
    ).resolves.toEqual(Array(8).fill(true));
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
    await repository.recordApproval(delegationApproval);
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
    const secondApproval = { ...approval(tenantId), id: 'approval_revocation' };
    const secondExecution = {
      ...execution(tenantId, 'execution_revocation'),
      approvalId: secondApproval.id,
      idempotencyKey: 'agent-execution-revocation',
    };
    await repository.recordApproval(secondApproval);
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
