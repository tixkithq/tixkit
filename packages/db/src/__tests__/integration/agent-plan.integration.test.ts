import {
  AGENT_PLATFORM_PROTOCOL_VERSION,
  AGENT_PROTOCOL_VERSION,
  agentActionDigest,
  agentSha256,
  buildAgentPlanDefinition,
  canonicalAgentJson,
  type AgentAction,
} from '@tixkit/agent-protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../../client.js';
import { runMigrations, truncateAllData } from '../../migrate.js';
import { AgentPlansMigration } from '../../migrations/0084_agent_plans.js';
import { AgentExecutionPlanBindingMigration } from '../../migrations/0085_agent_execution_plan_binding.js';
import {
  AgentExecutionRepository,
  AgentPlanRepository,
  BrandRepository,
  EventRepository,
  OrganizationRepository,
  TenantRepository,
} from '../../repositories/index.js';

type DriverCase = { driver: 'postgres' | 'mysql' | 'mssql'; url: string };
const requestedDriver = process.env.DB_INTEGRATION_DRIVER;
const driverCases: DriverCase[] = [
  { driver: 'postgres', url: process.env.DATABASE_URL ?? '' },
  { driver: 'mysql', url: process.env.DATABASE_URL_MYSQL ?? '' },
  { driver: 'mssql', url: process.env.DATABASE_URL_MSSQL ?? '' },
].filter(
  (candidate) =>
    candidate.url.length > 0 && (!requestedDriver || candidate.driver === requestedDriver),
) as DriverCase[];

if (driverCases.length === 0)
  it.skip('agent plan integration (database URLs are not configured)', () => {});

