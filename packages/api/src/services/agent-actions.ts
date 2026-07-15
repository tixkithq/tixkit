import {
  AGENT_PROTOCOL_VERSION,
  agentActionDigest,
  agentSha256,
  agentExecutionIdempotencyKey,
  authorizeAgentAction,
  canonicalAgentJson,
  DurableAgentExecutionService,
  AgentExecutionConflictError,
  type AgentAction,
  type AgentApproval,
  type AgentContentPrepareResult,
  type AgentDelegationGrant,
  type AgentExecution,
  type AgentExecutionEvidence,
  type AgentEventReadResult,
  type AgentEventPrepareResult,
  type AgentEventUpdatePreview,
  type AgentPrincipal,
  type AgentReadinessReadResult,
  validateAgentEventReadResult,
  validateAgentContentPrepareResult,
  validateAgentEventPrepareResult,
  validateAgentEventUpdatePreview,
  validateAgentReadinessReadResult,
} from '@tixkit/agent-protocol';
import { AgentExecutionRepository, sql, type Database } from '@tixkit/db';
import type { Selectable, Transaction } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import {
  eventPublishReadinessSnapshotSha256,
  EventPublishAgentAdapter,
  type EventPublishAgentAdapterCheckpoints,
} from './agent-event-publish.js';
import { ReadinessService, resolvePaymentMode } from './readiness.js';
import { EventUpdateService } from './event-update.js';
import { prepareAgentEventPageContent } from './agent-content-prepare.js';

type Executor = Database | Transaction<import('@tixkit/db').DB>;
const ACTION_TTL_MILLISECONDS = 15 * 60 * 1000;
const APPROVAL_TTL_MILLISECONDS = 5 * 60 * 1000;
const SHA256 = /^[a-f0-9]{64}$/u;

type EventPublishAgentAction = AgentAction & {
  kind: 'event.publish';
  autonomy: 'execute_with_approval';
  target: AgentAction['target'] & {
    resourceType: 'event';
    apiOperation: 'events.publish';
  };
};

type ReadinessReadAgentAction = AgentAction & {
  kind: 'readiness.read';
  autonomy: 'read';
  target: AgentAction['target'] & {
    resourceType: 'event';
    apiOperation: 'events.readiness.get';
  };
};

type EventReadAgentAction = AgentAction & {
  kind: 'event.read';
  autonomy: 'read';
  target: AgentAction['target'] & {
    resourceType: 'event';
    apiOperation: 'events.get';
  };
};

type EventPrepareAgentAction = AgentAction & {
  kind: 'event.prepare';
  autonomy: 'prepare';
  target: AgentAction['target'] & {
    resourceType: 'event';
    apiOperation: 'events.prepare';
  };
};

type EventUpdateAgentAction = AgentAction & {
  kind: 'event.update';
  autonomy: 'execute_with_approval';
  target: AgentAction['target'] & {
    resourceType: 'event';
    apiOperation: 'events.update';
  };
};

type ContentPrepareAgentAction = AgentAction & {
  kind: 'content.prepare';
  autonomy: 'prepare';
  target: AgentAction['target'] & {
    resourceType: 'event';
    apiOperation: 'content.prepare';
  };
};

interface PreparedAgentActionBase {
  actionDigest: string;
  expiresAt: string;
}

interface PreparedAgentReadinessBase extends PreparedAgentActionBase {
  dryRun: {
    launchable: boolean;
    readinessSnapshotSha256: string;
    blockingReasonCodes: readonly string[];
  };
}

export interface PreparedAgentEventPublishAction extends PreparedAgentReadinessBase {
  action: EventPublishAgentAction;
  authorization: {
    eligibleForApproval: boolean;
    reasons: readonly string[];
    snapshotSha256: string;
    checkedAt: string;
  };
}

export interface PreparedAgentReadinessAction extends PreparedAgentReadinessBase {
  action: ReadinessReadAgentAction;
  authorization: {
    allowed: true;
    eligibleForApproval: false;
    reasons: readonly [];
    snapshotSha256: string;
    checkedAt: string;
  };
  result: AgentReadinessReadResult;
  resultSha256: string;
}

export interface PreparedAgentEventReadAction extends PreparedAgentActionBase {
  action: EventReadAgentAction;
  authorization: {
    allowed: true;
    eligibleForApproval: false;
    reasons: readonly [];
    snapshotSha256: string;
    checkedAt: string;
  };
  result: AgentEventReadResult;
  resultSha256: string;
}

export interface PreparedAgentEventPrepareAction extends PreparedAgentActionBase {
  action: EventPrepareAgentAction;
  authorization: {
    allowed: true;
    eligibleForApproval: false;
    reasons: readonly [];
    snapshotSha256: string;
    checkedAt: string;
  };
  result: AgentEventPrepareResult;
  resultSha256: string;
}

export interface PreparedAgentEventUpdateAction extends PreparedAgentActionBase {
  action: EventUpdateAgentAction;
  authorization: {
    eligibleForApproval: boolean;
    reasons: readonly string[];
    snapshotSha256: string;
    checkedAt: string;
  };
  preview: AgentEventUpdatePreview;
  previewSha256: string;
}

export interface PreparedAgentContentPrepareAction extends PreparedAgentActionBase {
  action: ContentPrepareAgentAction;
  authorization: {
    allowed: true;
    eligibleForApproval: false;
    reasons: readonly [];
    snapshotSha256: string;
    checkedAt: string;
  };
  result: AgentContentPrepareResult;
  resultSha256: string;
}

export type PreparedAgentAction =
  | PreparedAgentEventPublishAction
  | PreparedAgentReadinessAction
  | PreparedAgentEventReadAction
  | PreparedAgentEventPrepareAction
  | PreparedAgentContentPrepareAction
  | PreparedAgentEventUpdateAction;

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

function retryableTransactionConflict(error: unknown): boolean {
  const item = error as {
    code?: string;
    errno?: number;
    number?: number;
    cause?: { code?: string; errno?: number; number?: number };
  };
  const code = item.code ?? item.cause?.code;
  const errno = item.errno ?? item.cause?.errno;
  const number = item.number ?? item.cause?.number;
  return (
    code === '23505' ||
    code === '40001' ||
    code === '40P01' ||
    code === 'ER_DUP_ENTRY' ||
    code === 'ER_LOCK_DEADLOCK' ||
    errno === 1062 ||
    errno === 1213 ||
    number === 1205 ||
    number === 2601 ||
    number === 2627
  );
}

async function executeAgentActionTransaction<T>(
  db: Database,
  operation: (tx: Transaction<import('@tixkit/db').DB>) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await db.transaction().setIsolationLevel('serializable').execute(operation);
    } catch (error) {
      if (attempt === 4 || !retryableTransactionConflict(error)) throw error;
    }
  }
  throw new Error('AGENT_ACTION_TRANSACTION_RETRY_EXHAUSTED');
}

function stableId(
  prefix: 'act' | 'aevt' | 'apr' | 'exec' | 'aaud' | 'worker',
  ...parts: readonly string[]
): string {
  const digest = createHash('sha256').update(parts.join('\0')).digest('hex');
  return `${prefix}_${digest.slice(0, 48)}`;
}

