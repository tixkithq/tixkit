import type { AgentApproval, AgentAuditRecord, AgentExecution } from '@tixkit/agent-protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../../client.js';
import { runMigrations, truncateAllData } from '../../migrate.js';
import { AgentExecutionRepository, TenantRepository } from '../../repositories/index.js';

type DriverCase = { driver: 'postgres' | 'mysql'; url: string };
const requestedDriver = process.env.DB_INTEGRATION_DRIVER;
const driverCases: DriverCase[] = [
  { driver: 'postgres', url: process.env.DATABASE_URL ?? '' },
  { driver: 'mysql', url: process.env.DATABASE_URL_MYSQL ?? '' },
].filter((candidate) => candidate.url.length > 0 &&
  (!requestedDriver || candidate.driver === requestedDriver)) as DriverCase[];

if (driverCases.length === 0)
  it.skip('agent execution integration (database URLs are not configured)', () => {});

function approval(tenantId: string): AgentApproval {
  return { id: 'approval_test', tenantId, actionDigest: 'a'.repeat(64),
    approverPrincipalId: 'organizer_test', approverPermissionSnapshot: ['events:write'],
    policyVersion: 7, approvedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
}

function execution(tenantId: string, id = 'execution_test'): AgentExecution {
  const now = new Date().toISOString();
  return { id, tenantId, actionId: 'action_test', actionDigest: 'a'.repeat(64),
    agentPrincipalId: 'agent_test', sponsorPrincipalId: 'organizer_test',
    delegationGrantId: 'delegation_test', approvalId: 'approval_test',
    idempotencyKey: 'agent-execution-test', requestFingerprint: 'b'.repeat(64), state: 'reserved',
    resourceVersion: 4, policyVersion: 7, fenceToken: 0, createdAt: now, updatedAt: now };
}

function audit(item: AgentExecution, id: string, phase: AgentAuditRecord['phase']): AgentAuditRecord {
  return { id, tenantId: item.tenantId, agentPrincipalId: item.agentPrincipalId,
    sponsorPrincipalId: item.sponsorPrincipalId, delegationGrantId: item.delegationGrantId,
    actionId: item.actionId, actionDigest: item.actionDigest, approvalId: item.approvalId, phase,
    idempotencyKey: item.idempotencyKey, resourceVersion: item.resourceVersion,
    occurredAt: new Date().toISOString(), reasonCodes: [] };
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
  });

  afterAll(async () => { await db?.destroy(); });

  it('atomically consumes one approval and converges concurrent idempotent reservations', async () => {
    const repository = new AgentExecutionRepository(db);
    const approved = approval(tenantId);
    const reserved = execution(tenantId);
    await repository.recordApproval(approved);
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      repository.reserveAndConsume({ execution: { ...reserved, id: `execution_${index}` },
        approval: approved, requiredApproverPermission: 'events:write', now: new Date().toISOString(),
        audit: [audit(reserved, `prepared_${index}`, 'prepared'),
          audit(reserved, `authorized_${index}`, 'authorized')] })));
    const executionIds = new Set(results.map((result) => result.execution.id));
    expect(executionIds.size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    const storedApproval = await db.selectFrom('agent_approvals').selectAll()
      .where('tenant_id', '=', tenantId).where('id', '=', approved.id).executeTakeFirstOrThrow();
    const executionId = [...executionIds][0]!;
    expect(storedApproval.consumed_execution_id).toBe(executionId);
    expect(await db.selectFrom('agent_audit_events').select('id')
      .where('tenant_id', '=', tenantId).execute()).toHaveLength(2);
  });

  it('enforces tenant scope, live leases, increasing fences, and exact completion ownership', async () => {
    const repository = new AgentExecutionRepository(db);
    const persisted = await db.selectFrom('agent_executions').select('id')
      .where('tenant_id', '=', tenantId).executeTakeFirstOrThrow();
    const source = execution(tenantId, persisted.id);
    const claimed = await repository.claim({ tenantId, executionId: persisted.id,
      workerId: 'worker_one', audit: audit(source, 'started_test', 'started') });
    expect(claimed).toMatchObject({ state: 'running', fenceToken: 1, leaseOwner: 'worker_one' });
    await expect(repository.claim({ tenantId, executionId: persisted.id, workerId: 'worker_two',
      audit: audit(source, 'started_other', 'started') }))
      .resolves.toBeNull();
    await expect(repository.claim({ tenantId: 'tenant_missing', executionId: 'execution_0',
      workerId: 'worker_one', audit: audit(source, 'started_wrong_tenant', 'started') }))
      .resolves.toBeNull();
    const completed = { ...claimed!, state: 'succeeded' as const, result: { eventId: 'event_test' } };
    await expect(repository.complete({ execution: completed,
      expectedRevision: { fenceToken: 0, leaseOwner: 'worker_one' },
      audit: audit(completed, 'succeeded_stale', 'succeeded') })).resolves.toBe(false);
    await expect(repository.complete({ execution: completed,
      expectedRevision: { fenceToken: 1, leaseOwner: 'worker_one' },
      audit: audit(completed, 'succeeded_test', 'succeeded') })).resolves.toBe(true);
    const stored = await db.selectFrom('agent_executions').selectAll()
      .where('tenant_id', '=', tenantId).where('id', '=', persisted.id).executeTakeFirstOrThrow();
    expect(stored).toMatchObject({ state: 'succeeded', lease_owner: null,
      result: JSON.stringify({ eventId: 'event_test' }) });
    expect(await db.selectFrom('agent_audit_events').select('phase')
      .where('tenant_id', '=', tenantId).where('execution_id', '=', persisted.id).execute())
      .toHaveLength(4);
    await expect(db.updateTable('agent_audit_events').set({ phase: 'failed' })
      .where('id', '=', 'succeeded_test').execute()).rejects.toThrow(/immutable/u);
    await expect(db.deleteFrom('agent_audit_events').where('id', '=', 'succeeded_test').execute())
      .rejects.toThrow(/immutable/u);
  });
});
