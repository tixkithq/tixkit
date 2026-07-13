import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { ClerkAuthService } from '../../auth/clerk.js';
import { writeAuditLog } from '../../auth/audit.js';
import { AuditLogRepository } from '@tixkit/db';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  type Principal,
} from '@tixkit/domain';
import { parseBody } from '../../http/schemas.js';
import {
  createPortableExportService,
  createS3PortableExportArtifactStore,
  createS3PortableExportMediaStore,
  portableExportSigningFromEnvironment,
  type PortableExportService,
} from '../../services/portable-export.js';
import {
  createPortableHistoricalAuthorizationService,
  type PortableHistoricalAuthorizationService,
} from '../../services/portable-export-authorization.js';

const createPortableExportSchema = z
  .object({
    organizationId: z.string().trim().min(3).max(32),
    mode: z.enum(['configuration', 'historical']).default('configuration'),
    authorizationId: z.string().trim().min(3).max(64).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.mode === 'historical' && !value.authorizationId)
      context.addIssue({
        code: 'custom',
        path: ['authorizationId'],
        message: 'Historical exports require an authorizationId',
      });
    if (value.mode === 'configuration' && value.authorizationId)
      context.addIssue({
        code: 'custom',
        path: ['authorizationId'],
        message: 'Configuration exports cannot use a historical authorization',
      });
  });
