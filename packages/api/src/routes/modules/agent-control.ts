import {
  AGENT_PROTOCOL_VERSION,
  AgentProtocolValidationError,
  type AgentCapability,
  type AgentDelegationGrant,
  type AgentPrincipal,
} from '@tixkit/agent-protocol';
import { AgentExecutionRepository } from '@tixkit/db';
import {
  ConflictError,
  ForbiddenError,
  IdempotencyConflictError,
  NotFoundError,
  ValidationError,
  type Principal,
} from '@tixkit/domain';
import type { FastifyPluginAsync } from 'fastify';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import { z } from 'zod';
import { ClerkAuthService } from '../../auth/clerk.js';
import { parseBody } from '../../http/schemas.js';

const agentIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{1,62}$/u);
const agentCapabilitySchema = z.enum([
  'events.read',
  'events.prepare',
  'events.execute',
  'readiness.read',
  'content.prepare',
  'campaigns.prepare',
]);
const agentCapabilitiesSchema = z
  .array(agentCapabilitySchema)
  .min(1)
  .max(5)
  .refine((capabilities) => new Set(capabilities).size === capabilities.length, {
    message: 'Agent capabilities must be unique',
  });
const eventScopeSchema = z.string().regex(/^event:[A-Za-z0-9][A-Za-z0-9_-]{1,62}$/u);
const MAX_DELEGATION_TTL_MILLISECONDS = 30 * 24 * 60 * 60 * 1000;

const registerPrincipalSchema = z
  .object({
    id: agentIdSchema,
    kind: z.enum(['third_party', 'self_hosted']),
    capabilities: agentCapabilitiesSchema,
    maximumAutonomy: z.enum(['read', 'recommend', 'prepare', 'execute_with_approval']),
  })
  .strict();

const grantDelegationSchema = z
  .object({
    id: agentIdSchema,
    agentPrincipalId: agentIdSchema,
    capabilities: agentCapabilitiesSchema,
    resourceScopes: z
      .array(eventScopeSchema)
      .min(1)
      .max(100)
      .refine((scopes) => new Set(scopes).size === scopes.length, {
        message: 'Agent resource scopes must be unique',
      }),
    expiresAt: z.string().datetime(),
  })
  .strict();

const idParamsSchema = z.object({ id: agentIdSchema }).strict();
const oauthClientParamsSchema = z
  .object({
    id: agentIdSchema,
    clientId: z.string().regex(/^oapp_[a-f0-9]{27}$/u),
  })
  .strict();
const createOAuthClientSchema = z
  .object({
    organizationId: z.string().min(3).max(64),
    name: z.string().trim().min(1).max(120),
  })
  .strict();

export type AgentControlStore = Pick<
  AgentExecutionRepository,
  | 'assertControlActor'
  | 'getPrincipal'
  | 'getDelegation'
  | 'registerPrincipal'
  | 'grantDelegation'
  | 'revokePrincipal'
  | 'revokeDelegation'
> &
  Partial<Pick<AgentExecutionRepository, 'createAgentOAuthClient' | 'revokeAgentOAuthClient'>>;

export interface AgentControlRouteOptions {
  repository?: AgentControlStore;
  allowedKinds?: readonly AgentPrincipal['kind'][];
  now?: () => Date;
}

function requireHumanAgentAdministrator(principal: Principal): asserts principal is Principal & {
  type: 'user';
} {
  if (principal.type !== 'user')
    throw new ForbiddenError('Only authenticated users can manage agent principals');
  ClerkAuthService.requirePermission(principal, 'developers.write');
  if (principal.brandIds?.length || principal.eventIds?.length)
    throw new ForbiddenError('Scoped principals cannot manage tenant-wide agent principals');
}

function idempotencyKey(headers: Record<string, unknown>): string {
  const value = headers['idempotency-key'];
  if (
    typeof value !== 'string' ||
    value.length < 16 ||
    value.length > 255 ||
    value.trim() !== value
  )
    throw new ValidationError(
      'Idempotency-Key must contain 16-255 characters with no surrounding whitespace',
    );
  return value;
}

function controlAudit(principal: Principal & { type: 'user' }, key: string, reasonCode: string) {
  return {
    id: `agentctl_${ulid().toLowerCase()}`,
    actorPrincipalId: principal.id,
    reasonCode,
    idempotencyKey: key,
  };
}

function tenantNamespacedId(
  prefix: 'agt' | 'dlg',
  tenantId: string,
  sponsorPrincipalId: string,
  clientId: string,
  resourceBinding?: string,
): string {
  const digest = createHash('sha256')
    .update(tenantId)
    .update('\0')
    .update(sponsorPrincipalId)
    .update('\0')
    .update(prefix)
    .update('\0')
    .update(clientId)
    .update('\0')
    .update(resourceBinding ?? '')
    .digest('hex');
  return `${prefix}_${digest.slice(0, 48)}`;
}

