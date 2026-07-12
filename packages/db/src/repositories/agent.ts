import type {
  AgentApproval,
  AgentAuditRecord,
  AgentExecution,
  AgentExecutionStore,
} from '@tixkit/agent-protocol';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import type { DB } from '../types/db.js';

type Executor = Kysely<DB> | Transaction<DB>;
const LEASE_MILLISECONDS = 5 * 60 * 1000;

function safeInteger(value: number | string | bigint, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`invalid ${field}`);
  return parsed;
}

function iso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('invalid persisted timestamp');
  return date.toISOString();
}

function parseObject(value: string | null): Readonly<Record<string, unknown>> | undefined {
  if (value === null) return undefined;
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('invalid persisted agent result');
  return parsed as Readonly<Record<string, unknown>>;
}

function toExecution(row: Selectable<DB['agent_executions']>): AgentExecution {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    actionId: row.action_id,
    actionDigest: row.action_digest,
    agentPrincipalId: row.agent_principal_id,
    sponsorPrincipalId: row.sponsor_principal_id,
    delegationGrantId: row.delegation_grant_id,
    approvalId: row.approval_id,
    idempotencyKey: row.idempotency_key,
    requestFingerprint: row.request_fingerprint,
    state: row.state as AgentExecution['state'],
    resourceVersion: safeInteger(row.resource_version, 'resource version'),
    policyVersion: safeInteger(row.policy_version, 'policy version'),
    fenceToken: safeInteger(row.fence_token, 'fence token'),
    ...(row.lease_owner === null ? {} : { leaseOwner: row.lease_owner }),
    ...(row.lease_expires_at === null ? {} : { leaseExpiresAt: iso(row.lease_expires_at) }),
    ...(row.result === null ? {} : { result: parseObject(row.result) }),
    ...(row.failure_code === null ? {} : { failureCode: row.failure_code }),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

async function databaseNow(db: Executor): Promise<Date> {
  const expression =
    process.env.DB_DRIVER === 'mysql'
      ? sql<Date>`current_timestamp(3)`
      : process.env.DB_DRIVER === 'mssql'
        ? sql<Date>`sysdatetime()`
        : sql<Date>`clock_timestamp()`;
  const result = await db.selectFrom('tenants').select(expression.as('now')).limit(1).executeTakeFirst();
  if (!result) throw new Error('database clock unavailable');
  return new Date(result.now);
}

async function appendAudit(
  db: Executor,
  executionId: string,
  record: AgentAuditRecord,
): Promise<void> {
  await db
    .insertInto('agent_audit_events')
    .values({
      id: record.id,
      tenant_id: record.tenantId,
      execution_id: executionId,
      agent_principal_id: record.agentPrincipalId,
      sponsor_principal_id: record.sponsorPrincipalId,
      delegation_grant_id: record.delegationGrantId,
      action_id: record.actionId,
      action_digest: record.actionDigest,
      plan_sha256: record.planSha256 ?? null,
      approval_id: record.approvalId ?? null,
      phase: record.phase,
      idempotency_key: record.idempotencyKey,
      resource_version: record.resourceVersion,
      occurred_at: new Date(record.occurredAt),
      reason_codes: JSON.stringify(record.reasonCodes),
      immutable: true,
    })
    .execute();
}

function assertAudit(
  execution: AgentExecution,
  record: AgentAuditRecord,
  allowedPhases: readonly AgentAuditRecord['phase'][],
): void {
  if (!allowedPhases.includes(record.phase) || record.tenantId !== execution.tenantId ||
    record.agentPrincipalId !== execution.agentPrincipalId ||
    record.sponsorPrincipalId !== execution.sponsorPrincipalId ||
    record.delegationGrantId !== execution.delegationGrantId ||
    record.actionId !== execution.actionId || record.actionDigest !== execution.actionDigest ||
    record.approvalId !== execution.approvalId ||
    record.idempotencyKey !== execution.idempotencyKey ||
    record.resourceVersion !== execution.resourceVersion)
    throw new Error('AGENT_AUDIT_IDENTITY_MISMATCH');
}

export class AgentExecutionRepository implements AgentExecutionStore {
  constructor(private readonly db: Kysely<DB>) {}

  async recordApproval(approval: AgentApproval): Promise<void> {
    await this.db
      .insertInto('agent_approvals')
      .values({
        id: approval.id,
        tenant_id: approval.tenantId,
        action_digest: approval.actionDigest,
        plan_sha256: approval.planSha256 ?? null,
        approver_principal_id: approval.approverPrincipalId,
        approver_permission_snapshot: JSON.stringify(approval.approverPermissionSnapshot),
        policy_version: approval.policyVersion,
        approved_at: new Date(approval.approvedAt),
        expires_at: new Date(approval.expiresAt),
        revoked_at: approval.revokedAt ? new Date(approval.revokedAt) : null,
        consumed_at: approval.consumedAt ? new Date(approval.consumedAt) : null,
        consumed_execution_id: null,
      })
      .execute();
  }

  async reserveAndConsume(input: {
    execution: AgentExecution;
    approval: AgentApproval;
    requiredApproverPermission: string;
    now: string;
    audit: readonly AgentAuditRecord[];
  }): Promise<{ created: boolean; execution: AgentExecution }> {
    return this.db.transaction().execute(async (tx) => {
      const approval = await tx
        .selectFrom('agent_approvals')
        .selectAll()
        .where('tenant_id', '=', input.execution.tenantId)
        .where('id', '=', input.approval.id)
        .forUpdate()
        .executeTakeFirst();
      if (!approval) throw new Error('AGENT_APPROVAL_INVALID');
      const existing = await tx
        .selectFrom('agent_executions')
        .selectAll()
        .where('tenant_id', '=', input.execution.tenantId)
        .where('idempotency_key', '=', input.execution.idempotencyKey)
        .executeTakeFirst();
      if (existing) return { created: false, execution: toExecution(existing) };

      const now = await databaseNow(tx);
      const permissions: unknown = JSON.parse(approval.approver_permission_snapshot);
      if (
        approval.action_digest !== input.execution.actionDigest ||
        safeInteger(approval.policy_version, 'approval policy version') !== input.execution.policyVersion ||
        !Array.isArray(permissions) ||
        !permissions.includes(input.requiredApproverPermission) ||
        approval.revoked_at !== null ||
        approval.consumed_at !== null ||
        new Date(approval.approved_at).getTime() > now.getTime() ||
        new Date(approval.expires_at).getTime() <= now.getTime()
      )
        throw new Error('AGENT_APPROVAL_INVALID');

      const consumed = await tx
        .updateTable('agent_approvals')
        .set({ consumed_at: now, consumed_execution_id: input.execution.id })
        .where('tenant_id', '=', input.execution.tenantId)
        .where('id', '=', approval.id)
        .where('consumed_at', 'is', null)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      if (Number(consumed.numUpdatedRows) !== 1) throw new Error('AGENT_APPROVAL_CONSUMED');

      await tx
        .insertInto('agent_executions')
        .values({
          id: input.execution.id,
          tenant_id: input.execution.tenantId,
          action_id: input.execution.actionId,
          action_digest: input.execution.actionDigest,
          agent_principal_id: input.execution.agentPrincipalId,
          sponsor_principal_id: input.execution.sponsorPrincipalId,
          delegation_grant_id: input.execution.delegationGrantId,
          approval_id: input.execution.approvalId,
          idempotency_key: input.execution.idempotencyKey,
          request_fingerprint: input.execution.requestFingerprint,
          state: input.execution.state,
          resource_version: input.execution.resourceVersion,
          policy_version: input.execution.policyVersion,
          fence_token: input.execution.fenceToken,
          lease_owner: null,
          lease_expires_at: null,
          result: null,
          failure_code: null,
          created_at: now,
          updated_at: now,
        })
        .execute();
      if (input.audit.length !== 2 ||
        new Set(input.audit.map(({ phase }) => phase)).size !== 2 ||
        !input.audit.some(({ phase }) => phase === 'prepared') ||
        !input.audit.some(({ phase }) => phase === 'authorized'))
        throw new Error('AGENT_AUDIT_PHASE_MISMATCH');
      for (const record of input.audit) {
        assertAudit(input.execution, record, ['prepared', 'authorized']);
        await appendAudit(tx, input.execution.id, { ...record, occurredAt: now.toISOString() });
      }
      const created = await tx
        .selectFrom('agent_executions')
        .selectAll()
        .where('tenant_id', '=', input.execution.tenantId)
        .where('id', '=', input.execution.id)
        .executeTakeFirstOrThrow();
      return { created: true, execution: toExecution(created) };
    });
  }

  async claim(input: {
    tenantId: string;
    executionId: string;
    workerId: string;
    audit: AgentAuditRecord;
  }): Promise<AgentExecution | null> {
    return this.db.transaction().execute(async (tx) => {
      const row = await tx.selectFrom('agent_executions').selectAll()
        .where('tenant_id', '=', input.tenantId).where('id', '=', input.executionId)
        .forUpdate().executeTakeFirst();
      if (!row || ['succeeded', 'compensated'].includes(row.state)) return row ? toExecution(row) : null;
      const now = await databaseNow(tx);
      if (row.state === 'running' && row.lease_expires_at &&
        new Date(row.lease_expires_at).getTime() > now.getTime())
        return null;
      const fenceToken = safeInteger(row.fence_token, 'fence token') + 1;
      const execution = toExecution(row);
      assertAudit(execution, input.audit, ['started']);
      const leaseExpiresAt = new Date(now.getTime() + LEASE_MILLISECONDS);
      await tx.updateTable('agent_executions').set({ state: 'running', fence_token: fenceToken,
        lease_owner: input.workerId, lease_expires_at: leaseExpiresAt, updated_at: now })
        .where('tenant_id', '=', input.tenantId).where('id', '=', input.executionId).execute();
      await appendAudit(tx, input.executionId, { ...input.audit, occurredAt: now.toISOString() });
      return toExecution({ ...row, state: 'running', fence_token: fenceToken,
        lease_owner: input.workerId, lease_expires_at: leaseExpiresAt, updated_at: now });
    });
  }

  async complete(input: {
    execution: AgentExecution;
    expectedRevision: { fenceToken: number; leaseOwner: string };
    audit: AgentAuditRecord;
  }): Promise<boolean> {
    return this.db.transaction().execute(async (tx) => {
      const row = await tx.selectFrom('agent_executions').selectAll()
        .where('tenant_id', '=', input.execution.tenantId).where('id', '=', input.execution.id)
        .forUpdate().executeTakeFirst();
      if (!row) return false;
      const now = await databaseNow(tx);
      const authoritative = toExecution(row);
      assertAudit(authoritative, input.audit, [input.execution.state === 'succeeded' ? 'succeeded' :
        input.execution.state === 'compensated' ? 'compensated' : 'failed']);
      if (row.state !== 'running' || row.lease_owner !== input.expectedRevision.leaseOwner ||
        safeInteger(row.fence_token, 'fence token') !== input.expectedRevision.fenceToken ||
        !row.lease_expires_at || new Date(row.lease_expires_at).getTime() <= now.getTime()) return false;
      await tx.updateTable('agent_executions').set({ state: input.execution.state,
        result: input.execution.result ? JSON.stringify(input.execution.result) : null,
        failure_code: input.execution.failureCode ?? null, lease_owner: null, lease_expires_at: null,
        updated_at: now }).where('tenant_id', '=', input.execution.tenantId)
        .where('id', '=', input.execution.id).where('state', '=', 'running')
        .where('fence_token', '=', input.expectedRevision.fenceToken)
        .where('lease_owner', '=', input.expectedRevision.leaseOwner).execute();
      await appendAudit(tx, input.execution.id, { ...input.audit, occurredAt: now.toISOString() });
      return true;
    });
  }
}
