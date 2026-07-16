import {
  context,
  SpanKind,
  SpanStatusCode,
  trace,
  type Span,
  type SpanAttributes,
} from '@opentelemetry/api';
import type { Resource } from '@opentelemetry/resources';
import type { NodeSDK } from '@opentelemetry/sdk-node';
import type { SpanExporter } from '@opentelemetry/sdk-trace-base';
import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Pushgateway,
  Registry,
} from 'prom-client';
import {
  RUM_MAXIMUM_VALUES,
  RUM_SURFACES,
  RUM_WEB_VITALS,
  type RumSurface,
  type RumWebVital,
} from '@tixkit/domain';

export {
  RUM_MAXIMUM_VALUES,
  RUM_SCHEMA_VERSION,
  RUM_SURFACES,
  RUM_WEB_VITALS,
  type RumSurface,
  type RumWebVital,
} from '@tixkit/domain';

const REDACTED = '[REDACTED]';
const SENSITIVE_KEY_PATTERN =
  /(authorization|cookie|password|secret|token|api[_-]?key|client[_-]?secret|signature|email|phone|card|buyer|attendee)/i;
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const SECRET_VALUE_PATTERN =
  /(bearer\s+)[A-Za-z0-9._~+/=-]+|(sk|pk|rk|tk|whsec|telnyx)_[A-Za-z0-9._~+/=-]+/gi;
const SENSITIVE_QUERY_PARAM_PATTERN =
  /(^|[?&#\s])((?:payment_intent_)?client_secret|access_token|refresh_token|id_token|api[_-]?key|password|email|phone|code|token)=([^&#\s]*)/gi;

let sdk: NodeSDK | undefined;

export type ObservabilityRuntimeConfig = {
  serviceName: string;
  serviceVersion?: string;
  environment?: string;
  otlpEndpoint?: string;
  disabled?: boolean;
};

export type TixkitMetrics = ReturnType<typeof createTixkitMetrics>;

export const pinoRedactionPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["stripe-signature"]',
  'req.headers["telnyx-signature-ed25519"]',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  'headers["x-api-key"]',
  'headers["stripe-signature"]',
  'headers["telnyx-signature-ed25519"]',
  '*.authorization',
  '*.password',
  '*.secret',
  '*.token',
  '*.apiKey',
  '*.clientSecret',
  '*.email',
  '*.phone',
];

export async function createTelemetryResource(
  config: ObservabilityRuntimeConfig,
): Promise<Resource> {
  const { resourceFromAttributes } = await import('@opentelemetry/resources');
  return resourceFromAttributes({
    'service.name': config.serviceName,
    ...(config.serviceVersion ? { 'service.version': config.serviceVersion } : {}),
    ...(config.environment ? { 'deployment.environment': config.environment } : {}),
  });
}

export async function createTraceExporter(
  config: ObservabilityRuntimeConfig,
): Promise<SpanExporter> {
  const { OTLPTraceExporter: _OTLPTraceExporter } =
    await import('@opentelemetry/exporter-trace-otlp-http');
  const traceEndpoint =
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
    formatOtlpTraceEndpoint(config.otlpEndpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT);
  const headers = parseOtlpHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS);
  return new _OTLPTraceExporter({
    ...(traceEndpoint ? { url: traceEndpoint } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  });
}

export function parseOtlpHeaders(value: string | undefined): Record<string, string> {
  if (!value?.trim()) return {};
  const headers: Record<string, string> = {};
  for (const entry of value.split(',')) {
    const separator = entry.indexOf('=');
    if (separator <= 0) throw new Error('OTEL_EXPORTER_OTLP_HEADERS entries must be key=value');
    const key = decodeURIComponent(entry.slice(0, separator).trim()).toLowerCase();
    const headerValue = decodeURIComponent(entry.slice(separator + 1).trim());
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(key) || /[\r\n]/.test(headerValue)) {
      throw new Error('OTEL_EXPORTER_OTLP_HEADERS contains an invalid header');
    }
    if (Object.hasOwn(headers, key)) {
      throw new Error(`OTEL_EXPORTER_OTLP_HEADERS contains duplicate header ${key}`);
    }
    headers[key] = headerValue;
  }
  return headers;
}

