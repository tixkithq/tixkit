import Fastify, { type FastifyInstance, type FastifyRequest, type RouteOptions } from 'fastify';
import compress from '@fastify/compress';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { RateLimitPluginOptions } from '@fastify/rate-limit';
import { ulid } from 'ulid';
import { Redis } from 'ioredis';
import { BrandRepository, createDb, type Database } from '@tixkit/db';
import { pinoRedactionPaths, redactErrorFields, redactObject, redactString } from '@tixkit/shared';
import { config } from './config/index.js';
import { ClerkAuthService, createAuthMiddleware } from './auth/clerk.js';
import { createAuthProvider } from './auth/providers.js';
import type { AuthProvider } from '@tixkit/shared';
import { PricingEngine } from './services/pricing.js';
import { InventoryService } from './services/inventory.js';
import { QrService } from './services/qr.js';
import { TemporalClient } from './services/temporal.js';
import { startMigrationLifecycleDispatcher } from './services/migration-lifecycle-dispatcher.js';
import type {
  PortableCutoverTrustConfiguration,
  PortableDryRunAttestationConfiguration,
} from './services/portable-import-control.js';
import { closeCheckInActivityPublisher } from './services/check-in-activity-events.js';
import {
  publicRouteModules,
  registerAuthenticatedRouteGroup,
  registerRouteModules,
  signedWebhookRouteModules,
} from './routes/registry.js';
import {
  createApiObservability,
  registerMetricsRoute,
  registerObservability,
} from './observability.js';
import type { StripeGateway } from '@tixkit/provider-clients';
import type { EmailTransport, SendSmsInput, SendSmsResult, SmsTransport } from '@tixkit/domain';
import type { ReadinessService } from './services/readiness.js';
import type { DashboardActionService } from './services/dashboard-actions.js';
import { createDefaultEmailTransport } from '@tixkit/email-transport';
import {
  createProviderIncidentEvidenceRuntime,
  ProviderIncidentEvidenceService,
} from './services/provider-incident-evidence.js';
import type { ProviderClientRuntime, StripeGatewayOptions } from '@tixkit/provider-clients';

type CorsOriginCallback = (error: Error | null, allow: boolean) => void;
type CorsOriginValidatorOptions = {
  customDomainCorsEnabled?: boolean;
  isVerifiedCustomDomainHost?: (host: string) => Promise<boolean>;
};

export type AppContext = {
  db: Database;
  pricingEngine: PricingEngine;
  inventoryService: InventoryService;
  qrService: QrService;
  authService: AuthProvider;
  temporalClient: TemporalClient;
  emailTransport: EmailTransport;
  smsTransport: SmsTransport;
  stripeGateway?: StripeGateway;
  stripeGatewayFactory?: (secretKey: string, options: StripeGatewayOptions) => StripeGateway;
  readinessServiceFactory?: (db: Database) => ReadinessService;
  dashboardActionServiceFactory?: (db: Database) => DashboardActionService;
  providerIncidentEvidenceService?: ProviderIncidentEvidenceService;
  providerClientRuntime?: ProviderClientRuntime;
  portableDryRunAttestation?: PortableDryRunAttestationConfiguration;
  portableCutoverTrust?: PortableCutoverTrustConfiguration;
  eventDuplicationCheckpoint?: (input: {
    stage: 'after_children_copied';
    sourceEventId: string;
    duplicatedEventId: string;
  }) => void | Promise<void>;
  eventPresetCheckpoint?: (input: {
    stage: 'after_preset_applied';
    eventId: string;
    startingPoint: 'free' | 'paid' | 'donation' | 'multiple';
  }) => void | Promise<void>;
  eventUpdateCheckpoint?: (input: {
    stage: 'before_transaction';
    eventId: string;
  }) => void | Promise<void>;
  eventFeePolicyCheckpoint?: (input: {
    stage: 'before_transaction';
    eventId: string;
  }) => void | Promise<void>;
  eventCodeFormatCheckpoint?: (input: {
    stage: 'before_transaction';
    eventId: string;
  }) => void | Promise<void>;
  eventPagePublishCheckpoint?: (input: {
    stage: 'after_event_locked';
    eventId: string;
    documentId: string;
    versionId: string;
  }) => void | Promise<void>;
};

