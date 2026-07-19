import {
  AGENT_PROTOCOL_VERSION,
  agentSha256,
  agentAuthorizationStateDigest,
  type AgentAction,
  type AgentActionInvoker,
  type AgentApproval,
  type AgentAuthorizationStateProvider,
  type AgentCurrentAuthorization,
  type AgentDelegationGrant,
  type AgentExecution,
  type AgentPrincipal,
  validateAgentActionResult,
} from '@tixkit/agent-protocol';
import { AuditLogRepository, sql, type Database } from '@tixkit/db';
import type { Transaction } from 'kysely';
import { ReadinessService, resolvePaymentMode } from './readiness.js';
import type { EventLaunchReadiness } from '@tixkit/domain';
import type { Permission } from '@tixkit/domain';
import { publishEvent } from './event-publication.js';
import { EventUpdateService, projectEventUpdateFields } from './event-update.js';

type Executor = Database | Transaction<import('@tixkit/db').DB>;

export type EventPublishAgentAdapterCheckpoints = {
  beforeExecutionReserve?: () => Promise<void> | void;
  beforeExecutionRun?: () => Promise<void> | void;
  beforeInvocationTransaction?: () => Promise<void> | void;
  beforeProductAudit?: () => Promise<void> | void;
  beforeEffectRecord?: () => Promise<void> | void;
};

function parseStrings(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) return parsed;
  } catch {
    // Persisted adapter state is untrusted and must map to the closed error taxonomy below.
  }
  throw Object.assign(new Error('invalid agent authorization state'), {
    code: 'AGENT_STATE_INVALID',
  });
}

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function authorizationChanged(reason: string): never {
  throw Object.assign(new Error(`agent authorization state changed: ${reason}`), {
    code: 'AGENT_AUTHORIZATION_CHANGED',
  });
}

export function eventPublishReadinessSnapshotSha256(readiness: EventLaunchReadiness): string {
  const { generatedAt: _generatedAt, ...materialState } = readiness;
  return agentSha256(materialState);
}

function readinessDigestFromPayload(payload: Readonly<Record<string, unknown>>): string {
  const keys = Object.keys(payload);
  if (
    keys.length !== 1 ||
    keys[0] !== 'readinessSnapshotSha256' ||
    typeof payload.readinessSnapshotSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(payload.readinessSnapshotSha256)
  )
    throw Object.assign(new Error('invalid event publish payload'), {
      code: 'AGENT_OPERATION_DENIED',
    });
  return payload.readinessSnapshotSha256;
}

function changePreviewFromPayload(payload: Readonly<Record<string, unknown>>): {
  changePreviewSha256: string;
  changes: Readonly<Record<string, unknown>>;
} {
  const keys = Object.keys(payload).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== 'changePreviewSha256' ||
    keys[1] !== 'changes' ||
    typeof payload.changePreviewSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(payload.changePreviewSha256) ||
    !payload.changes ||
    typeof payload.changes !== 'object' ||
    Array.isArray(payload.changes)
  )
    throw Object.assign(new Error('invalid event update payload'), {
      code: 'AGENT_OPERATION_DENIED',
    });
  return {
    changePreviewSha256: payload.changePreviewSha256,
    changes: payload.changes as Readonly<Record<string, unknown>>,
  };
}

async function databaseNow(db: Executor): Promise<string> {
  const result = await db
    .selectFrom('tenants')
    .select(sql<Date>`current_timestamp`.as('now'))
    .limit(1)
    .executeTakeFirstOrThrow();
  return iso(result.now);
}

