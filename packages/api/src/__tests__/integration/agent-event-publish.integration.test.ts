import {
  AGENT_PROTOCOL_VERSION,
  AGENT_PLATFORM_PROTOCOL_VERSION,
  agentActionDigest,
  agentAuthorizationStateDigest,
  agentSha256,
  AgentExecutionConflictError,
  DurableAgentExecutionService,
  buildAgentPlanDefinition,
  validateAgentEventReadResult,
  type AgentAction,
  type AgentExecution,
  type AgentExecutionStore,
} from '@tixkit/agent-protocol';
import { createHash } from 'node:crypto';
import type { Permission } from '@tixkit/domain';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BrandRepository,
  createDb,
  EventRepository,
  OrganizationRepository,
  runMigrations,
  AgentExecutionRepository,
  AgentPlanRepository,
  TenantRepository,
  truncateAllData,
  type Database,
} from '@tixkit/db';
import { AgentActionResultsMigration } from '@tixkit/db/migrations';
import {
  EventPublishAgentAdapter,
  eventPublishReadinessSnapshotSha256,
} from '../../services/agent-event-publish.js';
import { AgentActionService } from '../../services/agent-actions.js';
import { ReadinessService, resolvePaymentMode } from '../../services/readiness.js';
import { publishEvent } from '../../services/event-publication.js';

type DriverCase = { driver: 'postgres' | 'mysql'; url: string };
const requestedDriver = process.env.DB_INTEGRATION_DRIVER;
const driverCases = [
  { driver: 'postgres', url: process.env.DATABASE_URL ?? '' },
  { driver: 'mysql', url: process.env.DATABASE_URL_MYSQL ?? '' },
].filter(
  (item) => item.url && (!requestedDriver || item.driver === requestedDriver),
) as DriverCase[];
if (driverCases.length === 0)
  it.skip('agent event adapter (database URLs not configured)', () => {});

