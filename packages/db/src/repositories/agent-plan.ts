import {
  AGENT_ACTION_REGISTRY,
  agentActionDigest,
  agentSha256,
  canonicalAgentJson,
  validateAgentPlanActionBindings,
  validateAgentPlanDefinition,
  validateAgentPlanState,
  validateAgentPlanStateTransition,
  type AgentAction,
  type AgentApproval,
  type AgentExecution,
  type AgentPlanDefinition,
  type AgentPlanState,
  type AgentPlanStatus,
  type AgentPlanStepState,
} from '@tixkit/agent-protocol';
import { sql, type Selectable, type Transaction } from 'kysely';
import type { Database } from '../client.js';
import type { DB } from '../types/db.js';

type Executor = Database | Transaction<DB>;

export interface AgentPlanActionBinding {
  stepId: string;
  actionId: string;
}

export interface PersistedAgentPlan {
  definition: AgentPlanDefinition;
  state: AgentPlanState;
  actionBindings: readonly AgentPlanActionBinding[];
}

export interface AgentPlanTransitionActor {
  type: 'agent' | 'user';
  tenantId: string;
  principalId: string;
}

interface AgentPlanActorAuthorizationEvidence {
  json: string;
  sha256: string;
}

function safeInteger(value: number | string | bigint, label: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`persisted ${label} is invalid`);
  return parsed;
}

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

async function databaseNow(executor: Executor): Promise<Date> {
  const expression =
    process.env.DB_DRIVER === 'mysql'
      ? sql<Date>`current_timestamp(3)`
      : process.env.DB_DRIVER === 'mssql'
        ? sql<Date>`sysdatetime()`
        : sql<Date>`clock_timestamp()`;
  const row = await executor
    .selectFrom('tenants')
    .select(expression.as('now'))
    .limit(1)
    .executeTakeFirst();
  if (!row) throw new Error('database clock unavailable');
  return new Date(row.now);
}

function parseObject(value: string, label: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error(`persisted ${label} is invalid`);
  return parsed as Record<string, unknown>;
}

function parseStringArray(value: string, label: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string'))
    throw new Error(`persisted ${label} is invalid`);
  return parsed;
}

function authorizationEvidence(
  snapshot: Readonly<Record<string, unknown>>,
): AgentPlanActorAuthorizationEvidence {
  return { json: canonicalAgentJson(snapshot), sha256: agentSha256(snapshot) };
}

function parseAction(row: Selectable<DB['agent_actions']>): AgentAction {
  const action = parseObject(row.action_json, 'agent action') as unknown as AgentAction;
  if (
    action.id !== row.id ||
    action.target?.tenantId !== row.tenant_id ||
    action.agentPrincipalId !== row.agent_principal_id ||
    action.sponsorPrincipalId !== row.sponsor_principal_id ||
    action.delegationGrantId !== row.delegation_grant_id ||
    action.kind !== row.action_kind ||
    action.target.resourceType !== row.resource_type ||
    action.target.resourceId !== row.resource_id ||
    action.target.resourceVersion !==
      safeInteger(row.resource_version, 'action resource version') ||
    action.expectedPolicyVersion !== safeInteger(row.policy_version, 'action policy version') ||
    action.idempotencyKey !== row.idempotency_key ||
    action.preparedAt !== iso(row.prepared_at) ||
    agentActionDigest(action) !== row.action_digest
  )
    throw new Error('persisted agent action binding is invalid');
  return action;
}

function parseDefinition(row: Selectable<DB['agent_plans']>): AgentPlanDefinition {
  const definition = parseObject(row.plan_json, 'agent plan') as unknown as AgentPlanDefinition;
  validateAgentPlanDefinition(definition);
  if (
    definition.id !== row.id ||
    definition.tenantId !== row.tenant_id ||
    definition.agentPrincipalId !== row.agent_principal_id ||
    definition.sponsorPrincipalId !== row.sponsor_principal_id ||
    definition.delegationGrantId !== row.delegation_grant_id ||
    definition.protocolVersion !== row.protocol_version ||
    definition.planSha256 !== row.plan_sha256 ||
    definition.createdAt !== iso(row.created_at) ||
    definition.expiresAt !== iso(row.expires_at)
  )
    throw new Error('persisted agent plan binding is invalid');
  return definition;
}

