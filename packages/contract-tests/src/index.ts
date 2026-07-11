import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  EMBED_LIFECYCLE_NAMES,
  isEmbedLifecycleDetail,
  validateCheckoutMessageEvent,
  type EmbedMessageExpectation,
} from '@tixkit/embed-core';

export type ContractFinding = { code: string; message: string; path?: string };
export type ContractResult = { ok: boolean; findings: ContractFinding[] };

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
      { ...canonical.event, source: {} as MessageEvent['source'] } as MessageEvent,
      {
        ...canonical.event,
        data: { ...(canonical.event.data as object), widgetId: '__invalid_widget__' },
      } as MessageEvent,
      {
        ...canonical.event,
        data: { ...(canonical.event.data as object), nonce: '__invalid_nonce__' },
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
    findings.push({ code: 'SDK_API_VERSION', message: 'SDK and API versions do not match.' });
  const unique = new Set(input.operationIds);
  if (unique.size !== input.operationIds.length)
    findings.push({ code: 'SDK_OPERATION_DUPLICATE', message: 'Operation IDs must be unique.' });
  for (const id of input.requiredOperationIds) {
    if (!unique.has(id))
      findings.push({ code: 'SDK_OPERATION_MISSING', message: `Missing operation ${id}.` });
  }
  for (const [index, sample] of input.errorSamples.entries()) {
    const error = sample as { error?: { code?: unknown; message?: unknown; requestId?: unknown } };
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
      { code: 'SDK_REQUEST_FAILED', message: 'SDK/API request could not be completed.' },
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
    findings.push({ code: 'SDK_RESPONSE_CONTENT_TYPE', message: 'Response is not JSON.' });
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