describe.sequential.each(driverCases)(
  'atomic event publish agent adapter: $driver',
  ({ driver, url }) => {
    let db: Database;
    let action: AgentAction;
    let execution: AgentExecution;
    let adapter: EventPublishAgentAdapter;

    beforeAll(async () => {
      process.env.DB_DRIVER = driver;
      await runMigrations(url);
      db = createDb(url);
    });
    afterAll(async () => {
      await db?.destroy();
    });

    beforeEach(async () => {
      await truncateAllData(db);
      const tenant = await new TenantRepository(db).create({ name: `Agent adapter ${driver}` });
      const organization = await new OrganizationRepository(db).create({
        tenantId: tenant.id,
        name: 'Agent adapter org',
        slug: `agent-adapter-${driver}`,
      });
      const brand = await new BrandRepository(db).create({
        tenantId: tenant.id,
        organizationId: organization.id,
        name: 'Agent adapter brand',
        slug: `agent-brand-${driver}`,
      });
      const event = await new EventRepository(db).create({
        tenantId: tenant.id,
        organizationId: organization.id,
        brandId: brand.id,
        slug: `agent-event-${driver}`,
        title: 'Agent event',
        currency: 'USD',
        timezone: 'UTC',
        startsAt: new Date(Date.now() + 86_400_000),
      });
      const currentEvent = await db
        .selectFrom('events')
        .selectAll()
        .where('id', '=', event.id)
        .executeTakeFirstOrThrow();
      const now = new Date();
      await db
        .insertInto('inventory_pools')
        .values({
          id: 'inv_agent_publish',
          event_id: event.id,
          name: 'Agent inventory',
          total_capacity: 100,
          hold_ttl_seconds: 600,
          created_at: now,
          updated_at: now,
        })
        .execute();
      await db
        .insertInto('ticket_types')
        .values({
          id: 'tt_agent_publish',
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
          inventory_pool_id: 'inv_agent_publish',
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
          id: 'ep_agent_publish',
          event_id: event.id,
          locale: 'en',
          title: 'Agent event',
          description: null,
          content_html: '<p>Event</p>',
          is_default: true,
          created_at: now,
          updated_at: now,
        })
        .execute();
      await db
        .insertInto('content_documents')
        .values({
          id: 'cdoc_agent_confirm',
          tenant_id: tenant.id,
          organization_id: organization.id,
          brand_id: brand.id,
          event_id: event.id,
          channel: 'email',
          key: 'order-confirmed',
          name: 'Order confirmation',
          status: 'draft',
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
          id: 'cver_agent_confirm',
          document_id: 'cdoc_agent_confirm',
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
          created_by: 'user_sponsor',
          created_at: now,
          published_at: now,
        })
        .execute();
      await db
        .updateTable('content_documents')
        .set({
          status: 'published',
          current_draft_version_id: 'cver_agent_confirm',
          published_version_id: 'cver_agent_confirm',
        })
        .where('id', '=', 'cdoc_agent_confirm')
        .execute();
      await db
        .insertInto('event_readiness_acknowledgements')
        .values({
          id: 'era_agent_checkout',
          tenant_id: tenant.id,
          organization_id: organization.id,
          brand_id: brand.id,
          event_id: event.id,
          step_id: 'checkout_consent',
          step_version: 1,
          subject_fingerprint: createHash('sha256').update('[]').digest('hex'),
          actor_id: 'user_sponsor',
          acknowledged_at: now,
        })
        .execute();
      await db
        .insertInto('user_profiles')
        .values({
          id: 'user_sponsor',
          tenant_id: tenant.id,
          clerk_user_id: `clerk_sponsor_${driver}`,
          email: `sponsor-${driver}@example.test`,
          first_name: null,
          last_name: null,
          avatar_url: null,
          status: 'active',
          last_seen_at: null,
          created_at: now,
          updated_at: now,
        })
        .execute();
      await db
        .insertInto('organization_members')
        .values({
          id: 'member_agent_publish',
          tenant_id: tenant.id,
          organization_id: organization.id,
          user_id: 'user_sponsor',
          role: 'owner',
          invited_at: now,
          accepted_at: now,
          created_at: now,
          updated_at: now,
        })
        .execute();
      await db
        .insertInto('permission_grants')
        .values([
          {
            id: 'pg_event_publish',
            tenant_id: tenant.id,
            principal_type: 'user',
            principal_id: 'user_sponsor',
            permission: 'events.write',
            scope_type: 'tenant',
            scope_id: null,
            created_at: now,
            updated_at: now,
          },
          {
            id: 'pg_event_readiness_read',
            tenant_id: tenant.id,
            principal_type: 'user',
            principal_id: 'user_sponsor',
            permission: 'events.read',
            scope_type: 'tenant',
            scope_id: null,
            created_at: now,
            updated_at: now,
          },
        ])
        .execute();
      await db
        .insertInto('agent_principals')
        .values({
          id: 'agent_publish',
          tenant_id: tenant.id,
          kind: 'third_party',
          sponsor_principal_id: 'user_sponsor',
          capabilities: JSON.stringify(['events.execute', 'events.read', 'readiness.read']),
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
          id: 'delegation_publish',
          tenant_id: tenant.id,
          agent_principal_id: 'agent_publish',
          sponsor_principal_id: 'user_sponsor',
          capabilities: JSON.stringify(['events.execute', 'events.read', 'readiness.read']),
          resource_scopes: JSON.stringify([`event:${event.id}`]),
          permission_snapshot: JSON.stringify(['events:publish', 'events:read']),
          issued_at: new Date(now.getTime() - 60_000),
          expires_at: new Date(now.getTime() + 3_600_000),
          revoked_at: null,
          created_at: now,
        })
        .execute();
      const readiness = await new ReadinessService(
        db,
        resolvePaymentMode(),
      ).getEventLaunchReadiness({
        tenantId: tenant.id,
        organizationId: organization.id,
        brandId: brand.id,
        eventId: event.id,
        permissions: new Set(['events.write']),
      });
      action = {
        id: 'action_publish',
        protocolVersion: AGENT_PROTOCOL_VERSION,
        agentPrincipalId: 'agent_publish',
        sponsorPrincipalId: 'user_sponsor',
        delegationGrantId: 'delegation_publish',
        kind: 'event.publish',
        autonomy: 'execute_with_approval',
        target: {
          tenantId: tenant.id,
          resourceType: 'event',
          resourceId: event.id,
          resourceVersion: Number(currentEvent.version),
          apiOperation: 'events.publish',
        },
        payload: {
          readinessSnapshotSha256: eventPublishReadinessSnapshotSha256(readiness),
        },
        idempotencyKey: 'agent-publish-integration-0001',
        expectedPolicyVersion: 3,
        preparedAt: now.toISOString(),
      };
      const digest = agentActionDigest(action);
      await db
        .insertInto('agent_approvals')
        .values({
          id: 'approval_publish',
          tenant_id: tenant.id,
          action_digest: digest,
          plan_sha256: null,
          approver_principal_id: 'user_sponsor',
          approver_permission_snapshot: JSON.stringify(['events:publish']),
          policy_version: 3,
          approved_at: new Date(now.getTime() - 5_000),
          expires_at: new Date(now.getTime() + 900_000),
          revoked_at: null,
          consumed_at: new Date(now.getTime() - 4_000),
          consumed_execution_id: 'execution_publish',
        })
        .execute();
      await db
        .insertInto('agent_action_policies')
        .values([
          {
            tenant_id: tenant.id,
            action_kind: 'event.publish',
            allowed: true,
            risk_allowed: true,
            policy_version: 3,
            updated_at: now,
          },
          {
            tenant_id: tenant.id,
            action_kind: 'event.read',
            allowed: true,
            risk_allowed: true,
            policy_version: 1,
            updated_at: now,
          },
          {
            tenant_id: tenant.id,
            action_kind: 'readiness.read',
            allowed: true,
            risk_allowed: true,
            policy_version: 1,
            updated_at: now,
          },
        ])
        .execute();
      await db
        .insertInto('agent_executions')
        .values({
          id: 'execution_publish',
          tenant_id: tenant.id,
          action_id: action.id,
          action_digest: digest,
          agent_principal_id: action.agentPrincipalId,
          sponsor_principal_id: action.sponsorPrincipalId,
          delegation_grant_id: action.delegationGrantId,
          approval_id: 'approval_publish',
          idempotency_key: action.idempotencyKey,
          request_fingerprint: 'f'.repeat(64),
          state: 'running',
          resource_version: action.target.resourceVersion,
          policy_version: 3,
          fence_token: 1,
          lease_owner: 'worker_publish',
          lease_expires_at: new Date(now.getTime() + 300_000),
          result: null,
          failure_code: null,
          created_at: now,
          updated_at: now,
        })
        .execute();
      execution = {
        id: 'execution_publish',
        tenantId: tenant.id,
        actionId: action.id,
        actionDigest: digest,
        agentPrincipalId: action.agentPrincipalId,
        sponsorPrincipalId: action.sponsorPrincipalId,
        delegationGrantId: action.delegationGrantId,
        approvalId: 'approval_publish',
        idempotencyKey: action.idempotencyKey,
        requestFingerprint: 'f'.repeat(64),
        state: 'running',
        resourceVersion: action.target.resourceVersion,
        policyVersion: 3,
        fenceToken: 1,
        leaseOwner: 'worker_publish',
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
      adapter = new EventPublishAgentAdapter(db);
    });

    function invocation(digest: string): Parameters<EventPublishAgentAdapter['invoke']>[0] {
      return {
        tenantId: execution.tenantId,
        operation: 'events.publish',
        resourceType: 'event',
        resourceId: action.target.resourceId,
        expectedResourceVersion: execution.resourceVersion,
        payload: action.payload,
        idempotencyKey: execution.idempotencyKey,
        agentPrincipalId: execution.agentPrincipalId,
        sponsorPrincipalId: execution.sponsorPrincipalId,
        delegationGrantId: execution.delegationGrantId,
        approvalId: execution.approvalId,
        executionId: execution.id,
        actionKind: 'event.publish',
        actionDigest: execution.actionDigest,
        expectedPolicyVersion: execution.policyVersion,
        authorizationStateDigest: digest,
        expectedLeaseOwner: execution.leaseOwner!,
        expectedFenceToken: execution.fenceToken,
      };
    }

    it('prepares one immutable server-derived action and converges exact replays', async () => {
      const service = new AgentActionService(db);
      const before = {
        event: await db
          .selectFrom('events')
          .select(['status', 'version'])
          .where('id', '=', action.target.resourceId)
          .executeTakeFirstOrThrow(),
        approvals: await db.selectFrom('agent_approvals').select('id').execute(),
        executions: await db.selectFrom('agent_executions').select('id').execute(),
        effects: await db.selectFrom('agent_action_effects').select('execution_id').execute(),
      };
      const request = {
        tenantId: action.target.tenantId,
        agentPrincipalId: action.agentPrincipalId,
        idempotencyKey: `agent-action-prepare-${driver}-0001`,
        kind: 'event.publish' as const,
        delegationGrantId: action.delegationGrantId,
        resourceId: action.target.resourceId,
      };
      const concurrent = await Promise.all(
        Array.from({ length: 4 }, () => service.prepare(request)),
      );
      const first = concurrent[0]!;
      expect(concurrent).toEqual([first, first, first, first]);
      const replay = await service.prepare(request);
      expect(replay).toEqual(first);
      expect(first.action).toMatchObject({
        agentPrincipalId: action.agentPrincipalId,
        sponsorPrincipalId: action.sponsorPrincipalId,
        target: {
          tenantId: action.target.tenantId,
          resourceId: action.target.resourceId,
          resourceVersion: action.target.resourceVersion,
        },
      });
      expect(first.authorization).toMatchObject({
        eligibleForApproval: true,
        reasons: ['approval_required'],
      });
      expect(first.dryRun).toMatchObject({ launchable: true, blockingReasonCodes: [] });
      await expect(
        service.prepare({ ...request, resourceId: 'event_substituted' }),
      ).rejects.toThrow('AGENT_ACTION_IDEMPOTENCY_CONFLICT');
      await expect(
        db
          .updateTable('agent_actions')
          .set({ action_digest: 'f'.repeat(64) })
          .where('id', '=', first.action.id)
          .execute(),
      ).rejects.toThrow();
      const lifecycleEvent = await db
        .selectFrom('agent_action_events')
        .select('id')
        .where('action_id', '=', first.action.id)
        .executeTakeFirstOrThrow();
      await expect(
        db
          .updateTable('agent_action_events')
          .set({ outcome: 'forged' })
          .where('id', '=', lifecycleEvent.id)
          .execute(),
      ).rejects.toThrow();
      await expect(
        db.deleteFrom('agent_action_events').where('id', '=', lifecycleEvent.id).execute(),
      ).rejects.toThrow();
      expect(
        await db
          .selectFrom('agent_actions')
          .select('id')
          .where('idempotency_key', '=', request.idempotencyKey)
          .execute(),
      ).toHaveLength(1);
      expect(
        await db
          .selectFrom('agent_action_events')
          .select('id')
          .where('action_id', '=', first.action.id)
          .execute(),
      ).toHaveLength(1);
      expect(
        await db
          .selectFrom('events')
          .select(['status', 'version'])
          .where('id', '=', action.target.resourceId)
          .executeTakeFirstOrThrow(),
      ).toEqual(before.event);
      expect(await db.selectFrom('agent_approvals').select('id').execute()).toEqual(
        before.approvals,
      );
      expect(await db.selectFrom('agent_executions').select('id').execute()).toEqual(
        before.executions,
      );
      expect(await db.selectFrom('agent_action_effects').select('execution_id').execute()).toEqual(
        before.effects,
      );
    });

    it('executes readiness.read directly with immutable result and audit evidence', async () => {
      const service = new AgentActionService(db);
      const beforeEvent = await db
        .selectFrom('events')
        .select(['status', 'version'])
        .where('id', '=', action.target.resourceId)
        .executeTakeFirstOrThrow();
      const beforeApprovals = await db.selectFrom('agent_approvals').select('id').execute();
      const beforeExecutions = await db.selectFrom('agent_executions').select('id').execute();
      const request = {
        tenantId: action.target.tenantId,
        agentPrincipalId: action.agentPrincipalId,
        idempotencyKey: `agent-readiness-read-${driver}-0001`,
        kind: 'readiness.read' as const,
        delegationGrantId: action.delegationGrantId,
        resourceId: action.target.resourceId,
      };
      const concurrent = await Promise.all(
        Array.from({ length: 4 }, () => service.prepare(request)),
      );
      const first = concurrent[0]!;
      expect(concurrent).toEqual([first, first, first, first]);
      expect(await service.prepare(request)).toEqual(first);
      expect(first.action).toMatchObject({
        kind: 'readiness.read',
        autonomy: 'read',
        target: {
          resourceType: 'event',
          resourceId: action.target.resourceId,
          resourceVersion: action.target.resourceVersion,
          apiOperation: 'events.readiness.get',
        },
      });
      expect(first.authorization).toEqual({
        allowed: true,
        eligibleForApproval: false,
        reasons: [],
        snapshotSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        checkedAt: expect.any(String),
      });
      expect(first.result).toMatchObject({
        resourceId: action.target.resourceId,
        resourceVersion: action.target.resourceVersion,
        status: 'ready',
        readinessSnapshotSha256: first.action.payload.readinessSnapshotSha256,
        published: false,
        blockerReasonCodes: [],
      });
      expect(first.resultSha256).toBe(agentSha256(first.result));
      expect(
        await db
          .selectFrom('agent_action_events')
          .select(['phase', 'outcome'])
          .where('action_id', '=', first.action.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ phase: 'succeeded', outcome: 'succeeded' });
      await expect(
        service.approve({
          tenantId: action.target.tenantId,
          approverPrincipalId: action.sponsorPrincipalId,
          actionId: first.action.id,
          actionDigest: first.actionDigest,
          idempotencyKey: `agent-readiness-approve-${driver}-0001`,
        }),
      ).rejects.toThrow('AGENT_ACTION_NOT_APPROVABLE');
      await expect(
        service.execute({
          tenantId: action.target.tenantId,
          agentPrincipalId: action.agentPrincipalId,
          actionId: first.action.id,
          approvalId: 'approval_publish',
          actionDigest: first.actionDigest,
        }),
      ).rejects.toThrow('AGENT_ACTION_EXECUTION_SCOPE_DENIED');
      expect(
        await db
          .selectFrom('events')
          .select(['status', 'version'])
          .where('id', '=', action.target.resourceId)
          .executeTakeFirstOrThrow(),
      ).toEqual(beforeEvent);
      expect(await db.selectFrom('agent_approvals').select('id').execute()).toEqual(
        beforeApprovals,
      );
      expect(await db.selectFrom('agent_executions').select('id').execute()).toEqual(
        beforeExecutions,
      );
      await expect(AgentActionResultsMigration.down!(db)).rejects.toThrow('rollback refused');
      const persisted = await db
        .selectFrom('agent_actions')
        .selectAll()
        .where('tenant_id', '=', action.target.tenantId)
        .where('id', '=', first.action.id)
        .executeTakeFirstOrThrow();
      const oneSidedAction = {
        ...first.action,
        id: `act_${'e'.repeat(48)}`,
        idempotencyKey: `agent-readiness-one-sided-${driver}-0001`,
      };
      await db
        .insertInto('agent_actions')
        .values({
          ...persisted,
          id: oneSidedAction.id,
          action_digest: agentActionDigest(oneSidedAction),
          action_json: JSON.stringify(oneSidedAction),
          idempotency_key: oneSidedAction.idempotencyKey,
          request_fingerprint: agentSha256({
            kind: oneSidedAction.kind,
            delegationGrantId: oneSidedAction.delegationGrantId,
            resourceId: oneSidedAction.target.resourceId,
          }),
          result_sha256: null,
        })
        .executeTakeFirstOrThrow();
      await expect(AgentActionResultsMigration.down!(db)).rejects.toThrow('rollback refused');
    });

    it('reads a version-bound event projection with explicit untrusted-content provenance', async () => {
      const service = new AgentActionService(db);
      const request = {
        tenantId: action.target.tenantId,
        agentPrincipalId: action.agentPrincipalId,
        idempotencyKey: `agent-event-read-${driver}-0001`,
        kind: 'event.read' as const,
        delegationGrantId: action.delegationGrantId,
        resourceId: action.target.resourceId,
      };
      const concurrent = await Promise.all(
        Array.from({ length: 4 }, () => service.prepare(request)),
      );
      const first = concurrent[0]!;
      expect(concurrent).toEqual([first, first, first, first]);
      expect(first.action).toMatchObject({
        kind: 'event.read',
        autonomy: 'read',
        target: {
          resourceType: 'event',
          resourceId: action.target.resourceId,
          resourceVersion: action.target.resourceVersion,
          apiOperation: 'events.get',
        },
      });
      expect(first.result.event).toMatchObject({
        title: expect.any(String),
        status: 'draft',
        currency: 'USD',
        timezone: expect.any(String),
      });
      expect(first.result.untrustedContentPaths).toEqual(['event.title', 'event.description']);
      expect(first.action.payload.eventSnapshotSha256).toBe(agentSha256(first.result.event));
      expect(first.result.eventSnapshotSha256).toBe(first.action.payload.eventSnapshotSha256);
      expect(first.resultSha256).toBe(agentSha256(first.result));
      expect(() => validateAgentEventReadResult(first.action, first.result)).not.toThrow();
      expect(
        await db
          .selectFrom('agent_action_events')
          .select(['phase', 'outcome'])
          .where('action_id', '=', first.action.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ phase: 'succeeded', outcome: 'succeeded' });
      await expect(
        service.approve({
          tenantId: action.target.tenantId,
          approverPrincipalId: action.sponsorPrincipalId,
          actionId: first.action.id,
          actionDigest: first.actionDigest,
          idempotencyKey: `agent-event-read-approve-${driver}-0001`,
        }),
      ).rejects.toThrow('AGENT_ACTION_NOT_APPROVABLE');
      await expect(
        service.execute({
          tenantId: action.target.tenantId,
          agentPrincipalId: action.agentPrincipalId,
          actionId: first.action.id,
          approvalId: 'approval_publish',
          actionDigest: first.actionDigest,
        }),
      ).rejects.toThrow('AGENT_ACTION_EXECUTION_SCOPE_DENIED');
      expect(
        await service.getForSponsor({
          tenantId: action.target.tenantId,
          sponsorPrincipalId: action.sponsorPrincipalId,
          actionId: first.action.id,
        }),
      ).toEqual(first);
      const persistedEvidence = await db
        .selectFrom('agent_action_events')
        .selectAll()
        .where('tenant_id', '=', action.target.tenantId)
        .where('action_id', '=', first.action.id)
        .where('phase', '=', 'succeeded')
        .executeTakeFirstOrThrow();
      const authorizationSource = await db
        .selectFrom('agent_actions')
        .selectAll()
        .where('tenant_id', '=', action.target.tenantId)
        .where('id', '=', first.action.id)
        .executeTakeFirstOrThrow();
      for (const [index, invalidAuthorization] of ['invalid', 'f'.repeat(64)].entries()) {
        const clonedAction = {
          ...first.action,
          id: `act_${String(index + 6).repeat(48)}`,
          idempotencyKey: `agent-event-read-authorization-${index}-${driver}-0001`,
        };
        await db
          .insertInto('agent_actions')
          .values({
            ...authorizationSource,
            id: clonedAction.id,
            action_digest: agentActionDigest(clonedAction),
            action_json: JSON.stringify(clonedAction),
            idempotency_key: clonedAction.idempotencyKey,
            request_fingerprint: agentSha256({
              ...request,
              idempotencyKey: clonedAction.idempotencyKey,
            }),
            authorization_snapshot_sha256: invalidAuthorization,
          })
          .executeTakeFirstOrThrow();
        await db
          .insertInto('agent_action_events')
          .values({
            ...persistedEvidence,
            id: `aevt_${String(index + 6).repeat(47)}`,
            action_id: clonedAction.id,
            action_digest: agentActionDigest(clonedAction),
            idempotency_key: clonedAction.idempotencyKey,
            request_fingerprint: agentSha256({
              ...request,
              idempotencyKey: clonedAction.idempotencyKey,
            }),
          })
          .executeTakeFirstOrThrow();
        await expect(
          service.prepare({ ...request, idempotencyKey: clonedAction.idempotencyKey }),
        ).rejects.toThrow('persisted agent authorization evidence is invalid');
      }
      const originalEvent = await db
        .selectFrom('events')
        .select(['title', 'version'])
        .where('tenant_id', '=', action.target.tenantId)
        .where('id', '=', action.target.resourceId)
        .executeTakeFirstOrThrow();
      await db
        .updateTable('events')
        .set({ title: 'Version-invalidated title', version: originalEvent.version + 1 })
        .where('tenant_id', '=', action.target.tenantId)
        .where('id', '=', action.target.resourceId)
        .executeTakeFirstOrThrow();
      await expect(service.prepare(request)).rejects.toThrow('AGENT_ACTION_RESOURCE_DENIED');
      expect(
        await service.getForAgent({
          tenantId: action.target.tenantId,
          agentPrincipalId: action.agentPrincipalId,
          actionId: first.action.id,
        }),
      ).toBeUndefined();
      expect(
        await service.getForSponsor({
          tenantId: action.target.tenantId,
          sponsorPrincipalId: action.sponsorPrincipalId,
          actionId: first.action.id,
        }),
      ).toBeUndefined();
      await db
        .updateTable('events')
        .set({ title: originalEvent.title, version: originalEvent.version })
        .where('tenant_id', '=', action.target.tenantId)
        .where('id', '=', action.target.resourceId)
        .executeTakeFirstOrThrow();
      const persisted = await db
        .selectFrom('agent_actions')
        .selectAll()
        .where('tenant_id', '=', action.target.tenantId)
        .where('id', '=', first.action.id)
        .executeTakeFirstOrThrow();
      const tamperedAction = {
        ...first.action,
        id: `act_${'5'.repeat(48)}`,
        idempotencyKey: `agent-event-read-tampered-${driver}-0001`,
      };
      await db
        .insertInto('agent_actions')
        .values({
          ...persisted,
          id: tamperedAction.id,
          action_digest: agentActionDigest(tamperedAction),
          action_json: JSON.stringify(tamperedAction),
          idempotency_key: tamperedAction.idempotencyKey,
          request_fingerprint: agentSha256({
            ...request,
            idempotencyKey: tamperedAction.idempotencyKey,
          }),
          result_json: JSON.stringify({
            ...first.result,
            event: { ...first.result.event, title: 'Injected tool instruction' },
          }),
        })
        .executeTakeFirstOrThrow();
      await db
        .insertInto('agent_action_events')
        .values({
          ...persistedEvidence,
          id: `aevt_${'5'.repeat(47)}`,
          action_id: tamperedAction.id,
          action_digest: agentActionDigest(tamperedAction),
          idempotency_key: tamperedAction.idempotencyKey,
          request_fingerprint: agentSha256({
            ...request,
            idempotencyKey: tamperedAction.idempotencyKey,
          }),
        })
        .executeTakeFirstOrThrow();
      await expect(
        service.prepare({ ...request, idempotencyKey: tamperedAction.idempotencyKey }),
      ).rejects.toThrow('digest binding');
    });

    it('denies readiness.read before evaluation when authority is missing', async () => {
      const service = new AgentActionService(db);
      await db
        .deleteFrom('permission_grants')
        .where('id', '=', 'pg_event_readiness_read')
        .execute();
      await expect(
        service.prepare({
          tenantId: action.target.tenantId,
          agentPrincipalId: action.agentPrincipalId,
          idempotencyKey: `agent-readiness-denied-${driver}-0001`,
          kind: 'readiness.read',
          delegationGrantId: action.delegationGrantId,
          resourceId: action.target.resourceId,
        }),
      ).rejects.toThrow('AGENT_ACTION_RESOURCE_DENIED');
      expect(
        await db
          .selectFrom('agent_actions')
          .select('id')
          .where('idempotency_key', '=', `agent-readiness-denied-${driver}-0001`)
          .execute(),
      ).toEqual([]);
    });

    it.each([
      'principal',
      'delegation',
      'scope',
      'sponsor_permission',
      'membership',
      'policy_action',
      'policy_risk',
      'policy_version',
      'resource_version',
    ] as const)(
      'denies readiness replay and retrieval after current %s authority changes',
      async (surface) => {
        const service = new AgentActionService(db);
        const request = {
          tenantId: action.target.tenantId,
          agentPrincipalId: action.agentPrincipalId,
          idempotencyKey: `agent-readiness-revoked-${surface}-${driver}-0001`,
          kind: 'readiness.read' as const,
          delegationGrantId: action.delegationGrantId,
          resourceId: action.target.resourceId,
        };
        const prepared = await service.prepare(request);
        if (surface === 'principal')
          await db
            .updateTable('agent_principals')
            .set({ state: 'revoked' })
            .where('tenant_id', '=', action.target.tenantId)
            .where('id', '=', action.agentPrincipalId)
            .executeTakeFirstOrThrow();
        if (surface === 'delegation')
          await db
            .updateTable('agent_delegations')
            .set({ revoked_at: new Date() })
            .where('tenant_id', '=', action.target.tenantId)
            .where('id', '=', action.delegationGrantId)
            .executeTakeFirstOrThrow();
        if (surface === 'scope')
          await db
            .updateTable('agent_delegations')
            .set({ resource_scopes: '[]' })
            .where('tenant_id', '=', action.target.tenantId)
            .where('id', '=', action.delegationGrantId)
            .executeTakeFirstOrThrow();
        if (surface === 'sponsor_permission')
          await db
            .deleteFrom('permission_grants')
            .where('tenant_id', '=', action.target.tenantId)
            .where('id', '=', 'pg_event_readiness_read')
            .executeTakeFirstOrThrow();
        if (surface === 'membership')
          await db
            .deleteFrom('organization_members')
            .where('tenant_id', '=', action.target.tenantId)
            .where('id', '=', 'member_agent_publish')
            .executeTakeFirstOrThrow();
        if (surface === 'policy_action' || surface === 'policy_risk')
          await db
            .updateTable('agent_action_policies')
            .set(surface === 'policy_action' ? { allowed: false } : { risk_allowed: false })
            .where('tenant_id', '=', action.target.tenantId)
            .where('action_kind', '=', 'readiness.read')
            .executeTakeFirstOrThrow();
        if (surface === 'policy_version')
          await db
            .updateTable('agent_action_policies')
            .set({ policy_version: 4 })
            .where('tenant_id', '=', action.target.tenantId)
            .where('action_kind', '=', 'readiness.read')
            .executeTakeFirstOrThrow();
        if (surface === 'resource_version')
          await db
            .updateTable('events')
            .set({ version: action.target.resourceVersion + 1 })
            .where('tenant_id', '=', action.target.tenantId)
            .where('id', '=', action.target.resourceId)
            .executeTakeFirstOrThrow();

        await expect(service.prepare(request)).rejects.toThrow('AGENT_ACTION_RESOURCE_DENIED');
        await expect(
          service.getForAgent({
            tenantId: action.target.tenantId,
            agentPrincipalId: action.agentPrincipalId,
            actionId: prepared.action.id,
          }),
        ).resolves.toBeUndefined();
      },
    );

    it('denies event.read before evaluation when sponsor read permission is missing', async () => {
      const service = new AgentActionService(db);
      const idempotencyKey = `agent-event-read-initial-denied-${driver}-0001`;
      await db
        .deleteFrom('permission_grants')
        .where('tenant_id', '=', action.target.tenantId)
        .where('id', '=', 'pg_event_readiness_read')
        .executeTakeFirstOrThrow();
      await expect(
        service.prepare({
          tenantId: action.target.tenantId,
          agentPrincipalId: action.agentPrincipalId,
          idempotencyKey,
          kind: 'event.read',
          delegationGrantId: action.delegationGrantId,
          resourceId: action.target.resourceId,
        }),
      ).rejects.toThrow('AGENT_ACTION_RESOURCE_DENIED');
      expect(
        await db
          .selectFrom('agent_actions')
          .select('id')
          .where('tenant_id', '=', action.target.tenantId)
          .where('idempotency_key', '=', idempotencyKey)
          .execute(),
      ).toEqual([]);
    });

    it.each([
      'principal_state',
      'principal_capability',
      'principal_protocol',
      'delegation_revocation',
      'delegation_capability',
      'delegation_sponsor',
      'delegation_scope',
      'delegation_expiry',
      'sponsor_state',
      'sponsor_permission',
      'membership',
      'policy_action',
      'policy_risk',
      'policy_version',
      'resource_version',
    ] as const)(
      'denies event.read replay and both retrieval surfaces after current %s changes',
      async (surface) => {
        const service = new AgentActionService(db);
        const request = {
          tenantId: action.target.tenantId,
          agentPrincipalId: action.agentPrincipalId,
          idempotencyKey: `agent-event-read-revoked-${surface}-${driver}-0001`,
          kind: 'event.read' as const,
          delegationGrantId: action.delegationGrantId,
          resourceId: action.target.resourceId,
        };
        const prepared = await service.prepare(request);
        if (surface === 'principal_state')
          await db
            .updateTable('agent_principals')
            .set({ state: 'revoked' })
            .where('tenant_id', '=', action.target.tenantId)
            .where('id', '=', action.agentPrincipalId)
            .executeTakeFirstOrThrow();
        if (surface === 'principal_capability')
          await db
            .updateTable('agent_principals')
            .set({ capabilities: JSON.stringify(['events.execute', 'readiness.read']) })
            .where('tenant_id', '=', action.target.tenantId)
            .where('id', '=', action.agentPrincipalId)
            .executeTakeFirstOrThrow();
        if (surface === 'principal_protocol')
          await db
            .updateTable('agent_principals')
            .set({ protocol_version: '2026-07-21' })
            .where('tenant_id', '=', action.target.tenantId)
            .where('id', '=', action.agentPrincipalId)
            .executeTakeFirstOrThrow();
        if (surface === 'delegation_revocation')
          await db
            .updateTable('agent_delegations')
            .set({ revoked_at: new Date() })
            .where('tenant_id', '=', action.target.tenantId)
            .where('id', '=', action.delegationGrantId)
            .executeTakeFirstOrThrow();
        if (surface === 'delegation_capability')
          await db
            .updateTable('agent_delegations')
            .set({ capabilities: JSON.stringify(['events.execute', 'readiness.read']) })
            .where('tenant_id', '=', action.target.tenantId)
            .where('id', '=', action.delegationGrantId)
            .executeTakeFirstOrThrow();
        if (surface === 'delegation_sponsor')
          await db
            .updateTable('agent_delegations')
            .set({ sponsor_principal_id: 'user_sponsor_mismatch' })
            .where('tenant_id', '=', action.target.tenantId)
            .where('id', '=', action.delegationGrantId)
            .executeTakeFirstOrThrow();
        if (surface === 'delegation_scope')
          await db
            .updateTable('agent_delegations')
            .set({ resource_scopes: '[]' })
            .where('tenant_id', '=', action.target.tenantId)
            .where('id', '=', action.delegationGrantId)
            .executeTakeFirstOrThrow();
        if (surface === 'delegation_expiry')
          await db
            .updateTable('agent_delegations')
            .set({ expires_at: new Date(Date.now() - 1_000) })
            .where('tenant_id', '=', action.target.tenantId)
            .where('id', '=', action.delegationGrantId)
            .executeTakeFirstOrThrow();
        if (surface === 'sponsor_state')
          await db
            .updateTable('user_profiles')
            .set({ status: 'suspended' })
            .where('tenant_id', '=', action.target.tenantId)
            .where('id', '=', action.sponsorPrincipalId)
            .executeTakeFirstOrThrow();
        if (surface === 'sponsor_permission')
          await db
            .deleteFrom('permission_grants')
            .where('tenant_id', '=', action.target.tenantId)
            .where('id', '=', 'pg_event_readiness_read')
            .executeTakeFirstOrThrow();
        if (surface === 'membership')
          await db
            .deleteFrom('organization_members')
            .where('tenant_id', '=', action.target.tenantId)
            .where('id', '=', 'member_agent_publish')
            .executeTakeFirstOrThrow();
        if (surface === 'policy_action' || surface === 'policy_risk')
          await db
            .updateTable('agent_action_policies')
            .set(surface === 'policy_action' ? { allowed: false } : { risk_allowed: false })
            .where('tenant_id', '=', action.target.tenantId)
            .where('action_kind', '=', 'event.read')
            .executeTakeFirstOrThrow();
        if (surface === 'policy_version')
          await db
            .updateTable('agent_action_policies')
            .set({ policy_version: 2 })
            .where('tenant_id', '=', action.target.tenantId)
            .where('action_kind', '=', 'event.read')
            .executeTakeFirstOrThrow();
        if (surface === 'resource_version')
          await db
            .updateTable('events')
            .set({ version: action.target.resourceVersion + 1 })
            .where('tenant_id', '=', action.target.tenantId)
            .where('id', '=', action.target.resourceId)
            .executeTakeFirstOrThrow();

        await expect(service.prepare(request)).rejects.toThrow('AGENT_ACTION_RESOURCE_DENIED');
        await expect(
          service.getForAgent({
            tenantId: action.target.tenantId,
            agentPrincipalId: action.agentPrincipalId,
            actionId: prepared.action.id,
          }),
        ).resolves.toBeUndefined();
        await expect(
          service.getForSponsor({
            tenantId: action.target.tenantId,
            sponsorPrincipalId: action.sponsorPrincipalId,
            actionId: prepared.action.id,
          }),
        ).resolves.toBeUndefined();
      },
    );

    it('hides event.read across wrong tenant, agent, sponsor and resource scope', async () => {
      const service = new AgentActionService(db);
      const request = {
        tenantId: action.target.tenantId,
        agentPrincipalId: action.agentPrincipalId,
        idempotencyKey: `agent-event-read-tenant-scope-${driver}-0001`,
        kind: 'event.read' as const,
        delegationGrantId: action.delegationGrantId,
        resourceId: action.target.resourceId,
      };
      const prepared = await service.prepare(request);
      await expect(
        service.getForAgent({
          tenantId: 'tenant_other',
          agentPrincipalId: action.agentPrincipalId,
          actionId: prepared.action.id,
        }),
      ).resolves.toBeUndefined();
      await expect(
        service.getForAgent({
          tenantId: action.target.tenantId,
          agentPrincipalId: 'agent_other',
          actionId: prepared.action.id,
        }),
      ).resolves.toBeUndefined();
      await expect(
        service.getForSponsor({
          tenantId: action.target.tenantId,
          sponsorPrincipalId: 'sponsor_other',
          actionId: prepared.action.id,
        }),
      ).resolves.toBeUndefined();
      await expect(
        service.prepare({
          ...request,
          idempotencyKey: `agent-event-read-resource-scope-${driver}-0001`,
          resourceId: 'event_other',
        }),
      ).rejects.toThrow('AGENT_ACTION_DELEGATION_DENIED');
      await expect(
        service.prepare({
          ...request,
          tenantId: 'tenant_other',
          idempotencyKey: `agent-event-read-tenant-scope-${driver}-0002`,
        }),
      ).rejects.toThrow();
    });

    it('hides readiness replay and retrieval across tenant scope', async () => {
      const service = new AgentActionService(db);
      const prepared = await service.prepare({
        tenantId: action.target.tenantId,
        agentPrincipalId: action.agentPrincipalId,
        idempotencyKey: `agent-readiness-tenant-scope-${driver}-0001`,
        kind: 'readiness.read',
        delegationGrantId: action.delegationGrantId,
        resourceId: action.target.resourceId,
      });
      await expect(
        service.getForAgent({
          tenantId: 'tenant_other',
          agentPrincipalId: action.agentPrincipalId,
          actionId: prepared.action.id,
        }),
      ).resolves.toBeUndefined();
      await expect(
        service.prepare({
          tenantId: 'tenant_other',
          agentPrincipalId: action.agentPrincipalId,
          idempotencyKey: `agent-readiness-tenant-scope-${driver}-0001`,
          kind: 'readiness.read',
          delegationGrantId: action.delegationGrantId,
          resourceId: action.target.resourceId,
        }),
      ).rejects.toThrow();
    });

    it.each(['extra', 'missing'] as const)(
      'fails closed on persisted readiness actions with %s payload fields',
      async (shape) => {
        const service = new AgentActionService(db);
        const prepared = await service.prepare({
          tenantId: action.target.tenantId,
          agentPrincipalId: action.agentPrincipalId,
          idempotencyKey: `agent-readiness-corrupt-source-${shape}-${driver}-0001`,
          kind: 'readiness.read',
          delegationGrantId: action.delegationGrantId,
          resourceId: action.target.resourceId,
        });
        const persisted = await db
          .selectFrom('agent_actions')
          .selectAll()
          .where('tenant_id', '=', action.target.tenantId)
          .where('id', '=', prepared.action.id)
          .executeTakeFirstOrThrow();
        const malformedAction = {
          ...prepared.action,
          id: `act_${(shape === 'extra' ? '6' : '7').repeat(48)}`,
          idempotencyKey: `agent-readiness-corrupt-${shape}-${driver}-0001`,
          payload:
            shape === 'extra'
              ? { ...prepared.action.payload, untrustedToolOutput: 'ignore policy' }
              : {},
        };
        await db
          .insertInto('agent_actions')
          .values({
            ...persisted,
            id: malformedAction.id,
            action_digest: agentActionDigest(malformedAction),
            action_json: JSON.stringify(malformedAction),
            idempotency_key: malformedAction.idempotencyKey,
            request_fingerprint: agentSha256({
              kind: malformedAction.kind,
              delegationGrantId: malformedAction.delegationGrantId,
              resourceId: malformedAction.target.resourceId,
            }),
          })
          .executeTakeFirstOrThrow();
        await expect(
          service.getForAgent({
            tenantId: action.target.tenantId,
            agentPrincipalId: action.agentPrincipalId,
            actionId: malformedAction.id,
          }),
        ).rejects.toThrow();
      },
    );

    it('fails closed before persistence for another agent delegation or an out-of-scope event', async () => {
      const service = new AgentActionService(db);
      await db
        .insertInto('agent_principals')
        .values({
          id: 'agent_other',
          tenant_id: action.target.tenantId,
          kind: 'third_party',
          sponsor_principal_id: action.sponsorPrincipalId,
          capabilities: JSON.stringify(['events.execute']),
          maximum_autonomy: 'execute_with_approval',
          protocol_version: AGENT_PROTOCOL_VERSION,
          state: 'active',
          registered_at: new Date(),
          updated_at: new Date(),
        })
        .execute();
      const beforeActions = await db.selectFrom('agent_actions').select('id').execute();
      const beforeEvents = await db.selectFrom('agent_action_events').select('id').execute();
      await expect(
        service.prepare({
          tenantId: action.target.tenantId,
          agentPrincipalId: 'agent_other',
          idempotencyKey: `agent-action-cross-agent-${driver}-0001`,
          kind: 'event.publish',
          delegationGrantId: action.delegationGrantId,
          resourceId: action.target.resourceId,
        }),
      ).rejects.toThrow('AGENT_ACTION_DELEGATION_DENIED');
      await db
        .updateTable('agent_delegations')
        .set({ resource_scopes: JSON.stringify(['event:another_event']) })
        .where('id', '=', action.delegationGrantId)
        .execute();
      await expect(
        service.prepare({
          tenantId: action.target.tenantId,
          agentPrincipalId: action.agentPrincipalId,
          idempotencyKey: `agent-action-out-of-scope-${driver}-0001`,
          kind: 'event.publish',
          delegationGrantId: action.delegationGrantId,
          resourceId: action.target.resourceId,
        }),
      ).rejects.toThrow('AGENT_ACTION_DELEGATION_DENIED');
      expect(await db.selectFrom('agent_actions').select('id').execute()).toEqual(beforeActions);
      expect(await db.selectFrom('agent_action_events').select('id').execute()).toEqual(
        beforeEvents,
      );
    });

    it('does not mark a risk-policy-denied action eligible for approval', async () => {
      await db
        .updateTable('agent_action_policies')
        .set({ risk_allowed: false })
        .where('tenant_id', '=', action.target.tenantId)
        .where('action_kind', '=', action.kind)
        .execute();
      const prepared = await new AgentActionService(db).prepare({
        tenantId: action.target.tenantId,
        agentPrincipalId: action.agentPrincipalId,
        idempotencyKey: `agent-action-risk-denied-${driver}-0001`,
        kind: 'event.publish',
        delegationGrantId: action.delegationGrantId,
        resourceId: action.target.resourceId,
      });
      expect(prepared.authorization.eligibleForApproval).toBe(false);
      expect(prepared.authorization.reasons).toContain('tenant_policy_denied');
    });

    it.each(['sponsor', 'membership', 'permission'] as const)(
      'fails closed before readiness persistence after %s authority is removed',
      async (removed) => {
        if (removed === 'sponsor')
          await db
            .updateTable('user_profiles')
            .set({ status: 'suspended' })
            .where('tenant_id', '=', action.target.tenantId)
            .where('id', '=', action.sponsorPrincipalId)
            .execute();
        if (removed === 'membership')
          await db
            .deleteFrom('organization_members')
            .where('tenant_id', '=', action.target.tenantId)
            .where('user_id', '=', action.sponsorPrincipalId)
            .execute();
        if (removed === 'permission')
          await db
            .deleteFrom('permission_grants')
            .where('tenant_id', '=', action.target.tenantId)
            .where('principal_id', '=', action.sponsorPrincipalId)
            .where('permission', '=', 'events.write')
            .execute();
        const beforeActions = await db.selectFrom('agent_actions').select('id').execute();
        const beforeEvents = await db.selectFrom('agent_action_events').select('id').execute();
        await expect(
          new AgentActionService(db).prepare({
            tenantId: action.target.tenantId,
            agentPrincipalId: action.agentPrincipalId,
            idempotencyKey: `agent-action-authority-${removed}-${driver}-0001`,
            kind: 'event.publish',
            delegationGrantId: action.delegationGrantId,
            resourceId: action.target.resourceId,
          }),
        ).rejects.toThrow('AGENT_ACTION_RESOURCE_DENIED');
        expect(await db.selectFrom('agent_actions').select('id').execute()).toEqual(beforeActions);
        expect(await db.selectFrom('agent_action_events').select('id').execute()).toEqual(
          beforeEvents,
        );
      },
    );

    it('issues one short-lived digest-bound human approval and converges exact replay', async () => {
      const service = new AgentActionService(db);
      const before = {
        event: await db
          .selectFrom('events')
          .select(['status', 'version'])
          .where('id', '=', action.target.resourceId)
          .executeTakeFirstOrThrow(),
        executions: await db.selectFrom('agent_executions').select('id').execute(),
        effects: await db.selectFrom('agent_action_effects').select('execution_id').execute(),
      };
      const prepared = await service.prepare({
        tenantId: action.target.tenantId,
        agentPrincipalId: action.agentPrincipalId,
        idempotencyKey: `agent-action-for-approval-${driver}-0001`,
        kind: 'event.publish',
        delegationGrantId: action.delegationGrantId,
        resourceId: action.target.resourceId,
      });
      const request = {
        tenantId: action.target.tenantId,
        approverPrincipalId: action.sponsorPrincipalId,
        actionId: prepared.action.id,
        actionDigest: prepared.actionDigest,
        idempotencyKey: `agent-action-approval-${driver}-0001`,
      };
      const concurrent = await Promise.all(
        Array.from({ length: 4 }, () => service.approve(request)),
      );
      const first = concurrent[0]!;
      expect(concurrent).toEqual([first, first, first, first]);
      const replay = await service.approve(request);
      expect(replay).toEqual(first);
      expect(first).toMatchObject({
        tenantId: action.target.tenantId,
        actionDigest: prepared.actionDigest,
        approverPrincipalId: action.sponsorPrincipalId,
        approverPermissionSnapshot: ['events:publish'],
        policyVersion: action.expectedPolicyVersion,
      });
      expect(
        new Date(first.expiresAt).getTime() - new Date(first.approvedAt).getTime(),
      ).toBeLessThanOrEqual(5 * 60 * 1000);
      expect(
        await db
          .selectFrom('agent_approvals')
          .select(['action_id', 'action_digest', 'consumed_at', 'revoked_at'])
          .where('id', '=', first.id)
          .executeTakeFirstOrThrow(),
      ).toMatchObject({
        action_id: prepared.action.id,
        action_digest: prepared.actionDigest,
        consumed_at: null,
        revoked_at: null,
      });
      expect(
        await db
          .selectFrom('agent_action_events')
          .select(['actor_type', 'phase', 'approval_id', 'outcome'])
          .where('action_id', '=', prepared.action.id)
          .where('phase', '=', 'approved')
          .execute(),
      ).toEqual([
        {
          actor_type: 'user',
          phase: 'approved',
          approval_id: first.id,
          outcome: 'approved',
        },
      ]);
      await expect(
        service.approve({ ...request, idempotencyKey: `${request.idempotencyKey}-second` }),
      ).rejects.toThrow('AGENT_ACTION_ALREADY_APPROVED');
      const competing = await Promise.allSettled(
        Array.from({ length: 3 }, (_, index) =>
          service.approve({
            ...request,
            idempotencyKey: `${request.idempotencyKey}-competing-${index}`,
          }),
        ),
      );
      expect(competing.every(({ status }) => status === 'rejected')).toBe(true);
      expect(
        await db
          .selectFrom('agent_approvals')
          .select('id')
          .where('action_id', '=', prepared.action.id)
          .execute(),
      ).toHaveLength(1);
      expect(
        await db
          .selectFrom('events')
          .select(['status', 'version'])
          .where('id', '=', action.target.resourceId)
          .executeTakeFirstOrThrow(),
      ).toEqual(before.event);
      expect(await db.selectFrom('agent_executions').select('id').execute()).toEqual(
        before.executions,
      );
      expect(await db.selectFrom('agent_action_effects').select('execution_id').execute()).toEqual(
        before.effects,
      );
      await db
        .deleteFrom('permission_grants')
        .where('tenant_id', '=', action.target.tenantId)
        .where('principal_id', '=', action.sponsorPrincipalId)
        .where('permission', '=', 'events.write')
        .execute();
      await expect(service.approve(request)).resolves.toEqual(first);
    });

    it('binds approval and durable execution to an authoritative plan digest', async () => {
      let releaseEffect!: () => void;
      let effectReached!: () => void;
      const releaseEffectPromise = new Promise<void>((resolve) => {
        releaseEffect = resolve;
      });
      const effectReachedPromise = new Promise<void>((resolve) => {
        effectReached = resolve;
      });
      const service = new AgentActionService(db, {
        beforeProductAudit: async () => {
          effectReached();
          await releaseEffectPromise;
        },
      });
      const prepared = await service.prepare({
        tenantId: action.target.tenantId,
        agentPrincipalId: action.agentPrincipalId,
        idempotencyKey: `agent-planned-action-${driver}-0001`,
        kind: 'event.publish',
        delegationGrantId: action.delegationGrantId,
        resourceId: action.target.resourceId,
      });
      const createdAt = prepared.action.preparedAt;
      const expiresAt = new Date(
        Math.min(
          new Date(prepared.expiresAt).getTime(),
          new Date(createdAt).getTime() + 4 * 60 * 1000,
        ),
      ).toISOString();
      const plan = buildAgentPlanDefinition({
        id: `plan_publish_${driver}`,
        protocolVersion: AGENT_PLATFORM_PROTOCOL_VERSION,
        tenantId: prepared.action.target.tenantId,
        agentPrincipalId: prepared.action.agentPrincipalId,
        sponsorPrincipalId: prepared.action.sponsorPrincipalId,
        delegationGrantId: prepared.action.delegationGrantId,
        purpose: 'Publish the reviewed event configuration',
        assumptions: [
          {
            id: 'assumption_reviewed',
            statement: 'The organizer reviewed the event launch configuration.',
            provenanceType: 'user',
            sourceReference: 'agent_event_publish_integration',
            verification: 'confirmed',
          },
        ],
        steps: [
          {
            id: 'step_publish',
            actionKind: prepared.action.kind,
            actionProtocolVersion: prepared.action.protocolVersion,
            actionDigest: prepared.actionDigest,
            dependsOnStepIds: [],
            projectedChanges: [
              {
                resourceType: prepared.action.target.resourceType,
                resourceId: prepared.action.target.resourceId,
                operation: 'publish',
                beforeVersion: prepared.action.target.resourceVersion,
                projectedVersion: prepared.action.target.resourceVersion + 1,
                previewSha256: agentSha256(prepared.dryRun),
              },
            ],
            costs: [
              {
                amountMinor: 0,
                currency: 'USD',
                basis: 'Event publication has no direct platform charge.',
                quoteSha256: agentSha256({ amountMinor: 0, currency: 'USD' }),
                expiresAt,
              },
            ],
            readinessImpact: {
              beforeSnapshotSha256: prepared.dryRun.readinessSnapshotSha256,
              projectedSnapshotSha256: agentSha256({
                actionDigest: prepared.actionDigest,
                status: 'published',
              }),
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
      const plans = new AgentPlanRepository(db);
      await plans.create({
        definition: plan,
        actionBindings: [{ stepId: 'step_publish', actionId: prepared.action.id }],
        actor: {
          type: 'agent',
          tenantId: plan.tenantId,
          principalId: plan.agentPrincipalId,
        },
        idempotencyKey: `agent-plan-create-${driver}-0001`,
      });
      await expect(
        service.approve({
          tenantId: plan.tenantId,
          approverPrincipalId: plan.sponsorPrincipalId,
          actionId: prepared.action.id,
          actionDigest: prepared.actionDigest,
          planSha256: plan.planSha256,
          idempotencyKey: `agent-plan-premature-${driver}-0001`,
        }),
      ).rejects.toThrow('AGENT_ACTION_APPROVAL_PLAN_BINDING_INVALID');
      await plans.transition({
        tenantId: plan.tenantId,
        planId: plan.id,
        expectedStateVersion: 1,
        status: 'awaiting_approval',
        stepStates: [{ stepId: 'step_publish', status: 'awaiting_approval' }],
        actor: {
          type: 'agent',
          tenantId: plan.tenantId,
          principalId: plan.agentPrincipalId,
        },
        reasonCode: 'approval_requested',
        idempotencyKey: `agent-plan-awaiting-${driver}-0001`,
      });
      await expect(
        service.approve({
          tenantId: plan.tenantId,
          approverPrincipalId: plan.sponsorPrincipalId,
          actionId: prepared.action.id,
          actionDigest: prepared.actionDigest,
          idempotencyKey: `agent-plan-omitted-${driver}-0001`,
        }),
      ).rejects.toThrow('AGENT_ACTION_APPROVAL_PLAN_BINDING_INVALID');
      expect(
        await db
          .selectFrom('agent_approvals')
          .select('id')
          .where('action_id', '=', prepared.action.id)
          .execute(),
      ).toEqual([]);
      const approval = await service.approve({
        tenantId: plan.tenantId,
        approverPrincipalId: plan.sponsorPrincipalId,
        actionId: prepared.action.id,
        actionDigest: prepared.actionDigest,
        planSha256: plan.planSha256,
        idempotencyKey: `agent-plan-approval-${driver}-0001`,
      });
      expect(approval.planSha256).toBe(plan.planSha256);
      const invalidAuditExecution: AgentExecution = {
        id: `exec_${'a'.repeat(48)}`,
        tenantId: plan.tenantId,
        actionId: prepared.action.id,
        actionDigest: prepared.actionDigest,
        planSha256: plan.planSha256,
        agentPrincipalId: plan.agentPrincipalId,
        sponsorPrincipalId: plan.sponsorPrincipalId,
        delegationGrantId: plan.delegationGrantId,
        approvalId: approval.id,
        idempotencyKey: 'a'.repeat(64),
        requestFingerprint: 'b'.repeat(64),
        state: 'reserved',
        resourceVersion: prepared.action.target.resourceVersion,
        policyVersion: prepared.action.expectedPolicyVersion,
        fenceToken: 0,
        createdAt: approval.approvedAt,
        updatedAt: approval.approvedAt,
      };
      const invalidAuditBase = {
        tenantId: plan.tenantId,
        agentPrincipalId: plan.agentPrincipalId,
        sponsorPrincipalId: plan.sponsorPrincipalId,
        delegationGrantId: plan.delegationGrantId,
        actionId: prepared.action.id,
        actionDigest: prepared.actionDigest,
        approvalId: approval.id,
        idempotencyKey: invalidAuditExecution.idempotencyKey,
        resourceVersion: prepared.action.target.resourceVersion,
        occurredAt: approval.approvedAt,
        reasonCodes: [],
      };
      await expect(
        new AgentExecutionRepository(db).reserveAndConsume({
          execution: invalidAuditExecution,
          approval,
          requiredApproverPermission: 'events:publish',
          now: approval.approvedAt,
          audit: [
            { ...invalidAuditBase, id: `aaud_${'a'.repeat(48)}`, phase: 'prepared' },
            { ...invalidAuditBase, id: `aaud_${'b'.repeat(48)}`, phase: 'authorized' },
          ],
        }),
      ).rejects.toThrow('AGENT_AUDIT_IDENTITY_MISMATCH');
      expect(
        await db
          .selectFrom('agent_approvals')
          .select('consumed_at')
          .where('id', '=', approval.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ consumed_at: null });
      const cancelledPrepared = await service.prepare({
        tenantId: action.target.tenantId,
        agentPrincipalId: action.agentPrincipalId,
        idempotencyKey: `agent-cancelled-action-${driver}-0001`,
        kind: 'event.publish',
        delegationGrantId: action.delegationGrantId,
        resourceId: action.target.resourceId,
      });
      const cancelledExpiresAt = new Date(
        Math.min(
          new Date(cancelledPrepared.expiresAt).getTime(),
          new Date(cancelledPrepared.action.preparedAt).getTime() + 4 * 60 * 1000,
        ),
      ).toISOString();
      const { planSha256: _originalPlanSha256, ...cancelledPlanInput } = plan;
      const cancelledPlan = buildAgentPlanDefinition({
        ...cancelledPlanInput,
        id: `plan_cancelled_${driver}`,
        steps: plan.steps.map((step) => ({
          ...step,
          actionDigest: cancelledPrepared.actionDigest,
          actionProtocolVersion: cancelledPrepared.action.protocolVersion,
          readinessImpact: {
            ...step.readinessImpact,
            beforeSnapshotSha256: cancelledPrepared.dryRun.readinessSnapshotSha256,
          },
          costs: step.costs.map((cost) => ({ ...cost, expiresAt: cancelledExpiresAt })),
        })),
        createdAt: cancelledPrepared.action.preparedAt,
        expiresAt: cancelledExpiresAt,
      });
      await plans.create({
        definition: cancelledPlan,
        actionBindings: [{ stepId: 'step_publish', actionId: cancelledPrepared.action.id }],
        actor: {
          type: 'agent',
          tenantId: cancelledPlan.tenantId,
          principalId: cancelledPlan.agentPrincipalId,
        },
        idempotencyKey: `agent-plan-cancel-create-${driver}-0001`,
      });
      await plans.transition({
        tenantId: cancelledPlan.tenantId,
        planId: cancelledPlan.id,
        expectedStateVersion: 1,
        status: 'awaiting_approval',
        stepStates: [{ stepId: 'step_publish', status: 'awaiting_approval' }],
        actor: {
          type: 'agent',
          tenantId: cancelledPlan.tenantId,
          principalId: cancelledPlan.agentPrincipalId,
        },
        reasonCode: 'approval_requested',
        idempotencyKey: `agent-plan-cancel-awaiting-${driver}-0001`,
      });
      const cancelledApproval = await service.approve({
        tenantId: cancelledPlan.tenantId,
        approverPrincipalId: cancelledPlan.sponsorPrincipalId,
        actionId: cancelledPrepared.action.id,
        actionDigest: cancelledPrepared.actionDigest,
        planSha256: cancelledPlan.planSha256,
        idempotencyKey: `agent-plan-cancel-approval-${driver}-0001`,
      });
      await plans.transition({
        tenantId: cancelledPlan.tenantId,
        planId: cancelledPlan.id,
        expectedStateVersion: 2,
        status: 'cancelled',
        stepStates: [{ stepId: 'step_publish', status: 'cancelled' }],
        actor: {
          type: 'user',
          tenantId: cancelledPlan.tenantId,
          principalId: cancelledPlan.sponsorPrincipalId,
        },
        reasonCode: 'sponsor_cancelled',
        idempotencyKey: `agent-plan-cancelled-${driver}-0001`,
      });
      await expect(
        service.execute({
          tenantId: cancelledPlan.tenantId,
          agentPrincipalId: cancelledPlan.agentPrincipalId,
          actionId: cancelledPrepared.action.id,
          approvalId: cancelledApproval.id,
          actionDigest: cancelledPrepared.actionDigest,
        }),
      ).rejects.toThrow('agent execution reservation conflicted');
      const executionPromise = service.execute({
        tenantId: plan.tenantId,
        agentPrincipalId: plan.agentPrincipalId,
        actionId: prepared.action.id,
        approvalId: approval.id,
        actionDigest: prepared.actionDigest,
      });
      await effectReachedPromise;
      const cancellationPromise = plans.transition({
        tenantId: plan.tenantId,
        planId: plan.id,
        expectedStateVersion: 2,
        status: 'cancelled',
        stepStates: [{ stepId: 'step_publish', status: 'cancelled' }],
        actor: { type: 'user', tenantId: plan.tenantId, principalId: plan.sponsorPrincipalId },
        reasonCode: 'sponsor_cancelled',
        idempotencyKey: `agent-plan-cancel-race-${driver}-0001`,
      });
      const cancellationResult = cancellationPromise.then(
        () => undefined,
        (error: unknown) => error,
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      releaseEffect();
      const executed = await executionPromise;
      expect(await cancellationResult).toMatchObject({
        message: 'AGENT_PLAN_CANCELLATION_REQUIRES_NO_EXECUTION',
      });
      expect(executed).toMatchObject({ state: 'succeeded', planSha256: plan.planSha256 });
      expect(
        await db
          .selectFrom('agent_executions')
          .select('plan_sha256')
          .where('id', '=', executed.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ plan_sha256: plan.planSha256 });
      expect(
        await db
          .selectFrom('agent_audit_events')
          .select('plan_sha256')
          .where('execution_id', '=', executed.id)
          .execute(),
      ).toSatisfy(
        (rows: Array<{ plan_sha256: string | null }>) =>
          rows.length > 0 && rows.every(({ plan_sha256 }) => plan_sha256 === plan.planSha256),
      );
      await expect(
        plans.transition({
          tenantId: plan.tenantId,
          planId: plan.id,
          expectedStateVersion: 2,
          status: 'succeeded',
          stepStates: [
            {
              stepId: 'step_publish',
              status: 'succeeded',
              approvalId: approval.id,
              executionId: executed.id,
              resultSha256: agentSha256(executed.result),
            },
          ],
          actor: {
            type: 'agent',
            tenantId: plan.tenantId,
            principalId: plan.agentPrincipalId,
          },
          reasonCode: 'execution_succeeded',
          idempotencyKey: `agent-plan-succeeded-${driver}-0001`,
        }),
      ).resolves.toMatchObject({ state: { status: 'succeeded', stateVersion: 3 } });
    });

    it('hides an action from a different sponsor without approval persistence', async () => {
      const service = new AgentActionService(db);
      const prepared = await service.prepare({
        tenantId: action.target.tenantId,
        agentPrincipalId: action.agentPrincipalId,
        idempotencyKey: `agent-action-cross-sponsor-${driver}-0001`,
        kind: 'event.publish',
        delegationGrantId: action.delegationGrantId,
        resourceId: action.target.resourceId,
      });
      await expect(
        service.getForSponsor({
          tenantId: action.target.tenantId,
          sponsorPrincipalId: 'user_other',
          actionId: prepared.action.id,
        }),
      ).resolves.toBeUndefined();
      await expect(
        service.approve({
          tenantId: action.target.tenantId,
          approverPrincipalId: 'user_other',
          actionId: prepared.action.id,
          actionDigest: prepared.actionDigest,
          idempotencyKey: `agent-action-cross-sponsor-approval-${driver}-0001`,
        }),
      ).rejects.toThrow('AGENT_ACTION_APPROVAL_SCOPE_DENIED');
      expect(
        await db
          .selectFrom('agent_approvals')
          .select('id')
          .where('action_id', '=', prepared.action.id)
          .execute(),
      ).toHaveLength(0);
    });

    it('revokes one exact approval after permission loss with convergent replay', async () => {
      const service = new AgentActionService(db);
      const beforeExecutions = await db.selectFrom('agent_executions').select('id').execute();
      const beforeEffects = await db
        .selectFrom('agent_action_effects')
        .select('execution_id')
        .execute();
      const prepared = await service.prepare({
        tenantId: action.target.tenantId,
        agentPrincipalId: action.agentPrincipalId,
        idempotencyKey: `agent-action-for-revocation-${driver}-0001`,
        kind: 'event.publish',
        delegationGrantId: action.delegationGrantId,
        resourceId: action.target.resourceId,
      });
      const approval = await service.approve({
        tenantId: action.target.tenantId,
        approverPrincipalId: action.sponsorPrincipalId,
        actionId: prepared.action.id,
        actionDigest: prepared.actionDigest,
        idempotencyKey: `agent-action-revocation-approval-${driver}-0001`,
      });
      await db
        .deleteFrom('permission_grants')
        .where('tenant_id', '=', action.target.tenantId)
        .where('principal_id', '=', action.sponsorPrincipalId)
        .where('permission', '=', 'events.write')
        .execute();
      const request = {
        tenantId: action.target.tenantId,
        sponsorPrincipalId: action.sponsorPrincipalId,
        actionId: prepared.action.id,
        approvalId: approval.id,
        actionDigest: prepared.actionDigest,
        idempotencyKey: `agent-action-revocation-${driver}-0001`,
      };
      const concurrent = await Promise.all(
        Array.from({ length: 4 }, () => service.revokeApproval(request)),
      );
      expect(concurrent).toEqual([concurrent[0], concurrent[0], concurrent[0], concurrent[0]]);
      expect(concurrent[0]).toMatchObject({ id: approval.id, revokedAt: expect.any(String) });
      await expect(service.revokeApproval(request)).resolves.toEqual(concurrent[0]);
      await expect(
        service.revokeApproval({
          ...request,
          approvalId: `apr_${'f'.repeat(48)}`,
        }),
      ).rejects.toThrow('AGENT_ACTION_APPROVAL_IDEMPOTENCY_CONFLICT');
      await expect(
        service.revokeApproval({
          ...request,
          sponsorPrincipalId: 'user_other',
          idempotencyKey: `${request.idempotencyKey}-other`,
        }),
      ).rejects.toThrow('AGENT_ACTION_APPROVAL_SCOPE_DENIED');
      await expect(
        service.revokeApproval({
          ...request,
          idempotencyKey: `${request.idempotencyKey}-second`,
        }),
      ).rejects.toThrow('AGENT_ACTION_APPROVAL_ALREADY_REVOKED');
      expect(
        await db
          .selectFrom('agent_action_events')
          .select(['approval_id', 'phase', 'outcome'])
          .where('action_id', '=', prepared.action.id)
          .where('phase', '=', 'revoked')
          .execute(),
      ).toEqual([{ approval_id: approval.id, phase: 'revoked', outcome: 'revoked' }]);
      expect(
        await db
          .selectFrom('agent_approvals')
          .select('revoked_at')
          .where('id', '=', approval.id)
          .executeTakeFirstOrThrow(),
      ).toMatchObject({ revoked_at: expect.any(Date) });
      expect(await db.selectFrom('agent_executions').select('id').execute()).toEqual(
        beforeExecutions,
      );
      expect(await db.selectFrom('agent_action_effects').select('execution_id').execute()).toEqual(
        beforeEffects,
      );
    });

    it('allows exactly one competing revocation key and rejects invalid bindings without effects', async () => {
      const service = new AgentActionService(db);
      const prepared = await service.prepare({
        tenantId: action.target.tenantId,
        agentPrincipalId: action.agentPrincipalId,
        idempotencyKey: `agent-action-revocation-race-${driver}-0001`,
        kind: 'event.publish',
        delegationGrantId: action.delegationGrantId,
        resourceId: action.target.resourceId,
      });
      const approval = await service.approve({
        tenantId: action.target.tenantId,
        approverPrincipalId: action.sponsorPrincipalId,
        actionId: prepared.action.id,
        actionDigest: prepared.actionDigest,
        idempotencyKey: `agent-action-revocation-race-approval-${driver}-0001`,
      });
      const beforeExecutions = await db.selectFrom('agent_executions').select('id').execute();
      const beforeEffects = await db
        .selectFrom('agent_action_effects')
        .select('execution_id')
        .execute();
      const base = {
        tenantId: action.target.tenantId,
        sponsorPrincipalId: action.sponsorPrincipalId,
        actionId: prepared.action.id,
        approvalId: approval.id,
        actionDigest: prepared.actionDigest,
      };
      for (const invalid of [
        { ...base, approvalId: `apr_${'f'.repeat(48)}` },
        { ...base, actionId: `act_${'f'.repeat(48)}` },
        { ...base, actionDigest: 'f'.repeat(64) },
        { ...base, tenantId: 'tenant_other' },
      ]) {
        await expect(
          service.revokeApproval({
            ...invalid,
            idempotencyKey: `agent-action-invalid-revocation-${driver}-${invalid.approvalId.slice(-4)}-${invalid.actionDigest.slice(0, 4)}-${invalid.tenantId}`,
          }),
        ).rejects.toThrow();
      }
      expect(
        await db
          .selectFrom('agent_approvals')
          .select('revoked_at')
          .where('id', '=', approval.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ revoked_at: null });
      const competing = await Promise.allSettled(
        Array.from({ length: 4 }, (_, index) =>
          service.revokeApproval({
            ...base,
            idempotencyKey: `agent-action-competing-revocation-${driver}-000${index}`,
          }),
        ),
      );
      expect(competing.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
      expect(competing.filter(({ status }) => status === 'rejected')).toHaveLength(3);
      expect(
        await db
          .selectFrom('agent_action_events')
          .select('id')
          .where('action_id', '=', prepared.action.id)
          .where('phase', '=', 'revoked')
          .execute(),
      ).toHaveLength(1);
      expect(await db.selectFrom('agent_executions').select('id').execute()).toEqual(
        beforeExecutions,
      );
      expect(await db.selectFrom('agent_action_effects').select('execution_id').execute()).toEqual(
        beforeEffects,
      );
    });

    it('refuses to revoke a consumed action approval without lifecycle mutation', async () => {
      const service = new AgentActionService(db);
      const prepared = await service.prepare({
        tenantId: action.target.tenantId,
        agentPrincipalId: action.agentPrincipalId,
        idempotencyKey: `agent-action-consumed-revocation-${driver}-0001`,
        kind: 'event.publish',
        delegationGrantId: action.delegationGrantId,
        resourceId: action.target.resourceId,
      });
      const approval = await service.approve({
        tenantId: action.target.tenantId,
        approverPrincipalId: action.sponsorPrincipalId,
        actionId: prepared.action.id,
        actionDigest: prepared.actionDigest,
        idempotencyKey: `agent-action-consumed-approval-${driver}-0001`,
      });
      await db
        .updateTable('agent_approvals')
        .set({ consumed_at: new Date() })
        .where('id', '=', approval.id)
        .executeTakeFirstOrThrow();
      await expect(
        service.revokeApproval({
          tenantId: action.target.tenantId,
          sponsorPrincipalId: action.sponsorPrincipalId,
          actionId: prepared.action.id,
          approvalId: approval.id,
          actionDigest: prepared.actionDigest,
          idempotencyKey: `agent-action-consumed-revocation-${driver}-0002`,
        }),
      ).rejects.toThrow('AGENT_ACTION_APPROVAL_ALREADY_CONSUMED');
      expect(
        await db
          .selectFrom('agent_action_events')
          .select('id')
          .where('action_id', '=', prepared.action.id)
          .where('phase', '=', 'revoked')
          .execute(),
      ).toHaveLength(0);
      expect(
        await db
          .selectFrom('agent_approvals')
          .select('revoked_at')
          .where('id', '=', approval.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ revoked_at: null });
    });

    it.each(['resource', 'policy', 'permission'] as const)(
      'invalidates approval after a material %s change',
      async (changed) => {
        const service = new AgentActionService(db);
        const prepared = await service.prepare({
          tenantId: action.target.tenantId,
          agentPrincipalId: action.agentPrincipalId,
          idempotencyKey: `agent-action-stale-${changed}-${driver}-0001`,
          kind: 'event.publish',
          delegationGrantId: action.delegationGrantId,
          resourceId: action.target.resourceId,
        });
        if (changed === 'resource')
          await db
            .updateTable('events')
            .set({ version: action.target.resourceVersion + 1 })
            .where('id', '=', action.target.resourceId)
            .execute();
        if (changed === 'policy')
          await db
            .updateTable('agent_action_policies')
            .set({ policy_version: action.expectedPolicyVersion + 1 })
            .where('tenant_id', '=', action.target.tenantId)
            .where('action_kind', '=', action.kind)
            .execute();
        if (changed === 'permission')
          await db
            .deleteFrom('permission_grants')
            .where('tenant_id', '=', action.target.tenantId)
            .where('principal_id', '=', action.sponsorPrincipalId)
            .where('permission', '=', 'events.write')
            .execute();
        await expect(
          service.approve({
            tenantId: action.target.tenantId,
            approverPrincipalId: action.sponsorPrincipalId,
            actionId: prepared.action.id,
            actionDigest: prepared.actionDigest,
            idempotencyKey: `agent-action-stale-approval-${changed}-${driver}-0001`,
          }),
        ).rejects.toThrow('AGENT_ACTION_NOT_APPROVABLE');
        expect(
          await db
            .selectFrom('agent_approvals')
            .select('id')
            .where('action_id', '=', prepared.action.id)
            .execute(),
        ).toHaveLength(0);
        expect(
          await db
            .selectFrom('agent_action_events')
            .select('id')
            .where('action_id', '=', prepared.action.id)
            .where('phase', '=', 'approved')
            .execute(),
        ).toHaveLength(0);
      },
    );

    it('executes an approved prepared action once and replays the terminal result', async () => {
      const service = new AgentActionService(db);
      const prepared = await service.prepare({
        tenantId: action.target.tenantId,
        agentPrincipalId: action.agentPrincipalId,
        idempotencyKey: `agent-action-public-execution-${driver}-0001`,
        kind: 'event.publish',
        delegationGrantId: action.delegationGrantId,
        resourceId: action.target.resourceId,
      });
      const approval = await service.approve({
        tenantId: action.target.tenantId,
        approverPrincipalId: action.sponsorPrincipalId,
        actionId: prepared.action.id,
        actionDigest: prepared.actionDigest,
        idempotencyKey: `agent-action-public-execution-approval-${driver}-0001`,
      });
      const request = {
        tenantId: action.target.tenantId,
        agentPrincipalId: action.agentPrincipalId,
        actionId: prepared.action.id,
        approvalId: approval.id,
        actionDigest: prepared.actionDigest,
      };
      await expect(
        service.execute({ ...request, agentPrincipalId: 'agent_substituted' }),
      ).rejects.toThrow('AGENT_ACTION_EXECUTION_SCOPE_DENIED');
      await expect(service.execute({ ...request, actionDigest: 'f'.repeat(64) })).rejects.toThrow(
        'AGENT_ACTION_EXECUTION_DIGEST_MISMATCH',
      );
      await expect(
        service.execute({ ...request, approvalId: `apr_${'f'.repeat(48)}` }),
      ).rejects.toThrow('AGENT_ACTION_EXECUTION_SCOPE_DENIED');
      expect(await db.selectFrom('agent_executions').select('id').execute()).toHaveLength(1);
      const concurrent = await Promise.allSettled(
        Array.from({ length: 4 }, () => service.execute(request)),
      );
      const fulfilled = concurrent.filter(
        (result): result is PromiseFulfilledResult<AgentExecution> => result.status === 'fulfilled',
      );
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);
      expect(
        concurrent
          .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
          .every((result) => result.reason instanceof AgentExecutionConflictError),
      ).toBe(true);
      const executed = fulfilled[0]!.value;
      expect(executed).toMatchObject({
        state: 'succeeded',
        actionId: prepared.action.id,
        approvalId: approval.id,
        result: {
          resourceId: action.target.resourceId,
          resourceVersion: action.target.resourceVersion + 1,
          status: 'published',
        },
      });
      await expect(service.execute(request)).resolves.toEqual(executed);
      expect(
        await db
          .selectFrom('agent_approvals')
          .select(['consumed_at', 'consumed_execution_id', 'revoked_at'])
          .where('id', '=', approval.id)
          .executeTakeFirstOrThrow(),
      ).toMatchObject({
        consumed_at: expect.any(Date),
        consumed_execution_id: executed.id,
        revoked_at: null,
      });
      expect(
        await db
          .selectFrom('agent_action_effects')
          .select('execution_id')
          .where('execution_id', '=', executed.id)
          .execute(),
      ).toEqual([{ execution_id: executed.id }]);
      const auditRows = await db
        .selectFrom('agent_audit_events')
        .select(['phase', 'action_id', 'approval_id', 'action_digest'])
        .where('execution_id', '=', executed.id)
        .execute();
      expect(auditRows).toHaveLength(4);
      expect(auditRows.map(({ phase }) => phase)).toEqual(
        expect.arrayContaining(['prepared', 'authorized', 'started', 'succeeded']),
      );
      expect(auditRows).toEqual(
        expect.arrayContaining(
          ['prepared', 'authorized', 'started', 'succeeded'].map((phase) => ({
            phase,
            action_id: prepared.action.id,
            approval_id: approval.id,
            action_digest: prepared.actionDigest,
          })),
        ),
      );
      const productAudit = await db
        .selectFrom('audit_logs')
        .select(['actor_type', 'actor_id', 'action', 'resource_id', 'request_id', 'diff_summary'])
        .where('tenant_id', '=', action.target.tenantId)
        .where('action', '=', 'event.published')
        .where('request_id', '=', executed.id)
        .executeTakeFirstOrThrow();
      expect(productAudit).toMatchObject({
        actor_type: 'agent',
        actor_id: action.agentPrincipalId,
        action: 'event.published',
        resource_id: action.target.resourceId,
        request_id: executed.id,
      });
      const productAuditDiff =
        typeof productAudit.diff_summary === 'string'
          ? (JSON.parse(productAudit.diff_summary) as Record<string, unknown>)
          : productAudit.diff_summary;
      expect(productAuditDiff).toMatchObject({
        protocolVersion: AGENT_PROTOCOL_VERSION,
        actionDigest: prepared.actionDigest,
        executionId: executed.id,
        sponsorPrincipalId: action.sponsorPrincipalId,
        delegationGrantId: action.delegationGrantId,
        approvalId: approval.id,
        expectedPolicyVersion: action.expectedPolicyVersion,
        expectedResourceVersion: action.target.resourceVersion,
        resultingResourceVersion: action.target.resourceVersion + 1,
      });
    });

    it('serializes execution against approval revocation with one safe winner', async () => {
      const service = new AgentActionService(db);
      const prepared = await service.prepare({
        tenantId: action.target.tenantId,
        agentPrincipalId: action.agentPrincipalId,
        idempotencyKey: `agent-action-execute-revoke-race-${driver}-0001`,
        kind: 'event.publish',
        delegationGrantId: action.delegationGrantId,
        resourceId: action.target.resourceId,
      });
      const approval = await service.approve({
        tenantId: action.target.tenantId,
        approverPrincipalId: action.sponsorPrincipalId,
        actionId: prepared.action.id,
        actionDigest: prepared.actionDigest,
        idempotencyKey: `agent-action-execute-revoke-race-approval-${driver}-0001`,
      });
      const [executionResult, revocationResult] = await Promise.allSettled([
        service.execute({
          tenantId: action.target.tenantId,
          agentPrincipalId: action.agentPrincipalId,
          actionId: prepared.action.id,
          approvalId: approval.id,
          actionDigest: prepared.actionDigest,
        }),
        service.revokeApproval({
          tenantId: action.target.tenantId,
          sponsorPrincipalId: action.sponsorPrincipalId,
          actionId: prepared.action.id,
          approvalId: approval.id,
          actionDigest: prepared.actionDigest,
          idempotencyKey: `agent-action-execute-revoke-race-revocation-${driver}-0001`,
        }),
      ]);
      expect(
        [executionResult, revocationResult].filter(({ status }) => status === 'fulfilled'),
      ).toHaveLength(1);
      if (executionResult.status === 'rejected')
        expect(executionResult.reason).toBeInstanceOf(AgentExecutionConflictError);
      if (revocationResult.status === 'rejected')
        expect(revocationResult.reason).toMatchObject({
          message: 'AGENT_ACTION_APPROVAL_ALREADY_CONSUMED',
        });
      const storedApproval = await db
        .selectFrom('agent_approvals')
        .select(['consumed_at', 'consumed_execution_id', 'revoked_at'])
        .where('id', '=', approval.id)
        .executeTakeFirstOrThrow();
      const executionWon = executionResult.status === 'fulfilled';
      expect(Boolean(storedApproval.consumed_at)).toBe(executionWon);
      expect(Boolean(storedApproval.consumed_execution_id)).toBe(executionWon);
      expect(Boolean(storedApproval.revoked_at)).toBe(!executionWon);
      expect(
        await db
          .selectFrom('agent_action_effects')
          .select('execution_id')
          .where('action_digest', '=', prepared.actionDigest)
          .execute(),
      ).toHaveLength(executionWon ? 1 : 0);
      expect(
        await db
          .selectFrom('agent_action_events')
          .select('id')
          .where('action_id', '=', prepared.action.id)
          .where('phase', '=', 'revoked')
          .execute(),
      ).toHaveLength(executionWon ? 0 : 1);
    });

    it.each([
      'execution_idempotency',
      'execution_fingerprint',
      'resource_version',
      'policy_version',
      'approval_consumed_at',
      'approval_execution_id',
      'approval_revoked',
    ] as const)(
      'rejects terminal replay after persisted %s binding corruption',
      async (changed) => {
        const service = new AgentActionService(db);
        const prepared = await service.prepare({
          tenantId: action.target.tenantId,
          agentPrincipalId: action.agentPrincipalId,
          idempotencyKey: `agent-action-replay-binding-${changed}-${driver}-0001`,
          kind: 'event.publish',
          delegationGrantId: action.delegationGrantId,
          resourceId: action.target.resourceId,
        });
        const approval = await service.approve({
          tenantId: action.target.tenantId,
          approverPrincipalId: action.sponsorPrincipalId,
          actionId: prepared.action.id,
          actionDigest: prepared.actionDigest,
          idempotencyKey: `agent-action-replay-binding-approval-${changed}-${driver}-0001`,
        });
        const request = {
          tenantId: action.target.tenantId,
          agentPrincipalId: action.agentPrincipalId,
          actionId: prepared.action.id,
          approvalId: approval.id,
          actionDigest: prepared.actionDigest,
        };
        const executed = await service.execute(request);
        if (changed === 'execution_idempotency')
          await db
            .updateTable('agent_executions')
            .set({ idempotency_key: 'corrupted-execution-key' })
            .where('id', '=', executed.id)
            .execute();
        if (changed === 'execution_fingerprint')
          await db
            .updateTable('agent_executions')
            .set({ request_fingerprint: 'f'.repeat(64) })
            .where('id', '=', executed.id)
            .execute();
        if (changed === 'resource_version')
          await db
            .updateTable('agent_executions')
            .set({ resource_version: executed.resourceVersion + 1 })
            .where('id', '=', executed.id)
            .execute();
        if (changed === 'policy_version')
          await db
            .updateTable('agent_executions')
            .set({ policy_version: executed.policyVersion + 1 })
            .where('id', '=', executed.id)
            .execute();
        if (changed === 'approval_consumed_at')
          await db
            .updateTable('agent_approvals')
            .set({ consumed_at: null })
            .where('id', '=', approval.id)
            .execute();
        if (changed === 'approval_execution_id')
          await db
            .updateTable('agent_approvals')
            .set({ consumed_execution_id: null })
            .where('id', '=', approval.id)
            .execute();
        if (changed === 'approval_revoked')
          await db
            .updateTable('agent_approvals')
            .set({ revoked_at: new Date() })
            .where('id', '=', approval.id)
            .execute();
        await expect(service.execute(request)).rejects.toBeInstanceOf(AgentExecutionConflictError);
        expect(
          await db
            .selectFrom('agent_action_effects')
            .select('execution_id')
            .where('execution_id', '=', executed.id)
            .execute(),
        ).toHaveLength(1);
      },
    );

    it.each(['resource', 'policy', 'permission', 'delegation', 'principal'] as const)(
      'refuses execution after a material %s change without consuming approval',
      async (changed) => {
        const service = new AgentActionService(db);
        const prepared = await service.prepare({
          tenantId: action.target.tenantId,
          agentPrincipalId: action.agentPrincipalId,
          idempotencyKey: `agent-action-execution-stale-${changed}-${driver}-0001`,
          kind: 'event.publish',
          delegationGrantId: action.delegationGrantId,
          resourceId: action.target.resourceId,
        });
        const approval = await service.approve({
          tenantId: action.target.tenantId,
          approverPrincipalId: action.sponsorPrincipalId,
          actionId: prepared.action.id,
          actionDigest: prepared.actionDigest,
          idempotencyKey: `agent-action-execution-stale-approval-${changed}-${driver}-0001`,
        });
        if (changed === 'resource')
          await db
            .updateTable('events')
            .set({ version: action.target.resourceVersion + 1 })
            .where('id', '=', action.target.resourceId)
            .execute();
        if (changed === 'policy')
          await db
            .updateTable('agent_action_policies')
            .set({ policy_version: action.expectedPolicyVersion + 1 })
            .where('tenant_id', '=', action.target.tenantId)
            .where('action_kind', '=', action.kind)
            .execute();
        if (changed === 'permission')
          await db
            .deleteFrom('permission_grants')
            .where('tenant_id', '=', action.target.tenantId)
            .where('principal_id', '=', action.sponsorPrincipalId)
            .where('permission', '=', 'events.write')
            .execute();
        if (changed === 'delegation')
          await db
            .updateTable('agent_delegations')
            .set({ revoked_at: new Date() })
            .where('tenant_id', '=', action.target.tenantId)
            .where('id', '=', action.delegationGrantId)
            .execute();
        if (changed === 'principal')
          await db
            .updateTable('agent_principals')
            .set({ state: 'revoked' })
            .where('tenant_id', '=', action.target.tenantId)
            .where('id', '=', action.agentPrincipalId)
            .execute();
        await expect(
          service.execute({
            tenantId: action.target.tenantId,
            agentPrincipalId: action.agentPrincipalId,
            actionId: prepared.action.id,
            approvalId: approval.id,
            actionDigest: prepared.actionDigest,
          }),
        ).rejects.toBeInstanceOf(AgentExecutionConflictError);
        expect(
          await db
            .selectFrom('agent_approvals')
            .select(['consumed_at', 'consumed_execution_id'])
            .where('id', '=', approval.id)
            .executeTakeFirstOrThrow(),
        ).toEqual({ consumed_at: null, consumed_execution_id: null });
        expect(
          await db
            .selectFrom('agent_executions')
            .select('id')
            .where('action_id', '=', prepared.action.id)
            .execute(),
        ).toHaveLength(0);
        expect(
          await db
            .selectFrom('agent_action_effects')
            .select('execution_id')
            .where('action_digest', '=', prepared.actionDigest)
            .execute(),
        ).toHaveLength(0);
      },
    );

    it('reloads the complete authorization state and executes an idempotent public operation', async () => {
      const state = await adapter.load({ action, execution });
      expect(new Date(state.observedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(state.approval.approvedAt).getTime(),
      );
      await expect(
        adapter.invoke(invocation(agentAuthorizationStateDigest(state))),
      ).resolves.toEqual({
        resourceId: action.target.resourceId,
        resourceVersion: action.target.resourceVersion + 1,
        status: 'published',
      });
      await expect(
        adapter.invoke(invocation(agentAuthorizationStateDigest(state))),
      ).resolves.toEqual({
        resourceId: action.target.resourceId,
        resourceVersion: action.target.resourceVersion + 1,
        status: 'published',
      });
      const published = await db
        .selectFrom('events')
        .select(['status', 'version'])
        .where('id', '=', action.target.resourceId)
        .executeTakeFirstOrThrow();
      expect(published).toMatchObject({
        status: 'published',
        version: action.target.resourceVersion + 1,
      });
      expect(
        await db
          .selectFrom('agent_action_effects')
          .select('execution_id')
          .where('execution_id', '=', execution.id)
          .execute(),
      ).toHaveLength(1);
      await expect(
        db
          .updateTable('agent_action_effects')
          .set({ result: '{}' })
          .where('execution_id', '=', execution.id)
          .execute(),
      ).rejects.toThrow(/immutable/u);
      await expect(
        db.deleteFrom('agent_action_effects').where('execution_id', '=', execution.id).execute(),
      ).rejects.toThrow(/immutable/u);
    });

    it.each(['product_audit', 'post_audit_effect'] as const)(
      'rolls back publication when %s persistence fails',
      async (failure) => {
        const forcedFailure = Object.assign(new Error(`forced ${failure} failure`), {
          code: 'FORCED_PERSISTENCE_FAILURE',
        });
        const failingAdapter = new EventPublishAgentAdapter(db, {
          beforeProductAudit:
            failure === 'product_audit' ? () => Promise.reject(forcedFailure) : undefined,
          beforeEffectRecord:
            failure === 'post_audit_effect' ? () => Promise.reject(forcedFailure) : undefined,
        });
        const state = await failingAdapter.load({ action, execution });
        await expect(
          failingAdapter.invoke(invocation(agentAuthorizationStateDigest(state))),
        ).rejects.toBe(forcedFailure);
        await expect(
          db
            .selectFrom('events')
            .select(['status', 'version'])
            .where('tenant_id', '=', action.target.tenantId)
            .where('id', '=', action.target.resourceId)
            .executeTakeFirstOrThrow(),
        ).resolves.toMatchObject({
          status: 'draft',
          version: action.target.resourceVersion,
        });
        expect(
          await db
            .selectFrom('audit_logs')
            .select('id')
            .where('tenant_id', '=', action.target.tenantId)
            .where('request_id', '=', execution.id)
            .execute(),
        ).toHaveLength(0);
        expect(
          await db
            .selectFrom('agent_action_effects')
            .select('execution_id')
            .where('execution_id', '=', execution.id)
            .execute(),
        ).toHaveLength(0);
        await expect(
          db
            .selectFrom('agent_executions')
            .select('state')
            .where('tenant_id', '=', action.target.tenantId)
            .where('id', '=', execution.id)
            .executeTakeFirstOrThrow(),
        ).resolves.toEqual({ state: 'running' });
      },
    );

    it('does not resurrect an event archived after a stale human read', async () => {
      const stale = await db
        .selectFrom('events')
        .selectAll()
        .where('tenant_id', '=', action.target.tenantId)
        .where('id', '=', action.target.resourceId)
        .executeTakeFirstOrThrow();
      await db
        .updateTable('events')
        .set({ status: 'archived', version: Number(stale.version) + 1, updated_at: new Date() })
        .where('tenant_id', '=', action.target.tenantId)
        .where('id', '=', action.target.resourceId)
        .where('version', '=', Number(stale.version))
        .executeTakeFirstOrThrow();

      const result = await db
        .transaction()
        .setIsolationLevel('serializable')
        .execute((tx) =>
          publishEvent(tx, new ReadinessService(tx as Database, resolvePaymentMode()), {
            tenantId: action.target.tenantId,
            eventId: action.target.resourceId,
            permissions: new Set<Permission>(['events.write']),
          }),
        );
      expect(result.kind).toBe('archived');
      await expect(
        db
          .selectFrom('events')
          .select(['status', 'version'])
          .where('tenant_id', '=', action.target.tenantId)
          .where('id', '=', action.target.resourceId)
          .executeTakeFirstOrThrow(),
      ).resolves.toMatchObject({ status: 'archived', version: Number(stale.version) + 1 });
    });

    it('serializes concurrent publication into one mutation', async () => {
      const publishOnce = () =>
        db
          .transaction()
          .setIsolationLevel('serializable')
          .execute((tx) =>
            publishEvent(tx, new ReadinessService(tx as Database, resolvePaymentMode()), {
              tenantId: action.target.tenantId,
              eventId: action.target.resourceId,
              permissions: new Set<Permission>(['events.write']),
            }),
          );
      const attempts = await Promise.allSettled([publishOnce(), publishOnce()]);
      const completed = attempts.filter(
        (attempt): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof publishOnce>>> =>
          attempt.status === 'fulfilled',
      );
      expect(completed.some(({ value }) => value.kind === 'published')).toBe(true);
      expect(
        attempts
          .filter((attempt): attempt is PromiseRejectedResult => attempt.status === 'rejected')
          .every((attempt) => {
            const error = attempt.reason as {
              code?: string;
              errno?: number;
              cause?: { code?: string; errno?: number };
            };
            return (
              (error.code ?? error.cause?.code) === '40001' ||
              (error.code ?? error.cause?.code) === 'ER_LOCK_DEADLOCK' ||
              (error.errno ?? error.cause?.errno) === 1213
            );
          }),
      ).toBe(true);
      await expect(publishOnce()).resolves.toMatchObject({ kind: 'already_published' });
      await expect(
        db
          .selectFrom('events')
          .select(['status', 'version'])
          .where('tenant_id', '=', action.target.tenantId)
          .where('id', '=', action.target.resourceId)
          .executeTakeFirstOrThrow(),
      ).resolves.toMatchObject({
        status: 'published',
        version: action.target.resourceVersion + 1,
      });
    });

    it.each(['missing_policy', 'invalid_principal_state'] as const)(
      'classifies permanent authorization load failure %s without invoking',
      async (failure) => {
        if (failure === 'missing_policy')
          await db
            .deleteFrom('agent_action_policies')
            .where('tenant_id', '=', execution.tenantId)
            .where('action_kind', '=', action.kind)
            .execute();
        if (failure === 'invalid_principal_state')
          await db
            .updateTable('agent_principals')
            .set({ capabilities: '{invalid-json' })
            .where('tenant_id', '=', execution.tenantId)
            .where('id', '=', execution.agentPrincipalId)
            .execute();
        await expect(adapter.load({ action, execution })).rejects.toMatchObject({
          code:
            failure === 'missing_policy' ? 'AGENT_AUTHORIZATION_CHANGED' : 'AGENT_STATE_INVALID',
        });
        expect(
          await db
            .selectFrom('agent_action_effects')
            .select('execution_id')
            .where('execution_id', '=', execution.id)
            .execute(),
        ).toHaveLength(0);
      },
    );

    it('lets a successor reconcile one committed effect after lease loss and revocation', async () => {
      await db
        .updateTable('agent_executions')
        .set({ state: 'reserved', fence_token: 0, lease_owner: null, lease_expires_at: null })
        .where('id', '=', execution.id)
        .execute();
      const reserved = {
        ...execution,
        state: 'reserved' as const,
        fenceToken: 0,
        leaseOwner: undefined,
      };
      const repository = new AgentExecutionRepository(db);
      let rejectFirstCompletion = true;
      let invocations = 0;
      const store: AgentExecutionStore = {
        reserveAndConsume: (input) => repository.reserveAndConsume(input),
        claim: (input) => repository.claim(input),
        recoverEffect: (input) => repository.recoverEffect(input),
        complete: async (input) => {
          if (rejectFirstCompletion) {
            rejectFirstCompletion = false;
            return false;
          }
          return repository.complete(input);
        },
      };
      let auditSequence = 0;
      const service = new DurableAgentExecutionService(
        store,
        {
          async invoke(input) {
            invocations += 1;
            return adapter.invoke(input);
          },
        },
        { now: () => new Date() },
        {
          executionId: () => 'unused_execution',
          auditId: () => `audit_recovery_${++auditSequence}`,
        },
        adapter,
      );
      await expect(
        service.run({ action, execution: reserved, workerId: 'worker_first' }),
      ).rejects.toBeInstanceOf(AgentExecutionConflictError);
      await db
        .updateTable('agent_executions')
        .set({ lease_expires_at: new Date(Date.now() - 60_000) })
        .where('id', '=', execution.id)
        .execute();
      await db
        .updateTable('agent_approvals')
        .set({ revoked_at: new Date() })
        .where('id', '=', execution.approvalId)
        .execute();
      await db
        .updateTable('agent_principals')
        .set({ state: 'revoked' })
        .where('id', '=', execution.agentPrincipalId)
        .execute();
      await db
        .updateTable('agent_delegations')
        .set({ revoked_at: new Date() })
        .where('id', '=', execution.delegationGrantId)
        .execute();
      await expect(
        service.run({ action, execution: reserved, workerId: 'worker_successor' }),
      ).resolves.toMatchObject({ state: 'succeeded', result: { status: 'published' } });
      expect(invocations).toBe(1);
      expect(
        await db
          .selectFrom('events')
          .select(['status', 'version'])
          .where('id', '=', action.target.resourceId)
          .executeTakeFirstOrThrow(),
      ).toMatchObject({ status: 'published', version: action.target.resourceVersion + 1 });
      expect(
        await db
          .selectFrom('agent_action_effects')
          .select('execution_id')
          .where('execution_id', '=', execution.id)
          .execute(),
      ).toHaveLength(1);
      expect(
        await db
          .selectFrom('agent_executions')
          .select('state')
          .where('id', '=', execution.id)
          .executeTakeFirstOrThrow(),
      ).toMatchObject({ state: 'succeeded' });
    });

    it.each([
      { resourceVersion: 999, status: 'published' },
      { resourceVersion: 2, status: 'failed' },
    ])('rejects a semantically forged persisted effect result: %o', async (override) => {
      const forged = { resourceId: action.target.resourceId, ...override };
      await db
        .insertInto('agent_action_effects')
        .values({
          execution_id: execution.id,
          tenant_id: execution.tenantId,
          action_digest: execution.actionDigest,
          resource_type: 'event',
          resource_id: action.target.resourceId,
          operation: 'events.publish',
          idempotency_key: execution.idempotencyKey,
          expected_policy_version: execution.policyVersion,
          expected_resource_version: execution.resourceVersion,
          effect_fence_token: execution.fenceToken,
          result: JSON.stringify(forged),
          result_sha256: agentSha256(forged),
          created_at: new Date(),
        })
        .execute();
      const state = await adapter.load({ action, execution });
      await expect(
        adapter.invoke(invocation(agentAuthorizationStateDigest(state))),
      ).rejects.toMatchObject({ code: 'AGENT_AUTHORIZATION_CHANGED' });
    });

    it.each(['approval', 'policy', 'resource', 'lease_expiry', 'successor_fence'] as const)(
      'rejects a %s change committed between load and invoke',
      async (changed) => {
        const state = await adapter.load({ action, execution });
        if (changed === 'approval')
          await db
            .updateTable('agent_approvals')
            .set({ revoked_at: new Date() })
            .where('id', '=', execution.approvalId)
            .execute();
        if (changed === 'policy')
          await db
            .updateTable('agent_action_policies')
            .set({ policy_version: 4 })
            .where('tenant_id', '=', execution.tenantId)
            .execute();
        if (changed === 'resource')
          await db
            .updateTable('events')
            .set({ version: 2 })
            .where('id', '=', action.target.resourceId)
            .execute();
        if (changed === 'lease_expiry')
          await db
            .updateTable('agent_executions')
            .set({ lease_expires_at: new Date(Date.now() - 60_000) })
            .where('id', '=', execution.id)
            .execute();
        if (changed === 'successor_fence')
          await db
            .updateTable('agent_executions')
            .set({ fence_token: 2, lease_owner: 'worker_successor' })
            .where('id', '=', execution.id)
            .execute();
        await expect(
          adapter.invoke(invocation(agentAuthorizationStateDigest(state))),
        ).rejects.toMatchObject({ code: 'AGENT_AUTHORIZATION_CHANGED' });
        expect(
          await db
            .selectFrom('events')
            .select('status')
            .where('id', '=', action.target.resourceId)
            .executeTakeFirstOrThrow(),
        ).toMatchObject({ status: 'draft' });
        expect(
          await db
            .selectFrom('agent_action_effects')
            .select('execution_id')
            .where('execution_id', '=', execution.id)
            .execute(),
        ).toHaveLength(0);
      },
    );
  },
);
