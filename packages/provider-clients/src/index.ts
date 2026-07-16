import { createHash } from 'node:crypto';
import { SpanKind, SpanStatusCode, trace, type Span } from '@opentelemetry/api';

const DEFAULT_DEADLINE_MS = 10_000;
const DEFAULT_BODY_PREVIEW_BYTES = 1_024;
const DEFAULT_RESPONSE_BYTES = 64 * 1_024;
const RETRYABLE_SERVER_STATUSES = new Set([500, 502, 503, 504]);
const SAFE_DIAGNOSTIC_KEYS = new Set(['code', 'type', 'error_code']);
const SAFE_DIAGNOSTIC_ENVELOPES = new Set(['error', 'errors']);
const REDACTED = '[REDACTED]';

export type ProviderFailureKind =
  | 'timeout'
  | 'cancelled'
  | 'transport'
  | 'rate-limit'
  | 'server'
  | 'validation'
  | 'malformed-response';

export type ProviderOutcome = 'success' | ProviderFailureKind;
export const PROVIDER_SERVICE_OUTCOMES = [
  'success',
  'decline',
  'caller_cancelled',
  'platform_failure',
] as const;
export type ProviderServiceOutcome = (typeof PROVIDER_SERVICE_OUTCOMES)[number];
export type ProviderDeliveryState = 'not-sent' | 'rejected' | 'unknown' | 'accepted';

export interface ProviderTelemetryEvent {
  dependency: string;
  operation: string;
  method: string;
  outcome: ProviderOutcome;
  serviceOutcome: ProviderServiceOutcome;
  durationMs: number;
  retryable: boolean;
  status?: number;
}

export interface ProviderClientRuntime {
  deadlineMs?: number;
  fetch?: typeof globalThis.fetch;
  onTelemetry?: (event: Readonly<ProviderTelemetryEvent>) => void;
}

export class ProviderOperationError extends Error {
  readonly name = 'ProviderOperationError';

  constructor(
    message: string,
    public readonly dependency: string,
    public readonly operation: string,
    public readonly kind: ProviderFailureKind,
    public readonly retryable: boolean,
    public readonly deliveryState: ProviderDeliveryState,
    public readonly safeToFailover: boolean,
    public readonly details: {
      status?: number;
      providerCode?: string;
      providerRequestId?: string;
      retryAfterMs?: number;
      bodyPreview?: string;
    } = {},
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
  }

  forRetry(): ProviderOperationError {
    return new ProviderOperationError(
      this.message,
      this.dependency,
      this.operation,
      this.kind,
      this.retryable,
      this.deliveryState,
      false,
    );
  }
}

export interface ProviderHttpRequest<T> extends ProviderClientRuntime {
  dependency: string;
  operation: string;
  method: string;
  url: string | URL;
  headers?: RequestInit['headers'];
  body?: RequestInit['body'];
  signal?: AbortSignal;
  idempotency?: { key: string; header?: string };
  apiVersion?: { value: string; header: string };
  expectJson?: boolean;
  allowEmptySuccess?: boolean;
  bodyPreviewBytes?: number;
  maxResponseBytes?: number;
  parse?: (body: unknown) => T;
  requestIdHeaders?: readonly string[];
}

export interface ProviderHttpResult<T> {
  data: T;
  status: number;
  providerRequestId?: string;
  durationMs: number;
}

