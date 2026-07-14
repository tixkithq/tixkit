import {
  ConflictError,
  ForbiddenError,
  IdempotencyConflictError,
  NotFoundError,
  ValidationError,
  type Principal,
} from '@tixkit/domain';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { ClerkAuthService } from '../../auth/clerk.js';
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
const approvalParamsSchema = actionParamsSchema
  .extend({ approvalId: z.string().regex(/^apr_[a-f0-9]{48}$/u) })
  .strict();
const approvalSchema = z.object({ actionDigest: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();

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
  getForSponsor(input: {
    tenantId: string;
    sponsorPrincipalId: string;
    actionId: string;
  }): Promise<PreparedAgentAction | undefined>;
  approve(input: {
    tenantId: string;
    approverPrincipalId: string;
    actionId: string;
    actionDigest: string;
    idempotencyKey: string;
  }): Promise<import('@tixkit/agent-protocol').AgentApproval>;
  revokeApproval(input: {
    tenantId: string;
    sponsorPrincipalId: string;
    actionId: string;
    approvalId: string;
    actionDigest: string;
    idempotencyKey: string;
  }): Promise<import('@tixkit/agent-protocol').AgentApproval>;
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

function requireHumanApprover(principal: Principal): asserts principal is Principal & {
  type: 'user';
} {
  if (principal.type !== 'user')
    throw new ForbiddenError('Only an authenticated human sponsor can approve an agent action');
  ClerkAuthService.requirePermission(principal, 'events.write');
}

function requireHumanSponsor(
  principal: Principal,
): asserts principal is Principal & { type: 'user' } {
  if (principal.type !== 'user')
    throw new ForbiddenError('Only the authenticated human sponsor can revoke an approval');
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
  if (message === 'AGENT_ACTION_APPROVAL_IDEMPOTENCY_CONFLICT')
    throw new IdempotencyConflictError(key);
  if (message === 'AGENT_ACTION_APPROVAL_SCOPE_DENIED')
    throw new NotFoundError('AgentAction', 'requested');
  if (message === 'AGENT_ACTION_APPROVAL_DIGEST_MISMATCH')
    throw new ConflictError('Agent action digest no longer matches the reviewed action');
  if (message === 'AGENT_ACTION_NOT_APPROVABLE')
    throw new ConflictError('Agent action is no longer eligible for approval');
  if (message === 'AGENT_ACTION_ALREADY_APPROVED')
    throw new ConflictError('Agent action already has an approval');
  if (message === 'AGENT_ACTION_APPROVAL_ALREADY_CONSUMED')
    throw new ConflictError('A consumed agent approval cannot be revoked');
  if (message === 'AGENT_ACTION_APPROVAL_ALREADY_REVOKED')
    throw new ConflictError('Agent action approval is already revoked');
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
    if (actor.type === 'agent') requireAgent(actor);
    else requireHumanApprover(actor);
    const { actionId } = parseBody(actionParamsSchema, request.params);
    const action =
      actor.type === 'agent'
        ? await service.getForAgent({
            tenantId: actor.tenantId,
            agentPrincipalId: actor.id,
            actionId,
          })
        : actor.type === 'user'
          ? await service.getForSponsor({
              tenantId: actor.tenantId,
              sponsorPrincipalId: actor.id,
              actionId,
            })
          : undefined;
    if (!action) throw new NotFoundError('AgentAction', actionId);
    reply.header('Cache-Control', 'no-store');
    return action;
  });

  app.post('/agent/actions/:actionId/approvals', async (request, reply) => {
    const actor = request.principal!;
    requireHumanApprover(actor);
    const key = idempotencyKey(request.headers);
    const { actionId } = parseBody(actionParamsSchema, request.params);
    const { actionDigest } = parseBody(approvalSchema, request.body);
    const expectedConfirmation = `approve:${actionId}:${actionDigest}`;
    if (request.headers['x-tixkit-confirmation'] !== expectedConfirmation)
      throw new ValidationError(`x-tixkit-confirmation must equal ${expectedConfirmation}`);
    try {
      const approval = await service.approve({
        tenantId: actor.tenantId,
        approverPrincipalId: actor.id,
        actionId,
        actionDigest,
        idempotencyKey: key,
      });
      reply.header('Cache-Control', 'no-store');
      return reply.status(201).send(approval);
    } catch (error) {
      translateAgentActionError(key, error);
    }
  });

  app.post('/agent/actions/:actionId/approvals/:approvalId/revoke', async (request, reply) => {
    const actor = request.principal!;
    requireHumanSponsor(actor);
    const key = idempotencyKey(request.headers);
    const { actionId, approvalId } = parseBody(approvalParamsSchema, request.params);
    const { actionDigest } = parseBody(approvalSchema, request.body);
    const expectedConfirmation = `revoke:${actionId}:${approvalId}:${actionDigest}`;
    if (request.headers['x-tixkit-confirmation'] !== expectedConfirmation)
      throw new ValidationError(`x-tixkit-confirmation must equal ${expectedConfirmation}`);
    try {
      const approval = await service.revokeApproval({
        tenantId: actor.tenantId,
        sponsorPrincipalId: actor.id,
        actionId,
        approvalId,
        actionDigest,
        idempotencyKey: key,
      });
      reply.header('Cache-Control', 'no-store');
      return reply.send(approval);
    } catch (error) {
      translateAgentActionError(key, error);
    }
  });
};