function parseState(
  definition: AgentPlanDefinition,
  row: Selectable<DB['agent_plan_states']>,
): AgentPlanState {
  const state = parseObject(row.state_json, 'agent plan state') as unknown as AgentPlanState;
  if (
    state.planId !== row.plan_id ||
    state.stateVersion !== safeInteger(row.state_version, 'agent plan state version') ||
    state.status !== row.status ||
    state.updatedAt !== iso(row.updated_at) ||
    agentSha256(state) !== row.state_sha256
  )
    throw new Error('persisted agent plan state binding is invalid');
  validateAgentPlanState(definition, state);
  return state;
}

function approvalFromRow(row: Selectable<DB['agent_approvals']>): AgentApproval {
  const permissions: unknown = JSON.parse(row.approver_permission_snapshot);
  if (
    !Array.isArray(permissions) ||
    permissions.some((permission) => typeof permission !== 'string')
  )
    throw new Error('persisted agent approval permissions are invalid');
  return {
    id: row.id,
    tenantId: row.tenant_id,
    actionDigest: row.action_digest,
    ...(row.plan_sha256 ? { planSha256: row.plan_sha256 } : {}),
    approverPrincipalId: row.approver_principal_id,
    approverPermissionSnapshot: permissions as string[],
    policyVersion: safeInteger(row.policy_version, 'agent approval policy version'),
    approvedAt: iso(row.approved_at),
    expiresAt: iso(row.expires_at),
    ...(row.revoked_at ? { revokedAt: iso(row.revoked_at) } : {}),
    ...(row.consumed_at ? { consumedAt: iso(row.consumed_at) } : {}),
  };
}

