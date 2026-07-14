import {
  agentSha256,
  normalizeAgentMemoryContent,
  type AgentMemoryContent,
  type AgentMemoryEntry,
  type AgentMemoryNamespace,
} from '@tixkit/agent-protocol';
import type { Principal } from '@tixkit/domain';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerErrorHandler } from '../app.js';
import {
  agentMemoryRoutes,
  type AgentMemoryRouteOptions,
  type AgentMemoryStore,
} from '../routes/modules/agent-memory.js';

const tenantId = 'tenant_agent_memory_01';
const sponsorId = 'user_agent_memory_01';
const eventId = 'event_agent_memory_01';
const now = new Date('2026-07-20T12:00:00.000Z');
const idempotencyKey = 'agent-memory-idempotency-0001';

function sponsor(overrides: Partial<Principal> = {}): Principal {
  return {
    type: 'user',
    id: sponsorId,
    tenantId,
    organizationIds: ['org_agent_memory_01'],
    scopes: ['settings.write', 'events.write'],
    ...overrides,
  };
}

const workspaceNamespace = {
  scopeType: 'workspace' as const,
  purpose: 'organizer_preferences' as const,
};
const content = {
  kind: 'organizer_preferences' as const,
  summary: 'Prefer concise copy',
  tone: 'concise' as const,
};

