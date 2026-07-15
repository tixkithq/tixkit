import {
  AgentProtocolValidationError,
  validateAgentPlanDefinition,
  type AgentPlanDefinition,
  type AgentPlanState,
  type AgentPlanStatus,
  type AgentPlanStepState,
} from '@tixkit/agent-protocol';
import {
  AgentPlanRepository,
  type AgentPlanActionBinding,
  type PersistedAgentPlan,
} from '@tixkit/db';
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
import { parseBody } from '../../http/schemas.js';

const idSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{1,62}$/u);
const idempotencyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]+$/u;
const planParamsSchema = z.object({ planId: idSchema }).strict();
const actionBindingSchema = z.object({ stepId: idSchema, actionId: idSchema }).strict();
const createPlanSchema = z
  .object({
    definition: z.unknown(),
    actionBindings: z.array(actionBindingSchema).min(1).max(100),
  })
  .strict();
const stepStateSchema = z
  .object({
    stepId: idSchema,
    status: z.enum([
      'pending',
      'blocked',
      'awaiting_approval',
      'approved',
      'executing',
      'succeeded',
      'failed',
      'cancelled',
      'compensated',
    ]),
    approvalId: idSchema.optional(),
    executionId: idSchema.optional(),
    resultSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    failureCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{1,127}$/u)
      .optional(),
  })
  .strict();
const transitionPlanSchema = z
  .object({
    expectedStateVersion: z.number().int().positive(),
    status: z.enum([
      'prepared',
      'awaiting_approval',
      'executing',
      'succeeded',
      'failed',
      'cancelled',
      'expired',
      'compensated',
    ]),
    stepStates: z.array(stepStateSchema).min(1).max(100),
    reasonCode: z.string().regex(/^[a-z0-9][a-z0-9_.-]{1,63}$/u),
  })
  .strict();

export type AgentPlanStore = Pick<
  AgentPlanRepository,
  'create' | 'getForAgent' | 'getForSponsor' | 'transition'
>;

export interface AgentPlanRouteOptions {
  repository?: AgentPlanStore;
}

function requirePlanActor(principal: Principal): asserts principal is Principal & {
  type: 'agent' | 'user';
} {
  if (principal.type !== 'agent' && principal.type !== 'user')
    throw new ForbiddenError('An explicit agent or human sponsor principal is required');
}

function requireAgent(principal: Principal): asserts principal is Principal & { type: 'agent' } {
  if (principal.type !== 'agent')
    throw new ForbiddenError('An explicit agent principal is required');
}

function idempotencyKey(headers: Record<string, unknown>): string {
  const value = headers['idempotency-key'];
  if (
    typeof value !== 'string' ||
    value.length < 16 ||
    value.length > 255 ||
    value.trim() !== value ||
    !idempotencyPattern.test(value)
  )
    throw new ValidationError(
      'Idempotency-Key must contain 16-255 safe token characters with no surrounding whitespace',
    );
  return value;
}

async function translatePlanError<T>(key: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AgentProtocolValidationError) throw new ValidationError(error.message);
    const message = error instanceof Error ? error.message : '';
    if (message === 'AGENT_PLAN_IDEMPOTENCY_CONFLICT') throw new IdempotencyConflictError(key);
    if (message === 'AGENT_PLAN_NOT_FOUND' || message === 'AGENT_PLAN_ACTOR_DENIED')
      throw new NotFoundError('AgentPlan', 'requested');
    if (message === 'AGENT_PLAN_STATE_CONFLICT')
      throw new ConflictError('Agent plan state version changed');
    if (message === 'AGENT_PLAN_ID_CONFLICT')
      throw new ConflictError('Agent plan identifier is already in use');
    if (message === 'AGENT_PLAN_LIFETIME_INVALID')
      throw new ConflictError('Agent plan lifetime is no longer valid');
    if (message === 'AGENT_PLAN_EXECUTION_APPROVAL_BINDING_INVALID')
      throw new ConflictError('Agent plan approval and execution evidence no longer match');
    if (
      message === 'AGENT_PLAN_IDEMPOTENCY_KEY_INVALID' ||
      message === 'AGENT_PLAN_ACTION_BINDINGS_INVALID'
    )
      throw new ValidationError('Agent plan request is invalid');
    throw error;
  }
}

export const agentPlanRoutes: FastifyPluginAsync<AgentPlanRouteOptions> = async (app, options) => {
  const repository = options.repository ?? new AgentPlanRepository(app.context.db);

  app.post('/agent/plans', { config: { agentAccess: true } }, async (request, reply) => {
    const principal = request.principal!;
    requireAgent(principal);
    const key = idempotencyKey(request.headers);
    const body = parseBody(createPlanSchema, request.body);
    const persisted = await translatePlanError(key, () =>
      Promise.resolve().then(() => {
        validateAgentPlanDefinition(body.definition as AgentPlanDefinition);
        return repository.create({
          definition: body.definition as AgentPlanDefinition,
          actionBindings: body.actionBindings as readonly AgentPlanActionBinding[],
          actor: {
            type: 'agent',
            tenantId: principal.tenantId,
            principalId: principal.id,
          },
          idempotencyKey: key,
        });
      }),
    );
    reply.header('Cache-Control', 'no-store');
    return reply.status(201).send(persisted);
  });

  app.get('/agent/plans/:planId', { config: { agentAccess: true } }, async (request, reply) => {
    const principal = request.principal!;
    requirePlanActor(principal);
    const { planId } = parseBody(planParamsSchema, request.params);
    const persisted =
      principal.type === 'agent'
        ? await repository.getForAgent({
            tenantId: principal.tenantId,
            agentPrincipalId: principal.id,
            planId,
          })
        : await repository.getForSponsor({
            tenantId: principal.tenantId,
            sponsorPrincipalId: principal.id,
            planId,
          });
    if (!persisted) throw new NotFoundError('AgentPlan', planId);
    reply.header('Cache-Control', 'no-store');
    return persisted;
  });

  app.post(
    '/agent/plans/:planId/transitions',
    { config: { agentAccess: true } },
    async (request, reply) => {
      const principal = request.principal!;
      requirePlanActor(principal);
      const key = idempotencyKey(request.headers);
      const { planId } = parseBody(planParamsSchema, request.params);
      const body = parseBody(transitionPlanSchema, request.body);
      const persisted = await translatePlanError(key, () =>
        repository.transition({
          tenantId: principal.tenantId,
          planId,
          expectedStateVersion: body.expectedStateVersion,
          status: body.status as AgentPlanStatus,
          stepStates: body.stepStates as readonly AgentPlanStepState[],
          actor: {
            type: principal.type,
            tenantId: principal.tenantId,
            principalId: principal.id,
          },
          reasonCode: body.reasonCode,
          idempotencyKey: key,
        }),
      );
      reply.header('Cache-Control', 'no-store');
      return reply.send(persisted);
    },
  );
};

export type { AgentPlanDefinition, AgentPlanState, PersistedAgentPlan };
