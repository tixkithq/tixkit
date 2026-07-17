import { createHash } from 'node:crypto';
import { STATUS_CODES } from 'node:http';
import { SpanKind, SpanStatusCode, trace, type Span } from '@opentelemetry/api';
import { validateExactProviderRequestId } from './incident-diagnostics.js';

const DEFAULT_DEADLINE_MS = 10_000;
const DEFAULT_BODY_PREVIEW_BYTES = 1_024;
const DEFAULT_RESPONSE_BYTES = 64 * 1_024;
const RETRYABLE_SERVER_STATUSES = new Set([500, 502, 503, 504]);
const MAX_IDEMPOTENCY_KEY_BYTES = 255;
const SAFE_DIAGNOSTIC_KEYS = new Set(['code', 'type', 'error_code']);
const SAFE_DIAGNOSTIC_ENVELOPES = new Set(['error', 'errors']);
const SAFE_CONTENT_TYPES = new Set([
  'application/json',
  'application/octet-stream',
  'application/problem+json',
  'application/x-www-form-urlencoded',
  'application/xml',
  'text/html',
  'text/plain',
  'text/xml',
]);
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
export type ProviderResponseClassification = 'json' | 'html' | 'text' | 'empty' | 'invalid-utf8';

export interface ProviderDiagnosticEnvelope {
  status: number;
  statusText: string;
  contentType?: string;
  responseBytes: number;
  responseClassification: ProviderResponseClassification;
  bodyDigest: string;
  retryAfterMs?: number;
  providerRequestId?: string;
}

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

export interface ProviderDiagnosticEvent {
  dependency: string;
  operation: string;
  method: string;
  envelope: ProviderDiagnosticEnvelope;
}

export interface ProviderIncidentScope {
  tenantId: string;
  organizationId: string;
}

export interface ProviderExactRequestIdEvent {
  dependency: string;
  operation: string;
  exactRequestId: string;
  requestIdHash: string;
  scope: ProviderIncidentScope;
}