class ApiCaptureSmsTransport implements SmsTransport {
  async send(input: SendSmsInput): Promise<SendSmsResult> {
    return {
      deliveryId: input.deliveryId,
      provider: 'capture',
      providerMessageId: `capsms_${ulid()}`,
      status: 'accepted',
      attemptedFallbackProviders: [],
      sentAt: new Date().toISOString(),
    };
  }
}

export const API_JSON_BODY_LIMIT_BYTES = 2 * 1024 * 1024;

function toJsonSafeErrorDetail(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[REDACTED]';
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value
      .map((entry) => toJsonSafeErrorDetail(entry, depth + 1))
      .filter((entry) => entry !== undefined);
  }
  if (typeof value === 'object') {
    const safe: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const safeEntry = toJsonSafeErrorDetail(entry, depth + 1);
      if (safeEntry !== undefined) safe[key] = safeEntry;
    }
    return safe;
  }
  return undefined;
}

function sanitizeErrorDetails(details: unknown): Record<string, unknown> | undefined {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return undefined;
  return toJsonSafeErrorDetail(redactObject(details)) as Record<string, unknown>;
}

function customDomainHostFromCorsOrigin(origin: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'https:' || parsed.port || parsed.pathname !== '/') return null;
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;

  const host = parsed.hostname.trim().toLowerCase();
  return host.length > 0 ? host : null;
}

async function isVerifiedCustomDomainCorsHost(db: Database, host: string): Promise<boolean> {
  const brand = await new BrandRepository(db).findByActiveDomain(host);
  return brand !== null;
}

export function createCorsOriginValidator(
  allowedOrigins: readonly string[],
  options: CorsOriginValidatorOptions = {},
) {
  const allowed = new Set(allowedOrigins);
  return (origin: string | undefined, callback: CorsOriginCallback): void => {
    if (origin === undefined || allowed.has(origin)) {
      callback(null, true);
      return;
    }

    if (!options.customDomainCorsEnabled || !options.isVerifiedCustomDomainHost) {
      callback(null, false);
      return;
    }

    const host = customDomainHostFromCorsOrigin(origin);
    if (host === null) {
      callback(null, false);
      return;
    }

    void options
      .isVerifiedCustomDomainHost(host)
      .then((isVerified) => {
        callback(null, isVerified);
      })
      .catch(() => {
        callback(null, false);
      });
  };
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const requestId = request.id;
    const err = error as Error & {
      statusCode?: number;
      code?: string;
      expose?: boolean;
      details?: Record<string, unknown>;
    };
    const statusCode = err.statusCode;
    const exposesError =
      typeof statusCode === 'number' &&
      statusCode >= 400 &&
      statusCode < 600 &&
      (statusCode < 500 || err.expose === true);
    if (exposesError) {
      const details = sanitizeErrorDetails(err.details);
      return reply.status(statusCode).send({
        error: {
          code: err.code ?? (statusCode >= 500 ? 'SERVICE_UNAVAILABLE' : 'VALIDATION_ERROR'),
          message: redactString(err.message),
          requestId,
          ...(details ? { details } : {}),
        },
      });
    }

    request.log.error({ err: redactErrorFields(error), requestId }, 'Unhandled error');
    return reply.status(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An internal error occurred',
        requestId,
      },
    });
  });
}

export function registerHealthRoute(app: FastifyInstance): void {
  app.get(
    '/health',
    {
      config: {
        rateLimit: false,
      },
    },
    async () => ({ status: 'ok', timestamp: new Date().toISOString() }),
  );
  app.get('/ready', { config: { rateLimit: false } }, async (_request, reply) => {
    try {
      let timeout: NodeJS.Timeout | undefined;
      await Promise.race([
        app.context.db.selectFrom('tenants').select('id').limit(1).execute(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('Readiness database timeout')), 2_000);
          timeout.unref();
        }),
      ]).finally(() => {
        if (timeout) clearTimeout(timeout);
      });
      return { status: 'ready', timestamp: new Date().toISOString() };
    } catch {
      return reply.status(503).send({ status: 'not_ready' });
    }
  });
}

