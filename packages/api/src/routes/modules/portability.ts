import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { ClerkAuthService } from '../../auth/clerk.js';
import { writeAuditLog } from '../../auth/audit.js';
import { AuditLogRepository } from '@tixkit/db';
import { ConflictError, ForbiddenError, ValidationError } from '@tixkit/domain';
import { parseBody } from '../../http/schemas.js';
import {
  createPortableExportService,
  createS3PortableExportArtifactStore,
  portableExportSigningFromEnvironment,
  type PortableExportService,
} from '../../services/portable-export.js';

const createPortableExportSchema = z
  .object({
    organizationId: z.string().trim().min(3).max(32),
    mode: z.literal('configuration').default('configuration'),
  })
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
}

export const portabilityRoutes: FastifyPluginAsync<PortabilityRouteOptions> = async (
  app,
  options,
) => {
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
          signing: portableExportSigningFromEnvironment(),
        });
      result = await service.exportConfiguration({
        tenantId: principal.tenantId,
        organizationId: body.organizationId,
        requestedBy: principal.id,
        idempotencyKey: parsedIdempotencyKey.data,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === 'PORTABLE_EXPORT_IDEMPOTENCY_CONFLICT' ||
          error.message === 'PORTABLE_EXPORT_IN_PROGRESS')
      )
        throw new ConflictError('Portable export request conflicts with an existing request');
      throw new PortableExportUnavailableError();
    }
    await writeAuditLog(new AuditLogRepository(app.context.db), request, principal, {
      action: 'portability.export.configuration',
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
};
