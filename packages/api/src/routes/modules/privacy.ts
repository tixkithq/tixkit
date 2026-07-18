import { createHash } from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AuditLogRepository,
  BrandRepository,
  PrivacyRequestRepository,
  type Database,
  executeTableQuery,
} from '@tixkit/db';
import {
  col,
  defineTable,
  paramsToQuery,
  type AdminTableQuery,
  type AdminTablePage,
} from '@tixkit/admin-table-core';
import { ForbiddenError, NotFoundError, ValidationError, type Principal } from '@tixkit/domain';
import { ClerkAuthService } from '../../auth/clerk.js';
import { writeAuditLog } from '../../auth/audit.js';
import { parseJsonValue, toIso } from '../../http/contracts.js';
import { hashRequest, withIdempotency } from '../../services/idempotency.js';

// ---------------------------------------------------------------------------
// Server-owned table schemas for audit logs and privacy requests
// ---------------------------------------------------------------------------

const auditLogTableSchema = defineTable('audit_logs', {
  primaryKey: 'id',
  defaultSort: { field: 'createdAt', direction: 'desc' },
  columns: [
    col.id('id').serverField('id'),
    col.enum('action', []).serverField('action').facet(),
    col.enum('resourceType', []).serverField('resource_type').facet(),
    col.text('actorId').serverField('actor_id').filterable(),
    col.dateTime('createdAt').serverField('created_at').sortable().filterable().facet(),
  ],
});

const auditLogListColumns = [
  'id',
  'tenant_id',
  'organization_id',
  'brand_id',
  'actor_type',
  'actor_id',
  'action',
  'resource_type',
  'resource_id',
  'diff_summary',
  'request_id',
  'ip',
  'user_agent',
  'created_at',
] as const;

const PRIVACY_REQUEST_STATUS_PRESETS = ['pending', 'processing', 'completed', 'failed'] as const;

const privacyRequestTableSchema = defineTable('privacy_requests', {
  primaryKey: 'id',
  defaultSort: { field: 'createdAt', direction: 'desc' },
  columns: [
    col.id('id').serverField('id'),
    col.enum('requestType', ['export', 'erasure']).serverField('request_type').facet(),
    col.status('status', PRIVACY_REQUEST_STATUS_PRESETS).serverField('status').sortable().facet(),
    col.enum('subjectType', ['buyer', 'attendee']).serverField('subject_type').facet(),
    col.dateTime('createdAt').serverField('created_at').sortable().filterable().facet(),
    col.dateTime('completedAt').serverField('completed_at').filterable(),
  ],
});

const privacyRequestListColumns = [
  'id',
  'tenant_id',
  'organization_id',
  'brand_id',
  'request_type',
  'subject_type',
  'subject_id',
  'subject_email',
  'status',
  'requested_by',
  'result',
  'error',
  'created_at',
  'completed_at',
] as const;

function parseStrictTableQuery(
  schema: Parameters<typeof paramsToQuery>[0],
  params: URLSearchParams,
): AdminTableQuery {
  const { query, rejected } = paramsToQuery(schema, params);
  if (rejected.length > 0) {
    throw new ValidationError(`Invalid table query parameters: ${rejected.join(', ')}`, {
      rejected,
    });
  }
  return query;
}

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

function deterministicPrivacyRequestId(input: {
  tenantId: string;
  idempotencyKey: string;
  requestHash: string;
}): string {
  const digest = createHash('sha256')
    .update(input.tenantId)
    .update('\0')
    .update(input.idempotencyKey)
    .update('\0')
    .update(input.requestHash)
    .digest('hex')
    .slice(0, 26);
  return `prv_${digest}`;
}

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
  ClerkAuthService.requireNoEventScope(principal, 'privacy requests');
  if (!input.brandId) {
    if (principal.brandIds && principal.brandIds.length > 0) {
      throw new ForbiddenError('Brand-scoped principals must provide brandId for privacy requests');
    }
    return;
  }

  const brand = await new BrandRepository(db).findById(input.brandId);
  if (!brand) throw new NotFoundError('Brand', input.brandId);
  ClerkAuthService.requireResourceTenant(principal, brand, 'Brand', input.brandId);
  ClerkAuthService.requireOrganizationScope(principal, brand.organization_id);
  ClerkAuthService.requireBrandScope(principal, input.brandId);
  if (brand.organization_id !== input.organizationId) {
    throw new NotFoundError('Brand', input.brandId);
  }
}