function entry(
  id: string,
  namespace: AgentMemoryNamespace,
  value: AgentMemoryContent = content,
): AgentMemoryEntry {
  return {
    id,
    namespace,
    key: 'copy_preferences',
    content: value,
    contentSha256: agentSha256(value),
    provenance: {
      type: 'organizer',
      actorPrincipalId: sponsorId,
      observedAt: now.toISOString(),
    },
    version: 1,
    retentionExpiresAt: '2026-08-20T12:00:00.000Z',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

function store(overrides: Partial<AgentMemoryStore> = {}): AgentMemoryStore {
  return {
    create: vi.fn(async (input) =>
      entry(input.id, input.namespace, normalizeAgentMemoryContent(input.content)),
    ),
    correct: vi.fn(async (input) =>
      entry(input.entryId, {
        tenantId: input.tenantId,
        sponsorPrincipalId: sponsorId,
        scopeType: 'workspace',
        purpose: input.content.kind,
      }),
    ),
    remove: vi.fn(async () => true),
    inspect: vi.fn(async () => []),
    ...overrides,
  };
}

async function testApp(
  principal: Principal,
  repository: AgentMemoryStore,
  options: Omit<AgentMemoryRouteOptions, 'repository' | 'now'> = {},
) {
  const app = Fastify({ logger: false, genReqId: () => 'req_agent_memory' });
  app.decorate('context', { db: {} } as never);
  app.addHook('preHandler', async (request) => {
    request.principal = principal;
  });
  registerErrorHandler(app);
  await app.register(agentMemoryRoutes, { ...options, repository, now: () => now });
  return app;
}

describe('agent memory routes', () => {
  it('creates sponsor-bound memory with stable server-owned identity and provenance', async () => {
    const repository = store();
    const app = await testApp(sponsor(), repository);
    const request = {
      method: 'POST' as const,
      url: '/agent-memory',
      headers: { 'idempotency-key': idempotencyKey },
      payload: {
        namespace: workspaceNamespace,
        key: 'copy_preferences',
        content,
        retentionExpiresAt: '2026-08-20T12:00:00.000Z',
      },
    };
    const first = await app.inject(request);
    const second = await app.inject(request);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    const firstId = first.json().id as string;
    expect(firstId).toMatch(/^mem_[a-f0-9]{48}$/u);
    expect(second.json().id).toBe(firstId);
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        id: firstId,
        namespace: {
          tenantId,
          sponsorPrincipalId: sponsorId,
          ...workspaceNamespace,
        },
        provenance: {
          type: 'organizer',
          actorPrincipalId: sponsorId,
          observedAt: now.toISOString(),
        },
        audit: expect.objectContaining({
          actorPrincipalId: sponsorId,
          idempotencyKey,
          reasonCode: 'PLATFORM_AGENT_MEMORY_CREATE',
        }),
      }),
    );
    await app.close();
  });

  it.each([
    sponsor({ type: 'api_key' as never }),
    sponsor({ type: 'mobile_device' as never }),
    sponsor({ scopes: ['events.read'] }),
  ])('denies non-human and underprivileged memory sponsors', async (principal) => {
    const repository = store();
    const app = await testApp(principal, repository);
    const response = await app.inject({
      method: 'POST',
      url: '/agent-memory',
      headers: { 'idempotency-key': idempotencyKey },
      payload: {
        namespace: workspaceNamespace,
        key: 'copy_preferences',
        content,
        retentionExpiresAt: '2026-08-20T12:00:00.000Z',
      },
    });
    expect(response.statusCode).toBe(403);
    expect(repository.create).not.toHaveBeenCalled();
    await app.close();
  });

  it('conceals event memory outside the caller resource scope', async () => {
    const repository = store();
    const app = await testApp(sponsor({ eventIds: ['event_allowed_01'] }), repository);
    const response = await app.inject({
      method: 'POST',
      url: '/agent-memory/inspect',
      headers: { 'idempotency-key': idempotencyKey },
      payload: {
        namespace: {
          scopeType: 'event',
          scopeId: eventId,
          purpose: 'project_context',
        },
      },
    });
    expect(response.statusCode).toBe(404);
    expect(repository.inspect).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects server-owned namespace fields, sensitive content, and weak idempotency keys', async () => {
    const repository = store();
    const app = await testApp(sponsor(), repository);
    const serverOwned = await app.inject({
      method: 'POST',
      url: '/agent-memory',
      headers: { 'idempotency-key': idempotencyKey },
      payload: {
        namespace: { ...workspaceNamespace, tenantId, sponsorPrincipalId: sponsorId },
        key: 'copy_preferences',
        content,
        retentionExpiresAt: '2026-08-20T12:00:00.000Z',
      },
    });
    const sensitive = await app.inject({
      method: 'POST',
      url: '/agent-memory',
      headers: { 'idempotency-key': idempotencyKey },
      payload: {
        namespace: workspaceNamespace,
        key: 'copy_preferences',
        content: { ...content, summary: 'Email buyer@example.com' },
        retentionExpiresAt: '2026-08-20T12:00:00.000Z',
      },
    });
    const weak = await app.inject({
      method: 'POST',
      url: '/agent-memory',
      headers: { 'idempotency-key': 'short' },
      payload: {
        namespace: workspaceNamespace,
        key: 'copy_preferences',
        content,
        retentionExpiresAt: '2026-08-20T12:00:00.000Z',
      },
    });
    expect(serverOwned.statusCode).toBe(400);
    expect(sensitive.statusCode).toBe(400);
    expect(weak.statusCode).toBe(400);
    await app.close();
  });

  it.each([sponsor({ type: 'api_key' as never }), sponsor({ type: 'mobile_device' as never })])(
    'denies non-human principals on every memory operation',
    async (principal) => {
      const repository = store();
      const app = await testApp(principal, repository);
      const requests = [
        {
          method: 'POST' as const,
          url: '/agent-memory/inspect',
          payload: { namespace: workspaceNamespace },
        },
        {
          method: 'POST' as const,
          url: '/agent-memory/export',
          payload: { namespace: workspaceNamespace },
        },
        {
          method: 'PATCH' as const,
          url: '/agent-memory/mem_denied_01',
          payload: {
            expectedVersion: 1,
            content,
            retentionExpiresAt: '2026-08-20T12:00:00.000Z',
          },
        },
        {
          method: 'POST' as const,
          url: '/agent-memory/mem_denied_01/delete',
          payload: { namespace: workspaceNamespace, expectedVersion: 1 },
        },
      ];
      for (const request of requests) {
        const response = await app.inject({
          ...request,
          headers: { 'idempotency-key': `${idempotencyKey}-${request.method}-${request.url}` },
        });
        expect(response.statusCode).toBe(403);
      }
      expect(repository.inspect).not.toHaveBeenCalled();
      expect(repository.correct).not.toHaveBeenCalled();
      expect(repository.remove).not.toHaveBeenCalled();
      await app.close();
    },
  );

  it('rejects a create whose memory kind does not match its namespace purpose', async () => {
    const repository = store();
    const app = await testApp(sponsor(), repository);
    const response = await app.inject({
      method: 'POST',
      url: '/agent-memory',
      headers: { 'idempotency-key': idempotencyKey },
      payload: {
        namespace: workspaceNamespace,
        key: 'event_context',
        content: { kind: 'project_context', summary: 'Prepare the event launch' },
        retentionExpiresAt: '2026-08-20T12:00:00.000Z',
      },
    });
    expect(response.statusCode).toBe(400);
    expect(repository.create).not.toHaveBeenCalled();
    await app.close();
  });

  it('exports an inspectable checksummed logical bundle', async () => {
    const namespace: AgentMemoryNamespace = {
      tenantId,
      sponsorPrincipalId: sponsorId,
      scopeType: 'workspace',
      purpose: 'organizer_preferences',
    };
    const entries = [entry('mem_export_01', namespace)];
    const repository = store({ inspect: vi.fn(async () => entries) });
    const app = await testApp(sponsor(), repository);
    const response = await app.inject({
      method: 'POST',
      url: '/agent-memory/export',
      headers: { 'idempotency-key': idempotencyKey },
      payload: { namespace: workspaceNamespace },
    });
    expect(response.statusCode).toBe(200);
    const bundle = response.json();
    expect(bundle).toMatchObject({ schemaVersion: 1, exportedAt: now.toISOString(), entries });
    const { sha256, ...body } = bundle;
    expect(sha256).toBe(agentSha256(body));
    expect(repository.inspect).toHaveBeenCalledWith(
      namespace,
      expect.objectContaining({ reasonCode: 'PLATFORM_AGENT_MEMORY_EXPORT' }),
      'export',
    );
    await app.close();
  });

  it('corrects and deletes through version-aware repository operations', async () => {
    const repository = store();
    const app = await testApp(sponsor(), repository);
    const corrected = await app.inject({
      method: 'PATCH',
      url: '/agent-memory/mem_change_01',
      headers: { 'idempotency-key': idempotencyKey },
      payload: {
        expectedVersion: 1,
        content: { ...content, summary: 'Prefer direct copy', tone: 'direct' },
        retentionExpiresAt: '2026-09-20T12:00:00.000Z',
      },
    });
    const removed = await app.inject({
      method: 'POST',
      url: '/agent-memory/mem_change_01/delete',
      headers: { 'idempotency-key': `${idempotencyKey}-delete` },
      payload: { namespace: workspaceNamespace, expectedVersion: 2 },
    });
    expect(corrected.statusCode).toBe(200);
    expect(removed.statusCode).toBe(200);
    expect(repository.correct).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId, entryId: 'mem_change_01', expectedVersion: 1 }),
    );
    expect(repository.remove).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: { tenantId, sponsorPrincipalId: sponsorId, ...workspaceNamespace },
        entryId: 'mem_change_01',
        expectedVersion: 2,
      }),
    );
    await app.close();
  });
});