export interface ProviderClientRuntime {
  deadlineMs?: number;
  fetch?: typeof globalThis.fetch;
  onTelemetry?: (event: Readonly<ProviderTelemetryEvent>) => void;
  onDiagnostic?: (event: Readonly<ProviderDiagnosticEvent>) => void | Promise<void>;
  onExactRequestId?: (event: Readonly<ProviderExactRequestIdEvent>) => void | Promise<void>;
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
      diagnostic?: ProviderDiagnosticEnvelope;
    } = {},
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
  }

  forRetry(): ProviderOperationError {
    const diagnostic = safeDiagnosticEnvelope(this.details.diagnostic);
    const safeDetails = {
      ...(this.details.status !== undefined &&
      Number.isSafeInteger(this.details.status) &&
      this.details.status >= 100 &&
      this.details.status <= 599
        ? { status: this.details.status }
        : {}),
      ...(this.details.providerCode &&
      (/^sha256:[a-f0-9]{64}$/u.test(this.details.providerCode) ||
        /^[0-9]{1,3}$/u.test(this.details.providerCode))
        ? { providerCode: this.details.providerCode }
        : {}),
      ...(this.details.providerRequestId &&
      /^sha256:[a-f0-9]{64}$/u.test(this.details.providerRequestId)
        ? { providerRequestId: this.details.providerRequestId }
        : {}),
      ...(this.details.retryAfterMs !== undefined &&
      Number.isSafeInteger(this.details.retryAfterMs) &&
      this.details.retryAfterMs >= 0 &&
      this.details.retryAfterMs <= 86_400_000
        ? { retryAfterMs: this.details.retryAfterMs }
        : {}),
      ...(diagnostic === undefined ? {} : { diagnostic }),
    };
    return new ProviderOperationError(
      this.message,
      this.dependency,
      this.operation,
      this.kind,
      this.retryable,
      this.deliveryState,
      false,
      safeDetails,
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
  incidentScope?: ProviderIncidentScope;
}

export interface ProviderHttpResult<T> {
  data: T;
  status: number;
  providerRequestId?: string;
  diagnostic: ProviderDiagnosticEnvelope;
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
  let rejectInterruption: (() => void) | undefined;
  const interruption = new Promise<never>((_resolve, reject) => {
    rejectInterruption = () => reject(new Error('Provider operation interrupted'));
  });
  void interruption.catch(() => undefined);
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException('Provider deadline exceeded', 'TimeoutError'));
    rejectInterruption?.();
  }, deadlineMs);
  const onCallerAbort = () => {
    controller.abort(new DOMException('Provider operation cancelled', 'AbortError'));
    rejectInterruption?.();
  };
  request.signal?.addEventListener('abort', onCallerAbort, { once: true });
  if (request.signal?.aborted) onCallerAbort();

  try {
    const headers = new Headers(request.headers);
    if (request.idempotency) {
      requireHttpIdempotencyKey(request, request.idempotency.key);
      headers.set(request.idempotency.header ?? 'Idempotency-Key', request.idempotency.key);
    }
    if (request.apiVersion) headers.set(request.apiVersion.header, request.apiVersion.value);

    let response: Response;
    try {
      if (controller.signal.aborted) {
        throw operationError(request, 'cancelled', false, 'not-sent', false, {});
      }
      response = await Promise.race([
        (request.fetch ?? globalThis.fetch)(request.url, {
          method,
          headers,
          body: request.body,
          signal: controller.signal,
          redirect: 'error',
        }),
        interruption,
      ]);
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

    const rawProviderRequestId = extractProviderRequestIdValue(
      response.headers,
      request.requestIdHeaders,
    );
    const providerRequestId =
      rawProviderRequestId === undefined
        ? undefined
        : `sha256:${createHash('sha256').update(rawProviderRequestId).digest('hex')}`;
    const exactProviderRequestId = safeExactProviderRequestId(rawProviderRequestId);
    emitExactRequestId(request, exactProviderRequestId, providerRequestId);
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
    let responseBody: BoundedResponseBody;
    try {
      responseBody = await readBoundedBody(response, maxResponseBytes, interruption);
    } catch {
      if (timedOut) {
        throw operationError(request, 'timeout', !sideEffecting, 'unknown', false, {});
      }
      if (request.signal?.aborted) {
        throw operationError(request, 'cancelled', false, 'unknown', false, {});
      }
      throw operationError(
        request,
        'malformed-response',
        false,
        response.ok ? 'accepted' : 'unknown',
        false,
        { status: response.status, providerRequestId },
      );
    }
    const diagnostic = createDiagnosticEnvelope(
      response,
      responseBody,
      retryAfterMs,
      providerRequestId,
    );
    emitDiagnostic(request, {
      dependency: request.dependency,
      operation: request.operation,
      method,
      envelope: diagnostic,
    });
    if (response.status >= 300 && response.status < 400) {
      throw operationError(request, 'malformed-response', false, 'unknown', false, {
        status: response.status,
        providerRequestId,
        retryAfterMs,
        diagnostic,
      });
    }
    if (responseBody.classification === 'invalid-utf8') {
      throw operationError(
        request,
        'malformed-response',
        false,
        response.ok ? 'accepted' : 'unknown',
        false,
        {
          status: response.status,
          providerRequestId,
          retryAfterMs,
          diagnostic,
        },
      );
    }
    const rawBody = responseBody.text ?? '';
    const bodyPreview = sanitizeBodyPreview(
      rawBody,
      request.bodyPreviewBytes ?? DEFAULT_BODY_PREVIEW_BYTES,
    );
    const parsed = parseResponseBody(rawBody);

    if (!response.ok) {
      const kind = classifyStatus(response.status);
      const retryable =
        kind === 'rate-limit' ||
        (kind === 'server' && RETRYABLE_SERVER_STATUSES.has(response.status) && !sideEffecting);
      const deliveryState = kind === 'validation' || kind === 'rate-limit' ? 'rejected' : 'unknown';
      throw operationError(request, kind, retryable, deliveryState, deliveryState === 'rejected', {
        status: response.status,
        providerCode: extractProviderCode(parsed),
        providerRequestId,
        retryAfterMs,
        bodyPreview,
        diagnostic,
      });
    }

    const expectsJson = request.expectJson ?? true;
    if (expectsJson && rawBody.trim().length === 0 && !request.allowEmptySuccess) {
      throw operationError(request, 'malformed-response', false, 'accepted', false, {
        status: response.status,
        providerRequestId,
        diagnostic,
      });
    }
    if (expectsJson && parsed === undefined) {
      throw operationError(request, 'malformed-response', false, 'accepted', false, {
        status: response.status,
        providerRequestId,
        bodyPreview,
        diagnostic,
      });
    }

    let data: T;
    try {
      data = request.parse ? request.parse(parsed) : ((expectsJson ? parsed : rawBody) as T);
    } catch (error) {
      if (
        error instanceof ProviderOperationError &&
        error.dependency === request.dependency &&
        error.operation === request.operation
      ) {
        const providerCode = safeProviderCode(error.details.providerCode);
        throw operationError(
          request,
          error.kind,
          error.retryable,
          error.deliveryState,
          error.safeToFailover,
          {
            status: response.status,
            ...(providerCode === undefined ? {} : { providerCode }),
            ...(providerRequestId === undefined ? {} : { providerRequestId }),
            diagnostic,
          },
        );
      }
      throw operationError(request, 'malformed-response', false, 'accepted', false, {
        status: response.status,
        providerRequestId,
        bodyPreview,
        diagnostic,
      });
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
    return {
      data,
      status: response.status,
      providerRequestId,
      diagnostic,
      durationMs,
    };
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
  if (status >= 500 && status <= 599) return 'server';
  return 'validation';
}

function safeProviderCode(value: string | undefined): string | undefined {
  return value && (/^[0-9]{1,3}$/u.test(value) || /^sha256:[a-f0-9]{64}$/u.test(value))
    ? value
    : undefined;
}

function requireHttpIdempotencyKey(
  request: Pick<ProviderHttpRequest<unknown>, 'dependency' | 'operation'>,
  value: string,
): void {
  const invalid =
    typeof value !== 'string' ||
    !value.trim() ||
    value !== value.trim() ||
    Buffer.byteLength(value, 'utf8') > MAX_IDEMPOTENCY_KEY_BYTES ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    });
  if (invalid) {
    throw operationError(request, 'validation', false, 'not-sent', false, {
      providerCode: 'idempotency_invalid',
    });
  }
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

interface BoundedResponseBody {
  bytes: Uint8Array;
  text?: string;
  classification: ProviderResponseClassification;
  digest: string;
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
  interruption: Promise<never>,
): Promise<BoundedResponseBody> {
  if (!response.body) return boundedResponseBody(new Uint8Array());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let complete = false;
  try {
    while (true) {
      const result = await Promise.race([reader.read(), interruption]);
      if (result.done) {
        complete = true;
        break;
      }
      total += result.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel('Provider response exceeded the configured byte limit');
        throw new RangeError('Provider response exceeded the configured byte limit');
      }
      chunks.push(result.value);
    }
  } finally {
    if (!complete) {
      void reader.cancel('Provider response read interrupted').catch(() => undefined);
    }
    try {
      reader.releaseLock();
    } catch {
      // The pending read still owns its rejection handler from Promise.race. Cancellation
      // above remains best-effort for non-conforming injected stream implementations.
    }
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return boundedResponseBody(body, response.headers.get('content-type'));
}

function boundedResponseBody(
  bytes: Uint8Array,
  contentTypeValue?: string | null,
): BoundedResponseBody {
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (bytes.byteLength === 0) {
    return { bytes, text: '', classification: 'empty', digest };
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { bytes, classification: 'invalid-utf8', digest };
  }
  const trimmed = text.trim();
  let classification: ProviderResponseClassification = 'text';
  try {
    JSON.parse(trimmed);
    classification = 'json';
  } catch {
    const contentType = safeContentType(contentTypeValue);
    if (contentType === 'text/html' || /^\s*(?:<!doctype\s+html|<html(?:\s|>))/iu.test(trimmed)) {
      classification = 'html';
    }
  }
  return { bytes, text, classification, digest };
}

function createDiagnosticEnvelope(
  response: Response,
  body: BoundedResponseBody,
  retryAfterMs: number | undefined,
  providerRequestId: string | undefined,
): ProviderDiagnosticEnvelope {
  return Object.freeze({
    status: response.status,
    statusText: canonicalStatusText(response.status),
    ...(safeContentType(response.headers.get('content-type')) === undefined
      ? {}
      : { contentType: safeContentType(response.headers.get('content-type')) }),
    responseBytes: body.bytes.byteLength,
    responseClassification: body.classification,
    bodyDigest: body.digest,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(providerRequestId === undefined ? {} : { providerRequestId }),
  });
}

function canonicalStatusText(status: number): string {
  return STATUS_CODES[status] ?? '[UNRECOGNIZED]';
}

function safeContentType(value: string | null | undefined): string | undefined {
  const mediaType = value?.split(';', 1)[0]?.trim().toLowerCase();
  return mediaType && SAFE_CONTENT_TYPES.has(mediaType) ? mediaType : undefined;
}

function safeDiagnosticEnvelope(
  value: ProviderDiagnosticEnvelope | undefined,
): ProviderDiagnosticEnvelope | undefined {
  if (
    !value ||
    !Number.isSafeInteger(value.status) ||
    value.status < 100 ||
    value.status > 599 ||
    !['json', 'html', 'text', 'empty', 'invalid-utf8'].includes(value.responseClassification) ||
    !Number.isSafeInteger(value.responseBytes) ||
    value.responseBytes < 0 ||
    value.responseBytes > 1024 * 1024 ||
    !/^sha256:[a-f0-9]{64}$/u.test(value.bodyDigest) ||
    (value.providerRequestId !== undefined &&
      !/^sha256:[a-f0-9]{64}$/u.test(value.providerRequestId)) ||
    (value.retryAfterMs !== undefined &&
      (!Number.isSafeInteger(value.retryAfterMs) ||
        value.retryAfterMs < 0 ||
        value.retryAfterMs > 86_400_000))
  ) {
    return undefined;
  }
  const statusText = canonicalStatusText(value.status);
  const contentType = safeContentType(value.contentType);
  return Object.freeze({
    status: value.status,
    statusText,
    ...(contentType === undefined ? {} : { contentType }),
    responseBytes: value.responseBytes,
    responseClassification: value.responseClassification,
    bodyDigest: value.bodyDigest,
    ...(value.retryAfterMs === undefined ? {} : { retryAfterMs: value.retryAfterMs }),
    ...(value.providerRequestId === undefined
      ? {}
      : { providerRequestId: value.providerRequestId }),
  });
}

export function extractProviderRequestId(
  headers: Headers,
  preferred: readonly string[] = [],
): string | undefined {
  const raw = extractProviderRequestIdValue(headers, preferred);
  return raw === undefined ? undefined : `sha256:${createHash('sha256').update(raw).digest('hex')}`;
}

function extractProviderRequestIdValue(
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
    if (!value) continue;
    return value;
  }
  return undefined;
}