async function assertLockedPrivacyScope(
  principal: Principal,
  db: Database,
  input: { organizationId: string; brandId?: string },
): Promise<void> {
  ClerkAuthService.requireNoEventScope(principal, 'privacy requests');
  const organization = await db
    .selectFrom('organizations')
    .select(['id', 'tenant_id'])
    .where('id', '=', input.organizationId)
    .forUpdate()
    .executeTakeFirst();
  if (!organization) throw new NotFoundError('Organization', input.organizationId);
  ClerkAuthService.requireResourceTenant(
    principal,
    organization,
    'Organization',
    input.organizationId,
  );
  ClerkAuthService.requireOrganizationScope(principal, input.organizationId);

  if (!input.brandId) {
    if (principal.brandIds && principal.brandIds.length > 0) {
      throw new ForbiddenError('Brand-scoped principals must provide brandId for privacy requests');
    }
    return;
  }

  const brand = await db
    .selectFrom('brands')
    .select(['id', 'tenant_id', 'organization_id'])
    .where('id', '=', input.brandId)
    .forUpdate()
    .executeTakeFirst();
  if (!brand || brand.organization_id !== input.organizationId) {
    throw new NotFoundError('Brand', input.brandId);
  }
  ClerkAuthService.requireResourceTenant(principal, brand, 'Brand', input.brandId);
  ClerkAuthService.requireOrganizationScope(principal, brand.organization_id);
  ClerkAuthService.requireBrandScope(principal, input.brandId);
}

function scopedBrandIdsForPrivacyList(
  principal: Principal,
  brandId?: string,
): string | string[] | undefined {
  ClerkAuthService.requireNoEventScope(principal, 'privacy and audit lists');
  if (brandId) {
    ClerkAuthService.requireBrandScope(principal, brandId);
    return brandId;
  }
  return principal.brandIds && principal.brandIds.length > 0 ? principal.brandIds : undefined;
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

function serializePrivacyRequest(
  row: Record<string, unknown>,
  options: { redactSubject?: boolean } = {},
) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    organizationId: row.organization_id,
    brandId: row.brand_id ?? null,
    requestType: row.request_type,
    subjectType: row.subject_type,
    subjectId: options.redactSubject ? null : (row.subject_id ?? null),
    subjectEmail: options.redactSubject ? null : (row.subject_email ?? null),
    status: row.status,
    requestedBy: row.requested_by,
    result: parseJsonValue(row.result, null),
    error: row.error ?? null,
    createdAt: toIso(row.created_at as Date | string),
    completedAt: toIso(row.completed_at as Date | string | null) ?? null,
  };
}

function redactPrivacyRequestResponse(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  return { ...(body as Record<string, unknown>), subjectId: null, subjectEmail: null };
}

