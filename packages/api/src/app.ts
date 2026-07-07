import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
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
import { tenantRoutes } from './routes/modules/tenant.js';
import { eventRoutes } from './routes/modules/events.js';
import { ticketingRoutes } from './routes/modules/ticketing.js';
import { checkoutRoutes } from './routes/modules/checkout.js';
import { orderRoutes } from './routes/modules/orders.js';
import { checkInRoutes } from './routes/modules/checkin.js';
import { webhookRoutes } from './routes/modules/webhooks.js';
import { developerRoutes } from './routes/modules/developer.js';
import { oauthAuthorizeRoutes, oauthTokenRoutes } from './routes/modules/oauth.js';
import { messagingRoutes } from './routes/modules/messaging.js';
import { contentRoutes, publicContentRoutes } from './routes/modules/content.js';
import { shortLinkRoutes, shortLinkRedirectRoutes } from './routes/modules/short-links.js';
import { reportingRoutes } from './routes/modules/reporting.js';
import { privacyRoutes } from './routes/modules/privacy.js';
import { clerkWebhookRoutes } from './routes/modules/clerk-webhooks.js';
import { stripeWebhookRoutes } from './routes/modules/stripe-webhooks.js';
import { telnyxWebhookRoutes } from './routes/modules/telnyx-webhooks.js';
import { emailWebhookRoutes } from './routes/modules/email-webhooks.js';
import { publicRoutes } from './routes/modules/public.js';
import { questionRoutes } from './routes/modules/questions.js';
import { authRoutes } from './routes/modules/auth.js';
import { publicUploadRoutes, uploadRoutes } from './routes/modules/uploads.js';
import { publicWaitlistRoutes, waitlistRoutes } from './routes/modules/waitlist.js';
import {
  createApiObservability,
  registerMetricsRoute,
  registerObservability,
} from './observability.js';
import type Stripe from 'stripe';
import type {
  EmailTransport,
  SendEmailInput,
  SendEmailResult,
  SendSmsInput,
  SendSmsResult,
  SmsTransport,
} from '@tixkit/domain';

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
  stripe?: Stripe;
};

class ApiCaptureEmailTransport implements EmailTransport {
  async send(input: SendEmailInput): Promise<SendEmailResult> {
    return {
      deliveryId: input.deliveryId,
      provider: 'capture',
      providerMessageId: `cap_${ulid()}`,
      status: 'accepted',
      attemptedFallbackProviders: [],
      sentAt: new Date().toISOString(),
    };
  }
}

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
      throw new Error('Redis is required for production rate limiting', { cause: error });
    }
    return undefined;
  }
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
  const emailTransport = new ApiCaptureEmailTransport();
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
  };
  app.decorate('context', ctx);
  registerErrorHandler(app);

  // Health check
  registerHealthRoute(app);
  registerMetricsRoute(app, observability, () => db);

  // Public webhook routes (no auth, signature-verified)
  await app.register(async (publicWebhooks) => {
    await registerIpRateLimit(publicWebhooks, { redis: rateLimitRedis });
    registerJsonBodyParser(publicWebhooks, { captureRawBody: true });
    await publicWebhooks.register(clerkWebhookRoutes, { prefix: '/v1/webhooks/clerk' });
    await publicWebhooks.register(stripeWebhookRoutes, { prefix: '/v1/webhooks/stripe' });
    await publicWebhooks.register(telnyxWebhookRoutes, { prefix: '/v1/webhooks/telnyx' });
    await publicWebhooks.register(emailWebhookRoutes, { prefix: '/v1/webhooks/email' });
  });

  // Public buyer-facing routes (no admin auth). Checkout is intentionally public:
  // buyers are anonymous and tenancy is resolved from the published event.
  await app.register(async (publicGroup) => {
    await registerIpRateLimit(publicGroup, { redis: rateLimitRedis });
    await publicGroup.register(publicRoutes, { prefix: '/v1' });
    await publicGroup.register(checkoutRoutes, { prefix: '/v1' });
    await publicGroup.register(publicUploadRoutes, { prefix: '/v1' });
    await publicGroup.register(publicWaitlistRoutes, { prefix: '/v1' });
    await publicGroup.register(oauthTokenRoutes, { prefix: '/v1' });
    await publicGroup.register(shortLinkRedirectRoutes, { prefix: '/v1' });
    await publicGroup.register(publicContentRoutes, { prefix: '/v1' });
  });

  // Authenticated admin/integration routes (Clerk user, API key, or scanner device)
  await app.register(async (authenticated) => {
    authenticated.addHook('onRequest', createAuthMiddleware(authService));
    await registerTenantRateLimit(authenticated, { redis: rateLimitRedis });

    await authenticated.register(tenantRoutes, { prefix: '/v1' });
    await authenticated.register(eventRoutes, { prefix: '/v1' });
    await authenticated.register(ticketingRoutes, { prefix: '/v1' });
    await authenticated.register(orderRoutes, { prefix: '/v1' });
    await authenticated.register(checkInRoutes, { prefix: '/v1' });
    await authenticated.register(webhookRoutes, { prefix: '/v1' });
    await authenticated.register(developerRoutes, { prefix: '/v1' });
    await authenticated.register(oauthAuthorizeRoutes, { prefix: '/v1' });
    await authenticated.register(messagingRoutes, { prefix: '/v1' });
    await authenticated.register(contentRoutes, { prefix: '/v1' });
    await authenticated.register(shortLinkRoutes, { prefix: '/v1' });
    await authenticated.register(reportingRoutes, { prefix: '/v1' });
    await authenticated.register(privacyRoutes, { prefix: '/v1' });
    await authenticated.register(questionRoutes, { prefix: '/v1' });
    await authenticated.register(authRoutes, { prefix: '/v1' });
    await authenticated.register(uploadRoutes, { prefix: '/v1' });
    await authenticated.register(waitlistRoutes, { prefix: '/v1' });
  });

  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    context: AppContext;
  }
}