function requestFingerprint(input: {
  kind:
    | 'event.publish'
    | 'event.read'
    | 'readiness.read'
    | 'event.prepare'
    | 'content.prepare'
    | 'event.update';
  delegationGrantId: string;
  resourceId: string;
  changes?: Readonly<Record<string, unknown>>;
  content?: unknown;
}): string {
  if (input.kind !== 'content.prepare') return agentSha256(input);
  let content: unknown;
  try {
    content = JSON.parse(JSON.stringify(input.content));
  } catch {
    throw new Error('AGENT_ACTION_CONTENT_INVALID');
  }
  return agentSha256({ ...input, content });
}

interface PrepareAgentActionInput {
  tenantId: string;
  agentPrincipalId: string;
  idempotencyKey: string;
  delegationGrantId: string;
  resourceId: string;
}

type PrepareEventPublishActionInput = PrepareAgentActionInput & {
  kind: 'event.publish';
};
type PrepareEventReadActionInput = PrepareAgentActionInput & {
  kind: 'event.read';
};
type PrepareReadinessActionInput = PrepareAgentActionInput & {
  kind: 'readiness.read';
};
type PrepareEventPrepareActionInput = PrepareAgentActionInput & {
  kind: 'event.prepare';
  changes: Readonly<Record<string, unknown>>;
};
type PrepareEventUpdateActionInput = PrepareAgentActionInput & {
  kind: 'event.update';
  changes: Readonly<Record<string, unknown>>;
};
type PrepareContentActionInput = PrepareAgentActionInput & {
  kind: 'content.prepare';
  content: unknown;
};

