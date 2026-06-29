import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { createDb, type Database } from '@tixkit/db';
import { pinoRedactionPaths, redactErrorFields, redactString } from '@tixkit/shared';
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

type CorsOriginCallback = (error: Error | null, allow: boolean) => void;

export type AppContext = {
  db: Database;
  pricingEngine: PricingEngine;
  inventoryService: InventoryService;
  qrService: QrService;
  authService: AuthProvider;
  temporalClient: TemporalClient;
  stripe?: Stripe;
};

export function createCorsOriginValidator(allowedOrigins: readonly string[]) {
  const allowed = new Set(allowedOrigins);
  return (origin: string | undefined, callback: CorsOriginCallback): void => {
    callback(null, origin === undefined || allowed.has(origin));
  };
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const requestId = request.id;
    const err = error as Error & { statusCode?: number; code?: string; expose?: boolean };
    const statusCode = err.statusCode;
    const exposesError =
      typeof statusCode === 'number' &&
      statusCode >= 400 &&
      statusCode < 600 &&
      (statusCode < 500 || err.expose === true);
    if (exposesError) {
      return reply.status(statusCode).send({
        error: {
          code: err.code ?? (statusCode >= 500 ? 'SERVICE_UNAVAILABLE' : 'VALIDATION_ERROR'),
          message: redactString(err.message),
          requestId,
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

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    trustProxy: config.trustProxy,
    logger: {
      level: config.logLevel,
      redact: { paths: pinoRedactionPaths, censor: '[REDACTED]' },
    },
    genReqId: () => `req_${Date.now().toString(36)}${Math.random().toString(36).substring(2, 8)}`,
  });
  const observability = await createApiObservability();
  registerObservability(app, observability);

  // Plugins
  await app.register(helmet);
  await app.register(cors, {
    origin: createCorsOriginValidator(config.corsAllowedOrigins),
    credentials: true,
  });
  await app.register(rateLimit, {
    max: config.rateLimitMax,
    timeWindow: config.rateLimitTimeWindow,
  });

  // Capture raw body for webhook signature verification while still parsing JSON for all routes
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    (request as unknown as { rawBody: string }).rawBody = body as string;
    try {
      const json = JSON.parse(body as string);
      done(null, json);
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  // Initialize services
  const db = createDb(config.databaseUrl);
  const pricingEngine = new PricingEngine();
  const inventoryService = new InventoryService(db);
  const qrService = new QrService();
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
  };
  app.decorate('context', ctx);
  registerErrorHandler(app);

  // Health check
  registerHealthRoute(app);
  registerMetricsRoute(app, observability, () => db);

  // Public webhook routes (no auth, signature-verified)
  await app.register(clerkWebhookRoutes, { prefix: '/v1/webhooks/clerk' });
  await app.register(stripeWebhookRoutes, { prefix: '/v1/webhooks/stripe' });
  await app.register(telnyxWebhookRoutes, { prefix: '/v1/webhooks/telnyx' });
  await app.register(emailWebhookRoutes, { prefix: '/v1/webhooks/email' });

  // Public buyer-facing routes (no admin auth). Checkout is intentionally public:
  // buyers are anonymous and tenancy is resolved from the published event.
  await app.register(async (publicGroup) => {
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