describe.sequential.each(driverCases)('agent plan persistence: $driver', ({ driver, url }) => {
  let db: Database;
  let tenantId: string;
  let eventId: string;
  let action: AgentAction;
  let plan: ReturnType<typeof buildAgentPlanDefinition>;

  beforeAll(async () => {
    process.env.DB_DRIVER = driver;
    await runMigrations(url);
    db = createDb(url);
    await truncateAllData(db);
    tenantId = (await new TenantRepository(db).create({ name: `Agent plan ${driver}` })).id;
    const organization = await new OrganizationRepository(db).create({
      tenantId,
      name: `Agent plan ${driver} organization`,
      slug: `agent-plan-${driver}-organization`,
    });
    const brand = await new BrandRepository(db).create({
      tenantId,
      organizationId: organization.id,
      name: `Agent plan ${driver} brand`,
      slug: `agent-plan-${driver}-brand`,
    });
    eventId = (
      await new EventRepository(db).create({
        tenantId,
        organizationId: organization.id,
        brandId: brand.id,
        slug: `agent-plan-${driver}-event`,
        title: `Agent plan ${driver} event`,
        currency: 'USD',
        timezone: 'America/Chicago',
        startsAt: new Date('2027-01-01T18:00:00.000Z'),
      })
    ).id;
    const base = new Date(Math.floor(Date.now() / 1000) * 1000);
    await db
      .insertInto('user_profiles')
      .values({
        id: 'user_plan_sponsor',
        tenant_id: tenantId,
        clerk_user_id: `clerk_agent_plan_${driver}`,
        email: `agent-plan-${driver}@example.test`,
        first_name: null,
        last_name: null,
        avatar_url: null,
        status: 'active',
        last_seen_at: null,
        created_at: base,
        updated_at: base,
      })
      .execute();
    await db
      .insertInto('permission_grants')
      .values(
        ['developers.write', 'events.write'].map((permission, index) => ({
          id: `permission_agent_plan_${index}`,
          tenant_id: tenantId,
          principal_type: 'user' as const,
          principal_id: 'user_plan_sponsor',
          permission,
          scope_type: 'tenant' as const,
          scope_id: null,
          created_at: base,
          updated_at: base,
        })),
      )
      .execute();
    await db
      .insertInto('organization_members')
      .values({
        id: 'member_agent_plan',
        tenant_id: tenantId,
        organization_id: organization.id,
        user_id: 'user_plan_sponsor',
        role: 'owner',
        invited_at: base,
        accepted_at: base,
        created_at: base,
        updated_at: base,
      })
      .execute();
    const identityRepository = new AgentExecutionRepository(db);
    await identityRepository.registerPrincipal(
      {
        id: 'agent_plan_test',
        tenantId,
        kind: 'third_party',
        sponsorPrincipalId: 'user_plan_sponsor',
        capabilities: ['events.execute'],
        maximumAutonomy: 'execute_with_approval',
        protocolVersion: AGENT_PROTOCOL_VERSION,
        state: 'active',
        registeredAt: new Date(base.getTime() - 5_000).toISOString(),
      },
      {
        id: 'audit_register_agent_plan',
        actorPrincipalId: 'user_plan_sponsor',
        reasonCode: 'TEST_AUTHORIZATION',
        idempotencyKey: 'agent-plan-register-2026',
      },
    );
    await identityRepository.grantDelegation(
      {
        id: 'delegation_plan_test',
        tenantId,
        agentPrincipalId: 'agent_plan_test',
        sponsorPrincipalId: 'user_plan_sponsor',
        capabilities: ['events.execute'],
        resourceScopes: [`event:${eventId}`],
        permissionSnapshot: ['events:publish', 'events:write'],
        issuedAt: base.toISOString(),
        expiresAt: new Date(base.getTime() + 3_600_000).toISOString(),
      },
      {
        id: 'audit_grant_agent_plan',
        actorPrincipalId: 'user_plan_sponsor',
        reasonCode: 'TEST_AUTHORIZATION',
        idempotencyKey: 'agent-plan-grant-2026',
      },
    );
    const event = await db
      .selectFrom('events')
      .select('version')
      .where('tenant_id', '=', tenantId)
      .where('id', '=', eventId)
      .executeTakeFirstOrThrow();
    const preparedAt = new Date(base.getTime() - 2_000).toISOString();
    const createdAt = new Date(base.getTime() - 1_000).toISOString();
    const expiresAt = new Date(base.getTime() + 600_000).toISOString();
    action = {
      id: 'action_plan_publish',
      protocolVersion: AGENT_PROTOCOL_VERSION,
      agentPrincipalId: 'agent_plan_test',
      sponsorPrincipalId: 'user_plan_sponsor',
      delegationGrantId: 'delegation_plan_test',
      kind: 'event.publish',
      autonomy: 'execute_with_approval',
      target: {
        tenantId,
        resourceType: 'event',
        resourceId: eventId,
        resourceVersion: Number(event.version),
        apiOperation: 'events.publish',
      },
      payload: { readinessSnapshotSha256: 'd'.repeat(64) },
      idempotencyKey: 'agent-plan-action-2026',
      expectedPolicyVersion: 3,
      preparedAt,
    };
    const actionDigest = agentActionDigest(action);
    await db
      .insertInto('agent_actions')
      .values({
        id: action.id,
        tenant_id: tenantId,
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
        request_fingerprint: agentSha256({ action }),
        authorization_snapshot_sha256: 'a'.repeat(64),
        authorization_reasons: '["approval_required"]',
        dry_run_json: canonicalAgentJson({
          launchable: true,
          readinessSnapshotSha256: action.payload.readinessSnapshotSha256,
          blockingReasonCodes: [],
        }),
        eligible_for_approval: true,
        prepared_at: new Date(preparedAt),
        expires_at: new Date(expiresAt),
      })
      .execute();
    plan = buildAgentPlanDefinition({
      id: 'plan_publish_test',
      protocolVersion: AGENT_PLATFORM_PROTOCOL_VERSION,
      tenantId,
      agentPrincipalId: action.agentPrincipalId,
      sponsorPrincipalId: action.sponsorPrincipalId,
      delegationGrantId: action.delegationGrantId,
      purpose: 'Publish the reviewed event configuration',
      assumptions: [
        {
          id: 'assumption_plan_reviewed',
          statement: 'The organizer reviewed the event launch configuration.',
          provenanceType: 'user',
          sourceReference: 'agent_plan_integration_test',
          verification: 'confirmed',
        },
      ],
      steps: [
        {
          id: 'step_publish',
          actionKind: action.kind,
          actionProtocolVersion: action.protocolVersion,
          actionDigest,
          dependsOnStepIds: [],
          projectedChanges: [
            {
              resourceType: action.target.resourceType,
              resourceId: action.target.resourceId,
              operation: 'publish',
              beforeVersion: action.target.resourceVersion,
              projectedVersion: action.target.resourceVersion + 1,
              previewSha256: 'b'.repeat(64),
            },
          ],
          costs: [
            {
              amountMinor: 0,
              currency: 'USD',
              basis: 'Event publication has no direct platform charge.',
              quoteSha256: 'c'.repeat(64),
              expiresAt,
            },
          ],
          readinessImpact: {
            beforeSnapshotSha256: 'd'.repeat(64),
            projectedSnapshotSha256: 'e'.repeat(64),
            introducedReasonCodes: [],
            resolvedReasonCodes: ['event_unpublished'],
          },
          approvalRequirement: { mode: 'fresh_action', riskClass: 'high' },
          reversibility: { mode: 'none' },
        },
      ],
      createdAt,
      expiresAt,
    });
  });

  afterAll(async () => {
    await db?.destroy();
  });

  it('persists immutable definitions, exact action links and idempotent initial state', async () => {
    const repository = new AgentPlanRepository(db);
    const input = {
      definition: plan,
      actionBindings: [{ stepId: 'step_publish', actionId: action.id }],
      actor: { type: 'agent' as const, tenantId, principalId: plan.agentPrincipalId },
      idempotencyKey: 'agent-plan-create-2026',
    };
    const created = await repository.create(input);
    expect(created.state).toMatchObject({
      planId: plan.id,
      planSha256: plan.planSha256,
      stateVersion: 1,
      status: 'prepared',
      stepStates: [{ stepId: 'step_publish', status: 'pending' }],
    });
    expect(new Date(created.state.updatedAt).getTime()).toBeGreaterThan(
      new Date(plan.createdAt).getTime(),
    );
    await expect(repository.create(input)).resolves.toEqual(created);
    await expect(
      repository.create({
        ...input,
        actor: { type: 'user', tenantId, principalId: plan.sponsorPrincipalId },
      }),
    ).rejects.toThrow('AGENT_PLAN_ACTOR_DENIED');
    await expect(
      repository.create({ ...input, actionBindings: [{ stepId: 'wrong', actionId: action.id }] }),
    ).rejects.toThrow('AGENT_PLAN_ACTION_BINDINGS_INVALID');
    await expect(
      repository.getForAgent({
        tenantId,
        agentPrincipalId: plan.agentPrincipalId,
        planId: plan.id,
      }),
    ).resolves.toEqual(created);
    await expect(
      repository.getForAgent({
        tenantId,
        agentPrincipalId: 'agent_other',
        planId: plan.id,
      }),
    ).resolves.toBeUndefined();
    await expect(
      repository.getForSponsor({
        tenantId,
        sponsorPrincipalId: plan.sponsorPrincipalId,
        planId: plan.id,
      }),
    ).resolves.toEqual(created);
    await expect(
      db
        .updateTable('agent_plans')
        .set({ plan_sha256: 'f'.repeat(64) })
        .execute(),
    ).rejects.toThrow(/immutable/u);
    await expect(db.deleteFrom('agent_plan_actions').execute()).rejects.toThrow(/immutable/u);
    await expect(AgentPlansMigration.down!(db)).rejects.toThrow('rollback refused');
  });

  it('isolates client-selected plan and event identities across tenants', async () => {
    const otherTenantId = (
      await new TenantRepository(db).create({ name: `Agent plan collision ${driver}` })
    ).id;
    const now = new Date(Math.floor(Date.now() / 1000) * 1000);
    const otherAgentId = `agent_plan_other_${driver}`;
    const otherSponsorId = `user_plan_other_${driver}`;
    const otherDelegationId = `delegation_plan_other_${driver}`;
    await db
      .insertInto('agent_principals')
      .values({
        id: otherAgentId,
        tenant_id: otherTenantId,
        kind: 'third_party',
        sponsor_principal_id: otherSponsorId,
        capabilities: '["events.execute"]',
        maximum_autonomy: 'execute_with_approval',
        protocol_version: AGENT_PROTOCOL_VERSION,
        state: 'active',
        registered_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto('agent_delegations')
      .values({
        id: otherDelegationId,
        tenant_id: otherTenantId,
        agent_principal_id: otherAgentId,
        sponsor_principal_id: otherSponsorId,
        capabilities: '["events.execute"]',
        resource_scopes: '["event:event_plan_shared"]',
        permission_snapshot: '["events:publish","events:write"]',
        issued_at: now,
        expires_at: new Date(now.getTime() + 3_600_000),
        revoked_at: null,
        created_at: now,
      })
      .execute();
    const otherAction: AgentAction = {
      ...action,
      id: `action_plan_other_${driver}`,
      agentPrincipalId: otherAgentId,
      sponsorPrincipalId: otherSponsorId,
      delegationGrantId: otherDelegationId,
      target: {
        ...action.target,
        tenantId: otherTenantId,
        resourceId: 'event_plan_shared',
      },
      idempotencyKey: 'agent-plan-other-action-2026',
      preparedAt: new Date(now.getTime() - 2_000).toISOString(),
    };
    const otherActionDigest = agentActionDigest(otherAction);
    await db
      .insertInto('agent_actions')
      .values({
        id: otherAction.id,
        tenant_id: otherTenantId,
        agent_principal_id: otherAgentId,
        sponsor_principal_id: otherSponsorId,
        delegation_grant_id: otherDelegationId,
        action_kind: otherAction.kind,
        action_digest: otherActionDigest,
        action_json: canonicalAgentJson(otherAction),
        resource_type: otherAction.target.resourceType,
        resource_id: otherAction.target.resourceId,
        resource_version: otherAction.target.resourceVersion,
        policy_version: otherAction.expectedPolicyVersion,
        idempotency_key: otherAction.idempotencyKey,
        request_fingerprint: agentSha256({ action: otherAction }),
        authorization_snapshot_sha256: 'a'.repeat(64),
        authorization_reasons: '["approval_required"]',
        dry_run_json: canonicalAgentJson({
          launchable: true,
          readinessSnapshotSha256: otherAction.payload.readinessSnapshotSha256,
          blockingReasonCodes: [],
        }),
        eligible_for_approval: true,
        prepared_at: new Date(otherAction.preparedAt),
        expires_at: new Date(now.getTime() + 600_000),
      })
      .execute();
    const otherPlan = buildAgentPlanDefinition({
      id: plan.id,
      protocolVersion: plan.protocolVersion,
      tenantId: otherTenantId,
      agentPrincipalId: otherAgentId,
      sponsorPrincipalId: otherSponsorId,
      delegationGrantId: otherDelegationId,
      purpose: plan.purpose,
      assumptions: plan.assumptions,
      steps: plan.steps.map((step) => ({
        ...step,
        actionDigest: otherActionDigest,
        projectedChanges: step.projectedChanges.map((change) => ({
          ...change,
          resourceId: otherAction.target.resourceId,
        })),
      })),
      createdAt: new Date(now.getTime() - 1_000).toISOString(),
      expiresAt: new Date(now.getTime() + 600_000).toISOString(),
    });
    const repository = new AgentPlanRepository(db);
    await expect(
      repository.create({
        definition: otherPlan,
        actionBindings: [{ stepId: 'step_publish', actionId: otherAction.id }],
        actor: { type: 'agent', tenantId: otherTenantId, principalId: otherAgentId },
        idempotencyKey: 'agent-plan-other-create-2026',
      }),
    ).resolves.toMatchObject({ definition: { id: plan.id, tenantId: otherTenantId } });
    await expect(
      repository.getForAgent({
        tenantId: otherTenantId,
        agentPrincipalId: otherAgentId,
        planId: plan.id,
      }),
    ).resolves.toMatchObject({ definition: { tenantId: otherTenantId } });
    await expect(
      repository.getForAgent({
        tenantId,
        agentPrincipalId: plan.agentPrincipalId,
        planId: plan.id,
      }),
    ).resolves.toMatchObject({ definition: { tenantId } });

    const sharedTransition = {
      expectedStateVersion: 1,
      status: 'awaiting_approval' as const,
      stepStates: [{ stepId: 'step_publish', status: 'awaiting_approval' as const }],
      reasonCode: 'approval_requested',
      idempotencyKey: 'agent-plan-shared-transition-2026',
    };
    await expect(
      repository.transition({
        ...sharedTransition,
        tenantId,
        planId: plan.id,
        actor: { type: 'agent', tenantId, principalId: plan.agentPrincipalId },
      }),
    ).resolves.toMatchObject({ state: { stateVersion: 2 } });
    await expect(
      repository.transition({
        ...sharedTransition,
        tenantId: otherTenantId,
        planId: otherPlan.id,
        actor: { type: 'agent', tenantId: otherTenantId, principalId: otherAgentId },
      }),
    ).resolves.toMatchObject({ state: { stateVersion: 2 } });
    const sharedEvents = await db
      .selectFrom('agent_plan_state_events')
      .select(['tenant_id', 'id'])
      .where('plan_id', '=', plan.id)
      .execute();
    expect(sharedEvents).toHaveLength(4);
    expect(new Set(sharedEvents.map(({ id }) => id)).size).toBe(4);
  });

  it('advances state only with authoritative approval evidence and CAS', async () => {
    const repository = new AgentPlanRepository(db);
    await expect(
      repository.getForAgent({
        tenantId,
        agentPrincipalId: plan.agentPrincipalId,
        planId: plan.id,
      }),
    ).resolves.toMatchObject({ state: { stateVersion: 2, status: 'awaiting_approval' } });
    const approvedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
    const approvalId = 'approval_plan_publish';
    await db
      .insertInto('agent_approvals')
      .values({
        id: approvalId,
        tenant_id: tenantId,
        action_id: action.id,
        action_digest: agentActionDigest(action),
        plan_sha256: plan.planSha256,
        approver_principal_id: plan.sponsorPrincipalId,
        approver_permission_snapshot: '["events:publish"]',
        policy_version: action.expectedPolicyVersion,
        approved_at: approvedAt,
        expires_at: new Date(approvedAt.getTime() + 300_000),
        revoked_at: null,
        consumed_at: null,
        consumed_execution_id: null,
      })
      .execute();
    await expect(
      repository.transition({
        tenantId,
        planId: plan.id,
        expectedStateVersion: 2,
        status: 'awaiting_approval',
        stepStates: [
          {
            stepId: 'step_publish',
            status: 'awaiting_approval',
            approvalId: 'approval_substituted',
          },
        ],
        actor: { type: 'user', tenantId, principalId: plan.sponsorPrincipalId },
        reasonCode: 'action_approved',
        idempotencyKey: 'agent-plan-transition-forged-2026',
      }),
    ).rejects.toThrow('approval evidence is unavailable');
    const transition = {
      tenantId,
      planId: plan.id,
      expectedStateVersion: 2,
      status: 'awaiting_approval' as const,
      stepStates: [{ stepId: 'step_publish', status: 'awaiting_approval' as const, approvalId }],
      actor: { type: 'user' as const, tenantId, principalId: plan.sponsorPrincipalId },
      reasonCode: 'action_approved',
      idempotencyKey: 'agent-plan-transition-approved-2026',
    };
    const advanced = await repository.transition(transition);
    expect(advanced.state).toMatchObject({ stateVersion: 3, status: 'awaiting_approval' });
    await expect(repository.transition(transition)).resolves.toEqual(advanced);
    const later = await repository.transition({
      ...transition,
      expectedStateVersion: 3,
      reasonCode: 'approval_observed',
      idempotencyKey: 'agent-plan-transition-observed-2026',
    });
    expect(later.state.stateVersion).toBe(4);
    await expect(repository.transition(transition)).resolves.toEqual(advanced);
    await expect(
      repository.create({
        definition: plan,
        actionBindings: [{ stepId: 'step_publish', actionId: action.id }],
        actor: { type: 'agent', tenantId, principalId: plan.agentPrincipalId },
        idempotencyKey: 'agent-plan-create-2026',
      }),
    ).resolves.toMatchObject({ state: { stateVersion: 1, status: 'prepared' } });
    await expect(
      repository.transition({
        ...transition,
        expectedStateVersion: 2,
        idempotencyKey: 'agent-plan-transition-stale-2026',
      }),
    ).rejects.toThrow('AGENT_PLAN_STATE_CONFLICT');
    const eventRows = await db
      .selectFrom('agent_plan_state_events')
      .select(['previous_state_version', 'next_state_version', 'actor_type', 'reason_code'])
      .where('tenant_id', '=', tenantId)
      .where('plan_id', '=', plan.id)
      .orderBy('next_state_version')
      .execute();
    expect(eventRows).toHaveLength(4);
    expect(eventRows[2]).toMatchObject({
      actor_type: 'user',
      reason_code: 'action_approved',
    });
    expect(Number(eventRows[2]!.previous_state_version)).toBe(2);
    expect(Number(eventRows[2]!.next_state_version)).toBe(3);
    await expect(
      db.updateTable('agent_plan_state_events').set({ reason_code: 'tampered' }).execute(),
    ).rejects.toThrow(/immutable/u);
  });

  it('binds one consumed approval to the exact execution and terminal result', async () => {
    const repository = new AgentPlanRepository(db);
    const executionId = 'execution_plan_publish';
    const consumedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
    await db
      .updateTable('agent_approvals')
      .set({ consumed_at: consumedAt, consumed_execution_id: 'execution_substituted' })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', 'approval_plan_publish')
      .execute();
    const execution = {
      id: executionId,
      tenant_id: tenantId,
      action_id: action.id,
      action_digest: agentActionDigest(action),
      plan_sha256: plan.planSha256,
      agent_principal_id: plan.agentPrincipalId,
      sponsor_principal_id: plan.sponsorPrincipalId,
      delegation_grant_id: plan.delegationGrantId,
      approval_id: 'approval_plan_publish',
      idempotency_key: 'agent-plan-execution-2026',
      request_fingerprint: agentSha256({ actionId: action.id, executionId }),
      state: 'running',
      resource_version: action.target.resourceVersion,
      policy_version: action.expectedPolicyVersion,
      fence_token: 1,
      lease_owner: 'worker_agent_plan',
      lease_expires_at: new Date(consumedAt.getTime() + 60_000),
      result: null,
      failure_code: null,
      created_at: consumedAt,
      updated_at: consumedAt,
    };
    await db.insertInto('agent_executions').values(execution).execute();
    const executingTransition = {
      tenantId,
      planId: plan.id,
      expectedStateVersion: 4,
      status: 'executing' as const,
      stepStates: [
        {
          stepId: 'step_publish',
          status: 'executing' as const,
          approvalId: 'approval_plan_publish',
          executionId,
        },
      ],
      actor: { type: 'agent' as const, tenantId, principalId: plan.agentPrincipalId },
      reasonCode: 'execution_started',
      idempotencyKey: 'agent-plan-transition-executing-2026',
    };
    await expect(repository.transition(executingTransition)).rejects.toThrow(
      'AGENT_PLAN_EXECUTION_APPROVAL_BINDING_INVALID',
    );
    await db
      .updateTable('agent_approvals')
      .set({ consumed_execution_id: executionId })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', 'approval_plan_publish')
      .execute();
    const raceDb = createDb(url);
    try {
      let releaseApproval!: () => void;
      let approvalLocked!: () => void;
      const releaseApprovalPromise = new Promise<void>((resolve) => {
        releaseApproval = resolve;
      });
      const approvalLockedPromise = new Promise<void>((resolve) => {
        approvalLocked = resolve;
      });
      const revokeRace = raceDb.transaction().execute(async (tx) => {
        await tx
          .selectFrom('agent_approvals')
          .select('id')
          .where('tenant_id', '=', tenantId)
          .where('id', '=', 'approval_plan_publish')
          .forUpdate()
          .executeTakeFirstOrThrow();
        approvalLocked();
        await releaseApprovalPromise;
        await tx
          .updateTable('agent_approvals')
          .set({ revoked_at: new Date() })
          .where('tenant_id', '=', tenantId)
          .where('id', '=', 'approval_plan_publish')
          .execute();
      });
      await approvalLockedPromise;
      const racedTransition = repository.transition(executingTransition);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      releaseApproval();
      await revokeRace;
      await expect(racedTransition).rejects.toThrow();
      await db
        .updateTable('agent_approvals')
        .set({ revoked_at: null })
        .where('tenant_id', '=', tenantId)
        .where('id', '=', 'approval_plan_publish')
        .execute();

      let releaseExecution!: () => void;
      let executionLocked!: () => void;
      const releaseExecutionPromise = new Promise<void>((resolve) => {
        releaseExecution = resolve;
      });
      const executionLockedPromise = new Promise<void>((resolve) => {
        executionLocked = resolve;
      });
      const executionRace = raceDb.transaction().execute(async (tx) => {
        await tx
          .selectFrom('agent_executions')
          .select('id')
          .where('tenant_id', '=', tenantId)
          .where('id', '=', executionId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        executionLocked();
        await releaseExecutionPromise;
        await tx
          .updateTable('agent_executions')
          .set({ state: 'failed', failure_code: 'RACE_FAILURE' })
          .where('tenant_id', '=', tenantId)
          .where('id', '=', executionId)
          .execute();
      });
      await executionLockedPromise;
      const executionRaceTransition = repository.transition(executingTransition);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      releaseExecution();
      await executionRace;
      await expect(executionRaceTransition).rejects.toThrow();
      await db
        .updateTable('agent_executions')
        .set({ state: 'running', failure_code: null })
        .where('tenant_id', '=', tenantId)
        .where('id', '=', executionId)
        .execute();
    } finally {
      await raceDb.destroy();
    }
    await expect(
      db
        .insertInto('agent_executions')
        .values({ ...execution, id: 'execution_plan_duplicate' })
        .execute(),
    ).rejects.toThrow();
    const executing = await repository.transition(executingTransition);
    expect(executing.state.stateVersion).toBe(5);

    const result = {
      resourceId: eventId,
      resourceVersion: action.target.resourceVersion + 1,
      status: 'published',
    };
    await db
      .updateTable('agent_executions')
      .set({ state: 'succeeded', result: canonicalAgentJson(result), updated_at: new Date() })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', executionId)
      .execute();
    const succeeded = await repository.transition({
      ...executingTransition,
      expectedStateVersion: 5,
      status: 'succeeded',
      stepStates: [
        {
          stepId: 'step_publish',
          status: 'succeeded',
          approvalId: 'approval_plan_publish',
          executionId,
          resultSha256: agentSha256(result),
        },
      ],
      reasonCode: 'execution_succeeded',
      idempotencyKey: 'agent-plan-transition-succeeded-2026',
    });
    expect(succeeded.state).toMatchObject({ stateVersion: 6, status: 'succeeded' });
    await expect(AgentExecutionPlanBindingMigration.down!(db)).rejects.toThrow('rollback refused');
  });

  it('reauthorizes tenant-scoped actors for every transition', async () => {
    const repository = new AgentPlanRepository(db);
    const transition = {
      tenantId,
      planId: plan.id,
      expectedStateVersion: 6,
      status: 'succeeded' as const,
      stepStates: [
        {
          stepId: 'step_publish',
          status: 'succeeded' as const,
          approvalId: 'approval_plan_publish',
          executionId: 'execution_plan_publish',
          resultSha256: agentSha256({
            resourceId: eventId,
            resourceVersion: action.target.resourceVersion + 1,
            status: 'published',
          }),
        },
      ],
      reasonCode: 'authorization_probe',
    };
    for (const actor of [
      { type: 'user' as const, tenantId, principalId: 'user_spoofed' },
      {
        type: 'user' as const,
        tenantId: 'tenant_cross_scope',
        principalId: plan.sponsorPrincipalId,
      },
      {
        type: 'system',
        tenantId,
        principalId: 'tixkit-agent-plan-state',
      } as unknown as { type: 'user'; tenantId: string; principalId: string },
    ])
      await expect(
        repository.transition({
          ...transition,
          actor,
          idempotencyKey: `agent-plan-auth-${actor.principalId}-2026`,
        }),
      ).rejects.toThrow('AGENT_PLAN_ACTOR_DENIED');

    await db
      .updateTable('agent_principals')
      .set({ state: 'suspended', updated_at: new Date() })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', plan.agentPrincipalId)
      .execute();
    await expect(
      repository.transition({
        ...transition,
        actor: { type: 'agent', tenantId, principalId: plan.agentPrincipalId },
        idempotencyKey: 'agent-plan-auth-suspended-2026',
      }),
    ).rejects.toThrow('AGENT_PLAN_ACTOR_DENIED');
    await db
      .updateTable('agent_principals')
      .set({ state: 'active', updated_at: new Date() })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', plan.agentPrincipalId)
      .execute();

    await db
      .updateTable('user_profiles')
      .set({ status: 'inactive', updated_at: new Date() })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', plan.sponsorPrincipalId)
      .execute();
    await expect(
      repository.transition({
        ...transition,
        actor: { type: 'user', tenantId, principalId: plan.sponsorPrincipalId },
        idempotencyKey: 'agent-plan-auth-inactive-2026',
      }),
    ).rejects.toThrow('AGENT_PLAN_ACTOR_DENIED');
    await db
      .updateTable('user_profiles')
      .set({ status: 'active', updated_at: new Date() })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', plan.sponsorPrincipalId)
      .execute();

    await db
      .deleteFrom('permission_grants')
      .where('tenant_id', '=', tenantId)
      .where('id', '=', 'permission_agent_plan_1')
      .execute();
    await expect(
      repository.transition({
        ...transition,
        actor: { type: 'user', tenantId, principalId: plan.sponsorPrincipalId },
        idempotencyKey: 'agent-plan-auth-permission-2026',
      }),
    ).rejects.toThrow('AGENT_PLAN_ACTOR_DENIED');
    const now = new Date();
    await db
      .insertInto('permission_grants')
      .values({
        id: 'permission_agent_plan_1',
        tenant_id: tenantId,
        principal_type: 'user',
        principal_id: plan.sponsorPrincipalId,
        permission: 'events.write',
        scope_type: 'tenant',
        scope_id: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .updateTable('user_profiles')
      .set({ status: 'inactive', updated_at: new Date() })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', plan.sponsorPrincipalId)
      .execute();
    await db
      .updateTable('agent_principals')
      .set({ state: 'suspended', updated_at: new Date() })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', plan.agentPrincipalId)
      .execute();
    const events = await db
      .selectFrom('agent_plan_state_events')
      .select(['actor_authorization_json', 'actor_authorization_sha256'])
      .where('tenant_id', '=', tenantId)
      .where('plan_id', '=', plan.id)
      .execute();
    expect(events).toHaveLength(6);
    const snapshots = events.map(({ actor_authorization_json, actor_authorization_sha256 }) => {
      const snapshot: unknown = JSON.parse(actor_authorization_json);
      expect(agentSha256(snapshot)).toBe(actor_authorization_sha256);
      expect(canonicalAgentJson(snapshot)).toBe(actor_authorization_json);
      return snapshot as Record<string, unknown>;
    });
    expect(
      snapshots.some(
        (snapshot) =>
          snapshot.principal &&
          typeof snapshot.principal === 'object' &&
          'state' in snapshot.principal &&
          snapshot.principal.state === 'active',
      ),
    ).toBe(true);
    expect(
      snapshots.some(
        (snapshot) =>
          snapshot.sponsor &&
          typeof snapshot.sponsor === 'object' &&
          'status' in snapshot.sponsor &&
          snapshot.sponsor.status === 'active',
      ),
    ).toBe(true);
  });

  it('rolls back only an empty plan store and reapplies cleanly', async () => {
    await truncateAllData(db);
    await expect(AgentPlansMigration.down!(db)).resolves.toBeUndefined();
    await expect(db.selectFrom('agent_plans').select('id').execute()).rejects.toThrow();
    await expect(AgentPlansMigration.up!(db)).resolves.toBeUndefined();
    await expect(db.selectFrom('agent_plans').select('id').execute()).resolves.toEqual([]);
  });
});
