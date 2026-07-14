import {
  ConflictError,
  ForbiddenError,
  IdempotencyConflictError,
  NotFoundError,
  ValidationError,
} from '@tixkit/domain';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { parseBody } from '../../http/schemas.js';
import { AgentActionService, type PreparedAgentAction } from '../../services/agent-actions.js';

const idSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{1,62}$/u);
const prepareActionSchema = z
  .object({
    kind: z.literal('event.publish'),
    delegationGrantId: idSchema,
    resourceId: idSchema,
  })
  .strict();
const actionParamsSchema = z.object({ actionId: z.string().regex(/^act_[a-f0-9]{48}$/u) }).strict();

export interface AgentActionRouteService {
  prepare(input: {
    tenantId: string;
    agentPrincipalId: string;
    idempotencyKey: string;
    kind: 'event.publish';
    delegationGrantId: string;
    resourceId: string;
  }): Promise<PreparedAgentAction>;
  getForAgent(input: {
    tenantId: string;
    agentPrincipalId: string;
    actionId: string;
  }): Promise<PreparedAgentAction | undefined>;
}

export interface AgentActionRouteOptions {
  service?: AgentActionRouteService;
}

function requireAgent(
  requestPrincipal: NonNullable<import('@tixkit/domain').Principal>,
): asserts requestPrincipal is NonNullable<import('@tixkit/domain').Principal> & { type: 'agent' } {
  if (requestPrincipal.type !== 'agent')
    throw new ForbiddenError('An explicit agent principal is required');
}

function idempotencyKey(headers: Record<string, unknown>): string {
  const value = headers['idempotency-key'];
  if (
    typeof value !== 'string' ||
    value.length < 16 ||
    value.length > 127 ||
    value.trim() !== value ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]+$/u.test(value)
  )
    throw new ValidationError(
      'Idempotency-Key must contain 16-127 safe token characters with no surrounding whitespace',
    );
  return value;
}

function translateAgentActionError(key: string, error: unknown): never {
  const message = error instanceof Error ? error.message : '';
  if (message === 'AGENT_ACTION_IDEMPOTENCY_CONFLICT') throw new IdempotencyConflictError(key);
  if (
    message === 'AGENT_ACTION_PRINCIPAL_DENIED' ||
    message === 'AGENT_ACTION_DELEGATION_DENIED' ||
    message === 'AGENT_ACTION_RESOURCE_DENIED'
  )
    throw new NotFoundError('AgentActionScope', 'requested');
  if (message === 'AGENT_ACTION_POLICY_UNAVAILABLE')
    throw new ConflictError('Agent action policy is not configured');
  throw error;
}

export const agentActionRoutes: FastifyPluginAsync<AgentActionRouteOptions> = async (
  app,
  options,
) => {
  const service = options.service ?? new AgentActionService(app.context.db);

  app.post('/agent/actions', { config: { agentAccess: true } }, async (request, reply) => {
    const actor = request.principal!;
    requireAgent(actor);
    const key = idempotencyKey(request.headers);
    const body = parseBody(prepareActionSchema, request.body);
    try {
      const prepared = await service.prepare({
        tenantId: actor.tenantId,
        agentPrincipalId: actor.id,
        idempotencyKey: key,
        ...body,
      });
      reply.header('Cache-Control', 'no-store');
      return reply.status(201).send(prepared);
    } catch (error) {
      translateAgentActionError(key, error);
    }
  });

  app.get('/agent/actions/:actionId', { config: { agentAccess: true } }, async (request, reply) => {
    const actor = request.principal!;
    requireAgent(actor);
    const { actionId } = parseBody(actionParamsSchema, request.params);
    const action = await service.getForAgent({
      tenantId: actor.tenantId,
      agentPrincipalId: actor.id,
      actionId,
    });
    if (!action) throw new NotFoundError('AgentAction', actionId);
    reply.header('Cache-Control', 'no-store');
    return action;
  });
};
