import type {
  AgentApproval,
  AgentAction,
  AgentActionResult,
  AgentAuditRecord,
  AgentCapability,
  AgentDelegationGrant,
  AgentExecution,
  AgentExecutionAuditRecord,
  AgentExecutionEvidence,
  AgentExecutionStore,
  AgentPrincipal,
} from '@tixkit/agent-protocol';
import {
  agentActionDigest,
  agentSha256,
  validateAgentActionResult,
  validateAgentActionResultForAction,
  validateAgentDelegation,
  validateAgentPrincipal,
} from '@tixkit/agent-protocol';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import { createHash, randomBytes } from 'node:crypto';
import type { DB } from '../types/db.js';
import { executeAgentTransactionWithRetry } from './agent-transaction-retry.js';

type Executor = Kysely<DB> | Transaction<DB>;
const LEASE_MILLISECONDS = 5 * 60 * 1000;
const CONTROL_TOKEN = /^[A-Z0-9_]{3,64}$/u;
const CONTROL_ID = /^[a-z0-9][a-z0-9_-]{1,62}$/u;
const EXECUTION_ID = /^exec_[a-f0-9]{48}$/u;
const ACTION_ID = /^act_[a-f0-9]{48}$/u;
const AGENT_ID = /^agt_[a-f0-9]{48}$/u;
const DELEGATION_ID = /^dlg_[a-f0-9]{48}$/u;
const APPROVAL_ID = /^apr_[a-f0-9]{48}$/u;
const AUDIT_ID = /^aaud_[a-f0-9]{48}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const FAILURE_CODE = /^[A-Z0-9_]{3,64}$/u;
const MAX_DELEGATION_TTL_MILLISECONDS = 30 * 24 * 60 * 60 * 1000;
const MAX_EXECUTION_AUDIT_RECORDS = 100;

function delegationPermissionSnapshot(capabilities: readonly AgentCapability[]): string[] {
  const permissions = new Set<string>();
  for (const capability of capabilities) {
    if (capability === 'events.read' || capability === 'readiness.read')
      permissions.add('events:read');
    else if (capability === 'events.prepare') permissions.add('events:write');
    else if (capability === 'events.execute') {
      permissions.add('events:write');
      permissions.add('events:publish');
    } else throw new Error('AGENT_DELEGATION_CAPABILITY_UNSUPPORTED');
  }
  return [...permissions].sort();
}

async function assertDelegationAuthority(
  db: Executor,
  delegation: AgentDelegationGrant,
  now: Date,
): Promise<string[]> {
  const permissionSnapshot = delegationPermissionSnapshot(delegation.capabilities);
  const requiredProductPermissions = new Set(
    permissionSnapshot.map((permission) =>
      permission === 'events:read' ? 'events.read' : 'events.write',
    ),
  );
  const grants = await db
    .selectFrom('permission_grants')
    .select(['permission'])
    .where('tenant_id', '=', delegation.tenantId)
    .where('principal_type', '=', 'user')
    .where('principal_id', '=', delegation.sponsorPrincipalId)
    .where('permission', 'in', [...requiredProductPermissions])
    .where('scope_type', '=', 'tenant')
    .where('scope_id', 'is', null)
    .forUpdate()
    .execute();
  const granted = new Set(grants.map(({ permission }) => permission));
  if ([...requiredProductPermissions].some((permission) => !granted.has(permission)))
    throw new Error('AGENT_CONTROL_SPONSOR_PERMISSION_DENIED');

  const eventIds = delegation.resourceScopes.map((scope) => {
    if (!scope.startsWith('event:')) throw new Error('AGENT_DELEGATION_SCOPE_UNSUPPORTED');
    return scope.slice('event:'.length);
  });
  if (new Set(eventIds).size !== eventIds.length) throw new Error('AGENT_DELEGATION_SCOPE_INVALID');
  const events = await db
    .selectFrom('events')
    .select(['id', 'organization_id'])
    .where('tenant_id', '=', delegation.tenantId)
    .where('id', 'in', eventIds)
    .forUpdate()
    .execute();
  if (events.length !== eventIds.length) throw new Error('AGENT_DELEGATION_SCOPE_DENIED');
  const organizationIds = [...new Set(events.map(({ organization_id }) => organization_id))];
  const memberships = await db
    .selectFrom('organization_members')
    .select(['organization_id'])
    .where('tenant_id', '=', delegation.tenantId)
    .where('user_id', '=', delegation.sponsorPrincipalId)
    .where('organization_id', 'in', organizationIds)
    .where('accepted_at', 'is not', null)
    .forUpdate()
    .execute();
  const memberOrganizations = new Set(memberships.map(({ organization_id }) => organization_id));
  if (organizationIds.some((organizationId) => !memberOrganizations.has(organizationId)))
    throw new Error('AGENT_DELEGATION_SCOPE_DENIED');

  const expiresAt = new Date(delegation.expiresAt).getTime();
  if (
    !Number.isFinite(expiresAt) ||
    expiresAt <= now.getTime() ||
    expiresAt - now.getTime() > MAX_DELEGATION_TTL_MILLISECONDS
  )
    throw new Error('AGENT_DELEGATION_EXPIRY_INVALID');
  return permissionSnapshot;
}

export interface AgentControlMutationAudit {
  id: string;
  actorPrincipalId: string;
  reasonCode: string;
  idempotencyKey: string;
}

