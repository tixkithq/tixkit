import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { openApiSpec } from '@tixkit/openapi';
import { tenantRoutes } from '../../routes/modules/tenant.js';
import { eventRoutes } from '../../routes/modules/events.js';
import { readinessRoutes } from '../../routes/modules/readiness.js';
import { ticketingRoutes } from '../../routes/modules/ticketing.js';
import { checkoutRoutes } from '../../routes/modules/checkout.js';
import { orderRoutes } from '../../routes/modules/orders.js';
import { checkInRoutes } from '../../routes/modules/checkin.js';
import { webhookRoutes } from '../../routes/modules/webhooks.js';
import { developerRoutes } from '../../routes/modules/developer.js';
import { messagingRoutes } from '../../routes/modules/messaging.js';
import { contentRoutes, publicContentRoutes } from '../../routes/modules/content.js';
import { shortLinkRoutes, shortLinkRedirectRoutes } from '../../routes/modules/short-links.js';
import { reportingRoutes } from '../../routes/modules/reporting.js';
import { privacyRoutes } from '../../routes/modules/privacy.js';
import { publicRoutes } from '../../routes/modules/public.js';
import { questionRoutes } from '../../routes/modules/questions.js';
import { authRoutes } from '../../routes/modules/auth.js';
import { publicUploadRoutes, uploadRoutes } from '../../routes/modules/uploads.js';
import { publicWaitlistRoutes, waitlistRoutes } from '../../routes/modules/waitlist.js';
import { migrationRoutes } from '../../routes/modules/migrations.js';
import { oauthAuthorizeRoutes, oauthTokenRoutes } from '../../routes/modules/oauth.js';
import { clerkWebhookRoutes } from '../../routes/modules/clerk-webhooks.js';
import { stripeWebhookRoutes } from '../../routes/modules/stripe-webhooks.js';
import { telnyxWebhookRoutes } from '../../routes/modules/telnyx-webhooks.js';
import { emailWebhookRoutes } from '../../routes/modules/email-webhooks.js';
import type { AppContext } from '../../app.js';
import { createApiObservability, registerMetricsRoute } from '../../observability.js';

/**
 * Route-presence contract test (T33).
 *
 * Builds a minimal Fastify instance with all route modules registered (using a
 * mock context so no real DB/Temporal connection is needed), captures the
 * registered route table, and compares it against the OpenAPI spec paths.
 *
 * This prevents drift between the API implementation and the OpenAPI spec:
 * - Every registered route (except /health) must have a matching OpenAPI
 *   path+method.
 * - Every OpenAPI path+method must have a matching registered route.
 */

type CapturedRoute = {
  method: string;
  url: string;
};

const operationalRoutesExcludedFromOpenApi = new Set(['GET /health', 'GET /ready', 'GET /metrics']);

async function buildRouteManifest(): Promise<CapturedRoute[]> {
  const routes: CapturedRoute[] = [];

  const app = Fastify({ logger: false });

  // Mock context: route modules read app.context.* at registration time but
  // never call the services during registration.
  const mockContext = {
    db: {},
    pricingEngine: {},
    inventoryService: {},
    qrService: {},
    authService: { requirePermission: () => {}, requireResourceTenant: () => {} },
    temporalClient: {},
  } as unknown as AppContext;
  app.decorate('context', mockContext);

  // Capture every route registration.
  app.addHook('onRoute', (route) => {
    const method = Array.isArray(route.method) ? route.method[0] : route.method;
    if (typeof method === 'string' && typeof route.url === 'string') {
      routes.push({ method: method.toUpperCase(), url: route.url });
    }
  });

  // Health check (outside /v1 prefix, documented separately in OpenAPI).
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/ready', async () => ({ status: 'ready' }));
  registerMetricsRoute(app, await createApiObservability(), () => mockContext.db, {
    requireBearerToken: false,
  });

  // Public webhook routes (no auth, signature-verified).
  await app.register(clerkWebhookRoutes, { prefix: '/v1/webhooks/clerk' });
  await app.register(stripeWebhookRoutes, { prefix: '/v1/webhooks/stripe' });
  await app.register(telnyxWebhookRoutes, { prefix: '/v1/webhooks/telnyx' });
  await app.register(emailWebhookRoutes, { prefix: '/v1/webhooks/email' });

  // Public routes.
  await app.register(async (publicGroup) => {
    await publicGroup.register(publicRoutes, { prefix: '/v1' });
    await publicGroup.register(checkoutRoutes, { prefix: '/v1' });
    await publicGroup.register(publicUploadRoutes, { prefix: '/v1' });
    await publicGroup.register(publicWaitlistRoutes, { prefix: '/v1' });
    await publicGroup.register(oauthTokenRoutes, { prefix: '/v1' });
    await publicGroup.register(shortLinkRedirectRoutes, { prefix: '/v1' });
    await publicGroup.register(publicContentRoutes, { prefix: '/v1' });
  });

  // Authenticated routes.
  await app.register(async (authenticated) => {
    await authenticated.register(tenantRoutes, { prefix: '/v1' });
    await authenticated.register(eventRoutes, { prefix: '/v1' });
    await authenticated.register(readinessRoutes, { prefix: '/v1' });
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
    await authenticated.register(migrationRoutes, { prefix: '/v1' });
  });

  await app.ready();
  await app.close();

  return routes;
}

