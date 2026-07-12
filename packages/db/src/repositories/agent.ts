import type {
  AgentApproval,
  AgentAction,
  AgentActionResult,
  AgentAuditRecord,
  AgentDelegationGrant,
  AgentExecution,
  AgentExecutionStore,
  AgentPrincipal,
} from '@tixkit/agent-protocol';
import { agentActionDigest, agentSha256, validateAgentActionResult,
  validateAgentActionResultForAction, validateAgentDelegation,
  validateAgentPrincipal } from '@tixkit/agent-protocol';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import type { DB } from '../types/db.js';

type Executor = Kysely<DB> | Transaction<DB>;
const LEASE_MILLISECONDS = 5 * 60 * 1000;
const CONTROL_TOKEN = /^[A-Z0-9_]{3,64}$/u;
const CONTROL_ID = /^[a-z0-9][a-z0-9_-]{1,62}$/u;

export interface AgentControlMutationAudit {
  id: string;
  actorPrincipalId: string;
  reasonCode: string;
  idempotencyKey: string;
}

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

function parseStrings(value: string, field: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string'))
    throw new Error(`invalid persisted ${field}`);
  return parsed;
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

async function appendControlEvent(db: Executor, input: AgentControlMutationAudit & {
  tenantId: string;
  targetType: 'principal' | 'delegation' | 'approval';
  targetId: string;
  operation: 'register' | 'grant' | 'revoke';
  previousState?: unknown;
  newState: unknown;
  occurredAt: Date;
  requestFingerprint: string;
  actorAuthorizationSha256: string;
  outcome: 'applied' | 'not_found';
}): Promise<void> {
  if (!CONTROL_ID.test(input.id) || !CONTROL_ID.test(input.actorPrincipalId) ||
    !CONTROL_TOKEN.test(input.reasonCode) || input.idempotencyKey.length < 16 ||
    input.idempotencyKey.length > 255)
    throw new Error('AGENT_CONTROL_AUDIT_INVALID');
  const normalize = (value: unknown): unknown => {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'bigint') return value.toString();
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object') return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, normalize(item)]),
    );
    return value;
  };
  await db.insertInto('agent_control_events').values({ id: input.id, tenant_id: input.tenantId,
    actor_principal_id: input.actorPrincipalId, target_type: input.targetType,
    target_id: input.targetId, operation: input.operation,
    previous_state_sha256: input.previousState === undefined ? null : agentSha256(normalize(input.previousState)),
    new_state_sha256: agentSha256(normalize(input.newState)), reason_code: input.reasonCode,
    idempotency_key: input.idempotencyKey, request_fingerprint: input.requestFingerprint,
    actor_authorization_sha256: input.actorAuthorizationSha256, outcome: input.outcome,
    occurred_at: input.occurredAt }).execute();
}

function controlFingerprint(audit: AgentControlMutationAudit, targetType: string, targetId: string,
  operation: string, requestedState: unknown): string {
  return agentSha256({ actorPrincipalId: audit.actorPrincipalId, reasonCode: audit.reasonCode,
    targetType, targetId, operation, requestedState });
}

async function controlReplay(db: Executor, tenantId: string, audit: AgentControlMutationAudit,
  fingerprint: string): Promise<'applied' | 'not_found' | undefined> {
  const row = await db.selectFrom('agent_control_events').selectAll()
    .where('tenant_id', '=', tenantId).where('idempotency_key', '=', audit.idempotencyKey)
    .forUpdate().executeTakeFirst();
  if (!row) return undefined;
  if (row.request_fingerprint !== fingerprint || row.actor_principal_id !== audit.actorPrincipalId)
    throw new Error('AGENT_CONTROL_IDEMPOTENCY_CONFLICT');
  return row.outcome as 'applied' | 'not_found';
}

async function lockControlTenant(db: Executor, tenantId: string): Promise<void> {
  const tenant = await db.selectFrom('tenants').select('id').where('id', '=', tenantId)
    .forUpdate().executeTakeFirst();
  if (!tenant) throw new Error('AGENT_CONTROL_TENANT_NOT_FOUND');
}