function executionFromRow(row: Selectable<DB['agent_executions']>): AgentExecution {
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
    resourceVersion: safeInteger(row.resource_version, 'agent execution resource version'),
    policyVersion: safeInteger(row.policy_version, 'agent execution policy version'),
    fenceToken: safeInteger(row.fence_token, 'agent execution fence token'),
    ...(row.lease_owner ? { leaseOwner: row.lease_owner } : {}),
    ...(row.lease_expires_at ? { leaseExpiresAt: iso(row.lease_expires_at) } : {}),
    ...(row.result ? { result: parseObject(row.result, 'agent execution result') } : {}),
    ...(row.failure_code ? { failureCode: row.failure_code } : {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function initialState(definition: AgentPlanDefinition, updatedAt: string): AgentPlanState {
  return {
    planId: definition.id,
    planSha256: definition.planSha256,
    stateVersion: 1,
    status: 'prepared',
    stepStates: definition.steps.map((step) => ({
      stepId: step.id,
      status: 'pending',
    })),
    updatedAt,
  };
}

function assertActor(definition: AgentPlanDefinition, actor: AgentPlanTransitionActor): void {
  const valid =
    actor.tenantId === definition.tenantId &&
    ((actor.type === 'agent' && actor.principalId === definition.agentPrincipalId) ||
      (actor.type === 'user' && actor.principalId === definition.sponsorPrincipalId));
  if (!valid) throw new Error('AGENT_PLAN_ACTOR_DENIED');
}

async function authorizeActor(
  executor: Executor,
  definition: AgentPlanDefinition,
  actions: readonly AgentAction[],
  actor: AgentPlanTransitionActor,
  now: Date,
): Promise<AgentPlanActorAuthorizationEvidence> {
  assertActor(definition, actor);
  if (actor.type === 'agent') {
    const principal = await executor
      .selectFrom('agent_principals')
      .selectAll()
      .where('tenant_id', '=', definition.tenantId)
      .where('id', '=', actor.principalId)
      .forUpdate()
      .executeTakeFirst();
    const delegation = await executor
      .selectFrom('agent_delegations')
      .selectAll()
      .where('tenant_id', '=', definition.tenantId)
      .where('id', '=', definition.delegationGrantId)
      .forUpdate()
      .executeTakeFirst();
    if (!principal || !delegation) throw new Error('AGENT_PLAN_ACTOR_DENIED');
    const principalCapabilities = parseStringArray(
      principal.capabilities,
      'agent principal capabilities',
    );
    const delegationCapabilities = parseStringArray(
      delegation.capabilities,
      'agent delegation capabilities',
    );
    const resourceScopes = parseStringArray(delegation.resource_scopes, 'agent resource scopes');
    const requiredCapabilities = [
      ...new Set(
        actions.flatMap(
          (action) =>
            AGENT_ACTION_REGISTRY.actions.find(({ kind }) => kind === action.kind)
              ?.requiredCapabilities ?? [],
        ),
      ),
    ];
    if (
      principal.state !== 'active' ||
      principal.sponsor_principal_id !== definition.sponsorPrincipalId ||
      delegation.agent_principal_id !== definition.agentPrincipalId ||
      delegation.sponsor_principal_id !== definition.sponsorPrincipalId ||
      delegation.revoked_at ||
      new Date(delegation.issued_at).getTime() > now.getTime() ||
      new Date(delegation.expires_at).getTime() <= now.getTime() ||
      new Date(delegation.expires_at).getTime() < new Date(definition.expiresAt).getTime() ||
      requiredCapabilities.some(
        (capability) =>
          !principalCapabilities.includes(capability) ||
          !delegationCapabilities.includes(capability),
      ) ||
      actions.some(
        (action) =>
          !resourceScopes.includes(`${action.target.resourceType}:${action.target.resourceId}`),
      )
    )
      throw new Error('AGENT_PLAN_ACTOR_DENIED');
    return authorizationEvidence({
      actor,
      principal: {
        state: principal.state,
        sponsorPrincipalId: principal.sponsor_principal_id,
        capabilities: principalCapabilities,
        updatedAt: iso(principal.updated_at),
      },
      delegation: {
        id: delegation.id,
        capabilities: delegationCapabilities,
        resourceScopes,
        expiresAt: iso(delegation.expires_at),
        revokedAt: null,
      },
      observedAt: now.toISOString(),
    });
  }
  const sponsor = await executor
    .selectFrom('user_profiles')
    .select(['status', 'updated_at'])
    .where('tenant_id', '=', definition.tenantId)
    .where('id', '=', actor.principalId)
    .forUpdate()
    .executeTakeFirst();
  const permission = await executor
    .selectFrom('permission_grants')
    .select(['id', 'updated_at'])
    .where('tenant_id', '=', definition.tenantId)
    .where('principal_type', '=', 'user')
    .where('principal_id', '=', actor.principalId)
    .where('permission', '=', 'events.write')
    .where('scope_type', '=', 'tenant')
    .where('scope_id', 'is', null)
    .forUpdate()
    .executeTakeFirst();
  const eventIds = [...new Set(actions.map((action) => action.target.resourceId))];
  const events = await executor
    .selectFrom('events')
    .select(['id', 'organization_id'])
    .where('tenant_id', '=', definition.tenantId)
    .where('id', 'in', eventIds)
    .forUpdate()
    .execute();
  const organizationIds = [...new Set(events.map(({ organization_id }) => organization_id))];
  const memberships = await executor
    .selectFrom('organization_members')
    .select(['organization_id', 'updated_at'])
    .where('tenant_id', '=', definition.tenantId)
    .where('user_id', '=', actor.principalId)
    .where('organization_id', 'in', organizationIds)
    .where('accepted_at', 'is not', null)
    .forUpdate()
    .execute();
  if (
    sponsor?.status !== 'active' ||
    !permission ||
    events.length !== eventIds.length ||
    memberships.length !== organizationIds.length
  )
    throw new Error('AGENT_PLAN_ACTOR_DENIED');
  return authorizationEvidence({
    actor,
    sponsor: { status: sponsor.status, updatedAt: iso(sponsor.updated_at) },
    permission: { id: permission.id, updatedAt: iso(permission.updated_at) },
    memberships: memberships
      .map((membership) => ({
        organizationId: membership.organization_id,
        updatedAt: iso(membership.updated_at),
      }))
      .sort((left, right) => left.organizationId.localeCompare(right.organizationId)),
    observedAt: now.toISOString(),
  });
}

export class AgentPlanRepository {
  constructor(private readonly db: Database) {}

  async create(input: {
    definition: AgentPlanDefinition;
    actionBindings: readonly AgentPlanActionBinding[];
    actor: AgentPlanTransitionActor;
    idempotencyKey: string;
  }): Promise<PersistedAgentPlan> {
    validateAgentPlanDefinition(input.definition);
    if (input.idempotencyKey.length < 8 || input.idempotencyKey.length > 255)
      throw new Error('AGENT_PLAN_IDEMPOTENCY_KEY_INVALID');
    if (
      input.actor.type !== 'agent' ||
      input.actor.tenantId !== input.definition.tenantId ||
      input.actor.principalId !== input.definition.agentPrincipalId
    )
      throw new Error('AGENT_PLAN_ACTOR_DENIED');
    if (
      input.actionBindings.length !== input.definition.steps.length ||
      new Set(input.actionBindings.map(({ stepId }) => stepId)).size !==
        input.actionBindings.length ||
      new Set(input.actionBindings.map(({ actionId }) => actionId)).size !==
        input.actionBindings.length
    )
      throw new Error('AGENT_PLAN_ACTION_BINDINGS_INVALID');
    const inputBindingsByStep = new Map(
      input.actionBindings.map((binding) => [binding.stepId, binding]),
    );
    const canonicalBindings = input.definition.steps.map((step) => {
      const binding = inputBindingsByStep.get(step.id);
      if (!binding) throw new Error('AGENT_PLAN_ACTION_BINDINGS_INVALID');
      return binding;
    });
    const requestFingerprint = agentSha256({
      definition: input.definition,
      actionBindings: canonicalBindings,
      actor: input.actor,
    });
    return this.db.transaction().execute(async (tx) => {
      await tx
        .selectFrom('tenants')
        .select('id')
        .where('id', '=', input.definition.tenantId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const replay = await tx
        .selectFrom('agent_plans')
        .selectAll()
        .where('tenant_id', '=', input.definition.tenantId)
        .where('agent_principal_id', '=', input.definition.agentPrincipalId)
        .where('idempotency_key', '=', input.idempotencyKey)
        .executeTakeFirst();
      if (replay) {
        if (replay.request_fingerprint !== requestFingerprint)
          throw new Error('AGENT_PLAN_IDEMPOTENCY_CONFLICT');
        return this.loadAtVersion(tx, replay, 1);
      }
      const conflictingId = await tx
        .selectFrom('agent_plans')
        .select('id')
        .where('tenant_id', '=', input.definition.tenantId)
        .where('id', '=', input.definition.id)
        .executeTakeFirst();
      if (conflictingId) throw new Error('AGENT_PLAN_ID_CONFLICT');
      const actionRows = await tx
        .selectFrom('agent_actions')
        .selectAll()
        .where('tenant_id', '=', input.definition.tenantId)
        .where(
          'id',
          'in',
          canonicalBindings.map(({ actionId }) => actionId),
        )
        .forUpdate()
        .execute();
      if (actionRows.length !== canonicalBindings.length)
        throw new Error('AGENT_PLAN_ACTION_BINDINGS_INVALID');
      const rowsById = new Map(actionRows.map((row) => [row.id, row]));
      const bindingsByStep = new Map(canonicalBindings.map((binding) => [binding.stepId, binding]));
      const actions = input.definition.steps.map((step) => {
        const binding = bindingsByStep.get(step.id);
        const row = binding ? rowsById.get(binding.actionId) : undefined;
        if (
          !binding ||
          !row ||
          row.action_digest !== step.actionDigest ||
          !row.eligible_for_approval ||
          iso(row.prepared_at) > input.definition.createdAt ||
          iso(row.expires_at) < input.definition.expiresAt
        )
          throw new Error('AGENT_PLAN_ACTION_BINDINGS_INVALID');
        return parseAction(row);
      });
      validateAgentPlanActionBindings(input.definition, actions);
      const now = await databaseNow(tx);
      if (
        new Date(input.definition.createdAt).getTime() > now.getTime() ||
        new Date(input.definition.expiresAt).getTime() <= now.getTime()
      )
        throw new Error('AGENT_PLAN_LIFETIME_INVALID');
      const actorAuthorization = await authorizeActor(
        tx,
        input.definition,
        actions,
        input.actor,
        now,
      );
      const state = initialState(input.definition, now.toISOString());
      validateAgentPlanStateTransition(input.definition, undefined, state, {
        actions,
        approvals: [],
        executions: [],
      });
      const stateSha256 = agentSha256(state);
      await tx
        .insertInto('agent_plans')
        .values({
          id: input.definition.id,
          tenant_id: input.definition.tenantId,
          agent_principal_id: input.definition.agentPrincipalId,
          sponsor_principal_id: input.definition.sponsorPrincipalId,
          delegation_grant_id: input.definition.delegationGrantId,
          protocol_version: input.definition.protocolVersion,
          plan_sha256: input.definition.planSha256,
          plan_json: canonicalAgentJson(input.definition),
          idempotency_key: input.idempotencyKey,
          request_fingerprint: requestFingerprint,
          created_at: new Date(input.definition.createdAt),
          expires_at: new Date(input.definition.expiresAt),
        })
        .execute();
      await tx
        .insertInto('agent_plan_actions')
        .values(
          input.definition.steps.map((step, ordinal) => ({
            tenant_id: input.definition.tenantId,
            plan_id: input.definition.id,
            step_id: step.id,
            action_id: bindingsByStep.get(step.id)!.actionId,
            action_digest: step.actionDigest,
            ordinal,
          })),
        )
        .execute();
      await tx
        .insertInto('agent_plan_states')
        .values({
          tenant_id: input.definition.tenantId,
          plan_id: input.definition.id,
          state_version: state.stateVersion,
          status: state.status,
          state_json: canonicalAgentJson(state),
          state_sha256: stateSha256,
          updated_at: new Date(state.updatedAt),
        })
        .execute();
      await tx
        .insertInto('agent_plan_state_events')
        .values({
          id: agentSha256({
            tenantId: input.definition.tenantId,
            planId: input.definition.id,
            stateVersion: 1,
          }),
          tenant_id: input.definition.tenantId,
          plan_id: input.definition.id,
          previous_state_version: null,
          next_state_version: 1,
          previous_state_sha256: null,
          next_state_sha256: stateSha256,
          previous_state_json: null,
          next_state_json: canonicalAgentJson(state),
          actor_type: input.actor.type,
          actor_principal_id: input.actor.principalId,
          actor_authorization_json: actorAuthorization.json,
          actor_authorization_sha256: actorAuthorization.sha256,
          reason_code: 'plan_created',
          idempotency_key: input.idempotencyKey,
          request_fingerprint: requestFingerprint,
          occurred_at: new Date(state.updatedAt),
        })
        .execute();
      return { definition: input.definition, state, actionBindings: canonicalBindings };
    });
  }

  async getForAgent(input: {
    tenantId: string;
    agentPrincipalId: string;
    planId: string;
  }): Promise<PersistedAgentPlan | undefined> {
    const row = await this.db
      .selectFrom('agent_plans')
      .selectAll()
      .where('tenant_id', '=', input.tenantId)
      .where('agent_principal_id', '=', input.agentPrincipalId)
      .where('id', '=', input.planId)
      .executeTakeFirst();
    return row ? this.load(this.db, row) : undefined;
  }

  async getForSponsor(input: {
    tenantId: string;
    sponsorPrincipalId: string;
    planId: string;
  }): Promise<PersistedAgentPlan | undefined> {
    const row = await this.db
      .selectFrom('agent_plans')
      .selectAll()
      .where('tenant_id', '=', input.tenantId)
      .where('sponsor_principal_id', '=', input.sponsorPrincipalId)
      .where('id', '=', input.planId)
      .executeTakeFirst();
    return row ? this.load(this.db, row) : undefined;
  }

  async transition(input: {
    tenantId: string;
    planId: string;
    expectedStateVersion: number;
    status: AgentPlanStatus;
    stepStates: readonly AgentPlanStepState[];
    actor: AgentPlanTransitionActor;
    reasonCode: string;
    idempotencyKey: string;
  }): Promise<PersistedAgentPlan> {
    if (
      input.idempotencyKey.length < 8 ||
      input.idempotencyKey.length > 255 ||
      !/^[a-z0-9][a-z0-9_.-]{1,63}$/u.test(input.reasonCode)
    )
      throw new Error('AGENT_PLAN_IDEMPOTENCY_KEY_INVALID');
    return this.db.transaction().execute(async (tx) => {
      await tx
        .selectFrom('tenants')
        .select('id')
        .where('id', '=', input.tenantId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const planRow = await tx
        .selectFrom('agent_plans')
        .selectAll()
        .where('tenant_id', '=', input.tenantId)
        .where('id', '=', input.planId)
        .executeTakeFirst();
      if (!planRow) throw new Error('AGENT_PLAN_NOT_FOUND');
      const definition = parseDefinition(planRow);
      const stateRow = await tx
        .selectFrom('agent_plan_states')
        .selectAll()
        .where('tenant_id', '=', input.tenantId)
        .where('plan_id', '=', input.planId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const previous = parseState(definition, stateRow);
      const { actions, actionBindings } = await this.loadActions(tx, definition);
      const now = await databaseNow(tx);
      const actorAuthorization = await authorizeActor(tx, definition, actions, input.actor, now);
      const updatedAt = new Date(
        Math.max(now.getTime(), new Date(previous.updatedAt).getTime() + 1),
      ).toISOString();
      const next: AgentPlanState = {
        planId: definition.id,
        planSha256: definition.planSha256,
        stateVersion: previous.stateVersion + 1,
        status: input.status,
        stepStates: input.stepStates,
        updatedAt,
      };
      const requestFingerprint = agentSha256({
        planId: input.planId,
        expectedStateVersion: input.expectedStateVersion,
        status: input.status,
        stepStates: input.stepStates,
        reasonCode: input.reasonCode,
        actor: input.actor,
      });
      const replay = await tx
        .selectFrom('agent_plan_state_events')
        .selectAll()
        .where('tenant_id', '=', input.tenantId)
        .where('actor_principal_id', '=', input.actor.principalId)
        .where('idempotency_key', '=', input.idempotencyKey)
        .executeTakeFirst();
      if (replay) {
        if (replay.request_fingerprint !== requestFingerprint)
          throw new Error('AGENT_PLAN_IDEMPOTENCY_CONFLICT');
        return this.loadAtEvent(tx, planRow, replay);
      }
      if (previous.stateVersion !== input.expectedStateVersion)
        throw new Error('AGENT_PLAN_STATE_CONFLICT');
      const approvals = await tx
        .selectFrom('agent_approvals as approval')
        .innerJoin('agent_plan_actions as binding', (join) =>
          join
            .onRef('binding.tenant_id', '=', 'approval.tenant_id')
            .onRef('binding.action_id', '=', 'approval.action_id'),
        )
        .selectAll('approval')
        .where('binding.tenant_id', '=', input.tenantId)
        .where('binding.plan_id', '=', input.planId)
        .forUpdate()
        .execute();
      const executions = await tx
        .selectFrom('agent_executions as execution')
        .innerJoin('agent_plan_actions as binding', (join) =>
          join
            .onRef('binding.tenant_id', '=', 'execution.tenant_id')
            .onRef('binding.action_id', '=', 'execution.action_id'),
        )
        .selectAll('execution')
        .where('binding.tenant_id', '=', input.tenantId)
        .where('binding.plan_id', '=', input.planId)
        .forUpdate()
        .execute();
      const approvalRowsById = new Map(approvals.map((approval) => [approval.id, approval]));
      for (const execution of executions) {
        const approval = approvalRowsById.get(execution.approval_id);
        if (!approval || !approval.consumed_at || approval.consumed_execution_id !== execution.id)
          throw new Error('AGENT_PLAN_EXECUTION_APPROVAL_BINDING_INVALID');
      }
      validateAgentPlanStateTransition(definition, previous, next, {
        actions,
        approvals: approvals.map(approvalFromRow),
        executions: executions.map(executionFromRow),
      });
      const previousSha256 = agentSha256(previous);
      const nextSha256 = agentSha256(next);
      const updated = await tx
        .updateTable('agent_plan_states')
        .set({
          state_version: next.stateVersion,
          status: next.status,
          state_json: canonicalAgentJson(next),
          state_sha256: nextSha256,
          updated_at: new Date(next.updatedAt),
        })
        .where('tenant_id', '=', input.tenantId)
        .where('plan_id', '=', input.planId)
        .where('state_version', '=', previous.stateVersion)
        .executeTakeFirst();
      if (Number(updated.numUpdatedRows) !== 1) throw new Error('AGENT_PLAN_STATE_CONFLICT');
      await tx
        .insertInto('agent_plan_state_events')
        .values({
          id: agentSha256({
            tenantId: input.tenantId,
            planId: input.planId,
            stateVersion: next.stateVersion,
            idempotencyKey: input.idempotencyKey,
          }),
          tenant_id: input.tenantId,
          plan_id: input.planId,
          previous_state_version: previous.stateVersion,
          next_state_version: next.stateVersion,
          previous_state_sha256: previousSha256,
          next_state_sha256: nextSha256,
          previous_state_json: canonicalAgentJson(previous),
          next_state_json: canonicalAgentJson(next),
          actor_type: input.actor.type,
          actor_principal_id: input.actor.principalId,
          actor_authorization_json: actorAuthorization.json,
          actor_authorization_sha256: actorAuthorization.sha256,
          reason_code: input.reasonCode,
          idempotency_key: input.idempotencyKey,
          request_fingerprint: requestFingerprint,
          occurred_at: new Date(next.updatedAt),
        })
        .execute();
      return { definition, state: next, actionBindings };
    });
  }

  private async loadAtVersion(
    executor: Executor,
    planRow: Selectable<DB['agent_plans']>,
    stateVersion: number,
  ): Promise<PersistedAgentPlan> {
    const event = await executor
      .selectFrom('agent_plan_state_events')
      .selectAll()
      .where('tenant_id', '=', planRow.tenant_id)
      .where('plan_id', '=', planRow.id)
      .where('next_state_version', '=', stateVersion)
      .executeTakeFirstOrThrow();
    return this.loadAtEvent(executor, planRow, event);
  }

  private async loadAtEvent(
    executor: Executor,
    planRow: Selectable<DB['agent_plans']>,
    event: Selectable<DB['agent_plan_state_events']>,
  ): Promise<PersistedAgentPlan> {
    const definition = parseDefinition(planRow);
    const { actions, actionBindings } = await this.loadActions(executor, definition);
    validateAgentPlanActionBindings(definition, actions);
    const state = parseObject(
      event.next_state_json,
      'agent plan event state',
    ) as unknown as AgentPlanState;
    const actorAuthorization = parseObject(
      event.actor_authorization_json,
      'agent plan actor authorization',
    );
    const authorizationActor = actorAuthorization.actor;
    if (
      state.stateVersion !== safeInteger(event.next_state_version, 'agent plan event version') ||
      agentSha256(state) !== event.next_state_sha256 ||
      state.updatedAt !== iso(event.occurred_at) ||
      canonicalAgentJson(actorAuthorization) !== event.actor_authorization_json ||
      agentSha256(actorAuthorization) !== event.actor_authorization_sha256 ||
      !authorizationActor ||
      typeof authorizationActor !== 'object' ||
      Array.isArray(authorizationActor) ||
      !('type' in authorizationActor) ||
      authorizationActor.type !== event.actor_type ||
      !('tenantId' in authorizationActor) ||
      authorizationActor.tenantId !== event.tenant_id ||
      !('principalId' in authorizationActor) ||
      authorizationActor.principalId !== event.actor_principal_id
    )
      throw new Error('persisted agent plan event state binding is invalid');
    validateAgentPlanState(definition, state);
    return { definition, state, actionBindings };
  }

  private async load(
    executor: Executor,
    planRow: Selectable<DB['agent_plans']>,
  ): Promise<PersistedAgentPlan> {
    const definition = parseDefinition(planRow);
    const stateRow = await executor
      .selectFrom('agent_plan_states')
      .selectAll()
      .where('tenant_id', '=', definition.tenantId)
      .where('plan_id', '=', definition.id)
      .executeTakeFirstOrThrow();
    const { actions, actionBindings } = await this.loadActions(executor, definition);
    validateAgentPlanActionBindings(definition, actions);
    const state = parseObject(stateRow.state_json, 'agent plan state') as unknown as AgentPlanState;
    if (
      state.stateVersion !== safeInteger(stateRow.state_version, 'agent plan state version') ||
      state.status !== stateRow.status ||
      state.updatedAt !== iso(stateRow.updated_at) ||
      agentSha256(state) !== stateRow.state_sha256
    )
      throw new Error('persisted agent plan state binding is invalid');
    validateAgentPlanState(definition, state);
    return { definition, state, actionBindings };
  }

  private async loadActions(
    executor: Executor,
    definition: AgentPlanDefinition,
  ): Promise<{ actions: AgentAction[]; actionBindings: AgentPlanActionBinding[] }> {
    const bindings = await executor
      .selectFrom('agent_plan_actions')
      .selectAll()
      .where('tenant_id', '=', definition.tenantId)
      .where('plan_id', '=', definition.id)
      .orderBy('ordinal')
      .execute();
    if (bindings.length !== definition.steps.length)
      throw new Error('persisted agent plan action bindings are incomplete');
    const actionRows = await executor
      .selectFrom('agent_actions')
      .selectAll()
      .where('tenant_id', '=', definition.tenantId)
      .where(
        'id',
        'in',
        bindings.map(({ action_id }) => action_id),
      )
      .execute();
    if (actionRows.length !== bindings.length)
      throw new Error('persisted agent plan actions are incomplete');
    const actionRowsById = new Map(actionRows.map((row) => [row.id, row]));
    const actions = bindings.map((binding) => {
      const row = actionRowsById.get(binding.action_id);
      if (!row) throw new Error('persisted agent plan action is unavailable');
      return parseAction(row);
    });
    const actionBindings = bindings.map((row, ordinal) => {
      if (
        row.ordinal !== ordinal ||
        row.step_id !== definition.steps[ordinal]?.id ||
        row.action_digest !== definition.steps[ordinal]?.actionDigest
      )
        throw new Error('persisted agent plan action binding is invalid');
      return { stepId: row.step_id, actionId: row.action_id };
    });
    return { actions, actionBindings };
  }
}
