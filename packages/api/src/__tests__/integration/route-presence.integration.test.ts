import { describe, expect, it } from 'vitest';
import { openApiSpec } from '@tixkit/openapi';
import { buildRouteManifest, type CapturedRoute } from './route-manifest.js';

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

const operationalRoutesExcludedFromOpenApi = new Set(['GET /health', 'GET /ready', 'GET /metrics']);

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
        expect.objectContaining({ method: 'GET', url: '/health' }),
        expect.objectContaining({ method: 'GET', url: '/metrics' }),
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
