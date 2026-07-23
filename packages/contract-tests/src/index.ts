import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  EMBED_LIFECYCLE_NAMES,
  isEmbedLifecycleDetail,
  validateCheckoutMessageEvent,
  type EmbedMessageExpectation,
} from '@tixkit/embed-core';
import {
  AGENT_PLATFORM_PROTOCOL_VERSION,
  AGENT_PROTOCOL_VERSION,
  agentActionDigest,
  agentSha256,
  buildAgentPlanDefinition,
  validateAgentActionResultForAction,
  validateAgentCampaignPrepareResult,
  validateAgentContentPrepareResult,
  validateAgentEventReadResult,
  validateAgentEventPrepareResult,
  validateAgentEventUpdatePreview,
  validateAgentPrincipal,
  validateAgentReportReadResult,
  validateAgentReadinessReadResult,
  type AgentAction,
  type AgentActionResult,
  type AgentApproval,
  type AgentCampaignPrepareResult,
  type AgentContentPrepareResult,
  type AgentExecution,
  type AgentEventReadResult,
  type AgentEventPrepareResult,
  type AgentEventUpdatePreview,
  type AgentReportReadResult,
  type AgentReadinessReadResult,
  type AgentPrincipal,
} from '@tixkit/agent-protocol';

export type ContractFinding = { code: string; message: string; path?: string };
export type ContractResult = { ok: boolean; findings: ContractFinding[] };
export const AGENT_PLATFORM_CONTRACT_API_VERSION = '2026-09-03' as const;
export type AgentPlatformConformanceTarget = 'platform-api' | 'self-hosted';
export type AgentPlatformContractEvidence = {
  profile: 'agent-platform';
  conformanceTarget: AgentPlatformConformanceTarget;
  apiVersion: typeof AGENT_PLATFORM_CONTRACT_API_VERSION;
  agentProtocolVersion: typeof AGENT_PROTOCOL_VERSION;
  agentPlatformProtocolVersion: typeof AGENT_PLATFORM_PROTOCOL_VERSION;
  principalKind: 'third_party' | 'self_hosted';
};
export type AgentPlatformContractResult = ContractResult & {
  evidence?: AgentPlatformContractEvidence;
};

export type AgentPlatformContractRequest = {
  method: 'GET' | 'POST';
  path: string;
  headers: Record<string, string>;
  body?: unknown;
};

export type AgentPlatformContractResponse = {
  status: number;
  headers: Record<string, string | undefined>;
  body: unknown;
};

export interface AgentPlatformContractInput {
  conformanceTarget: AgentPlatformConformanceTarget;
  apiVersion: string;
  sponsorAccessToken: string;
  agentClientId: string;
  agentClientSecret: string;
  delegationGrantId: string;
  resourceId: string;
  campaignEmailTemplateKey: string;
  planId: string;
  idempotencyPrefix: string;
  execute(request: AgentPlatformContractRequest): Promise<AgentPlatformContractResponse>;
}

function result(findings: ContractFinding[]): ContractResult {
  return { ok: findings.length === 0, findings };
}