export function registerJsonBodyParser(
  app: FastifyInstance,
  options: { captureRawBody?: boolean } = {},
): void {
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    const rawBody = body as string;
    if (options.captureRawBody === true) {
      (request as unknown as { rawBody: string }).rawBody = rawBody;
    }
    if (rawBody.trim().length === 0) {
      done(null, undefined);
      return;
    }
    try {
      const json = JSON.parse(rawBody);
      done(null, json);
    } catch (err) {
      done(err as Error, undefined);
    }
  });
}

type RateLimitRegistrationOptions = {
  max?: number;
  timeWindow?: string;
  redis?: RateLimitPluginOptions['redis'];
};

export async function registerIpRateLimit(
  app: FastifyInstance,
  options: RateLimitRegistrationOptions = {},
): Promise<void> {
  await app.register(rateLimit, {
    max: options.max ?? config.rateLimitMax,
    timeWindow: options.timeWindow ?? config.rateLimitTimeWindow,
    redis: options.redis,
  });
}

export function tenantRateLimitKey(request: FastifyRequest): string {
  const principal = request.principal;
  if (principal) return `tenant:${principal.tenantId}`;
  return `unauthenticated:${request.ip}`;
}

export async function registerTenantRateLimit(
  app: FastifyInstance,
  options: RateLimitRegistrationOptions = {},
): Promise<void> {
  await app.register(rateLimit, {
    max: options.max ?? config.rateLimitMax,
    timeWindow: options.timeWindow ?? config.rateLimitTimeWindow,
    redis: options.redis,
    hook: 'preHandler',
    keyGenerator: tenantRateLimitKey,
  });
}

export function shouldUseRedisRateLimit(): boolean {
  return config.nodeEnv !== 'test';
}

export async function createRateLimitRedisClient(): Promise<Redis | undefined> {
  if (!shouldUseRedisRateLimit()) return undefined;

  const redis = new Redis(config.redisUrl, {
    connectTimeout: 1_000,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    lazyConnect: true,
  });
  redis.on('error', () => undefined);
  try {
    await redis.connect();
    return redis;
  } catch (error) {
    redis.disconnect();
    if (config.nodeEnv === 'production') {
      throw new Error('Redis is required for production rate limiting', {
        cause: error,
      });
    }
    return undefined;
  }
}

export type ApplicationRouteAccess = 'operational' | 'public' | 'signed-webhook' | 'authenticated';

export type ApplicationRouteRegistrationOptions = {
  authService: Parameters<typeof createAuthMiddleware>[0];
  dbProvider: () => Database;
  metrics?: {
    bearerToken?: string;
    requireBearerToken?: boolean;
  };
  observability: Awaited<ReturnType<typeof createApiObservability>>;
  onRoute?: Partial<Record<ApplicationRouteAccess, (route: RouteOptions) => void>>;
  rateLimitRedis?: RateLimitPluginOptions['redis'];
  registerRateLimits?: boolean;
};