function assertCapabilities(principal: Principal, capabilities: readonly AgentCapability[]): void {
  for (const capability of capabilities) {
    const required =
      capability === 'events.read' || capability === 'readiness.read'
        ? 'events.read'
        : capability === 'campaigns.prepare'
          ? 'messages.write'
          : 'events.write';
    if (!ClerkAuthService.hasPermission(principal, required))
      throw new ForbiddenError(`Sponsor does not currently hold authority for ${capability}`);
  }
}

async function translateControlError<T>(key: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AgentProtocolValidationError) throw new ValidationError(error.message);
    const message = error instanceof Error ? error.message : '';
    if (message === 'AGENT_CONTROL_IDEMPOTENCY_CONFLICT') throw new IdempotencyConflictError(key);
    if (message === 'AGENT_CONTROL_REFERENCE_CONFLICT')
      throw new ConflictError('Agent stable reference is already in use');
    if (message === 'AGENT_CONTROL_ACTOR_DENIED')
      throw new ForbiddenError('Agent control authorization changed');
    if (message === 'AGENT_CONTROL_ORGANIZATION_DENIED')
      throw new ForbiddenError('Agent credential organization authorization changed');
    if (
      message === 'AGENT_CONTROL_SPONSOR_MISMATCH' ||
      message === 'AGENT_CONTROL_SPONSOR_PERMISSION_DENIED'
    )
      throw new ForbiddenError('Agent sponsor authorization changed');
    if (message === 'AGENT_PRINCIPAL_INACTIVE')
      throw new ConflictError('Agent principal is unavailable for delegation');
    if (message === 'AGENT_DELEGATION_SCOPE_DENIED')
      throw new NotFoundError('Agent delegation scope', 'requested');
    if (
      message === 'AGENT_DELEGATION_CAPABILITY_UNSUPPORTED' ||
      message === 'AGENT_DELEGATION_SCOPE_UNSUPPORTED' ||
      message === 'AGENT_DELEGATION_SCOPE_INVALID' ||
      message === 'AGENT_DELEGATION_EXPIRY_INVALID'
    )
      throw new ValidationError('Agent delegation request is invalid');
    throw error;
  }
}

function assertFutureExpiry(now: Date, expiresAt: string): void {
  const current = now.getTime();
  const expiry = new Date(expiresAt).getTime();
  if (expiry <= current || expiry - current > MAX_DELEGATION_TTL_MILLISECONDS)
    throw new ValidationError('Agent delegation expiry must be within the next 30 days');
}

