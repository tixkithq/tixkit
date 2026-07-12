import { AGENT_PROTOCOL_VERSION, agentActionDigest, agentAuthorizationStateDigest, agentSha256,
  AgentExecutionConflictError, DurableAgentExecutionService,
  type AgentAction, type AgentExecution, type AgentExecutionStore } from '@tixkit/agent-protocol';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BrandRepository, createDb, EventRepository, OrganizationRepository, runMigrations,
  AgentExecutionRepository, TenantRepository, truncateAllData, type Database } from '@tixkit/db';
import { EventPublishAgentAdapter } from '../../services/agent-event-publish.js';

type DriverCase = { driver: 'postgres' | 'mysql'; url: string };
const requestedDriver = process.env.DB_INTEGRATION_DRIVER;
const driverCases = [
  { driver: 'postgres', url: process.env.DATABASE_URL ?? '' },
  { driver: 'mysql', url: process.env.DATABASE_URL_MYSQL ?? '' },
].filter((item) => item.url && (!requestedDriver || item.driver === requestedDriver)) as DriverCase[];
if (driverCases.length === 0) it.skip('agent event adapter (database URLs not configured)', () => {});

describe.sequential.each(driverCases)('atomic event publish agent adapter: $driver', ({ driver, url }) => {
  let db: Database;
  let action: AgentAction;
  let execution: AgentExecution;
  let adapter: EventPublishAgentAdapter;

  beforeAll(async () => {
    process.env.DB_DRIVER = driver;
    await runMigrations(url);
    db = createDb(url);
  });
  afterAll(async () => { await db?.destroy(); });

  beforeEach(async () => {
    await truncateAllData(db);
    const tenant = await new TenantRepository(db).create({ name: `Agent adapter ${driver}` });
    const organization = await new OrganizationRepository(db).create({ tenantId: tenant.id,
      name: 'Agent adapter org', slug: `agent-adapter-${driver}` });
    const brand = await new BrandRepository(db).create({ tenantId: tenant.id,
      organizationId: organization.id, name: 'Agent adapter brand', slug: `agent-brand-${driver}` });
    const event = await new EventRepository(db).create({ tenantId: tenant.id,
      organizationId: organization.id, brandId: brand.id, slug: `agent-event-${driver}`,
      title: 'Agent event', currency: 'USD', timezone: 'UTC',
      startsAt: new Date(Date.now() + 86_400_000) });
    const currentEvent = await db.selectFrom('events').selectAll().where('id', '=', event.id)
      .executeTakeFirstOrThrow();
    const now = new Date();
    await db.insertInto('inventory_pools').values({ id: 'inv_agent_publish', event_id: event.id,
      name: 'Agent inventory', total_capacity: 100, hold_ttl_seconds: 600,
      created_at: now, updated_at: now }).execute();
    await db.insertInto('ticket_types').values({ id: 'tt_agent_publish', event_id: event.id,
      name: 'General admission', description: null, kind: 'standard', status: 'active',
      visibility: 'public', currency: 'USD', price_cents: 0, minimum_price_cents: null,
      sales_start_at: null, sales_end_at: null, min_per_order: 1, max_per_order: 10,
      inventory_pool_id: 'inv_agent_publish', sort_order: 0, requires_access_code: false,
      access_code_hint: null, event_occurrence_id: null, created_at: now, updated_at: now }).execute();
    await db.insertInto('event_pages').values({ id: 'ep_agent_publish', event_id: event.id,
      locale: 'en', title: 'Agent event', description: null, content_html: '<p>Event</p>',
      is_default: true, created_at: now, updated_at: now }).execute();
    await db.insertInto('content_documents').values({ id: 'cdoc_agent_confirm', tenant_id: tenant.id,
      organization_id: organization.id, brand_id: brand.id, event_id: event.id, channel: 'email',
      key: 'order-confirmed', name: 'Order confirmation', status: 'draft', locale: 'en',
      current_draft_version_id: null, published_version_id: null, created_at: now, updated_at: now })
      .execute();
    await db.insertInto('content_document_versions').values({ id: 'cver_agent_confirm',
      document_id: 'cdoc_agent_confirm', version_number: 1, status: 'published', schema_version: 1,
      subject: 'Confirmed', preview_text: null, content_json: '{}', rendered_html: '<p>Confirmed</p>',
      rendered_text: 'Confirmed', variables: '[]', validation: '{}', created_by: 'user_sponsor',
      created_at: now, published_at: now }).execute();
    await db.updateTable('content_documents').set({ status: 'published',
      current_draft_version_id: 'cver_agent_confirm', published_version_id: 'cver_agent_confirm' })
      .where('id', '=', 'cdoc_agent_confirm').execute();
    await db.insertInto('event_readiness_acknowledgements').values({ id: 'era_agent_checkout',
      tenant_id: tenant.id, organization_id: organization.id, brand_id: brand.id,
      event_id: event.id, step_id: 'checkout_consent', step_version: 1,
      subject_fingerprint: createHash('sha256').update('[]').digest('hex'),
      actor_id: 'user_sponsor', acknowledged_at: now }).execute();
    await db.insertInto('user_profiles').values({ id: 'user_sponsor', tenant_id: tenant.id,
      clerk_user_id: `clerk_sponsor_${driver}`, email: `sponsor-${driver}@example.test`,
      first_name: null, last_name: null, avatar_url: null, status: 'active', last_seen_at: null,
      created_at: now, updated_at: now }).execute();
    await db.insertInto('permission_grants').values({ id: 'pg_event_publish', tenant_id: tenant.id,
      principal_type: 'user', principal_id: 'user_sponsor', permission: 'events.write',
      scope_type: 'tenant', scope_id: null, created_at: now, updated_at: now }).execute();
    await db.insertInto('agent_principals').values({ id: 'agent_publish', tenant_id: tenant.id,
      kind: 'third_party', sponsor_principal_id: 'user_sponsor',
      capabilities: JSON.stringify(['events.execute']), maximum_autonomy: 'execute_with_approval',
      protocol_version: AGENT_PROTOCOL_VERSION, state: 'active', registered_at: now, updated_at: now })
      .execute();
    await db.insertInto('agent_delegations').values({ id: 'delegation_publish', tenant_id: tenant.id,
      agent_principal_id: 'agent_publish', sponsor_principal_id: 'user_sponsor',
      capabilities: JSON.stringify(['events.execute']),
      resource_scopes: JSON.stringify([`event:${event.id}`]),
      permission_snapshot: JSON.stringify(['events:publish']),
      issued_at: new Date(now.getTime() - 60_000), expires_at: new Date(now.getTime() + 3_600_000),
      revoked_at: null, created_at: now }).execute();
    action = { id: 'action_publish', protocolVersion: AGENT_PROTOCOL_VERSION,
      agentPrincipalId: 'agent_publish', sponsorPrincipalId: 'user_sponsor',
      delegationGrantId: 'delegation_publish', kind: 'event.publish',
      autonomy: 'execute_with_approval', target: { tenantId: tenant.id, resourceType: 'event',
        resourceId: event.id, resourceVersion: Number(currentEvent.version),
        apiOperation: 'events.publish' }, payload: {}, idempotencyKey: 'agent-publish-integration-0001',
      expectedPolicyVersion: 3, preparedAt: now.toISOString() };
    const digest = agentActionDigest(action);
    await db.insertInto('agent_approvals').values({ id: 'approval_publish', tenant_id: tenant.id,
      action_digest: digest, plan_sha256: null, approver_principal_id: 'user_sponsor',
      approver_permission_snapshot: JSON.stringify(['events:publish']), policy_version: 3,
      approved_at: new Date(now.getTime() - 5_000), expires_at: new Date(now.getTime() + 900_000),
      revoked_at: null, consumed_at: new Date(now.getTime() - 4_000),
      consumed_execution_id: 'execution_publish' }).execute();
    await db.insertInto('agent_action_policies').values({ tenant_id: tenant.id,
      action_kind: 'event.publish', allowed: true, risk_allowed: true, policy_version: 3,
      updated_at: now }).execute();
    await db.insertInto('agent_executions').values({ id: 'execution_publish', tenant_id: tenant.id,
      action_id: action.id, action_digest: digest, agent_principal_id: action.agentPrincipalId,
      sponsor_principal_id: action.sponsorPrincipalId,
      delegation_grant_id: action.delegationGrantId, approval_id: 'approval_publish',
      idempotency_key: action.idempotencyKey, request_fingerprint: 'f'.repeat(64), state: 'running',
      resource_version: action.target.resourceVersion, policy_version: 3, fence_token: 1,
      lease_owner: 'worker_publish', lease_expires_at: new Date(now.getTime() + 300_000),
      result: null, failure_code: null, created_at: now, updated_at: now }).execute();
    execution = { id: 'execution_publish', tenantId: tenant.id, actionId: action.id,
      actionDigest: digest, agentPrincipalId: action.agentPrincipalId,
      sponsorPrincipalId: action.sponsorPrincipalId, delegationGrantId: action.delegationGrantId,
      approvalId: 'approval_publish', idempotencyKey: action.idempotencyKey,
      requestFingerprint: 'f'.repeat(64), state: 'running', resourceVersion: action.target.resourceVersion,
      policyVersion: 3, fenceToken: 1, leaseOwner: 'worker_publish', createdAt: now.toISOString(),
      updatedAt: now.toISOString() };
    adapter = new EventPublishAgentAdapter(db);
  });

  function invocation(digest: string): Parameters<EventPublishAgentAdapter['invoke']>[0] {
    return { tenantId: execution.tenantId, operation: 'events.publish', resourceType: 'event',
      resourceId: action.target.resourceId, expectedResourceVersion: execution.resourceVersion,
      payload: {}, idempotencyKey: execution.idempotencyKey,
      agentPrincipalId: execution.agentPrincipalId, sponsorPrincipalId: execution.sponsorPrincipalId,
      delegationGrantId: execution.delegationGrantId, approvalId: execution.approvalId,
      executionId: execution.id, actionKind: 'event.publish', actionDigest: execution.actionDigest,
      expectedPolicyVersion: execution.policyVersion, authorizationStateDigest: digest,
      expectedLeaseOwner: execution.leaseOwner!, expectedFenceToken: execution.fenceToken };
  }

  it('reloads the complete authorization state and executes an idempotent public operation', async () => {
    const state = await adapter.load({ action, execution });
    expect(new Date(state.observedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(state.approval.approvedAt).getTime(),
    );
    await expect(adapter.invoke(invocation(agentAuthorizationStateDigest(state)))).resolves.toEqual({
      resourceId: action.target.resourceId, resourceVersion: action.target.resourceVersion + 1,
      status: 'published',
    });
    await expect(adapter.invoke(invocation(agentAuthorizationStateDigest(state)))).resolves.toEqual({
      resourceId: action.target.resourceId, resourceVersion: action.target.resourceVersion + 1,
      status: 'published',
    });
    const published = await db.selectFrom('events').select(['status', 'version'])
      .where('id', '=', action.target.resourceId).executeTakeFirstOrThrow();
    expect(published).toMatchObject({ status: 'published', version: action.target.resourceVersion + 1 });
    expect(await db.selectFrom('agent_action_effects').select('execution_id')
      .where('execution_id', '=', execution.id).execute()).toHaveLength(1);
    await expect(db.updateTable('agent_action_effects').set({ result: '{}' })
      .where('execution_id', '=', execution.id).execute()).rejects.toThrow(/immutable/u);
    await expect(db.deleteFrom('agent_action_effects').where('execution_id', '=', execution.id)
      .execute()).rejects.toThrow(/immutable/u);
  });

  it('lets a successor reconcile one committed effect after lease loss and revocation', async () => {
    await db.updateTable('agent_executions').set({ state: 'reserved', fence_token: 0,
      lease_owner: null, lease_expires_at: null }).where('id', '=', execution.id).execute();
    const reserved = { ...execution, state: 'reserved' as const, fenceToken: 0,
      leaseOwner: undefined };
    const repository = new AgentExecutionRepository(db);
    let rejectFirstCompletion = true;
    let invocations = 0;
    const store: AgentExecutionStore = {
      reserveAndConsume: (input) => repository.reserveAndConsume(input),
      claim: (input) => repository.claim(input),
      recoverEffect: (input) => repository.recoverEffect(input),
      complete: async (input) => {
        if (rejectFirstCompletion) { rejectFirstCompletion = false; return false; }
        return repository.complete(input);
      },
    };
    let auditSequence = 0;
    const service = new DurableAgentExecutionService(store, {
      async invoke(input) { invocations += 1; return adapter.invoke(input); },
    }, { now: () => new Date() }, { executionId: () => 'unused_execution',
      auditId: () => `audit_recovery_${++auditSequence}` }, adapter);
    await expect(service.run({ action, execution: reserved, workerId: 'worker_first' }))
      .rejects.toBeInstanceOf(AgentExecutionConflictError);
    await db.updateTable('agent_executions').set({ lease_expires_at: new Date(Date.now() - 60_000) })
      .where('id', '=', execution.id).execute();
    await db.updateTable('agent_approvals').set({ revoked_at: new Date() })
      .where('id', '=', execution.approvalId).execute();
    await db.updateTable('agent_principals').set({ state: 'revoked' })
      .where('id', '=', execution.agentPrincipalId).execute();
    await db.updateTable('agent_delegations').set({ revoked_at: new Date() })
      .where('id', '=', execution.delegationGrantId).execute();
    await expect(service.run({ action, execution: reserved, workerId: 'worker_successor' }))
      .resolves.toMatchObject({ state: 'succeeded', result: { status: 'published' } });
    expect(invocations).toBe(1);
    expect(await db.selectFrom('events').select(['status', 'version'])
      .where('id', '=', action.target.resourceId).executeTakeFirstOrThrow())
      .toMatchObject({ status: 'published', version: action.target.resourceVersion + 1 });
    expect(await db.selectFrom('agent_action_effects').select('execution_id')
      .where('execution_id', '=', execution.id).execute()).toHaveLength(1);
    expect(await db.selectFrom('agent_executions').select('state').where('id', '=', execution.id)
      .executeTakeFirstOrThrow()).toMatchObject({ state: 'succeeded' });
  });

  it.each([
    { resourceVersion: 999, status: 'published' },
    { resourceVersion: 2, status: 'failed' },
  ])('rejects a semantically forged persisted effect result: %o', async (override) => {
    const forged = { resourceId: action.target.resourceId, ...override };
    await db.insertInto('agent_action_effects').values({ execution_id: execution.id,
      tenant_id: execution.tenantId, action_digest: execution.actionDigest,
      resource_type: 'event', resource_id: action.target.resourceId, operation: 'events.publish',
      idempotency_key: execution.idempotencyKey, expected_policy_version: execution.policyVersion,
      expected_resource_version: execution.resourceVersion, effect_fence_token: execution.fenceToken,
      result: JSON.stringify(forged), result_sha256: agentSha256(forged), created_at: new Date() }).execute();
    const state = await adapter.load({ action, execution });
    await expect(adapter.invoke(invocation(agentAuthorizationStateDigest(state))))
      .rejects.toMatchObject({ code: 'AGENT_AUTHORIZATION_CHANGED' });
  });

  it.each(['approval', 'policy', 'resource', 'lease_expiry', 'successor_fence'] as const)(
    'rejects a %s change committed between load and invoke', async (changed) => {
      const state = await adapter.load({ action, execution });
      if (changed === 'approval') await db.updateTable('agent_approvals').set({ revoked_at: new Date() })
        .where('id', '=', execution.approvalId).execute();
      if (changed === 'policy') await db.updateTable('agent_action_policies')
        .set({ policy_version: 4 }).where('tenant_id', '=', execution.tenantId).execute();
      if (changed === 'resource') await db.updateTable('events').set({ version: 2 })
        .where('id', '=', action.target.resourceId).execute();
      if (changed === 'lease_expiry') await db.updateTable('agent_executions')
        .set({ lease_expires_at: new Date(Date.now() - 60_000) }).where('id', '=', execution.id).execute();
      if (changed === 'successor_fence') await db.updateTable('agent_executions')
        .set({ fence_token: 2, lease_owner: 'worker_successor' }).where('id', '=', execution.id).execute();
      await expect(adapter.invoke(invocation(agentAuthorizationStateDigest(state))))
        .rejects.toMatchObject({ code: 'AGENT_AUTHORIZATION_CHANGED' });
      expect(await db.selectFrom('events').select('status').where('id', '=', action.target.resourceId)
        .executeTakeFirstOrThrow()).toMatchObject({ status: 'draft' });
      expect(await db.selectFrom('agent_action_effects').select('execution_id')
        .where('execution_id', '=', execution.id).execute()).toHaveLength(0);
    },
  );
});
