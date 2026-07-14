import {
  AGENT_PROTOCOL_VERSION,
  agentActionDigest,
  agentSha256,
  authorizeAgentAction,
  canonicalAgentJson,
  type AgentAction,
  type AgentApproval,
  type AgentDelegationGrant,
  type AgentPrincipal,
} from '@tixkit/agent-protocol';
import { sql, type Database } from '@tixkit/db';
import type { Selectable, Transaction } from 'kysely';
import { createHash } from 'node:crypto';
import { eventPublishReadinessSnapshotSha256 } from './agent-event-publish.js';
import { ReadinessService, resolvePaymentMode } from './readiness.js';

type Executor = Database | Transaction<import('@tixkit/db').DB>;
const ACTION_TTL_MILLISECONDS = 15 * 60 * 1000;
const APPROVAL_TTL_MILLISECONDS = 5 * 60 * 1000;

export interface PreparedAgentAction {
  action: AgentAction;
  actionDigest: string;
  expiresAt: string;
  authorization: {
    eligibleForApproval: boolean;
    reasons: readonly string[];
    snapshotSha256: string;
    checkedAt: string;
  };
  dryRun: {
    launchable: boolean;
    readinessSnapshotSha256: string;
    blockingReasonCodes: readonly string[];
  };
}

function parseStrings(value: string, field: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string'))
    throw new Error(`invalid persisted ${field}`);
  return parsed;
}

function parseAction(value: string): AgentAction {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('invalid persisted agent action');
  const action = parsed as AgentAction;
  agentActionDigest(action);
  return action;
}

function iso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('invalid persisted agent action timestamp');
  return date.toISOString();
}

function safeInteger(value: number | string | bigint, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`invalid ${field}`);
  return parsed;
}

async function databaseNow(db: Executor): Promise<Date> {
  const expression =
    process.env.DB_DRIVER === 'mysql'
      ? sql<Date>`current_timestamp`
      : process.env.DB_DRIVER === 'mssql'
        ? sql<Date>`sysdatetime()`
        : sql<Date>`clock_timestamp()`;
  const row = await db
    .selectFrom('tenants')
    .select(expression.as('now'))
    .limit(1)
    .executeTakeFirst();
  if (!row) throw new Error('database clock unavailable');
  return new Date(row.now);
}

function stableId(prefix: 'act' | 'aevt' | 'apr', ...parts: readonly string[]): string {
  const digest = createHash('sha256').update(parts.join('\0')).digest('hex');
  return `${prefix}_${digest.slice(0, 48)}`;
}

function requestFingerprint(input: {
  kind: 'event.publish';
  delegationGrantId: string;
  resourceId: string;
}): string {
  return agentSha256(input);
}

function toPrincipal(row: {
  id: string;
  tenant_id: string;
  kind: string;
  sponsor_principal_id: string;
  capabilities: string;
  maximum_autonomy: string;
  protocol_version: string;
  state: string;
  registered_at: Date | string;
}): AgentPrincipal {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    kind: row.kind as AgentPrincipal['kind'],
    sponsorPrincipalId: row.sponsor_principal_id,
    capabilities: parseStrings(
      row.capabilities,
      'agent capabilities',
    ) as AgentPrincipal['capabilities'],
    maximumAutonomy: row.maximum_autonomy as AgentPrincipal['maximumAutonomy'],
    protocolVersion: row.protocol_version as AgentPrincipal['protocolVersion'],
    state: row.state as AgentPrincipal['state'],
    registeredAt: iso(row.registered_at),
  };
}

function toDelegation(row: {
  id: string;
  tenant_id: string;
  agent_principal_id: string;
  sponsor_principal_id: string;
  capabilities: string;
  resource_scopes: string;
  permission_snapshot: string;
  issued_at: Date | string;
  expires_at: Date | string;
  revoked_at: Date | string | null;
}): AgentDelegationGrant {
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
    permissionSnapshot: parseStrings(row.permission_snapshot, 'delegation permissions'),
    issuedAt: iso(row.issued_at),
    expiresAt: iso(row.expires_at),
    ...(row.revoked_at ? { revokedAt: iso(row.revoked_at) } : {}),
  };
}