export async function executeProviderHttp<T = Record<string, unknown>>(
  request: ProviderHttpRequest<T>,
): Promise<ProviderHttpResult<T>> {
  const startedAt = performance.now();
  const method = request.method.toUpperCase();
  const sideEffecting = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  const deadlineMs = positiveDeadline(request.deadlineMs);
  const maxResponseBytes = positiveResponseLimit(request.maxResponseBytes);
  const span = startProviderSpan(request.dependency, request.operation, method);
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException('Provider deadline exceeded', 'TimeoutError'));
  }, deadlineMs);
  const onCallerAbort = () => controller.abort(request.signal?.reason);
  request.signal?.addEventListener('abort', onCallerAbort, { once: true });
  if (request.signal?.aborted) onCallerAbort();

  try {
    const headers = new Headers(request.headers);
    if (request.idempotency) {
      headers.set(request.idempotency.header ?? 'Idempotency-Key', request.idempotency.key);
    }
    if (request.apiVersion) headers.set(request.apiVersion.header, request.apiVersion.value);

    let response: Response;
    try {
      if (controller.signal.aborted) {
        throw operationError(request, 'cancelled', false, 'not-sent', false, {});
      }
      response = await (request.fetch ?? globalThis.fetch)(request.url, {
        method,
        headers,
        body: request.body,
        signal: controller.signal,
        redirect: 'error',
      });
    } catch (cause) {
      if (cause instanceof ProviderOperationError) throw cause;
      const kind: ProviderFailureKind = timedOut
        ? 'timeout'
        : request.signal?.aborted
          ? 'cancelled'
          : 'transport';
      throw operationError(
        request,
        kind,
        kind !== 'cancelled' && !sideEffecting,
        'unknown',
        false,
        {},
      );
    }

    const providerRequestId = extractProviderRequestId(response.headers, request.requestIdHeaders);
    if (response.status >= 300 && response.status < 400) {
      throw operationError(request, 'malformed-response', false, 'unknown', false, {
        status: response.status,
        providerRequestId,
      });
    }
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
    let rawBody: string;
    try {
      rawBody = await readBoundedBody(response, maxResponseBytes);
    } catch (cause) {
      if (timedOut) {
        throw operationError(request, 'timeout', !sideEffecting, 'unknown', false, {});
      }
      if (request.signal?.aborted) {
        throw operationError(request, 'cancelled', false, 'unknown', false, {}, cause);
      }
      throw operationError(
        request,
        'malformed-response',
        false,
        response.ok ? 'accepted' : 'unknown',
        false,
        { status: response.status, providerRequestId },
        cause,
      );
    }
    const bodyPreview = sanitizeBodyPreview(
      rawBody,
      request.bodyPreviewBytes ?? DEFAULT_BODY_PREVIEW_BYTES,
    );
    const parsed = parseResponseBody(rawBody);

    if (!response.ok) {
      const kind = classifyStatus(response.status);
      const retryable = kind === 'rate-limit' || (kind === 'server' && !sideEffecting);
      const deliveryState = kind === 'validation' || kind === 'rate-limit' ? 'rejected' : 'unknown';
      throw operationError(request, kind, retryable, deliveryState, deliveryState === 'rejected', {
        status: response.status,
        providerCode: extractProviderCode(parsed),
        providerRequestId,
        retryAfterMs,
        bodyPreview,
      });
    }

    const expectsJson = request.expectJson ?? true;
    if (expectsJson && rawBody.trim().length === 0 && !request.allowEmptySuccess) {
      throw operationError(request, 'malformed-response', false, 'accepted', false, {
        status: response.status,
        providerRequestId,
      });
    }
    if (expectsJson && parsed === undefined) {
      throw operationError(request, 'malformed-response', false, 'accepted', false, {
        status: response.status,
        providerRequestId,
        bodyPreview,
      });
    }

    let data: T;
    try {
      data = request.parse ? request.parse(parsed) : ((expectsJson ? parsed : rawBody) as T);
    } catch (cause) {
      throw operationError(
        request,
        'malformed-response',
        false,
        'accepted',
        false,
        { status: response.status, providerRequestId, bodyPreview },
        cause,
      );
    }
    const durationMs = elapsed(startedAt);
    recordSuccess(span, response.status, durationMs);
    emitTelemetry(request, {
      dependency: request.dependency,
      operation: request.operation,
      method,
      outcome: 'success',
      serviceOutcome: 'success',
      durationMs,
      retryable: false,
      status: response.status,
    });
    return { data, status: response.status, providerRequestId, durationMs };
  } catch (error) {
    const normalized =
      error instanceof ProviderOperationError
        ? error
        : operationError(request, 'transport', !sideEffecting, 'unknown', false, {});
    const durationMs = elapsed(startedAt);
    recordFailure(span, normalized, durationMs);
    emitTelemetry(request, {
      dependency: request.dependency,
      operation: request.operation,
      method,
      outcome: normalized.kind,
      serviceOutcome:
        normalized.kind === 'cancelled' && request.signal?.aborted === true && !timedOut
          ? 'caller_cancelled'
          : 'platform_failure',
      durationMs,
      retryable: normalized.retryable,
      ...(normalized.details.status === undefined ? {} : { status: normalized.details.status }),
    });
    throw normalized;
  } finally {
    clearTimeout(timeout);
    request.signal?.removeEventListener('abort', onCallerAbort);
    span.end();
  }
}

