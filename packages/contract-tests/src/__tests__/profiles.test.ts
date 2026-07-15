import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { EMBED_LIFECYCLE_NAMES } from '@tixkit/embed-core';
import { agentSha256 } from '@tixkit/agent-protocol';
import {
  testEmbedHostContract,
  testSdkConsumerContract,
  testWebhookConsumerContract,
  runWebhookConsumerContract,
  runSdkApiConsumerContract,
  runAgentPlatformContract,
} from '../index.js';

describe('third-party contract profiles', () => {
  it('accepts a pinned SRI embed with strict CSP, fallback, and complete lifecycle coverage', () => {
    const artifact = new TextEncoder().encode('widget artifact');
    const sri = `sha384-${createHash('sha384').update(artifact).digest('base64')}`;
    const source = {} as MessageEventSource;
    expect(
      testEmbedHostContract({
        html: `<script src="https://cdn.example/v1.2.3/widget.js" integrity="${sri}" crossorigin="anonymous"></script><a href="https://checkout.example/event" aria-label="Open secure checkout">Checkout</a>`,
        csp: "default-src 'none'; script-src https://cdn.example; connect-src https://checkout.example; frame-src https://checkout.example",
        expectedOrigin: 'https://checkout.example',
        lifecycleEvents: EMBED_LIFECYCLE_NAMES.map((name) => `tixkit:v1:${name}`),
        // eslint-disable-next-line oxc/no-map-spread -- Each discriminated lifecycle fixture requires its own immutable shape.
        lifecycleDetails: EMBED_LIFECYCLE_NAMES.map((name) => ({
          contractVersion: '1.0',
          name,
          widgetId: 'widget_1',
          eventId: 'evt_1',
          mode: 'inline',
          timestamp: '2026-07-10T12:00:00.000Z',
          ...(name === 'closed' ? { reason: 'buyer' } : {}),
          ...(name === 'checkout-session-created' ? { sessionId: 'cs_1' } : {}),
          ...(name === 'order-completed' ? { orderId: 'ord_1' } : {}),
          ...(name === 'recoverable-error' || name === 'fatal-error'
            ? {
                errorCode: 'internal-error',
                message: 'Safe error',
                retryable: name === 'recoverable-error',
              }
            : {}),
        })),
        artifact,
        sri,
        fallbackAccessibleName: 'Open secure checkout',
        messageEvents: [
          {
            event: {
              origin: 'https://checkout.example',
              source,
              data: {
                source: 'tixkit-checkout',
                type: 'checkout:ready',
                contractVersion: '1.0',
                widgetId: 'widget_1',
                eventId: 'evt_1',
                nonce: '0123456789abcdef0123456789abcdef',
              },
            } as MessageEvent,
            expectation: {
              origin: 'https://checkout.example',
              source,
              widgetId: 'widget_1',
              eventId: 'evt_1',
              nonce: '0123456789abcdef0123456789abcdef',
            },
            valid: true,
          },
          ...[
            { origin: 'https://attacker.example' },
            { source: {} as MessageEventSource },
            { data: { widgetId: 'widget_2' } },
            { data: { nonce: 'fedcba9876543210fedcba9876543210' } },
            { data: { contractVersion: '2.0' } },
          ].map((override) => ({
            event: {
              origin: 'https://checkout.example',
              source,
              data: {
                source: 'tixkit-checkout',
                type: 'checkout:ready',
                contractVersion: '1.0',
                widgetId: 'widget_1',
                eventId: 'evt_1',
                nonce: '0123456789abcdef0123456789abcdef',
                ...override.data,
              },
              ...override,
            } as MessageEvent,
            expectation: {
              origin: 'https://checkout.example',
              source,
              widgetId: 'widget_1',
              eventId: 'evt_1',
              nonce: '0123456789abcdef0123456789abcdef',
            },
            valid: false,
          })),
        ],
      }).ok,
    ).toBe(true);
  });

  it('detects strict-CSP, SRI, fallback, and lifecycle host failures', () => {
    const output = testEmbedHostContract({
      html: '<script src="https://cdn.example/latest/widget.js"></script>',
      csp: "script-src 'unsafe-inline'; connect-src https://checkout.example.evil; img-src https://checkout.example",
      expectedOrigin: 'https://checkout.example',
      lifecycleEvents: [],
      lifecycleDetails: [],
      artifact: new Uint8Array(),
      sri: 'sha384-invalid',
      fallbackAccessibleName: '',
      messageEvents: [],
    });
    expect(output.ok).toBe(false);
    expect(output.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining([
        'EMBED_VERSION_UNPINNED',
        'EMBED_SRI_MISSING',
        'EMBED_FALLBACK_MISSING',
        'EMBED_CSP_BROAD',
        'EMBED_ORIGIN_MISSING',
        'EMBED_LIFECYCLE_MISSING',
      ]),
    );
  });

  it('verifies case-insensitive signed headers and executes idempotent duplicate handling', async () => {
    const secret = 'whsec_contract_fixture';
    const newer = JSON.stringify({
      type: 'test.ping',
      test: true,
      apiVersion: '2026-01-01',
      createdAt: '2026-07-10T12:01:00.000Z',
      data: { endpointId: 'wh_1' },
    });
    const older = JSON.stringify({
      type: 'test.ping',
      test: true,
      apiVersion: '2026-01-01',
      createdAt: '2026-07-10T12:00:00.000Z',
      data: { endpointId: 'wh_1' },
    });
    const signature = (timestamp: number, body: string) =>
      `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
    const inputDeliveries = [
      {
        headers: {
          'X-Tixkit-Signature': signature(200, newer),
          'X-Tixkit-Delivery': 'd_1',
          'X-Tixkit-Event-ID': 'whe_new',
        },
        body: newer,
        receivedAtMs: 200_000,
        ordering: { key: 'order:ord_1', version: 2 },
      },
      {
        headers: {
          'X-Tixkit-Signature': signature(100, older),
          'X-Tixkit-Delivery': 'd_3',
          'X-Tixkit-Event-ID': 'whe_other_order',
        },
        body: older,
        receivedAtMs: 100_000,
        ordering: { key: 'order:ord_2', version: 1 },
      },
      {
        headers: {
          'X-Tixkit-Signature': signature(100, older),
          'X-Tixkit-Delivery': 'd_2',
          'X-Tixkit-Event-ID': 'whe_old',
        },
        body: older,
        receivedAtMs: 100_000,
        ordering: { key: 'order:ord_1', version: 1 },
      },
      {
        headers: {
          'X-Tixkit-Signature': signature(200, newer),
          'X-Tixkit-Delivery': 'd_1',
          'X-Tixkit-Event-ID': 'whe_new',
        },
        body: newer,
        receivedAtMs: 200_000,
        ordering: { key: 'order:ord_1', version: 2 },
      },
    ];
    const output = testWebhookConsumerContract({
      secret,
      deliveries: inputDeliveries,
    });
    expect(output.ok).toBe(true);
    const processed = new Set<string>();
    const executed = await runWebhookConsumerContract({
      secret,
      deliveries: inputDeliveries,
      consume: async (delivery) => {
        const id = delivery.headers['X-Tixkit-Delivery']!;
        const duplicate = processed.has(id);
        processed.add(id);
        return {
          acknowledged: true,
          duplicate,
          applied: (id === 'd_1' || id === 'd_3') && !duplicate,
          sideEffectId: `effect:${id}`,
        };
      },
    });
    expect(executed.ok).toBe(true);
  });

  it('checks API version, operation parity, uniqueness, and error envelopes', () => {
    expect(
      testSdkConsumerContract({
        apiVersion: '2026-01-01',
        expectedApiVersion: '2026-01-01',
        operationIds: ['getEvents', 'postCheckout'],
        requiredOperationIds: ['getEvents'],
        errorSamples: [{ error: { code: 'NOT_FOUND', message: 'Not found', requestId: 'req_1' } }],
      }).ok,
    ).toBe(true);
    expect(
      testSdkConsumerContract({
        apiVersion: 'old',
        expectedApiVersion: '2026-01-01',
        operationIds: ['getEvents', 'getEvents'],
        requiredOperationIds: ['postCheckout'],
        errorSamples: [{}],
      }).findings.map((finding) => finding.code),
    ).toEqual([
      'SDK_API_VERSION',
      'SDK_OPERATION_DUPLICATE',
      'SDK_OPERATION_MISSING',
      'SDK_ERROR_SCHEMA',
    ]);
  });

  it('executes the SDK/API synthetic-delivery operation with auth and version headers', async () => {
    const executed = vi.fn(async (request) => ({
      status: 202,
      headers: { 'Content-Type': 'application/json' },
      body: { queued: true, test: true, eventId: 'whe_test', endpointId: 'wh_1' },
      request,
    }));
    const output = await runSdkApiConsumerContract({
      apiVersion: '2026-01-01',
      apiKey: 'tk_sandbox',
      endpointId: 'wh_1',
      execute: executed,
    });
    expect(output.ok).toBe(true);
    expect(executed).toHaveBeenCalledWith({
      method: 'POST',
      path: '/v1/webhook-endpoints/wh_1/test',
      headers: {
        authorization: 'Bearer tk_sandbox',
        accept: 'application/json',
        'X-Tixkit-Version': '2026-01-01',
      },
    });
  });

  it('executes the sponsor-approved plan-bound agent platform golden path', async () => {
    const actionId = `act_${'a'.repeat(48)}`;
    const approvalId = `apr_${'b'.repeat(48)}`;
    const executionId = `exec_${'c'.repeat(48)}`;
    const action = {
      id: actionId,
      protocolVersion: '2026-07-22' as const,
      agentPrincipalId: 'agent_primary',
      sponsorPrincipalId: 'sponsor_primary',
      delegationGrantId: 'delegation_primary',
      kind: 'event.publish' as const,
      autonomy: 'execute_with_approval' as const,
      target: {
        tenantId: 'tenant_primary',
        resourceType: 'event',
        resourceId: 'event_primary',
        resourceVersion: 7,
        apiOperation: 'events.publish',
      },
      payload: { readinessSnapshotSha256: 'f'.repeat(64) },
      idempotencyKey: 'agent.conformance.0001.prepare',
      expectedPolicyVersion: 3,
      preparedAt: '2026-07-14T12:00:00.000Z',
    };
    const actionDigest = agentSha256(action);
    const readinessAction = {
      id: `act_${'r'.repeat(48)}`,
      protocolVersion: '2026-07-22' as const,
      agentPrincipalId: 'agent_primary',
      sponsorPrincipalId: 'sponsor_primary',
      delegationGrantId: 'delegation_primary',
      kind: 'readiness.read' as const,
      autonomy: 'read' as const,
      target: {
        tenantId: 'tenant_primary',
        resourceType: 'event',
        resourceId: 'event_primary',
        resourceVersion: 7,
        apiOperation: 'events.readiness.get',
      },
      payload: { readinessSnapshotSha256: 'f'.repeat(64) },
      idempotencyKey: 'agent.conformance.0001.readiness',
      expectedPolicyVersion: 3,
      preparedAt: '2026-07-14T11:59:00.000Z',
    };
    const readinessResult = {
      resourceId: 'event_primary',
      resourceVersion: 7,
      status: 'ready' as const,
      readinessSnapshotSha256: 'f'.repeat(64),
      generatedAt: '2026-07-14T11:59:00.000Z',
      published: false,
      blockerReasonCodes: [],
      warningReasonCodes: [],
    };
    let planSha256 = '';
    let substituteApprovalDigest = false;
    let substituteApprovalIdentity = false;
    let substituteApprovalPermission = false;
    let substituteApprovalTime = false;
    let rejectAwaitingTransition = false;
    let returnMalformedAction = false;
    let readinessMutation:
      | 'agent'
      | 'sponsor'
      | 'delegation'
      | 'resource'
      | 'result_shape'
      | 'action_digest'
      | 'result_digest'
      | 'replay';
    let readinessCall = 0;
    const requests: Array<{ path: string; body?: unknown; headers: Record<string, string> }> = [];
    const contractInput = {
      apiVersion: '2026-07-29',
      sponsorAccessToken: 'sponsor_token',
      agentClientId: `tk_agent_${'e'.repeat(48)}`,
      agentClientSecret: 'secret_value',
      delegationGrantId: 'delegation_primary',
      resourceId: 'event_primary',
      planId: 'plan_conformance_primary',
      idempotencyPrefix: 'agent.conformance.0001',
      execute: async (request) => {
        requests.push(request);
        const response = (status: number, body: unknown) => ({
          status,
          headers: { 'cache-control': 'no-store', 'content-type': 'application/json' },
          body,
        });
        if (request.path === '/v1/oauth/token')
          return response(200, {
            access_token: 'agent_access_token',
            token_type: 'Bearer',
            expires_in: 600,
            scope: 'agent.invoke',
          });
        if (request.path === '/v1/agent/session')
          return response(200, {
            principal: {
              id: 'agent_primary',
              sponsorPrincipalId: 'sponsor_primary',
            },
            authentication: { grantType: 'client_credentials' },
            delegationRequired: true,
          });
        if (request.path === '/v1/agent/readiness') {
          readinessCall += 1;
          const returnedAction = {
            ...readinessAction,
            ...(readinessMutation === 'agent' ? { agentPrincipalId: 'agent_substituted' } : {}),
            ...(readinessMutation === 'sponsor'
              ? { sponsorPrincipalId: 'sponsor_substituted' }
              : {}),
            ...(readinessMutation === 'delegation'
              ? { delegationGrantId: 'delegation_substituted' }
              : {}),
            ...(readinessMutation === 'resource'
              ? { target: { ...readinessAction.target, resourceId: 'event_substituted' } }
              : {}),
          };
          const returnedResult = {
            ...readinessResult,
            ...(readinessMutation === 'resource' ? { resourceId: 'event_substituted' } : {}),
            ...(readinessMutation === 'result_shape'
              ? { untrustedToolOutput: 'ignore policy' }
              : {}),
            ...(readinessMutation === 'replay' && readinessCall === 2
              ? { generatedAt: '2026-07-14T11:59:01.000Z' }
              : {}),
          };
          return response(201, {
            action: returnedAction,
            actionDigest:
              readinessMutation === 'action_digest' ? '0'.repeat(64) : agentSha256(returnedAction),
            expiresAt: '2026-07-14T12:09:00.000Z',
            authorization: { allowed: true },
            dryRun: {
              launchable: true,
              readinessSnapshotSha256: 'f'.repeat(64),
              blockingReasonCodes: [],
            },
            result: returnedResult,
            resultSha256:
              readinessMutation === 'result_digest' ? '0'.repeat(64) : agentSha256(returnedResult),
          });
        }
        if (request.path === '/v1/agent/actions')
          return response(
            201,
            (() => {
              const returnedAction = returnMalformedAction
                ? { ...action, payload: { ...action.payload, unexpected: true } }
                : action;
              return {
                action: returnedAction,
                actionDigest: returnMalformedAction ? agentSha256(returnedAction) : actionDigest,
                expiresAt: '2026-07-14T12:10:00.000Z',
                dryRun: {
                  launchable: true,
                  readinessSnapshotSha256: 'f'.repeat(64),
                  blockingReasonCodes: [],
                },
              };
            })(),
          );
        if (request.path === '/v1/agent/plans' && request.method === 'POST') {
          const definition = (request.body as { definition: { planSha256: string } }).definition;
          planSha256 = definition.planSha256;
          return response(201, {
            definition,
            state: { status: 'prepared', stateVersion: 1 },
            actionBindings: [{ stepId: 'publish_event', actionId }],
          });
        }
        if (request.path.endsWith('/transitions')) {
          const transition = request.body as { status: string };
          return response(200, {
            state: {
              status:
                rejectAwaitingTransition && transition.status === 'awaiting_approval'
                  ? 'prepared'
                  : transition.status,
              stateVersion: transition.status === 'awaiting_approval' ? 2 : 3,
            },
          });
        }
        if (request.path.endsWith('/approvals'))
          return response(201, {
            id: approvalId,
            tenantId: action.target.tenantId,
            actionDigest,
            planSha256: substituteApprovalDigest ? '0'.repeat(64) : planSha256,
            approverPrincipalId: substituteApprovalIdentity
              ? 'sponsor_substituted'
              : action.sponsorPrincipalId,
            approverPermissionSnapshot: [
              substituteApprovalPermission ? 'events.write' : 'events:publish',
            ],
            policyVersion: action.expectedPolicyVersion,
            approvedAt: '2026-07-14T12:01:00.000Z',
            expiresAt: substituteApprovalTime
              ? '2026-07-14T12:09:00.000Z'
              : '2026-07-14T12:04:00.000Z',
          });
        if (request.path.endsWith('/executions'))
          return response(200, {
            id: executionId,
            state: 'succeeded',
            planSha256,
            actionId,
            actionDigest,
            approvalId,
            agentPrincipalId: action.agentPrincipalId,
            sponsorPrincipalId: action.sponsorPrincipalId,
            delegationGrantId: action.delegationGrantId,
            result: { resourceId: 'event_primary', resourceVersion: 8, status: 'published' },
          });
        if (request.path.endsWith(`/${executionId}`))
          return response(200, {
            execution: {
              id: executionId,
              planSha256,
              actionId,
              actionDigest,
              approvalId,
              agentPrincipalId: action.agentPrincipalId,
              sponsorPrincipalId: action.sponsorPrincipalId,
              delegationGrantId: action.delegationGrantId,
            },
            audit: ['prepared', 'authorized', 'started', 'succeeded'].map((phase) => ({
              phase,
              planSha256,
              actionId,
              actionDigest,
              approvalId,
              agentPrincipalId: action.agentPrincipalId,
              sponsorPrincipalId: action.sponsorPrincipalId,
              delegationGrantId: action.delegationGrantId,
            })),
          });
        return response(404, {});
      },
    } as const;
    const output = await runAgentPlatformContract(contractInput);
    expect(output).toEqual({ ok: true, findings: [] });
    expect(requests.filter((request) => request.path === '/v1/agent/readiness')).toHaveLength(2);
    const approvalRequest = requests.find((request) => request.path.endsWith('/approvals'))!;
    expect(approvalRequest.body).toEqual({ actionDigest, planSha256 });
    expect(approvalRequest.headers['X-Tixkit-Confirmation']).toBe(
      `approve:${actionId}:${actionDigest}:${planSha256}`,
    );
    const executionRequest = requests.find((request) => request.path.endsWith('/executions'))!;
    expect(executionRequest.body).toEqual({ approvalId, actionDigest });
    expect(executionRequest.body).not.toHaveProperty('planSha256');

    for (const mutation of [
      'agent',
      'sponsor',
      'delegation',
      'resource',
      'result_shape',
      'action_digest',
      'result_digest',
      'replay',
    ] as const) {
      readinessMutation = mutation;
      readinessCall = 0;
      const publishRequestsBeforeMalformedReadiness = requests.filter(
        (request) =>
          request.path === '/v1/agent/actions' &&
          (request.body as { kind?: string })?.kind === 'event.publish',
      ).length;
      const malformedReadiness = await runAgentPlatformContract(contractInput);
      expect(
        malformedReadiness.findings.map((finding) => finding.code),
        mutation,
      ).toContain('AGENT_PLATFORM_READINESS_SCHEMA');
      expect(
        requests.filter(
          (request) =>
            request.path === '/v1/agent/actions' &&
            (request.body as { kind?: string })?.kind === 'event.publish',
        ),
        mutation,
      ).toHaveLength(publishRequestsBeforeMalformedReadiness);
    }
    readinessMutation = undefined;

    substituteApprovalDigest = true;
    const substituted = await runAgentPlatformContract(contractInput);
    expect(substituted.ok).toBe(false);
    expect(substituted.findings.map((finding) => finding.code)).toContain(
      'AGENT_PLATFORM_APPROVAL_SCHEMA',
    );

    substituteApprovalDigest = false;
    rejectAwaitingTransition = true;
    const approvalRequestsBefore = requests.filter((request) =>
      request.path.endsWith('/approvals'),
    ).length;
    const invalidTransition = await runAgentPlatformContract(contractInput);
    expect(invalidTransition.findings.map((finding) => finding.code)).toContain(
      'AGENT_PLATFORM_PLAN_STATE',
    );
    expect(requests.filter((request) => request.path.endsWith('/approvals'))).toHaveLength(
      approvalRequestsBefore,
    );

    rejectAwaitingTransition = false;
    substituteApprovalIdentity = true;
    const executionRequestsBefore = requests.filter((request) =>
      request.path.endsWith('/executions'),
    ).length;
    const substitutedIdentity = await runAgentPlatformContract(contractInput);
    expect(substitutedIdentity.findings.map((finding) => finding.code)).toContain(
      'AGENT_PLATFORM_APPROVAL_SCHEMA',
    );
    expect(requests.filter((request) => request.path.endsWith('/executions'))).toHaveLength(
      executionRequestsBefore,
    );

    substituteApprovalIdentity = false;
    substituteApprovalPermission = true;
    const invalidPermission = await runAgentPlatformContract(contractInput);
    expect(invalidPermission.findings.map((finding) => finding.code)).toContain(
      'AGENT_PLATFORM_APPROVAL_SCHEMA',
    );
    expect(requests.filter((request) => request.path.endsWith('/executions'))).toHaveLength(
      executionRequestsBefore,
    );

    substituteApprovalPermission = false;
    substituteApprovalTime = true;
    const invalidApprovalTime = await runAgentPlatformContract(contractInput);
    expect(invalidApprovalTime.findings.map((finding) => finding.code)).toContain(
      'AGENT_PLATFORM_APPROVAL_SCHEMA',
    );
    expect(requests.filter((request) => request.path.endsWith('/executions'))).toHaveLength(
      executionRequestsBefore,
    );

    substituteApprovalTime = false;
    returnMalformedAction = true;
    const approvalRequestsBeforeMalformedAction = requests.filter((request) =>
      request.path.endsWith('/approvals'),
    ).length;
    const malformedAction = await runAgentPlatformContract(contractInput);
    expect(malformedAction.findings.map((finding) => finding.code)).toContain(
      'AGENT_PLATFORM_PREPARE_SCHEMA',
    );
    expect(requests.filter((request) => request.path.endsWith('/approvals'))).toHaveLength(
      approvalRequestsBeforeMalformedAction,
    );
  });

  it('rejects malformed agent-platform input before sending credentials', async () => {
    const executed = vi.fn();
    const output = await runAgentPlatformContract({
      apiVersion: 'latest',
      sponsorAccessToken: 'sponsor_token',
      agentClientId: 'agent_client',
      agentClientSecret: 'agent_secret',
      delegationGrantId: 'delegation_primary',
      resourceId: 'event_primary',
      planId: '../invalid',
      idempotencyPrefix: 'short',
      execute: executed,
    });
    expect(output.findings.map((finding) => finding.code)).toEqual(['AGENT_PLATFORM_INPUT']);
    expect(executed).not.toHaveBeenCalled();
  });
});