export const agentControlRoutes: FastifyPluginAsync<AgentControlRouteOptions> = async (
  app,
  options,
) => {
  const repository = options.repository ?? new AgentExecutionRepository(app.context.db);
  const now = options.now ?? (() => new Date());
  const allowedKinds = new Set(
    options.allowedKinds ??
      (process.env.TIXKIT_OPERATING_MODEL === 'self-hosted'
        ? (['third_party', 'self_hosted'] as const)
        : (['third_party'] as const)),
  );

  app.post('/agent-principals', async (request, reply) => {
    const actor = request.principal!;
    requireHumanAgentAdministrator(actor);
    const key = idempotencyKey(request.headers);
    const body = parseBody(registerPrincipalSchema, request.body);
    if (!allowedKinds.has(body.kind))
      throw new ForbiddenError(`Agent kind ${body.kind} is unavailable in this deployment`);
    assertCapabilities(actor, body.capabilities);
    const requestedPrincipal: AgentPrincipal = {
      ...body,
      id: tenantNamespacedId('agt', actor.tenantId, actor.id, body.id),
      tenantId: actor.tenantId,
      sponsorPrincipalId: actor.id,
      protocolVersion: AGENT_PROTOCOL_VERSION,
      state: 'active',
      capabilities: body.capabilities as AgentCapability[],
      registeredAt: new Date(0).toISOString(),
    };
    const principal = await translateControlError(key, () =>
      repository.registerPrincipal(
        requestedPrincipal,
        controlAudit(actor, key, 'PLATFORM_AGENT_PRINCIPAL_REGISTER'),
      ),
    );
    return reply.status(201).send(principal);
  });

  app.get('/agent-principals/:id', async (request) => {
    const actor = request.principal!;
    requireHumanAgentAdministrator(actor);
    await translateControlError('agent-control-read', () =>
      repository.assertControlActor(actor.tenantId, actor.id),
    );
    const { id } = parseBody(idParamsSchema, request.params);
    const principal = await repository.getPrincipal(actor.tenantId, id);
    if (!principal || principal.sponsorPrincipalId !== actor.id)
      throw new NotFoundError('AgentPrincipal', id);
    return principal;
  });

  app.post('/agent-principals/:id/revoke', async (request) => {
    const actor = request.principal!;
    requireHumanAgentAdministrator(actor);
    const key = idempotencyKey(request.headers);
    const { id } = parseBody(idParamsSchema, request.params);
    const existing = await repository.getPrincipal(actor.tenantId, id);
    if (!existing || existing.sponsorPrincipalId !== actor.id)
      throw new NotFoundError('AgentPrincipal', id);
    const revoked = await translateControlError(key, () =>
      repository.revokePrincipal({
        tenantId: actor.tenantId,
        principalId: id,
        audit: controlAudit(actor, key, 'PLATFORM_AGENT_PRINCIPAL_REVOKE'),
      }),
    );
    if (!revoked) throw new NotFoundError('AgentPrincipal', id);
    return { id, state: 'revoked' as const };
  });

  app.post('/agent-principals/:id/oauth-clients', async (request, reply) => {
    const actor = request.principal!;
    requireHumanAgentAdministrator(actor);
    const key = idempotencyKey(request.headers);
    const { id } = parseBody(idParamsSchema, request.params);
    const body = parseBody(createOAuthClientSchema, request.body);
    ClerkAuthService.requireOrganizationScope(actor, body.organizationId);
    const createClient = repository.createAgentOAuthClient;
    if (!createClient) throw new Error('Agent OAuth credential storage is unavailable');
    const stableReference = createHash('sha256')
      .update(actor.tenantId)
      .update('\0')
      .update(actor.id)
      .update('\0')
      .update(id)
      .update('\0')
      .update(key)
      .digest('hex')
      .slice(0, 48);
    const credential = await translateControlError(key, () =>
      createClient.call(repository, {
        tenantId: actor.tenantId,
        organizationId: body.organizationId,
        agentPrincipalId: id,
        applicationId: `oapp_${stableReference.slice(0, 27)}`,
        clientId: `tk_agent_${stableReference}`,
        name: body.name,
        audit: controlAudit(actor, key, 'PLATFORM_AGENT_OAUTH_CLIENT_CREATE'),
      }),
    );
    if (credential.clientSecret) reply.header('cache-control', 'no-store');
    return reply.status(credential.clientSecret ? 201 : 200).send(credential);
  });

  app.post('/agent-principals/:id/oauth-clients/:clientId/revoke', async (request) => {
    const actor = request.principal!;
    requireHumanAgentAdministrator(actor);
    const key = idempotencyKey(request.headers);
    const { id, clientId } = parseBody(oauthClientParamsSchema, request.params);
    const revokeClient = repository.revokeAgentOAuthClient;
    if (!revokeClient) throw new Error('Agent OAuth credential storage is unavailable');
    const revoked = await translateControlError(key, () =>
      revokeClient.call(repository, {
        tenantId: actor.tenantId,
        agentPrincipalId: id,
        applicationId: clientId,
        audit: controlAudit(actor, key, 'PLATFORM_AGENT_OAUTH_CLIENT_REVOKE'),
      }),
    );
    if (!revoked) throw new NotFoundError('AgentOAuthClient', clientId);
    return { id: clientId, status: 'revoked' as const };
  });

  app.post('/agent-delegations', async (request, reply) => {
    const actor = request.principal!;
    requireHumanAgentAdministrator(actor);
    const key = idempotencyKey(request.headers);
    const body = parseBody(grantDelegationSchema, request.body);
    assertFutureExpiry(now(), body.expiresAt);
    assertCapabilities(actor, body.capabilities);
    const principal = await repository.getPrincipal(actor.tenantId, body.agentPrincipalId);
    if (!principal || principal.sponsorPrincipalId !== actor.id)
      throw new NotFoundError('AgentPrincipal', body.agentPrincipalId);
    const requestedDelegation: AgentDelegationGrant = {
      id: tenantNamespacedId('dlg', actor.tenantId, actor.id, body.id, body.agentPrincipalId),
      agentPrincipalId: body.agentPrincipalId,
      capabilities: body.capabilities as AgentCapability[],
      resourceScopes: body.resourceScopes,
      permissionSnapshot: [],
      issuedAt: new Date(0).toISOString(),
      expiresAt: body.expiresAt,
      tenantId: actor.tenantId,
      sponsorPrincipalId: actor.id,
    };
    const delegation = await translateControlError(key, () =>
      repository.grantDelegation(
        requestedDelegation,
        controlAudit(actor, key, 'PLATFORM_AGENT_DELEGATION_GRANT'),
      ),
    );
    return reply.status(201).send(delegation);
  });

  app.post('/agent-delegations/:id/revoke', async (request) => {
    const actor = request.principal!;
    requireHumanAgentAdministrator(actor);
    const key = idempotencyKey(request.headers);
    const { id } = parseBody(idParamsSchema, request.params);
    const existing = await repository.getDelegation(actor.tenantId, id);
    if (!existing || existing.sponsorPrincipalId !== actor.id)
      throw new NotFoundError('AgentDelegation', id);
    const revoked = await translateControlError(key, () =>
      repository.revokeDelegation({
        tenantId: actor.tenantId,
        delegationId: id,
        audit: controlAudit(actor, key, 'PLATFORM_AGENT_DELEGATION_REVOKE'),
      }),
    );
    if (!revoked) throw new NotFoundError('AgentDelegation', id);
    return { id, revoked: true };
  });
};