async function executeControlTransaction<T>(db: Kysely<DB>,
  operation: (tx: Transaction<DB>) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await db.transaction().execute(operation);
    } catch (error) {
      const databaseError = error as { code?: string; errno?: number;
        cause?: { code?: string; errno?: number } };
      const code = databaseError.code ?? databaseError.cause?.code;
      const errno = databaseError.errno ?? databaseError.cause?.errno;
      if (attempt === 4 || (code !== '40001' && code !== '40P01' &&
        code !== 'ER_LOCK_DEADLOCK' && errno !== 1213)) throw error;
    }
  }
  throw new Error('AGENT_CONTROL_TRANSACTION_RETRY_EXHAUSTED');
}

async function authorizeControlActor(db: Executor, tenantId: string,
  actorPrincipalId: string): Promise<string> {
  const actor = await db.selectFrom('user_profiles').select(['id', 'tenant_id', 'status', 'updated_at'])
    .where('tenant_id', '=', tenantId).where('id', '=', actorPrincipalId)
    .forUpdate().executeTakeFirst();
  const grant = await db.selectFrom('permission_grants').selectAll()
    .where('tenant_id', '=', tenantId).where('principal_type', '=', 'user')
    .where('principal_id', '=', actorPrincipalId).where('permission', '=', 'developers.write')
    .where('scope_type', '=', 'tenant').where('scope_id', 'is', null)
    .forUpdate().executeTakeFirst();
  if (!actor || actor.status !== 'active' || !grant) throw new Error('AGENT_CONTROL_ACTOR_DENIED');
  return agentSha256({ actorId: actor.id, tenantId: actor.tenant_id, status: actor.status,
    actorUpdatedAt: iso(actor.updated_at), grantId: grant.id, permission: grant.permission,
    scopeType: grant.scope_type, grantUpdatedAt: iso(grant.updated_at) });
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

  async registerPrincipal(principal: AgentPrincipal, audit: AgentControlMutationAudit): Promise<void> {
    validateAgentPrincipal(principal);
    const fingerprint = controlFingerprint(audit, 'principal', principal.id, 'register', principal);
    await executeControlTransaction(this.db, async (tx) => {
      await lockControlTenant(tx, principal.tenantId);
      if (await controlReplay(tx, principal.tenantId, audit, fingerprint)) return;
      const actorAuthorizationSha256 = await authorizeControlActor(tx, principal.tenantId,
        audit.actorPrincipalId);
      const now = await databaseNow(tx);
      await tx.insertInto('agent_principals').values({ id: principal.id,
      tenant_id: principal.tenantId, kind: principal.kind,
      sponsor_principal_id: principal.sponsorPrincipalId,
      capabilities: JSON.stringify(principal.capabilities),
      maximum_autonomy: principal.maximumAutonomy, protocol_version: principal.protocolVersion,
      state: principal.state, registered_at: new Date(principal.registeredAt),
      updated_at: new Date(principal.registeredAt) }).execute();
      await appendControlEvent(tx, { ...audit, tenantId: principal.tenantId,
        targetType: 'principal', targetId: principal.id, operation: 'register',
        newState: principal, occurredAt: now, requestFingerprint: fingerprint,
        actorAuthorizationSha256, outcome: 'applied' });
    });
  }

  async grantDelegation(delegation: AgentDelegationGrant,
    audit: AgentControlMutationAudit): Promise<void> {
    const fingerprint = controlFingerprint(audit, 'delegation', delegation.id, 'grant', delegation);
    await executeControlTransaction(this.db, async (tx) => {
      await lockControlTenant(tx, delegation.tenantId);
      if (await controlReplay(tx, delegation.tenantId, audit, fingerprint)) return;
      const actorAuthorizationSha256 = await authorizeControlActor(tx, delegation.tenantId,
        audit.actorPrincipalId);
      const principal = await tx.selectFrom('agent_principals').selectAll()
        .where('tenant_id', '=', delegation.tenantId).where('id', '=', delegation.agentPrincipalId)
        .forUpdate().executeTakeFirst();
      if (!principal || principal.state !== 'active' ||
        principal.sponsor_principal_id !== delegation.sponsorPrincipalId)
        throw new Error('AGENT_PRINCIPAL_INACTIVE');
      const persistedPrincipal = await this.getPrincipalFrom(tx, principal);
      validateAgentDelegation(delegation, persistedPrincipal);
      const now = await databaseNow(tx);
      await tx.insertInto('agent_delegations').values({ id: delegation.id,
        tenant_id: delegation.tenantId, agent_principal_id: delegation.agentPrincipalId,
        sponsor_principal_id: delegation.sponsorPrincipalId,
        capabilities: JSON.stringify(delegation.capabilities),
        resource_scopes: JSON.stringify(delegation.resourceScopes),
        permission_snapshot: JSON.stringify(delegation.permissionSnapshot),
        issued_at: new Date(delegation.issuedAt), expires_at: new Date(delegation.expiresAt),
        revoked_at: delegation.revokedAt ? new Date(delegation.revokedAt) : null,
        created_at: now }).execute();
      await appendControlEvent(tx, { ...audit, tenantId: delegation.tenantId,
        targetType: 'delegation', targetId: delegation.id, operation: 'grant',
        newState: delegation, occurredAt: now, requestFingerprint: fingerprint,
        actorAuthorizationSha256, outcome: 'applied' });
    });
  }

  async revokePrincipal(input: { tenantId: string; principalId: string;
    audit: AgentControlMutationAudit }): Promise<boolean> {
    const requested = { state: 'revoked' };
    const fingerprint = controlFingerprint(input.audit, 'principal', input.principalId,
      'revoke', requested);
    return executeControlTransaction(this.db, async (tx) => {
      await lockControlTenant(tx, input.tenantId);
      const replay = await controlReplay(tx, input.tenantId, input.audit, fingerprint);
      if (replay) return replay === 'applied';
      const actorAuthorizationSha256 = await authorizeControlActor(tx, input.tenantId,
        input.audit.actorPrincipalId);
      const now = await databaseNow(tx);
      const previous = await tx.selectFrom('agent_principals').selectAll()
        .where('tenant_id', '=', input.tenantId).where('id', '=', input.principalId)
        .forUpdate().executeTakeFirst();
      if (!previous || previous.state === 'revoked') {
        await appendControlEvent(tx, { ...input.audit, tenantId: input.tenantId,
          targetType: 'principal', targetId: input.principalId, operation: 'revoke',
          newState: requested, occurredAt: now, requestFingerprint: fingerprint,
          actorAuthorizationSha256, outcome: 'not_found' });
        return false;
      }
      const result = await tx.updateTable('agent_principals').set({ state: 'revoked', updated_at: now })
        .where('tenant_id', '=', input.tenantId).where('id', '=', input.principalId)
        .where('state', '!=', 'revoked').executeTakeFirst();
      if (Number(result.numUpdatedRows) !== 1) return false;
      await tx.updateTable('agent_delegations').set({ revoked_at: now })
        .where('tenant_id', '=', input.tenantId).where('agent_principal_id', '=', input.principalId)
        .where('revoked_at', 'is', null).execute();
      await appendControlEvent(tx, { ...input.audit, tenantId: input.tenantId,
        targetType: 'principal', targetId: input.principalId, operation: 'revoke',
        previousState: previous, newState: { ...previous, state: 'revoked', updated_at: now },
        occurredAt: now, requestFingerprint: fingerprint, actorAuthorizationSha256,
        outcome: 'applied' });
      return true;
    });
  }

  async revokeDelegation(input: { tenantId: string; delegationId: string;
    audit: AgentControlMutationAudit }): Promise<boolean> {
    const requested = { revoked: true };
    const fingerprint = controlFingerprint(input.audit, 'delegation', input.delegationId,
      'revoke', requested);
    return executeControlTransaction(this.db, async (tx) => {
      await lockControlTenant(tx, input.tenantId);
      const replay = await controlReplay(tx, input.tenantId, input.audit, fingerprint);
      if (replay) return replay === 'applied';
      const actorAuthorizationSha256 = await authorizeControlActor(tx, input.tenantId,
        input.audit.actorPrincipalId);
      const previous = await tx.selectFrom('agent_delegations').selectAll()
        .where('tenant_id', '=', input.tenantId).where('id', '=', input.delegationId)
        .forUpdate().executeTakeFirst();
      const now = await databaseNow(tx);
      if (!previous || previous.revoked_at) {
        await appendControlEvent(tx, { ...input.audit, tenantId: input.tenantId,
          targetType: 'delegation', targetId: input.delegationId, operation: 'revoke',
          newState: requested, occurredAt: now, requestFingerprint: fingerprint,
          actorAuthorizationSha256, outcome: 'not_found' });
        return false;
      }
      await tx.updateTable('agent_delegations').set({ revoked_at: now })
        .where('tenant_id', '=', input.tenantId).where('id', '=', input.delegationId).execute();
      await appendControlEvent(tx, { ...input.audit, tenantId: input.tenantId,
        targetType: 'delegation', targetId: input.delegationId, operation: 'revoke',
        previousState: previous, newState: { ...previous, revoked_at: now }, occurredAt: now,
        requestFingerprint: fingerprint, actorAuthorizationSha256, outcome: 'applied' });
      return true;
    });
  }

  async revokeApproval(input: { tenantId: string; approvalId: string;
    audit: AgentControlMutationAudit }): Promise<boolean> {
    const requested = { revoked: true };
    const fingerprint = controlFingerprint(input.audit, 'approval', input.approvalId,
      'revoke', requested);
    return executeControlTransaction(this.db, async (tx) => {
      await lockControlTenant(tx, input.tenantId);
      const replay = await controlReplay(tx, input.tenantId, input.audit, fingerprint);
      if (replay) return replay === 'applied';
      const actorAuthorizationSha256 = await authorizeControlActor(tx, input.tenantId,
        input.audit.actorPrincipalId);
      const previous = await tx.selectFrom('agent_approvals').selectAll()
        .where('tenant_id', '=', input.tenantId).where('id', '=', input.approvalId)
        .forUpdate().executeTakeFirst();
      const now = await databaseNow(tx);
      if (!previous || previous.revoked_at) {
        await appendControlEvent(tx, { ...input.audit, tenantId: input.tenantId,
          targetType: 'approval', targetId: input.approvalId, operation: 'revoke',
          newState: requested, occurredAt: now, requestFingerprint: fingerprint,
          actorAuthorizationSha256, outcome: 'not_found' });
        return false;
      }
      await tx.updateTable('agent_approvals').set({ revoked_at: now })
        .where('tenant_id', '=', input.tenantId).where('id', '=', input.approvalId).execute();
      await appendControlEvent(tx, { ...input.audit, tenantId: input.tenantId,
        targetType: 'approval', targetId: input.approvalId, operation: 'revoke',
        previousState: previous, newState: { ...previous, revoked_at: now }, occurredAt: now,
        requestFingerprint: fingerprint, actorAuthorizationSha256, outcome: 'applied' });
      return true;
    });
  }

  async getPrincipal(tenantId: string, principalId: string): Promise<AgentPrincipal | undefined> {
    const row = await this.db.selectFrom('agent_principals').selectAll()
      .where('tenant_id', '=', tenantId).where('id', '=', principalId).executeTakeFirst();
    if (!row) return undefined;
    return this.getPrincipalFrom(this.db, row);
  }

  private async getPrincipalFrom(_db: Executor,
    row: Selectable<DB['agent_principals']>): Promise<AgentPrincipal> {
    return { id: row.id, tenantId: row.tenant_id, kind: row.kind as AgentPrincipal['kind'],
      sponsorPrincipalId: row.sponsor_principal_id,
      capabilities: parseStrings(row.capabilities, 'principal capabilities') as AgentPrincipal['capabilities'],
      maximumAutonomy: row.maximum_autonomy as AgentPrincipal['maximumAutonomy'],
      protocolVersion: row.protocol_version as AgentPrincipal['protocolVersion'],
      state: row.state as AgentPrincipal['state'], registeredAt: iso(row.registered_at) };
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
      const committedEffect = await tx.selectFrom('agent_action_effects').selectAll()
        .where('tenant_id', '=', input.tenantId).where('execution_id', '=', row.id)
        .executeTakeFirst();
      if (committedEffect) {
        const result = JSON.parse(committedEffect.result) as AgentActionResult;
        validateAgentActionResult(result);
        if (committedEffect.action_digest !== row.action_digest ||
          committedEffect.idempotency_key !== row.idempotency_key ||
          Number(committedEffect.expected_policy_version) !== Number(row.policy_version) ||
          Number(committedEffect.expected_resource_version) !== Number(row.resource_version) ||
          Number(committedEffect.effect_fence_token) < 1 ||
          Number(committedEffect.effect_fence_token) > Number(row.fence_token) ||
          agentSha256(result) !== committedEffect.result_sha256)
          throw new Error('AGENT_EFFECT_BINDING_INVALID');
      }
      if (!committedEffect) {
        // Keep the same principal → delegation → approval lock order as revocation paths.
        const principal = await tx.selectFrom('agent_principals').selectAll()
          .where('tenant_id', '=', input.tenantId).where('id', '=', row.agent_principal_id)
          .forUpdate().executeTakeFirst();
        const delegation = await tx.selectFrom('agent_delegations').selectAll()
          .where('tenant_id', '=', input.tenantId).where('id', '=', row.delegation_grant_id)
          .forUpdate().executeTakeFirst();
        const approval = await tx.selectFrom('agent_approvals').selectAll()
          .where('tenant_id', '=', input.tenantId).where('id', '=', row.approval_id)
          .forUpdate().executeTakeFirst();
        if (!principal || principal.state !== 'active' || !delegation || delegation.revoked_at ||
          delegation.agent_principal_id !== row.agent_principal_id ||
          delegation.sponsor_principal_id !== row.sponsor_principal_id ||
          new Date(delegation.issued_at).getTime() > now.getTime() ||
          new Date(delegation.expires_at).getTime() <= now.getTime() ||
          !approval || approval.revoked_at || approval.consumed_execution_id !== row.id)
          return null;
      }
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

  async recoverEffect(input: { execution: AgentExecution;
    action: AgentAction }): Promise<AgentActionResult | undefined> {
    const row = await this.db.selectFrom('agent_action_effects').selectAll()
      .where('tenant_id', '=', input.execution.tenantId)
      .where('execution_id', '=', input.execution.id).executeTakeFirst();
    if (!row) return undefined;
    if (row.action_digest !== input.execution.actionDigest ||
      row.action_digest !== agentActionDigest(input.action) ||
      row.resource_type !== input.action.target.resourceType ||
      row.resource_id !== input.action.target.resourceId ||
      row.operation !== input.action.target.apiOperation ||
      row.idempotency_key !== input.execution.idempotencyKey ||
      Number(row.expected_policy_version) !== input.execution.policyVersion ||
      Number(row.expected_resource_version) !== input.execution.resourceVersion ||
      Number(row.effect_fence_token) < 1 ||
      Number(row.effect_fence_token) > input.execution.fenceToken)
      throw new Error('AGENT_EFFECT_BINDING_INVALID');
    const result = JSON.parse(row.result) as AgentActionResult;
    validateAgentActionResultForAction(input.action, result);
    if (agentSha256(result) !== row.result_sha256)
      throw new Error('AGENT_EFFECT_RESULT_INVALID');
    if (input.action.kind === 'event.publish') {
      const event = await this.db.selectFrom('events').select(['status', 'version'])
        .where('tenant_id', '=', input.execution.tenantId)
        .where('id', '=', input.action.target.resourceId).executeTakeFirst();
      if (!event || event.status !== 'published' || Number(event.version) !== result.resourceVersion)
        throw new Error('AGENT_EFFECT_RESOURCE_STATE_INVALID');
    }
    return result;
  }
}
