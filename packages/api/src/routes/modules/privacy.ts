import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AuditLogRepository,
  BrandRepository,
  PrivacyRequestRepository,
  type Database,
} from '@tixkit/db';
import { NotFoundError, ValidationError, type Principal } from '@tixkit/domain';
import { ClerkAuthService } from '../../auth/clerk.js';
import { writeAuditLog } from '../../auth/audit.js';
import { pageEnvelope, parseJsonValue, parsePagination, toIso } from '../../http/contracts.js';
import { hashRequest, withIdempotency } from '../../services/idempotency.js';

const privacyRequestSchema = z
  .object({
    organizationId: z.string().min(1),
    brandId: z.string().min(1).optional(),
    subjectType: z.enum(['buyer', 'attendee']),
    subjectId: z.string().min(1).optional(),
    subjectEmail: z.string().email().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.subjectId && !value.subjectEmail) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'subjectId or subjectEmail is required',
        path: ['subjectEmail'],
      });
    }
  });

type PrivacyRequestBody = z.infer<typeof privacyRequestSchema> & {
  subjectEmail?: string;
};

function parsePrivacyBody(body: unknown): PrivacyRequestBody {
  const parsed = privacyRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError('Invalid privacy request', {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }

  return {
    ...parsed.data,
    subjectEmail: parsed.data.subjectEmail?.trim().toLowerCase(),
  };
}

async function assertPrivacyScope(
  principal: Principal,
  db: Database,
  input: { organizationId: string; brandId?: string },
): Promise<void> {
  ClerkAuthService.requireOrganizationScope(principal, input.organizationId);
  if (!input.brandId) return;

  const brand = await new BrandRepository(db).findById(input.brandId);
  if (!brand) throw new NotFoundError('Brand', input.brandId);
  ClerkAuthService.requireResourceTenant(principal, brand, 'Brand', input.brandId);
  ClerkAuthService.requireOrganizationScope(principal, brand.organization_id);
  ClerkAuthService.requireBrandScope(principal, input.brandId);
  if (brand.organization_id !== input.organizationId) {
    throw new ValidationError('Brand does not belong to the requested organization');
  }
}

function serializeAuditLog(row: Record<string, unknown>) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    organizationId: row.organization_id ?? null,
    brandId: row.brand_id ?? null,
    actorType: row.actor_type,
    actorId: row.actor_id,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    diffSummary: parseJsonValue(row.diff_summary, null),
    requestId: row.request_id ?? null,
    ip: row.ip ?? null,
    userAgent: row.user_agent ?? null,
    createdAt: toIso(row.created_at as Date | string),
  };
}

function serializePrivacyRequest(row: Record<string, unknown>) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    organizationId: row.organization_id,
    brandId: row.brand_id ?? null,
    requestType: row.request_type,
    subjectType: row.subject_type,
    subjectId: row.subject_id ?? null,
    subjectEmail: row.subject_email ?? null,
    status: row.status,
    requestedBy: row.requested_by,
    result: parseJsonValue(row.result, null),
    error: row.error ?? null,
    createdAt: toIso(row.created_at as Date | string),
    completedAt: toIso(row.completed_at as Date | string | null) ?? null,
  };
}