function eventReadProjection(event: {
  title: string;
  description: string | null;
  status: string;
  currency: string;
  timezone: string;
  starts_at: Date | string;
  ends_at: Date | string | null;
  visibility: string;
  capacity: number | null;
  minimum_age: number | null;
}): AgentEventReadResult['event'] {
  return {
    title: event.title,
    description: event.description,
    status: event.status as AgentEventReadResult['event']['status'],
    currency: event.currency,
    timezone: event.timezone,
    startsAt: iso(event.starts_at),
    endsAt: event.ends_at === null ? null : iso(event.ends_at),
    visibility: event.visibility as AgentEventReadResult['event']['visibility'],
    capacity: event.capacity === null ? null : safeInteger(event.capacity, 'event capacity'),
    minimumAge:
      event.minimum_age === null ? null : safeInteger(event.minimum_age, 'event minimum age'),
  };
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
  constructor(
    private readonly db: Database,
    private readonly eventPublishCheckpoints: EventPublishAgentAdapterCheckpoints = {},
  ) {}

  async prepare(input: PrepareEventPublishActionInput): Promise<PreparedAgentEventPublishAction>;
  async prepare(input: PrepareEventReadActionInput): Promise<PreparedAgentEventReadAction>;
  async prepare(input: PrepareReadinessActionInput): Promise<PreparedAgentReadinessAction>;
  async prepare(input: PrepareEventPrepareActionInput): Promise<PreparedAgentEventPrepareAction>;
  async prepare(input: PrepareContentActionInput): Promise<PreparedAgentContentPrepareAction>;
  async prepare(input: PrepareEventUpdateActionInput): Promise<PreparedAgentEventUpdateAction>;
  async prepare(
    input:
      | PrepareEventPublishActionInput
      | PrepareEventReadActionInput
      | PrepareReadinessActionInput
      | PrepareEventPrepareActionInput
      | PrepareContentActionInput
      | PrepareEventUpdateActionInput,
  ): Promise<PreparedAgentAction> {
    const fingerprint = requestFingerprint(input);
    return executeAgentActionTransaction(this.db, async (tx) => {
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
        await this.assertDirectAuthorizationEvidence(tx, replay);
        const prepared = this.fromRow(replay);
        if (
          prepared.action.kind !== 'event.publish' &&
          prepared.action.kind !== 'event.update' &&
          !(await this.isCurrentlyReadable(tx, prepared, await databaseNow(tx)))
        )
          throw new Error('AGENT_ACTION_RESOURCE_DENIED');
        return prepared;
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
      const requiredCapability =
        input.kind === 'event.publish' || input.kind === 'event.update'
          ? 'events.execute'
          : input.kind === 'event.read'
            ? 'events.read'
            : input.kind === 'event.prepare'
              ? 'events.prepare'
              : input.kind === 'content.prepare'
                ? 'content.prepare'
                : 'readiness.read';
      if (
        principal.state !== 'active' ||
        principal.protocolVersion !== AGENT_PROTOCOL_VERSION ||
        !principal.capabilities.includes(requiredCapability)
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
        !delegation.capabilities.includes(requiredCapability) ||
        !delegation.resourceScopes.includes(`event:${input.resourceId}`) ||
        delegation.revokedAt ||
        new Date(delegation.issuedAt).getTime() > now.getTime() ||
        new Date(delegation.expiresAt).getTime() <= now.getTime()
      )
        throw new Error('AGENT_ACTION_DELEGATION_DENIED');
      const event = await tx
        .selectFrom('events')
        .select([
          'id',
          'organization_id',
          'brand_id',
          'version',
          'title',
          'description',
          'status',
          'currency',
          'timezone',
          'starts_at',
          'ends_at',
          'visibility',
          'capacity',
          'minimum_age',
          'slug',
          'cover_image_url',
        ])
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
        .where(
          'permission',
          '=',
          input.kind === 'event.publish' ||
            input.kind === 'event.prepare' ||
            input.kind === 'content.prepare' ||
            input.kind === 'event.update'
            ? 'events.write'
            : 'events.read',
        )
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
      if (
        input.kind !== 'event.publish' &&
        input.kind !== 'event.update' &&
        (!policy.allowed || !policy.risk_allowed)
      )
        throw new Error('AGENT_ACTION_RESOURCE_DENIED');
      const readiness =
        input.kind === 'event.read' ||
        input.kind === 'event.prepare' ||
        input.kind === 'content.prepare' ||
        input.kind === 'event.update'
          ? undefined
          : await new ReadinessService(
              tx as Database,
              resolvePaymentMode(),
            ).getEventLaunchReadiness({
              tenantId: input.tenantId,
              organizationId: event.organization_id,
              brandId: event.brand_id,
              eventId: event.id,
              permissions: new Set([
                input.kind === 'event.publish' ? 'events.write' : 'events.read',
              ]),
            });
      const readinessSnapshotSha256 = readiness
        ? eventPublishReadinessSnapshotSha256(readiness)
        : undefined;
      const eventProjection = input.kind === 'event.read' ? eventReadProjection(event) : undefined;
      const eventSnapshotSha256 = eventProjection ? agentSha256(eventProjection) : undefined;
      const resolvedEventPatch =
        input.kind === 'event.prepare' || input.kind === 'event.update'
          ? await new EventUpdateService(tx as Database).resolvePatch({
              tenantId: input.tenantId,
              eventId: event.id,
              patch: {
                ...input.changes,
                expectedVersion: safeInteger(event.version, 'event version'),
              },
            })
          : undefined;
      const changePreview = resolvedEventPatch
        ? {
            resourceId: event.id,
            resourceVersion: safeInteger(event.version, 'event version'),
            changedFields: resolvedEventPatch.requestedFields,
            before: resolvedEventPatch.before,
            after: resolvedEventPatch.after,
          }
        : undefined;
      const changePreviewSha256 = changePreview ? agentSha256(changePreview) : undefined;
      const preparedContent =
        input.kind === 'content.prepare'
          ? prepareAgentEventPageContent({
              event: {
                id: event.id,
                slug: event.slug,
                title: event.title,
                description: event.description,
                startsAt: iso(event.starts_at),
                endsAt: event.ends_at === null ? null : iso(event.ends_at),
                timezone: event.timezone,
                coverImageUrl: event.cover_image_url,
              },
              content: input.content,
            })
          : undefined;
      if (
        input.kind === 'event.update' &&
        changePreview &&
        agentSha256(changePreview.before) === agentSha256(changePreview.after)
      )
        throw new Error('AGENT_ACTION_NO_MATERIAL_CHANGE');
      const action: AgentAction = {
        id: stableId('act', input.tenantId, input.agentPrincipalId, input.idempotencyKey),
        protocolVersion: AGENT_PROTOCOL_VERSION,
        agentPrincipalId: input.agentPrincipalId,
        sponsorPrincipalId: principal.sponsorPrincipalId,
        delegationGrantId: input.delegationGrantId,
        kind: input.kind,
        autonomy:
          input.kind === 'event.publish' || input.kind === 'event.update'
            ? 'execute_with_approval'
            : input.kind === 'event.prepare'
              ? 'prepare'
              : input.kind === 'content.prepare'
                ? 'prepare'
                : 'read',
        target: {
          tenantId: input.tenantId,
          resourceType: 'event',
          resourceId: event.id,
          resourceVersion: safeInteger(event.version, 'event version'),
          apiOperation:
            input.kind === 'event.publish'
              ? 'events.publish'
              : input.kind === 'event.update'
                ? 'events.update'
                : input.kind === 'event.read'
                  ? 'events.get'
                  : input.kind === 'event.prepare'
                    ? 'events.prepare'
                    : input.kind === 'content.prepare'
                      ? 'content.prepare'
                      : 'events.readiness.get',
        },
        payload:
          input.kind === 'event.read'
            ? { eventSnapshotSha256 }
            : input.kind === 'event.prepare' || input.kind === 'event.update'
              ? { changePreviewSha256, changes: resolvedEventPatch!.after }
              : input.kind === 'content.prepare'
                ? preparedContent!
                : { readinessSnapshotSha256 },
        idempotencyKey: input.idempotencyKey,
        expectedPolicyVersion: safeInteger(policy.policy_version, 'agent policy version'),
        preparedAt: now.toISOString(),
      };
      const actionDigest = agentActionDigest(action);
      const sponsorPermissions = [
        input.kind === 'event.publish'
          ? 'events:publish'
          : input.kind === 'event.prepare' || input.kind === 'event.update'
            ? 'events:write'
            : input.kind === 'content.prepare'
              ? 'events:write'
              : 'events:read',
      ];
      const decision = authorizeAgentAction({
        principal,
        delegation,
        action,
        actionDigest,
        sponsorPermissions,
        tenantAllowedActions: policy.allowed && policy.risk_allowed ? [input.kind] : [],
        currentResourceVersion: action.target.resourceVersion,
        currentPolicyVersion: action.expectedPolicyVersion,
        now: now.toISOString(),
      });
      const authorizationReasons =
        input.kind === 'event.publish'
          ? [
              ...new Set([
                ...decision.reasons,
                ...(readiness?.launchable ? [] : ['event_not_ready']),
              ]),
            ]
          : [...decision.reasons];
      if (input.kind !== 'event.publish' && input.kind !== 'event.update' && !decision.allowed)
        throw new Error('AGENT_ACTION_RESOURCE_DENIED');
      const eligibleForApproval =
        (input.kind === 'event.publish' || input.kind === 'event.update') &&
        (input.kind !== 'event.publish' || readiness?.launchable === true) &&
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
        materialSnapshotSha256:
          preparedContent?.contentPreviewSha256 ??
          changePreviewSha256 ??
          eventSnapshotSha256 ??
          readinessSnapshotSha256,
        checkedAt: now.toISOString(),
      });
      const expiresAt = new Date(
        Math.min(now.getTime() + ACTION_TTL_MILLISECONDS, new Date(delegation.expiresAt).getTime()),
      );
      const dryRun: PreparedAgentReadinessBase['dryRun'] | AgentEventUpdatePreview | undefined =
        readiness
          ? {
              launchable: readiness.launchable,
              readinessSnapshotSha256: readinessSnapshotSha256!,
              blockingReasonCodes: [
                ...new Set(readiness.requiredBlockers.flatMap((step) => step.reasonCodes)),
              ],
            }
          : input.kind === 'event.update' && changePreview && changePreviewSha256
            ? {
                resourceId: changePreview.resourceId,
                resourceVersion: changePreview.resourceVersion,
                changePreviewSha256,
                changedFields: changePreview.changedFields,
                before: changePreview.before,
                after: changePreview.after,
                observedAt: now.toISOString(),
                untrustedContentPaths: changePreview.changedFields.flatMap((field) => [
                  `before.${field}`,
                  `after.${field}`,
                ]),
              }
            : undefined;
      const result:
        | AgentReadinessReadResult
        | AgentEventReadResult
        | AgentEventPrepareResult
        | AgentContentPrepareResult
        | undefined =
        input.kind === 'readiness.read' && readiness && readinessSnapshotSha256
          ? {
              resourceId: event.id,
              resourceVersion: action.target.resourceVersion,
              status: readiness.launchable ? 'ready' : 'blocked',
              readinessSnapshotSha256,
              generatedAt: readiness.generatedAt,
              published: readiness.published,
              blockerReasonCodes: [
                ...new Set(readiness.requiredBlockers.flatMap((step) => step.reasonCodes)),
              ],
              warningReasonCodes: [
                ...new Set(readiness.recommendedWarnings.flatMap((step) => step.reasonCodes)),
              ],
            }
          : input.kind === 'event.read' && eventProjection && eventSnapshotSha256
            ? {
                resourceId: event.id,
                resourceVersion: action.target.resourceVersion,
                eventSnapshotSha256,
                observedAt: now.toISOString(),
                event: eventProjection,
                untrustedContentPaths: ['event.title', 'event.description'],
              }
            : input.kind === 'event.prepare' && changePreview && changePreviewSha256
              ? {
                  ...changePreview,
                  changePreviewSha256,
                  observedAt: now.toISOString(),
                  untrustedContentPaths: changePreview.changedFields.flatMap((field) => [
                    `before.${field}`,
                    `after.${field}`,
                  ]),
                }
              : input.kind === 'content.prepare' && preparedContent
                ? {
                    resourceId: event.id,
                    resourceVersion: action.target.resourceVersion,
                    ...preparedContent,
                    observedAt: now.toISOString(),
                    untrustedContentPaths: ['content', 'preview.discovery'] as const,
                  }
                : undefined;
      if (result) {
        if (action.kind === 'event.read')
          validateAgentEventReadResult(action, result as AgentEventReadResult);
        else if (action.kind === 'event.prepare')
          validateAgentEventPrepareResult(action, result as AgentEventPrepareResult);
        else if (action.kind === 'content.prepare')
          validateAgentContentPrepareResult(action, result as AgentContentPrepareResult);
        else validateAgentReadinessReadResult(action, result as AgentReadinessReadResult);
      }
      if (action.kind === 'event.update' && dryRun)
        validateAgentEventUpdatePreview(action, dryRun as AgentEventUpdatePreview);
      const resultSha256 = result ? agentSha256(result) : undefined;
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
          dry_run_json: canonicalAgentJson(
            dryRun ??
              (action.kind === 'event.prepare'
                ? { changePreviewSha256: changePreviewSha256! }
                : action.kind === 'content.prepare'
                  ? {
                      contentPreviewSha256: preparedContent!.contentPreviewSha256,
                    }
                  : { eventSnapshotSha256: eventSnapshotSha256! }),
          ),
          result_json: result ? canonicalAgentJson(result) : null,
          result_sha256: resultSha256 ?? null,
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
          phase:
            input.kind === 'event.publish' || input.kind === 'event.update'
              ? 'prepared'
              : 'succeeded',
          approval_id: null,
          execution_id: null,
          idempotency_key: input.idempotencyKey,
          request_fingerprint: fingerprint,
          authorization_sha256: authorizationSnapshotSha256,
          outcome:
            input.kind !== 'event.publish' && input.kind !== 'event.update'
              ? 'succeeded'
              : eligibleForApproval
                ? 'approval_required'
                : 'denied',
          occurred_at: now,
        })
        .execute();
      const common = {
        actionDigest,
        expiresAt: expiresAt.toISOString(),
      };
      if (result && resultSha256 && action.kind === 'event.read')
        return {
          ...common,
          action: action as EventReadAgentAction,
          authorization: {
            allowed: true as const,
            eligibleForApproval: false as const,
            reasons: [] as const,
            snapshotSha256: authorizationSnapshotSha256,
            checkedAt: now.toISOString(),
          },
          result: result as AgentEventReadResult,
          resultSha256,
        };
      if (result && resultSha256 && action.kind === 'event.prepare')
        return {
          ...common,
          action: action as EventPrepareAgentAction,
          authorization: {
            allowed: true as const,
            eligibleForApproval: false as const,
            reasons: [] as const,
            snapshotSha256: authorizationSnapshotSha256,
            checkedAt: now.toISOString(),
          },
          result: result as AgentEventPrepareResult,
          resultSha256,
        };
      if (result && resultSha256 && action.kind === 'content.prepare')
        return {
          ...common,
          action: action as ContentPrepareAgentAction,
          authorization: {
            allowed: true as const,
            eligibleForApproval: false as const,
            reasons: [] as const,
            snapshotSha256: authorizationSnapshotSha256,
            checkedAt: now.toISOString(),
          },
          result: result as AgentContentPrepareResult,
          resultSha256,
        };
      if (action.kind === 'event.update' && dryRun)
        return {
          ...common,
          preview: dryRun as AgentEventUpdatePreview,
          previewSha256: agentSha256(dryRun as AgentEventUpdatePreview),
          action: action as EventUpdateAgentAction,
          authorization: {
            eligibleForApproval,
            reasons: authorizationReasons,
            snapshotSha256: authorizationSnapshotSha256,
            checkedAt: now.toISOString(),
          },
        };
      if (result && resultSha256 && action.kind === 'readiness.read' && dryRun)
        return {
          ...common,
          dryRun: dryRun as PreparedAgentReadinessBase['dryRun'],
          action: action as ReadinessReadAgentAction,
          authorization: {
            allowed: true as const,
            eligibleForApproval: false as const,
            reasons: [] as const,
            snapshotSha256: authorizationSnapshotSha256,
            checkedAt: now.toISOString(),
          },
          result: result as AgentReadinessReadResult,
          resultSha256,
        };
      if (!dryRun) throw new Error('AGENT_ACTION_PREVIEW_UNAVAILABLE');
      return {
        ...common,
        dryRun: dryRun as PreparedAgentReadinessBase['dryRun'],
        action: action as EventPublishAgentAction,
        authorization: {
          eligibleForApproval,
          reasons: authorizationReasons,
          snapshotSha256: authorizationSnapshotSha256,
          checkedAt: now.toISOString(),
        },
      };
    });
  }

  async getForAgent(input: {
    tenantId: string;
    agentPrincipalId: string;
    actionId: string;
  }): Promise<PreparedAgentAction | undefined> {
    return executeAgentActionTransaction(this.db, async (tx) => {
      const tenant = await tx
        .selectFrom('tenants')
        .select('id')
        .where('id', '=', input.tenantId)
        .forUpdate()
        .executeTakeFirst();
      if (!tenant) return undefined;
      const row = await tx
        .selectFrom('agent_actions')
        .selectAll()
        .where('tenant_id', '=', input.tenantId)
        .where('agent_principal_id', '=', input.agentPrincipalId)
        .where('id', '=', input.actionId)
        .forUpdate()
        .executeTakeFirst();
      if (!row) return undefined;
      await this.assertDirectAuthorizationEvidence(tx, row);
      const prepared = this.fromRow(row);
      if (
        prepared.action.kind !== 'event.publish' &&
        prepared.action.kind !== 'event.update' &&
        !(await this.isCurrentlyReadable(tx, prepared, await databaseNow(tx)))
      )
        return undefined;
      return prepared;
    });
  }

  async getExecutionForAgent(input: {
    tenantId: string;
    agentPrincipalId: string;
    actionId: string;
    executionId: string;
  }): Promise<AgentExecutionEvidence | undefined> {
    return new AgentExecutionRepository(this.db).getExecutionEvidence(input);
  }

  async getExecutionForSponsor(input: {
    tenantId: string;
    sponsorPrincipalId: string;
    actionId: string;
    executionId: string;
  }): Promise<AgentExecutionEvidence | undefined> {
    return new AgentExecutionRepository(this.db).getExecutionEvidence(input);
  }

  async getForSponsor(input: {
    tenantId: string;
    sponsorPrincipalId: string;
    actionId: string;
  }): Promise<PreparedAgentAction | undefined> {
    return executeAgentActionTransaction(this.db, async (tx) => {
      const tenant = await tx
        .selectFrom('tenants')
        .select('id')
        .where('id', '=', input.tenantId)
        .forUpdate()
        .executeTakeFirst();
      if (!tenant) return undefined;
      const row = await tx
        .selectFrom('agent_actions')
        .selectAll()
        .where('tenant_id', '=', input.tenantId)
        .where('sponsor_principal_id', '=', input.sponsorPrincipalId)
        .where('id', '=', input.actionId)
        .forUpdate()
        .executeTakeFirst();
      if (!row) return undefined;
      await this.assertDirectAuthorizationEvidence(tx, row);
      const action = this.fromRow(row);
      const authorized =
        action.action.kind !== 'event.publish' && action.action.kind !== 'event.update'
          ? await this.isCurrentlyReadable(tx, action, await databaseNow(tx))
          : await this.hasLiveSponsorAuthority(
              tx,
              input.tenantId,
              input.sponsorPrincipalId,
              action.action.target.resourceId,
              'events.write',
            );
      return authorized ? action : undefined;
    });
  }

  async approve(input: {
    tenantId: string;
    approverPrincipalId: string;
    actionId: string;
    actionDigest: string;
    planSha256?: string;
    idempotencyKey: string;
    expectedActionKind?: 'event.publish' | 'event.update';
  }): Promise<AgentApproval> {
    const fingerprint = agentSha256({
      actionId: input.actionId,
      actionDigest: input.actionDigest,
      planSha256: input.planSha256 ?? null,
    });
    return executeAgentActionTransaction(this.db, async (tx) => {
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
      if (prepared.action.kind !== 'event.publish' && prepared.action.kind !== 'event.update')
        throw new Error('AGENT_ACTION_NOT_APPROVABLE');
      if (input.expectedActionKind && prepared.action.kind !== input.expectedActionKind)
        throw new Error('AGENT_ACTION_APPROVAL_SCOPE_DENIED');
      if (prepared.actionDigest !== input.actionDigest)
        throw new Error('AGENT_ACTION_APPROVAL_DIGEST_MISMATCH');
      const now = await databaseNow(tx);
      let planExpiresAt: Date | undefined;
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
          'plan.plan_json',
          'plan.expires_at',
          'binding.action_digest',
          'binding.step_id',
          'state.status',
          'state.state_json',
        ])
        .where('plan.tenant_id', '=', input.tenantId)
        .where('plan.sponsor_principal_id', '=', input.approverPrincipalId)
        .where('binding.action_id', '=', input.actionId)
        .forUpdate()
        .executeTakeFirst();
      const planStepState = plan
        ? (() => {
            const state: unknown = JSON.parse(plan.state_json);
            if (!state || typeof state !== 'object' || Array.isArray(state)) return undefined;
            const stepStates = (state as { stepStates?: unknown }).stepStates;
            if (!Array.isArray(stepStates)) return undefined;
            return stepStates.find(
              (step): step is { stepId: string; status: string } =>
                Boolean(step) &&
                typeof step === 'object' &&
                !Array.isArray(step) &&
                (step as { stepId?: unknown }).stepId === plan.step_id &&
                typeof (step as { status?: unknown }).status === 'string',
            );
          })()
        : undefined;
      const dependenciesSucceeded = plan
        ? (() => {
            const definition: unknown = JSON.parse(plan.plan_json);
            const state: unknown = JSON.parse(plan.state_json);
            if (
              !definition ||
              typeof definition !== 'object' ||
              Array.isArray(definition) ||
              !state ||
              typeof state !== 'object' ||
              Array.isArray(state)
            )
              return false;
            const steps = (definition as { steps?: unknown }).steps;
            const stepStates = (state as { stepStates?: unknown }).stepStates;
            if (!Array.isArray(steps) || !Array.isArray(stepStates)) return false;
            const definitionStep = steps.find(
              (step) =>
                Boolean(step) &&
                typeof step === 'object' &&
                !Array.isArray(step) &&
                (step as { id?: unknown }).id === plan.step_id,
            ) as { dependsOnStepIds?: unknown } | undefined;
            if (
              !definitionStep ||
              !Array.isArray(definitionStep.dependsOnStepIds) ||
              definitionStep.dependsOnStepIds.some((dependency) => typeof dependency !== 'string')
            )
              return false;
            const statuses = new Map(
              stepStates.flatMap((step) =>
                step &&
                typeof step === 'object' &&
                !Array.isArray(step) &&
                typeof (step as { stepId?: unknown }).stepId === 'string' &&
                typeof (step as { status?: unknown }).status === 'string'
                  ? [
                      [
                        (step as { stepId: string }).stepId,
                        (step as { status: string }).status,
                      ] as const,
                    ]
                  : [],
              ),
            );
            return definitionStep.dependsOnStepIds.every(
              (dependency) => statuses.get(dependency as string) === 'succeeded',
            );
          })()
        : true;
      const invalidPlanBinding =
        Boolean(plan) !== Boolean(input.planSha256) ||
        (plan &&
          (plan.plan_sha256 !== input.planSha256 ||
            plan.action_digest !== input.actionDigest ||
            new Date(plan.expires_at).getTime() <= now.getTime() ||
            plan.status !== 'awaiting_approval' ||
            planStepState?.status !== 'awaiting_approval' ||
            !dependenciesSucceeded));
      if (plan) planExpiresAt = new Date(plan.expires_at);
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
          replayed.planSha256 !== input.planSha256 ||
          replayed.approverPrincipalId !== input.approverPrincipalId ||
          replayed.policyVersion !== prepared.action.expectedPolicyVersion ||
          replayed.approverPermissionSnapshot.length !== 1 ||
          replayed.approverPermissionSnapshot[0] !==
            (prepared.action.kind === 'event.publish' ? 'events:publish' : 'events:write')
        )
          throw new Error('persisted agent approval binding is invalid');
        return replayed;
      }
      if (invalidPlanBinding) throw new Error('AGENT_ACTION_APPROVAL_PLAN_BINDING_INVALID');
      const actionAuthorizationSha256 = await this.assertCurrentlyApprovable(
        tx,
        prepared,
        input.approverPrincipalId,
        now,
      );
      const authorizationSha256 = agentSha256({
        actionAuthorizationSha256,
        planSha256: input.planSha256 ?? null,
      });
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
          planExpiresAt?.getTime() ?? Number.POSITIVE_INFINITY,
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
        ...(input.planSha256 ? { planSha256: input.planSha256 } : {}),
        approverPrincipalId: input.approverPrincipalId,
        approverPermissionSnapshot: [
          prepared.action.kind === 'event.publish' ? 'events:publish' : 'events:write',
        ],
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
          plan_sha256: input.planSha256 ?? null,
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

  async revokeApproval(input: {
    tenantId: string;
    sponsorPrincipalId: string;
    actionId: string;
    approvalId: string;
    actionDigest: string;
    idempotencyKey: string;
    expectedActionKind?: 'event.publish' | 'event.update';
  }): Promise<AgentApproval> {
    const fingerprint = agentSha256({
      actionId: input.actionId,
      approvalId: input.approvalId,
      actionDigest: input.actionDigest,
      operation: 'revoke',
    });
    return executeAgentActionTransaction(this.db, async (tx) => {
      await tx
        .selectFrom('tenants')
        .select('id')
        .where('id', '=', input.tenantId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const action = await tx
        .selectFrom('agent_actions')
        .selectAll()
        .where('tenant_id', '=', input.tenantId)
        .where('id', '=', input.actionId)
        .where('sponsor_principal_id', '=', input.sponsorPrincipalId)
        .forUpdate()
        .executeTakeFirst();
      if (!action) throw new Error('AGENT_ACTION_APPROVAL_SCOPE_DENIED');
      const prepared = this.fromRow(action);
      if (input.expectedActionKind && prepared.action.kind !== input.expectedActionKind)
        throw new Error('AGENT_ACTION_APPROVAL_SCOPE_DENIED');
      if (prepared.actionDigest !== input.actionDigest)
        throw new Error('AGENT_ACTION_APPROVAL_DIGEST_MISMATCH');
      const replay = await tx
        .selectFrom('agent_action_events')
        .selectAll()
        .where('tenant_id', '=', input.tenantId)
        .where('actor_principal_id', '=', input.sponsorPrincipalId)
        .where('phase', '=', 'revoked')
        .where('idempotency_key', '=', input.idempotencyKey)
        .forUpdate()
        .executeTakeFirst();
      if (replay) {
        if (
          replay.request_fingerprint !== fingerprint ||
          replay.action_id !== input.actionId ||
          replay.action_digest !== input.actionDigest ||
          replay.approval_id !== input.approvalId
        )
          throw new Error('AGENT_ACTION_APPROVAL_IDEMPOTENCY_CONFLICT');
        const approval = await tx
          .selectFrom('agent_approvals')
          .selectAll()
          .where('tenant_id', '=', input.tenantId)
          .where('id', '=', input.approvalId)
          .where('action_id', '=', input.actionId)
          .executeTakeFirstOrThrow();
        const replayed = this.approvalFromRow(approval);
        if (
          replayed.actionDigest !== input.actionDigest ||
          replayed.approverPrincipalId !== input.sponsorPrincipalId ||
          !replayed.revokedAt
        )
          throw new Error('persisted agent approval revocation binding is invalid');
        return replayed;
      }
      const approval = await tx
        .selectFrom('agent_approvals')
        .selectAll()
        .where('tenant_id', '=', input.tenantId)
        .where('id', '=', input.approvalId)
        .where('action_id', '=', input.actionId)
        .where('action_digest', '=', input.actionDigest)
        .where('approver_principal_id', '=', input.sponsorPrincipalId)
        .forUpdate()
        .executeTakeFirst();
      if (!approval) throw new Error('AGENT_ACTION_APPROVAL_SCOPE_DENIED');
      if (approval.consumed_at) throw new Error('AGENT_ACTION_APPROVAL_ALREADY_CONSUMED');
      if (approval.revoked_at) throw new Error('AGENT_ACTION_APPROVAL_ALREADY_REVOKED');
      const now = await databaseNow(tx);
      await tx
        .updateTable('agent_approvals')
        .set({ revoked_at: now })
        .where('tenant_id', '=', input.tenantId)
        .where('id', '=', input.approvalId)
        .where('revoked_at', 'is', null)
        .where('consumed_at', 'is', null)
        .executeTakeFirstOrThrow();
      const revoked = this.approvalFromRow({ ...approval, revoked_at: now });
      await tx
        .insertInto('agent_action_events')
        .values({
          id: stableId('aevt', input.actionId, input.approvalId, 'revoked'),
          tenant_id: input.tenantId,
          action_id: input.actionId,
          action_digest: input.actionDigest,
          agent_principal_id: prepared.action.agentPrincipalId,
          sponsor_principal_id: prepared.action.sponsorPrincipalId,
          actor_type: 'user',
          actor_principal_id: input.sponsorPrincipalId,
          phase: 'revoked',
          approval_id: input.approvalId,
          execution_id: null,
          idempotency_key: input.idempotencyKey,
          request_fingerprint: fingerprint,
          authorization_sha256: agentSha256({
            tenantId: input.tenantId,
            sponsorPrincipalId: input.sponsorPrincipalId,
            actionId: input.actionId,
            approvalId: input.approvalId,
            actionDigest: input.actionDigest,
          }),
          outcome: 'revoked',
          occurred_at: now,
        })
        .execute();
      return revoked;
    });
  }

  async execute(input: {
    tenantId: string;
    agentPrincipalId: string;
    actionId: string;
    approvalId: string;
    actionDigest: string;
    expectedActionKind?: 'event.publish' | 'event.update';
  }): Promise<AgentExecution> {
    const prepared = await this.getForAgent({
      tenantId: input.tenantId,
      agentPrincipalId: input.agentPrincipalId,
      actionId: input.actionId,
    });
    if (!prepared) throw new Error('AGENT_ACTION_EXECUTION_SCOPE_DENIED');
    if (prepared.action.kind !== 'event.publish' && prepared.action.kind !== 'event.update')
      throw new Error('AGENT_ACTION_EXECUTION_SCOPE_DENIED');
    if (input.expectedActionKind && prepared.action.kind !== input.expectedActionKind)
      throw new Error('AGENT_ACTION_EXECUTION_SCOPE_DENIED');
    if (prepared.actionDigest !== input.actionDigest)
      throw new Error('AGENT_ACTION_EXECUTION_DIGEST_MISMATCH');
    const approvalRow = await this.db
      .selectFrom('agent_approvals')
      .selectAll()
      .where('tenant_id', '=', input.tenantId)
      .where('id', '=', input.approvalId)
      .where('action_id', '=', input.actionId)
      .where('action_digest', '=', input.actionDigest)
      .where('approver_principal_id', '=', prepared.action.sponsorPrincipalId)
      .executeTakeFirst();
    if (!approvalRow) throw new Error('AGENT_ACTION_EXECUTION_SCOPE_DENIED');
    const executionId = stableId('exec', input.tenantId, input.actionId, input.approvalId);
    const now = new Date().toISOString();
    const probe: AgentExecution = {
      id: executionId,
      tenantId: input.tenantId,
      actionId: input.actionId,
      actionDigest: input.actionDigest,
      ...(approvalRow.plan_sha256 ? { planSha256: approvalRow.plan_sha256 } : {}),
      agentPrincipalId: input.agentPrincipalId,
      sponsorPrincipalId: prepared.action.sponsorPrincipalId,
      delegationGrantId: prepared.action.delegationGrantId,
      approvalId: input.approvalId,
      idempotencyKey: agentExecutionIdempotencyKey(prepared.action),
      requestFingerprint: agentSha256({
        actionDigest: input.actionDigest,
        idempotencyKey: agentExecutionIdempotencyKey(prepared.action),
        tenantId: input.tenantId,
      }),
      state: 'reserved',
      resourceVersion: prepared.action.target.resourceVersion,
      policyVersion: prepared.action.expectedPolicyVersion,
      fenceToken: 0,
      createdAt: now,
      updatedAt: now,
    };
    const repository = new AgentExecutionRepository(this.db);
    const adapter = new EventPublishAgentAdapter(this.db, this.eventPublishCheckpoints);
    const executionService = new DurableAgentExecutionService(
      repository,
      adapter,
      { now: () => new Date() },
      {
        executionId: () => executionId,
        auditId: () => stableId('aaud', executionId, randomUUID()),
      },
      adapter,
    );
    const existing = await repository.getExecution(input.tenantId, executionId);
    if (existing) {
      if (
        existing.actionId !== probe.actionId ||
        existing.actionDigest !== probe.actionDigest ||
        existing.planSha256 !== probe.planSha256 ||
        existing.agentPrincipalId !== probe.agentPrincipalId ||
        existing.sponsorPrincipalId !== probe.sponsorPrincipalId ||
        existing.delegationGrantId !== probe.delegationGrantId ||
        existing.approvalId !== probe.approvalId ||
        existing.idempotencyKey !== probe.idempotencyKey ||
        existing.requestFingerprint !== probe.requestFingerprint ||
        existing.resourceVersion !== probe.resourceVersion ||
        existing.policyVersion !== probe.policyVersion ||
        !approvalRow.consumed_at ||
        approvalRow.consumed_execution_id !== existing.id ||
        approvalRow.revoked_at
      )
        throw new AgentExecutionConflictError('persisted agent execution binding is invalid');
      if (['succeeded', 'failed', 'compensated'].includes(existing.state)) return existing;
      await this.eventPublishCheckpoints.beforeExecutionRun?.();
      const completed = await executionService.run({
        action: prepared.action,
        execution: existing,
        workerId: stableId('worker', executionId),
      });
      return (await repository.getExecution(input.tenantId, executionId)) ?? completed;
    }
    let current: Awaited<ReturnType<EventPublishAgentAdapter['load']>>;
    try {
      current = await adapter.load({
        action: prepared.action,
        execution: probe,
      });
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
      if (
        code === 'AGENT_AUTHORIZATION_CHANGED' ||
        code === 'AGENT_STATE_INVALID' ||
        code === 'AGENT_OPERATION_DENIED'
      )
        throw new AgentExecutionConflictError('agent execution authorization state changed');
      throw error;
    }
    let reserved: AgentExecution;
    try {
      reserved = await executionService.reserve({
        principal: current.principal,
        delegation: current.delegation,
        action: prepared.action,
        actionDigest: prepared.actionDigest,
        sponsorPermissions: current.sponsorPermissions,
        tenantAllowedActions: current.riskPolicyAllowed ? current.tenantAllowedActions : [],
        currentResourceVersion: current.currentResourceVersion,
        currentPolicyVersion: current.currentPolicyVersion,
        now: current.observedAt,
        approval: this.approvalFromRow(approvalRow),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (
        message === 'AGENT_APPROVAL_INVALID' ||
        message === 'AGENT_APPROVAL_CONSUMED' ||
        message === 'AGENT_EXECUTION_IDEMPOTENCY_CONFLICT'
      )
        throw new AgentExecutionConflictError('agent execution reservation conflicted');
      throw error;
    }
    await this.eventPublishCheckpoints.beforeExecutionRun?.();
    const completed = await executionService.run({
      action: prepared.action,
      execution: reserved,
      workerId: stableId('worker', executionId),
    });
    return (await repository.getExecution(input.tenantId, executionId)) ?? completed;
  }

  private async hasLiveSponsorAuthority(
    db: Executor,
    tenantId: string,
    sponsorPrincipalId: string,
    eventId: string,
    requiredPermission: 'events.read' | 'events.write',
  ): Promise<boolean> {
    const event = await db
      .selectFrom('events')
      .select('organization_id')
      .where('tenant_id', '=', tenantId)
      .where('id', '=', eventId)
      .executeTakeFirst();
    if (!event) return false;
    const sponsor = await db
      .selectFrom('user_profiles')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('id', '=', sponsorPrincipalId)
      .where('status', '=', 'active')
      .executeTakeFirst();
    const membership = await db
      .selectFrom('organization_members')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('organization_id', '=', event.organization_id)
      .where('user_id', '=', sponsorPrincipalId)
      .where('accepted_at', 'is not', null)
      .executeTakeFirst();
    const permissionGrant = await db
      .selectFrom('permission_grants')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('principal_type', '=', 'user')
      .where('principal_id', '=', sponsorPrincipalId)
      .where('permission', '=', requiredPermission)
      .where('scope_type', '=', 'tenant')
      .where('scope_id', 'is', null)
      .executeTakeFirst();
    return Boolean(sponsor && membership && permissionGrant);
  }

  private async isCurrentlyReadable(
    tx: Transaction<import('@tixkit/db').DB>,
    prepared: PreparedAgentAction,
    now: Date,
  ): Promise<boolean> {
    const { action } = prepared;
    if (
      action.kind !== 'readiness.read' &&
      action.kind !== 'event.read' &&
      action.kind !== 'event.prepare' &&
      action.kind !== 'content.prepare'
    )
      return false;
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
      .select(['id', 'version'])
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
    if (!principalRow || !delegationRow || !event || !policy) return false;
    const sponsorAuthorized = await this.hasLiveSponsorAuthority(
      tx,
      action.target.tenantId,
      action.sponsorPrincipalId,
      action.target.resourceId,
      action.kind === 'event.prepare' || action.kind === 'content.prepare'
        ? 'events.write'
        : 'events.read',
    );
    const decision = authorizeAgentAction({
      principal: toPrincipal(principalRow),
      delegation: toDelegation(delegationRow),
      action,
      actionDigest: prepared.actionDigest,
      sponsorPermissions: sponsorAuthorized
        ? [
            action.kind === 'event.prepare' || action.kind === 'content.prepare'
              ? 'events:write'
              : 'events:read',
          ]
        : [],
      tenantAllowedActions: policy.allowed && policy.risk_allowed ? [action.kind] : [],
      currentResourceVersion: safeInteger(event.version, 'event version'),
      currentPolicyVersion: safeInteger(policy.policy_version, 'agent policy version'),
      now: now.toISOString(),
    });
    return decision.allowed;
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
      (action.kind !== 'event.publish' && action.kind !== 'event.update') ||
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
    const readiness =
      action.kind === 'event.publish'
        ? await new ReadinessService(tx as Database, resolvePaymentMode()).getEventLaunchReadiness({
            tenantId: action.target.tenantId,
            organizationId: event.organization_id,
            brandId: event.brand_id,
            eventId: event.id,
            permissions: new Set(['events.write']),
          })
        : undefined;
    const readinessSnapshotSha256 = readiness
      ? eventPublishReadinessSnapshotSha256(readiness)
      : undefined;
    const resolvedUpdate =
      action.kind === 'event.update'
        ? await new EventUpdateService(tx as Database).resolvePatch({
            tenantId: action.target.tenantId,
            eventId: event.id,
            patch: {
              ...(action.payload.changes as Readonly<Record<string, unknown>>),
              expectedVersion: action.target.resourceVersion,
            },
          })
        : undefined;
    const updatePreviewSha256 = resolvedUpdate
      ? agentSha256({
          resourceId: event.id,
          resourceVersion: safeInteger(event.version, 'event version'),
          changedFields: resolvedUpdate.requestedFields,
          before: resolvedUpdate.before,
          after: resolvedUpdate.after,
        })
      : undefined;
    const decision = authorizeAgentAction({
      principal,
      delegation,
      action,
      actionDigest: prepared.actionDigest,
      sponsorPermissions: [action.kind === 'event.publish' ? 'events:publish' : 'events:write'],
      tenantAllowedActions: policy.allowed && policy.risk_allowed ? [action.kind] : [],
      currentResourceVersion: safeInteger(event.version, 'event version'),
      currentPolicyVersion: safeInteger(policy.policy_version, 'agent policy version'),
      now: now.toISOString(),
    });
    if (
      (action.kind === 'event.publish' &&
        (!readiness?.launchable ||
          readinessSnapshotSha256 !== action.payload.readinessSnapshotSha256)) ||
      (action.kind === 'event.update' &&
        updatePreviewSha256 !== action.payload.changePreviewSha256) ||
      decision.reasons.length !== 1 ||
      decision.reasons[0] !== 'approval_required'
    )
      throw new Error('AGENT_ACTION_NOT_APPROVABLE');
    return agentSha256({
      actionDigest: prepared.actionDigest,
      principal,
      delegation,
      sponsor: {
        id: sponsor.id,
        status: sponsor.status,
        updatedAt: iso(sponsor.updated_at),
      },
      membership: { id: membership.id, updatedAt: iso(membership.updated_at) },
      permission: { id: permission.id, updatedAt: iso(permission.updated_at) },
      policy: {
        allowed: Boolean(policy.allowed),
        riskAllowed: Boolean(policy.risk_allowed),
        version: safeInteger(policy.policy_version, 'agent policy version'),
      },
      resourceVersion: safeInteger(event.version, 'event version'),
      materialSnapshotSha256: readinessSnapshotSha256 ?? updatePreviewSha256,
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
    if (!SHA256.test(row.authorization_snapshot_sha256))
      throw new Error('persisted agent authorization evidence is invalid');
    const persistedPreview: unknown = JSON.parse(row.dry_run_json);
    let dryRun: PreparedAgentReadinessBase['dryRun'] | undefined;
    if (action.kind === 'event.read') {
      if (
        !persistedPreview ||
        typeof persistedPreview !== 'object' ||
        Array.isArray(persistedPreview) ||
        Object.keys(persistedPreview).length !== 1 ||
        !('eventSnapshotSha256' in persistedPreview) ||
        persistedPreview.eventSnapshotSha256 !== action.payload.eventSnapshotSha256
      )
        throw new Error('persisted agent event preview is invalid');
    } else if (action.kind === 'event.prepare') {
      if (
        !persistedPreview ||
        typeof persistedPreview !== 'object' ||
        Array.isArray(persistedPreview) ||
        Object.keys(persistedPreview).length !== 1 ||
        !('changePreviewSha256' in persistedPreview) ||
        persistedPreview.changePreviewSha256 !== action.payload.changePreviewSha256
      )
        throw new Error('persisted agent event prepare preview is invalid');
    } else if (action.kind === 'content.prepare') {
      if (
        !persistedPreview ||
        typeof persistedPreview !== 'object' ||
        Array.isArray(persistedPreview) ||
        Object.keys(persistedPreview).length !== 1 ||
        !('contentPreviewSha256' in persistedPreview) ||
        persistedPreview.contentPreviewSha256 !== action.payload.contentPreviewSha256
      )
        throw new Error('persisted agent content prepare preview is invalid');
    } else if (action.kind === 'event.update') {
      if (
        !persistedPreview ||
        typeof persistedPreview !== 'object' ||
        Array.isArray(persistedPreview)
      )
        throw new Error('persisted agent event update preview is invalid');
      validateAgentEventUpdatePreview(action, persistedPreview as AgentEventUpdatePreview);
    } else {
      const readinessSnapshotSha256 = action.payload.readinessSnapshotSha256;
      if (typeof readinessSnapshotSha256 !== 'string')
        throw new Error('persisted event publish readiness digest is invalid');
      if (
        !persistedPreview ||
        typeof persistedPreview !== 'object' ||
        Array.isArray(persistedPreview) ||
        !('launchable' in persistedPreview) ||
        typeof persistedPreview.launchable !== 'boolean' ||
        !('readinessSnapshotSha256' in persistedPreview) ||
        persistedPreview.readinessSnapshotSha256 !== readinessSnapshotSha256 ||
        !('blockingReasonCodes' in persistedPreview) ||
        !Array.isArray(persistedPreview.blockingReasonCodes) ||
        persistedPreview.blockingReasonCodes.some((reason) => typeof reason !== 'string')
      )
        throw new Error('persisted agent action dry run is invalid');
      dryRun = persistedPreview as PreparedAgentReadinessBase['dryRun'];
    }
    let result:
      | AgentReadinessReadResult
      | AgentEventReadResult
      | AgentEventPrepareResult
      | AgentContentPrepareResult
      | undefined;
    let resultSha256: string | undefined;
    if (
      action.kind === 'readiness.read' ||
      action.kind === 'event.read' ||
      action.kind === 'event.prepare' ||
      action.kind === 'content.prepare'
    ) {
      if (!row.result_json || !row.result_sha256)
        throw new Error('persisted direct agent result is unavailable');
      const parsedResult: unknown = JSON.parse(row.result_json);
      if (!parsedResult || typeof parsedResult !== 'object' || Array.isArray(parsedResult))
        throw new Error('persisted direct agent result is invalid');
      if (action.kind === 'event.read') {
        result = parsedResult as AgentEventReadResult;
        validateAgentEventReadResult(action, result);
      } else if (action.kind === 'event.prepare') {
        result = parsedResult as AgentEventPrepareResult;
        validateAgentEventPrepareResult(action, result);
      } else if (action.kind === 'content.prepare') {
        result = parsedResult as AgentContentPrepareResult;
        validateAgentContentPrepareResult(action, result);
      } else {
        result = parsedResult as AgentReadinessReadResult;
        validateAgentReadinessReadResult(action, result);
      }
      if (agentSha256(result) !== row.result_sha256)
        throw new Error('persisted direct agent result digest is invalid');
      resultSha256 = row.result_sha256;
      if (reasons.length !== 0 || Boolean(row.eligible_for_approval))
        throw new Error('persisted direct agent authorization is invalid');
    } else if (row.result_json || row.result_sha256) {
      throw new Error('persisted consequential agent action contains an unexpected direct result');
    }
    const common = {
      actionDigest: row.action_digest,
      expiresAt: iso(row.expires_at),
    };
    if (action.kind === 'event.read' && result && resultSha256)
      return {
        ...common,
        action: action as EventReadAgentAction,
        authorization: {
          allowed: true,
          eligibleForApproval: false,
          reasons: [],
          snapshotSha256: row.authorization_snapshot_sha256,
          checkedAt: iso(row.prepared_at),
        },
        result: result as AgentEventReadResult,
        resultSha256,
      };
    if (action.kind === 'event.prepare' && result && resultSha256)
      return {
        ...common,
        action: action as EventPrepareAgentAction,
        authorization: {
          allowed: true,
          eligibleForApproval: false,
          reasons: [],
          snapshotSha256: row.authorization_snapshot_sha256,
          checkedAt: iso(row.prepared_at),
        },
        result: result as AgentEventPrepareResult,
        resultSha256,
      };
    if (action.kind === 'content.prepare' && result && resultSha256)
      return {
        ...common,
        action: action as ContentPrepareAgentAction,
        authorization: {
          allowed: true,
          eligibleForApproval: false,
          reasons: [],
          snapshotSha256: row.authorization_snapshot_sha256,
          checkedAt: iso(row.prepared_at),
        },
        result: result as AgentContentPrepareResult,
        resultSha256,
      };
    if (action.kind === 'readiness.read' && result && resultSha256 && dryRun)
      return {
        ...common,
        dryRun,
        action: action as ReadinessReadAgentAction,
        authorization: {
          allowed: true,
          eligibleForApproval: false,
          reasons: [],
          snapshotSha256: row.authorization_snapshot_sha256,
          checkedAt: iso(row.prepared_at),
        },
        result: result as AgentReadinessReadResult,
        resultSha256,
      };
    if (action.kind === 'event.update')
      return {
        ...common,
        preview: persistedPreview as AgentEventUpdatePreview,
        previewSha256: agentSha256(persistedPreview),
        action: action as EventUpdateAgentAction,
        authorization: {
          eligibleForApproval: Boolean(row.eligible_for_approval),
          reasons,
          snapshotSha256: row.authorization_snapshot_sha256,
          checkedAt: iso(row.prepared_at),
        },
      };
    return {
      ...common,
      dryRun: dryRun!,
      action: action as EventPublishAgentAction,
      authorization: {
        eligibleForApproval: Boolean(row.eligible_for_approval),
        reasons,
        snapshotSha256: row.authorization_snapshot_sha256,
        checkedAt: iso(row.prepared_at),
      },
    };
  }

  private async assertDirectAuthorizationEvidence(
    tx: Transaction<import('@tixkit/db').DB>,
    row: Selectable<import('@tixkit/db').DB['agent_actions']>,
  ): Promise<void> {
    if (
      row.action_kind !== 'readiness.read' &&
      row.action_kind !== 'event.read' &&
      row.action_kind !== 'event.prepare' &&
      row.action_kind !== 'content.prepare'
    )
      return;
    if (!SHA256.test(row.authorization_snapshot_sha256))
      throw new Error('persisted agent authorization evidence is invalid');
    const evidence = await tx
      .selectFrom('agent_action_events')
      .select([
        'action_digest',
        'agent_principal_id',
        'sponsor_principal_id',
        'authorization_sha256',
        'outcome',
      ])
      .where('tenant_id', '=', row.tenant_id)
      .where('action_id', '=', row.id)
      .where('phase', '=', 'succeeded')
      .executeTakeFirst();
    if (
      !evidence ||
      evidence.action_digest !== row.action_digest ||
      evidence.agent_principal_id !== row.agent_principal_id ||
      evidence.sponsor_principal_id !== row.sponsor_principal_id ||
      evidence.authorization_sha256 !== row.authorization_snapshot_sha256 ||
      evidence.outcome !== 'succeeded'
    )
      throw new Error('persisted agent authorization evidence is invalid');
  }
}