export async function startOpenTelemetry(
  config: ObservabilityRuntimeConfig,
): Promise<{ shutdown: () => Promise<void> }> {
  if (config.disabled || process.env.OTEL_SDK_DISABLED === 'true') {
    return { shutdown: async () => undefined };
  }

  if (!sdk) {
    const [{ NodeSDK: _NodeSDK }, { BatchSpanProcessor: _BatchSpanProcessor }] = await Promise.all([
      import('@opentelemetry/sdk-node'),
      import('@opentelemetry/sdk-trace-base'),
    ]);
    sdk = new _NodeSDK({
      resource: await createTelemetryResource(config),
      spanProcessor: new _BatchSpanProcessor(await createTraceExporter(config)),
    });
    sdk.start();
  }

  return {
    shutdown: async () => {
      await sdk?.shutdown();
      sdk = undefined;
    },
  };
}

export async function withSpan<T>(
  spanName: string,
  attributes: SpanAttributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const tracer = trace.getTracer('tixkit');
  const span = tracer.startSpan(spanName, {
    kind: SpanKind.INTERNAL,
    attributes: sanitizeSpanAttributes(attributes),
  });
  return context.with(trace.setSpan(context.active(), span), async () => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      const sanitizedError = redactError(error);
      span.recordException(sanitizedError);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: sanitizedError.message,
      });
      throw error;
    } finally {
      span.end();
    }
  });
}

export function sanitizeSpanAttributes(attributes: SpanAttributes): SpanAttributes {
  const sanitized: SpanAttributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null) continue;
    sanitized[key] = shouldRedactKey(key) ? REDACTED : redactAttributeValue(value);
  }
  return sanitized;
}

export function redactObject<T>(value: T, depth = 0): T {
  if (depth > 8) return REDACTED as T;
  if (Array.isArray(value)) return value.map((item) => redactObject(item, depth + 1)) as T;
  if (!value || typeof value !== 'object') return redactScalar(value) as T;

  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    redacted[key] = shouldRedactKey(key) ? REDACTED : redactObject(entry, depth + 1);
  }
  return redacted as T;
}

export function redactError(error: unknown): Error {
  if (!(error instanceof Error)) return new Error(redactString(String(error)));

  const sanitized = new Error(redactString(error.message));
  sanitized.name = redactString(error.name);
  sanitized.stack = error.stack ? redactString(error.stack) : undefined;
  return sanitized;
}

export function redactErrorFields(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { message: redactString(String(error)) };

  const record = error as Error & {
    code?: unknown;
    statusCode?: unknown;
  };
  return {
    type: redactString(error.name),
    message: redactString(error.message),
    stack: error.stack ? redactString(error.stack) : undefined,
    code: typeof record.code === 'string' ? redactString(record.code) : redactObject(record.code),
    statusCode: redactObject(record.statusCode),
  };
}

