import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '@tixkit/domain';
import { registerErrorHandler } from '../app.js';
import { providerIncidentRoutes } from '../routes/modules/provider-incidents.js';
import {
  ProviderIncidentEvidenceUnavailableError,
  type ProviderIncidentEvidenceService,
} from '../services/provider-incident-evidence.js';

const evidenceId = 'pie_01HZZZZZZZZZZZZZZZZZZZZZZZ';
const organizationId = 'org_01';

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    type: 'user',
    id: 'user_01',
    tenantId: 'tenant_01',
    organizationIds: [organizationId],
    scopes: ['provider_incidents.read'],
    ...overrides,
  };
}

async function testApp(input: {
  principal: Principal;
  reveal: ReturnType<typeof vi.fn>;
  findActive?: ReturnType<typeof vi.fn>;
  acceptedPrivilegedMembership?: boolean;
  scopedGrant?: boolean;
}) {
  const app = Fastify();
  const db = {
    selectFrom: (table: string) => {
      const query = {
        select: () => query,
        where: () => query,
        executeTakeFirst: async () =>
          table === 'organization_members'
            ? input.acceptedPrivilegedMembership === false
              ? undefined
              : { id: 'member_01' }
            : input.scopedGrant === false
              ? undefined
              : { id: 'grant_01' },
      };
      return query;
    },
  };
  app.decorate('context', { db } as never);
  app.addHook('preHandler', async (request) => {
    request.principal = input.principal;
  });

  registerErrorHandler(app);
  await app.register(rateLimit, { global: false });
  await app.register(providerIncidentRoutes, {
    service: {
      reveal: input.reveal,
      findActiveByCorrelation: input.findActive ?? vi.fn(async () => []),
    } as unknown as ProviderIncidentEvidenceService,
  });
  return app;
}