const createPortableDeltaExportSchema = z
  .object({
    organizationId: z.string().trim().min(3).max(32),
    parentExportJobId: z.string().trim().min(3).max(64),
    cutoverFreeze: z
      .object({
        frozenAt: z.string().datetime({ offset: false }),
        receiptSha256: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .strict()
      .optional(),
  })
  .strict();
const createHistoricalAuthorizationSchema = z
  .object({
    organizationId: z.string().trim().min(3).max(32),
    expiresAt: z.string().datetime({ offset: false }),
  })
  .strict();
const revokeHistoricalAuthorizationSchema = z
  .object({ organizationId: z.string().trim().min(3).max(32) })
  .strict();
const historicalAuthorizationParamsSchema = z
  .object({ authorizationId: z.string().trim().min(3).max(64) })
  .strict();
const portableExportIdempotencyKeySchema = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => value === value.trim());

class PortableExportUnavailableError extends Error {
  readonly code = 'SERVICE_UNAVAILABLE';
  readonly statusCode = 503;
  readonly expose = true;

  constructor() {
    super('Portable export signing or immutable storage is unavailable');
  }
}

export interface PortabilityRouteOptions {
  exportService?: PortableExportService;
  authorizationService?: PortableHistoricalAuthorizationService;
}

function requireHistoricalAuthorizationPrincipal(
  principal: Principal,
  organizationId: string,
): void {
  ClerkAuthService.requirePermission(principal, 'migrations.write');
  ClerkAuthService.requireOrganizationScope(principal, organizationId);
  ClerkAuthService.requireNoEventScope(principal, 'historical portability authorization');
  if (principal.type !== 'user' || principal.brandIds?.length)
    throw new ForbiddenError(
      'Historical portability authorization requires an unscoped organization user',
    );
}

function rethrowHistoricalAuthorizationError(error: unknown): never {
  if (!(error instanceof Error)) throw new PortableExportUnavailableError();
  if (error.message === 'PORTABLE_EXPORT_AUTHORIZATION_ADMIN_REQUIRED')
    throw new ForbiddenError('An accepted organization owner or admin is required');
  if (error.message === 'PORTABLE_EXPORT_AUTHORIZATION_NOT_FOUND')
    throw new NotFoundError('Historical export authorization', 'requested');
  if (
    error.message === 'PORTABLE_EXPORT_AUTHORIZATION_REVOKED' ||
    error.message === 'PORTABLE_EXPORT_AUTHORIZATION_EXPIRED' ||
    error.message === 'PORTABLE_EXPORT_AUTHORIZATION_ALREADY_CONSUMED' ||
    error.message === 'PORTABLE_EXPORT_AUTHORIZATION_PRINCIPAL_MISMATCH' ||
    error.message === 'PORTABLE_EXPORT_AUTHORIZATION_STATE_CONFLICT'
  )
    throw new ConflictError('A fresh unrevoked historical export authorization is required');
  if (
    error.message === 'PORTABLE_EXPORT_AUTHORIZATION_INVALID' ||
    error.message === 'PORTABLE_EXPORT_AUTHORIZATION_REVOCATION_INVALID'
  )
    throw new ValidationError('Historical export authorization is invalid');
  throw new PortableExportUnavailableError();
}

export const portabilityRoutes: FastifyPluginAsync<PortabilityRouteOptions> = async (
  app,
  options,
) => {
  app.post('/portable-export-authorizations', async (request, reply) => {
    const principal = request.principal!;
    const body = parseBody(createHistoricalAuthorizationSchema, request.body);
    requireHistoricalAuthorizationPrincipal(principal, body.organizationId);
    let authorization;
    try {
      const service =
        options.authorizationService ??
        createPortableHistoricalAuthorizationService(app.context.db);
      authorization = await service.grant({
        tenantId: principal.tenantId,
        organizationId: body.organizationId,
        principalId: principal.id,
        expiresAt: new Date(body.expiresAt),
      });
    } catch (error) {
      rethrowHistoricalAuthorizationError(error);
    }
    await writeAuditLog(new AuditLogRepository(app.context.db), request, principal, {
      action: 'portability.export.historical_authorization.grant',
      organizationId: body.organizationId,
      resourceType: 'portable_export_authorization',
      resourceId: authorization.authorizationId,
      diffSummary: { expiresAt: authorization.expiresAt, scope: authorization.scope },
    });
    return reply.code(201).send(authorization);
  });

  app.post('/portable-export-authorizations/:authorizationId/revoke', async (request, reply) => {
    const principal = request.principal!;
    const body = parseBody(revokeHistoricalAuthorizationSchema, request.body);
    const params = parseBody(historicalAuthorizationParamsSchema, request.params);
    requireHistoricalAuthorizationPrincipal(principal, body.organizationId);
    try {
      const service =
        options.authorizationService ??
        createPortableHistoricalAuthorizationService(app.context.db);
      await service.revoke({
        tenantId: principal.tenantId,
        organizationId: body.organizationId,
        principalId: principal.id,
        authorizationId: params.authorizationId,
      });
    } catch (error) {
      rethrowHistoricalAuthorizationError(error);
    }
    await writeAuditLog(new AuditLogRepository(app.context.db), request, principal, {
      action: 'portability.export.historical_authorization.revoke',
      organizationId: body.organizationId,
      resourceType: 'portable_export_authorization',
      resourceId: params.authorizationId,
      diffSummary: { revoked: true },
    });
    return reply.code(204).send();
  });

  app.post('/portable-exports', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'migrations.write');
    const body = parseBody(createPortableExportSchema, request.body);
    ClerkAuthService.requireOrganizationScope(principal, body.organizationId);
    ClerkAuthService.requireNoEventScope(principal, 'organization portability exports');
    if (principal.type !== 'system' && principal.brandIds?.length) {
      throw new ForbiddenError(
        'Brand-scoped principals cannot access organization portability exports',
      );
    }
    if (body.mode === 'historical' && principal.type !== 'user')
      throw new ForbiddenError('Historical portability exports require a user principal');
    const idempotencyKey = request.headers['idempotency-key'];
    const parsedIdempotencyKey = portableExportIdempotencyKeySchema.safeParse(idempotencyKey);
    if (!parsedIdempotencyKey.success)
      throw new ValidationError(
        'Idempotency-Key must be present, contain 1-255 characters, and have no surrounding whitespace',
      );

    let result: Awaited<
      ReturnType<ReturnType<typeof createPortableExportService>['exportConfiguration']>
    >;
    try {
      const service =
        options.exportService ??
        createPortableExportService({
          db: app.context.db,
          store: createS3PortableExportArtifactStore(),
          mediaStore: createS3PortableExportMediaStore(),
          signing: portableExportSigningFromEnvironment(),
        });
      result =
        body.mode === 'historical'
          ? await service.exportHistorical({
              tenantId: principal.tenantId,
              organizationId: body.organizationId,
              requestedBy: principal.id,
              idempotencyKey: parsedIdempotencyKey.data,
              authorizationId: body.authorizationId!,
            })
          : await service.exportConfiguration({
              tenantId: principal.tenantId,
              organizationId: body.organizationId,
              requestedBy: principal.id,
              idempotencyKey: parsedIdempotencyKey.data,
            });
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === 'PORTABLE_EXPORT_IDEMPOTENCY_CONFLICT' ||
          error.message === 'PORTABLE_EXPORT_IN_PROGRESS' ||
          error.message === 'PORTABLE_EXPORT_LINEAGE_PARENT_INVALID')
      )
        throw new ConflictError('Portable export request conflicts with an existing request');
      if (error instanceof Error && error.message === 'PORTABLE_EXPORT_LINEAGE_INVALID')
        throw new ValidationError('Portable export lineage is invalid');
      if (error instanceof Error && error.message.startsWith('PORTABLE_EXPORT_AUTHORIZATION_'))
        rethrowHistoricalAuthorizationError(error);
      throw new PortableExportUnavailableError();
    }
    await writeAuditLog(new AuditLogRepository(app.context.db), request, principal, {
      action:
        body.mode === 'historical'
          ? 'portability.export.historical'
          : 'portability.export.configuration',
      organizationId: body.organizationId,
      resourceType: 'portable_export',
      resourceId: result.jobId,
      diffSummary: { bundleId: result.bundleId, mode: body.mode },
    });

    return reply
      .header('content-type', 'application/vnd.tixkit.portable+json')
      .header('content-disposition', `attachment; filename="${result.bundleId}.tixkit.json"`)
      .header('x-tixkit-portable-job-id', result.jobId)
      .header('cache-control', 'private, no-store')
      .send(Buffer.from(result.bytes));
  });

  app.post('/portable-delta-exports', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'migrations.write');
    const body = parseBody(createPortableDeltaExportSchema, request.body);
    ClerkAuthService.requireOrganizationScope(principal, body.organizationId);
    ClerkAuthService.requireNoEventScope(principal, 'organization portability exports');
    if (principal.type !== 'system' && principal.brandIds?.length)
      throw new ForbiddenError(
        'Brand-scoped principals cannot access organization portability exports',
      );
    const parsedIdempotencyKey = portableExportIdempotencyKeySchema.safeParse(
      request.headers['idempotency-key'],
    );
    if (!parsedIdempotencyKey.success)
      throw new ValidationError(
        'Idempotency-Key must be present, contain 1-255 characters, and have no surrounding whitespace',
      );
    let result: Awaited<ReturnType<PortableExportService['exportConfiguration']>>;
    try {
      const service =
        options.exportService ??
        createPortableExportService({
          db: app.context.db,
          store: createS3PortableExportArtifactStore(),
          mediaStore: createS3PortableExportMediaStore(),
          signing: portableExportSigningFromEnvironment(),
        });
      result = await service.exportConfiguration({
        tenantId: principal.tenantId,
        organizationId: body.organizationId,
        requestedBy: principal.id,
        idempotencyKey: parsedIdempotencyKey.data,
        parentExportJobId: body.parentExportJobId,
        ...(body.cutoverFreeze ? { cutoverFreeze: body.cutoverFreeze } : {}),
      });
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === 'PORTABLE_EXPORT_IDEMPOTENCY_CONFLICT' ||
          error.message === 'PORTABLE_EXPORT_IN_PROGRESS' ||
          error.message === 'PORTABLE_EXPORT_LINEAGE_PARENT_INVALID')
      )
        throw new ConflictError('Portable delta export conflicts with its durable parent');
      if (error instanceof Error && error.message === 'PORTABLE_EXPORT_LINEAGE_INVALID')
        throw new ValidationError('Portable export lineage is invalid');
      throw new PortableExportUnavailableError();
    }
    await writeAuditLog(new AuditLogRepository(app.context.db), request, principal, {
      action: 'portability.export.configuration_delta',
      organizationId: body.organizationId,
      resourceType: 'portable_export',
      resourceId: result.jobId,
      diffSummary: {
        bundleId: result.bundleId,
        parentExportJobId: body.parentExportJobId,
        finalCutover: Boolean(body.cutoverFreeze),
      },
    });
    return reply
      .header('content-type', 'application/vnd.tixkit.portable+json')
      .header('content-disposition', `attachment; filename="${result.bundleId}.tixkit.json"`)
      .header('x-tixkit-portable-job-id', result.jobId)
      .header('cache-control', 'private, no-store')
      .send(Buffer.from(result.bytes));
  });
};
