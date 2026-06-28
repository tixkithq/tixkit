import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { BrandRepository, EventRepository } from '@tixkit/db';
import { ClerkAuthService } from '../../auth/clerk.js';
import { NotFoundError, ValidationError, type Principal } from '@tixkit/domain';
import {
  completeUploadArtifact,
  createUploadArtifact,
  getUploadArtifactDownloadUrl,
  uploadTokenMatches,
  type UploadPurpose,
} from '../../services/uploads.js';
import { parseBody } from '../../http/schemas.js';

const uploadPurposeSchema = z.enum(['checkout_answer', 'brand_logo', 'user_avatar']);

const createUploadSchema = z
  .object({
    purpose: uploadPurposeSchema,
    fileName: z.string().min(1).max(255),
    contentType: z.string().min(1).max(255),
    sizeBytes: z.number().int().positive(),
    brandId: z.string().optional(),
    eventId: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const publicCreateUploadSchema = z
  .object({
    fileName: z.string().min(1).max(255),
    contentType: z.string().min(1).max(255),
    sizeBytes: z.number().int().positive(),
    questionId: z.string().optional(),
  })
  .strict();

const publicCompleteSchema = z
  .object({
    token: z.string().min(1),
  })
  .strict();

function hasCheckoutQuestionMetadata(metadata: Record<string, unknown> | undefined): boolean {
  return metadata !== undefined && Object.prototype.hasOwnProperty.call(metadata, 'questionId');
}

type ScopedUploadArtifact = {
  organization_id?: string | null;
  brand_id?: string | null;
  event_id?: string | null;
};

function requireUploadArtifactScope(principal: Principal, artifact: ScopedUploadArtifact): void {
  ClerkAuthService.requireOrganizationScope(principal, artifact.organization_id ?? undefined);
  ClerkAuthService.requireBrandScope(principal, artifact.brand_id ?? undefined);
  ClerkAuthService.requireEventScope(principal, artifact.event_id ?? undefined);
}

export const publicUploadRoutes: FastifyPluginAsync = async (app) => {
  const db = app.context.db;

  app.post('/public/events/:eventId/upload-artifacts', async (request, reply) => {
    const { eventId } = request.params as { eventId: string };
    const body = parseBody(publicCreateUploadSchema, request.body);
    const event = await new EventRepository(db).findById(eventId);
    if (!event) throw new NotFoundError('Event', eventId);
    if (event.status !== 'published') throw new ValidationError('Event is not published');

    const result = await createUploadArtifact(db, {
      tenantId: event.tenant_id,
      organizationId: event.organization_id,
      brandId: event.brand_id,
      eventId,
      purpose: 'checkout_answer',
      fileName: body.fileName,
      contentType: body.contentType,
      sizeBytes: body.sizeBytes,
      metadata: { questionId: body.questionId },
      publicComplete: true,
    });
    return reply.status(201).send(result);
  });

  app.post('/public/upload-artifacts/:artifactId/complete', async (request) => {
    const { artifactId } = request.params as { artifactId: string };
    const body = parseBody(publicCompleteSchema, request.body);
    const artifact = await db
      .selectFrom('upload_artifacts')
      .selectAll()
      .where('id', '=', artifactId)
      .executeTakeFirst();
    if (
      !artifact ||
      artifact.purpose !== 'checkout_answer' ||
      !uploadTokenMatches(artifact.client_token_hash, body.token)
    ) {
      throw new NotFoundError('UploadArtifact', artifactId);
    }
    return completeUploadArtifact(db, artifactId);
  });
};

export const uploadRoutes: FastifyPluginAsync = async (app) => {
  const db = app.context.db;
  app.post('/upload-artifacts', async (request, reply) => {
    const principal = request.principal!;
    const body = parseBody(createUploadSchema, request.body);
    let tenantId = principal.tenantId;
    let organizationId: string | null = null;
    let brandId: string | null = body.brandId ?? null;
    let eventId: string | null = body.eventId ?? null;

    if (body.purpose === 'brand_logo') {
      ClerkAuthService.requirePermission(principal, 'settings.write');
      if (eventId) throw new ValidationError('eventId is not allowed for brand logo uploads');
      if (hasCheckoutQuestionMetadata(body.metadata)) {
        throw new ValidationError('metadata.questionId is not allowed for brand logo uploads');
      }
      if (!brandId) throw new ValidationError('brandId is required for brand logo uploads');
      const brand = await new BrandRepository(db).findById(brandId);
      if (!brand) throw new NotFoundError('Brand', brandId);
      ClerkAuthService.requireResourceTenant(principal, brand, 'Brand', brandId);
      ClerkAuthService.requireOrganizationScope(principal, brand.organization_id);
      ClerkAuthService.requireBrandScope(principal, brand.id);
      tenantId = brand.tenant_id;
      organizationId = brand.organization_id;
      brandId = brand.id;
    } else if (body.purpose === 'checkout_answer') {
      ClerkAuthService.requirePermission(principal, 'events.write');
      if (!eventId) throw new ValidationError('eventId is required for checkout answer uploads');
      const event = await new EventRepository(db).findById(eventId);
      if (!event) throw new NotFoundError('Event', eventId);
      ClerkAuthService.requireResourceTenant(principal, event, 'Event', eventId);
      ClerkAuthService.requireOrganizationScope(principal, event.organization_id);
      ClerkAuthService.requireBrandScope(principal, event.brand_id);
      ClerkAuthService.requireEventScope(principal, eventId);
      tenantId = event.tenant_id;
      organizationId = event.organization_id;
      brandId = event.brand_id;
    } else if (body.purpose === 'user_avatar') {
      if (brandId) throw new ValidationError('brandId is not allowed for user avatar uploads');
      if (eventId) throw new ValidationError('eventId is not allowed for user avatar uploads');
      if (hasCheckoutQuestionMetadata(body.metadata)) {
        throw new ValidationError('metadata.questionId is not allowed for user avatar uploads');
      }
    }

    const result = await createUploadArtifact(db, {
      tenantId,
      organizationId,
      brandId,
      eventId,
      createdByUserId: principal.id,
      purpose: body.purpose as UploadPurpose,
      fileName: body.fileName,
      contentType: body.contentType,
      sizeBytes: body.sizeBytes,
      metadata: body.metadata,
    });
    return reply.status(201).send(result);
  });

  app.post('/upload-artifacts/:artifactId/complete', async (request) => {
    const principal = request.principal!;
    const { artifactId } = request.params as { artifactId: string };
    const artifact = await db
      .selectFrom('upload_artifacts')
      .selectAll()
      .where('id', '=', artifactId)
      .executeTakeFirst();
    if (!artifact) throw new NotFoundError('UploadArtifact', artifactId);
    ClerkAuthService.requireResourceTenant(principal, artifact, 'UploadArtifact', artifactId);
    requireUploadArtifactScope(principal, artifact);
    return completeUploadArtifact(db, artifactId);
  });

  app.get('/upload-artifacts/:artifactId/download', async (request) => {
    const principal = request.principal!;
    const { artifactId } = request.params as { artifactId: string };
    const artifact = await db
      .selectFrom('upload_artifacts')
      .selectAll()
      .where('id', '=', artifactId)
      .executeTakeFirst();
    if (!artifact) throw new NotFoundError('UploadArtifact', artifactId);
    ClerkAuthService.requireResourceTenant(principal, artifact, 'UploadArtifact', artifactId);
    requireUploadArtifactScope(principal, artifact);
    const downloadUrl = await getUploadArtifactDownloadUrl(db, artifactId);
    return { downloadUrl };
  });
};