function positiveDeadline(value: number | undefined): number {
  const deadline = value ?? DEFAULT_DEADLINE_MS;
  if (!Number.isSafeInteger(deadline) || deadline <= 0 || deadline > 120_000) {
    throw new TypeError('Provider deadline must be an integer between 1 and 120000 milliseconds');
  }
  return deadline;
}

function positiveResponseLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_RESPONSE_BYTES;
  if (!Number.isSafeInteger(limit) || limit < 1_024 || limit > 1024 * 1024) {
    throw new TypeError('Provider response limit must be between 1024 and 1048576 bytes');
  }
  return limit;
}

function operationError(
  request: Pick<ProviderHttpRequest<unknown>, 'dependency' | 'operation'>,
  kind: ProviderFailureKind,
  retryable: boolean,
  deliveryState: ProviderDeliveryState,
  safeToFailover: boolean,
  details: ProviderOperationError['details'],
  cause?: unknown,
): ProviderOperationError {
  const status = details.status === undefined ? '' : ` (HTTP ${details.status})`;
  return new ProviderOperationError(
    `${request.dependency}.${request.operation} failed: ${kind}${status}`,
    request.dependency,
    request.operation,
    kind,
    retryable,
    deliveryState,
    safeToFailover,
    details,
    cause,
  );
}

function classifyStatus(status: number): ProviderFailureKind {
  if (status === 429) return 'rate-limit';
  if (RETRYABLE_SERVER_STATUSES.has(status)) return 'server';
  return 'validation';
}

function parseResponseBody(rawBody: string): unknown | undefined {
  if (!rawBody.trim()) return undefined;
  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    return undefined;
  }
}

function extractProviderCode(body: unknown): string | undefined {
  // Provider-controlled values can contain credentials or customer identifiers even
  // when they appear under conventional diagnostic keys. Provider adapters may add
  // typed, enumerated codes after proving the provider contract; the generic HTTP
  // boundary never persists an untrusted value.
  void body;
  return undefined;
}

export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value?.trim()) return undefined;
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/u.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds)
      ? Math.min(24 * 60 * 60 * 1_000, Math.max(0, Math.ceil(seconds * 1_000)))
      : undefined;
  }
  const timestamp = Date.parse(trimmed);
  return Number.isFinite(timestamp)
    ? Math.min(24 * 60 * 60 * 1_000, Math.max(0, timestamp - now))
    : undefined;
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel('Provider response exceeded the configured byte limit');
        throw new RangeError('Provider response exceeded the configured byte limit');
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(body);
}

export function extractProviderRequestId(
  headers: Headers,
  preferred: readonly string[] = [],
): string | undefined {
  const candidates = [
    ...preferred,
    'request-id',
    'x-request-id',
    'x-provider-request-id',
    'stripe-request-id',
    'x-telnyx-request-id',
    'x-resend-request-id',
  ];
  for (const name of new Set(candidates.map((candidate) => candidate.toLowerCase()))) {
    const value = headers.get(name)?.trim();
    if (value) return `sha256:${createHash('sha256').update(value).digest('hex')}`;
  }
  return undefined;
}