export const privacyRoutes: FastifyPluginAsync = async (app) => {
  const db = app.context.db;
  const privacyRepo = () => new PrivacyRequestRepository(db);

  app.get('/audit-logs', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'settings.write');

    const rawQuery = request.query as Record<string, string | undefined>;
    const { organizationId, brandId } = rawQuery;

    if (organizationId) ClerkAuthService.requireOrganizationScope(principal, organizationId);
    const brandScope = scopedBrandIdsForPrivacyList(principal, brandId);

    if (principal.type !== 'system' && principal.organizationIds.length === 0) {
      return {
        items: [],
        nextCursor: undefined,
        total: 0,
        filterTotal: 0,
      } as AdminTablePage<unknown>;
    }

    const scope: Record<string, string | string[]> = {};
    if (organizationId) {
      scope.organization_id = organizationId;
    } else if (principal.type !== 'system') {
      scope.organization_id = principal.organizationIds;
    }
    if (brandScope) scope.brand_id = brandScope;

    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(rawQuery)) {
      if (value !== undefined && key !== 'organizationId' && key !== 'brandId') {
        searchParams.set(key, value);
      }
    }
    const tableQuery = parseStrictTableQuery(auditLogTableSchema, searchParams);

    const result = await executeTableQuery(
      db,
      {
        tableName: 'audit_logs',
        schema: auditLogTableSchema,
        tenantId: principal.tenantId,
        scope,
        serialize: serializeAuditLog,
        selectFields: auditLogListColumns,
      },
      tableQuery,
    );

    return result as AdminTablePage<unknown>;
  });

  app.get('/privacy/requests', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'settings.write');

    const rawQuery = request.query as Record<string, string | undefined>;
    const { organizationId, brandId } = rawQuery;

    if (organizationId) ClerkAuthService.requireOrganizationScope(principal, organizationId);
    const brandScope = scopedBrandIdsForPrivacyList(principal, brandId);

    if (principal.type !== 'system' && principal.organizationIds.length === 0) {
      return {
        items: [],
        nextCursor: undefined,
        total: 0,
        filterTotal: 0,
      } as AdminTablePage<unknown>;
    }

    const scope: Record<string, string | string[]> = {};
    if (organizationId) {
      scope.organization_id = organizationId;
    } else if (principal.type !== 'system') {
      scope.organization_id = principal.organizationIds;
    }
    if (brandScope) scope.brand_id = brandScope;

    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(rawQuery)) {
      if (value !== undefined && key !== 'organizationId' && key !== 'brandId') {
        searchParams.set(key, value);
      }
    }
    const tableQuery = parseStrictTableQuery(privacyRequestTableSchema, searchParams);

    const result = await executeTableQuery(
      db,
      {
        tableName: 'privacy_requests',
        schema: privacyRequestTableSchema,
        tenantId: principal.tenantId,
        scope,
        serialize: serializePrivacyRequest,
        selectFields: privacyRequestListColumns,
      },
      tableQuery,
    );

    return result as AdminTablePage<unknown>;
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
    ClerkAuthService.requireNoEventScope(principal, 'privacy requests');
    if (principal.brandIds && principal.brandIds.length > 0 && !row.brand_id) {
      throw new NotFoundError('PrivacyRequest', requestId);
    }
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

    const actorBoundRequestHash = hashRequest({
      requestType,
      actor: { type: principal.type, id: principal.id },
      ...body,
    });
    const legacyRequestHash = hashRequest({ requestType, ...body });
    const legacyRequestId = deterministicPrivacyRequestId({
      tenantId: principal.tenantId,
      idempotencyKey,
      requestHash: legacyRequestHash,
    });
    const legacyRequest = await privacyRepo().findById(legacyRequestId);
    const useLegacyIdentity =
      legacyRequest?.tenant_id === principal.tenantId &&
      legacyRequest.requested_by === principal.id;
    const requestHash = useLegacyIdentity ? legacyRequestHash : actorBoundRequestHash;
    const requestId = useLegacyIdentity
      ? legacyRequestId
      : deterministicPrivacyRequestId({
          tenantId: principal.tenantId,
          idempotencyKey,
          requestHash,
        });
    const subjectSha256 = hashRequest({
      subjectType: body.subjectType,
      subjectId: body.subjectId ?? null,
      subjectEmail: body.subjectEmail ?? null,
    });
    await app.context.privacyRequestWriteCheckpoint?.({
      stage: 'before_transaction',
      requestId,
      requestType,
    });

    const result = await withIdempotency(
      db,
      {
        key: idempotencyKey,
        tenantId: principal.tenantId,
        requestHash,
        discardErrorCodes: ['NOT_FOUND', 'FORBIDDEN'],
        sanitizeStoredResponse: redactPrivacyRequestResponse,
      },
      async () => {
        const row = await db.transaction().execute(async (transaction) => {
          await assertLockedPrivacyScope(principal, transaction, body);
          const transactionPrivacyRepo = new PrivacyRequestRepository(transaction);
          let existing = await transaction
            .selectFrom('privacy_requests')
            .selectAll()
            .where('id', '=', requestId)
            .forUpdate()
            .executeTakeFirst();
          existing ??= await transactionPrivacyRepo.create({
            id: requestId,
            tenantId: principal.tenantId,
            organizationId: body.organizationId,
            brandId: body.brandId ?? null,
            requestType,
            subjectType: body.subjectType,
            subjectId: body.subjectId ?? null,
            subjectEmail: body.subjectEmail ?? null,
            requestedBy: principal.id,
          });

          if (
            existing.tenant_id !== principal.tenantId ||
            existing.organization_id !== body.organizationId ||
            existing.brand_id !== (body.brandId ?? null) ||
            existing.request_type !== requestType ||
            existing.subject_type !== body.subjectType ||
            existing.subject_id !== (body.subjectId ?? null) ||
            existing.subject_email !== (body.subjectEmail ?? null) ||
            existing.requested_by !== principal.id
          ) {
            throw new ValidationError('Privacy request identity collision');
          }

          const auditAction = `privacy.${requestType}.requested`;
          const existingAudit = await transaction
            .selectFrom('audit_logs')
            .select('id')
            .where('tenant_id', '=', principal.tenantId)
            .where('action', '=', auditAction)
            .where('resource_type', '=', 'PrivacyRequest')
            .where('resource_id', '=', existing.id)
            .executeTakeFirst();
          if (!existingAudit) {
            await writeAuditLog(
              new AuditLogRepository(transaction),
              request,
              principal,
              {
                action: auditAction,
                organizationId: body.organizationId,
                brandId: body.brandId ?? null,
                resourceType: 'PrivacyRequest',
                resourceId: existing.id,
                diffSummary: {
                  requestType,
                  subjectType: body.subjectType,
                  subjectSha256,
                },
              },
              { failClosed: true },
            );
          }
          return existing;
        });

        await app.context.privacyRequestWriteCheckpoint?.({
          stage: 'after_transaction_before_workflow',
          requestId,
          requestType,
        });

        try {
          await app.context.temporalClient.startPrivacyRequest({ requestId: row.id });
        } catch {
          throw new Error('Privacy workflow dispatch failed');
        }

        return { status: 202, body: serializePrivacyRequest(row, { redactSubject: true }) };
      },
    );

    return reply.status(result.status).send(result.body);
  }

  app.post('/privacy/data-exports', async (request, reply) => {
    ClerkAuthService.requireNoEventScope(request.principal!, 'privacy requests');
    return createPrivacyRequest('export', request, reply);
  });

  app.post('/privacy/erasures', async (request, reply) => {
    ClerkAuthService.requireNoEventScope(request.principal!, 'privacy requests');
    return createPrivacyRequest('erasure', request, reply);
  });
};
