import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { openApiSpec } from '@gatekit/openapi';
import { tenantRoutes } from '../../routes/modules/tenant.js';
import { eventRoutes } from '../../routes/modules/events.js';
import { ticketingRoutes } from '../../routes/modules/ticketing.js';
import { checkoutRoutes } from '../../routes/modules/checkout.js';
import { orderRoutes } from '../../routes/modules/orders.js';
import { checkInRoutes } from '../../routes/modules/checkin.js';
import { webhookRoutes } from '../../routes/modules/webhooks.js';
import { developerRoutes } from '../../routes/modules/developer.js';
import { messagingRoutes } from '../../routes/modules/messaging.js';
import { reportingRoutes } from '../../routes/modules/reporting.js';
import { publicRoutes } from '../../routes/modules/public.js';
import { questionRoutes } from '../../routes/modules/questions.js';
import { authRoutes } from '../../routes/modules/auth.js';
import type { AppContext } from '../../app.js';

/**
 * Route-presence contract test (T33).
 *
 * Builds a minimal Fastify instance with all route modules registered (using a
 * mock context so no real DB/Temporal connection is needed), captures the
 * registered route table, and compares it against the OpenAPI spec paths.
 *
 * This prevents drift between the API implementation and the OpenAPI spec:
 * - Every registered route (except webhook receivers and /health) must have a
 *   matching OpenAPI path+method.
 * - Every OpenAPI path+method must have a matching registered route.
 */

type CapturedRoute = {
  method: string;
  url: string;
};

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

  // Public routes.
  await app.register(async (publicGroup) => {
    await publicGroup.register(publicRoutes, { prefix: '/v1' });
    await publicGroup.register(checkoutRoutes, { prefix: '/v1' });
  });

  // Authenticated routes.
  await app.register(async (authenticated) => {
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

  await app.ready();
  await app.close();

  return routes;
}

/**
 * Routes that are intentionally NOT in the OpenAPI spec:
 * - Webhook receiver endpoints (Clerk, Stripe, Telnyx) are inbound webhooks,
 *   not part of the public API surface.
 */
const EXCLUDED_ROUTE_PREFIXES = [
  '/v1/webhooks/clerk',
  '/v1/webhooks/stripe',
  '/v1/webhooks/telnyx',
];

/**
 * OpenAPI paths that are intentionally not registered as Fastify routes in
 * this test:
 * - Webhook receiver endpoints (Clerk, Stripe, Telnyx) are inbound webhooks
 *   registered with separate prefixes in the app and are not part of the
 *   public API surface for SDK consumers.
 */
const EXCLUDED_OPENAPI_PATHS = [
  '/webhooks/clerk',
  '/webhooks/stripe',
  '/webhooks/telnyx/sms',
];

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
  });

  it('every registered route (except webhook receivers) has a matching OpenAPI path+method', () => {
    const openApiPaths = openApiSpec.paths as Record<string, Record<string, unknown>>;

    const missingFromSpec: string[] = [];
    for (const route of manifest) {
      if (route.url === '/health') continue; // documented separately
      if (route.method === 'HEAD') continue; // Fastify auto-generates HEAD for GET
      if (EXCLUDED_ROUTE_PREFIXES.some((prefix) => route.url.startsWith(prefix))) continue;

      const normalizedPath = stripPrefix(normalizeUrl(route.url));
      const specEntry = openApiPaths[normalizedPath];
      if (!specEntry) {
        missingFromSpec.push(`${route.method} ${route.url} -> OpenAPI path "${normalizedPath}" not found`);
        continue;
      }
      const methodLower = route.method.toLowerCase();
      if (!specEntry[methodLower]) {
        missingFromSpec.push(`${route.method} ${route.url} -> OpenAPI path "${normalizedPath}" has no ${methodLower} method`);
      }
    }

    expect(missingFromSpec).toEqual([]);
  });

  it('every OpenAPI path+method has a matching registered route (except documented exclusions)', () => {
    const openApiPaths = openApiSpec.paths as Record<string, Record<string, unknown>>;

    const missingFromRoutes: string[] = [];
    for (const [path, methods] of Object.entries(openApiPaths)) {
      if (EXCLUDED_OPENAPI_PATHS.includes(path)) continue;

      for (const method of Object.keys(methods)) {
        if (method === 'parameters') continue; // OpenAPI path-level parameters
        const methodUpper = method.toUpperCase();

        // Convert OpenAPI path ({param}) to Fastify path (:param) with /v1 prefix.
        const fastifyPath = `/v1${path === '/' ? '' : path}`.replace(/\{(\w+)\}/g, ':$1');

        const found = manifest.some(
          (r) => r.method === methodUpper && r.url === fastifyPath,
        );

        if (!found && path !== '/health') {
          missingFromRoutes.push(`${methodUpper} ${path} -> no matching Fastify route`);
        }
      }
    }

    expect(missingFromRoutes).toEqual([]);
  });
});