export const privacyRoutes: FastifyPluginAsync = async (app) => {
  const db = app.context.db;
  const auditRepo = () => new AuditLogRepository(db);
  const privacyRepo = () => new PrivacyRequestRepository(db);

  app.get('/audit-logs', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'settings.write');
    const pagination = parsePagination(request.query);
    const query = request.query as Record<string, unknown>;
    const organizationId =
      typeof query.organizationId === 'string' ? query.organizationId : undefined;
    const brandId = typeof query.brandId === 'string' ? query.brandId : undefined;

    if (organizationId) ClerkAuthService.requireOrganizationScope(principal, organizationId);
    if (brandId) ClerkAuthService.requireBrandScope(principal, brandId);
    if (principal.type !== 'system' && principal.organizationIds.length === 0) {
      return pageEnvelope([], pagination.limit);
    }

    const rows = await auditRepo().listByTenant(principal.tenantId, {
      organizationIds: principal.type === 'system' ? undefined : principal.organizationIds,
      organizationId,
      brandId,
      action: typeof query.action === 'string' ? query.action : undefined,
      resourceType: typeof query.resourceType === 'string' ? query.resourceType : undefined,
      actorId: typeof query.actorId === 'string' ? query.actorId : undefined,
      cursor: pagination.cursor,
      limit: pagination.limit,
    });

    return pageEnvelope(rows.map(serializeAuditLog), pagination.limit);
  });

  app.get('/privacy/requests', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'settings.write');
    const pagination = parsePagination(request.query);
    const query = request.query as Record<string, unknown>;
    const organizationId =
      typeof query.organizationId === 'string' ? query.organizationId : undefined;
    const brandId = typeof query.brandId === 'string' ? query.brandId : undefined;

    if (organizationId) ClerkAuthService.requireOrganizationScope(principal, organizationId);
    if (brandId) ClerkAuthService.requireBrandScope(principal, brandId);
    if (principal.type !== 'system' && principal.organizationIds.length === 0) {
      return pageEnvelope([], pagination.limit);
    }

    const rows = await privacyRepo().listByTenant(principal.tenantId, {
      organizationIds: principal.type === 'system' ? undefined : principal.organizationIds,
      organizationId,
      brandId,
      requestType: typeof query.requestType === 'string' ? query.requestType : undefined,
      status: typeof query.status === 'string' ? query.status : undefined,
      cursor: pagination.cursor,
      limit: pagination.limit,
    });

    return pageEnvelope(rows.map(serializePrivacyRequest), pagination.limit);
  });

  app.get('/privacy/requests/:requestId', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'settings.write');
    const { requestId } = request.params as { requestId: string };
    const row = await privacyRepo().findById(requestId);
    if (!row || row.tenant_id !== principal.tenantId) {
      throw new NotFoundError('PrivacyRequest', requestId);
    }
    ClerkAuthService.requireOrganizationScope(principal, row.organization_id);
    if (row.brand_id) ClerkAuthService.requireBrandScope(principal, row.brand_id);
    return serializePrivacyRequest(row);
  });

  async function createPrivacyRequest(
    requestType: 'export' | 'erasure',
    request: FastifyRequest,
    reply: FastifyReply,
  ) {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'settings.write');
    const body = parsePrivacyBody(request.body);
    await assertPrivacyScope(principal, db, body);

    const idempotencyKey = request.headers['idempotency-key'];
    if (typeof idempotencyKey !== 'string') {
      throw new ValidationError('Idempotency-Key header is required for privacy requests');
    }

    const result = await withIdempotency(
      db,
      {
        key: idempotencyKey,
        tenantId: principal.tenantId,
        requestHash: hashRequest({ requestType, ...body }),
      },
      async () => {
        const row = await privacyRepo().create({
          tenantId: principal.tenantId,
          organizationId: body.organizationId,
          brandId: body.brandId ?? null,
          requestType,
          subjectType: body.subjectType,
          subjectId: body.subjectId ?? null,
          subjectEmail: body.subjectEmail ?? null,
          requestedBy: principal.id,
        });

        await app.context.temporalClient.startPrivacyRequest({ requestId: row.id });

        await writeAuditLog(auditRepo(), request, principal, {
          action: `privacy.${requestType}.requested`,
          organizationId: body.organizationId,
          brandId: body.brandId ?? null,
          resourceType: 'PrivacyRequest',
          resourceId: row.id,
          diffSummary: {
            subjectType: body.subjectType,
            subjectId: body.subjectId ?? null,
            subjectEmail: body.subjectEmail ?? null,
          },
        });

        return { status: 202, body: serializePrivacyRequest(row) };
      },
    );

    return reply.status(result.status).send(result.body);
  }

  app.post('/privacy/data-exports', async (request, reply) =>
    createPrivacyRequest('export', request, reply),
  );

  app.post('/privacy/erasures', async (request, reply) =>
    createPrivacyRequest('erasure', request, reply),
  );
};
