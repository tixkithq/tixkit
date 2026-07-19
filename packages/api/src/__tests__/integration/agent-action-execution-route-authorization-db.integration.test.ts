import {
  AGENT_PROTOCOL_VERSION,
  agentActionDigest,
  agentExecutionIdempotencyKey,
  agentSha256,
  canonicalAgentJson,
} from '@tixkit/agent-protocol';
import {
  BrandRepository,
  createDb,
  EventRepository,
  OrganizationRepository,
  TenantRepository,
  type Database,
} from '@tixkit/db';
import type { Principal } from '@tixkit/domain';
import Fastify, { type FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { registerErrorHandler, type AppContext } from '../../app.js';
import { agentActionRoutes } from '../../routes/modules/agent-actions.js';
import {
  AgentActionService,
  type PreparedAgentAction,
  type PreparedAgentEventPublishAction,
} from '../../services/agent-actions.js';
import {
  describeWithIntegrationDatabase,
  integrationDatabaseUrl,
  restoreDatabaseDriver,
  setIntegrationDatabaseDriver,
} from './integration-database.js';

export const AGENT_ACTION_EXECUTION_AUTHORIZATION_ASSERTION_IDS = Object.freeze([
  'agent-execution:authorized-control',
  'agent-execution:resource-concealment-zero-effects',
  'agent-execution:principal-type-denial-zero-effects',
  'agent-execution:live-authority-invalidation-zero-effects',
  'agent-execution:concurrent-single-effect',
] as const);

function registerAgentExecutionEvidence(
  assertionId: (typeof AGENT_ACTION_EXECUTION_AUTHORIZATION_ASSERTION_IDS)[number],
  semanticProof: boolean,
): void {
  expect(semanticProof, assertionId).toBe(true);
}

let app: FastifyInstance;
let db: Database;
let service: AgentActionService;
let activePrincipal: Principal;
let previousDriver: string | undefined;
let prepared: PreparedAgentAction;
let approvalId: string;
let alternatePrepared: PreparedAgentAction;
let alternateApprovalId: string;
let beforeExecutionReserveImplementation: () => Promise<void> = async () => undefined;
let beforeExecutionReserveReached = 0;

let fixtureSuffix = randomBytes(8).toString('hex');
const fixtureId = (prefix: string, label: string): string =>
  `${prefix}_${createHash('sha256').update(`${label}\0${fixtureSuffix}`).digest('hex').slice(0, 24)}`;
const protocolFixtureId = (prefix: string, label: string): string =>
  `${prefix}_${createHash('sha256').update(`${label}\0${fixtureSuffix}`).digest('hex').slice(0, 48)}`;
let sponsorId: string;
let alternateSponsorId: string;
let agentId: string;
let alternateAgentId: string;
let delegationId: string;
let alternateDelegationId: string;
let inventoryPoolId: string;
let ticketTypeId: string;
let eventPageId: string;
let contentDocumentId: string;
let contentVersionId: string;
let readinessAcknowledgementId: string;

function refreshFixtureIdentity(): void {
  fixtureSuffix = randomBytes(8).toString('hex');
  sponsorId = fixtureId('usr', 'agent_route_sponsor');
  alternateSponsorId = fixtureId('usr', 'agent_route_other');
  agentId = protocolFixtureId('agt', 'primary-agent');
  alternateAgentId = protocolFixtureId('agt', 'alternate-agent');
  delegationId = protocolFixtureId('dlg', 'primary-delegation');
  alternateDelegationId = protocolFixtureId('dlg', 'alternate-delegation');
  inventoryPoolId = fixtureId('inv', 'agent_route');
  ticketTypeId = fixtureId('tt', 'agent_route');
  eventPageId = fixtureId('ep', 'agent_route');
  contentDocumentId = fixtureId('cdoc', 'agent_route_confirm');
  contentVersionId = fixtureId('cver', 'agent_route_confirm');
  readinessAcknowledgementId = fixtureId('era', 'agent_route_checkout');
}

function principal(type: Principal['type'], overrides: Partial<Principal> = {}): Principal {
  return {
    id: type === 'agent' ? agentId : fixtureId(type, 'agent_route'),
    type,
    tenantId: prepared?.action.target.tenantId ?? 'unseeded',
    organizationIds: [],
    brandIds: [],
    eventIds: [],
    scopes: type === 'user' ? ['events.write'] : [],
    ...overrides,
  };
}

async function seedFixture(): Promise<void> {
  const tenant = await new TenantRepository(db).create({ name: 'Agent route authorization' });
  const organization = await new OrganizationRepository(db).create({
    tenantId: tenant.id,
    name: 'Agent route organization',
    slug: `agent-route-organization-${fixtureSuffix}`,
  });
  const brand = await new BrandRepository(db).create({
    tenantId: tenant.id,
    organizationId: organization.id,
    name: 'Agent route brand',
    slug: `agent-route-brand-${fixtureSuffix}`,
  });
  const event = await new EventRepository(db).create({
    tenantId: tenant.id,
    organizationId: organization.id,
    brandId: brand.id,
    slug: `agent-route-event-${fixtureSuffix}`,
    title: 'Agent route event',
    currency: 'USD',
    timezone: 'UTC',
    startsAt: new Date(Date.now() + 86_400_000),
  });
  const now = new Date();
  await db
    .insertInto('inventory_pools')
    .values({
      id: inventoryPoolId,
      event_id: event.id,
      name: 'General inventory',
      total_capacity: 100,
      hold_ttl_seconds: 600,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('ticket_types')
    .values({
      id: ticketTypeId,
      event_id: event.id,
      name: 'General admission',
      description: null,
      kind: 'standard',
      status: 'active',
      visibility: 'public',
      currency: 'USD',
      price_cents: 0,
      minimum_price_cents: null,
      sales_start_at: null,
      sales_end_at: null,
      min_per_order: 1,
      max_per_order: 10,
      inventory_pool_id: inventoryPoolId,
      sort_order: 0,
      requires_access_code: false,
      access_code_hint: null,
      event_occurrence_id: null,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('event_pages')
    .values({
      id: eventPageId,
      event_id: event.id,
      locale: 'en',
      title: 'Agent route event',
      description: null,
      content_html: '<p>Agent route event</p>',
      is_default: true,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('content_documents')
    .values({
      id: contentDocumentId,
      tenant_id: tenant.id,
      organization_id: organization.id,
      brand_id: brand.id,
      event_id: event.id,
      channel: 'email',
      key: 'order-confirmed',
      name: 'Order confirmation',
      status: 'published',
      locale: 'en',
      current_draft_version_id: null,
      published_version_id: null,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('content_document_versions')
    .values({
      id: contentVersionId,
      document_id: contentDocumentId,
      version_number: 1,
      status: 'published',
      schema_version: 1,
      subject: 'Confirmed',
      preview_text: null,
      content_json: '{}',
      rendered_html: '<p>Confirmed</p>',
      rendered_text: 'Confirmed',
      variables: '[]',
      validation: '{}',
      created_by: sponsorId,
      created_at: now,
      published_at: now,
    })
    .execute();
  await db
    .updateTable('content_documents')
    .set({
      current_draft_version_id: contentVersionId,
      published_version_id: contentVersionId,
    })
    .where('id', '=', contentDocumentId)
    .execute();
  await db
    .insertInto('event_readiness_acknowledgements')
    .values({
      id: readinessAcknowledgementId,
      tenant_id: tenant.id,
      organization_id: organization.id,
      brand_id: brand.id,
      event_id: event.id,
      step_id: 'checkout_consent',
      step_version: 1,
      subject_fingerprint: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
      actor_id: sponsorId,
      acknowledged_at: now,
    })
    .execute();
  await db
    .insertInto('user_profiles')
    .values(
      [sponsorId, alternateSponsorId].map((id) => ({
        id,
        tenant_id: tenant.id,
        clerk_user_id: `clerk_${id.slice(0, 24)}`,
        email: `${id}@example.test`,
        first_name: null,
        last_name: null,
        avatar_url: null,
        status: 'active',
        last_seen_at: null,
        created_at: now,
        updated_at: now,
      })),
    )
    .execute();
  await db
    .insertInto('organization_members')
    .values(
      [sponsorId, alternateSponsorId].map((userId, index) => ({
        id: fixtureId('mem', `agent_route_${index}`),
        tenant_id: tenant.id,
        organization_id: organization.id,
        user_id: userId,
        role: 'owner',
        invited_at: now,
        accepted_at: now,
        created_at: now,
        updated_at: now,
      })),
    )
    .execute();
  await db
    .insertInto('permission_grants')
    .values(
      [sponsorId, alternateSponsorId].map((principalId, index) => ({
        id: fixtureId('pg', `agent_route_publish_${index}`),
        tenant_id: tenant.id,
        principal_type: 'user' as const,
        principal_id: principalId,
        permission: 'events.write',
        scope_type: 'tenant' as const,
        scope_id: null,
        created_at: now,
        updated_at: now,
      })),
    )
    .execute();
  await db
    .insertInto('agent_principals')
    .values([
      {
        id: agentId,
        tenant_id: tenant.id,
        kind: 'third_party',
        sponsor_principal_id: sponsorId,
        capabilities: JSON.stringify(['events.execute']),
        maximum_autonomy: 'execute_with_approval',
        protocol_version: AGENT_PROTOCOL_VERSION,
        state: 'active',
        registered_at: now,
        updated_at: now,
      },
      {
        id: alternateAgentId,
        tenant_id: tenant.id,
        kind: 'third_party',
        sponsor_principal_id: alternateSponsorId,
        capabilities: JSON.stringify(['events.execute']),
        maximum_autonomy: 'execute_with_approval',
        protocol_version: AGENT_PROTOCOL_VERSION,
        state: 'active',
        registered_at: now,
        updated_at: now,
      },
    ])
    .execute();
  await db
    .insertInto('agent_delegations')
    .values(
      [
        [delegationId, agentId, sponsorId],
        [alternateDelegationId, alternateAgentId, alternateSponsorId],
      ].map(([id, agentPrincipalId, sponsorPrincipalId]) => ({
        id: id!,
        tenant_id: tenant.id,
        agent_principal_id: agentPrincipalId!,
        sponsor_principal_id: sponsorPrincipalId!,
        capabilities: JSON.stringify(['events.execute']),
        resource_scopes: JSON.stringify([`event:${event.id}`]),
        permission_snapshot: JSON.stringify(['events:publish', 'events:write']),
        issued_at: new Date(now.getTime() - 60_000),
        expires_at: new Date(now.getTime() + 3_600_000),
        revoked_at: null,
        created_at: now,
      })),
    )
    .execute();
  await db
    .insertInto('agent_action_policies')
    .values({
      tenant_id: tenant.id,
      action_kind: 'event.publish',
      allowed: true,
      risk_allowed: true,
      policy_version: 3,
      updated_at: now,
    })
    .execute();

  prepared = await service.prepare({
    tenantId: tenant.id,
    agentPrincipalId: agentId,
    idempotencyKey: `agent-route-prepare-${fixtureSuffix}`,
    kind: 'event.publish',
    delegationGrantId: delegationId,
    resourceId: event.id,
  });
  if (!prepared.authorization.eligibleForApproval)
    throw new Error(
      `fixture is not approvable: ${prepared.authorization.reasons.join(',')}; blockers=${prepared.dryRun.blockingReasonCodes.join(',')}`,
    );
  const approval = await service.approve({
    tenantId: tenant.id,
    approverPrincipalId: sponsorId,
    actionId: prepared.action.id,
    actionDigest: prepared.actionDigest,
    idempotencyKey: `agent-route-approval-${fixtureSuffix}`,
    expectedActionKind: 'event.publish',
  });
  approvalId = approval.id;
  alternatePrepared = await service.prepare({
    tenantId: tenant.id,
    agentPrincipalId: alternateAgentId,
    idempotencyKey: `agent-route-prepare-alternate-${fixtureSuffix}`,
    kind: 'event.publish',
    delegationGrantId: alternateDelegationId,
    resourceId: event.id,
  });
  const alternateApproval = await service.approve({
    tenantId: tenant.id,
    approverPrincipalId: alternateSponsorId,
    actionId: alternatePrepared.action.id,
    actionDigest: alternatePrepared.actionDigest,
    idempotencyKey: `agent-route-approval-alternate-${fixtureSuffix}`,
    expectedActionKind: 'event.publish',
  });
  alternateApprovalId = alternateApproval.id;
  activePrincipal = principal('agent', { tenantId: tenant.id });
}

async function resetFixture(): Promise<void> {
  refreshFixtureIdentity();
  beforeExecutionReserveImplementation = async () => undefined;
  beforeExecutionReserveReached = 0;
  await seedFixture();
}

async function databaseNow(): Promise<Date> {
  const row = await db
    .selectNoFrom(sql<Date>`current_timestamp`.as('database_now'))
    .executeTakeFirstOrThrow();
  return new Date(row.database_now);
}

async function expectedApprovalAuthorizationSha256(approvedAt: Date | string): Promise<string> {
  if (prepared.action.kind !== 'event.publish') throw new Error('expected event.publish fixture');
  const [agent, delegation, sponsor, membership, permission, policy] = await Promise.all([
    db
      .selectFrom('agent_principals')
      .selectAll()
      .where('id', '=', agentId)
      .executeTakeFirstOrThrow(),
    db
      .selectFrom('agent_delegations')
      .selectAll()
      .where('id', '=', delegationId)
      .executeTakeFirstOrThrow(),
    db
      .selectFrom('user_profiles')
      .selectAll()
      .where('id', '=', sponsorId)
      .executeTakeFirstOrThrow(),
    db
      .selectFrom('organization_members')
      .selectAll()
      .where('user_id', '=', sponsorId)
      .executeTakeFirstOrThrow(),
    db
      .selectFrom('permission_grants')
      .selectAll()
      .where('principal_id', '=', sponsorId)
      .executeTakeFirstOrThrow(),
    db
      .selectFrom('agent_action_policies')
      .selectAll()
      .where('tenant_id', '=', prepared.action.target.tenantId)
      .where('action_kind', '=', prepared.action.kind)
      .executeTakeFirstOrThrow(),
  ]);
  const iso = (value: Date | string): string => new Date(value).toISOString();
  const actionAuthorizationSha256 = agentSha256({
    actionDigest: prepared.actionDigest,
    principal: {
      id: agent.id,
      tenantId: agent.tenant_id,
      kind: agent.kind,
      sponsorPrincipalId: agent.sponsor_principal_id,
      capabilities: JSON.parse(agent.capabilities) as string[],
      maximumAutonomy: agent.maximum_autonomy,
      protocolVersion: agent.protocol_version,
      state: agent.state,
      registeredAt: iso(agent.registered_at),
    },
    delegation: {
      id: delegation.id,
      tenantId: delegation.tenant_id,
      agentPrincipalId: delegation.agent_principal_id,
      sponsorPrincipalId: delegation.sponsor_principal_id,
      capabilities: JSON.parse(delegation.capabilities) as string[],
      resourceScopes: JSON.parse(delegation.resource_scopes) as string[],
      permissionSnapshot: JSON.parse(delegation.permission_snapshot) as string[],
      issuedAt: iso(delegation.issued_at),
      expiresAt: iso(delegation.expires_at),
    },
    sponsor: { id: sponsor.id, status: sponsor.status, updatedAt: iso(sponsor.updated_at) },
    membership: { id: membership.id, updatedAt: iso(membership.updated_at) },
    permission: { id: permission.id, updatedAt: iso(permission.updated_at) },
    policy: {
      allowed: Boolean(policy.allowed),
      riskAllowed: Boolean(policy.risk_allowed),
      version: Number(policy.policy_version),
    },
    resourceVersion: prepared.action.target.resourceVersion,
    materialSnapshotSha256: prepared.action.payload.readinessSnapshotSha256,
    checkedAt: iso(approvedAt),
  });
  return agentSha256({ actionAuthorizationSha256, planSha256: null });
}

function stableFixtureId(prefix: 'aaud' | 'exec', ...parts: readonly string[]): string {
  return `${prefix}_${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 48)}`;
}

async function seedPreparedActionWithExpiration(expiresInMilliseconds: number): Promise<void> {
  if (prepared.action.kind !== 'event.publish') throw new Error('expected event.publish fixture');
  const sourcePrepared = prepared as PreparedAgentEventPublishAction;
  const sourceAction = await db
    .selectFrom('agent_actions')
    .selectAll()
    .where('id', '=', sourcePrepared.action.id)
    .executeTakeFirstOrThrow();
  const sourceApproval = await db
    .selectFrom('agent_approvals')
    .selectAll()
    .where('id', '=', approvalId)
    .executeTakeFirstOrThrow();
  const sourceEvents = await db
    .selectFrom('agent_action_events')
    .selectAll()
    .where('action_id', '=', prepared.action.id)
    .orderBy('phase', 'asc')
    .execute();
  const now = await databaseNow();
  const preparedAt = new Date(now.getTime() - 20 * 60_000);
  const expiresAt = new Date(now.getTime() + expiresInMilliseconds);
  const expiredAction = {
    ...sourcePrepared.action,
    id: protocolFixtureId('act', 'expired-prepared-action'),
    idempotencyKey: `agent-route-expired-prepared-${fixtureSuffix}`,
    preparedAt: preparedAt.toISOString(),
  };
  const expiredDigest = agentActionDigest(expiredAction);
  const expiredApprovalId = protocolFixtureId('apr', 'expired-prepared-approval');
  await db
    .insertInto('agent_actions')
    .values({
      ...sourceAction,
      id: expiredAction.id,
      action_digest: expiredDigest,
      action_json: canonicalAgentJson(expiredAction),
      idempotency_key: expiredAction.idempotencyKey,
      request_fingerprint: agentSha256({
        agentPrincipalId: agentId,
        delegationGrantId: delegationId,
        idempotencyKey: expiredAction.idempotencyKey,
        kind: 'event.publish',
        resourceId: expiredAction.target.resourceId,
        tenantId: expiredAction.target.tenantId,
      }),
      prepared_at: preparedAt,
      expires_at: expiresAt,
    })
    .execute();
  await db
    .insertInto('agent_approvals')
    .values({
      ...sourceApproval,
      id: expiredApprovalId,
      action_id: expiredAction.id,
      action_digest: expiredDigest,
      approved_at: new Date(now.getTime() - 10 * 60_000),
      expires_at: new Date(now.getTime() + 5 * 60_000),
      revoked_at: null,
      consumed_at: null,
      consumed_execution_id: null,
    })
    .execute();
  await db
    .insertInto('agent_action_events')
    .values(
      sourceEvents.map((event, index) => ({
        ...event,
        id: protocolFixtureId('aevt', `expired-route-${index}`),
        action_id: expiredAction.id,
        action_digest: expiredDigest,
        approval_id: event.phase === 'approved' ? expiredApprovalId : null,
        idempotency_key:
          event.phase === 'approved'
            ? `agent-route-expired-approval-${fixtureSuffix}`
            : expiredAction.idempotencyKey,
        occurred_at: new Date(preparedAt.getTime() + index * 60_000),
      })),
    )
    .execute();
  prepared = {
    ...sourcePrepared,
    action: expiredAction,
    actionDigest: expiredDigest,
    expiresAt: expiresAt.toISOString(),
  };
  approvalId = expiredApprovalId;
}

async function seedExpiredTerminalReplay(
  sourceExecutionId: string,
): Promise<{ executionId: string }> {
  const sourceExecution = await db
    .selectFrom('agent_executions')
    .selectAll()
    .where('id', '=', sourceExecutionId)
    .executeTakeFirstOrThrow();
  const sourceEffect = await db
    .selectFrom('agent_action_effects')
    .selectAll()
    .where('execution_id', '=', sourceExecutionId)
    .executeTakeFirstOrThrow();
  const sourceAudit = await db
    .selectFrom('agent_audit_events')
    .selectAll()
    .where('execution_id', '=', sourceExecutionId)
    .orderBy('occurred_at', 'asc')
    .orderBy('id', 'asc')
    .execute();
  await seedPreparedActionWithExpiration(-60_000);
  const now = await databaseNow();
  const executionId = stableFixtureId(
    'exec',
    prepared.action.target.tenantId,
    prepared.action.id,
    approvalId,
  );
  const idempotencyKey = agentExecutionIdempotencyKey(prepared.action);
  const requestFingerprint = agentSha256({
    actionDigest: prepared.actionDigest,
    idempotencyKey,
    tenantId: prepared.action.target.tenantId,
  });
  await db
    .updateTable('agent_approvals')
    .set({
      consumed_at: now,
      consumed_execution_id: executionId,
      expires_at: new Date(now.getTime() - 60_000),
    })
    .where('id', '=', approvalId)
    .execute();
  await db
    .insertInto('agent_executions')
    .values({
      ...sourceExecution,
      id: executionId,
      action_id: prepared.action.id,
      action_digest: prepared.actionDigest,
      agent_principal_id: agentId,
      sponsor_principal_id: sponsorId,
      delegation_grant_id: delegationId,
      approval_id: approvalId,
      idempotency_key: idempotencyKey,
      request_fingerprint: requestFingerprint,
      resource_version: prepared.action.target.resourceVersion,
      policy_version: prepared.action.expectedPolicyVersion,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('agent_action_effects')
    .values({
      ...sourceEffect,
      execution_id: executionId,
      tenant_id: prepared.action.target.tenantId,
      action_digest: prepared.actionDigest,
      idempotency_key: idempotencyKey,
      expected_policy_version: prepared.action.expectedPolicyVersion,
      expected_resource_version: prepared.action.target.resourceVersion,
      created_at: now,
    })
    .execute();
  await db
    .insertInto('agent_audit_events')
    .values(
      sourceAudit.map((row, index) => ({
        ...row,
        id: stableFixtureId('aaud', executionId, row.phase, String(index)),
        execution_id: executionId,
        tenant_id: prepared.action.target.tenantId,
        agent_principal_id: agentId,
        sponsor_principal_id: sponsorId,
        delegation_grant_id: delegationId,
        action_id: prepared.action.id,
        action_digest: prepared.actionDigest,
        approval_id: approvalId,
        idempotency_key: idempotencyKey,
        resource_version: prepared.action.target.resourceVersion,
        occurred_at: now,
      })),
    )
    .execute();
  return { executionId };
}

function executeRequest(
  overrides: {
    actionId?: string;
    approvalId?: string;
    actionDigest?: string;
    confirmation?: string;
    idempotencyKey?: string;
  } = {},
) {
  const actionId = overrides.actionId ?? prepared.action.id;
  const selectedApprovalId = overrides.approvalId ?? approvalId;
  const actionDigest = overrides.actionDigest ?? prepared.actionDigest;
  const confirmation =
    overrides.confirmation ?? `execute:${actionId}:${selectedApprovalId}:${actionDigest}`;
  return app.inject({
    method: 'POST',
    url: `/agent/actions/${actionId}/executions`,
    headers: {
      'idempotency-key': overrides.idempotencyKey ?? confirmation,
      'x-tixkit-confirmation': confirmation,
    },
    payload: { approvalId: selectedApprovalId, actionDigest },
  });
}

function boundedResponseEvidence(response: { body: string; statusCode: number }): string {
  let error: { code?: unknown; message?: unknown } | undefined;
  try {
    const parsed: unknown = JSON.parse(response.body);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const candidate = (parsed as { error?: unknown }).error;
      if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
        error = candidate as { code?: unknown; message?: unknown };
      }
    }
  } catch {
    // Fall through to a bounded body after structured redaction.
  }
  const redacted = error
    ? JSON.stringify({ code: error.code, message: error.message })
    : response.body.replace(/[\w.+-]+@[\w.-]+/gu, '[redacted-email]');
  return `status=${response.statusCode}; response=${redacted.slice(0, 384)}`;
}

async function consequentialSnapshot() {
  const tenantId = prepared.action.target.tenantId;
  const event = await db
    .selectFrom('events')
    .select(['status', 'version'])
    .where('id', '=', prepared.action.target.resourceId)
    .executeTakeFirstOrThrow();
  const actions = await db
    .selectFrom('agent_actions')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('id', 'asc')
    .execute();
  const approvals = await db
    .selectFrom('agent_approvals')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('id', 'asc')
    .execute();
  const executions = await db
    .selectFrom('agent_executions')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('id', 'asc')
    .execute();
  return {
    actions,
    approvals,
    event,
    executions,
    effects: await db
      .selectFrom('agent_action_effects')
      .selectAll()
      .where(
        'execution_id',
        'in',
        executions.length > 0 ? executions.map((execution) => execution.id) : ['no_execution'],
      )
      .orderBy('execution_id', 'asc')
      .execute(),
    actionAudit: await db
      .selectFrom('agent_action_events')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .orderBy('id', 'asc')
      .execute(),
    executionAudit: await db
      .selectFrom('agent_audit_events')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .orderBy('id', 'asc')
      .execute(),
  };
}

describeWithIntegrationDatabase('agent execution route authorization and atomicity', () => {
  beforeAll(async () => {
    previousDriver = setIntegrationDatabaseDriver();
    db = createDb(integrationDatabaseUrl());
    service = new AgentActionService(db, {
      beforeExecutionReserve: () => beforeExecutionReserveImplementation(),
    });
    app = Fastify({ logger: false });
    app.decorate('context', { db } as AppContext);
    app.addHook('onRequest', async (request) => {
      request.principal = activePrincipal;
    });
    registerErrorHandler(app);
    await app.register(agentActionRoutes, { service });
    await app.ready();
  }, 120_000);

  beforeEach(async () => {
    await resetFixture();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await db?.destroy();
    restoreDatabaseDriver(previousDriver);
  });

  it('binds execution to the exact agent, tenant, action, approval, delegation, and sponsor', async () => {
    const before = await consequentialSnapshot();
    let verifiedDenials = 0;
    const wrongCases = [
      { principalOverrides: { id: alternateAgentId } },
      { principalOverrides: { tenantId: 'tnt_wrong_scope' } },
      { requestOverrides: { actionId: protocolFixtureId('act', 'unknown-action') } },
      { requestOverrides: { approvalId: protocolFixtureId('apr', 'unknown-approval') } },
      {
        requestOverrides: {
          actionId: alternatePrepared.action.id,
          approvalId: alternateApprovalId,
          actionDigest: alternatePrepared.actionDigest,
        },
      },
      { requestOverrides: { approvalId: alternateApprovalId } },
    ];
    for (const wrongCase of wrongCases) {
      activePrincipal = principal('agent', wrongCase.principalOverrides);
      const response = await executeRequest(wrongCase.requestOverrides);
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
      expect(await consequentialSnapshot()).toEqual(before);
      verifiedDenials += 1;
    }
    registerAgentExecutionEvidence(
      'agent-execution:resource-concealment-zero-effects',
      verifiedDenials === wrongCases.length,
    );
  });

  it('rejects human, API-key, and non-agent principals before effects', async () => {
    const before = await consequentialSnapshot();
    let verifiedDenials = 0;
    for (const type of ['user', 'api_key', 'mobile_device', 'system'] as const) {
      activePrincipal = principal(type);
      const response = await executeRequest();
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
      expect(await consequentialSnapshot()).toEqual(before);
      verifiedDenials += 1;
    }
    registerAgentExecutionEvidence(
      'agent-execution:principal-type-denial-zero-effects',
      verifiedDenials === 4,
    );
  });

  it('rejects malformed or substituted digest, confirmation, and idempotency evidence', async () => {
    const before = await consequentialSnapshot();
    const cases = [
      () =>
        executeRequest({
          actionDigest: 'f'.repeat(64),
          confirmation: `execute:${prepared.action.id}:${approvalId}:${prepared.actionDigest}`,
        }),
      () => executeRequest({ actionDigest: 'invalid' }),
      () => executeRequest({ confirmation: 'execute:substituted' }),
      () => executeRequest({ idempotencyKey: 'execute:substituted' }),
    ];
    for (const invoke of cases) {
      const response = await invoke();
      expect(response.statusCode).toBe(400);
      expect(await consequentialSnapshot()).toEqual(before);
    }
  });

  it('invalidates post-approval live authority changes without consequential effects', async () => {
    const invalidations: ReadonlyArray<{
      name: string;
      mutate: () => Promise<unknown>;
    }> = [
      {
        name: 'revoked delegation',
        mutate: () =>
          db
            .updateTable('agent_delegations')
            .set({ revoked_at: new Date() })
            .where('id', '=', delegationId)
            .execute(),
      },
      {
        name: 'expired delegation',
        mutate: () =>
          db
            .updateTable('agent_delegations')
            .set({ expires_at: new Date(Date.now() - 60_000) })
            .where('id', '=', delegationId)
            .execute(),
      },
      {
        name: 'revoked agent principal',
        mutate: () =>
          db
            .updateTable('agent_principals')
            .set({ state: 'revoked' })
            .where('id', '=', agentId)
            .execute(),
      },
      {
        name: 'removed agent capability',
        mutate: () =>
          db
            .updateTable('agent_principals')
            .set({ capabilities: '[]' })
            .where('id', '=', agentId)
            .execute(),
      },
      {
        name: 'inactive sponsor',
        mutate: () =>
          db
            .updateTable('user_profiles')
            .set({ status: 'suspended' })
            .where('id', '=', sponsorId)
            .execute(),
      },
      {
        name: 'removed sponsor membership',
        mutate: () =>
          db
            .updateTable('organization_members')
            .set({ accepted_at: null })
            .where('user_id', '=', sponsorId)
            .execute(),
      },
      {
        name: 'removed sponsor permission grant',
        mutate: () =>
          db.deleteFrom('permission_grants').where('principal_id', '=', sponsorId).execute(),
      },
      {
        name: 'disabled tenant action policy',
        mutate: () =>
          db
            .updateTable('agent_action_policies')
            .set({ allowed: false })
            .where('tenant_id', '=', prepared.action.target.tenantId)
            .where('action_kind', '=', 'event.publish')
            .execute(),
      },
      {
        name: 'disabled risk policy',
        mutate: () =>
          db
            .updateTable('agent_action_policies')
            .set({ risk_allowed: false })
            .where('tenant_id', '=', prepared.action.target.tenantId)
            .where('action_kind', '=', 'event.publish')
            .execute(),
      },
      {
        name: 'changed policy version',
        mutate: () =>
          db
            .updateTable('agent_action_policies')
            .set({ policy_version: 4 })
            .where('tenant_id', '=', prepared.action.target.tenantId)
            .where('action_kind', '=', 'event.publish')
            .execute(),
      },
      {
        name: 'revoked approval',
        mutate: () =>
          db
            .updateTable('agent_approvals')
            .set({ revoked_at: new Date() })
            .where('id', '=', approvalId)
            .execute(),
      },
      {
        name: 'expired approval',
        mutate: async () =>
          db
            .updateTable('agent_approvals')
            .set({ expires_at: new Date((await databaseNow()).getTime() - 60_000) })
            .where('id', '=', approvalId)
            .execute(),
      },
      {
        name: 'expired prepared action',
        mutate: () => seedPreparedActionWithExpiration(-60_000),
      },
      {
        name: 'prepared action expires at the reservation boundary',
        mutate: async () => {
          await seedPreparedActionWithExpiration(3_000);
          beforeExecutionReserveImplementation = async () => {
            beforeExecutionReserveReached += 1;
            await new Promise((resolve) => setTimeout(resolve, 6_000));
          };
        },
      },
      {
        name: 'changed resource version',
        mutate: () =>
          db
            .updateTable('events')
            .set({ version: prepared.action.target.resourceVersion + 1 })
            .where('id', '=', prepared.action.target.resourceId)
            .execute(),
      },
    ];

    let verifiedInvalidations = 0;
    for (const invalidation of invalidations) {
      await resetFixture();
      await invalidation.mutate();
      const before = await consequentialSnapshot();
      const response = await executeRequest();
      const responseEvidence = `${invalidation.name}: ${boundedResponseEvidence(response)}`;
      if (invalidation.name === 'prepared action expires at the reservation boundary')
        expect(beforeExecutionReserveReached).toBe(1);
      expect(response.statusCode, responseEvidence).toBe(409);
      expect(response.json(), responseEvidence).toMatchObject({ error: { code: 'CONFLICT' } });
      expect(await consequentialSnapshot(), invalidation.name).toEqual(before);
      verifiedInvalidations += 1;
    }
    registerAgentExecutionEvidence(
      'agent-execution:live-authority-invalidation-zero-effects',
      verifiedInvalidations === invalidations.length,
    );
  }, 120_000);

  it('publishes once under concurrent exact route calls and replays one execution identity', async () => {
    const responses = await Promise.all([
      executeRequest(),
      executeRequest(),
      executeRequest(),
      executeRequest(),
    ]);
    const responseEvidence = responses.map(boundedResponseEvidence).join(' | ');
    expect(
      responses.some((response) => response.statusCode === 200),
      responseEvidence,
    ).toBe(true);
    expect(
      responses.every((response) => [200, 409].includes(response.statusCode)),
      responseEvidence,
    ).toBe(true);

    const replay = await executeRequest();
    expect(replay.statusCode, boundedResponseEvidence(replay)).toBe(200);
    const successfulBodies = [...responses, replay]
      .filter((response) => response.statusCode === 200)
      .map((response) => response.json<{ id: string }>());
    expect(new Set(successfulBodies.map((body) => body.id))).toHaveLength(1);

    const state = await consequentialSnapshot();
    expect(state.event.status).toBe('published');
    expect(Number(state.event.version)).toBe(prepared.action.target.resourceVersion + 1);
    expect(state.executions).toHaveLength(1);
    expect(state.effects).toHaveLength(1);
    const consumed = state.approvals.find((approval) => approval.id === approvalId);
    expect(consumed).toMatchObject({
      consumed_at: expect.any(Date),
      consumed_execution_id: state.executions[0]!.id,
    });
    const actionAudit = await db
      .selectFrom('agent_action_events')
      .selectAll()
      .where('action_id', '=', prepared.action.id)
      .orderBy('occurred_at', 'asc')
      .orderBy('id', 'asc')
      .execute();
    const actionPhaseOrder = new Map([
      ['prepared', 0],
      ['approved', 1],
    ]);
    const orderedActionAudit = [...actionAudit].sort(
      (left, right) =>
        (actionPhaseOrder.get(left.phase) ?? 99) - (actionPhaseOrder.get(right.phase) ?? 99),
    );
    expect(orderedActionAudit.map((row) => row.phase)).toEqual(['prepared', 'approved']);
    expect(actionAudit).toHaveLength(2);
    expect(new Set(actionAudit.map((row) => row.id))).toHaveLength(2);
    expect(actionAudit.every((row) => /^aevt_[a-f0-9]{48}$/u.test(row.id))).toBe(true);
    const actionRow = state.actions.find((row) => row.id === prepared.action.id)!;
    const actionOccurredAt = orderedActionAudit.map((row) => new Date(row.occurred_at).getTime());
    expect(actionOccurredAt).toEqual([...actionOccurredAt].sort((left, right) => left - right));
    expect(
      actionOccurredAt.every(
        (occurredAt) =>
          occurredAt >= new Date(actionRow.prepared_at).getTime() &&
          occurredAt <= new Date(consumed!.approved_at).getTime(),
      ),
    ).toBe(true);
    expect(
      orderedActionAudit.map((row) => ({
        tenantId: row.tenant_id,
        actionId: row.action_id,
        actionDigest: row.action_digest,
        agentPrincipalId: row.agent_principal_id,
        sponsorPrincipalId: row.sponsor_principal_id,
        phase: row.phase,
        approvalId: row.approval_id,
        actorType: row.actor_type,
        actorPrincipalId: row.actor_principal_id,
        idempotencyKey: row.idempotency_key,
        requestFingerprint: row.request_fingerprint,
        authorizationSha256: row.authorization_sha256,
        outcome: row.outcome,
      })),
    ).toEqual([
      {
        tenantId: prepared.action.target.tenantId,
        actionId: prepared.action.id,
        actionDigest: prepared.actionDigest,
        agentPrincipalId: agentId,
        sponsorPrincipalId: sponsorId,
        phase: 'prepared',
        approvalId: null,
        actorType: 'agent',
        actorPrincipalId: agentId,
        idempotencyKey: `agent-route-prepare-${fixtureSuffix}`,
        requestFingerprint: agentSha256({
          agentPrincipalId: agentId,
          delegationGrantId: delegationId,
          idempotencyKey: `agent-route-prepare-${fixtureSuffix}`,
          kind: 'event.publish',
          resourceId: prepared.action.target.resourceId,
          tenantId: prepared.action.target.tenantId,
        }),
        authorizationSha256: prepared.authorization.snapshotSha256,
        outcome: 'approval_required',
      },
      {
        tenantId: prepared.action.target.tenantId,
        actionId: prepared.action.id,
        actionDigest: prepared.actionDigest,
        agentPrincipalId: agentId,
        sponsorPrincipalId: sponsorId,
        phase: 'approved',
        approvalId,
        actorType: 'user',
        actorPrincipalId: sponsorId,
        idempotencyKey: `agent-route-approval-${fixtureSuffix}`,
        requestFingerprint: agentSha256({
          actionId: prepared.action.id,
          actionDigest: prepared.actionDigest,
          planSha256: null,
        }),
        authorizationSha256: await expectedApprovalAuthorizationSha256(consumed!.approved_at),
        outcome: 'approved',
      },
    ]);
    const executionAudit = await db
      .selectFrom('agent_audit_events')
      .selectAll()
      .where('execution_id', '=', state.executions[0]!.id)
      .execute();
    const phaseOrder = new Map([
      ['prepared', 0],
      ['authorized', 1],
      ['started', 2],
      ['succeeded', 3],
    ]);
    expect(
      executionAudit
        .map((row) => row.phase)
        .sort((left, right) => (phaseOrder.get(left) ?? 99) - (phaseOrder.get(right) ?? 99)),
    ).toEqual(['prepared', 'authorized', 'started', 'succeeded']);
    expect(executionAudit).toHaveLength(4);
    expect(new Set(executionAudit.map((row) => row.id))).toHaveLength(4);
    expect(executionAudit.every((row) => /^aaud_[a-f0-9]{48}$/u.test(row.id))).toBe(true);
    expect(executionAudit.every((row) => row.execution_id === state.executions[0]!.id)).toBe(true);
    const execution = state.executions[0]!;
    const approval = state.approvals.find((row) => row.id === approvalId)!;
    expect(approval).toMatchObject({
      action_id: prepared.action.id,
      action_digest: prepared.actionDigest,
      approver_principal_id: sponsorId,
      consumed_execution_id: execution.id,
      consumed_at: expect.any(Date),
      revoked_at: null,
    });
    const executionOccurredAt = executionAudit
      .map((row) => new Date(row.occurred_at).getTime())
      .sort((left, right) => left - right);
    expect(
      executionOccurredAt.every(
        (occurredAt) =>
          occurredAt >= new Date(execution.created_at).getTime() &&
          occurredAt <= new Date(execution.updated_at).getTime(),
      ),
    ).toBe(true);
    expect(
      executionAudit.map((row) => ({
        tenantId: row.tenant_id,
        executionId: row.execution_id,
        agentPrincipalId: row.agent_principal_id,
        sponsorPrincipalId: row.sponsor_principal_id,
        delegationGrantId: row.delegation_grant_id,
        actionId: row.action_id,
        actionDigest: row.action_digest,
        planSha256: row.plan_sha256,
        approvalId: row.approval_id,
        phase: row.phase,
        idempotencyKey: row.idempotency_key,
        resourceVersion: Number(row.resource_version),
        reasonCodes:
          typeof row.reason_codes === 'string' ? JSON.parse(row.reason_codes) : row.reason_codes,
        immutable: Boolean(row.immutable),
      })),
    ).toEqual(
      expect.arrayContaining(
        ['prepared', 'authorized', 'started', 'succeeded'].map((phase) => ({
          tenantId: prepared.action.target.tenantId,
          executionId: execution.id,
          agentPrincipalId: agentId,
          sponsorPrincipalId: sponsorId,
          delegationGrantId: delegationId,
          actionId: prepared.action.id,
          actionDigest: prepared.actionDigest,
          planSha256: null,
          approvalId,
          phase,
          idempotencyKey: execution.idempotency_key,
          resourceVersion: prepared.action.target.resourceVersion,
          reasonCodes: [],
          immutable: true,
        })),
      ),
    );
    const repositoryEvidence = await service.getExecutionForAgent({
      tenantId: prepared.action.target.tenantId,
      agentPrincipalId: agentId,
      actionId: prepared.action.id,
      executionId: execution.id,
    });
    expect(repositoryEvidence?.execution.id).toBe(execution.id);
    expect(repositoryEvidence?.audit.map((row) => row.phase)).toEqual([
      'prepared',
      'authorized',
      'started',
      'succeeded',
    ]);
    registerAgentExecutionEvidence(
      'agent-execution:authorized-control',
      replay.statusCode === 200 && state.event.status === 'published',
    );
    registerAgentExecutionEvidence(
      'agent-execution:concurrent-single-effect',
      state.executions.length === 1 &&
        state.effects.length === 1 &&
        successfulBodies.every((body) => body.id === execution.id),
    );

    const terminalReplay = await seedExpiredTerminalReplay(execution.id);
    const beforeExpiredReplay = await consequentialSnapshot();
    const expiredReplay = await executeRequest();
    expect(expiredReplay.statusCode).toBe(200);
    expect(expiredReplay.json<{ id: string }>().id).toBe(terminalReplay.executionId);
    expect(await consequentialSnapshot()).toEqual(beforeExpiredReplay);
  });
});