function safeExactProviderRequestId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    return validateExactProviderRequestId(value);
  } catch {
    return undefined;
  }
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

function emitDiagnostic(request: ProviderClientRuntime, event: ProviderDiagnosticEvent): void {
  try {
    const exported = request.onDiagnostic?.(Object.freeze({ ...event }));
    if (exported) void Promise.resolve(exported).catch(() => undefined);
  } catch {
    // Diagnostic export is best-effort and must never alter provider operation semantics.
  }
}

function emitExactRequestId(
  request: ProviderHttpRequest<unknown>,
  exactRequestId: string | undefined,
  requestIdHash: string | undefined,
): void {
  if (
    exactRequestId === undefined ||
    requestIdHash === undefined ||
    request.incidentScope === undefined ||
    request.onExactRequestId === undefined
  )
    return;
  try {
    const callback = request.onExactRequestId(
      Object.freeze({
        dependency: request.dependency,
        operation: request.operation,
        exactRequestId,
        requestIdHash,
        scope: Object.freeze({ ...request.incidentScope }),
      }),
    );
    if (callback) void Promise.resolve(callback).catch(() => undefined);
  } catch {
    // Privileged incident capture is best-effort and must not alter provider semantics.
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
  incidentScope?: ProviderIncidentScope;
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
    const result = await executeProviderHttp<ProviderMessageResult>({
      ...this.runtime,
      dependency: 'telnyx',
      operation: 'send-sms',
      method: 'POST',
      url: `${providerBaseUrl(
        this.config.baseUrl ?? 'https://api.telnyx.com/v2',
        'api.telnyx.com',
        'telnyx',
        'send-sms',
      )}/messages`,
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      idempotency: { key: input.idempotencyKey },
      requestIdHeaders: ['x-telnyx-request-id'],
      incidentScope: input.incidentScope,
      body: JSON.stringify({
        from: input.from,
        to: input.to,
        text: input.body,
        type: 'SMS',
        webhook_url: input.webhookUrl,
        use_profile_webhooks: !input.webhookUrl,
      }),
      parse: telnyxMessageResult,
    });
    return result.data;
  }
}