export function sanitizeBodyPreview(rawBody: string, limit = DEFAULT_BODY_PREVIEW_BYTES): string {
  if (!Number.isSafeInteger(limit) || limit < 64 || limit > 4_096) {
    throw new TypeError('Provider body preview limit must be between 64 and 4096 bytes');
  }
  let safe: string;
  try {
    safe = JSON.stringify(allowlistedStructuredPreview(JSON.parse(rawBody) as unknown));
  } catch {
    safe = REDACTED;
  }
  const bytes = Buffer.from(safe, 'utf8');
  if (bytes.byteLength <= limit) return safe;
  const ellipsis = Buffer.from('…', 'utf8');
  return `${bytes
    .subarray(0, limit - ellipsis.byteLength)
    .toString('utf8')
    .replace(/\uFFFD+$/u, '')}…`;
}

function allowlistedStructuredPreview(value: unknown, depth = 0): unknown {
  if (depth > 4) return {};
  if (Array.isArray(value)) {
    return value.slice(0, 8).map((entry) => allowlistedStructuredPreview(entry, depth + 1));
  }
  if (!value || typeof value !== 'object') return {};
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SAFE_DIAGNOSTIC_KEYS.has(key)) {
      if (typeof entry === 'string' || typeof entry === 'number') result[key] = REDACTED;
      continue;
    }
    if (SAFE_DIAGNOSTIC_ENVELOPES.has(key)) {
      result[key] = allowlistedStructuredPreview(entry, depth + 1);
    }
  }
  return result;
}

function startProviderSpan(dependency: string, operation: string, method: string): Span {
  return trace
    .getTracer('tixkit-provider-clients')
    .startSpan(`provider.${dependency}.${operation}`, {
      kind: SpanKind.CLIENT,
      attributes: {
        'server.address': dependency,
        'http.request.method': method,
        'tixkit.provider.dependency': dependency,
        'tixkit.provider.operation': operation,
      },
    });
}

function recordSuccess(span: Span, status: number, durationMs: number): void {
  span.setAttributes({
    'http.response.status_code': status,
    'tixkit.provider.outcome': 'success',
    'tixkit.provider.retryable': false,
    'tixkit.provider.duration_ms': durationMs,
  });
  span.setStatus({ code: SpanStatusCode.OK });
}

function recordFailure(span: Span, error: ProviderOperationError, durationMs: number): void {
  span.setAttributes({
    'tixkit.provider.outcome': error.kind,
    'tixkit.provider.retryable': error.retryable,
    'tixkit.provider.duration_ms': durationMs,
    ...(error.details.status === undefined
      ? {}
      : { 'http.response.status_code': error.details.status }),
  });
  span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
}

function emitTelemetry(request: ProviderClientRuntime, event: ProviderTelemetryEvent): void {
  try {
    request.onTelemetry?.(Object.freeze({ ...event }));
  } catch {
    // Telemetry is diagnostic and must never alter provider operation semantics.
  }
}

function elapsed(startedAt: number): number {
  return Math.max(0, Math.round((performance.now() - startedAt) * 1_000) / 1_000);
}

export interface SmsMessageInput {
  from: string;
  to: string;
  body: string;
  idempotencyKey: string;
  webhookUrl?: string;
}

export interface ProviderMessageResult {
  providerMessageId?: string;
  accepted: boolean;
}

export class TelnyxMessagingClient {
  constructor(
    private readonly config: { apiKey: string; baseUrl?: string },
    private readonly runtime: ProviderClientRuntime = {},
  ) {}

  async sendSms(input: SmsMessageInput): Promise<ProviderMessageResult> {
    requireCredential(this.config.apiKey, 'telnyx', 'send-sms');
    const result = await executeProviderHttp({
      ...this.runtime,
      dependency: 'telnyx',
      operation: 'send-sms',
      method: 'POST',
      url: `${trimBaseUrl(this.config.baseUrl ?? 'https://api.telnyx.com/v2')}/messages`,
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      idempotency: { key: input.idempotencyKey },
      requestIdHeaders: ['x-telnyx-request-id'],
      body: JSON.stringify({
        from: input.from,
        to: input.to,
        text: input.body,
        type: 'SMS',
        webhook_url: input.webhookUrl,
        use_profile_webhooks: !input.webhookUrl,
      }),
      parse: recordBody,
    });
    const nested = result.data.data;
    const providerMessageId =
      optionalString(result.data, 'id') ??
      (nested && typeof nested === 'object' && !Array.isArray(nested)
        ? optionalString(nested as Record<string, unknown>, 'id')
        : undefined);
    if (!providerMessageId) throw malformedProviderPayload('telnyx', 'send-sms');
    return { providerMessageId, accepted: true };
  }
}