export interface AgentOAuthClient {
  id: string;
  tenantId: string;
  organizationId: string;
  agentPrincipalId: string;
  name: string;
  clientId: string;
  clientSecret?: string;
  scope: 'agent.invoke';
  status: 'active' | 'revoked';
  createdAt: string;
  updatedAt: string;
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
    ...(row.plan_sha256 === null ? {} : { planSha256: row.plan_sha256 }),
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

function assertExecutionEvidenceState(execution: AgentExecution): void {
  const createdAt = new Date(execution.createdAt).getTime();
  const updatedAt = new Date(execution.updatedAt).getTime();
  if (
    !EXECUTION_ID.test(execution.id) ||
    !ACTION_ID.test(execution.actionId) ||
    !SHA256.test(execution.actionDigest) ||
    (execution.planSha256 !== undefined && !SHA256.test(execution.planSha256)) ||
    !AGENT_ID.test(execution.agentPrincipalId) ||
    !DELEGATION_ID.test(execution.delegationGrantId) ||
    !APPROVAL_ID.test(execution.approvalId) ||
    !SHA256.test(execution.idempotencyKey) ||
    !SHA256.test(execution.requestFingerprint) ||
    !['reserved', 'running', 'succeeded', 'failed', 'compensated'].includes(execution.state) ||
    !Number.isSafeInteger(execution.resourceVersion) ||
    execution.resourceVersion < 0 ||
    !Number.isSafeInteger(execution.policyVersion) ||
    execution.policyVersion < 1 ||
    !Number.isSafeInteger(execution.fenceToken) ||
    execution.fenceToken < 0 ||
    !Number.isFinite(createdAt) ||
    !Number.isFinite(updatedAt) ||
    createdAt > updatedAt
  )
    throw new Error('AGENT_EXECUTION_EVIDENCE_INVALID');
  const hasLease = execution.leaseOwner !== undefined || execution.leaseExpiresAt !== undefined;
  const leaseIsValid =
    typeof execution.leaseOwner === 'string' &&
    CONTROL_ID.test(execution.leaseOwner) &&
    typeof execution.leaseExpiresAt === 'string' &&
    Number.isFinite(new Date(execution.leaseExpiresAt).getTime());
  if (execution.result !== undefined) {
    try {
      validateAgentActionResult(execution.result as AgentActionResult);
    } catch {
      throw new Error('AGENT_EXECUTION_RESULT_INVALID');
    }
  }
  if (
    (execution.state === 'reserved' &&
      (execution.fenceToken !== 0 || hasLease || execution.result || execution.failureCode)) ||
    (execution.state === 'running' &&
      (execution.fenceToken < 1 ||
        !leaseIsValid ||
        execution.result ||
        (execution.failureCode !== undefined &&
          execution.failureCode !== 'AGENT_EFFECT_RECOVERY'))) ||
    (execution.state === 'succeeded' &&
      (execution.fenceToken < 1 ||
        hasLease ||
        execution.failureCode ||
        !execution.result ||
        execution.result.status !== 'published')) ||
    (execution.state === 'failed' &&
      (execution.fenceToken < 1 ||
        hasLease ||
        execution.result ||
        typeof execution.failureCode !== 'string' ||
        !FAILURE_CODE.test(execution.failureCode))) ||
    (execution.state === 'compensated' &&
      (execution.fenceToken < 1 ||
        hasLease ||
        execution.result ||
        execution.failureCode !== 'AGENT_ACTION_COMPENSATED'))
  )
    throw new Error('AGENT_EXECUTION_STATE_INVALID');
}

const AGENT_AUDIT_PHASES = new Set<AgentAuditRecord['phase']>([
  'prepared',
  'authorized',
  'denied',
  'started',
  'succeeded',
  'failed',
  'compensated',
]);
const AGENT_AUDIT_PHASE_ORDER: Readonly<Record<AgentAuditRecord['phase'], number>> = {
  prepared: 0,
  authorized: 1,
  denied: 2,
  started: 3,
  succeeded: 4,
  failed: 4,
  compensated: 4,
};

function auditPhaseOrder(record: AgentAuditRecord): number {
  if (
    record.phase === 'started' &&
    record.reasonCodes.length === 1 &&
    record.reasonCodes[0] === 'effect_recovery'
  )
    return 5;
  if (record.phase === 'succeeded' || record.phase === 'compensated') return 6;
  return AGENT_AUDIT_PHASE_ORDER[record.phase];
}

function toAuditRecord(row: Selectable<DB['agent_audit_events']>): AgentAuditRecord {
  if (!AGENT_AUDIT_PHASES.has(row.phase as AgentAuditRecord['phase']))
    throw new Error('AGENT_AUDIT_PHASE_INVALID');
  if (row.immutable !== true && row.immutable !== 1)
    throw new Error('AGENT_AUDIT_MUTABILITY_INVALID');
  if (
    !AUDIT_ID.test(row.id) ||
    (row.plan_sha256 !== null && !SHA256.test(row.plan_sha256)) ||
    !Number.isFinite(new Date(row.occurred_at).getTime())
  )
    throw new Error('AGENT_AUDIT_EVIDENCE_INVALID');
  const reasonCodes = parseStrings(row.reason_codes, 'audit reason codes');
  if (
    reasonCodes.length > 16 ||
    new Set(reasonCodes).size !== reasonCodes.length ||
    reasonCodes.some((code) => !/^[a-z0-9_]{2,64}$/u.test(code))
  )
    throw new Error('AGENT_AUDIT_REASON_CODES_INVALID');
  return {
    id: row.id,
    tenantId: row.tenant_id,
    agentPrincipalId: row.agent_principal_id,
    sponsorPrincipalId: row.sponsor_principal_id,
    delegationGrantId: row.delegation_grant_id,
    actionId: row.action_id,
    actionDigest: row.action_digest,
    ...(row.plan_sha256 === null ? {} : { planSha256: row.plan_sha256 }),
    ...(row.approval_id === null ? {} : { approvalId: row.approval_id }),
    phase: row.phase as AgentAuditRecord['phase'],
    idempotencyKey: row.idempotency_key,
    resourceVersion: safeInteger(row.resource_version, 'audit resource version'),
    occurredAt: iso(row.occurred_at),
    reasonCodes,
  };
}

function toDelegation(row: Selectable<DB['agent_delegations']>): AgentDelegationGrant {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    agentPrincipalId: row.agent_principal_id,
    sponsorPrincipalId: row.sponsor_principal_id,
    capabilities: parseStrings(
      row.capabilities,
      'delegation capabilities',
    ) as AgentDelegationGrant['capabilities'],
    resourceScopes: parseStrings(row.resource_scopes, 'delegation resource scopes'),
    permissionSnapshot: parseStrings(row.permission_snapshot, 'delegation permission snapshot'),
    issuedAt: iso(row.issued_at),
    expiresAt: iso(row.expires_at),
    ...(row.revoked_at ? { revokedAt: iso(row.revoked_at) } : {}),
  };
}

async function databaseNow(db: Executor): Promise<Date> {
  const expression =
    process.env.DB_DRIVER === 'mysql'
      ? sql<Date>`current_timestamp`
      : process.env.DB_DRIVER === 'mssql'
        ? sql<Date>`sysdatetime()`
        : sql<Date>`clock_timestamp()`;
  const result = await db
    .selectFrom('tenants')
    .select(expression.as('now'))
    .limit(1)
    .executeTakeFirst();
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

async function appendControlEvent(
  db: Executor,
  input: AgentControlMutationAudit & {
    tenantId: string;
    targetType: 'principal' | 'delegation' | 'approval' | 'oauth_client';
    targetId: string;
    operation: 'register' | 'grant' | 'revoke';
    previousState?: unknown;
    newState: unknown;
    occurredAt: Date;
    requestFingerprint: string;
    actorAuthorizationSha256: string;
    outcome: 'applied' | 'not_found';
  },
): Promise<void> {
  if (
    !CONTROL_ID.test(input.id) ||
    !CONTROL_ID.test(input.actorPrincipalId) ||
    !CONTROL_TOKEN.test(input.reasonCode) ||
    input.idempotencyKey.length < 16 ||
    input.idempotencyKey.length > 255
  )
    throw new Error('AGENT_CONTROL_AUDIT_INVALID');
  const normalize = (value: unknown): unknown => {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'bigint') return value.toString();
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]));
    return value;
  };
  await db
    .insertInto('agent_control_events')
    .values({
      id: input.id,
      tenant_id: input.tenantId,
      actor_principal_id: input.actorPrincipalId,
      target_type: input.targetType,
      target_id: input.targetId,
      operation: input.operation,
      previous_state_sha256:
        input.previousState === undefined ? null : agentSha256(normalize(input.previousState)),
      new_state_sha256: agentSha256(normalize(input.newState)),
      reason_code: input.reasonCode,
      idempotency_key: input.idempotencyKey,
      request_fingerprint: input.requestFingerprint,
      actor_authorization_sha256: input.actorAuthorizationSha256,
      outcome: input.outcome,
      occurred_at: input.occurredAt,
    })
    .execute();
}