export function createTixkitMetrics(serviceName: string) {
  const registry = new Registry();
  registry.setDefaultLabels({ service: serviceName });
  collectDefaultMetrics({ register: registry, prefix: 'tixkit_process_' });

  const httpRequestDuration = new Histogram({
    name: 'tixkit_http_request_duration_seconds',
    help: 'HTTP request latency by method, route, and status code.',
    labelNames: ['method', 'route', 'status_code'],
    buckets: [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });

  const httpRequestErrors = new Counter({
    name: 'tixkit_http_request_errors_total',
    help: 'HTTP responses with a 5xx status code.',
    labelNames: ['method', 'route', 'status_code'],
    registers: [registry],
  });

  const checkoutEvents = new Counter({
    name: 'tixkit_checkout_events_total',
    help: 'Checkout API and workflow events by operation and outcome.',
    labelNames: ['operation', 'outcome'],
    registers: [registry],
  });

  const paymentEvents = new Counter({
    name: 'tixkit_payment_events_total',
    help: 'Payment provider events by operation, provider, and outcome.',
    labelNames: ['operation', 'provider', 'outcome'],
    registers: [registry],
  });

  const refundEvents = new Counter({
    name: 'tixkit_refund_events_total',
    help: 'Refund events by operation, provider, and outcome.',
    labelNames: ['operation', 'provider', 'outcome'],
    registers: [registry],
  });

  const webhookEvents = new Counter({
    name: 'tixkit_webhook_events_total',
    help: 'Inbound and outbound webhook events by operation and outcome.',
    labelNames: ['operation', 'outcome'],
    registers: [registry],
  });

  const exportEvents = new Counter({
    name: 'tixkit_export_events_total',
    help: 'Export events by operation and outcome.',
    labelNames: ['operation', 'outcome'],
    registers: [registry],
  });

  const scanEvents = new Counter({
    name: 'tixkit_scan_events_total',
    help: 'Scanner and check-in events by operation and outcome.',
    labelNames: ['operation', 'outcome'],
    registers: [registry],
  });

  const onboardingEvents = new Counter({
    name: 'tixkit_onboarding_events_total',
    help: 'Privacy-safe onboarding step, validation, abandonment, preview, and publish outcomes.',
    labelNames: ['stage', 'outcome', 'reason_code'],
    registers: [registry],
  });

  const onboardingMilestoneDuration = new Histogram({
    name: 'tixkit_onboarding_milestone_duration_seconds',
    help: 'Elapsed time from durable draft creation to onboarding milestones.',
    labelNames: ['milestone'],
    buckets: [5, 15, 30, 60, 120, 300, 600, 1800, 3600, 86400],
    registers: [registry],
  });

  const rumLcp = new Histogram({
    name: 'tixkit_rum_lcp_seconds',
    help: 'Privacy-safe Largest Contentful Paint samples by bounded buyer surface.',
    labelNames: ['surface'],
    buckets: [0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 10, 30, 60],
    registers: [registry],
  });

  const rumInp = new Histogram({
    name: 'tixkit_rum_inp_seconds',
    help: 'Privacy-safe Interaction to Next Paint samples by bounded buyer surface.',
    labelNames: ['surface'],
    buckets: [0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 1, 2, 5, 10],
    registers: [registry],
  });

  const rumCls = new Histogram({
    name: 'tixkit_rum_cls_score',
    help: 'Privacy-safe Cumulative Layout Shift samples by bounded buyer surface.',
    labelNames: ['surface'],
    buckets: [0.01, 0.025, 0.05, 0.075, 0.1, 0.15, 0.25, 0.5, 1, 2, 5, 10],
    registers: [registry],
  });

  const inventoryActiveHolds = new Gauge({
    name: 'tixkit_inventory_active_holds',
    help: 'Active, non-expired checkout inventory holds.',
    labelNames: ['scope'],
    registers: [registry],
  });

  const temporalActivityDuration = new Histogram({
    name: 'tixkit_temporal_activity_duration_seconds',
    help: 'Temporal activity execution latency by activity and outcome.',
    labelNames: ['activity', 'outcome'],
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300],
    registers: [registry],
  });

  const temporalActivityEvents = new Counter({
    name: 'tixkit_temporal_activity_events_total',
    help: 'Temporal activity completions by activity and outcome.',
    labelNames: ['activity', 'outcome'],
    registers: [registry],
  });

  const migrationEvents = new Counter({
    name: 'tixkit_migration_events_total',
    help: 'Privacy-safe migration outcomes by bounded phase, outcome, and error code.',
    labelNames: ['phase', 'outcome', 'error_code'],
    registers: [registry],
  });

  const migrationProgressAge = new Gauge({
    name: 'tixkit_migration_progress_age_seconds',
    help: 'Seconds since the current migration phase last made worker progress.',
    labelNames: ['phase'],
    registers: [registry],
  });

  return {
    registry,
    contentType: registry.contentType,
    metrics: {
      httpRequestDuration,
      httpRequestErrors,
      checkoutEvents,
      paymentEvents,
      refundEvents,
      webhookEvents,
      exportEvents,
      scanEvents,
      onboardingEvents,
      onboardingMilestoneDuration,
      rumLcp,
      rumInp,
      rumCls,
      inventoryActiveHolds,
      temporalActivityDuration,
      temporalActivityEvents,
      migrationEvents,
      migrationProgressAge,
    },
  };
}