export function testEmbedHostContract(input: {
  html: string;
  csp: string;
  expectedOrigin: string;
  lifecycleEvents: readonly string[];
  lifecycleDetails: readonly unknown[];
  artifact: Uint8Array;
  sri: string;
  fallbackAccessibleName: string;
  messageEvents: readonly {
    event: MessageEvent;
    expectation: EmbedMessageExpectation;
    valid: boolean;
  }[];
}): ContractResult {
  const findings: ContractFinding[] = [];
  const widgetScript =
    /<script\b([^>]*\bsrc\s*=\s*(["'])[^"']+\/v\d+\.\d+\.\d+\/[^"']*\2[^>]*)>/iu.exec(
      input.html,
    )?.[1];
  if (!widgetScript)
    findings.push({
      code: 'EMBED_VERSION_UNPINNED',
      message: 'Widget script must use a pinned version.',
    });
  const actualSri = `sha384-${createHash('sha384').update(input.artifact).digest('base64')}`;
  if (
    input.sri !== actualSri ||
    !widgetScript ||
    !new RegExp(
      `\\bintegrity\\s*=\\s*["']${actualSri.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}["']`,
      'u',
    ).test(widgetScript) ||
    !/\bcrossorigin\s*=\s*(["'])anonymous\1/iu.test(widgetScript)
  )
    findings.push({
      code: 'EMBED_SRI_MISSING',
      message: 'Widget script must include SHA-384 SRI.',
    });
  const fallback = findCheckoutFallback(input.html, input.expectedOrigin);
  if (!fallback)
    findings.push({
      code: 'EMBED_FALLBACK_MISSING',
      message: 'Host must include a checkout fallback link.',
    });
  if (/unsafe-inline|connect-src[^;]*\shttps:(?:\s|;|$)/u.test(input.csp))
    findings.push({
      code: 'EMBED_CSP_BROAD',
      message: 'CSP contains a broad or inline allowance.',
    });
  const directives = parseCsp(input.csp);
  if (
    !directives.get('connect-src')?.includes(input.expectedOrigin) ||
    !directives.get('frame-src')?.includes(input.expectedOrigin)
  )
    findings.push({
      code: 'EMBED_ORIGIN_MISSING',
      message: 'CSP must name the selected checkout origin.',
    });
  if (!fallback?.accessibleName || fallback.accessibleName !== input.fallbackAccessibleName.trim())
    findings.push({
      code: 'EMBED_FALLBACK_ACCESSIBLE_NAME',
      message: 'Fallback link needs an accessible name.',
    });
  for (const name of EMBED_LIFECYCLE_NAMES) {
    if (!input.lifecycleEvents.includes(`tixkit:v1:${name}`))
      findings.push({
        code: 'EMBED_LIFECYCLE_MISSING',
        message: `Missing lifecycle event ${name}.`,
      });
    const detail = input.lifecycleDetails.find(
      (candidate) =>
        Boolean(candidate) &&
        typeof candidate === 'object' &&
        (candidate as { name?: unknown }).name === name,
    ) as Record<string, unknown> | undefined;
    if (!isEmbedLifecycleDetail(detail) || detail.name !== name)
      findings.push({
        code: 'EMBED_LIFECYCLE_SCHEMA',
        message: `Lifecycle payload ${name} does not match contract v1.`,
      });
  }
  for (const [index, captured] of input.messageEvents.entries()) {
    const validation = validateCheckoutMessageEvent(captured.event, captured.expectation);
    if (validation.ok !== captured.valid)
      findings.push({
        code: 'EMBED_MESSAGE_VALIDATION',
        message: 'Origin/source/widget/nonce validation mismatch.',
        path: `${index}`,
      });
  }
  const canonical = input.messageEvents.find((captured) => captured.valid);
  if (!canonical) {
    findings.push({
      code: 'EMBED_MESSAGE_POSITIVE_MISSING',
      message: 'A valid checkout message fixture is required.',
    });
  } else {
    const mutations: MessageEvent[] = [
      { ...canonical.event, origin: 'https://invalid.example' } as MessageEvent,
      {
        ...canonical.event,
        source: {} as MessageEvent['source'],
      } as MessageEvent,
      {
        ...canonical.event,
        data: {
          ...(canonical.event.data as object),
          widgetId: '__invalid_widget__',
        },
      } as MessageEvent,
      {
        ...canonical.event,
        data: {
          ...(canonical.event.data as object),
          nonce: '__invalid_nonce__',
        },
      } as MessageEvent,
      {
        ...canonical.event,
        data: { ...(canonical.event.data as object), contractVersion: '999.0' },
      } as MessageEvent,
    ];
    if (mutations.some((event) => validateCheckoutMessageEvent(event, canonical.expectation).ok))
      findings.push({
        code: 'EMBED_MESSAGE_FAIL_CLOSED',
        message: 'Origin, source, widget, nonce, and version mutations must fail closed.',
      });
  }
  return result(findings);
}

function parseCsp(csp: string): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const raw of csp.split(';')) {
    const [name, ...tokens] = raw.trim().split(/\s+/u);
    if (name) directives.set(name.toLowerCase(), tokens);
  }
  return directives;
}

function findCheckoutFallback(
  html: string,
  expectedOrigin: string,
): { accessibleName: string } | undefined {
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/giu)) {
    const attributes = match[1] ?? '';
    const href = /\bhref\s*=\s*(["'])(.*?)\1/iu.exec(attributes)?.[2];
    if (!href) continue;
    try {
      if (new URL(href).origin !== expectedOrigin) continue;
    } catch {
      continue;
    }
    if (/\b(?:hidden|aria-hidden\s*=\s*(["'])true\1)/iu.test(attributes)) continue;
    if (/\btabindex\s*=\s*(["'])-1\1/iu.test(attributes)) continue;
    const label = /\baria-label\s*=\s*(["'])(.*?)\1/iu.exec(attributes)?.[2]?.trim();
    const text = (match[2] ?? '').replace(/<[^>]*>/gu, '').trim();
    return { accessibleName: label || text };
  }
  return undefined;
}

export type CapturedWebhookDelivery = {
  headers: Record<string, string | undefined>;
  body: string;
  receivedAtMs: number;
  ordering?: { key: string; version: number };
};

export function testWebhookConsumerContract(input: {
  secret: string;
  deliveries: readonly CapturedWebhookDelivery[];
  toleranceMs?: number;
}): ContractResult {
  const findings: ContractFinding[] = [];
  for (const [index, delivery] of input.deliveries.entries()) {
    const headers = Object.fromEntries(
      Object.entries(delivery.headers).map(([key, value]) => [key.toLowerCase(), value]),
    );
    const signature = headers['x-tixkit-signature'] ?? '';
    const match = /^t=(\d+),v1=([a-f0-9]{64})$/u.exec(signature);
    if (!match) {
      findings.push({
        code: 'WEBHOOK_SIGNATURE_FORMAT',
        message: 'Signature format is invalid.',
        path: `${index}`,
      });
      continue;
    }
    const timestamp = Number(match[1]);
    const expected = createHmac('sha256', input.secret)
      .update(`${timestamp}.${delivery.body}`)
      .digest();
    const actual = Buffer.from(match[2], 'hex');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      findings.push({
        code: 'WEBHOOK_SIGNATURE_INVALID',
        message: 'Signature verification failed.',
        path: `${index}`,
      });
    if (Math.abs(delivery.receivedAtMs - timestamp * 1000) > (input.toleranceMs ?? 300_000))
      findings.push({
        code: 'WEBHOOK_TIMESTAMP_STALE',
        message: 'Delivery timestamp is outside tolerance.',
        path: `${index}`,
      });
    if (!headers['x-tixkit-delivery'])
      findings.push({
        code: 'WEBHOOK_DELIVERY_ID',
        message: 'Delivery ID is missing.',
        path: `${index}`,
      });
  }
  return result(findings);
}

export async function runWebhookConsumerContract(input: {
  secret: string;
  deliveries: readonly CapturedWebhookDelivery[];
  consume: (delivery: CapturedWebhookDelivery) => Promise<{
    acknowledged: boolean;
    duplicate: boolean;
    applied: boolean;
    sideEffectId?: string;
  }>;
  toleranceMs?: number;
}): Promise<ContractResult> {
  const findings = [...testWebhookConsumerContract(input).findings];
  const seen = new Map<string, string | undefined>();
  const seenEvents = new Set<string>();
  const newestVersion = new Map<string, number>();
  let observedDuplicate = false;
  let observedOutOfOrder = false;
  for (const [index, delivery] of input.deliveries.entries()) {
    // eslint-disable-next-line no-await-in-loop -- consumer outcomes must be observed in delivery order.
    const outcome = await input.consume(delivery);
    const headers = Object.fromEntries(
      Object.entries(delivery.headers).map(([key, value]) => [key.toLowerCase(), value]),
    );
    const deliveryId = headers['x-tixkit-delivery'];
    const eventId = headers['x-tixkit-event-id'];
    if (!outcome.acknowledged)
      findings.push({
        code: 'WEBHOOK_NOT_ACKNOWLEDGED',
        message: 'Consumer did not acknowledge delivery.',
        path: `${index}`,
      });
    if (deliveryId && seen.has(deliveryId)) {
      observedDuplicate = true;
      if (!outcome.duplicate || outcome.sideEffectId !== seen.get(deliveryId))
        findings.push({
          code: 'WEBHOOK_DUPLICATE_SIDE_EFFECT',
          message: 'Duplicate delivery was not idempotent.',
          path: `${index}`,
        });
    } else if (deliveryId) {
      if (outcome.duplicate)
        findings.push({
          code: 'WEBHOOK_FALSE_DUPLICATE',
          message: 'First delivery was marked duplicate.',
          path: `${index}`,
        });
      seen.set(deliveryId, outcome.sideEffectId);
    }
    if (eventId && delivery.ordering && !seenEvents.has(eventId)) {
      const watermark = newestVersion.get(delivery.ordering.key) ?? Number.NEGATIVE_INFINITY;
      const expectedApplied = delivery.ordering.version >= watermark;
      if (!expectedApplied) observedOutOfOrder = true;
      if (outcome.applied !== expectedApplied)
        findings.push({
          code: 'WEBHOOK_OUT_OF_ORDER_STATE',
          message: expectedApplied
            ? 'A current event was not applied.'
            : 'An older event overwrote newer consumer state.',
          path: `${index}`,
        });
      newestVersion.set(delivery.ordering.key, Math.max(watermark, delivery.ordering.version));
      seenEvents.add(eventId);
    }
  }
  if (!observedDuplicate)
    findings.push({
      code: 'WEBHOOK_DUPLICATE_FIXTURE_MISSING',
      message: 'Contract run requires a duplicate delivery fixture.',
    });
  if (!observedOutOfOrder)
    findings.push({
      code: 'WEBHOOK_OUT_OF_ORDER_FIXTURE_MISSING',
      message: 'Contract run requires distinct newer-then-older event fixtures.',
    });
  return result(findings);
}

export function testSdkConsumerContract(input: {
  apiVersion: string;
  expectedApiVersion: string;
  operationIds: readonly string[];
  requiredOperationIds: readonly string[];
  errorSamples: readonly unknown[];
}): ContractResult {
  const findings: ContractFinding[] = [];
  if (input.apiVersion !== input.expectedApiVersion)
    findings.push({
      code: 'SDK_API_VERSION',
      message: 'SDK and API versions do not match.',
    });
  const unique = new Set(input.operationIds);
  if (unique.size !== input.operationIds.length)
    findings.push({
      code: 'SDK_OPERATION_DUPLICATE',
      message: 'Operation IDs must be unique.',
    });
  for (const id of input.requiredOperationIds) {
    if (!unique.has(id))
      findings.push({
        code: 'SDK_OPERATION_MISSING',
        message: `Missing operation ${id}.`,
      });
  }
  for (const [index, sample] of input.errorSamples.entries()) {
    const error = sample as {
      error?: { code?: unknown; message?: unknown; requestId?: unknown };
    };
    if (typeof error?.error?.code !== 'string' || typeof error.error.message !== 'string')
      findings.push({
        code: 'SDK_ERROR_SCHEMA',
        message: 'Error sample does not match the API envelope.',
        path: `${index}`,
      });
  }
  return result(findings);
}

export type SdkApiRequest = {
  method: 'POST';
  path: string;
  headers: Record<string, string>;
};

export async function runSdkApiConsumerContract(input: {
  apiVersion: string;
  apiKey: string;
  endpointId: string;
  execute: (request: SdkApiRequest) => Promise<{
    status: number;
    headers: Record<string, string | undefined>;
    body: unknown;
  }>;
}): Promise<ContractResult> {
  const findings: ContractFinding[] = [];
  const request: SdkApiRequest = {
    method: 'POST',
    path: `/v1/webhook-endpoints/${encodeURIComponent(input.endpointId)}/test`,
    headers: {
      authorization: `Bearer ${input.apiKey}`,
      accept: 'application/json',
      'X-Tixkit-Version': input.apiVersion,
    },
  };
  let response: Awaited<ReturnType<typeof input.execute>>;
  try {
    response = await input.execute(request);
  } catch {
    return result([
      {
        code: 'SDK_REQUEST_FAILED',
        message: 'SDK/API request could not be completed.',
      },
    ]);
  }
  const headers = Object.fromEntries(
    Object.entries(response.headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  if (response.status !== 202)
    findings.push({
      code: 'SDK_RESPONSE_STATUS',
      message: `Expected 202, received ${response.status}.`,
    });
  if (headers['content-type'] && !headers['content-type']?.includes('application/json'))
    findings.push({
      code: 'SDK_RESPONSE_CONTENT_TYPE',
      message: 'Response is not JSON.',
    });
  const body = response.body as {
    queued?: unknown;
    test?: unknown;
    eventId?: unknown;
    endpointId?: unknown;
  };
  if (
    body?.queued !== true ||
    body.test !== true ||
    typeof body.eventId !== 'string' ||
    body.endpointId !== input.endpointId
  ) {
    findings.push({
      code: 'SDK_RESPONSE_SCHEMA',
      message: 'Synthetic delivery response is invalid.',
    });
  }
  return result(findings);
}

function objectBody(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export async function runAgentPlatformContract(
  input: AgentPlatformContractInput,
): Promise<AgentPlatformContractResult> {
  const findings: ContractFinding[] = [];
  if (
    (input.conformanceTarget !== 'platform-api' && input.conformanceTarget !== 'self-hosted') ||
    input.apiVersion !== AGENT_PLATFORM_CONTRACT_API_VERSION ||
    !input.sponsorAccessToken ||
    !input.agentClientId ||
    !input.agentClientSecret ||
    !input.delegationGrantId ||
    !input.resourceId ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input.campaignEmailTemplateKey) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{1,62}$/u.test(input.planId) ||
    input.idempotencyPrefix.length < 16 ||
    input.idempotencyPrefix.length > 180 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(input.idempotencyPrefix)
  ) {
    findings.push({
      code: 'AGENT_PLATFORM_INPUT',
      message: `Conformance input must target API ${AGENT_PLATFORM_CONTRACT_API_VERSION} with complete credentials and valid plan and idempotency identifiers.`,
    });
    return result(findings);
  }
  const reportFrom = new Date(0).toISOString();
  const reportTo = new Date(Math.floor((Date.now() - 5_000) / 1_000) * 1_000).toISOString();
  const request = async (
    stage: string,
    value: AgentPlatformContractRequest,
    expectedStatus: number,
    requireNoStore = true,
  ): Promise<AgentPlatformContractResponse | undefined> => {
    try {
      const response = await input.execute(value);
      if (response.status !== expectedStatus) {
        findings.push({
          code: 'AGENT_PLATFORM_STATUS',
          message: `${stage} expected ${expectedStatus}, received ${response.status}.`,
          path: stage,
        });
        return undefined;
      }
      const cacheControl = Object.entries(response.headers).find(
        ([name]) => name.toLowerCase() === 'cache-control',
      )?.[1];
      if (requireNoStore && !/(?:^|,)\s*no-store(?:\s*(?:,|$))/iu.test(cacheControl ?? ''))
        findings.push({
          code: 'AGENT_PLATFORM_CACHE_CONTROL',
          message: `${stage} must return Cache-Control: no-store.`,
          path: stage,
        });
      return response;
    } catch {
      findings.push({
        code: 'AGENT_PLATFORM_REQUEST_FAILED',
        message: `${stage} request could not be completed.`,
        path: stage,
      });
      return undefined;
    }
  };
  const headers = (token: string): Record<string, string> => ({
    authorization: `Bearer ${token}`,
    accept: 'application/json',
    'content-type': 'application/json',
    'X-Tixkit-Version': input.apiVersion,
  });
  const oauth = await request(
    'oauth',
    {
      method: 'POST',
      path: '/v1/oauth/token',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: {
        grant_type: 'client_credentials',
        client_id: input.agentClientId,
        client_secret: input.agentClientSecret,
      },
    },
    200,
  );
  const accessToken = objectBody(oauth?.body)?.access_token;
  const oauthBody = objectBody(oauth?.body);
  if (
    typeof accessToken !== 'string' ||
    !/^[A-Za-z0-9._~+/-]+=*$/u.test(accessToken) ||
    oauthBody?.token_type !== 'Bearer' ||
    oauthBody.scope !== 'agent.invoke'
  ) {
    findings.push({
      code: 'AGENT_PLATFORM_OAUTH_SCHEMA',
      message: 'OAuth response is invalid.',
    });
    return result(findings);
  }
  const sessionResponse = await request(
    'session',
    { method: 'GET', path: '/v1/agent/session', headers: headers(accessToken) },
    200,
  );
  const session = objectBody(sessionResponse?.body);
  const principalBody = objectBody(session?.principal);
  const authentication = objectBody(session?.authentication);
  const requiredCapabilities = [
    'events.read',
    'reports.read',
    'readiness.read',
    'events.prepare',
    'content.prepare',
    'campaigns.prepare',
    'events.execute',
  ] as const;
  const expectedPrincipalKind =
    input.conformanceTarget === 'platform-api' ? 'third_party' : 'self_hosted';
  let principal: AgentPrincipal | undefined;
  try {
    principal = principalBody as unknown as AgentPrincipal;
    validateAgentPrincipal(principal);
  } catch {
    principal = undefined;
  }
  if (
    !principal ||
    principal.kind !== expectedPrincipalKind ||
    principal.protocolVersion !== AGENT_PROTOCOL_VERSION ||
    principal.state !== 'active' ||
    principal.maximumAutonomy !== 'execute_with_approval' ||
    requiredCapabilities.some((capability) => !principal?.capabilities.includes(capability)) ||
    authentication?.grantType !== 'client_credentials' ||
    authentication.scope !== 'agent.invoke' ||
    !Array.isArray(authentication.productPermissions) ||
    authentication.productPermissions.length !== 0 ||
    session?.delegationRequired !== true ||
    session.supportedProtocolVersion !== AGENT_PROTOCOL_VERSION
  ) {
    findings.push({
      code: 'AGENT_PLATFORM_SESSION_SCHEMA',
      message: 'Explicit agent session response is invalid.',
    });
    return result(findings);
  }
  const eventReadRequest: AgentPlatformContractRequest = {
    method: 'POST',
    path: '/v1/agent/events',
    headers: {
      ...headers(accessToken),
      'Idempotency-Key': `${input.idempotencyPrefix}.event.read`,
    },
    body: {
      delegationGrantId: input.delegationGrantId,
      resourceId: input.resourceId,
    },
  };
  const eventReadResponse = await request('event-read', eventReadRequest, 201);
  const eventReadReplay = await request('event-read-replay', eventReadRequest, 201);
  const eventPrepared = objectBody(eventReadResponse?.body);
  const eventAction = objectBody(eventPrepared?.action) as unknown as AgentAction | undefined;
  const eventResult = objectBody(eventPrepared?.result);
  const eventAuthorization = objectBody(eventPrepared?.authorization);
  let eventActionDigest: string | undefined;
  let eventResultDigest: string | undefined;
  try {
    if (!eventAction || !eventResult) throw new Error('invalid event read response');
    validateAgentEventReadResult(eventAction, eventResult as unknown as AgentEventReadResult);
    eventActionDigest = agentActionDigest(eventAction);
    eventResultDigest = agentSha256(eventResult);
  } catch {
    eventActionDigest = undefined;
  }
  if (
    !eventAction ||
    eventAction.protocolVersion !== AGENT_PROTOCOL_VERSION ||
    eventAction.kind !== 'event.read' ||
    eventAction.autonomy !== 'read' ||
    eventAction.agentPrincipalId !== principal.id ||
    eventAction.sponsorPrincipalId !== principal.sponsorPrincipalId ||
    eventAction.delegationGrantId !== input.delegationGrantId ||
    eventAction.target.resourceType !== 'event' ||
    eventAction.target.resourceId !== input.resourceId ||
    eventAction.target.apiOperation !== 'events.get' ||
    eventActionDigest !== eventPrepared?.actionDigest ||
    eventResultDigest !== eventPrepared?.resultSha256 ||
    eventAuthorization?.allowed !== true ||
    eventPrepared?.dryRun !== undefined ||
    objectBody(eventAction.payload)?.eventSnapshotSha256 !== eventResult?.eventSnapshotSha256 ||
    agentSha256(eventReadResponse?.body) !== agentSha256(eventReadReplay?.body) ||
    !Array.isArray(eventResult?.untrustedContentPaths) ||
    eventResult.untrustedContentPaths.join(',') !== 'event.title,event.description'
  ) {
    findings.push({
      code: 'AGENT_PLATFORM_EVENT_READ_SCHEMA',
      message:
        'Direct event projection, untrusted-content boundary, result digest or exact replay evidence is invalid.',
    });
    return result(findings);
  }
  const reportReadRequest: AgentPlatformContractRequest = {
    method: 'POST',
    path: '/v1/agent/reports',
    headers: {
      ...headers(accessToken),
      'Idempotency-Key': `${input.idempotencyPrefix}.report.read`,
    },
    body: {
      delegationGrantId: input.delegationGrantId,
      resourceId: input.resourceId,
      from: reportFrom,
      to: reportTo,
    },
  };
  const reportReadResponse = await request('report-read', reportReadRequest, 201);
  const reportReadReplay = await request('report-read-replay', reportReadRequest, 201);
  const preparedReport = objectBody(reportReadResponse?.body);
  const reportAction = objectBody(preparedReport?.action) as unknown as AgentAction | undefined;
  const reportResult = objectBody(preparedReport?.result);
  const reportAuthorization = objectBody(preparedReport?.authorization);
  let reportActionDigest: string | undefined;
  let reportResultDigest: string | undefined;
  let reportValidationFailure: string | undefined;
  try {
    if (!reportAction || !reportResult) throw new Error('invalid report read response');
    validateAgentReportReadResult(reportAction, reportResult as unknown as AgentReportReadResult);
    reportActionDigest = agentActionDigest(reportAction);
    reportResultDigest = agentSha256(reportResult);
  } catch (error) {
    reportValidationFailure = error instanceof Error ? error.message : 'unknown validation error';
  }
  const reportRetrieved =
    typeof reportAction?.id === 'string'
      ? await request(
          'report-read-get',
          {
            method: 'GET',
            path: `/v1/agent/reports/${encodeURIComponent(reportAction.id)}`,
            headers: headers(accessToken),
          },
          200,
        )
      : undefined;
  if (
    !reportAction ||
    reportAction.protocolVersion !== AGENT_PROTOCOL_VERSION ||
    reportAction.kind !== 'report.read' ||
    reportAction.autonomy !== 'read' ||
    reportAction.agentPrincipalId !== principal.id ||
    reportAction.sponsorPrincipalId !== principal.sponsorPrincipalId ||
    reportAction.delegationGrantId !== input.delegationGrantId ||
    reportAction.target.tenantId !== principal.tenantId ||
    reportAction.target.resourceType !== 'event' ||
    reportAction.target.resourceId !== input.resourceId ||
    reportAction.target.apiOperation !== 'reports.get' ||
    reportAction.idempotencyKey !== `${input.idempotencyPrefix}.report.read` ||
    reportActionDigest !== preparedReport?.actionDigest ||
    reportResultDigest !== preparedReport?.resultSha256 ||
    reportAuthorization?.allowed !== true ||
    preparedReport?.dryRun !== undefined ||
    objectBody(reportAction.payload)?.reportType !== 'event_sales' ||
    objectBody(reportAction.payload)?.from !== reportFrom ||
    objectBody(reportAction.payload)?.to !== reportTo ||
    objectBody(reportAction.payload)?.reportSnapshotSha256 !== reportResult?.reportSnapshotSha256 ||
    reportResult?.from !== reportFrom ||
    reportResult?.to !== reportTo ||
    agentSha256(reportReadResponse?.body) !== agentSha256(reportReadReplay?.body) ||
    agentSha256(reportReadResponse?.body) !== agentSha256(reportRetrieved?.body) ||
    !Array.isArray(reportResult?.untrustedContentPaths) ||
    reportResult.untrustedContentPaths.length !== 0
  ) {
    findings.push({
      code: 'AGENT_PLATFORM_REPORT_READ_SCHEMA',
      message: `Direct aggregate report, closed range, snapshot digest, retrieval or exact replay evidence is invalid.${reportValidationFailure ? ` ${reportValidationFailure}` : ''}`,
    });
    return result(findings);
  }
  await request(
    'report-read-approval-rejected',
    {
      method: 'POST',
      path: `/v1/agent/actions/${encodeURIComponent(reportAction.id)}/approvals`,
      headers: {
        ...headers(input.sponsorAccessToken),
        'Idempotency-Key': `${input.idempotencyPrefix}.report.read.approval`,
        'X-Tixkit-Confirmation': `approve:${reportAction.id}:${reportActionDigest}`,
      },
      body: { actionDigest: reportActionDigest },
    },
    404,
    false,
  );
  await request(
    'report-read-execution-rejected',
    {
      method: 'POST',
      path: `/v1/agent/actions/${encodeURIComponent(reportAction.id)}/executions`,
      headers: {
        ...headers(accessToken),
        'Idempotency-Key': `execute:${reportAction.id}:apr_${'0'.repeat(48)}:${reportActionDigest}`,
        'X-Tixkit-Confirmation': `execute:${reportAction.id}:apr_${'0'.repeat(48)}:${reportActionDigest}`,
      },
      body: { approvalId: `apr_${'0'.repeat(48)}`, actionDigest: reportActionDigest },
    },
    404,
    false,
  );
  const eventPrepareRequest: AgentPlatformContractRequest = {
    method: 'POST',
    path: '/v1/agent/event-preparations',
    headers: {
      ...headers(accessToken),
      'Idempotency-Key': `${input.idempotencyPrefix}.event.prepare`,
    },
    body: {
      delegationGrantId: input.delegationGrantId,
      resourceId: input.resourceId,
      changes: {
        title: 'Contract-prepared event',
        description: 'Organizer-authored prepared description.',
      },
    },
  };
  const eventPrepareResponse = await request('event-prepare', eventPrepareRequest, 201);
  const eventPrepareReplay = await request('event-prepare-replay', eventPrepareRequest, 201);
  const preparedEventChange = objectBody(eventPrepareResponse?.body);
  const eventPrepareAction = objectBody(preparedEventChange?.action) as unknown as
    | AgentAction
    | undefined;
  const eventPrepareResult = objectBody(preparedEventChange?.result);
  const eventPrepareAuthorization = objectBody(preparedEventChange?.authorization);
  let eventPrepareActionDigest: string | undefined;
  let eventPrepareResultDigest: string | undefined;
  let eventPrepareValidationFailure: string | undefined;
  try {
    if (!eventPrepareAction || !eventPrepareResult)
      throw new Error('invalid event prepare response');
    validateAgentEventPrepareResult(
      eventPrepareAction,
      eventPrepareResult as unknown as AgentEventPrepareResult,
    );
    eventPrepareActionDigest = agentActionDigest(eventPrepareAction);
    eventPrepareResultDigest = agentSha256(eventPrepareResult);
  } catch (error) {
    eventPrepareActionDigest = undefined;
    eventPrepareValidationFailure =
      error instanceof Error ? error.message : 'unknown validation error';
  }
  if (
    !eventPrepareAction ||
    eventPrepareAction.protocolVersion !== AGENT_PROTOCOL_VERSION ||
    eventPrepareAction.kind !== 'event.prepare' ||
    eventPrepareAction.autonomy !== 'prepare' ||
    eventPrepareAction.agentPrincipalId !== principal.id ||
    eventPrepareAction.sponsorPrincipalId !== principal.sponsorPrincipalId ||
    eventPrepareAction.delegationGrantId !== input.delegationGrantId ||
    eventPrepareAction.target.resourceType !== 'event' ||
    eventPrepareAction.target.resourceId !== input.resourceId ||
    eventPrepareAction.target.apiOperation !== 'events.prepare' ||
    eventPrepareActionDigest !== preparedEventChange?.actionDigest ||
    eventPrepareResultDigest !== preparedEventChange?.resultSha256 ||
    eventPrepareAuthorization?.allowed !== true ||
    preparedEventChange?.dryRun !== undefined ||
    objectBody(eventPrepareAction.payload)?.changePreviewSha256 !==
      eventPrepareResult?.changePreviewSha256 ||
    agentSha256(eventPrepareResponse?.body) !== agentSha256(eventPrepareReplay?.body) ||
    !Array.isArray(eventPrepareResult?.changedFields) ||
    eventPrepareResult.changedFields.join(',') !== 'description,title' ||
    !Array.isArray(eventPrepareResult.untrustedContentPaths) ||
    eventPrepareResult.untrustedContentPaths.join(',') !==
      'before.description,after.description,before.title,after.title'
  ) {
    findings.push({
      code: 'AGENT_PLATFORM_EVENT_PREPARE_SCHEMA',
      message: `Direct event preparation, normalized preview digest, untrusted-content boundary or exact replay evidence is invalid.${eventPrepareValidationFailure ? ` ${eventPrepareValidationFailure}` : ''}`,
    });
    return result(findings);
  }
  const contentPrepareRequest: AgentPlatformContractRequest = {
    method: 'POST',
    path: '/v1/agent/content-preparations',
    headers: {
      ...headers(accessToken),
      'Idempotency-Key': `${input.idempotencyPrefix}.content.prepare`,
    },
    body: {
      delegationGrantId: input.delegationGrantId,
      resourceId: input.resourceId,
      content: {
        schemaVersion: 2,
        editor: {
          provider: '@puckeditor/core',
          data: { root: { props: {} }, content: [] },
        },
        settings: { locale: 'en' },
      },
    },
  };
  const contentPrepareResponse = await request('content-prepare', contentPrepareRequest, 201);
  const contentPrepareReplay = await request('content-prepare-replay', contentPrepareRequest, 201);
  const preparedContent = objectBody(contentPrepareResponse?.body);
  const contentAction = objectBody(preparedContent?.action) as unknown as AgentAction | undefined;
  const contentResult = objectBody(preparedContent?.result);
  const contentAuthorization = objectBody(preparedContent?.authorization);
  let contentActionDigest: string | undefined;
  let contentResultDigest: string | undefined;
  let contentValidationFailure: string | undefined;
  try {
    if (!contentAction || !contentResult) throw new Error('invalid content prepare response');
    validateAgentContentPrepareResult(
      contentAction,
      contentResult as unknown as AgentContentPrepareResult,
    );
    contentActionDigest = agentActionDigest(contentAction);
    contentResultDigest = agentSha256(contentResult);
  } catch (error) {
    contentActionDigest = undefined;
    contentValidationFailure = error instanceof Error ? error.message : 'unknown validation error';
  }
  if (
    !contentAction ||
    contentAction.protocolVersion !== AGENT_PROTOCOL_VERSION ||
    contentAction.kind !== 'content.prepare' ||
    contentAction.autonomy !== 'prepare' ||
    contentAction.agentPrincipalId !== principal.id ||
    contentAction.sponsorPrincipalId !== principal.sponsorPrincipalId ||
    contentAction.delegationGrantId !== input.delegationGrantId ||
    contentAction.target.resourceType !== 'event' ||
    contentAction.target.resourceId !== input.resourceId ||
    contentAction.target.apiOperation !== 'content.prepare' ||
    contentActionDigest !== preparedContent?.actionDigest ||
    contentResultDigest !== preparedContent?.resultSha256 ||
    contentAuthorization?.allowed !== true ||
    preparedContent?.dryRun !== undefined ||
    contentResult?.contentPreviewSha256 !==
      objectBody(contentAction.payload)?.contentPreviewSha256 ||
    agentSha256(contentPrepareResponse?.body) !== agentSha256(contentPrepareReplay?.body) ||
    !Array.isArray(contentResult?.untrustedContentPaths) ||
    contentResult.untrustedContentPaths.join(',') !== 'content,preview.discovery'
  ) {
    findings.push({
      code: 'AGENT_PLATFORM_CONTENT_PREPARE_SCHEMA',
      message: `Direct content preparation, canonical preview digest, untrusted-content boundary or exact replay evidence is invalid.${contentValidationFailure ? ` ${contentValidationFailure}` : ''}`,
    });
    return result(findings);
  }
  await request(
    'content-prepare-approval-rejected',
    {
      method: 'POST',
      path: `/v1/agent/actions/${encodeURIComponent(contentAction.id)}/approvals`,
      headers: {
        ...headers(input.sponsorAccessToken),
        'Idempotency-Key': `${input.idempotencyPrefix}.content.prepare.approval`,
        'X-Tixkit-Confirmation': `approve:${contentAction.id}:${contentActionDigest}`,
      },
      body: { actionDigest: contentActionDigest },
    },
    404,
    false,
  );
  await request(
    'content-prepare-execution-rejected',
    {
      method: 'POST',
      path: `/v1/agent/actions/${encodeURIComponent(contentAction.id)}/executions`,
      headers: {
        ...headers(accessToken),
        'Idempotency-Key': `execute:${contentAction.id}:apr_${'0'.repeat(48)}:${contentActionDigest}`,
        'X-Tixkit-Confirmation': `execute:${contentAction.id}:apr_${'0'.repeat(48)}:${contentActionDigest}`,
      },
      body: { approvalId: `apr_${'0'.repeat(48)}`, actionDigest: contentActionDigest },
    },
    404,
    false,
  );
  const campaignPrepareRequest: AgentPlatformContractRequest = {
    method: 'POST',
    path: '/v1/agent/campaign-preparations',
    headers: {
      ...headers(accessToken),
      'Idempotency-Key': `${input.idempotencyPrefix}.campaign.prepare`,
    },
    body: {
      delegationGrantId: input.delegationGrantId,
      resourceId: input.resourceId,
      audience: 'all',
      channel: 'email',
      emailTemplateKey: input.campaignEmailTemplateKey,
    },
  };
  const campaignPrepareResponse = await request('campaign-prepare', campaignPrepareRequest, 201);
  const campaignPrepareReplay = await request(
    'campaign-prepare-replay',
    campaignPrepareRequest,
    201,
  );
  const preparedCampaign = objectBody(campaignPrepareResponse?.body);
  const campaignAction = objectBody(preparedCampaign?.action) as unknown as AgentAction | undefined;
  const campaignResult = objectBody(preparedCampaign?.result);
  const campaignAuthorization = objectBody(preparedCampaign?.authorization);
  let campaignActionDigest: string | undefined;
  let campaignResultDigest: string | undefined;
  let campaignValidationFailure: string | undefined;
  try {
    if (!campaignAction || !campaignResult) throw new Error('invalid campaign prepare response');
    validateAgentCampaignPrepareResult(
      campaignAction,
      campaignResult as unknown as AgentCampaignPrepareResult,
    );
    campaignActionDigest = agentActionDigest(campaignAction);
    campaignResultDigest = agentSha256(campaignResult);
  } catch (error) {
    campaignValidationFailure = error instanceof Error ? error.message : 'unknown validation error';
  }
  if (
    !campaignAction ||
    campaignAction.protocolVersion !== AGENT_PROTOCOL_VERSION ||
    campaignAction.kind !== 'campaign.prepare' ||
    campaignAction.autonomy !== 'prepare' ||
    campaignAction.agentPrincipalId !== principal.id ||
    campaignAction.sponsorPrincipalId !== principal.sponsorPrincipalId ||
    campaignAction.delegationGrantId !== input.delegationGrantId ||
    campaignAction.target.resourceType !== 'event' ||
    campaignAction.target.resourceId !== input.resourceId ||
    campaignAction.target.apiOperation !== 'campaigns.prepare' ||
    campaignActionDigest !== preparedCampaign?.actionDigest ||
    campaignResultDigest !== preparedCampaign?.resultSha256 ||
    campaignAuthorization?.allowed !== true ||
    preparedCampaign?.dryRun !== undefined ||
    campaignResult?.complianceResultSha256 !==
      objectBody(campaignAction.payload)?.complianceResultSha256 ||
    campaignResult?.eligibleDeliveryCount === undefined ||
    agentSha256(campaignPrepareResponse?.body) !== agentSha256(campaignPrepareReplay?.body) ||
    !Array.isArray(campaignResult?.untrustedContentPaths) ||
    campaignResult.untrustedContentPaths.length !== 0
  ) {
    findings.push({
      code: 'AGENT_PLATFORM_CAMPAIGN_PREPARE_SCHEMA',
      message: `Direct campaign preparation, exact compliance snapshot or replay evidence is invalid.${campaignValidationFailure ? ` ${campaignValidationFailure}` : ''}`,
    });
    return result(findings);
  }
  await request(
    'campaign-prepare-approval-rejected',
    {
      method: 'POST',
      path: `/v1/agent/actions/${encodeURIComponent(campaignAction.id)}/approvals`,
      headers: {
        ...headers(input.sponsorAccessToken),
        'Idempotency-Key': `${input.idempotencyPrefix}.campaign.prepare.approval`,
        'X-Tixkit-Confirmation': `approve:${campaignAction.id}:${campaignActionDigest}`,
      },
      body: { actionDigest: campaignActionDigest },
    },
    404,
    false,
  );
  await request(
    'campaign-prepare-execution-rejected',
    {
      method: 'POST',
      path: `/v1/agent/actions/${encodeURIComponent(campaignAction.id)}/executions`,
      headers: {
        ...headers(accessToken),
        'Idempotency-Key': `execute:${campaignAction.id}:apr_${'0'.repeat(48)}:${campaignActionDigest}`,
        'X-Tixkit-Confirmation': `execute:${campaignAction.id}:apr_${'0'.repeat(48)}:${campaignActionDigest}`,
      },
      body: { approvalId: `apr_${'0'.repeat(48)}`, actionDigest: campaignActionDigest },
    },
    404,
    false,
  );
  const eventUpdateRequest: AgentPlatformContractRequest = {
    method: 'POST',
    path: '/v1/agent/event-updates',
    headers: {
      ...headers(accessToken),
      'Idempotency-Key': `${input.idempotencyPrefix}.event.update`,
    },
    body: {
      delegationGrantId: input.delegationGrantId,
      resourceId: input.resourceId,
      changes: {
        title: 'Contract-updated event',
        description: 'Organizer-approved updated description.',
      },
    },
  };
  const eventUpdateResponse = await request('event-update', eventUpdateRequest, 201);
  const eventUpdateReplay = await request('event-update-replay', eventUpdateRequest, 201);
  const preparedEventUpdate = objectBody(eventUpdateResponse?.body);
  const eventUpdateAction = objectBody(preparedEventUpdate?.action) as unknown as
    | AgentAction
    | undefined;
  const eventUpdatePreview = objectBody(preparedEventUpdate?.preview);
  const eventUpdateAuthorization = objectBody(preparedEventUpdate?.authorization);
  const eventUpdatePreparedKeys = preparedEventUpdate
    ? Object.keys(preparedEventUpdate).sort().join(',')
    : '';
  const eventUpdateAuthorizationKeys = eventUpdateAuthorization
    ? Object.keys(eventUpdateAuthorization).sort().join(',')
    : '';
  const eventUpdatePreparedAt = Date.parse(String(eventUpdateAction?.preparedAt));
  const eventUpdateActionExpiresAt = Date.parse(String(preparedEventUpdate?.expiresAt));
  const eventUpdateAuthorizationCheckedAt = Date.parse(String(eventUpdateAuthorization?.checkedAt));
  let eventUpdateActionDigest: string | undefined;
  try {
    if (!eventUpdateAction || !eventUpdatePreview) throw new Error('invalid event update response');
    validateAgentEventUpdatePreview(
      eventUpdateAction,
      eventUpdatePreview as unknown as AgentEventUpdatePreview,
    );
    eventUpdateActionDigest = agentActionDigest(eventUpdateAction);
  } catch {
    eventUpdateActionDigest = undefined;
  }
  if (
    !eventUpdateAction ||
    eventUpdatePreparedKeys !==
      ['action', 'actionDigest', 'authorization', 'expiresAt', 'preview', 'previewSha256']
        .sort()
        .join(',') ||
    eventUpdateAuthorizationKeys !==
      ['checkedAt', 'eligibleForApproval', 'reasons', 'snapshotSha256'].sort().join(',') ||
    eventUpdateAction.protocolVersion !== AGENT_PROTOCOL_VERSION ||
    eventUpdateAction.kind !== 'event.update' ||
    eventUpdateAction.autonomy !== 'execute_with_approval' ||
    !/^act_[a-f0-9]{48}$/u.test(eventUpdateAction.id) ||
    !/^agt_[a-f0-9]{48}$/u.test(eventUpdateAction.agentPrincipalId) ||
    !/^dlg_[a-f0-9]{48}$/u.test(eventUpdateAction.delegationGrantId) ||
    eventUpdateAction.agentPrincipalId !== principal.id ||
    eventUpdateAction.sponsorPrincipalId !== principal.sponsorPrincipalId ||
    eventUpdateAction.delegationGrantId !== input.delegationGrantId ||
    eventUpdateAction.target.resourceType !== 'event' ||
    eventUpdateAction.target.resourceId !== input.resourceId ||
    eventUpdateAction.target.apiOperation !== 'events.update' ||
    eventUpdateActionDigest !== preparedEventUpdate?.actionDigest ||
    eventUpdateAuthorization?.eligibleForApproval !== true ||
    !Array.isArray(eventUpdateAuthorization.reasons) ||
    eventUpdateAuthorization.reasons.join(',') !== 'approval_required' ||
    !/^[a-f0-9]{64}$/u.test(String(eventUpdateAuthorization.snapshotSha256)) ||
    preparedEventUpdate?.previewSha256 !== agentSha256(eventUpdatePreview) ||
    objectBody(eventUpdateAction.payload)?.changePreviewSha256 !==
      eventUpdatePreview?.changePreviewSha256 ||
    agentSha256(eventUpdateResponse?.body) !== agentSha256(eventUpdateReplay?.body) ||
    !Array.isArray(eventUpdatePreview?.changedFields) ||
    eventUpdatePreview.changedFields.join(',') !== 'description,title' ||
    !Number.isFinite(eventUpdatePreparedAt) ||
    !Number.isFinite(eventUpdateActionExpiresAt) ||
    !Number.isFinite(eventUpdateAuthorizationCheckedAt) ||
    eventUpdateAuthorizationCheckedAt < eventUpdatePreparedAt ||
    eventUpdateAuthorizationCheckedAt > eventUpdateActionExpiresAt ||
    eventUpdateActionExpiresAt <= eventUpdatePreparedAt ||
    eventUpdateActionExpiresAt - eventUpdatePreparedAt > 15 * 60_000
  ) {
    findings.push({
      code: 'AGENT_PLATFORM_EVENT_UPDATE_SCHEMA',
      message:
        'Approval-bound event update, immutable preview digest or exact preparation replay evidence is invalid.',
    });
    return result(findings);
  }
  const eventUpdateApprovalResponse = await request(
    'event-update-approve',
    {
      method: 'POST',
      path: `/v1/agent/event-updates/${encodeURIComponent(eventUpdateAction.id)}/approvals`,
      headers: {
        ...headers(input.sponsorAccessToken),
        'Idempotency-Key': `${input.idempotencyPrefix}.event.update.approve`,
        'X-Tixkit-Confirmation': `approve:${eventUpdateAction.id}:${eventUpdateActionDigest}`,
      },
      body: { actionDigest: eventUpdateActionDigest },
    },
    201,
  );
  const eventUpdateApproval = objectBody(eventUpdateApprovalResponse?.body) as unknown as
    | AgentApproval
    | undefined;
  const eventUpdateApprovalKeys = eventUpdateApproval
    ? Object.keys(eventUpdateApproval).sort().join(',')
    : '';
  const eventUpdateApprovedAt = Date.parse(String(eventUpdateApproval?.approvedAt));
  const eventUpdateApprovalExpiresAt = Date.parse(String(eventUpdateApproval?.expiresAt));
  if (
    !eventUpdateApproval ||
    eventUpdateApprovalKeys !==
      [
        'actionDigest',
        'approvedAt',
        'approverPermissionSnapshot',
        'approverPrincipalId',
        'expiresAt',
        'id',
        'policyVersion',
        'tenantId',
      ]
        .sort()
        .join(',') ||
    !/^apr_[a-f0-9]{48}$/u.test(eventUpdateApproval.id) ||
    eventUpdateApproval.tenantId !== eventUpdateAction.target.tenantId ||
    eventUpdateApproval.actionDigest !== eventUpdateActionDigest ||
    eventUpdateApproval.planSha256 !== undefined ||
    eventUpdateApproval.approverPrincipalId !== eventUpdateAction.sponsorPrincipalId ||
    eventUpdateApproval.approverPermissionSnapshot?.join(',') !== 'events:write' ||
    eventUpdateApproval.policyVersion !== eventUpdateAction.expectedPolicyVersion ||
    eventUpdateApproval.revokedAt !== undefined ||
    eventUpdateApproval.consumedAt !== undefined ||
    !Number.isFinite(eventUpdateApprovedAt) ||
    !Number.isFinite(eventUpdateApprovalExpiresAt) ||
    eventUpdateApprovedAt < eventUpdatePreparedAt ||
    eventUpdateApprovedAt < eventUpdateAuthorizationCheckedAt ||
    eventUpdateApprovalExpiresAt <= eventUpdateApprovedAt ||
    eventUpdateApprovalExpiresAt - eventUpdateApprovedAt > 5 * 60_000 ||
    eventUpdateApprovalExpiresAt > eventUpdateActionExpiresAt
  ) {
    findings.push({
      code: 'AGENT_PLATFORM_EVENT_UPDATE_APPROVAL_SCHEMA',
      message: 'Event update approval is not bound to the exact immutable preview and sponsor.',
    });
    return result(findings);
  }
  const eventUpdateExecutionRequest: AgentPlatformContractRequest = {
    method: 'POST',
    path: `/v1/agent/event-updates/${encodeURIComponent(eventUpdateAction.id)}/executions`,
    headers: {
      ...headers(accessToken),
      'Idempotency-Key': `execute:${eventUpdateAction.id}:${eventUpdateApproval.id}:${eventUpdateActionDigest}`,
      'X-Tixkit-Confirmation': `execute:${eventUpdateAction.id}:${eventUpdateApproval.id}:${eventUpdateActionDigest}`,
    },
    body: {
      approvalId: eventUpdateApproval.id,
      actionDigest: eventUpdateActionDigest,
    },
  };
  const eventUpdateExecutionResponse = await request(
    'event-update-execute',
    eventUpdateExecutionRequest,
    200,
  );
  const eventUpdateExecutionReplay = await request(
    'event-update-execute-replay',
    eventUpdateExecutionRequest,
    200,
  );
  const eventUpdateExecution = eventUpdateExecutionResponse?.body as AgentExecution | undefined;
  try {
    if (!eventUpdateExecution?.result) throw new Error('missing event update result');
    validateAgentActionResultForAction(
      eventUpdateAction,
      eventUpdateExecution.result as AgentActionResult,
    );
  } catch {
    findings.push({
      code: 'AGENT_PLATFORM_EVENT_UPDATE_EXECUTION_SCHEMA',
      message: 'Event update execution result is not bound to the approved resource version.',
    });
    return result(findings);
  }
  const eventUpdateExecutionKeys = eventUpdateExecution
    ? Object.keys(eventUpdateExecution).sort().join(',')
    : '';
  if (
    eventUpdateExecutionKeys !==
      [
        'actionDigest',
        'actionId',
        'agentPrincipalId',
        'approvalId',
        'createdAt',
        'delegationGrantId',
        'fenceToken',
        'id',
        'idempotencyKey',
        'policyVersion',
        'requestFingerprint',
        'resourceVersion',
        'result',
        'sponsorPrincipalId',
        'state',
        'tenantId',
        'updatedAt',
      ]
        .sort()
        .join(',') ||
    !/^exec_[a-f0-9]{48}$/u.test(eventUpdateExecution.id) ||
    eventUpdateExecution.tenantId !== eventUpdateAction.target.tenantId ||
    eventUpdateExecution.state !== 'succeeded' ||
    eventUpdateExecution.actionId !== eventUpdateAction.id ||
    eventUpdateExecution.actionDigest !== eventUpdateActionDigest ||
    eventUpdateExecution.approvalId !== eventUpdateApproval.id ||
    eventUpdateExecution.agentPrincipalId !== eventUpdateAction.agentPrincipalId ||
    eventUpdateExecution.sponsorPrincipalId !== eventUpdateAction.sponsorPrincipalId ||
    eventUpdateExecution.delegationGrantId !== eventUpdateAction.delegationGrantId ||
    !/^agt_[a-f0-9]{48}$/u.test(eventUpdateExecution.agentPrincipalId) ||
    !/^dlg_[a-f0-9]{48}$/u.test(eventUpdateExecution.delegationGrantId) ||
    eventUpdateExecution.planSha256 !== undefined ||
    !/^[a-f0-9]{64}$/u.test(eventUpdateExecution.idempotencyKey) ||
    !/^[a-f0-9]{64}$/u.test(eventUpdateExecution.requestFingerprint) ||
    eventUpdateExecution.resourceVersion !== eventUpdateAction.target.resourceVersion ||
    eventUpdateExecution.policyVersion !== eventUpdateAction.expectedPolicyVersion ||
    !Number.isSafeInteger(eventUpdateExecution.fenceToken) ||
    eventUpdateExecution.fenceToken < 1 ||
    !Number.isFinite(Date.parse(eventUpdateExecution.createdAt)) ||
    !Number.isFinite(Date.parse(eventUpdateExecution.updatedAt)) ||
    Date.parse(eventUpdateExecution.createdAt) < eventUpdateApprovedAt ||
    Date.parse(eventUpdateExecution.createdAt) >= eventUpdateApprovalExpiresAt ||
    Date.parse(eventUpdateExecution.updatedAt) < Date.parse(eventUpdateExecution.createdAt) ||
    agentSha256(eventUpdateExecutionResponse?.body) !==
      agentSha256(eventUpdateExecutionReplay?.body)
  ) {
    findings.push({
      code: 'AGENT_PLATFORM_EVENT_UPDATE_EXECUTION_SCHEMA',
      message: 'Event update execution identity or exact replay evidence is invalid.',
    });
    return result(findings);
  }
  const readinessRequest: AgentPlatformContractRequest = {
    method: 'POST',
    path: '/v1/agent/readiness',
    headers: {
      ...headers(accessToken),
      'Idempotency-Key': `${input.idempotencyPrefix}.readiness`,
    },
    body: {
      delegationGrantId: input.delegationGrantId,
      resourceId: input.resourceId,
    },
  };
  const readinessResponse = await request('readiness', readinessRequest, 201);
  const readinessReplayResponse = await request('readiness-replay', readinessRequest, 201);
  const readinessPrepared = objectBody(readinessResponse?.body);
  const readinessAction = objectBody(readinessPrepared?.action) as unknown as
    | AgentAction
    | undefined;
  const readinessResult = objectBody(readinessPrepared?.result);
  const readinessDryRun = objectBody(readinessPrepared?.dryRun);
  const readinessAuthorization = objectBody(readinessPrepared?.authorization);
  let readinessActionDigest: string | undefined;
  let readinessResultDigest: string | undefined;
  let readinessReplayMatches = false;
  try {
    if (!readinessAction || !readinessResult) throw new Error('invalid readiness response');
    validateAgentReadinessReadResult(
      readinessAction,
      readinessResult as unknown as AgentReadinessReadResult,
    );
    readinessActionDigest = agentActionDigest(readinessAction);
    readinessResultDigest = agentSha256(readinessResult);
    readinessReplayMatches =
      agentSha256(readinessResponse?.body) === agentSha256(readinessReplayResponse?.body);
  } catch {
    readinessActionDigest = undefined;
  }
  if (
    !readinessAction ||
    readinessAction.protocolVersion !== AGENT_PROTOCOL_VERSION ||
    readinessAction.kind !== 'readiness.read' ||
    readinessAction.autonomy !== 'read' ||
    readinessAction.agentPrincipalId !== principal.id ||
    readinessAction.sponsorPrincipalId !== principal.sponsorPrincipalId ||
    readinessAction.delegationGrantId !== input.delegationGrantId ||
    readinessAction.target.resourceType !== 'event' ||
    readinessAction.target.resourceId !== input.resourceId ||
    readinessAction.target.apiOperation !== 'events.readiness.get' ||
    readinessActionDigest !== readinessPrepared?.actionDigest ||
    readinessResultDigest !== readinessPrepared?.resultSha256 ||
    readinessAuthorization?.allowed !== true ||
    typeof readinessDryRun?.readinessSnapshotSha256 !== 'string' ||
    readinessDryRun.readinessSnapshotSha256 !== readinessResult?.readinessSnapshotSha256 ||
    objectBody(readinessAction.payload)?.readinessSnapshotSha256 !==
      readinessResult?.readinessSnapshotSha256 ||
    !readinessReplayMatches
  ) {
    findings.push({
      code: 'AGENT_PLATFORM_READINESS_SCHEMA',
      message: 'Direct readiness action, result digest or exact replay evidence is invalid.',
    });
    return result(findings);
  }
  const prepare = await request(
    'prepare',
    {
      method: 'POST',
      path: '/v1/agent/actions',
      headers: {
        ...headers(accessToken),
        'Idempotency-Key': `${input.idempotencyPrefix}.prepare`,
      },
      body: {
        kind: 'event.publish',
        delegationGrantId: input.delegationGrantId,
        resourceId: input.resourceId,
      },
    },
    201,
  );
  const prepared = objectBody(prepare?.body);
  const rawAction = objectBody(prepared?.action);
  let action: AgentAction | undefined;
  let canonicalActionDigest: string | undefined;
  const actionDigest = prepared?.actionDigest;
  const dryRun = objectBody(prepared?.dryRun);
  const actionExpiresAt = prepared?.expiresAt;
  try {
    if (!rawAction) throw new Error('invalid action');
    action = rawAction as unknown as AgentAction;
    canonicalActionDigest = agentActionDigest(action);
  } catch {
    action = undefined;
  }
  if (
    !action ||
    action.protocolVersion !== AGENT_PROTOCOL_VERSION ||
    typeof actionDigest !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(actionDigest) ||
    canonicalActionDigest !== actionDigest ||
    typeof actionExpiresAt !== 'string' ||
    !Number.isFinite(Date.parse(actionExpiresAt)) ||
    !Number.isFinite(Date.parse(action.preparedAt)) ||
    Date.parse(actionExpiresAt) <= Date.parse(action.preparedAt) ||
    dryRun?.launchable !== true ||
    typeof dryRun.readinessSnapshotSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(dryRun.readinessSnapshotSha256) ||
    action.agentPrincipalId !== principal.id ||
    action.sponsorPrincipalId !== principal.sponsorPrincipalId ||
    action.delegationGrantId !== input.delegationGrantId ||
    action.kind !== 'event.publish' ||
    action.autonomy !== 'execute_with_approval' ||
    action.target.resourceType !== 'event' ||
    action.target.resourceId !== input.resourceId ||
    action.target.resourceVersion !== eventUpdateAction.target.resourceVersion + 1 ||
    action.target.apiOperation !== 'events.publish' ||
    objectBody(action.payload)?.readinessSnapshotSha256 !== dryRun.readinessSnapshotSha256
  ) {
    findings.push({
      code: 'AGENT_PLATFORM_PREPARE_SCHEMA',
      message: 'Prepared action or dry-run evidence is invalid.',
    });
    return result(findings);
  }
  const expiresAt = new Date(
    Math.min(new Date(actionExpiresAt).getTime(), new Date(action.preparedAt).getTime() + 240_000),
  ).toISOString();
  let definition;
  try {
    definition = buildAgentPlanDefinition({
      id: input.planId,
      protocolVersion: AGENT_PLATFORM_PROTOCOL_VERSION,
      tenantId: action.target.tenantId,
      agentPrincipalId: action.agentPrincipalId,
      sponsorPrincipalId: action.sponsorPrincipalId,
      delegationGrantId: action.delegationGrantId,
      purpose: 'Conformance: publish one reviewed event',
      assumptions: [
        {
          id: 'conformance_reviewed',
          statement: 'The conformance operator selected this event for a controlled publish test.',
          provenanceType: 'user',
          sourceReference: 'tixkit-contract-tests',
          verification: 'confirmed',
        },
      ],
      steps: [
        {
          id: 'publish_event',
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
              previewSha256: agentSha256(dryRun),
            },
          ],
          costs: [
            {
              amountMinor: 0,
              currency: 'USD',
              basis: 'Conformance event publication has no direct platform charge.',
              quoteSha256: agentSha256({ amountMinor: 0, currency: 'USD' }),
              expiresAt,
            },
          ],
          readinessImpact: {
            beforeSnapshotSha256: String(dryRun.readinessSnapshotSha256),
            projectedSnapshotSha256: agentSha256({
              actionDigest,
              status: 'published',
            }),
            introducedReasonCodes: [],
            resolvedReasonCodes: ['event_unpublished'],
          },
          approvalRequirement: { mode: 'fresh_action', riskClass: 'high' },
          reversibility: { mode: 'none' },
        },
      ],
      createdAt: action.preparedAt,
      expiresAt,
    });
  } catch {
    findings.push({
      code: 'AGENT_PLATFORM_PLAN_BUILD',
      message: 'Prepared action could not produce a canonical plan.',
    });
    return result(findings);
  }
  const planCreate = await request(
    'plan-create',
    {
      method: 'POST',
      path: '/v1/agent/plans',
      headers: {
        ...headers(accessToken),
        'Idempotency-Key': `${input.idempotencyPrefix}.plan.create`,
      },
      body: {
        definition,
        actionBindings: [{ stepId: 'publish_event', actionId: action.id }],
      },
    },
    201,
  );
  const createdPlan = objectBody(planCreate?.body);
  const createdState = objectBody(createdPlan?.state);
  const createdBindings = createdPlan?.actionBindings;
  if (
    objectBody(createdPlan?.definition)?.planSha256 !== definition.planSha256 ||
    createdState?.status !== 'prepared' ||
    createdState.stateVersion !== 1 ||
    !Array.isArray(createdBindings) ||
    createdBindings.length !== 1 ||
    objectBody(createdBindings[0])?.stepId !== 'publish_event' ||
    objectBody(createdBindings[0])?.actionId !== action.id
  ) {
    findings.push({
      code: 'AGENT_PLATFORM_PLAN_SCHEMA',
      message: 'Persisted plan digest does not match the canonical definition.',
    });
    return result(findings);
  }
  const awaiting = await request(
    'plan-awaiting',
    {
      method: 'POST',
      path: `/v1/agent/plans/${encodeURIComponent(definition.id)}/transitions`,
      headers: {
        ...headers(accessToken),
        'Idempotency-Key': `${input.idempotencyPrefix}.plan.awaiting`,
      },
      body: {
        expectedStateVersion: 1,
        status: 'awaiting_approval',
        stepStates: [{ stepId: 'publish_event', status: 'awaiting_approval' }],
        reasonCode: 'conformance_approval_requested',
      },
    },
    200,
  );
  const awaitingState = objectBody(objectBody(awaiting?.body)?.state);
  if (awaitingState?.status !== 'awaiting_approval' || awaitingState.stateVersion !== 2) {
    findings.push({
      code: 'AGENT_PLATFORM_PLAN_STATE',
      message: 'Plan did not enter awaiting_approval.',
    });
    return result(findings);
  }
  const approvalResponse = await request(
    'approve',
    {
      method: 'POST',
      path: `/v1/agent/actions/${encodeURIComponent(action.id)}/approvals`,
      headers: {
        ...headers(input.sponsorAccessToken),
        'Idempotency-Key': `${input.idempotencyPrefix}.approve`,
        'X-Tixkit-Confirmation': `approve:${action.id}:${actionDigest}:${definition.planSha256}`,
      },
      body: { actionDigest, planSha256: definition.planSha256 },
    },
    201,
  );
  const approval = objectBody(approvalResponse?.body) as unknown as AgentApproval | undefined;
  if (
    !approval ||
    typeof approval.id !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{1,62}$/u.test(approval.id) ||
    approval.tenantId !== action.target.tenantId ||
    approval.actionDigest !== actionDigest ||
    approval.planSha256 !== definition.planSha256 ||
    approval.approverPrincipalId !== action.sponsorPrincipalId ||
    !Array.isArray(approval.approverPermissionSnapshot) ||
    approval.approverPermissionSnapshot.length !== 1 ||
    approval.approverPermissionSnapshot[0] !== 'events:publish' ||
    approval.policyVersion !== action.expectedPolicyVersion ||
    !Number.isSafeInteger(approval.policyVersion) ||
    !Number.isFinite(Date.parse(approval.approvedAt)) ||
    !Number.isFinite(Date.parse(approval.expiresAt)) ||
    Date.parse(approval.approvedAt) < Date.parse(action.preparedAt) ||
    Date.parse(approval.expiresAt) <= Date.parse(approval.approvedAt) ||
    Date.parse(approval.expiresAt) > Date.parse(approval.approvedAt) + 300_000 ||
    Date.parse(approval.expiresAt) > Date.parse(actionExpiresAt) ||
    Date.parse(approval.expiresAt) > Date.parse(definition.expiresAt) ||
    approval.revokedAt !== undefined ||
    approval.consumedAt !== undefined
  ) {
    findings.push({
      code: 'AGENT_PLATFORM_APPROVAL_SCHEMA',
      message: 'Approval is not bound to the authoritative plan digest.',
    });
    return result(findings);
  }
  const executionResponse = await request(
    'execute',
    {
      method: 'POST',
      path: `/v1/agent/actions/${encodeURIComponent(action.id)}/executions`,
      headers: {
        ...headers(accessToken),
        'Idempotency-Key': `execute:${action.id}:${approval.id}:${actionDigest}`,
        'X-Tixkit-Confirmation': `execute:${action.id}:${approval.id}:${actionDigest}`,
      },
      body: { approvalId: approval.id, actionDigest },
    },
    200,
  );
  const execution = executionResponse?.body as AgentExecution | undefined;
  if (
    !execution ||
    execution.state !== 'succeeded' ||
    execution.planSha256 !== definition.planSha256 ||
    execution.actionId !== action.id ||
    execution.actionDigest !== actionDigest ||
    execution.approvalId !== approval.id ||
    execution.agentPrincipalId !== action.agentPrincipalId ||
    execution.sponsorPrincipalId !== action.sponsorPrincipalId ||
    execution.delegationGrantId !== action.delegationGrantId ||
    !execution.result
  ) {
    findings.push({
      code: 'AGENT_PLATFORM_EXECUTION_SCHEMA',
      message: 'Terminal execution evidence is invalid or missing its plan digest.',
    });
    return result(findings);
  }
  let resultSha256: string;
  try {
    resultSha256 = agentSha256(execution.result);
  } catch {
    findings.push({
      code: 'AGENT_PLATFORM_EXECUTION_SCHEMA',
      message: 'Terminal execution result is not canonical digestible evidence.',
    });
    return result(findings);
  }
  const succeeded = await request(
    'plan-succeeded',
    {
      method: 'POST',
      path: `/v1/agent/plans/${encodeURIComponent(definition.id)}/transitions`,
      headers: {
        ...headers(accessToken),
        'Idempotency-Key': `${input.idempotencyPrefix}.plan.succeeded`,
      },
      body: {
        expectedStateVersion: 2,
        status: 'succeeded',
        stepStates: [
          {
            stepId: 'publish_event',
            status: 'succeeded',
            approvalId: approval.id,
            executionId: execution.id,
            resultSha256,
          },
        ],
        reasonCode: 'conformance_execution_succeeded',
      },
    },
    200,
  );
  const succeededState = objectBody(objectBody(succeeded?.body)?.state);
  if (succeededState?.status !== 'succeeded' || succeededState.stateVersion !== 3)
    findings.push({
      code: 'AGENT_PLATFORM_PLAN_STATE',
      message: 'Plan did not persist terminal succeeded evidence.',
    });
  const inspection = await request(
    'inspect',
    {
      method: 'GET',
      path: `/v1/agent/actions/${encodeURIComponent(action.id)}/executions/${encodeURIComponent(execution.id)}`,
      headers: headers(accessToken),
    },
    200,
  );
  const evidence = objectBody(inspection?.body);
  const inspectedExecution = objectBody(evidence?.execution);
  const audit = evidence?.audit;
  if (
    inspectedExecution?.id !== execution.id ||
    inspectedExecution.actionId !== action.id ||
    inspectedExecution.actionDigest !== actionDigest ||
    inspectedExecution.approvalId !== approval.id ||
    inspectedExecution.agentPrincipalId !== action.agentPrincipalId ||
    inspectedExecution.sponsorPrincipalId !== action.sponsorPrincipalId ||
    inspectedExecution.delegationGrantId !== action.delegationGrantId ||
    inspectedExecution.planSha256 !== definition.planSha256 ||
    !Array.isArray(audit) ||
    audit.length < 4 ||
    audit.some((record) => {
      const value = objectBody(record);
      return (
        value?.actionId !== action.id ||
        value.actionDigest !== actionDigest ||
        value.approvalId !== approval.id ||
        value.agentPrincipalId !== action.agentPrincipalId ||
        value.sponsorPrincipalId !== action.sponsorPrincipalId ||
        value.delegationGrantId !== action.delegationGrantId ||
        value.planSha256 !== definition.planSha256
      );
    })
  )
    findings.push({
      code: 'AGENT_PLATFORM_AUDIT_SCHEMA',
      message: 'Execution audit evidence is incomplete or not plan-bound.',
    });
  if (findings.length > 0) return result(findings);
  return {
    ok: true,
    findings: [],
    evidence: {
      profile: 'agent-platform',
      conformanceTarget: input.conformanceTarget,
      apiVersion: AGENT_PLATFORM_CONTRACT_API_VERSION,
      agentProtocolVersion: AGENT_PROTOCOL_VERSION,
      agentPlatformProtocolVersion: AGENT_PLATFORM_PROTOCOL_VERSION,
      principalKind: expectedPrincipalKind,
    },
  };
}

function assertResult(value: ContractResult): void {
  if (!value.ok)
    throw new Error(
      value.findings
        .map(
          (finding) =>
            `${finding.path ? `${finding.path} ` : ''}${finding.code}: ${finding.message}`,
        )
        .join('\n'),
    );
}
export function assertEmbedHostContract(input: Parameters<typeof testEmbedHostContract>[0]): void {
  assertResult(testEmbedHostContract(input));
}
export function assertWebhookConsumerContract(
  input: Parameters<typeof testWebhookConsumerContract>[0],
): void {
  assertResult(testWebhookConsumerContract(input));
}
export function assertSdkConsumerContract(
  input: Parameters<typeof testSdkConsumerContract>[0],
): void {
  assertResult(testSdkConsumerContract(input));
}
