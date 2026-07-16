import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { ForbiddenError, NotFoundError, type Principal } from '@tixkit/domain';
import type { Database } from '@tixkit/db';
import { ClerkAuthService } from '../../auth/clerk.js';
import { parseBody } from '../../http/schemas.js';
import {
  ProviderIncidentEvidenceUnavailableError,
  type ProviderIncidentEvidenceService,
} from '../../services/provider-incident-evidence.js';

const evidenceParamsSchema = z.object({
  evidenceId: z.string().regex(/^pie_[A-Z0-9]{26}$/u),
});
const revealSchema = z
  .object({
    organizationId: z
      .string()
      .min(1)
      .max(32)
      .regex(/^[A-Za-z0-9_-]+$/u),
    reason: z
      .string()
      .min(1)
      .max(256)
      .refine(
        (value) =>
          value === value.trim() &&
          ![...value].some((character) => (character.codePointAt(0) ?? 0) < 32),
        'Reason must be trimmed and contain no control characters',
      ),
  })
  .strict();
const lookupSchema = z
  .object({
    organizationId: z
      .string()
      .min(1)
      .max(32)
      .regex(/^[A-Za-z0-9_-]+$/u),
    correlationSha256: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  })
  .strict();

async function requireProviderIncidentRevealAccess(
  db: Database,
  principal: Principal,
  organizationId: string,
): Promise<void> {
  const [membership, grant] = await Promise.all([
    db
      .selectFrom('organization_members')
      .select('id')
      .where('tenant_id', '=', principal.tenantId)
      .where('organization_id', '=', organizationId)
      .where('user_id', '=', principal.id)
      .where('accepted_at', 'is not', null)
      .where('role', 'in', ['owner', 'admin'])
      .executeTakeFirst(),
    db
      .selectFrom('permission_grants')
      .select('id')
      .where('tenant_id', '=', principal.tenantId)
      .where('principal_type', '=', 'user')
      .where('principal_id', '=', principal.id)
      .where('permission', '=', 'provider_incidents.read')
      .where('scope_type', '=', 'organization')
      .where('scope_id', '=', organizationId)
      .executeTakeFirst(),
  ]);
  if (!membership || !grant) throw new NotFoundError('Organization', organizationId);
}

export type ProviderIncidentRouteOptions = {
  service?: ProviderIncidentEvidenceService;
};

export const providerIncidentRoutes: FastifyPluginAsync<ProviderIncidentRouteOptions> = async (
  app,
  options,
) => {
  app.get(
    '/provider-incidents',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      onRequest: async (_request, reply) => {
        reply.header('Cache-Control', 'no-store');
      },
    },
    async (request, reply) => {
      const principal = request.principal!;
      if (principal.type !== 'user')
        throw new ForbiddenError('Only human user principals can inspect provider evidence');
      ClerkAuthService.requirePermission(principal, 'provider_incidents.read');
      const query = parseBody(lookupSchema, request.query);
      ClerkAuthService.requireOrganizationScope(principal, query.organizationId);
      await requireProviderIncidentRevealAccess(app.context.db, principal, query.organizationId);
      const service = options.service ?? app.context.providerIncidentEvidenceService;
      if (!service)
        return reply.code(503).send({ message: 'Provider incident evidence unavailable' });
      try {
        const evidence = await service.findActiveByCorrelation({
          tenantId: principal.tenantId,
          organizationId: query.organizationId,
          correlationSha256: query.correlationSha256,
        });
        return {
          evidence: evidence.map((row) => ({
            evidenceId: row.id,
            provider: row.provider,
            operation: row.operation,
            correlationSha256: row.correlation_sha256,
            capturedAt: new Date(row.captured_at).toISOString(),
            expiresAt: new Date(row.expires_at).toISOString(),
          })),
        };
      } catch {
        return reply.code(503).send({ message: 'Provider incident evidence unavailable' });
      }
    },
  );

  app.post(
    '/provider-incidents/:evidenceId/reveal',
    {
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      onRequest: async (_request, reply) => {
        reply.header('Cache-Control', 'no-store');
      },
    },
    async (request, reply) => {
      const principal = request.principal!;
      if (principal.type !== 'user')
        throw new ForbiddenError(
          'Only human user principals can reveal provider incident evidence',
        );
      ClerkAuthService.requirePermission(principal, 'provider_incidents.read');
      const params = parseBody(evidenceParamsSchema, request.params);
      const body = parseBody(revealSchema, request.body);
      ClerkAuthService.requireOrganizationScope(principal, body.organizationId);
      await requireProviderIncidentRevealAccess(app.context.db, principal, body.organizationId);
      const service = options.service ?? app.context.providerIncidentEvidenceService;
      if (!service)
        return reply.code(503).send({ message: 'Provider incident evidence unavailable' });

      let requestId: string | undefined;
      try {
        requestId = await service.reveal({
          evidenceId: params.evidenceId,
          tenantId: principal.tenantId,
          organizationId: body.organizationId,
          audit: {
            actorType: 'user',
            actorId: principal.id,
            reason: body.reason,
            requestId: request.id,
            ip: request.ip,
            userAgent: request.headers['user-agent'],
          },
        });
      } catch (error) {
        if (error instanceof ProviderIncidentEvidenceUnavailableError)
          return reply.code(503).send({ message: 'Provider incident evidence unavailable' });
        request.log.warn(
          { evidenceId: params.evidenceId },
          'Provider incident reveal failed closed',
        );
        return reply.code(503).send({ message: 'Provider incident evidence unavailable' });
      }
      if (requestId === undefined)
        throw new NotFoundError('Provider incident evidence', params.evidenceId);
      return { requestId };
    },
  );
};
