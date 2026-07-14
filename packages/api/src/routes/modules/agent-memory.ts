import {
  AgentProtocolValidationError,
  agentSha256,
  type AgentMemoryContent,
  type AgentMemoryEntry,
  type AgentMemoryNamespace,
} from '@tixkit/agent-protocol';
import { AgentMemoryRepository } from '@tixkit/db';
import {
  ConflictError,
  ForbiddenError,
  IdempotencyConflictError,
  NotFoundError,
  ValidationError,
  type Principal,
} from '@tixkit/domain';
import type { FastifyPluginAsync } from 'fastify';
import { ulid } from 'ulid';
import { z } from 'zod';
import { ClerkAuthService } from '../../auth/clerk.js';
import { parseBody } from '../../http/schemas.js';

const idSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{1,62}$/u);
const namespaceSchema = z
  .object({
    scopeType: z.enum(['workspace', 'event']),
    scopeId: idSchema.optional(),
    purpose: z.enum(['organizer_preferences', 'project_context']),
  })
  .strict()
  .superRefine((namespace, context) => {
    if (namespace.scopeType === 'workspace' && namespace.scopeId !== undefined)
      context.addIssue({ code: 'custom', path: ['scopeId'], message: 'Workspace has no scopeId' });
    if (namespace.scopeType === 'event' && namespace.scopeId === undefined)
      context.addIssue({ code: 'custom', path: ['scopeId'], message: 'Event scopeId is required' });
  });

const organizerPreferencesSchema = z
  .object({
    kind: z.literal('organizer_preferences'),
    summary: z.string().min(1).max(2_000),
    tone: z.enum(['concise', 'warm', 'formal', 'direct']).optional(),
    verbosity: z.enum(['brief', 'standard', 'detailed']).optional(),
    locale: z.string().optional(),
    timezone: z.string().optional(),
    currency: z.string().optional(),
  })
  .strict();
const projectContextSchema = z
  .object({
    kind: z.literal('project_context'),
    summary: z.string().min(1).max(2_000),
    facts: z
      .array(
        z
          .object({
            kind: z.enum(['objective', 'constraint', 'decision']),
            text: z.string().min(1).max(2_000),
          })
          .strict(),
      )
      .max(25)
      .optional(),
  })
  .strict();
const contentSchema = z.discriminatedUnion('kind', [
  organizerPreferencesSchema,
  projectContextSchema,
]);
const createSchema = z
  .object({
    namespace: namespaceSchema,
    key: z.string().regex(/^[a-z][a-z0-9_.-]{1,63}$/u),
    content: contentSchema,
    retentionExpiresAt: z.string().datetime(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.namespace.purpose !== input.content.kind)
      context.addIssue({
        code: 'custom',
        path: ['content', 'kind'],
        message: 'Content kind must match namespace purpose',
      });
  });
const inspectSchema = z.object({ namespace: namespaceSchema }).strict();
const correctSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    content: contentSchema,
    retentionExpiresAt: z.string().datetime(),
  })
  .strict();
const removeSchema = z
  .object({ namespace: namespaceSchema, expectedVersion: z.number().int().positive() })
  .strict();
const idParamsSchema = z.object({ id: idSchema }).strict();

export type AgentMemoryStore = Pick<
  AgentMemoryRepository,
  'create' | 'correct' | 'remove' | 'inspect'
>;

export interface AgentMemoryRouteOptions {
  repository?: AgentMemoryStore;
  now?: () => Date;
}

function requireHumanMemorySponsor(
  principal: Principal,
  namespace: z.infer<typeof namespaceSchema>,
): asserts principal is Principal & { type: 'user' } {
  if (principal.type !== 'user') throw new ForbiddenError('Only users can manage agent memory');
  const required = namespace.scopeType === 'event' ? 'events.write' : 'settings.write';
  if (
    !ClerkAuthService.hasPermission(principal, required) &&
    !ClerkAuthService.hasPermission(principal, 'developers.write')
  )
    throw new ForbiddenError('Agent memory sponsor lacks current authority');
  if (
    namespace.scopeType === 'event' &&
    principal.eventIds?.length &&
    !principal.eventIds.includes(namespace.scopeId as never)
  )
    throw new NotFoundError('Event', namespace.scopeId!);
}

function requireHumanMemoryActor(
  principal: Principal,
): asserts principal is Principal & { type: 'user' } {
  if (principal.type !== 'user') throw new ForbiddenError('Only users can manage agent memory');
}

