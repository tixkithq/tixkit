import { agentSha256 } from '@tixkit/agent-protocol';
import { runAgentPlatformContract } from '@tixkit/contract-tests';

const mutation = process.argv[2] || 'none';
const actionId = `act_${'a'.repeat(48)}`;
const approvalId = `apr_${'b'.repeat(48)}`;
const executionId = `exec_${'c'.repeat(48)}`;
const base = {
  protocolVersion: '2026-07-22',
  agentPrincipalId: 'agent_primary',
  sponsorPrincipalId: 'sponsor_primary',
  delegationGrantId: 'delegation_primary',
  expectedPolicyVersion: 3,
};
const target = {
  tenantId: 'tenant_primary',
  resourceType: 'event',
  resourceId: 'event_primary',
  resourceVersion: 7,
};
const projection = {
  title: 'Packed conformance event',
  description: 'Organizer-authored content.',
  status: 'draft',
  currency: 'USD',
  timezone: 'America/Chicago',
  startsAt: '2026-07-14T12:00:00.000Z',
  endsAt: '2026-07-14T12:30:00.000Z',
  visibility: 'unlisted',
  capacity: 500,
  minimumAge: null,
};
const eventSnapshotSha256 = agentSha256(projection);
const eventAction = {
  id: `act_${'e'.repeat(48)}`,
  ...base,
  kind: 'event.read',
  autonomy: 'read',
  target: { ...target, apiOperation: 'events.get' },
  payload: { eventSnapshotSha256 },
  idempotencyKey: 'agent.conformance.packed.event.read',
  preparedAt: '2026-07-14T11:58:00.000Z',
};
const readinessAction = {
  id: `act_${'r'.repeat(48)}`,
  ...base,
  kind: 'readiness.read',
  autonomy: 'read',
  target: { ...target, apiOperation: 'events.readiness.get' },
  payload: { readinessSnapshotSha256: 'f'.repeat(64) },
  idempotencyKey: 'agent.conformance.packed.readiness',
  preparedAt: '2026-07-14T11:59:00.000Z',
};
const publishAction = {
  id: actionId,
  ...base,
  kind: 'event.publish',
  autonomy: 'execute_with_approval',
  target: { ...target, apiOperation: 'events.publish' },
  payload: { readinessSnapshotSha256: 'f'.repeat(64) },
  idempotencyKey: 'agent.conformance.packed.prepare',
  preparedAt: '2026-07-14T12:00:00.000Z',
};
const actionDigest = agentSha256(publishAction);
let planSha256 = '';
let eventCalls = 0;
const response = (status, body) => ({
  status,
  headers: { 'cache-control': 'no-store', 'content-type': 'application/json' },
  body,
});
const execute = async (request) => {
  if (request.path === '/v1/oauth/token')
    return response(200, {
      access_token: 'agent_access_token',
      token_type: 'Bearer',
      expires_in: 600,
      scope: 'agent.invoke',
    });
  if (request.path === '/v1/agent/session')
    return response(200, {
      principal: { id: 'agent_primary', sponsorPrincipalId: 'sponsor_primary' },
      authentication: { grantType: 'client_credentials' },
      delegationRequired: true,
    });
  if (request.path === '/v1/agent/events') {
    eventCalls += 1;
    const result = {
      resourceId: 'event_primary',
      resourceVersion: 7,
      eventSnapshotSha256,
      observedAt:
        mutation === 'replay' && eventCalls === 2
          ? '2026-07-14T11:58:01.000Z'
          : '2026-07-14T11:58:00.000Z',
      event:
        mutation === 'projection'
          ? { ...projection, title: 'Substituted event content' }
          : projection,
      untrustedContentPaths:
        mutation === 'untrusted_paths'
          ? ['event.description', 'event.title']
          : ['event.title', 'event.description'],
    };
    return response(201, {
      action: eventAction,
      actionDigest: agentSha256(eventAction),
      expiresAt: '2026-07-14T12:08:00.000Z',
      authorization: { allowed: true },
      result,
      resultSha256: mutation === 'result_digest' ? '0'.repeat(64) : agentSha256(result),
    });
  }
  if (request.path === '/v1/agent/readiness') {
    const result = {
      resourceId: 'event_primary',
      resourceVersion: 7,
      status: 'ready',
      readinessSnapshotSha256: 'f'.repeat(64),
      generatedAt: '2026-07-14T11:59:00.000Z',
      published: false,
      blockerReasonCodes: [],
      warningReasonCodes: [],
    };
    return response(201, {
      action: readinessAction,
      actionDigest: agentSha256(readinessAction),
      expiresAt: '2026-07-14T12:09:00.000Z',
      authorization: { allowed: true },
      dryRun: {
        launchable: true,
        readinessSnapshotSha256: 'f'.repeat(64),
        blockingReasonCodes: [],
      },
      result,
      resultSha256: agentSha256(result),
    });
  }
  if (request.path === '/v1/agent/actions')
    return response(201, {
      action: publishAction,
      actionDigest,
      expiresAt: '2026-07-14T12:10:00.000Z',
      dryRun: {
        launchable: true,
        readinessSnapshotSha256: 'f'.repeat(64),
        blockingReasonCodes: [],
      },
    });
  if (request.path === '/v1/agent/plans' && request.method === 'POST') {
    const definition = request.body.definition;
    planSha256 = definition.planSha256;
    return response(201, {
      definition,
      state: { status: 'prepared', stateVersion: 1 },
      actionBindings: [{ stepId: 'publish_event', actionId }],
    });
  }
  if (request.path.endsWith('/transitions')) {
    const status = request.body.status;
    return response(200, {
      state: { status, stateVersion: status === 'awaiting_approval' ? 2 : 3 },
    });
  }
  if (request.path.endsWith('/approvals'))
    return response(201, {
      id: approvalId,
      tenantId: target.tenantId,
      actionDigest,
      planSha256,
      approverPrincipalId: base.sponsorPrincipalId,
      approverPermissionSnapshot: ['events:publish'],
      policyVersion: 3,
      approvedAt: '2026-07-14T12:01:00.000Z',
      expiresAt: '2026-07-14T12:04:00.000Z',
    });
  if (request.path.endsWith('/executions'))
    return response(200, {
      id: executionId,
      state: 'succeeded',
      planSha256,
      actionId,
      actionDigest,
      approvalId,
      ...base,
      result: { resourceId: 'event_primary', resourceVersion: 8, status: 'published' },
    });
  if (request.path.endsWith(`/${executionId}`)) {
    const binding = {
      planSha256,
      actionId,
      actionDigest,
      approvalId,
      agentPrincipalId: base.agentPrincipalId,
      sponsorPrincipalId: base.sponsorPrincipalId,
      delegationGrantId: base.delegationGrantId,
    };
    return response(200, {
      execution: { id: executionId, ...binding },
      audit: ['prepared', 'authorized', 'started', 'succeeded'].map((phase) => ({
        phase,
        ...binding,
      })),
    });
  }
  return response(404, {});
};

const result = await runAgentPlatformContract({
  apiVersion: '2026-07-30',
  sponsorAccessToken: 'sponsor_token',
  agentClientId: `tk_agent_${'e'.repeat(48)}`,
  agentClientSecret: 'secret_value',
  delegationGrantId: base.delegationGrantId,
  resourceId: target.resourceId,
  planId: 'plan_conformance_packed',
  idempotencyPrefix: 'agent.conformance.packed',
  execute,
});
process.stdout.write(JSON.stringify({ result, eventCalls }));