function normalizeUrl(url: string): string {
  // Fastify route URLs use :param syntax; OpenAPI uses {param}.
  // Normalize to OpenAPI style for comparison.
  return url.replace(/:(\w+)/g, '{$1}');
}

function stripPrefix(url: string): string {
  // OpenAPI paths are relative to /v1 (the server base URL).
  // Remove the /v1 prefix from Fastify routes for comparison.
  if (url.startsWith('/v1/')) return url.slice(3); // keep leading /
  if (url === '/v1') return '/';
  return url;
}

describe('Route-presence contract (T33)', () => {
  let manifest: CapturedRoute[];

  it('builds a route manifest without errors', async () => {
    manifest = await buildRouteManifest();
    expect(manifest.length).toBeGreaterThan(0);
    expect(manifest).toEqual(
      expect.arrayContaining([
        { method: 'GET', url: '/health' },
        { method: 'GET', url: '/metrics' },
      ]),
    );
  });

  it('every registered route has a matching OpenAPI path+method', () => {
    const openApiPaths = openApiSpec.paths as Record<string, Record<string, unknown>>;

    const missingFromSpec: string[] = [];
    for (const route of manifest) {
      if (operationalRoutesExcludedFromOpenApi.has(`${route.method} ${route.url}`)) continue;
      if (route.method === 'HEAD') continue; // Fastify auto-generates HEAD for GET

      const normalizedPath = stripPrefix(normalizeUrl(route.url));
      const specEntry = openApiPaths[normalizedPath];
      if (!specEntry) {
        missingFromSpec.push(
          `${route.method} ${route.url} -> OpenAPI path "${normalizedPath}" not found`,
        );
        continue;
      }
      const methodLower = route.method.toLowerCase();
      if (!specEntry[methodLower]) {
        missingFromSpec.push(
          `${route.method} ${route.url} -> OpenAPI path "${normalizedPath}" has no ${methodLower} method`,
        );
      }
    }

    expect(missingFromSpec).toEqual([]);
  });

  it('every OpenAPI path+method has a matching registered route', () => {
    const openApiPaths = openApiSpec.paths as Record<string, Record<string, unknown>>;

    const missingFromRoutes: string[] = [];
    for (const [path, methods] of Object.entries(openApiPaths)) {
      for (const method of Object.keys(methods)) {
        if (method === 'parameters') continue; // OpenAPI path-level parameters
        const methodUpper = method.toUpperCase();

        // Convert OpenAPI path ({param}) to Fastify path (:param) with /v1 prefix.
        const fastifyPath = `/v1${path === '/' ? '' : path}`.replace(/\{(\w+)\}/g, ':$1');

        const found = manifest.some((r) => r.method === methodUpper && r.url === fastifyPath);

        if (!found && path !== '/health') {
          missingFromRoutes.push(`${methodUpper} ${path} -> no matching Fastify route`);
        }
      }
    }

    expect(missingFromRoutes).toEqual([]);
  });
});