export async function registerApplicationRoutes(
  app: FastifyInstance,
  options: ApplicationRouteRegistrationOptions,
): Promise<void> {
  const rateLimitsEnabled = options.registerRateLimits !== false;

  await app.register(async (operational) => {
    if (options.onRoute?.operational) {
      operational.addHook('onRoute', options.onRoute.operational);
    }
    registerHealthRoute(operational);
    registerMetricsRoute(operational, options.observability, options.dbProvider, options.metrics);
  });

  await app.register(async (signedWebhooks) => {
    if (options.onRoute?.['signed-webhook']) {
      signedWebhooks.addHook('onRoute', options.onRoute['signed-webhook']);
    }
    if (rateLimitsEnabled) {
      await registerIpRateLimit(signedWebhooks, { redis: options.rateLimitRedis });
    }
    registerJsonBodyParser(signedWebhooks, { captureRawBody: true });
    await registerRouteModules(signedWebhooks, signedWebhookRouteModules);
  });

  await app.register(async (publicGroup) => {
    if (options.onRoute?.public) {
      publicGroup.addHook('onRoute', options.onRoute.public);
    }
    if (rateLimitsEnabled) {
      await registerIpRateLimit(publicGroup, { redis: options.rateLimitRedis });
    }
    const authenticateTestCheckout = createAuthMiddleware(options.authService);
    publicGroup.addHook('onRequest', async (request, reply) => {
      if (request.headers['x-tixkit-test-order'] === '1') {
        await authenticateTestCheckout(request, reply);
      }
    });
    await registerRouteModules(publicGroup, publicRouteModules);
  });

  await registerAuthenticatedRouteGroup(app, options.authService, async (authenticated) => {
    if (options.onRoute?.authenticated) {
      authenticated.addHook('onRoute', options.onRoute.authenticated);
    }
    if (rateLimitsEnabled) {
      await registerTenantRateLimit(authenticated, { redis: options.rateLimitRedis });
    }
  });
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    bodyLimit: API_JSON_BODY_LIMIT_BYTES,
    trustProxy: config.trustProxy,
    logger: {
      level: config.logLevel,
      redact: { paths: pinoRedactionPaths, censor: '[REDACTED]' },
    },
    genReqId: () => `req_${Date.now().toString(36)}${Math.random().toString(36).substring(2, 8)}`,
  });
  const observability = await createApiObservability();
  registerObservability(app, observability);
  const rateLimitRedis = await createRateLimitRedisClient();
  app.addHook('onClose', async () => {
    rateLimitRedis?.disconnect();
    await closeCheckInActivityPublisher();
  });
  const db = createDb(config.databaseUrl);

  // Plugins
  await app.register(helmet);
  await app.register(cors, {
    origin: createCorsOriginValidator(config.corsAllowedOrigins, {
      customDomainCorsEnabled: config.customDomainCorsEnabled,
      isVerifiedCustomDomainHost: (host) => isVerifiedCustomDomainCorsHost(db, host),
    }),
    credentials: true,
  });
  await app.register(compress, {
    globalCompression: true,
    globalDecompression: false,
    threshold: config.compressionThresholdBytes,
  });

  // Initialize services
  const pricingEngine = new PricingEngine();
  const inventoryService = new InventoryService(db);
  const qrService = new QrService();
  const providerIncidentEvidenceRuntime = createProviderIncidentEvidenceRuntime(db);
  const providerIncidentEvidenceService = providerIncidentEvidenceRuntime.service;
  const emailTransport = createDefaultEmailTransport(
    providerIncidentEvidenceRuntime.providerClientRuntime,
  );
  const smsTransport = new ApiCaptureSmsTransport();
  const authService = createAuthProvider(
    {
      provider: config.authProvider,
      nodeEnv: config.nodeEnv,
      clerkSecretKey: config.clerkSecretKey,
      oidcIssuerUrl: config.oidcIssuerUrl,
      oidcAudience: config.oidcAudience,
    },
    db,
  );
  const temporalClient = await TemporalClient.connect();

  // Seed dev tenant/org/brand when in local dev mode (no Clerk secret key).
  // This ensures the admin dashboard has minimum context to create events.
  await new ClerkAuthService(config.clerkSecretKey, db).ensureDevSeed();

  const ctx: AppContext = {
    db,
    pricingEngine,
    inventoryService,
    qrService,
    authService,
    temporalClient,
    emailTransport,
    smsTransport,
    providerIncidentEvidenceService,
    providerClientRuntime: providerIncidentEvidenceRuntime.providerClientRuntime,
  };
  app.decorate('context', ctx);
  registerErrorHandler(app);

  await registerApplicationRoutes(app, {
    authService,
    dbProvider: () => db,
    observability,
    rateLimitRedis,
  });

  const stopMigrationLifecycleDispatcher = startMigrationLifecycleDispatcher({
    db,
    temporalClient,
    workerId: `migration-lifecycle_${process.pid}_${ulid()}`,
    onError: (error) => {
      app.log.error(
        { err: redactErrorFields(error) },
        'Migration lifecycle command dispatcher failed',
      );
    },
  });
  app.addHook('onClose', async () => {
    await stopMigrationLifecycleDispatcher();
  });

  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    context: AppContext;
  }
}