export class TwilioMessagingClient {
  constructor(
    private readonly config: { accountSid: string; authToken: string; baseUrl?: string },
    private readonly runtime: ProviderClientRuntime = {},
  ) {}

  async sendSms(input: SmsMessageInput): Promise<ProviderMessageResult> {
    requireCredential(this.config.accountSid, 'twilio', 'send-sms');
    requireCredential(this.config.authToken, 'twilio', 'send-sms');
    const form = new URLSearchParams({ From: input.from, To: input.to, Body: input.body });
    if (input.webhookUrl) form.set('StatusCallback', input.webhookUrl);
    const baseUrl = trimBaseUrl(this.config.baseUrl ?? 'https://api.twilio.com/2010-04-01');
    const result = await executeProviderHttp({
      ...this.runtime,
      dependency: 'twilio',
      operation: 'send-sms',
      method: 'POST',
      url: `${baseUrl}/Accounts/${encodeURIComponent(this.config.accountSid)}/Messages.json`,
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.config.accountSid}:${this.config.authToken}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      idempotency: { key: input.idempotencyKey },
      body: form,
      parse: recordBody,
    });
    const providerMessageId = optionalString(result.data, 'sid');
    if (!providerMessageId) throw malformedProviderPayload('twilio', 'send-sms');
    return { providerMessageId, accepted: true };
  }
}

export class VonageMessagingClient {
  constructor(
    private readonly config: { apiKey: string; apiSecret: string; baseUrl?: string },
    private readonly runtime: ProviderClientRuntime = {},
  ) {}

  async sendSms(input: SmsMessageInput): Promise<ProviderMessageResult> {
    requireCredential(this.config.apiKey, 'vonage', 'send-sms');
    requireCredential(this.config.apiSecret, 'vonage', 'send-sms');
    const form = new URLSearchParams({
      api_key: this.config.apiKey,
      api_secret: this.config.apiSecret,
      from: input.from,
      to: input.to,
      text: input.body,
      'client-ref': input.idempotencyKey,
    });
    if (input.webhookUrl) form.set('callback', input.webhookUrl);
    const result = await executeProviderHttp({
      ...this.runtime,
      dependency: 'vonage',
      operation: 'send-sms',
      method: 'POST',
      url: `${trimBaseUrl(this.config.baseUrl ?? 'https://rest.nexmo.com')}/sms/json`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      idempotency: { key: input.idempotencyKey, header: 'X-Tixkit-Idempotency-Key' },
      body: form,
      parse: recordBody,
    });
    const messages = Array.isArray(result.data.messages) ? result.data.messages : [];
    const first = messages[0];
    if (!first || typeof first !== 'object' || Array.isArray(first)) {
      throw malformedProviderPayload('vonage', 'send-sms');
    }
    const message = first as Record<string, unknown>;
    if (message.status !== '0') {
      const providerCode =
        typeof message.status === 'string' || typeof message.status === 'number'
          ? String(message.status)
          : undefined;
      throw new ProviderOperationError(
        'vonage.send-sms failed: validation',
        'vonage',
        'send-sms',
        'validation',
        false,
        'rejected',
        true,
        { providerCode },
      );
    }
    const providerMessageId = optionalString(message, 'message-id');
    if (!providerMessageId) throw malformedProviderPayload('vonage', 'send-sms');
    return {
      providerMessageId,
      accepted: true,
    };
  }
}

export class PlivoMessagingClient {
  constructor(
    private readonly config: { authId: string; authToken: string; baseUrl?: string },
    private readonly runtime: ProviderClientRuntime = {},
  ) {}