export class TwilioMessagingClient {
  constructor(
    private readonly config: {
      accountSid: string;
      authToken: string;
      baseUrl?: string;
    },
    private readonly runtime: ProviderClientRuntime = {},
  ) {}

  async sendSms(input: SmsMessageInput): Promise<ProviderMessageResult> {
    requireCredential(this.config.accountSid, 'twilio', 'send-sms');
    requireCredential(this.config.authToken, 'twilio', 'send-sms');
    const form = new URLSearchParams({
      From: input.from,
      To: input.to,
      Body: input.body,
    });
    if (input.webhookUrl) form.set('StatusCallback', input.webhookUrl);
    const baseUrl = providerBaseUrl(
      this.config.baseUrl ?? 'https://api.twilio.com/2010-04-01',
      'api.twilio.com',
      'twilio',
      'send-sms',
    );
    const result = await executeProviderHttp<ProviderMessageResult>({
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
      incidentScope: input.incidentScope,
      body: form,
      parse: twilioMessageResult,
    });
    return result.data;
  }
}

export class VonageMessagingClient {
  constructor(
    private readonly config: {
      apiKey: string;
      apiSecret: string;
      baseUrl?: string;
    },
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
    const result = await executeProviderHttp<ProviderMessageResult>({
      ...this.runtime,
      dependency: 'vonage',
      operation: 'send-sms',
      method: 'POST',
      url: `${providerBaseUrl(
        this.config.baseUrl ?? 'https://rest.nexmo.com',
        'rest.nexmo.com',
        'vonage',
        'send-sms',
      )}/sms/json`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      idempotency: {
        key: input.idempotencyKey,
        header: 'X-Tixkit-Idempotency-Key',
      },
      incidentScope: input.incidentScope,
      body: form,
      parse: vonageMessageResult,
    });
    return result.data;
  }
}