describe('provider incident reveal route', () => {
  it('locates only hash metadata before plaintext reveal', async () => {
    const correlationSha256 = `sha256:${'a'.repeat(64)}`;
    const findActive = vi.fn(async () => [
      {
        id: evidenceId,
        provider: 'resend',
        operation: 'send-email',
        correlation_sha256: correlationSha256,
        captured_at: new Date('2026-07-16T12:00:00.000Z'),
        expires_at: new Date('2026-07-16T13:00:00.000Z'),
      },
    ]);
    const app = await testApp({ principal: principal(), reveal: vi.fn(), findActive });
    const response = await app.inject({
      method: 'GET',
      url: `/provider-incidents?organizationId=${organizationId}&correlationSha256=${correlationSha256}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({
      evidence: [
        {
          evidenceId,
          provider: 'resend',
          operation: 'send-email',
          correlationSha256,
          capturedAt: '2026-07-16T12:00:00.000Z',
          expiresAt: '2026-07-16T13:00:00.000Z',
        },
      ],
    });
    expect(JSON.stringify(response.json())).not.toContain('req_');
    await app.close();
  });

  it.each([
    ['API key', principal({ type: 'api_key' }), 403],
    ['agent', principal({ type: 'agent' }), 403],
    ['mobile device', principal({ type: 'mobile_device' }), 403],
    ['missing permission', principal({ scopes: ['developers.write'] }), 403],
    ['different organization', principal({ organizationIds: ['org_other'] }), 404],
  ])('denies %s principals before reveal', async (_label, denied, status) => {
    const reveal = vi.fn();
    const app = await testApp({ principal: denied, reveal });
    const response = await app.inject({
      method: 'POST',
      url: `/provider-incidents/${evidenceId}/reveal`,
      payload: { organizationId, reason: 'Provider support escalation' },
    });
    expect(response.statusCode).toBe(status);
    expect(reveal).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    ['API key', principal({ type: 'api_key' }), 403],
    ['agent', principal({ type: 'agent' }), 403],
    ['mobile device', principal({ type: 'mobile_device' }), 403],
    ['missing permission', principal({ scopes: ['developers.write'] }), 403],
    ['different organization', principal({ organizationIds: ['org_other'] }), 404],
  ])('denies %s principals before hash lookup', async (_label, denied, status) => {
    const findActive = vi.fn(async () => []);
    const app = await testApp({ principal: denied, reveal: vi.fn(), findActive });
    const response = await app.inject({
      method: 'GET',
      url: `/provider-incidents?organizationId=${organizationId}&correlationSha256=sha256:${'a'.repeat(64)}`,
    });
    expect(response.statusCode).toBe(status);
    expect(findActive).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    ['permission grant belongs to another organization', true, false],
    ['membership is not a current owner or administrator', false, true],
  ])('denies a mixed-organization principal when %s', async (_label, membership, grant) => {
    const reveal = vi.fn();
    const app = await testApp({
      principal: principal({ organizationIds: [organizationId, 'org_other'] }),
      reveal,
      acceptedPrivilegedMembership: membership,
      scopedGrant: grant,
    });
    const response = await app.inject({
      method: 'POST',
      url: `/provider-incidents/${evidenceId}/reveal`,
      payload: { organizationId, reason: 'Provider support escalation' },
    });
    expect(response.statusCode).toBe(404);
    expect(reveal).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    ['permission grant belongs to another organization', true, false],
    ['membership is not a current owner or administrator', false, true],
  ])('denies hash lookup when %s', async (_label, membership, grant) => {
    const findActive = vi.fn(async () => []);
    const app = await testApp({
      principal: principal({ organizationIds: [organizationId, 'org_other'] }),
      reveal: vi.fn(),
      findActive,
      acceptedPrivilegedMembership: membership,
      scopedGrant: grant,
    });
    const response = await app.inject({
      method: 'GET',
      url: `/provider-incidents?organizationId=${organizationId}&correlationSha256=sha256:${'a'.repeat(64)}`,
    });
    expect(response.statusCode).toBe(404);
    expect(findActive).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns the exact ID only after scoped service reveal and disables caching', async () => {
    const reveal = vi.fn(async () => 'req_exact_support_01');
    const app = await testApp({ principal: principal(), reveal });
    const response = await app.inject({
      method: 'POST',
      url: `/provider-incidents/${evidenceId}/reveal`,
      payload: { organizationId, reason: 'Provider support escalation' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({ requestId: 'req_exact_support_01' });
    expect(reveal).toHaveBeenCalledWith(
      expect.objectContaining({
        evidenceId,
        tenantId: 'tenant_01',
        organizationId,
        audit: expect.objectContaining({ actorType: 'user', actorId: 'user_01' }),
      }),
    );
    await app.close();
  });

  it.each([
    ['missing evidence', undefined, 404],
    ['disabled sink', new ProviderIncidentEvidenceUnavailableError(), 503],
    ['tampered ciphertext', new Error('ciphertext with req_secret_must_not_escape'), 503],
  ])('fails closed for %s', async (_label, outcome, status) => {
    const reveal =
      outcome instanceof Error
        ? vi.fn(async () => Promise.reject(outcome))
        : vi.fn(async () => outcome);
    const app = await testApp({ principal: principal(), reveal });
    const response = await app.inject({
      method: 'POST',
      url: `/provider-incidents/${evidenceId}/reveal`,
      payload: { organizationId, reason: 'Provider support escalation' },
    });
    expect(response.statusCode).toBe(status);
    expect(response.body).not.toContain('req_secret_must_not_escape');
    expect(response.headers['cache-control']).toBe('no-store');
    await app.close();
  });

  it('rejects unknown reveal fields and rate-limits repeated plaintext access', async () => {
    const reveal = vi.fn(async () => undefined);
    const app = await testApp({ principal: principal(), reveal });
    const invalid = await app.inject({
      method: 'POST',
      url: `/provider-incidents/${evidenceId}/reveal`,
      payload: { organizationId, reason: 'Provider support', unexpected: true },
    });
    expect(invalid.statusCode).toBe(400);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: `/provider-incidents/${evidenceId}/reveal`,
        payload: { organizationId, reason: 'Provider support' },
      });
      expect(response.statusCode).toBe(404);
    }
    const limited = await app.inject({
      method: 'POST',
      url: `/provider-incidents/${evidenceId}/reveal`,
      payload: { organizationId, reason: 'Provider support' },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['cache-control']).toBe('no-store');
    await app.close();
  });
});