export function observeRumWebVital(
  metrics: TixkitMetrics,
  input: { surface: RumSurface; metric: RumWebVital; value: number },
): void {
  if (!RUM_SURFACES.includes(input.surface) || !RUM_WEB_VITALS.includes(input.metric)) {
    throw new TypeError('RUM surface and metric must use the bounded public contract');
  }
  if (
    !Number.isFinite(input.value) ||
    input.value < 0 ||
    input.value > RUM_MAXIMUM_VALUES[input.metric]
  ) {
    throw new TypeError('RUM value is outside the bounded public contract');
  }
  const labels = { surface: input.surface };
  if (input.metric === 'LCP') metrics.metrics.rumLcp.observe(labels, input.value);
  else if (input.metric === 'INP') metrics.metrics.rumInp.observe(labels, input.value);
  else metrics.metrics.rumCls.observe(labels, input.value);
}

const MIGRATION_PHASES = new Set(['prepare', 'commit', 'reconcile', 'rollback']);
const MIGRATION_ERROR_CODES = new Set([
  'none',
  'failed',
  'conflict',
  'scope_violation',
  'reconciliation_required',
  'rollback_refused',
  'side_effect_attempt',
]);

export function observeMigrationOperation(
  metrics: TixkitMetrics,
  input: {
    phase: string;
    outcome: string;
    errorCode?: string;
  },
): void {
  const phase = MIGRATION_PHASES.has(input.phase) ? input.phase : 'reconcile';
  const errorCode = MIGRATION_ERROR_CODES.has(input.errorCode ?? 'none')
    ? (input.errorCode ?? 'none')
    : 'failed';
  const outcome = input.outcome === 'ok' ? 'ok' : 'error';
  metrics.metrics.migrationEvents.inc({
    phase,
    outcome,
    error_code: errorCode,
  });
}

export function observeTemporalActivity(
  metrics: TixkitMetrics,
  input: { activity: string; outcome: string; durationSeconds: number },
): void {
  metrics.metrics.temporalActivityEvents.inc({
    activity: input.activity,
    outcome: input.outcome,
  });
  metrics.metrics.temporalActivityDuration.observe(
    { activity: input.activity, outcome: input.outcome },
    input.durationSeconds,
  );
}

export async function pushMetricsToGateway(
  metrics: TixkitMetrics,
  input: { gatewayUrl?: string; jobName: string; instance?: string },
): Promise<void> {
  if (!input.gatewayUrl) return;
  const gateway = new Pushgateway(input.gatewayUrl, {}, metrics.registry);
  await gateway.push({
    jobName: input.jobName,
    ...(input.instance ? { groupings: { instance: input.instance } } : {}),
  });
}

export async function deleteMetricsFromGateway(input: {
  gatewayUrl?: string;
  jobName: string;
  instance?: string;
}): Promise<void> {
  if (!input.gatewayUrl) return;
  const gateway = new Pushgateway(input.gatewayUrl);
  await gateway.delete({
    jobName: input.jobName,
    ...(input.instance ? { groupings: { instance: input.instance } } : {}),
  });
}

function formatOtlpTraceEndpoint(endpoint?: string): string | undefined {
  if (!endpoint) return undefined;
  const normalized = endpoint.replace(/\/+$/, '');
  return normalized.endsWith('/v1/traces') ? normalized : `${normalized}/v1/traces`;
}

function shouldRedactKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

function redactScalar(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return redactString(value);
}

function redactAttributeValue(
  value: unknown,
): string | number | boolean | string[] | number[] | boolean[] {
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    const filtered = value.filter(
      (item): item is string | number | boolean =>
        typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean',
    );
    if (filtered.every((item) => typeof item === 'number')) return filtered;
    if (filtered.every((item) => typeof item === 'boolean')) return filtered;
    return filtered.map((item) => String(item)).map(redactString);
  }
  return String(value);
}

export function redactString(value: string): string {
  return value
    .replace(EMAIL_PATTERN, REDACTED)
    .replace(SENSITIVE_QUERY_PARAM_PATTERN, (_match, prefix: string, name: string) => {
      return `${prefix}${name}=${REDACTED}`;
    })
    .replace(SECRET_VALUE_PATTERN, (_match, bearerPrefix: string | undefined) =>
      bearerPrefix ? `${bearerPrefix}${REDACTED}` : REDACTED,
    );
}