function controlFingerprint(
  audit: AgentControlMutationAudit,
  targetType: string,
  targetId: string,
  operation: string,
  requestedState: unknown,
): string {
  return agentSha256({
    actorPrincipalId: audit.actorPrincipalId,
    reasonCode: audit.reasonCode,
    targetType,
    targetId,
    operation,
    requestedState,
  });
}

async function controlReplay(
  db: Executor,
  tenantId: string,
  audit: AgentControlMutationAudit,
  fingerprint: string,
): Promise<'applied' | 'not_found' | undefined> {
  const row = await db
    .selectFrom('agent_control_events')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('idempotency_key', '=', audit.idempotencyKey)
    .forUpdate()
    .executeTakeFirst();
  if (!row) return undefined;
  if (row.request_fingerprint !== fingerprint || row.actor_principal_id !== audit.actorPrincipalId)
    throw new Error('AGENT_CONTROL_IDEMPOTENCY_CONFLICT');
  return row.outcome as 'applied' | 'not_found';
}

async function lockControlTenant(db: Executor, tenantId: string): Promise<void> {
  const tenant = await db
    .selectFrom('tenants')
    .select('id')
    .where('id', '=', tenantId)
    .forUpdate()
    .executeTakeFirst();
  if (!tenant) throw new Error('AGENT_CONTROL_TENANT_NOT_FOUND');
}

async function executeRetryableTransaction<T>(
  db: Kysely<DB>,
  operation: (tx: Transaction<DB>) => Promise<T>,
  exhaustedCode: string,
): Promise<T> {
  return executeAgentTransactionWithRetry(() => db.transaction().execute(operation), exhaustedCode);
}

async function executeControlTransaction<T>(
  db: Kysely<DB>,
  operation: (tx: Transaction<DB>) => Promise<T>,
): Promise<T> {
  return executeRetryableTransaction(db, operation, 'AGENT_CONTROL_TRANSACTION_RETRY_EXHAUSTED');
}

async function authorizeControlActor(
  db: Executor,
  tenantId: string,
  actorPrincipalId: string,
): Promise<string> {
  const actor = await db
    .selectFrom('user_profiles')
    .select(['id', 'tenant_id', 'status', 'updated_at'])
    .where('tenant_id', '=', tenantId)
    .where('id', '=', actorPrincipalId)
    .forUpdate()
    .executeTakeFirst();
  const grant = await db
    .selectFrom('permission_grants')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('principal_type', '=', 'user')
    .where('principal_id', '=', actorPrincipalId)
    .where('permission', '=', 'developers.write')
    .where('scope_type', '=', 'tenant')
    .where('scope_id', 'is', null)
    .forUpdate()
    .executeTakeFirst();
  if (!actor || actor.status !== 'active' || !grant) throw new Error('AGENT_CONTROL_ACTOR_DENIED');
  return agentSha256({
    actorId: actor.id,
    tenantId: actor.tenant_id,
    status: actor.status,
    actorUpdatedAt: iso(actor.updated_at),
    grantId: grant.id,
    permission: grant.permission,
    scopeType: grant.scope_type,
    grantUpdatedAt: iso(grant.updated_at),
  });
}

function assertAudit(
  execution: AgentExecution,
  record: AgentAuditRecord,
  allowedPhases: readonly AgentAuditRecord['phase'][],
): asserts record is AgentExecutionAuditRecord {
  if (
    !allowedPhases.includes(record.phase) ||
    record.tenantId !== execution.tenantId ||
    record.agentPrincipalId !== execution.agentPrincipalId ||
    record.sponsorPrincipalId !== execution.sponsorPrincipalId ||
    record.delegationGrantId !== execution.delegationGrantId ||
    record.actionId !== execution.actionId ||
    record.actionDigest !== execution.actionDigest ||
    record.planSha256 !== execution.planSha256 ||
    record.approvalId !== execution.approvalId ||
    record.idempotencyKey !== execution.idempotencyKey ||
    record.resourceVersion !== execution.resourceVersion
  )
    throw new Error('AGENT_AUDIT_IDENTITY_MISMATCH');
}

export class AgentExecutionRepository implements AgentExecutionStore {
  constructor(private readonly db: Kysely<DB>) {}

  async getExecution(tenantId: string, executionId: string): Promise<AgentExecution | undefined> {
    const row = await this.db
      .selectFrom('agent_executions')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('id', '=', executionId)
      .executeTakeFirst();
    return row ? toExecution(row) : undefined;
  }

  async getExecutionEvidence(
    input: {
      tenantId: string;
      executionId: string;
      actionId: string;
    } & (
      | { agentPrincipalId: string; sponsorPrincipalId?: never }
      | { sponsorPrincipalId: string; agentPrincipalId?: never }
    ),
  ): Promise<AgentExecutionEvidence | undefined> {
    return this.db.transaction().execute(async (tx) => {
      let query = tx
        .selectFrom('agent_executions')
        .selectAll()
        .where('tenant_id', '=', input.tenantId)
        .where('id', '=', input.executionId)
        .where('action_id', '=', input.actionId);
      query =
        'agentPrincipalId' in input && input.agentPrincipalId !== undefined
          ? query.where('agent_principal_id', '=', input.agentPrincipalId)
          : query.where('sponsor_principal_id', '=', input.sponsorPrincipalId!);
      const executionRow = await query.forUpdate().executeTakeFirst();
      if (!executionRow) return undefined;
      const execution = toExecution(executionRow);
      assertExecutionEvidenceState(execution);
      const rows = await tx
        .selectFrom('agent_audit_events')
        .selectAll()
        .where('tenant_id', '=', input.tenantId)
        .where('execution_id', '=', input.executionId)
        .orderBy('occurred_at', 'asc')
        .orderBy('id', 'asc')
        .limit(MAX_EXECUTION_AUDIT_RECORDS + 1)
        .execute();
      if (rows.length > MAX_EXECUTION_AUDIT_RECORDS) throw new Error('AGENT_AUDIT_LIMIT_EXCEEDED');
      const audit = rows
        .map(toAuditRecord)
        .sort((left, right) => {
          const timestamp = left.occurredAt.localeCompare(right.occurredAt);
          if (timestamp !== 0) return timestamp;
          const phase = auditPhaseOrder(left) - auditPhaseOrder(right);
          return phase === 0 ? left.id.localeCompare(right.id) : phase;
        })
        .map((record) => {
          assertAudit(execution, record, [...AGENT_AUDIT_PHASES]);
          return record;
        });
      const terminalPhases = audit.filter(({ phase }) =>
        ['denied', 'succeeded', 'failed', 'compensated'].includes(phase),
      );
      const expectedTerminalPhase = ['succeeded', 'failed', 'compensated'].includes(execution.state)
        ? execution.state
        : undefined;
      const lifecycleTail = audit.slice(2);
      const expectedStartedRecords = expectedTerminalPhase
        ? lifecycleTail.slice(0, -1)
        : lifecycleTail;
      const failedIndex = lifecycleTail.findIndex(({ phase }) => phase === 'failed');
      const recoveryPrefix = failedIndex < 0 ? [] : lifecycleTail.slice(0, failedIndex);
      const recoverySuffix = failedIndex < 0 ? [] : lifecycleTail.slice(failedIndex + 1);
      const recoveryInProgress = execution.state === 'running';
      const recoverySucceeded = execution.state === 'succeeded';
      const recoveryStarts = recoverySucceeded ? recoverySuffix.slice(0, -1) : recoverySuffix;
      const validRecoverySequence =
        failedIndex > 0 &&
        recoveryPrefix.every(({ phase }) => phase === 'started') &&
        recoverySuffix.length >= 1 + (recoverySucceeded ? 1 : 0) &&
        recoveryStarts.every(
          ({ phase, reasonCodes }) =>
            phase === 'started' && reasonCodes.length === 1 && reasonCodes[0] === 'effect_recovery',
        ) &&
        ((recoveryInProgress && recoverySuffix.every(({ phase }) => phase === 'started')) ||
          (recoverySucceeded && recoverySuffix.at(-1)?.phase === 'succeeded'));
      const normalLifecycleInvalid =
        expectedStartedRecords.some(({ phase }) => phase !== 'started') ||
        terminalPhases.length !== (expectedTerminalPhase ? 1 : 0) ||
        (expectedTerminalPhase !== undefined &&
          (terminalPhases[0]?.phase !== expectedTerminalPhase ||
            lifecycleTail.at(-1)?.phase !== expectedTerminalPhase));
      if (
        audit.filter(({ phase }) => phase === 'prepared').length !== 1 ||
        audit.filter(({ phase }) => phase === 'authorized').length !== 1 ||
        audit[0]?.phase !== 'prepared' ||
        audit[1]?.phase !== 'authorized' ||
        (execution.state === 'reserved' && audit.length !== 2) ||
        ((execution.state === 'running' ||
          execution.state === 'succeeded' ||
          execution.state === 'failed' ||
          execution.state === 'compensated') &&
          !audit.some(({ phase }) => phase === 'started')) ||
        (!validRecoverySequence && normalLifecycleInvalid) ||
        audit.some(({ occurredAt }) => {
          const timestamp = new Date(occurredAt).getTime();
          return (
            timestamp < new Date(execution.createdAt).getTime() ||
            timestamp > new Date(execution.updatedAt).getTime()
          );
        })
      )
        throw new Error('AGENT_AUDIT_SEQUENCE_INVALID');
      return { execution, audit };
    });
  }

