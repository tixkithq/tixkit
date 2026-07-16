import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { authRoutes } from './modules/auth.js';
import { agentControlRoutes } from './modules/agent-control.js';
import { agentActionRoutes } from './modules/agent-actions.js';
import { agentMemoryRoutes } from './modules/agent-memory.js';
import { agentPlanRoutes } from './modules/agent-plans.js';
import { agentSessionRoutes } from './modules/agent-session.js';
import { checkInRoutes } from './modules/checkin.js';
import { checkoutRoutes } from './modules/checkout.js';
import { contentRoutes, publicContentRoutes } from './modules/content.js';
import { developerRoutes } from './modules/developer.js';
import { emailWebhookRoutes } from './modules/email-webhooks.js';
import { eventMediaRoutes } from './modules/event-media.js';
import { eventRoutes } from './modules/events.js';
import { messagingRoutes } from './modules/messaging.js';
import { migrationRoutes } from './modules/migrations.js';
import { oauthAuthorizeRoutes, oauthTokenRoutes } from './modules/oauth.js';
import { orderRoutes } from './modules/orders.js';
import { portabilityRoutes } from './modules/portability.js';
import { privacyRoutes } from './modules/privacy.js';
import { publicRoutes } from './modules/public.js';
import { questionRoutes } from './modules/questions.js';
import { readinessRoutes } from './modules/readiness.js';
import { rumRoutes } from './modules/rum.js';
import { reportingRoutes } from './modules/reporting.js';
import { shortLinkRedirectRoutes, shortLinkRoutes } from './modules/short-links.js';
import { clerkWebhookRoutes } from './modules/clerk-webhooks.js';
import { stripeWebhookRoutes } from './modules/stripe-webhooks.js';
import { telnyxWebhookRoutes } from './modules/telnyx-webhooks.js';
import { tenantRoutes } from './modules/tenant.js';
import { ticketingRoutes } from './modules/ticketing.js';
import { publicUploadRoutes, uploadRoutes } from './modules/uploads.js';
import { publicWaitlistRoutes, waitlistRoutes } from './modules/waitlist.js';
import { webhookRoutes } from './modules/webhooks.js';
import { createAuthMiddleware } from '../auth/clerk.js';
import { ForbiddenError } from '@tixkit/domain';

export type RouteModuleRegistration = {
  plugin: FastifyPluginAsync;
  prefix: string;
};

export const signedWebhookRouteModules: readonly RouteModuleRegistration[] = [
  { plugin: clerkWebhookRoutes, prefix: '/v1/webhooks/clerk' },
  { plugin: stripeWebhookRoutes, prefix: '/v1/webhooks/stripe' },
  { plugin: telnyxWebhookRoutes, prefix: '/v1/webhooks/telnyx' },
  { plugin: emailWebhookRoutes, prefix: '/v1/webhooks/email' },
];

export const publicRouteModules: readonly RouteModuleRegistration[] = [
  { plugin: rumRoutes, prefix: '/v1' },
  { plugin: publicRoutes, prefix: '/v1' },
  { plugin: checkoutRoutes, prefix: '/v1' },
  { plugin: publicUploadRoutes, prefix: '/v1' },
  { plugin: publicWaitlistRoutes, prefix: '/v1' },
  { plugin: oauthTokenRoutes, prefix: '/v1' },
  { plugin: shortLinkRedirectRoutes, prefix: '/v1' },
  { plugin: publicContentRoutes, prefix: '/v1' },
];

export const authenticatedRouteModules: readonly RouteModuleRegistration[] = [
  { plugin: agentSessionRoutes, prefix: '/v1' },
  { plugin: agentActionRoutes, prefix: '/v1' },
  { plugin: agentControlRoutes, prefix: '/v1' },
  { plugin: agentMemoryRoutes, prefix: '/v1' },
  { plugin: agentPlanRoutes, prefix: '/v1' },
  { plugin: tenantRoutes, prefix: '/v1' },
  { plugin: eventRoutes, prefix: '/v1' },
  { plugin: eventMediaRoutes, prefix: '/v1' },
  { plugin: readinessRoutes, prefix: '/v1' },
  { plugin: ticketingRoutes, prefix: '/v1' },
  { plugin: orderRoutes, prefix: '/v1' },
  { plugin: checkInRoutes, prefix: '/v1' },
  { plugin: webhookRoutes, prefix: '/v1' },
  { plugin: developerRoutes, prefix: '/v1' },
  { plugin: oauthAuthorizeRoutes, prefix: '/v1' },
  { plugin: messagingRoutes, prefix: '/v1' },
  { plugin: contentRoutes, prefix: '/v1' },
  { plugin: shortLinkRoutes, prefix: '/v1' },
  { plugin: reportingRoutes, prefix: '/v1' },
  { plugin: privacyRoutes, prefix: '/v1' },
  { plugin: questionRoutes, prefix: '/v1' },
  { plugin: authRoutes, prefix: '/v1' },
  { plugin: uploadRoutes, prefix: '/v1' },
  { plugin: waitlistRoutes, prefix: '/v1' },
  { plugin: migrationRoutes, prefix: '/v1' },
  { plugin: portabilityRoutes, prefix: '/v1' },
];

export async function registerRouteModules(
  app: FastifyInstance,
  modules: readonly RouteModuleRegistration[],
): Promise<void> {
  for (const module of modules) {
    await app.register(module.plugin, { prefix: module.prefix });
  }
}

export async function registerAuthenticatedRouteGroup(
  app: FastifyInstance,
  authService: Parameters<typeof createAuthMiddleware>[0],
  setup?: (authenticated: FastifyInstance) => void | Promise<void>,
): Promise<void> {
  await app.register(async (authenticated) => {
    authenticated.addHook('onRequest', createAuthMiddleware(authService));
    authenticated.addHook('onRequest', enforceAgentRouteAccess);
    await setup?.(authenticated);
    await registerRouteModules(authenticated, authenticatedRouteModules);
  });
}

export async function enforceAgentRouteAccess(request: import('fastify').FastifyRequest) {
  if (request.principal?.type === 'agent' && request.routeOptions.config.agentAccess !== true) {
    throw new ForbiddenError('Agent principals cannot access this route');
  }
}

declare module 'fastify' {
  interface FastifyContextConfig {
    agentAccess?: boolean;
  }
}