function persistedNamespace(
  principal: Principal & { type: 'user' },
  namespace: z.infer<typeof namespaceSchema>,
): AgentMemoryNamespace {
  return {
    tenantId: principal.tenantId,
    sponsorPrincipalId: principal.id,
    scopeType: namespace.scopeType,
    ...(namespace.scopeId === undefined ? {} : { scopeId: namespace.scopeId }),
    purpose: namespace.purpose,
  };
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

function audit(principal: Principal & { type: 'user' }, key: string, reasonCode: string) {
  return {
    id: `memevt_${ulid().toLowerCase()}`,
    actorPrincipalId: principal.id,
    reasonCode,
    idempotencyKey: key,
  };
}

function memoryId(principal: Principal & { type: 'user' }, key: string): string {
  return `mem_${agentSha256({
    domain: 'tixkit-agent-memory-create-v1',
    tenantId: principal.tenantId,
    sponsorPrincipalId: principal.id,
    idempotencyKey: key,
  }).slice(0, 48)}`;
}

async function translateMemoryError<T>(key: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AgentProtocolValidationError) throw new ValidationError(error.message);
    const message = error instanceof Error ? error.message : '';
    if (message === 'AGENT_MEMORY_IDEMPOTENCY_CONFLICT') throw new IdempotencyConflictError(key);
    if (message === 'AGENT_MEMORY_ACTOR_DENIED')
      throw new ForbiddenError('Agent memory authorization changed');
    if (message === 'AGENT_MEMORY_SCOPE_NOT_FOUND')
      throw new NotFoundError('Agent memory scope', 'requested');
    if (message === 'AGENT_MEMORY_VERSION_CONFLICT')
      throw new ConflictError('Agent memory version changed');
    if (
      message === 'AGENT_MEMORY_PROJECT_SCOPE_UNAVAILABLE' ||
      message === 'AGENT_MEMORY_NAMESPACE_MISMATCH' ||
      message === 'AGENT_MEMORY_PROVENANCE_ACTOR_MISMATCH'
    )
      throw new ValidationError('Agent memory request is invalid');
    if (message === 'AGENT_MEMORY_RESOURCE_REBOUND')
      throw new ConflictError('Agent memory scope identity changed');
    throw error;
  }
}

function exportBundle(
  namespace: AgentMemoryNamespace,
  entries: readonly AgentMemoryEntry[],
  at: Date,
) {
  const body = {
    schemaVersion: 1,
    exportedAt: at.toISOString(),
    namespace,
    entries,
  } as const;
  return { ...body, sha256: agentSha256(body) };
}

export const agentMemoryRoutes: FastifyPluginAsync<AgentMemoryRouteOptions> = async (
  app,
  options,
) => {
  const repository = options.repository ?? new AgentMemoryRepository(app.context.db);
  const now = options.now ?? (() => new Date());

  app.post('/agent-memory', async (request, reply) => {
    const principal = request.principal!;
    const key = idempotencyKey(request.headers);
    const body = parseBody(createSchema, request.body);
    requireHumanMemorySponsor(principal, body.namespace);
    const namespace = persistedNamespace(principal, body.namespace);
    const entry = await translateMemoryError(key, () =>
      repository.create({
        id: memoryId(principal, key),
        namespace,
        key: body.key,
        content: body.content as AgentMemoryContent,
        provenance: {
          type: 'organizer',
          actorPrincipalId: principal.id,
          observedAt: now().toISOString(),
        },
        retentionExpiresAt: body.retentionExpiresAt,
        audit: audit(principal, key, 'PLATFORM_AGENT_MEMORY_CREATE'),
      }),
    );
    if (!entry) throw new ConflictError('Agent memory entry was not persisted');
    return reply.status(201).send(entry);
  });

  app.post('/agent-memory/inspect', async (request) => {
    const principal = request.principal!;
    const key = idempotencyKey(request.headers);
    const body = parseBody(inspectSchema, request.body);
    requireHumanMemorySponsor(principal, body.namespace);
    const namespace = persistedNamespace(principal, body.namespace);
    const entries = await translateMemoryError(key, () =>
      repository.inspect(
        namespace,
        audit(principal, key, 'PLATFORM_AGENT_MEMORY_INSPECT'),
        'inspect',
      ),
    );
    return { entries };
  });

  app.post('/agent-memory/export', async (request) => {
    const principal = request.principal!;
    const key = idempotencyKey(request.headers);
    const body = parseBody(inspectSchema, request.body);
    requireHumanMemorySponsor(principal, body.namespace);
    const namespace = persistedNamespace(principal, body.namespace);
    const entries = await translateMemoryError(key, () =>
      repository.inspect(
        namespace,
        audit(principal, key, 'PLATFORM_AGENT_MEMORY_EXPORT'),
        'export',
      ),
    );
    return exportBundle(namespace, entries, now());
  });

  app.patch('/agent-memory/:id', async (request) => {
    const principal = request.principal!;
    const key = idempotencyKey(request.headers);
    const { id } = parseBody(idParamsSchema, request.params);
    const body = parseBody(correctSchema, request.body);
    requireHumanMemoryActor(principal);
    const entry = await translateMemoryError(key, () =>
      repository.correct({
        tenantId: principal.tenantId,
        entryId: id,
        expectedVersion: body.expectedVersion,
        content: body.content as AgentMemoryContent,
        retentionExpiresAt: body.retentionExpiresAt,
        audit: audit(principal, key, 'PLATFORM_AGENT_MEMORY_CORRECT'),
      }),
    );
    if (!entry) throw new NotFoundError('AgentMemory', id);
    return entry;
  });

  app.post('/agent-memory/:id/delete', async (request) => {
    const principal = request.principal!;
    const key = idempotencyKey(request.headers);
    const { id } = parseBody(idParamsSchema, request.params);
    const body = parseBody(removeSchema, request.body);
    requireHumanMemorySponsor(principal, body.namespace);
    const namespace = persistedNamespace(principal, body.namespace);
    const removed = await translateMemoryError(key, () =>
      repository.remove({
        namespace,
        entryId: id,
        expectedVersion: body.expectedVersion,
        audit: audit(principal, key, 'PLATFORM_AGENT_MEMORY_DELETE'),
      }),
    );
    if (!removed) throw new NotFoundError('AgentMemory', id);
    return { id, deleted: true };
  });
};
