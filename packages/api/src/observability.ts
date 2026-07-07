import { createHash, timingSafeEqual } from 'node:crypto';
import { SpanKind, SpanStatusCode, trace, type Span } from '@opentelemetry/api';
import type { Database } from '@tixkit/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  createTixkitMetrics,
  redactError,
  sanitizeSpanAttributes,
  startOpenTelemetry,
  type TixkitMetrics,
} from '@tixkit/shared';
import { config } from './config/index.js';

type RequestObservabilityState = {
  span: Span;
  startedAt: bigint;
};

type MetricsRouteOptions = {
  bearerToken?: string;
  requireBearerToken?: boolean;
};

export type ApiObservability = {
  metrics: TixkitMetrics;
};

export async function createApiObservability(): Promise<ApiObservability> {
  await startOpenTelemetry({
    serviceName: 'tixkit-api',
    serviceVersion: process.env.npm_package_version,
    environment: config.nodeEnv,
    otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  });

  return { metrics: createTixkitMetrics('tixkit-api') };
}

export function registerObservability(app: FastifyInstance, observability: ApiObservability): void {
  app.decorate('observability', observability);

  app.addHook('onRequest', (request, _reply, done) => {
    const span = trace.getTracer('tixkit-api').startSpan('http.request', {
      kind: SpanKind.SERVER,
      attributes: sanitizeSpanAttributes({
        'http.request.method': request.method,
        'url.path': getRequestPathname(request.url),
        'tixkit.request_id': request.id,
      }),
    });
    request.observability = { span, startedAt: process.hrtime.bigint() };
    done();
  });

  app.addHook('preHandler', (request, _reply, done) => {
    annotateRequestSpan(request);
    done();
  });

  app.addHook('onError', (request, _reply, error, done) => {
    const sanitizedError = redactError(error);
    request.observability?.span.recordException(sanitizedError);
    request.observability?.span.setStatus({
      code: SpanStatusCode.ERROR,
      message: sanitizedError.message,
    });
    done();
  });

  app.addHook('onResponse', (request, reply, done) => {
    finishRequestObservability(observability.metrics, request, reply);
    done();
  });
}

export function registerMetricsRoute(
  app: FastifyInstance,
  observability: ApiObservability,
  dbProvider: () => Database,
  options: MetricsRouteOptions = {},
): void {
  const bearerToken = options.bearerToken ?? config.metricsBearerToken;
  const isLocalMetricsEnvironment = config.nodeEnv === 'development' || config.nodeEnv === 'test';
  const requireBearerToken =
    options.requireBearerToken ?? (!isLocalMetricsEnvironment || bearerToken.length > 0);

  app.get(
    '/metrics',
    {
      compress: false,
      config: {
        rateLimit: false,
      },
    },
    async (request, reply) => {
      if (requireBearerToken && !isAuthorizedMetricsRequest(request, bearerToken)) {
        return reply.status(401).send({
          error: {
            code: 'UNAUTHORIZED',
            message: 'Unauthorized',
            requestId: request.id,
          },
        });
      }

      await refreshInventoryHoldGauge(observability.metrics, dbProvider());
      const body = await observability.metrics.registry.metrics();
      return reply.header('Content-Type', observability.metrics.contentType).send(body);
    },
  );
}

function isAuthorizedMetricsRequest(request: FastifyRequest, bearerToken: string): boolean {
  if (!bearerToken) return false;

  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return false;

  return constantTimeEquals(authHeader.substring(7), bearerToken);
}

function constantTimeEquals(actual: string, expected: string): boolean {
  const actualHash = createHash('sha256').update(actual).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(actualHash, expectedHash);
}

export async function refreshInventoryHoldGauge(
  metrics: TixkitMetrics,
  db: Database,
): Promise<void> {
  const row = await db
    .selectFrom('checkout_holds')
    .select(({ fn }) => fn.sum<number>('quantity').as('quantity'))
    .where('status', '=', 'active')
    .where('expires_at', '>', new Date())
    .executeTakeFirst();
  metrics.metrics.inventoryActiveHolds.set({ scope: 'global' }, Number(row?.quantity ?? 0));
}

function finishRequestObservability(
  metrics: TixkitMetrics,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  const state = request.observability;
  if (!state) return;

  const route = getRouteLabel(request);
  const statusCode = String(reply.statusCode);
  const durationSeconds = Number(process.hrtime.bigint() - state.startedAt) / 1_000_000_000;
  const labels = { method: request.method, route, status_code: statusCode };

  state.span.setAttributes(
    sanitizeSpanAttributes({
      'http.route': route,
      'http.response.status_code': reply.statusCode,
      'tixkit.tenant_id': request.principal?.tenantId,
      'tixkit.organization_ids': request.principal?.organizationIds.join(','),
      'tixkit.brand_ids': request.principal?.brandIds?.join(','),
    }),
  );

  if (reply.statusCode >= 500) {
    state.span.setStatus({ code: SpanStatusCode.ERROR });
    metrics.metrics.httpRequestErrors.inc(labels);
  } else {
    state.span.setStatus({ code: SpanStatusCode.OK });
  }

  metrics.metrics.httpRequestDuration.observe(labels, durationSeconds);
  recordDomainMetrics(metrics, route, reply.statusCode);
  state.span.end();
}

function annotateRequestSpan(request: FastifyRequest): void {
  request.observability?.span.setAttributes(
    sanitizeSpanAttributes({
      'http.route': getRouteLabel(request),
      'tixkit.tenant_id': request.principal?.tenantId,
      'tixkit.organization_ids': request.principal?.organizationIds.join(','),
      'tixkit.brand_ids': request.principal?.brandIds?.join(','),
    }),
  );
}

function recordDomainMetrics(metrics: TixkitMetrics, route: string, statusCode: number): void {
  const outcome = statusCode >= 500 ? 'error' : statusCode >= 400 ? 'rejected' : 'ok';
  if (route.includes('/checkout')) {
    metrics.metrics.checkoutEvents.inc({ operation: 'api', outcome });
  }
  if (route.includes('/payment')) {
    metrics.metrics.paymentEvents.inc({ operation: 'api', provider: 'stripe', outcome });
  }
  if (route.includes('/refund')) {
    metrics.metrics.refundEvents.inc({ operation: 'api', provider: 'stripe', outcome });
  }
  if (route.includes('/webhooks')) {
    metrics.metrics.webhookEvents.inc({ operation: 'inbound', outcome });
  }
  if (route.includes('/exports')) {
    metrics.metrics.exportEvents.inc({ operation: 'api', outcome });
  }
  if (route.includes('/check-in') || route.includes('/scan')) {
    metrics.metrics.scanEvents.inc({ operation: 'api', outcome });
  }
}

function getRouteLabel(request: FastifyRequest): string {
  return request.routeOptions.url ?? request.routerPath ?? getRequestPathname(request.url);
}

function getRequestPathname(rawUrl: string): string {
  try {
    return new URL(rawUrl, 'http://tixkit.local').pathname || '/';
  } catch {
    const queryIndex = rawUrl.indexOf('?');
    const fragmentIndex = rawUrl.indexOf('#');
    const endIndexes = [queryIndex, fragmentIndex].filter((index) => index >= 0);
    const endIndex = endIndexes.length > 0 ? Math.min(...endIndexes) : rawUrl.length;
    return rawUrl.slice(0, endIndex) || '/';
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    observability: ApiObservability;
  }

  interface FastifyRequest {
    observability?: RequestObservabilityState;
    routerPath?: string;
  }
}
