import {
  AGENT_PLATFORM_PROTOCOL_VERSION,
  AGENT_PROTOCOL_VERSION,
  agentActionDigest,
  agentSha256,
  buildAgentPlanDefinition,
  canonicalAgentJson,
  type AgentAction,
} from '@tixkit/agent-protocol';
import {
  AgentPlanRepository,
  TenantRepository,
  createDb,
  runMigrations,
  truncateAllData,
  type Database,
} from '@tixkit/db';
import type { Principal } from '@tixkit/domain';
import Fastify, { type FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentPlanRoutes } from '../../routes/modules/agent-plans.js';

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
  it.skip('agent plan route integration (database URLs are not configured)', () => {});

function actor(id: string, tenantId: string): Principal {
  return {
    id,
    type: 'agent',
    tenantId,
    organizationIds: [],
    brandIds: [],
    eventIds: [],
    scopes: [],
  };
}

async function seedPlan(db: Database, tenantId: string, suffix: string) {
  const agentPrincipalId = `agent_route_${suffix}`;
  const sponsorPrincipalId = `sponsor_route_${suffix}`;
  const delegationGrantId = `delegation_route_${suffix}`;
  const actionId = `action_route_${suffix}`;
  const now = new Date(Math.floor(Date.now() / 1000) * 1000);
  const preparedAt = new Date(now.getTime() - 2_000).toISOString();
  const createdAt = new Date(now.getTime() - 1_000).toISOString();
  const expiresAt = new Date(now.getTime() + 600_000).toISOString();

  await db
    .insertInto('agent_principals')
    .values({
      id: agentPrincipalId,
      tenant_id: tenantId,
      kind: 'third_party',
      sponsor_principal_id: sponsorPrincipalId,
      capabilities: '["events.execute"]',
      maximum_autonomy: 'execute_with_approval',
      protocol_version: AGENT_PROTOCOL_VERSION,
      state: 'active',
      registered_at: new Date(now.getTime() - 5_000),
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('agent_delegations')
    .values({
      id: delegationGrantId,
      tenant_id: tenantId,
      agent_principal_id: agentPrincipalId,
      sponsor_principal_id: sponsorPrincipalId,
      capabilities: '["events.execute"]',
      resource_scopes: `["event:event_route_${suffix}"]`,
      permission_snapshot: '["events:publish","events:write"]',
      issued_at: new Date(now.getTime() - 4_000),
      expires_at: new Date(now.getTime() + 3_600_000),
      revoked_at: null,
      created_at: now,
    })
    .execute();

  const action: AgentAction = {
    id: actionId,
    protocolVersion: AGENT_PROTOCOL_VERSION,
    agentPrincipalId,
    sponsorPrincipalId,
    delegationGrantId,
    kind: 'event.publish',
    autonomy: 'execute_with_approval',
    target: {
      tenantId,
      resourceType: 'event',
      resourceId: `event_route_${suffix}`,
      resourceVersion: 1,
      apiOperation: 'events.publish',
    },
    payload: { readinessSnapshotSha256: 'd'.repeat(64) },
    idempotencyKey: `agent-route-action-${suffix}-0001`,
    expectedPolicyVersion: 1,
    preparedAt,
  };
  const actionDigest = agentActionDigest(action);
  await db
    .insertInto('agent_actions')
    .values({
      id: actionId,
      tenant_id: tenantId,
      agent_principal_id: agentPrincipalId,
      sponsor_principal_id: sponsorPrincipalId,
      delegation_grant_id: delegationGrantId,
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

  const definition = buildAgentPlanDefinition({
    id: 'plan_route_shared',
    protocolVersion: AGENT_PLATFORM_PROTOCOL_VERSION,
    tenantId,
    agentPrincipalId,
    sponsorPrincipalId,
    delegationGrantId,
    purpose: `Prove route isolation for ${suffix}`,
    assumptions: [],
    steps: [
      {
        id: 'step_publish',
        actionKind: 'event.publish',
        actionProtocolVersion: AGENT_PROTOCOL_VERSION,
        actionDigest,
        dependsOnStepIds: [],
        projectedChanges: [
          {
            resourceType: 'event',
            resourceId: action.target.resourceId,
            operation: 'publish',
            beforeVersion: 1,
            projectedVersion: 2,
            previewSha256: 'b'.repeat(64),
          },
        ],
        costs: [],
        readinessImpact: {
          beforeSnapshotSha256: 'd'.repeat(64),
          projectedSnapshotSha256: 'd'.repeat(64),
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
  await new AgentPlanRepository(db).create({
    definition,
    actionBindings: [{ stepId: 'step_publish', actionId }],
    actor: { type: 'agent', tenantId, principalId: agentPrincipalId },
    idempotencyKey: `agent-route-plan-${suffix}-0001`,
  });
  return { definition, principal: actor(agentPrincipalId, tenantId) };
}

describe.sequential.each(driverCases)(
  'agent plan authenticated route isolation: $driver',
  ({ driver, url }) => {
    let db: Database;
    let app: ReturnType<typeof Fastify>;
    let tenantA: Awaited<ReturnType<typeof seedPlan>>;
    let tenantB: Awaited<ReturnType<typeof seedPlan>>;
    let tenantBId: string;

    beforeAll(async () => {
      process.env.DB_DRIVER = driver;
      await runMigrations(url);
      db = createDb(url);
      await truncateAllData(db);
      const tenantAId = (await new TenantRepository(db).create({ name: `Route A ${driver}` })).id;
      tenantBId = (await new TenantRepository(db).create({ name: `Route B ${driver}` })).id;
      tenantA = await seedPlan(db, tenantAId, `${driver}_a`);
      tenantB = await seedPlan(db, tenantBId, `${driver}_b`);
      const principals = new Map<string, Principal>([
        ['tenant-a', tenantA.principal],
        ['tenant-b', tenantB.principal],
        ['tenant-b-foreign', actor(`agent_route_${driver}_foreign`, tenantBId)],
      ]);
      app = Fastify({ logger: false });
      app.decorate('context', { db } as never);
      app.addHook('onRequest', async (request: FastifyRequest) => {
        request.principal = principals.get(
          String(request.headers['x-test-authenticated-principal']),
        );
      });
      await app.register(agentPlanRoutes);
      await app.ready();
    });

    afterAll(async () => {
      await app?.close();
      await db?.destroy();
    });

    it('returns only the same-tenant plan and conceals foreign actors without mutation', async () => {
      const [responseA, responseB] = await Promise.all([
        app.inject({
          method: 'GET',
          url: '/agent/plans/plan_route_shared',
          headers: { 'x-test-authenticated-principal': 'tenant-a' },
        }),
        app.inject({
          method: 'GET',
          url: '/agent/plans/plan_route_shared',
          headers: { 'x-test-authenticated-principal': 'tenant-b' },
        }),
      ]);
      expect(responseA.statusCode).toBe(200);
      expect(responseA.json().definition.tenantId).toBe(tenantA.definition.tenantId);
      expect(responseB.statusCode).toBe(200);
      expect(responseB.json().definition.tenantId).toBe(tenantB.definition.tenantId);

      const foreignRead = await app.inject({
        method: 'GET',
        url: '/agent/plans/plan_route_shared',
        headers: { 'x-test-authenticated-principal': 'tenant-b-foreign' },
      });
      expect(foreignRead.statusCode).toBe(404);
      const foreignTransition = await app.inject({
        method: 'POST',
        url: '/agent/plans/plan_route_shared/transitions',
        headers: {
          'x-test-authenticated-principal': 'tenant-b-foreign',
          'idempotency-key': `agent-route-foreign-${driver}-0001`,
        },
        payload: {
          expectedStateVersion: 1,
          status: 'awaiting_approval',
          stepStates: [{ stepId: 'step_publish', status: 'awaiting_approval' }],
          reasonCode: 'approval_requested',
        },
      });
      expect(foreignTransition.statusCode).toBe(404);

      const states = await db
        .selectFrom('agent_plan_states')
        .select(['tenant_id', 'state_version', 'status'])
        .where('plan_id', '=', 'plan_route_shared')
        .orderBy('tenant_id')
        .execute();
      expect(states).toHaveLength(2);
      expect(
        states.map((state) => ({ ...state, state_version: Number(state.state_version) })),
      ).toEqual(
        expect.arrayContaining([
          { tenant_id: tenantA.definition.tenantId, state_version: 1, status: 'prepared' },
          { tenant_id: tenantBId, state_version: 1, status: 'prepared' },
        ]),
      );
    });
  },
);