export class EventPublishAgentAdapter
  implements AgentAuthorizationStateProvider, AgentActionInvoker
{
  constructor(
    private readonly db: Database,
    private readonly checkpoints: EventPublishAgentAdapterCheckpoints = {},
  ) {}

  async load(input: {
    action: AgentAction;
    execution: AgentExecution;
  }): Promise<AgentCurrentAuthorization> {
    this.assertEventAction(
      input.action.kind,
      input.action.target.apiOperation,
      input.action.target.resourceType,
    );
    return this.db
      .transaction()
      .execute((tx) =>
        this.loadState(
          tx,
          input.action.target.tenantId,
          input.action.target.resourceId,
          input.execution,
          false,
          input.action.kind as 'event.publish' | 'event.update',
        ),
      );
  }

  async invoke(input: Parameters<AgentActionInvoker['invoke']>[0]) {
    this.assertEventAction(input.actionKind, input.operation, input.resourceType);
    await this.checkpoints.beforeInvocationTransaction?.();
    const approvedReadinessDigest =
      input.actionKind === 'event.publish' ? readinessDigestFromPayload(input.payload) : undefined;
    const approvedUpdate =
      input.actionKind === 'event.update' ? changePreviewFromPayload(input.payload) : undefined;
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
        const executionRow = await tx
          .selectFrom('agent_executions')
          .selectAll()
          .where('tenant_id', '=', input.tenantId)
          .where('id', '=', input.executionId)
          .forUpdate()
          .executeTakeFirst();
        const invocationTime = new Date(await databaseNow(tx)).getTime();
        if (
          !executionRow ||
          executionRow.state !== 'running' ||
          executionRow.action_digest !== input.actionDigest ||
          executionRow.agent_principal_id !== input.agentPrincipalId ||
          executionRow.sponsor_principal_id !== input.sponsorPrincipalId ||
          executionRow.delegation_grant_id !== input.delegationGrantId ||
          executionRow.approval_id !== input.approvalId ||
          executionRow.lease_owner !== input.expectedLeaseOwner ||
          Number(executionRow.fence_token) !== input.expectedFenceToken ||
          !executionRow.lease_expires_at ||
          new Date(executionRow.lease_expires_at).getTime() <= invocationTime ||
          Number(executionRow.resource_version) !== input.expectedResourceVersion ||
          Number(executionRow.policy_version) !== input.expectedPolicyVersion
        )
          throw Object.assign(new Error('agent execution binding changed'), {
            code: 'AGENT_AUTHORIZATION_CHANGED',
          });
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
          .where('plan.tenant_id', '=', input.tenantId)
          .where('binding.action_id', '=', executionRow.action_id)
          .forUpdate()
          .executeTakeFirst();
        const planStepIsExecutable = plan
          ? (() => {
              const state: unknown = JSON.parse(plan.state_json);
              if (!state || typeof state !== 'object' || Array.isArray(state)) return false;
              const stepStates = (state as { stepStates?: unknown }).stepStates;
              if (!Array.isArray(stepStates)) return false;
              return stepStates.some(
                (step) =>
                  Boolean(step) &&
                  typeof step === 'object' &&
                  !Array.isArray(step) &&
                  (step as { stepId?: unknown }).stepId === plan.step_id &&
                  (step as { status?: unknown }).status === 'awaiting_approval',
              );
            })()
          : true;
        if (
          Boolean(plan) !== Boolean(executionRow.plan_sha256) ||
          (plan &&
            (plan.plan_sha256 !== executionRow.plan_sha256 ||
              plan.action_digest !== executionRow.action_digest ||
              plan.status !== 'awaiting_approval' ||
              !planStepIsExecutable ||
              new Date(plan.expires_at).getTime() <= invocationTime))
        )
          throw Object.assign(new Error('agent plan authorization changed before invocation'), {
            code: 'AGENT_AUTHORIZATION_CHANGED',
          });
        const priorEffect = await tx
          .selectFrom('agent_action_effects')
          .selectAll()
          .where('tenant_id', '=', input.tenantId)
          .where('execution_id', '=', input.executionId)
          .executeTakeFirst();
        if (priorEffect) {
          if (
            priorEffect.action_digest !== input.actionDigest ||
            priorEffect.resource_type !== input.resourceType ||
            priorEffect.resource_id !== input.resourceId ||
            priorEffect.operation !== input.operation ||
            priorEffect.idempotency_key !== input.idempotencyKey ||
            Number(priorEffect.expected_policy_version) !== input.expectedPolicyVersion ||
            Number(priorEffect.expected_resource_version) !== input.expectedResourceVersion ||
            Number(priorEffect.effect_fence_token) < 1 ||
            Number(priorEffect.effect_fence_token) > input.expectedFenceToken
          )
            throw Object.assign(new Error('agent effect binding changed'), {
              code: 'AGENT_AUTHORIZATION_CHANGED',
            });
          const result = JSON.parse(priorEffect.result) as {
            resourceId: string;
            resourceVersion: number;
            status: string;
          };
          validateAgentActionResult(result);
          const effectedEvent = await tx
            .selectFrom('events')
            .selectAll()
            .where('tenant_id', '=', input.tenantId)
            .where('id', '=', input.resourceId)
            .forUpdate()
            .executeTakeFirst();
          if (
            agentSha256(result) !== priorEffect.result_sha256 ||
            result.status !== (input.actionKind === 'event.publish' ? 'published' : 'updated') ||
            (input.actionKind === 'event.publish'
              ? result.resourceVersion !== input.expectedResourceVersion &&
                result.resourceVersion !== input.expectedResourceVersion + 1
              : result.resourceVersion !== input.expectedResourceVersion + 1) ||
            !effectedEvent ||
            (input.actionKind === 'event.publish' && effectedEvent.status !== 'published') ||
            (input.actionKind === 'event.update' &&
              agentSha256(
                projectEventUpdateFields(
                  effectedEvent,
                  Object.keys(approvedUpdate!.changes).sort(),
                ),
              ) !== agentSha256(approvedUpdate!.changes)) ||
            Number(effectedEvent.version) !== result.resourceVersion
          )
            throw Object.assign(new Error('agent effect result digest changed'), {
              code: 'AGENT_AUTHORIZATION_CHANGED',
            });
          return result;
        }
        const execution: AgentExecution = {
          id: executionRow.id,
          tenantId: executionRow.tenant_id,
          actionId: executionRow.action_id,
          actionDigest: executionRow.action_digest,
          ...(executionRow.plan_sha256 ? { planSha256: executionRow.plan_sha256 } : {}),
          agentPrincipalId: executionRow.agent_principal_id,
          sponsorPrincipalId: executionRow.sponsor_principal_id,
          delegationGrantId: executionRow.delegation_grant_id,
          approvalId: executionRow.approval_id,
          idempotencyKey: executionRow.idempotency_key,
          requestFingerprint: executionRow.request_fingerprint,
          state: 'running',
          resourceVersion: Number(executionRow.resource_version),
          policyVersion: Number(executionRow.policy_version),
          fenceToken: Number(executionRow.fence_token),
          createdAt: iso(executionRow.created_at),
          updatedAt: iso(executionRow.updated_at),
        };
        const current = await this.loadState(
          tx,
          input.tenantId,
          input.resourceId,
          execution,
          true,
          input.actionKind as 'event.publish' | 'event.update',
        );
        const now = new Date(current.observedAt).getTime();
        if (agentAuthorizationStateDigest(current) !== input.authorizationStateDigest)
          throw Object.assign(new Error('agent authorization digest changed before invocation'), {
            code: 'AGENT_AUTHORIZATION_CHANGED',
          });
        const denials = [
          current.principal.state !== 'active' && 'principal_state',
          current.principal.protocolVersion !== AGENT_PROTOCOL_VERSION && 'protocol',
          current.principal.sponsorPrincipalId !== input.sponsorPrincipalId && 'principal_sponsor',
          current.principal.maximumAutonomy !== 'execute_with_approval' && 'autonomy',
          !current.principal.capabilities.includes('events.execute') && 'principal_capability',
          current.delegation.agentPrincipalId !== input.agentPrincipalId && 'delegation_agent',
          current.delegation.sponsorPrincipalId !== input.sponsorPrincipalId &&
            'delegation_sponsor',
          current.delegation.revokedAt !== undefined && 'delegation_revoked',
          new Date(current.delegation.issuedAt).getTime() > now && 'delegation_not_started',
          new Date(current.delegation.expiresAt).getTime() <= now && 'delegation_expired',
          !current.delegation.capabilities.includes('events.execute') && 'delegation_capability',
          !current.delegation.permissionSnapshot.includes(
            input.actionKind === 'event.publish' ? 'events:publish' : 'events:write',
          ) && 'delegation_permission',
          !current.delegation.resourceScopes.includes(`event:${input.resourceId}`) &&
            'delegation_scope',
          current.approval.actionDigest !== input.actionDigest && 'approval_digest',
          current.approval.revokedAt !== undefined && 'approval_revoked',
          new Date(current.approval.approvedAt).getTime() > now && 'approval_not_started',
          new Date(current.approval.expiresAt).getTime() <= now && 'approval_expired',
          current.approvalExecutionId !== input.executionId && 'approval_binding',
          !current.sponsorPermissions.includes(
            input.actionKind === 'event.publish' ? 'events:publish' : 'events:write',
          ) && 'sponsor_permission',
          !current.tenantAllowedActions.includes(input.actionKind) && 'tenant_policy',
          !current.riskPolicyAllowed && 'risk_policy',
          current.currentPolicyVersion !== input.expectedPolicyVersion && 'policy_version',
          current.currentResourceVersion !== input.expectedResourceVersion && 'resource_version',
        ].filter((reason): reason is string => typeof reason === 'string');
        if (denials.length > 0)
          throw Object.assign(
            new Error(`agent authorization changed before invocation: ${denials.join(',')}`),
            { code: 'AGENT_AUTHORIZATION_CHANGED' },
          );

        const event = await tx
          .selectFrom('events')
          .selectAll()
          .where('tenant_id', '=', input.tenantId)
          .where('id', '=', input.resourceId)
          .forUpdate()
          .executeTakeFirst();
        if (!event)
          throw Object.assign(new Error('event is missing'), {
            code: 'AGENT_AUTHORIZATION_CHANGED',
          });
        if (input.actionKind === 'event.update') {
          const updateService = new EventUpdateService(tx as Database);
          const resolved = await updateService.resolvePatch({
            tenantId: input.tenantId,
            eventId: input.resourceId,
            patch: {
              ...approvedUpdate!.changes,
              expectedVersion: input.expectedResourceVersion,
            },
          });
          const preview = {
            resourceId: event.id,
            resourceVersion: input.expectedResourceVersion,
            changedFields: resolved.requestedFields,
            before: resolved.before,
            after: resolved.after,
          };
          if (
            agentSha256(preview) !== approvedUpdate!.changePreviewSha256 ||
            agentSha256(resolved.after) !== agentSha256(approvedUpdate!.changes) ||
            agentSha256(resolved.before) === agentSha256(resolved.after)
          )
            throw Object.assign(new Error('event update preview changed after approval'), {
              code: 'AGENT_AUTHORIZATION_CHANGED',
            });
          const update = await updateService.applyResolvedPatchInTransaction(tx, resolved);
          if (!update.applied)
            throw Object.assign(new Error('event version changed'), {
              code: 'RESOURCE_VERSION_CHANGED',
            });
          await this.checkpoints.beforeProductAudit?.();
          await new AuditLogRepository(tx as Database).create({
            tenantId: input.tenantId,
            organizationId: event.organization_id,
            brandId: event.brand_id,
            actorType: 'agent',
            actorId: input.agentPrincipalId,
            action: 'event.updated',
            resourceType: 'Event',
            resourceId: update.event.id,
            requestId: input.executionId,
            diffSummary: {
              protocolVersion: AGENT_PROTOCOL_VERSION,
              actionDigest: input.actionDigest,
              executionId: input.executionId,
              sponsorPrincipalId: input.sponsorPrincipalId,
              delegationGrantId: input.delegationGrantId,
              approvalId: input.approvalId,
              expectedPolicyVersion: input.expectedPolicyVersion,
              expectedResourceVersion: input.expectedResourceVersion,
              resultingResourceVersion: Number(update.event.version),
              changePreviewSha256: approvedUpdate!.changePreviewSha256,
              changedFields: resolved.requestedFields,
            },
          });
          const result = {
            resourceId: update.event.id,
            resourceVersion: Number(update.event.version),
            status: 'updated',
          };
          await this.checkpoints.beforeEffectRecord?.();
          await this.recordEffect(tx, input, result, new Date(invocationTime));
          return result;
        }
        const publication = await publishEvent(
          tx,
          new ReadinessService(tx as Database, resolvePaymentMode()),
          {
            tenantId: input.tenantId,
            eventId: input.resourceId,
            permissions: new Set<Permission>(['events.write']),
            expectedResourceVersion: input.expectedResourceVersion,
            beforePublish: ({ readiness }) => {
              if (eventPublishReadinessSnapshotSha256(readiness) !== approvedReadinessDigest)
                throw Object.assign(new Error('event readiness changed after approval'), {
                  code: 'AGENT_AUTHORIZATION_CHANGED',
                });
            },
            onPublished: async ({ event, published }) => {
              await this.checkpoints.beforeProductAudit?.();
              await new AuditLogRepository(tx as Database).create({
                tenantId: input.tenantId,
                organizationId: event.organization_id,
                brandId: event.brand_id,
                actorType: 'agent',
                actorId: input.agentPrincipalId,
                action: 'event.published',
                resourceType: 'Event',
                resourceId: published.id,
                requestId: input.executionId,
                diffSummary: {
                  protocolVersion: AGENT_PROTOCOL_VERSION,
                  actionDigest: input.actionDigest,
                  executionId: input.executionId,
                  sponsorPrincipalId: input.sponsorPrincipalId,
                  delegationGrantId: input.delegationGrantId,
                  approvalId: input.approvalId,
                  expectedPolicyVersion: input.expectedPolicyVersion,
                  expectedResourceVersion: input.expectedResourceVersion,
                  resultingResourceVersion: Number(published.version),
                },
              });
            },
          },
        );
        if (publication.kind === 'not_found')
          throw Object.assign(new Error('event is missing'), {
            code: 'AGENT_AUTHORIZATION_CHANGED',
          });
        if (publication.kind === 'archived')
          throw Object.assign(new Error('event is archived'), {
            code: 'EVENT_ARCHIVED',
          });
        if (publication.kind === 'blocked')
          throw Object.assign(new Error('event readiness blocked'), {
            code: 'EVENT_NOT_READY',
          });
        if (publication.kind === 'stale')
          throw Object.assign(new Error('event version changed'), {
            code: 'RESOURCE_VERSION_CHANGED',
          });
        const published =
          publication.kind === 'published' ? publication.published : publication.event;
        const result = {
          resourceId: published.id,
          resourceVersion: Number(published.version),
          status: 'published',
        };
        await this.checkpoints.beforeEffectRecord?.();
        await this.recordEffect(tx, input, result, new Date(invocationTime));
        return result;
      });
  }

  private async recordEffect(
    db: Executor,
    input: Parameters<AgentActionInvoker['invoke']>[0],
    result: { resourceId: string; resourceVersion: number; status: string },
    now: Date,
  ): Promise<void> {
    await db
      .insertInto('agent_action_effects')
      .values({
        execution_id: input.executionId,
        tenant_id: input.tenantId,
        action_digest: input.actionDigest,
        resource_type: input.resourceType,
        resource_id: input.resourceId,
        operation: input.operation,
        idempotency_key: input.idempotencyKey,
        expected_policy_version: input.expectedPolicyVersion,
        expected_resource_version: input.expectedResourceVersion,
        effect_fence_token: input.expectedFenceToken,
        result: JSON.stringify(result),
        result_sha256: agentSha256(result),
        created_at: now,
      })
      .execute();
  }

  private async loadState(
    db: Executor,
    tenantId: string,
    eventId: string,
    execution: AgentExecution,
    lock: boolean,
    actionKind: 'event.publish' | 'event.update',
  ): Promise<AgentCurrentAuthorization> {
    const principalQuery = db
      .selectFrom('agent_principals')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('id', '=', execution.agentPrincipalId);
    const principal = await (lock ? principalQuery.forUpdate() : principalQuery).executeTakeFirst();
    if (!principal) authorizationChanged('principal_missing');
    const delegationQuery = db
      .selectFrom('agent_delegations')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('id', '=', execution.delegationGrantId);
    const delegation = await (
      lock ? delegationQuery.forUpdate() : delegationQuery
    ).executeTakeFirst();
    if (!delegation) authorizationChanged('delegation_missing');
    const approvalQuery = db
      .selectFrom('agent_approvals')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('id', '=', execution.approvalId);
    const approval = await (lock ? approvalQuery.forUpdate() : approvalQuery).executeTakeFirst();
    if (!approval) authorizationChanged('approval_missing');
    const permissionQuery = db
      .selectFrom('permission_grants')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('principal_type', '=', 'user')
      .where('principal_id', '=', execution.sponsorPrincipalId)
      .where('permission', '=', 'events.write')
      .where('scope_type', '=', 'tenant')
      .where('scope_id', 'is', null);
    const permission = await (
      lock ? permissionQuery.forUpdate() : permissionQuery
    ).executeTakeFirst();
    const sponsorQuery = db
      .selectFrom('user_profiles')
      .select('status')
      .where('tenant_id', '=', tenantId)
      .where('id', '=', execution.sponsorPrincipalId);
    const sponsor = await (lock ? sponsorQuery.forUpdate() : sponsorQuery).executeTakeFirst();
    const policyQuery = db
      .selectFrom('agent_action_policies')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('action_kind', '=', actionKind);
    const policy = await (lock ? policyQuery.forUpdate() : policyQuery).executeTakeFirst();
    if (!policy) authorizationChanged('policy_missing');
    const eventQuery = db
      .selectFrom('events')
      .select(['id', 'organization_id', 'version'])
      .where('tenant_id', '=', tenantId)
      .where('id', '=', eventId);
    const event = await (lock ? eventQuery.forUpdate() : eventQuery).executeTakeFirst();
    if (!event) authorizationChanged('event_missing');
    const membershipQuery = db
      .selectFrom('organization_members')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('organization_id', '=', event.organization_id)
      .where('user_id', '=', execution.sponsorPrincipalId)
      .where('accepted_at', 'is not', null);
    const membership = await (
      lock ? membershipQuery.forUpdate() : membershipQuery
    ).executeTakeFirst();
    return {
      principal: {
        id: principal.id,
        tenantId: principal.tenant_id,
        kind: principal.kind as AgentPrincipal['kind'],
        sponsorPrincipalId: principal.sponsor_principal_id,
        capabilities: parseStrings(principal.capabilities) as AgentPrincipal['capabilities'],
        maximumAutonomy: principal.maximum_autonomy as AgentPrincipal['maximumAutonomy'],
        protocolVersion: principal.protocol_version as typeof AGENT_PROTOCOL_VERSION,
        state: principal.state as AgentPrincipal['state'],
        registeredAt: iso(principal.registered_at),
      },
      delegation: {
        id: delegation.id,
        tenantId: delegation.tenant_id,
        agentPrincipalId: delegation.agent_principal_id,
        sponsorPrincipalId: delegation.sponsor_principal_id,
        capabilities: parseStrings(delegation.capabilities) as AgentDelegationGrant['capabilities'],
        resourceScopes: parseStrings(delegation.resource_scopes),
        permissionSnapshot: parseStrings(delegation.permission_snapshot),
        issuedAt: iso(delegation.issued_at),
        expiresAt: iso(delegation.expires_at),
        ...(delegation.revoked_at ? { revokedAt: iso(delegation.revoked_at) } : {}),
      },
      approval: {
        id: approval.id,
        tenantId: approval.tenant_id,
        actionDigest: approval.action_digest,
        ...(approval.plan_sha256 ? { planSha256: approval.plan_sha256 } : {}),
        approverPrincipalId: approval.approver_principal_id,
        approverPermissionSnapshot: parseStrings(approval.approver_permission_snapshot),
        policyVersion: Number(approval.policy_version),
        approvedAt: iso(approval.approved_at),
        expiresAt: iso(approval.expires_at),
        ...(approval.revoked_at ? { revokedAt: iso(approval.revoked_at) } : {}),
        ...(approval.consumed_at ? { consumedAt: iso(approval.consumed_at) } : {}),
      } as AgentApproval,
      approvalExecutionId: approval.consumed_execution_id ?? '',
      sponsorPermissions:
        permission && sponsor?.status === 'active' && membership
          ? [actionKind === 'event.publish' ? 'events:publish' : 'events:write']
          : [],
      tenantAllowedActions: policy.allowed ? [actionKind] : [],
      currentResourceVersion: Number(event.version),
      currentPolicyVersion: Number(policy.policy_version),
      riskPolicyAllowed: Boolean(policy.risk_allowed),
      observedAt: await databaseNow(db),
    };
  }

  private assertEventAction(kind: string, operation: string, resourceType: string): void {
    if (
      resourceType !== 'event' ||
      (kind !== 'event.publish' && kind !== 'event.update') ||
      operation !== (kind === 'event.publish' ? 'events.publish' : 'events.update')
    )
      throw Object.assign(new Error('unsupported agent action adapter target'), {
        code: 'AGENT_OPERATION_DENIED',
      });
  }
}
