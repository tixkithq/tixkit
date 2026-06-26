import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { createDb, type Database } from '@gatekit/db';
import { config } from './config/index.js';
import { ClerkAuthService, createAuthMiddleware } from './auth/clerk.js';
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
import { messagingRoutes } from './routes/modules/messaging.js';
import { reportingRoutes } from './routes/modules/reporting.js';
import { clerkWebhookRoutes } from './routes/modules/clerk-webhooks.js';
import { stripeWebhookRoutes } from './routes/modules/stripe-webhooks.js';
import { telnyxWebhookRoutes } from './routes/modules/telnyx-webhooks.js';
import { publicRoutes } from './routes/modules/public.js';
import { questionRoutes } from './routes/modules/questions.js';
import { authRoutes } from './routes/modules/auth.js';

export type AppContext = {
  db: Database;
  pricingEngine: PricingEngine;
  inventoryService: InventoryService;
  qrService: QrService;
  authService: ClerkAuthService;
  temporalClient: TemporalClient;
};

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      transport: config.nodeEnv === 'development' ? { target: 'pino-pretty' } : undefined,
    },
    genReqId: () => `req_${Date.now().toString(36)}${Math.random().toString(36).substring(2, 8)}`,
  });

  // Plugins
  await app.register(helmet);
  await app.register(cors, {
    origin: true,
    credentials: true,
  });
  await app.register(rateLimit, {
    max: config.nodeEnv === 'production' ? 100 : 1000,
    timeWindow: '1 minute',
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
  const authService = new ClerkAuthService(config.clerkSecretKey, db);
	  const temporalClient = await TemporalClient.connect();

	  // Seed dev tenant/org/brand when in local dev mode (no Clerk secret key).
	  // This ensures the admin dashboard has minimum context to create events.
	  await authService.ensureDevSeed();

	  const ctx: AppContext = { db, pricingEngine, inventoryService, qrService, authService, temporalClient };
	  app.decorate('context', ctx);

  // Health check
  app.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

  // Public webhook routes (no auth, signature-verified)
  await app.register(clerkWebhookRoutes, { prefix: '/v1/webhooks/clerk' });
  await app.register(stripeWebhookRoutes, { prefix: '/v1/webhooks/stripe' });
  await app.register(telnyxWebhookRoutes, { prefix: '/v1/webhooks/telnyx' });

  // Public buyer-facing routes (no admin auth). Checkout is intentionally public:
  // buyers are anonymous and tenancy is resolved from the published event.
  await app.register(async (publicGroup) => {
    await publicGroup.register(publicRoutes, { prefix: '/v1' });
    await publicGroup.register(checkoutRoutes, { prefix: '/v1' });
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
    await authenticated.register(messagingRoutes, { prefix: '/v1' });
    await authenticated.register(reportingRoutes, { prefix: '/v1' });
    await authenticated.register(questionRoutes, { prefix: '/v1' });
    await authenticated.register(authRoutes, { prefix: '/v1' });
  });

  // Error handler
  app.setErrorHandler((error, request, reply) => {
    const requestId = request.id;
    const err = error as Error & { statusCode?: number; code?: string };
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      return reply.status(err.statusCode).send({
        error: {
          code: err.code ?? 'VALIDATION_ERROR',
          message: err.message,
          requestId,
        },
      });
    }

    request.log.error({ err: error, requestId }, 'Unhandled error');
    return reply.status(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An internal error occurred',
        requestId,
      },
    });
  });

	  return app;
	}

declare module 'fastify' {
  interface FastifyInstance {
    context: AppContext;
  }
}