  async sendSms(input: SmsMessageInput): Promise<ProviderMessageResult> {
    requireCredential(this.config.authId, 'plivo', 'send-sms');
    requireCredential(this.config.authToken, 'plivo', 'send-sms');
    const baseUrl = trimBaseUrl(this.config.baseUrl ?? 'https://api.plivo.com/v1');
    const result = await executeProviderHttp({
      ...this.runtime,
      dependency: 'plivo',
      operation: 'send-sms',
      method: 'POST',
      url: `${baseUrl}/Account/${encodeURIComponent(this.config.authId)}/Message/`,
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.config.authId}:${this.config.authToken}`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
      idempotency: { key: input.idempotencyKey, header: 'X-Tixkit-Idempotency-Key' },
      body: JSON.stringify({
        src: input.from,
        dst: input.to,
        text: input.body,
        url: input.webhookUrl,
      }),
      parse: recordBody,
    });
    const ids = result.data.message_uuid;
    const providerMessageId = Array.isArray(ids)
      ? typeof ids[0] === 'string'
        ? ids[0]
        : undefined
      : typeof ids === 'string'
        ? ids
        : undefined;
    if (!providerMessageId) throw malformedProviderPayload('plivo', 'send-sms');
    return { providerMessageId, accepted: true };
  }
}

export interface ResendEmailInput {
  from: string;
  to: readonly string[];
  subject: string;
  html: string;
  idempotencyKey: string;
  text?: string;
  replyTo?: string;
  headers?: Readonly<Record<string, string>>;
  tags?: ReadonlyArray<{ name: string; value: string }>;
  attachments?: ReadonlyArray<{ filename: string; content: string; contentType: string }>;
}

export class ResendMessagingClient {
  constructor(
    private readonly config: { apiKey: string; baseUrl?: string },
    private readonly runtime: ProviderClientRuntime = {},
  ) {}

  async sendEmail(input: ResendEmailInput): Promise<ProviderMessageResult> {
    requireCredential(this.config.apiKey, 'resend', 'send-email');
    const payload: Record<string, unknown> = {
      from: input.from,
      to: input.to,
      subject: input.subject,
      html: input.html,
    };
    if (input.text) payload.text = input.text;
    if (input.replyTo) payload.reply_to = input.replyTo;
    if (input.headers && Object.keys(input.headers).length > 0) payload.headers = input.headers;
    if (input.tags && input.tags.length > 0) payload.tags = input.tags;
    if (input.attachments && input.attachments.length > 0) {
      payload.attachments = input.attachments.map((attachment) => ({
        filename: attachment.filename,
        content: attachment.content,
        content_type: attachment.contentType,
      }));
    }
    const result = await executeProviderHttp({
      ...this.runtime,
      dependency: 'resend',
      operation: 'send-email',
      method: 'POST',
      url: `${trimBaseUrl(this.config.baseUrl ?? 'https://api.resend.com')}/emails`,
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      idempotency: { key: input.idempotencyKey },
      requestIdHeaders: ['x-resend-request-id'],
      body: JSON.stringify(payload),
      parse: recordBody,
    });
    const nested = result.data.data;
    const providerMessageId =
      optionalString(result.data, 'id') ??
      (nested && typeof nested === 'object' && !Array.isArray(nested)
        ? optionalString(nested as Record<string, unknown>, 'id')
        : undefined);
    if (!providerMessageId) throw malformedProviderPayload('resend', 'send-email');
    return { providerMessageId, accepted: true };
  }
}

function recordBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Expected a provider response object');
  }
  return value as Record<string, unknown>;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function trimBaseUrl(value: string): string {
  return value.replace(/\/+$/u, '');
}

function malformedProviderPayload(dependency: string, operation: string): ProviderOperationError {
  return new ProviderOperationError(
    `${dependency}.${operation} failed: malformed-response`,
    dependency,
    operation,
    'malformed-response',
    false,
    'accepted',
    false,
  );
}

function requireCredential(value: string, dependency: string, operation: string): void {
  if (value.trim()) return;
  throw new ProviderOperationError(
    `${dependency}.${operation} failed: validation`,
    dependency,
    operation,
    'validation',
    false,
    'not-sent',
    false,
    { providerCode: 'configuration_missing' },
  );
}

export * from './stripe.js';
