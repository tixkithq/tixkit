import Fastify, { type RouteOptions } from 'fastify';
import { registerApplicationRoutes, type AppContext } from '../../app.js';
import { createApiObservability } from '../../observability.js';
import { UnauthorizedError } from '@tixkit/domain';

export type RouteAccess = 'operational' | 'public' | 'signed-webhook' | 'authenticated';

export type CapturedRoute = {
  access: RouteAccess;
  handlerSource: string;
  method: string;
  preHandlerSource: string;
  url: string;
};

function hooksSource(hooks: RouteOptions['preHandler']): string {
  if (!hooks) return '';
  return (Array.isArray(hooks) ? hooks : [hooks])
    .map((hook) => Function.prototype.toString.call(hook))
    .join('\n');
}

function captureRoute(routes: CapturedRoute[], access: RouteAccess) {
  return (route: RouteOptions) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    const preHandlerSource = hooksSource(route.preHandler);
    const effectiveAccess =
      access === 'public' &&
      /authenticate(?:ScannerDevice|ApiKey|BearerToken)/.test(preHandlerSource)
        ? 'authenticated'
        : access;
    for (const method of methods) {
      if (typeof method !== 'string' || typeof route.url !== 'string') continue;
      routes.push({
        access: effectiveAccess,
        handlerSource: Function.prototype.toString.call(route.handler),
        method: method.toUpperCase(),
        preHandlerSource,
        url: route.url,
      });
    }
  };
}

async function createRouteManifestApp(enforceAuthentication: boolean) {
  const routes: CapturedRoute[] = [];
  const app = Fastify({ logger: false });
  const authService = {
    authenticateAgentAccessToken: async () => {
      throw new UnauthorizedError();
    },
    authenticateApiKey: async () => {
      throw new UnauthorizedError();
    },
    authenticateLocalDev: async () => {
      throw new UnauthorizedError();
    },
    authenticateOAuthAccessToken: async () => {
      throw new UnauthorizedError();
    },
    authenticateRequest: async () => {
      throw new UnauthorizedError();
    },
    authenticateScannerDevice: async () => {
      throw new UnauthorizedError();
    },
    authenticateUser: async () => {
      throw new UnauthorizedError();
    },
    isLocalDevMode: () => false,
  };
  const mockContext = {
    db: {},
    pricingEngine: {},
    inventoryService: {},
    qrService: {},
    authService,
    temporalClient: {},
  } as unknown as AppContext;
  app.decorate('context', mockContext);

  await registerApplicationRoutes(app, {
    authService: authService as unknown as Parameters<
      typeof registerApplicationRoutes
    >[1]['authService'],
    dbProvider: () => mockContext.db,
    metrics: {
      bearerToken: 'metrics-inventory-test-token',
      requireBearerToken: enforceAuthentication,
    },
    observability: await createApiObservability(),
    onRoute: {
      authenticated: captureRoute(routes, 'authenticated'),
      operational: captureRoute(routes, 'operational'),
      public: captureRoute(routes, 'public'),
      'signed-webhook': captureRoute(routes, 'signed-webhook'),
    },
    registerRateLimits: false,
  });

  await app.ready();
  return { app, routes };
}

export async function buildRouteManifest(): Promise<CapturedRoute[]> {
  const { app, routes } = await createRouteManifestApp(false);
  await app.close();
  return routes;
}

export async function buildAuthenticatedRouteTestApp() {
  return createRouteManifestApp(true);
}