export class PlivoMessagingClient {
  constructor(
    private readonly config: {
      authId: string;
      authToken: string;
      baseUrl?: string;
    },
    private readonly runtime: ProviderClientRuntime = {},
  ) {}

  async sendSms(input: SmsMessageInput): Promise<ProviderMessageResult> {
    requireCredential(this.config.authId, 'plivo', 'send-sms');
    requireCredential(this.config.authToken, 'plivo', 'send-sms');
    const baseUrl = providerBaseUrl(
      this.config.baseUrl ?? 'https://api.plivo.com/v1',
      'api.plivo.com',
      'plivo',
      'send-sms',
    );
    const result = await executeProviderHttp<ProviderMessageResult>({
      ...this.runtime,
      dependency: 'plivo',
      operation: 'send-sms',
      method: 'POST',
      url: `${baseUrl}/Account/${encodeURIComponent(this.config.authId)}/Message/`,
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.config.authId}:${this.config.authToken}`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
      idempotency: {
        key: input.idempotencyKey,
        header: 'X-Tixkit-Idempotency-Key',
      },
      incidentScope: input.incidentScope,
      body: JSON.stringify({
        src: input.from,
        dst: input.to,
        text: input.body,
        url: input.webhookUrl,
      }),
      parse: plivoMessageResult,
    });
    return result.data;
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
  attachments?: ReadonlyArray<{
    filename: string;
    content: string;
    contentType: string;
  }>;
  incidentScope?: ProviderIncidentScope;
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
    const result = await executeProviderHttp<ProviderMessageResult>({
      ...this.runtime,
      dependency: 'resend',
      operation: 'send-email',
      method: 'POST',
      url: `${providerBaseUrl(
        this.config.baseUrl ?? 'https://api.resend.com',
        'api.resend.com',
        'resend',
        'send-email',
      )}/emails`,
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      idempotency: { key: input.idempotencyKey },
      requestIdHeaders: ['x-resend-request-id'],
      incidentScope: input.incidentScope,
      body: JSON.stringify(payload),
      parse: resendMessageResult,
    });
    return result.data;
  }
}

function telnyxMessageResult(value: unknown): ProviderMessageResult {
  const body = recordBody(value);
  const nested = body.data;
  const providerMessageId =
    optionalString(body, 'id') ??
    (nested && typeof nested === 'object' && !Array.isArray(nested)
      ? optionalString(nested as Record<string, unknown>, 'id')
      : undefined);
  if (!providerMessageId) throw malformedProviderPayload('telnyx', 'send-sms');
  return { providerMessageId, accepted: true };
}

function twilioMessageResult(value: unknown): ProviderMessageResult {
  const providerMessageId = optionalString(recordBody(value), 'sid');
  if (!providerMessageId) throw malformedProviderPayload('twilio', 'send-sms');
  return { providerMessageId, accepted: true };
}

function vonageMessageResult(value: unknown): ProviderMessageResult {
  const body = recordBody(value);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const first = messages[0];
  if (!first || typeof first !== 'object' || Array.isArray(first)) {
    throw malformedProviderPayload('vonage', 'send-sms');
  }
  const message = first as Record<string, unknown>;
  const providerCode = message.status;
  if (typeof providerCode !== 'string' || !/^\d{1,3}$/u.test(providerCode)) {
    throw malformedProviderPayload('vonage', 'send-sms');
  }
  if (providerCode !== '0') {
    const semantic = vonageSemanticFailure(providerCode);
    throw new ProviderOperationError(
      `vonage.send-sms failed: ${semantic.kind}`,
      'vonage',
      'send-sms',
      semantic.kind,
      semantic.retryable,
      'rejected',
      true,
      { providerCode },
    );
  }
  const providerMessageId = optionalString(message, 'message-id');
  if (!providerMessageId) throw malformedProviderPayload('vonage', 'send-sms');
  return { providerMessageId, accepted: true };
}

function plivoMessageResult(value: unknown): ProviderMessageResult {
  const ids = recordBody(value).message_uuid;
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

function resendMessageResult(value: unknown): ProviderMessageResult {
  const body = recordBody(value);
  const nested = body.data;
  const providerMessageId =
    optionalString(body, 'id') ??
    (nested && typeof nested === 'object' && !Array.isArray(nested)
      ? optionalString(nested as Record<string, unknown>, 'id')
      : undefined);
  if (!providerMessageId) throw malformedProviderPayload('resend', 'send-email');
  return { providerMessageId, accepted: true };
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

export function providerBaseUrl(
  value: string,
  expectedHostname: string,
  dependency: string,
  operation: string,
): string {
  if (
    !value ||
    value.length > 2_048 ||
    value !== value.trim() ||
    value.includes('\\') ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 32 || codePoint === 127;
    })
  ) {
    throw providerConfigurationError(dependency, operation);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw providerConfigurationError(dependency, operation);
  }
  const testSafeInjection = parsed.hostname.endsWith('.test') && process.env.NODE_ENV === 'test';
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.port !== '' && !testSafeInjection) ||
    (parsed.hostname !== expectedHostname && !testSafeInjection)
  ) {
    throw providerConfigurationError(dependency, operation);
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/u, '')}`;
}

function providerConfigurationError(dependency: string, operation: string): ProviderOperationError {
  return new ProviderOperationError(
    `${dependency}.${operation} failed: validation`,
    dependency,
    operation,
    'validation',
    false,
    'not-sent',
    false,
    { providerCode: 'configuration_invalid' },
  );
}

function vonageSemanticFailure(status: string | undefined): {
  kind: ProviderFailureKind;
  retryable: boolean;
} {
  if (status === '1') return { kind: 'rate-limit', retryable: true };
  if (status === '5') return { kind: 'server', retryable: true };
  return { kind: 'validation', retryable: false };
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
export * from './incident-diagnostics.js';