export class AgentActionService {
  constructor(private readonly db: Database) {}

  async prepare(input: {
    tenantId: string;
    agentPrincipalId: string;
    idempotencyKey: string;
    kind: 'event.publish';
    delegationGrantId: string;
    resourceId: string;
  }): Promise<PreparedAgentAction> {
    const fingerprint = requestFingerprint(input);
    return this.db
      .transaction()
      .setIsolationLevel('serializable')
      .execute(async (tx) => {
        await tx
          .selectFrom('tenants')
          .select('id')
          .where('id', '=', input.tenantId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        const replay = await tx
          .selectFrom('agent_actions')
          .selectAll()
          .where('tenant_id', '=', input.tenantId)
          .where('agent_principal_id', '=', input.agentPrincipalId)
          .where('idempotency_key', '=', input.idempotencyKey)
          .executeTakeFirst();
        if (replay) {
          if (replay.request_fingerprint !== fingerprint)
            throw new Error('AGENT_ACTION_IDEMPOTENCY_CONFLICT');
          return this.fromRow(replay);
        }

        const principalRow = await tx
          .selectFrom('agent_principals')
          .selectAll()
          .where('tenant_id', '=', input.tenantId)
          .where('id', '=', input.agentPrincipalId)
          .forUpdate()
          .executeTakeFirst();
        if (!principalRow) throw new Error('AGENT_ACTION_PRINCIPAL_DENIED');
        const principal = toPrincipal(principalRow);
        if (
          principal.state !== 'active' ||
          principal.protocolVersion !== AGENT_PROTOCOL_VERSION ||
          !principal.capabilities.includes('events.execute')
        )
          throw new Error('AGENT_ACTION_PRINCIPAL_DENIED');
        const delegationRow = await tx
          .selectFrom('agent_delegations')
          .selectAll()
          .where('tenant_id', '=', input.tenantId)
          .where('id', '=', input.delegationGrantId)
          .forUpdate()
          .executeTakeFirst();
        if (!delegationRow) throw new Error('AGENT_ACTION_DELEGATION_DENIED');
        const delegation = toDelegation(delegationRow);
        const now = await databaseNow(tx);
        if (
          delegation.agentPrincipalId !== principal.id ||
          delegation.sponsorPrincipalId !== principal.sponsorPrincipalId ||
          !delegation.capabilities.includes('events.execute') ||
          !delegation.resourceScopes.includes(`event:${input.resourceId}`) ||
          delegation.revokedAt ||
          new Date(delegation.issuedAt).getTime() > now.getTime() ||
          new Date(delegation.expiresAt).getTime() <= now.getTime()
        )
          throw new Error('AGENT_ACTION_DELEGATION_DENIED');
        const event = await tx
          .selectFrom('events')
          .select(['id', 'organization_id', 'brand_id', 'version'])
          .where('tenant_id', '=', input.tenantId)
          .where('id', '=', input.resourceId)
          .forUpdate()
          .executeTakeFirst();
        if (!event) throw new Error('AGENT_ACTION_RESOURCE_DENIED');
        const sponsor = await tx
          .selectFrom('user_profiles')
          .select('status')
          .where('tenant_id', '=', input.tenantId)
          .where('id', '=', principal.sponsorPrincipalId)
          .forUpdate()
          .executeTakeFirst();
        const membership = await tx
          .selectFrom('organization_members')
          .select('id')
          .where('tenant_id', '=', input.tenantId)
          .where('organization_id', '=', event.organization_id)
          .where('user_id', '=', principal.sponsorPrincipalId)
          .where('accepted_at', 'is not', null)
          .forUpdate()
          .executeTakeFirst();
        const permission = await tx
          .selectFrom('permission_grants')
          .select('id')
          .where('tenant_id', '=', input.tenantId)
          .where('principal_type', '=', 'user')
          .where('principal_id', '=', principal.sponsorPrincipalId)
          .where('permission', '=', 'events.write')
          .where('scope_type', '=', 'tenant')
          .where('scope_id', 'is', null)
          .forUpdate()
          .executeTakeFirst();
        if (sponsor?.status !== 'active' || !membership || !permission)
          throw new Error('AGENT_ACTION_RESOURCE_DENIED');
        const policy = await tx
          .selectFrom('agent_action_policies')
          .selectAll()
          .where('tenant_id', '=', input.tenantId)
          .where('action_kind', '=', input.kind)
          .forUpdate()
          .executeTakeFirst();
        if (!policy) throw new Error('AGENT_ACTION_POLICY_UNAVAILABLE');
        const readiness = await new ReadinessService(
          tx as Database,
          resolvePaymentMode(),
        ).getEventLaunchReadiness({
          tenantId: input.tenantId,
          organizationId: event.organization_id,
          brandId: event.brand_id,
          eventId: event.id,
          permissions: new Set(['events.write']),
        });
        const readinessSnapshotSha256 = eventPublishReadinessSnapshotSha256(readiness);
        const action: AgentAction = {
          id: stableId('act', input.tenantId, input.agentPrincipalId, input.idempotencyKey),
          protocolVersion: AGENT_PROTOCOL_VERSION,
          agentPrincipalId: input.agentPrincipalId,
          sponsorPrincipalId: principal.sponsorPrincipalId,
          delegationGrantId: input.delegationGrantId,
          kind: input.kind,
          autonomy: 'execute_with_approval',
          target: {
            tenantId: input.tenantId,
            resourceType: 'event',
            resourceId: event.id,
            resourceVersion: safeInteger(event.version, 'event version'),
            apiOperation: 'events.publish',
          },
          payload: { readinessSnapshotSha256 },
          idempotencyKey: input.idempotencyKey,
          expectedPolicyVersion: safeInteger(policy.policy_version, 'agent policy version'),
          preparedAt: now.toISOString(),
        };
        const actionDigest = agentActionDigest(action);
        const sponsorPermissions = ['events:publish'];
        const decision = authorizeAgentAction({
          principal,
          delegation,
          action,
          actionDigest,
          sponsorPermissions,
          tenantAllowedActions: policy.allowed && policy.risk_allowed ? ['event.publish'] : [],
          currentResourceVersion: action.target.resourceVersion,
          currentPolicyVersion: action.expectedPolicyVersion,
          now: now.toISOString(),
        });
        const authorizationReasons = [
          ...new Set([...decision.reasons, ...(readiness.launchable ? [] : ['event_not_ready'])]),
        ];
        const eligibleForApproval =
          readiness.launchable &&
          decision.reasons.length === 1 &&
          decision.reasons[0] === 'approval_required';
        const authorizationSnapshotSha256 = agentSha256({
          principal,
          delegation,
          sponsorPermissions,
          policy: {
            allowed: Boolean(policy.allowed),
            riskAllowed: Boolean(policy.risk_allowed),
            version: action.expectedPolicyVersion,
          },
          resource: action.target,
          readinessSnapshotSha256,
          checkedAt: now.toISOString(),
        });
        const expiresAt = new Date(
          Math.min(
            now.getTime() + ACTION_TTL_MILLISECONDS,
            new Date(delegation.expiresAt).getTime(),
          ),
        );
        const dryRun = {
          launchable: readiness.launchable,
          readinessSnapshotSha256,
          blockingReasonCodes: [
            ...new Set(readiness.requiredBlockers.flatMap((step) => step.reasonCodes)),
          ],
        };
        await tx
          .insertInto('agent_actions')
          .values({
            id: action.id,
            tenant_id: input.tenantId,
            agent_principal_id: action.agentPrincipalId,
            sponsor_principal_id: action.sponsorPrincipalId,
            delegation_grant_id: action.delegationGrantId,
            action_kind: action.kind,
            action_digest: actionDigest,
            action_json: canonicalAgentJson(action),
            resource_type: action.target.resourceType,
            resource_id: action.target.resourceId,
            resource_version: action.target.resourceVersion,
            policy_version: action.expectedPolicyVersion,
            idempotency_key: action.idempotencyKey,
            request_fingerprint: fingerprint,
            authorization_snapshot_sha256: authorizationSnapshotSha256,
            authorization_reasons: JSON.stringify(authorizationReasons),
            dry_run_json: canonicalAgentJson(dryRun),
            eligible_for_approval: eligibleForApproval,
            prepared_at: now,
            expires_at: expiresAt,
          })
          .execute();
        await tx
          .insertInto('agent_action_events')
          .values({
            id: stableId('aevt', action.id, 'prepared'),
            tenant_id: input.tenantId,
            action_id: action.id,
            action_digest: actionDigest,
            agent_principal_id: action.agentPrincipalId,
            sponsor_principal_id: action.sponsorPrincipalId,
            actor_type: 'agent',
            actor_principal_id: action.agentPrincipalId,
            phase: 'prepared',
            approval_id: null,
            execution_id: null,
            idempotency_key: input.idempotencyKey,
            request_fingerprint: fingerprint,
            authorization_sha256: authorizationSnapshotSha256,
            outcome: eligibleForApproval ? 'approval_required' : 'denied',
            occurred_at: now,
          })
          .execute();
        return {
          action,
          actionDigest,
          expiresAt: expiresAt.toISOString(),
          authorization: {
            eligibleForApproval,
            reasons: authorizationReasons,
            snapshotSha256: authorizationSnapshotSha256,
            checkedAt: now.toISOString(),
          },
          dryRun,
        };
      });
  }

  async getForAgent(input: {
    tenantId: string;
    agentPrincipalId: string;
    actionId: string;
  }): Promise<PreparedAgentAction | undefined> {
    const row = await this.db
      .selectFrom('agent_actions')
      .selectAll()
      .where('tenant_id', '=', input.tenantId)
      .where('agent_principal_id', '=', input.agentPrincipalId)
      .where('id', '=', input.actionId)
      .executeTakeFirst();
    return row ? this.fromRow(row) : undefined;
  }

  async getForSponsor(input: {
    tenantId: string;
    sponsorPrincipalId: string;
    actionId: string;
  }): Promise<PreparedAgentAction | undefined> {
    const row = await this.db
      .selectFrom('agent_actions')
      .selectAll()
      .where('tenant_id', '=', input.tenantId)
      .where('sponsor_principal_id', '=', input.sponsorPrincipalId)
      .where('id', '=', input.actionId)
      .executeTakeFirst();
    if (!row) return undefined;
    const action = this.fromRow(row);
    const authorized = await this.hasLiveSponsorAuthority(
      this.db,
      input.tenantId,
      input.sponsorPrincipalId,
      action.action.target.resourceId,
    );
    return authorized ? action : undefined;
  }

  async approve(input: {
    tenantId: string;
    approverPrincipalId: string;
    actionId: string;
    actionDigest: string;
    idempotencyKey: string;
  }): Promise<AgentApproval> {
    const fingerprint = agentSha256({
      actionId: input.actionId,
      actionDigest: input.actionDigest,
    });
    return this.db
      .transaction()
      .setIsolationLevel('serializable')
      .execute(async (tx) => {
        await tx
          .selectFrom('tenants')
          .select('id')
          .where('id', '=', input.tenantId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        const row = await tx
          .selectFrom('agent_actions')
          .selectAll()
          .where('tenant_id', '=', input.tenantId)
          .where('id', '=', input.actionId)
          .where('sponsor_principal_id', '=', input.approverPrincipalId)
          .forUpdate()
          .executeTakeFirst();
        if (!row) throw new Error('AGENT_ACTION_APPROVAL_SCOPE_DENIED');
        const prepared = this.fromRow(row);
        if (prepared.actionDigest !== input.actionDigest)
          throw new Error('AGENT_ACTION_APPROVAL_DIGEST_MISMATCH');
        const replay = await tx
          .selectFrom('agent_action_events')
          .selectAll()
          .where('tenant_id', '=', input.tenantId)
          .where('actor_principal_id', '=', input.approverPrincipalId)
          .where('phase', '=', 'approved')
          .where('idempotency_key', '=', input.idempotencyKey)
          .forUpdate()
          .executeTakeFirst();
        if (replay) {
          if (
            replay.request_fingerprint !== fingerprint ||
            replay.action_id !== input.actionId ||
            replay.action_digest !== input.actionDigest ||
            !replay.approval_id
          )
            throw new Error('AGENT_ACTION_APPROVAL_IDEMPOTENCY_CONFLICT');
          const approval = await tx
            .selectFrom('agent_approvals')
            .selectAll()
            .where('tenant_id', '=', input.tenantId)
            .where('id', '=', replay.approval_id)
            .where('action_id', '=', input.actionId)
            .executeTakeFirstOrThrow();
          const replayed = this.approvalFromRow(approval);
          if (
            replayed.actionDigest !== input.actionDigest ||
            replayed.approverPrincipalId !== input.approverPrincipalId ||
            replayed.policyVersion !== prepared.action.expectedPolicyVersion ||
            replayed.approverPermissionSnapshot.length !== 1 ||
            replayed.approverPermissionSnapshot[0] !== 'events:publish'
          )
            throw new Error('persisted agent approval binding is invalid');
          return replayed;
        }
        const now = await databaseNow(tx);
        const authorizationSha256 = await this.assertCurrentlyApprovable(
          tx,
          prepared,
          input.approverPrincipalId,
          now,
        );
        const existing = await tx
          .selectFrom('agent_approvals')
          .select('id')
          .where('tenant_id', '=', input.tenantId)
          .where('action_id', '=', input.actionId)
          .forUpdate()
          .executeTakeFirst();
        if (existing) throw new Error('AGENT_ACTION_ALREADY_APPROVED');
        const expiresAt = new Date(
          Math.min(
            now.getTime() + APPROVAL_TTL_MILLISECONDS,
            new Date(prepared.expiresAt).getTime(),
          ),
        );
        const approval: AgentApproval = {
          id: stableId(
            'apr',
            input.tenantId,
            input.approverPrincipalId,
            input.actionId,
            input.idempotencyKey,
          ),
          tenantId: input.tenantId,
          actionDigest: input.actionDigest,
          approverPrincipalId: input.approverPrincipalId,
          approverPermissionSnapshot: ['events:publish'],
          policyVersion: prepared.action.expectedPolicyVersion,
          approvedAt: now.toISOString(),
          expiresAt: expiresAt.toISOString(),
        };
        await tx
          .insertInto('agent_approvals')
          .values({
            id: approval.id,
            tenant_id: approval.tenantId,
            action_id: input.actionId,
            action_digest: approval.actionDigest,
            plan_sha256: null,
            approver_principal_id: approval.approverPrincipalId,
            approver_permission_snapshot: canonicalAgentJson(approval.approverPermissionSnapshot),
            policy_version: approval.policyVersion,
            approved_at: now,
            expires_at: expiresAt,
            revoked_at: null,
            consumed_at: null,
            consumed_execution_id: null,
          })
          .execute();
        await tx
          .insertInto('agent_action_events')
          .values({
            id: stableId('aevt', input.actionId, 'approved'),
            tenant_id: input.tenantId,
            action_id: input.actionId,
            action_digest: input.actionDigest,
            agent_principal_id: prepared.action.agentPrincipalId,
            sponsor_principal_id: prepared.action.sponsorPrincipalId,
            actor_type: 'user',
            actor_principal_id: input.approverPrincipalId,
            phase: 'approved',
            approval_id: approval.id,
            execution_id: null,
            idempotency_key: input.idempotencyKey,
            request_fingerprint: fingerprint,
            authorization_sha256: authorizationSha256,
            outcome: 'approved',
            occurred_at: now,
          })
          .execute();
        return approval;
      });
  }

  private async hasLiveSponsorAuthority(
    db: Executor,
    tenantId: string,
    sponsorPrincipalId: string,
    eventId: string,
  ): Promise<boolean> {
    const event = await db
      .selectFrom('events')
      .select('organization_id')
      .where('tenant_id', '=', tenantId)
      .where('id', '=', eventId)
      .executeTakeFirst();
    if (!event) return false;
    const [sponsor, membership, permission] = await Promise.all([
      db
        .selectFrom('user_profiles')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .where('id', '=', sponsorPrincipalId)
        .where('status', '=', 'active')
        .executeTakeFirst(),
      db
        .selectFrom('organization_members')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .where('organization_id', '=', event.organization_id)
        .where('user_id', '=', sponsorPrincipalId)
        .where('accepted_at', 'is not', null)
        .executeTakeFirst(),
      db
        .selectFrom('permission_grants')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .where('principal_type', '=', 'user')
        .where('principal_id', '=', sponsorPrincipalId)
        .where('permission', '=', 'events.write')
        .where('scope_type', '=', 'tenant')
        .where('scope_id', 'is', null)
        .executeTakeFirst(),
    ]);
    return Boolean(sponsor && membership && permission);
  }

  private async assertCurrentlyApprovable(
    tx: Transaction<import('@tixkit/db').DB>,
    prepared: PreparedAgentAction,
    approverPrincipalId: string,
    now: Date,
  ): Promise<string> {
    const { action } = prepared;
    if (
      !prepared.authorization.eligibleForApproval ||
      action.sponsorPrincipalId !== approverPrincipalId ||
      new Date(prepared.expiresAt).getTime() <= now.getTime()
    )
      throw new Error('AGENT_ACTION_NOT_APPROVABLE');
    const principalRow = await tx
      .selectFrom('agent_principals')
      .selectAll()
      .where('tenant_id', '=', action.target.tenantId)
      .where('id', '=', action.agentPrincipalId)
      .forUpdate()
      .executeTakeFirst();
    const delegationRow = await tx
      .selectFrom('agent_delegations')
      .selectAll()
      .where('tenant_id', '=', action.target.tenantId)
      .where('id', '=', action.delegationGrantId)
      .forUpdate()
      .executeTakeFirst();
    const event = await tx
      .selectFrom('events')
      .select(['id', 'organization_id', 'brand_id', 'version'])
      .where('tenant_id', '=', action.target.tenantId)
      .where('id', '=', action.target.resourceId)
      .forUpdate()
      .executeTakeFirst();
    const policy = await tx
      .selectFrom('agent_action_policies')
      .selectAll()
      .where('tenant_id', '=', action.target.tenantId)
      .where('action_kind', '=', action.kind)
      .forUpdate()
      .executeTakeFirst();
    if (!principalRow || !delegationRow || !event || !policy)
      throw new Error('AGENT_ACTION_NOT_APPROVABLE');
    const principal = toPrincipal(principalRow);
    const delegation = toDelegation(delegationRow);
    const sponsor = await tx
      .selectFrom('user_profiles')
      .select(['id', 'status', 'updated_at'])
      .where('tenant_id', '=', action.target.tenantId)
      .where('id', '=', approverPrincipalId)
      .forUpdate()
      .executeTakeFirst();
    const membership = await tx
      .selectFrom('organization_members')
      .select(['id', 'updated_at'])
      .where('tenant_id', '=', action.target.tenantId)
      .where('organization_id', '=', event.organization_id)
      .where('user_id', '=', approverPrincipalId)
      .where('accepted_at', 'is not', null)
      .forUpdate()
      .executeTakeFirst();
    const permission = await tx
      .selectFrom('permission_grants')
      .select(['id', 'updated_at'])
      .where('tenant_id', '=', action.target.tenantId)
      .where('principal_type', '=', 'user')
      .where('principal_id', '=', approverPrincipalId)
      .where('permission', '=', 'events.write')
      .where('scope_type', '=', 'tenant')
      .where('scope_id', 'is', null)
      .forUpdate()
      .executeTakeFirst();
    if (sponsor?.status !== 'active' || !membership || !permission)
      throw new Error('AGENT_ACTION_NOT_APPROVABLE');
    const readiness = await new ReadinessService(
      tx as Database,
      resolvePaymentMode(),
    ).getEventLaunchReadiness({
      tenantId: action.target.tenantId,
      organizationId: event.organization_id,
      brandId: event.brand_id,
      eventId: event.id,
      permissions: new Set(['events.write']),
    });
    const readinessSnapshotSha256 = eventPublishReadinessSnapshotSha256(readiness);
    const decision = authorizeAgentAction({
      principal,
      delegation,
      action,
      actionDigest: prepared.actionDigest,
      sponsorPermissions: ['events:publish'],
      tenantAllowedActions: policy.allowed && policy.risk_allowed ? ['event.publish'] : [],
      currentResourceVersion: safeInteger(event.version, 'event version'),
      currentPolicyVersion: safeInteger(policy.policy_version, 'agent policy version'),
      now: now.toISOString(),
    });
    if (
      !readiness.launchable ||
      readinessSnapshotSha256 !== action.payload.readinessSnapshotSha256 ||
      decision.reasons.length !== 1 ||
      decision.reasons[0] !== 'approval_required'
    )
      throw new Error('AGENT_ACTION_NOT_APPROVABLE');
    return agentSha256({
      actionDigest: prepared.actionDigest,
      principal,
      delegation,
      sponsor: { id: sponsor.id, status: sponsor.status, updatedAt: iso(sponsor.updated_at) },
      membership: { id: membership.id, updatedAt: iso(membership.updated_at) },
      permission: { id: permission.id, updatedAt: iso(permission.updated_at) },
      policy: {
        allowed: Boolean(policy.allowed),
        riskAllowed: Boolean(policy.risk_allowed),
        version: safeInteger(policy.policy_version, 'agent policy version'),
      },
      resourceVersion: safeInteger(event.version, 'event version'),
      readinessSnapshotSha256,
      checkedAt: now.toISOString(),
    });
  }

  private approvalFromRow(
    row: Selectable<import('@tixkit/db').DB['agent_approvals']>,
  ): AgentApproval {
    const permissions = parseStrings(
      row.approver_permission_snapshot,
      'approver permission snapshot',
    );
    return {
      id: row.id,
      tenantId: row.tenant_id,
      actionDigest: row.action_digest,
      ...(row.plan_sha256 ? { planSha256: row.plan_sha256 } : {}),
      approverPrincipalId: row.approver_principal_id,
      approverPermissionSnapshot: permissions,
      policyVersion: safeInteger(row.policy_version, 'approval policy version'),
      approvedAt: iso(row.approved_at),
      expiresAt: iso(row.expires_at),
      ...(row.revoked_at ? { revokedAt: iso(row.revoked_at) } : {}),
      ...(row.consumed_at ? { consumedAt: iso(row.consumed_at) } : {}),
    };
  }

  private fromRow(row: Selectable<import('@tixkit/db').DB['agent_actions']>): PreparedAgentAction {
    const action = parseAction(row.action_json);
    if (
      action.id !== row.id ||
      action.agentPrincipalId !== row.agent_principal_id ||
      action.sponsorPrincipalId !== row.sponsor_principal_id ||
      action.delegationGrantId !== row.delegation_grant_id ||
      action.kind !== row.action_kind ||
      action.target.tenantId !== row.tenant_id ||
      action.target.resourceType !== row.resource_type ||
      action.target.resourceId !== row.resource_id ||
      action.target.resourceVersion !== safeInteger(row.resource_version, 'resource version') ||
      action.expectedPolicyVersion !== safeInteger(row.policy_version, 'policy version') ||
      action.idempotencyKey !== row.idempotency_key ||
      agentActionDigest(action) !== row.action_digest
    )
      throw new Error('persisted agent action binding is invalid');
    const reasons = parseStrings(row.authorization_reasons, 'authorization reasons');
    const readinessSnapshotSha256 = action.payload.readinessSnapshotSha256;
    if (typeof readinessSnapshotSha256 !== 'string')
      throw new Error('persisted event publish readiness digest is invalid');
    const dryRun: unknown = JSON.parse(row.dry_run_json);
    if (
      !dryRun ||
      typeof dryRun !== 'object' ||
      Array.isArray(dryRun) ||
      !('launchable' in dryRun) ||
      typeof dryRun.launchable !== 'boolean' ||
      !('readinessSnapshotSha256' in dryRun) ||
      dryRun.readinessSnapshotSha256 !== readinessSnapshotSha256 ||
      !('blockingReasonCodes' in dryRun) ||
      !Array.isArray(dryRun.blockingReasonCodes) ||
      dryRun.blockingReasonCodes.some((reason) => typeof reason !== 'string')
    )
      throw new Error('persisted agent action dry run is invalid');
    return {
      action,
      actionDigest: row.action_digest,
      expiresAt: iso(row.expires_at),
      authorization: {
        eligibleForApproval: Boolean(row.eligible_for_approval),
        reasons,
        snapshotSha256: row.authorization_snapshot_sha256,
        checkedAt: iso(row.prepared_at),
      },
      dryRun: dryRun as PreparedAgentAction['dryRun'],
    };
  }
}