  async assertControlActor(tenantId: string, actorPrincipalId: string): Promise<void> {
    await executeControlTransaction(this.db, async (tx) => {
      await lockControlTenant(tx, tenantId);
      await authorizeControlActor(tx, tenantId, actorPrincipalId);
    });
  }

  async createAgentOAuthClient(input: {
    tenantId: string;
    organizationId: string;
    agentPrincipalId: string;
    applicationId: string;
    clientId: string;
    name: string;
    audit: AgentControlMutationAudit;
  }): Promise<AgentOAuthClient> {
    const requested = {
      organizationId: input.organizationId,
      agentPrincipalId: input.agentPrincipalId,
      applicationId: input.applicationId,
      clientId: input.clientId,
      name: input.name,
      scope: 'agent.invoke',
    };
    const fingerprint = controlFingerprint(
      input.audit,
      'oauth_client',
      input.applicationId,
      'register',
      requested,
    );
    return executeControlTransaction(this.db, async (tx) => {
      await lockControlTenant(tx, input.tenantId);
      const actorAuthorizationSha256 = await authorizeControlActor(
        tx,
        input.tenantId,
        input.audit.actorPrincipalId,
      );
      const principal = await tx
        .selectFrom('agent_principals')
        .selectAll()
        .where('tenant_id', '=', input.tenantId)
        .where('id', '=', input.agentPrincipalId)
        .forUpdate()
        .executeTakeFirst();
      if (
        !principal ||
        principal.state !== 'active' ||
        principal.sponsor_principal_id !== input.audit.actorPrincipalId
      )
        throw new Error('AGENT_PRINCIPAL_INACTIVE');
      const membership = await tx
        .selectFrom('organization_members')
        .select('organization_id')
        .where('tenant_id', '=', input.tenantId)
        .where('organization_id', '=', input.organizationId)
        .where('user_id', '=', input.audit.actorPrincipalId)
        .where('accepted_at', 'is not', null)
        .forUpdate()
        .executeTakeFirst();
      if (!membership) throw new Error('AGENT_CONTROL_ORGANIZATION_DENIED');
      const now = await databaseNow(tx);
      if (await controlReplay(tx, input.tenantId, input.audit, fingerprint)) {
        const existing = await tx
          .selectFrom('oauth_applications')
          .selectAll()
          .where('tenant_id', '=', input.tenantId)
          .where('id', '=', input.applicationId)
          .where('subject_type', '=', 'agent')
          .executeTakeFirst();
        if (!existing || existing.agent_principal_id !== input.agentPrincipalId)
          throw new Error('AGENT_CONTROL_REPLAY_STATE_MISSING');
        return {
          id: existing.id,
          tenantId: existing.tenant_id,
          organizationId: existing.organization_id,
          agentPrincipalId: input.agentPrincipalId,
          name: existing.name,
          clientId: existing.client_id,
          scope: 'agent.invoke',
          status: existing.status as AgentOAuthClient['status'],
          createdAt: iso(existing.created_at),
          updatedAt: iso(existing.updated_at),
        };
      }
      const conflict = await tx
        .selectFrom('oauth_applications')
        .select('id')
        .where('id', '=', input.applicationId)
        .forUpdate()
        .executeTakeFirst();
      if (conflict) throw new Error('AGENT_CONTROL_REFERENCE_CONFLICT');
      const clientSecret = `tk_agent_secret_${randomBytes(32).toString('base64url')}`;
      await tx
        .insertInto('oauth_applications')
        .values({
          id: input.applicationId,
          tenant_id: input.tenantId,
          organization_id: input.organizationId,
          name: input.name,
          client_id: input.clientId,
          client_secret_hash: createHash('sha256').update(clientSecret).digest('hex'),
          redirect_uris: '[]',
          scopes: '["agent.invoke"]',
          subject_type: 'agent',
          agent_principal_id: input.agentPrincipalId,
          status: 'active',
          created_at: now,
          updated_at: now,
        })
        .execute();
      const result: AgentOAuthClient = {
        id: input.applicationId,
        tenantId: input.tenantId,
        organizationId: input.organizationId,
        agentPrincipalId: input.agentPrincipalId,
        name: input.name,
        clientId: input.clientId,
        clientSecret,
        scope: 'agent.invoke',
        status: 'active',
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
      const { clientSecret: _clientSecret, ...auditedResult } = result;
      await appendControlEvent(tx, {
        ...input.audit,
        tenantId: input.tenantId,
        targetType: 'oauth_client',
        targetId: input.applicationId,
        operation: 'register',
        newState: auditedResult,
        occurredAt: now,
        requestFingerprint: fingerprint,
        actorAuthorizationSha256,
        outcome: 'applied',
      });
      return result;
    });
  }

  async revokeAgentOAuthClient(input: {
    tenantId: string;
    agentPrincipalId: string;
    applicationId: string;
    audit: AgentControlMutationAudit;
  }): Promise<boolean> {
    const requested = { status: 'revoked' };
    const fingerprint = controlFingerprint(
      input.audit,
      'oauth_client',
      input.applicationId,
      'revoke',
      requested,
    );
    return executeControlTransaction(this.db, async (tx) => {
      await lockControlTenant(tx, input.tenantId);
      const actorAuthorizationSha256 = await authorizeControlActor(
        tx,
        input.tenantId,
        input.audit.actorPrincipalId,
      );
      const principal = await tx
        .selectFrom('agent_principals')
        .select(['sponsor_principal_id'])
        .where('tenant_id', '=', input.tenantId)
        .where('id', '=', input.agentPrincipalId)
        .forUpdate()
        .executeTakeFirst();
      if (!principal || principal.sponsor_principal_id !== input.audit.actorPrincipalId)
        throw new Error('AGENT_CONTROL_SPONSOR_MISMATCH');
      const application = await tx
        .selectFrom('oauth_applications')
        .selectAll()
        .where('tenant_id', '=', input.tenantId)
        .where('id', '=', input.applicationId)
        .where('subject_type', '=', 'agent')
        .where('agent_principal_id', '=', input.agentPrincipalId)
        .forUpdate()
        .executeTakeFirst();
      const replay = await controlReplay(tx, input.tenantId, input.audit, fingerprint);
      if (replay) return replay === 'applied';
      const now = await databaseNow(tx);
      if (!application || application.status === 'revoked') {
        await appendControlEvent(tx, {
          ...input.audit,
          tenantId: input.tenantId,
          targetType: 'oauth_client',
          targetId: input.applicationId,
          operation: 'revoke',
          newState: requested,
          occurredAt: now,
          requestFingerprint: fingerprint,
          actorAuthorizationSha256,
          outcome: 'not_found',
        });
        return false;
      }
      await tx
        .updateTable('oauth_applications')
        .set({ status: 'revoked', updated_at: now })
        .where('id', '=', application.id)
        .where('status', '=', 'active')
        .executeTakeFirst();
      await tx
        .updateTable('oauth_access_tokens')
        .set({ revoked_at: now, updated_at: now })
        .where('oauth_application_id', '=', application.id)
        .where('revoked_at', 'is', null)
        .execute();
      await appendControlEvent(tx, {
        ...input.audit,
        tenantId: input.tenantId,
        targetType: 'oauth_client',
        targetId: input.applicationId,
        operation: 'revoke',
        previousState: application,
        newState: { ...application, status: 'revoked', updated_at: now },
        occurredAt: now,
        requestFingerprint: fingerprint,
        actorAuthorizationSha256,
        outcome: 'applied',
      });
      return true;
    });
  }

  async registerPrincipal(
    principal: AgentPrincipal,
    audit: AgentControlMutationAudit,
  ): Promise<AgentPrincipal> {
    const { registeredAt: _registeredAt, ...requestedPrincipal } = principal;
    const fingerprint = controlFingerprint(
      audit,
      'principal',
      principal.id,
      'register',
      requestedPrincipal,
    );
    return executeControlTransaction(this.db, async (tx) => {
      await lockControlTenant(tx, principal.tenantId);
      const actorAuthorizationSha256 = await authorizeControlActor(
        tx,
        principal.tenantId,
        audit.actorPrincipalId,
      );
      if (principal.sponsorPrincipalId !== audit.actorPrincipalId)
        throw new Error('AGENT_CONTROL_SPONSOR_MISMATCH');
      const now = await databaseNow(tx);
      const persistedPrincipal: AgentPrincipal = {
        ...principal,
        registeredAt: now.toISOString(),
      };
      validateAgentPrincipal(persistedPrincipal);
      if (await controlReplay(tx, principal.tenantId, audit, fingerprint)) {
        const existing = await tx
          .selectFrom('agent_principals')
          .selectAll()
          .where('tenant_id', '=', principal.tenantId)
          .where('id', '=', principal.id)
          .executeTakeFirstOrThrow();
        return this.getPrincipalFrom(tx, existing);
      }
      const conflictingPrincipal = await tx
        .selectFrom('agent_principals')
        .select('id')
        .where('tenant_id', '=', principal.tenantId)
        .where('id', '=', principal.id)
        .forUpdate()
        .executeTakeFirst();
      if (conflictingPrincipal) throw new Error('AGENT_CONTROL_REFERENCE_CONFLICT');
      await tx
        .insertInto('agent_principals')
        .values({
          id: persistedPrincipal.id,
          tenant_id: persistedPrincipal.tenantId,
          kind: persistedPrincipal.kind,
          sponsor_principal_id: persistedPrincipal.sponsorPrincipalId,
          capabilities: JSON.stringify(persistedPrincipal.capabilities),
          maximum_autonomy: persistedPrincipal.maximumAutonomy,
          protocol_version: persistedPrincipal.protocolVersion,
          state: persistedPrincipal.state,
          registered_at: now,
          updated_at: now,
        })
        .execute();
      const insertedPrincipal = await tx
        .selectFrom('agent_principals')
        .selectAll()
        .where('tenant_id', '=', principal.tenantId)
        .where('id', '=', principal.id)
        .executeTakeFirstOrThrow();
      const canonicalPrincipal = await this.getPrincipalFrom(tx, insertedPrincipal);
      await appendControlEvent(tx, {
        ...audit,
        tenantId: principal.tenantId,
        targetType: 'principal',
        targetId: principal.id,
        operation: 'register',
        newState: canonicalPrincipal,
        occurredAt: now,
        requestFingerprint: fingerprint,
        actorAuthorizationSha256,
        outcome: 'applied',
      });
      return canonicalPrincipal;
    });
  }

  async grantDelegation(
    delegation: AgentDelegationGrant,
    audit: AgentControlMutationAudit,
  ): Promise<AgentDelegationGrant> {
    const {
      issuedAt: _issuedAt,
      revokedAt: _revokedAt,
      permissionSnapshot: _permissionSnapshot,
      ...requestedDelegation
    } = delegation;
    const fingerprint = controlFingerprint(
      audit,
      'delegation',
      delegation.id,
      'grant',
      requestedDelegation,
    );
    return executeControlTransaction(this.db, async (tx) => {
      await lockControlTenant(tx, delegation.tenantId);
      const actorAuthorizationSha256 = await authorizeControlActor(
        tx,
        delegation.tenantId,
        audit.actorPrincipalId,
      );
      if (delegation.sponsorPrincipalId !== audit.actorPrincipalId || delegation.revokedAt)
        throw new Error('AGENT_CONTROL_SPONSOR_MISMATCH');
      const principal = await tx
        .selectFrom('agent_principals')
        .selectAll()
        .where('tenant_id', '=', delegation.tenantId)
        .where('id', '=', delegation.agentPrincipalId)
        .forUpdate()
        .executeTakeFirst();
      if (
        !principal ||
        principal.state !== 'active' ||
        principal.sponsor_principal_id !== delegation.sponsorPrincipalId
      )
        throw new Error('AGENT_PRINCIPAL_INACTIVE');
      const persistedPrincipal = await this.getPrincipalFrom(tx, principal);
      const now = await databaseNow(tx);
      const permissionSnapshot = await assertDelegationAuthority(tx, delegation, now);
      const persistedDelegation: AgentDelegationGrant = {
        ...delegation,
        issuedAt: now.toISOString(),
        permissionSnapshot,
      };
      validateAgentDelegation(persistedDelegation, persistedPrincipal);
      if (await controlReplay(tx, delegation.tenantId, audit, fingerprint)) {
        const row = await tx
          .selectFrom('agent_delegations')
          .selectAll()
          .where('tenant_id', '=', delegation.tenantId)
          .where('id', '=', delegation.id)
          .executeTakeFirst();
        const existing = row ? toDelegation(row) : undefined;
        if (!existing) throw new Error('AGENT_CONTROL_REPLAY_STATE_MISSING');
        return existing;
      }
      const conflictingDelegation = await tx
        .selectFrom('agent_delegations')
        .select('id')
        .where('tenant_id', '=', delegation.tenantId)
        .where('id', '=', delegation.id)
        .forUpdate()
        .executeTakeFirst();
      if (conflictingDelegation) throw new Error('AGENT_CONTROL_REFERENCE_CONFLICT');
      await tx
        .insertInto('agent_delegations')
        .values({
          id: delegation.id,
          tenant_id: delegation.tenantId,
          agent_principal_id: delegation.agentPrincipalId,
          sponsor_principal_id: delegation.sponsorPrincipalId,
          capabilities: JSON.stringify(delegation.capabilities),
          resource_scopes: JSON.stringify(delegation.resourceScopes),
          permission_snapshot: JSON.stringify(permissionSnapshot),
          issued_at: now,
          expires_at: new Date(delegation.expiresAt),
          revoked_at: null,
          created_at: now,
        })
        .execute();
      const insertedDelegation = await tx
        .selectFrom('agent_delegations')
        .selectAll()
        .where('tenant_id', '=', delegation.tenantId)
        .where('id', '=', delegation.id)
        .executeTakeFirstOrThrow();
      const canonicalDelegation = toDelegation(insertedDelegation);
      await appendControlEvent(tx, {
        ...audit,
        tenantId: delegation.tenantId,
        targetType: 'delegation',
        targetId: delegation.id,
        operation: 'grant',
        newState: canonicalDelegation,
        occurredAt: now,
        requestFingerprint: fingerprint,
        actorAuthorizationSha256,
        outcome: 'applied',
      });
      return canonicalDelegation;
    });
  }

  async revokePrincipal(input: {
    tenantId: string;
    principalId: string;
    audit: AgentControlMutationAudit;
  }): Promise<boolean> {
    const requested = { state: 'revoked' };
    const fingerprint = controlFingerprint(
      input.audit,
      'principal',
      input.principalId,
      'revoke',
      requested,
    );
    return executeControlTransaction(this.db, async (tx) => {
      await lockControlTenant(tx, input.tenantId);
      const actorAuthorizationSha256 = await authorizeControlActor(
        tx,
        input.tenantId,
        input.audit.actorPrincipalId,
      );
      const now = await databaseNow(tx);
      const previous = await tx
        .selectFrom('agent_principals')
        .selectAll()
        .where('tenant_id', '=', input.tenantId)
        .where('id', '=', input.principalId)
        .forUpdate()
        .executeTakeFirst();
      if (previous && previous.sponsor_principal_id !== input.audit.actorPrincipalId)
        throw new Error('AGENT_CONTROL_SPONSOR_MISMATCH');
      const replay = await controlReplay(tx, input.tenantId, input.audit, fingerprint);
      if (replay) return replay === 'applied';
      if (!previous || previous.state === 'revoked') {
        await appendControlEvent(tx, {
          ...input.audit,
          tenantId: input.tenantId,
          targetType: 'principal',
          targetId: input.principalId,
          operation: 'revoke',
          newState: requested,
          occurredAt: now,
          requestFingerprint: fingerprint,
          actorAuthorizationSha256,
          outcome: 'not_found',
        });
        return false;
      }
      const result = await tx
        .updateTable('agent_principals')
        .set({ state: 'revoked', updated_at: now })
        .where('tenant_id', '=', input.tenantId)
        .where('id', '=', input.principalId)
        .where('state', '!=', 'revoked')
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) !== 1) return false;
      await tx
        .updateTable('agent_delegations')
        .set({ revoked_at: now })
        .where('tenant_id', '=', input.tenantId)
        .where('agent_principal_id', '=', input.principalId)
        .where('revoked_at', 'is', null)
        .execute();
      await appendControlEvent(tx, {
        ...input.audit,
        tenantId: input.tenantId,
        targetType: 'principal',
        targetId: input.principalId,
        operation: 'revoke',
        previousState: previous,
        newState: { ...previous, state: 'revoked', updated_at: now },
        occurredAt: now,
        requestFingerprint: fingerprint,
        actorAuthorizationSha256,
        outcome: 'applied',
      });
      return true;
    });
  }

  async revokeDelegation(input: {
    tenantId: string;
    delegationId: string;
    audit: AgentControlMutationAudit;
  }): Promise<boolean> {
    const requested = { revoked: true };
    const fingerprint = controlFingerprint(
      input.audit,
      'delegation',
      input.delegationId,
      'revoke',
      requested,
    );
    return executeControlTransaction(this.db, async (tx) => {
      await lockControlTenant(tx, input.tenantId);
      const actorAuthorizationSha256 = await authorizeControlActor(
        tx,
        input.tenantId,
        input.audit.actorPrincipalId,
      );
      const previous = await tx
        .selectFrom('agent_delegations')
        .selectAll()
        .where('tenant_id', '=', input.tenantId)
        .where('id', '=', input.delegationId)
        .forUpdate()
        .executeTakeFirst();
      const now = await databaseNow(tx);
      if (previous && previous.sponsor_principal_id !== input.audit.actorPrincipalId)
        throw new Error('AGENT_CONTROL_SPONSOR_MISMATCH');
      const replay = await controlReplay(tx, input.tenantId, input.audit, fingerprint);
      if (replay) return replay === 'applied';
      if (!previous || previous.revoked_at) {
        await appendControlEvent(tx, {
          ...input.audit,
          tenantId: input.tenantId,
          targetType: 'delegation',
          targetId: input.delegationId,
          operation: 'revoke',
          newState: requested,
          occurredAt: now,
          requestFingerprint: fingerprint,
          actorAuthorizationSha256,
          outcome: 'not_found',
        });
        return false;
      }
      await tx
        .updateTable('agent_delegations')
        .set({ revoked_at: now })
        .where('tenant_id', '=', input.tenantId)
        .where('id', '=', input.delegationId)
        .execute();
      await appendControlEvent(tx, {
        ...input.audit,
        tenantId: input.tenantId,
        targetType: 'delegation',
        targetId: input.delegationId,
        operation: 'revoke',
        previousState: previous,
        newState: { ...previous, revoked_at: now },
        occurredAt: now,
        requestFingerprint: fingerprint,
        actorAuthorizationSha256,
        outcome: 'applied',
      });
      return true;
    });
  }

  async getPrincipal(tenantId: string, principalId: string): Promise<AgentPrincipal | undefined> {
    const row = await this.db
      .selectFrom('agent_principals')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('id', '=', principalId)
      .executeTakeFirst();
    if (!row) return undefined;
    return this.getPrincipalFrom(this.db, row);
  }

  async getDelegation(
    tenantId: string,
    delegationId: string,
  ): Promise<AgentDelegationGrant | undefined> {
    const row = await this.db
      .selectFrom('agent_delegations')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('id', '=', delegationId)
      .executeTakeFirst();
    return row ? toDelegation(row) : undefined;
  }

  private async getPrincipalFrom(
    _db: Executor,
    row: Selectable<DB['agent_principals']>,
  ): Promise<AgentPrincipal> {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      kind: row.kind as AgentPrincipal['kind'],
      sponsorPrincipalId: row.sponsor_principal_id,
      capabilities: parseStrings(
        row.capabilities,
        'principal capabilities',
      ) as AgentPrincipal['capabilities'],
      maximumAutonomy: row.maximum_autonomy as AgentPrincipal['maximumAutonomy'],
      protocolVersion: row.protocol_version as AgentPrincipal['protocolVersion'],
      state: row.state as AgentPrincipal['state'],
      registeredAt: iso(row.registered_at),
    };
  }

  async reserveAndConsume(input: {
    execution: AgentExecution;
    approval: AgentApproval;
    requiredApproverPermission: string;
    now: string;
    audit: readonly AgentAuditRecord[];
  }): Promise<{ created: boolean; execution: AgentExecution }> {
    return executeRetryableTransaction(
      this.db,
      async (tx) => {
        await tx
          .selectFrom('tenants')
          .select('id')
          .where('id', '=', input.execution.tenantId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        const plan = await tx
          .selectFrom('agent_plans as plan')
          .innerJoin('agent_plan_actions as binding', (join) =>
            join
              .onRef('binding.tenant_id', '=', 'plan.tenant_id')
              .onRef('binding.plan_id', '=', 'plan.id'),
          )
          .innerJoin('agent_plan_states as state', (join) =>
            join
              .onRef('state.tenant_id', '=', 'plan.tenant_id')
              .onRef('state.plan_id', '=', 'plan.id'),
          )
          .select([
            'plan.plan_sha256',
            'plan.expires_at',
            'binding.action_digest',
            'binding.step_id',
            'state.status',
            'state.state_json',
          ])
          .where('plan.tenant_id', '=', input.execution.tenantId)
          .where('binding.action_id', '=', input.execution.actionId)
          .forUpdate()
          .executeTakeFirst();
        const planStepIsExecutable = plan
          ? (() => {
              const state: unknown = JSON.parse(plan.state_json);
              if (!state || typeof state !== 'object' || Array.isArray(state)) return false;
              const stepStates = (state as { stepStates?: unknown }).stepStates;
              if (!Array.isArray(stepStates)) return false;
              const step = stepStates.find(
                (candidate) =>
                  Boolean(candidate) &&
                  typeof candidate === 'object' &&
                  !Array.isArray(candidate) &&
                  (candidate as { stepId?: unknown }).stepId === plan.step_id,
              );
              return (
                Boolean(step) &&
                typeof step === 'object' &&
                !Array.isArray(step) &&
                (step as { status?: unknown }).status === 'awaiting_approval'
              );
            })()
          : true;
        const transactionNow = await databaseNow(tx);
        if (
          Boolean(plan) !== Boolean(input.execution.planSha256) ||
          (plan &&
            (plan.plan_sha256 !== input.execution.planSha256 ||
              plan.action_digest !== input.execution.actionDigest ||
              plan.status !== 'awaiting_approval' ||
              !planStepIsExecutable ||
              new Date(plan.expires_at).getTime() <= transactionNow.getTime()))
        )
          throw new Error('AGENT_APPROVAL_INVALID');
        const approval = await tx
          .selectFrom('agent_approvals')
          .selectAll()
          .where('tenant_id', '=', input.execution.tenantId)
          .where('id', '=', input.approval.id)
          .forUpdate()
          .executeTakeFirst();
        if (
          !approval ||
          input.approval.id !== input.execution.approvalId ||
          approval.id !== input.execution.approvalId ||
          approval.action_digest !== input.execution.actionDigest ||
          approval.plan_sha256 !== (input.execution.planSha256 ?? null) ||
          approval.approver_principal_id !== input.execution.sponsorPrincipalId ||
          (approval.action_id !== null && approval.action_id !== input.execution.actionId)
        )
          throw new Error('AGENT_APPROVAL_INVALID');
        const existing = await tx
          .selectFrom('agent_executions')
          .selectAll()
          .where('tenant_id', '=', input.execution.tenantId)
          .where('idempotency_key', '=', input.execution.idempotencyKey)
          .executeTakeFirst();
        if (existing) {
          if (
            existing.action_id !== input.execution.actionId ||
            existing.action_digest !== input.execution.actionDigest ||
            existing.plan_sha256 !== (input.execution.planSha256 ?? null) ||
            existing.agent_principal_id !== input.execution.agentPrincipalId ||
            existing.sponsor_principal_id !== input.execution.sponsorPrincipalId ||
            existing.delegation_grant_id !== input.execution.delegationGrantId ||
            existing.approval_id !== input.execution.approvalId ||
            existing.request_fingerprint !== input.execution.requestFingerprint ||
            safeInteger(existing.resource_version, 'execution resource version') !==
              input.execution.resourceVersion ||
            safeInteger(existing.policy_version, 'execution policy version') !==
              input.execution.policyVersion
          )
            throw new Error('AGENT_EXECUTION_IDEMPOTENCY_CONFLICT');
          return { created: false, execution: toExecution(existing) };
        }

        const now = transactionNow;
        const permissions: unknown = JSON.parse(approval.approver_permission_snapshot);
        if (
          safeInteger(approval.policy_version, 'approval policy version') !==
            input.execution.policyVersion ||
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
            plan_sha256: input.execution.planSha256 ?? null,
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
        if (
          input.audit.length !== 2 ||
          new Set(input.audit.map(({ phase }) => phase)).size !== 2 ||
          !input.audit.some(({ phase }) => phase === 'prepared') ||
          !input.audit.some(({ phase }) => phase === 'authorized')
        )
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
      },
      'AGENT_EXECUTION_TRANSACTION_RETRY_EXHAUSTED',
    );
  }

  async claim(input: {
    tenantId: string;
    executionId: string;
    workerId: string;
    audit: AgentAuditRecord;
  }): Promise<AgentExecution | null> {
    return this.db.transaction().execute(async (tx) => {
      const tenant = await tx
        .selectFrom('tenants')
        .select('id')
        .where('id', '=', input.tenantId)
        .forUpdate()
        .executeTakeFirst();
      if (!tenant) return null;
      const row = await tx
        .selectFrom('agent_executions')
        .selectAll()
        .where('tenant_id', '=', input.tenantId)
        .where('id', '=', input.executionId)
        .forUpdate()
        .executeTakeFirst();
      if (!row || ['succeeded', 'compensated'].includes(row.state))
        return row ? toExecution(row) : null;
      const now = await databaseNow(tx);
      if (
        row.state === 'running' &&
        row.lease_expires_at &&
        new Date(row.lease_expires_at).getTime() > now.getTime()
      )
        return null;
      const committedEffect = await tx
        .selectFrom('agent_action_effects')
        .selectAll()
        .where('tenant_id', '=', input.tenantId)
        .where('execution_id', '=', row.id)
        .executeTakeFirst();
      if (row.state === 'failed' && !committedEffect) return toExecution(row);
      if (committedEffect) {
        const result = JSON.parse(committedEffect.result) as AgentActionResult;
        validateAgentActionResult(result);
        if (
          committedEffect.action_digest !== row.action_digest ||
          committedEffect.idempotency_key !== row.idempotency_key ||
          Number(committedEffect.expected_policy_version) !== Number(row.policy_version) ||
          Number(committedEffect.expected_resource_version) !== Number(row.resource_version) ||
          Number(committedEffect.effect_fence_token) < 1 ||
          Number(committedEffect.effect_fence_token) > Number(row.fence_token) ||
          agentSha256(result) !== committedEffect.result_sha256
        )
          throw new Error('AGENT_EFFECT_BINDING_INVALID');
      }
      if (!committedEffect) {
        // Keep the same principal → delegation → approval lock order as revocation paths.
        const principal = await tx
          .selectFrom('agent_principals')
          .selectAll()
          .where('tenant_id', '=', input.tenantId)
          .where('id', '=', row.agent_principal_id)
          .forUpdate()
          .executeTakeFirst();
        const delegation = await tx
          .selectFrom('agent_delegations')
          .selectAll()
          .where('tenant_id', '=', input.tenantId)
          .where('id', '=', row.delegation_grant_id)
          .forUpdate()
          .executeTakeFirst();
        const approval = await tx
          .selectFrom('agent_approvals')
          .selectAll()
          .where('tenant_id', '=', input.tenantId)
          .where('id', '=', row.approval_id)
          .forUpdate()
          .executeTakeFirst();
        if (
          !principal ||
          principal.state !== 'active' ||
          !delegation ||
          delegation.revoked_at ||
          delegation.agent_principal_id !== row.agent_principal_id ||
          delegation.sponsor_principal_id !== row.sponsor_principal_id ||
          new Date(delegation.issued_at).getTime() > now.getTime() ||
          new Date(delegation.expires_at).getTime() <= now.getTime() ||
          !approval ||
          approval.revoked_at ||
          approval.consumed_execution_id !== row.id
        )
          return null;
      }
      const fenceToken = safeInteger(row.fence_token, 'fence token') + 1;
      const effectRecovery = row.state === 'failed' || row.failure_code === 'AGENT_EFFECT_RECOVERY';
      const execution = toExecution(row);
      assertAudit(execution, input.audit, ['started']);
      const leaseExpiresAt = new Date(now.getTime() + LEASE_MILLISECONDS);
      await tx
        .updateTable('agent_executions')
        .set({
          state: 'running',
          fence_token: fenceToken,
          lease_owner: input.workerId,
          lease_expires_at: leaseExpiresAt,
          failure_code: effectRecovery ? 'AGENT_EFFECT_RECOVERY' : null,
          updated_at: now,
        })
        .where('tenant_id', '=', input.tenantId)
        .where('id', '=', input.executionId)
        .execute();
      await appendAudit(tx, input.executionId, {
        ...input.audit,
        occurredAt: now.toISOString(),
        reasonCodes: effectRecovery ? ['effect_recovery'] : input.audit.reasonCodes,
      });
      return toExecution({
        ...row,
        state: 'running',
        fence_token: fenceToken,
        lease_owner: input.workerId,
        lease_expires_at: leaseExpiresAt,
        failure_code: effectRecovery ? 'AGENT_EFFECT_RECOVERY' : null,
        updated_at: now,
      });
    });
  }

  async complete(input: {
    execution: AgentExecution;
    expectedRevision: { fenceToken: number; leaseOwner: string };
    audit: AgentAuditRecord;
  }): Promise<boolean> {
    return this.db.transaction().execute(async (tx) => {
      const tenant = await tx
        .selectFrom('tenants')
        .select('id')
        .where('id', '=', input.execution.tenantId)
        .forUpdate()
        .executeTakeFirst();
      if (!tenant) return false;
      const row = await tx
        .selectFrom('agent_executions')
        .selectAll()
        .where('tenant_id', '=', input.execution.tenantId)
        .where('id', '=', input.execution.id)
        .forUpdate()
        .executeTakeFirst();
      if (!row) return false;
      const now = await databaseNow(tx);
      const authoritative = toExecution(row);
      assertAudit(authoritative, input.audit, [
        input.execution.state === 'succeeded'
          ? 'succeeded'
          : input.execution.state === 'compensated'
            ? 'compensated'
            : 'failed',
      ]);
      if (
        row.state !== 'running' ||
        row.lease_owner !== input.expectedRevision.leaseOwner ||
        safeInteger(row.fence_token, 'fence token') !== input.expectedRevision.fenceToken ||
        !row.lease_expires_at ||
        new Date(row.lease_expires_at).getTime() <= now.getTime()
      )
        return false;
      const completed = await tx
        .updateTable('agent_executions')
        .set({
          state: input.execution.state,
          result: input.execution.result ? JSON.stringify(input.execution.result) : null,
          failure_code: input.execution.failureCode ?? null,
          lease_owner: null,
          lease_expires_at: null,
          updated_at: now,
        })
        .where('tenant_id', '=', input.execution.tenantId)
        .where('id', '=', input.execution.id)
        .where('state', '=', 'running')
        .where('fence_token', '=', input.expectedRevision.fenceToken)
        .where('lease_owner', '=', input.expectedRevision.leaseOwner)
        .executeTakeFirst();
      if (Number(completed.numUpdatedRows) !== 1) return false;
      await appendAudit(tx, input.execution.id, { ...input.audit, occurredAt: now.toISOString() });
      return true;
    });
  }

  async recoverEffect(input: {
    execution: AgentExecution;
    action: AgentAction;
  }): Promise<AgentActionResult | undefined> {
    const row = await this.db
      .selectFrom('agent_action_effects')
      .selectAll()
      .where('tenant_id', '=', input.execution.tenantId)
      .where('execution_id', '=', input.execution.id)
      .executeTakeFirst();
    if (!row) return undefined;
    if (
      row.action_digest !== input.execution.actionDigest ||
      row.action_digest !== agentActionDigest(input.action) ||
      row.resource_type !== input.action.target.resourceType ||
      row.resource_id !== input.action.target.resourceId ||
      row.operation !== input.action.target.apiOperation ||
      row.idempotency_key !== input.execution.idempotencyKey ||
      Number(row.expected_policy_version) !== input.execution.policyVersion ||
      Number(row.expected_resource_version) !== input.execution.resourceVersion ||
      Number(row.effect_fence_token) < 1 ||
      Number(row.effect_fence_token) > input.execution.fenceToken
    )
      throw new Error('AGENT_EFFECT_BINDING_INVALID');
    const result = JSON.parse(row.result) as AgentActionResult;
    validateAgentActionResultForAction(input.action, result);
    if (agentSha256(result) !== row.result_sha256) throw new Error('AGENT_EFFECT_RESULT_INVALID');
    if (input.action.kind === 'event.publish') {
      const event = await this.db
        .selectFrom('events')
        .select(['status', 'version'])
        .where('tenant_id', '=', input.execution.tenantId)
        .where('id', '=', input.action.target.resourceId)
        .executeTakeFirst();
      if (
        !event ||
        event.status !== 'published' ||
        Number(event.version) !== result.resourceVersion
      )
        throw new Error('AGENT_EFFECT_RESOURCE_STATE_INVALID');
    }
    return result;
  }
}
