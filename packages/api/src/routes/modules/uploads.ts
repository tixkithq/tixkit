import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { BrandRepository, EventRepository, type Database } from '@tixkit/db';
import { ClerkAuthService } from '../../auth/clerk.js';
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
  type Permission,
  type Principal,
} from '@tixkit/domain';
import {
  completeUploadArtifact,
  createUploadArtifact,
  getUploadArtifactDownloadUrl,
  streamBrandLogo,
  streamContentEmailImage,
  streamContentEventPageImage,
  streamEventMedia,
  uploadTokenMatches,
  type UploadPurpose,
} from '../../services/uploads.js';
import { parseBody } from '../../http/schemas.js';

const uploadPurposeSchema = z.enum([
  'checkout_answer',
  'brand_logo',
  'user_avatar',
  'content_email_image',
  'content_event_page_image',
  'event_cover',
  'event_seo_image',
]);

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
    questionId: z.string().min(1),
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

function checkoutQuestionIdFromMetadata(metadata: Record<string, unknown> | undefined): string {
  const questionId = metadata?.questionId;
  if (typeof questionId !== 'string' || questionId.length === 0) {
    throw new ValidationError('metadata.questionId is required for checkout answer uploads');
  }
  return questionId;
}

function contentDocumentIdFromMetadata(
  metadata: Record<string, unknown> | undefined,
): string | undefined {
  const contentDocumentId = metadata?.contentDocumentId;
  if (contentDocumentId === undefined) return undefined;
  if (typeof contentDocumentId !== 'string' || contentDocumentId.length === 0) {
    throw new ValidationError('metadata.contentDocumentId must be a non-empty string');
  }
  return contentDocumentId;
}

async function requireCheckoutFileQuestion(
  db: Database,
  eventId: string,
  questionId: string,
): Promise<void> {
  const question = await db
    .selectFrom('questions')
    .select(['id', 'type', 'status', 'is_hidden', 'hidden_at', 'deleted_at'])
    .where('event_id', '=', eventId)
    .where('id', '=', questionId)
    .executeTakeFirst();

  if (
    !question ||
    question.type !== 'file' ||
    question.status === 'hidden' ||
    question.is_hidden ||
    question.hidden_at ||
    question.deleted_at
  ) {
    throw new ValidationError('questionId must reference an active file question for this event');
  }
}

async function requireContentDocumentForUpload(
  db: Database,
  documentId: string,
  expected: {
    tenantId: string;
    organizationId: string;
    brandId: string;
    eventId: string;
    channel: 'email' | 'event_page';
  },
): Promise<void> {
  const document = await db
    .selectFrom('content_documents')
    .select(['id', 'tenant_id', 'organization_id', 'brand_id', 'event_id', 'channel'])
    .where('id', '=', documentId)
    .executeTakeFirst();

  if (!document) throw new NotFoundError('ContentDocument', documentId);
  if (document.channel !== expected.channel) {
    throw new ValidationError(
      expected.channel === 'email'
        ? 'metadata.contentDocumentId must reference an email content document'
        : 'metadata.contentDocumentId must reference an event page content document',
    );
  }
  if (
    document.tenant_id !== expected.tenantId ||
    document.organization_id !== expected.organizationId ||
    document.brand_id !== expected.brandId ||
    document.event_id !== expected.eventId
  ) {
    throw new NotFoundError('ContentDocument', documentId);
  }
}

type ScopedUploadArtifact = {
  organization_id?: string | null;
  brand_id?: string | null;
  event_id?: string | null;
  created_by_user_id?: string | null;
  purpose?: string | null;
};

function requireUploadArtifactScope(principal: Principal, artifact: ScopedUploadArtifact): void {
  ClerkAuthService.requireOrganizationScope(principal, artifact.organization_id ?? undefined);
  ClerkAuthService.requireBrandScope(principal, artifact.brand_id ?? undefined);
  ClerkAuthService.requireEventScope(principal, artifact.event_id ?? undefined);
}

function requireAnyPermission(principal: Principal, permissions: Permission[]): void {
  if (!permissions.some((permission) => ClerkAuthService.hasPermission(principal, permission))) {
    throw new ForbiddenError(`Missing required permission: ${permissions.join(' or ')}`);
  }
}

function requireUploadArtifactAccess(
  principal: Principal,
  artifact: ScopedUploadArtifact,
  operation: 'complete' | 'download',
): void {
  requireUploadArtifactScope(principal, artifact);

  if (artifact.purpose === 'checkout_answer') {
    if (operation === 'complete') {
      ClerkAuthService.requirePermission(principal, 'events.write');
      return;
    }
    requireAnyPermission(principal, ['events.read', 'events.write']);
    return;
  }

  if (artifact.purpose === 'brand_logo') {
    ClerkAuthService.requirePermission(principal, 'settings.write');
    return;
  }

  if (artifact.purpose === 'user_avatar') {
    if (!artifact.created_by_user_id || artifact.created_by_user_id !== principal.id) {
      throw new NotFoundError('UploadArtifact', 'scoped');
    }
    return;
  }

  if (artifact.purpose === 'content_email_image') {
    ClerkAuthService.requirePermission(principal, 'messages.write');
    return;
  }

  if (artifact.purpose === 'content_event_page_image') {
    ClerkAuthService.requirePermission(principal, 'events.write');
    return;
  }
  if (artifact.purpose === 'event_cover' || artifact.purpose === 'event_seo_image') {
    ClerkAuthService.requirePermission(principal, 'events.write');
    return;
  }

  throw new ForbiddenError('Upload artifact purpose is not supported');
}

export const publicUploadRoutes: FastifyPluginAsync = async (app) => {
  const db = app.context.db;

  app.post('/public/events/:eventId/upload-artifacts', async (request, reply) => {
    const { eventId } = request.params as { eventId: string };
    const body = parseBody(publicCreateUploadSchema, request.body);
    const event = await new EventRepository(db).findById(eventId);
    if (!event) throw new NotFoundError('Event', eventId);
    if (event.status !== 'published') throw new ValidationError('Event is not published');
    await requireCheckoutFileQuestion(db, eventId, body.questionId);

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

  app.get('/public/content-email-images/:artifactId', async (request, reply) => {
    const { artifactId } = request.params as { artifactId: string };
    const { stream, contentType, fileName } = await streamContentEmailImage(db, artifactId);
    reply.header('Content-Type', contentType);
    reply.header('Content-Disposition', `inline; filename="${fileName.replaceAll('"', '')}"`);
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    reply.header('Cross-Origin-Resource-Policy', 'cross-origin');
    return reply.send(stream);
  });

  app.get('/public/content-event-page-images/:artifactId', async (request, reply) => {
    const { artifactId } = request.params as { artifactId: string };
    const { stream, contentType, fileName } = await streamContentEventPageImage(db, artifactId);
    reply.header('Content-Type', contentType);
    reply.header('Content-Disposition', `inline; filename="${fileName.replaceAll('"', '')}"`);
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    reply.header('Cross-Origin-Resource-Policy', 'cross-origin');
    return reply.send(stream);
  });

  app.get('/public/brand-logos/:artifactId', async (request, reply) => {
    const { artifactId } = request.params as { artifactId: string };
    const { stream, contentType, fileName } = await streamBrandLogo(db, artifactId);
    reply.header('Content-Type', contentType);
    reply.header('Content-Disposition', `inline; filename="${fileName.replaceAll('"', '')}"`);
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    reply.header('Cross-Origin-Resource-Policy', 'cross-origin');
    return reply.send(stream);
  });

  app.get('/public/event-media/:purpose/:artifactId', async (request, reply) => {
    const { purpose, artifactId } = request.params as { purpose: string; artifactId: string };
    if (purpose !== 'event_cover' && purpose !== 'event_seo_image')
      throw new NotFoundError('UploadArtifact', artifactId);
    const { stream, contentType, fileName } = await streamEventMedia(db, artifactId, purpose);
    reply.header('Content-Type', contentType);
    reply.header('Content-Disposition', `inline; filename="${fileName.replaceAll('"', '')}"`);
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    reply.header('Cross-Origin-Resource-Policy', 'cross-origin');
    return reply.send(stream);
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
      const questionId = checkoutQuestionIdFromMetadata(body.metadata);
      const event = await new EventRepository(db).findById(eventId);
      if (!event) throw new NotFoundError('Event', eventId);
      ClerkAuthService.requireResourceTenant(principal, event, 'Event', eventId);
      ClerkAuthService.requireOrganizationScope(principal, event.organization_id);
      ClerkAuthService.requireBrandScope(principal, event.brand_id);
      ClerkAuthService.requireEventScope(principal, eventId);
      await requireCheckoutFileQuestion(db, eventId, questionId);
      tenantId = event.tenant_id;
      organizationId = event.organization_id;
      brandId = event.brand_id;
    } else if (body.purpose === 'user_avatar') {
      if (brandId) throw new ValidationError('brandId is not allowed for user avatar uploads');
      if (eventId) throw new ValidationError('eventId is not allowed for user avatar uploads');
      if (hasCheckoutQuestionMetadata(body.metadata)) {
        throw new ValidationError('metadata.questionId is not allowed for user avatar uploads');
      }
    } else if (body.purpose === 'event_cover' || body.purpose === 'event_seo_image') {
      ClerkAuthService.requirePermission(principal, 'events.write');
      if (!eventId) throw new ValidationError('eventId is required for event media uploads');
      const event = await new EventRepository(db).findById(eventId);
      if (!event) throw new NotFoundError('Event', eventId);
      ClerkAuthService.requireResourceTenant(principal, event, 'Event', eventId);
      ClerkAuthService.requireOrganizationScope(principal, event.organization_id);
      ClerkAuthService.requireBrandScope(principal, event.brand_id);
      ClerkAuthService.requireEventScope(principal, eventId);
      if (brandId && brandId !== event.brand_id)
        throw new ValidationError('brandId must match the event brand');
      tenantId = event.tenant_id;
      organizationId = event.organization_id;
      brandId = event.brand_id;
    } else if (
      body.purpose === 'content_email_image' ||
      body.purpose === 'content_event_page_image'
    ) {
      const isEventPageImage = body.purpose === 'content_event_page_image';
      ClerkAuthService.requirePermission(
        principal,
        isEventPageImage ? 'events.write' : 'messages.write',
      );
      if (!eventId) {
        throw new ValidationError(
          isEventPageImage
            ? 'eventId is required for content event page images'
            : 'eventId is required for content email images',
        );
      }
      if (hasCheckoutQuestionMetadata(body.metadata)) {
        throw new ValidationError(
          isEventPageImage
            ? 'metadata.questionId is not allowed for content event page images'
            : 'metadata.questionId is not allowed for content email images',
        );
      }
      const contentDocumentId = contentDocumentIdFromMetadata(body.metadata);
      const event = await new EventRepository(db).findById(eventId);
      if (!event) throw new NotFoundError('Event', eventId);
      ClerkAuthService.requireResourceTenant(principal, event, 'Event', eventId);
      ClerkAuthService.requireOrganizationScope(principal, event.organization_id);
      ClerkAuthService.requireBrandScope(principal, event.brand_id);
      ClerkAuthService.requireEventScope(principal, eventId);
      if (brandId && brandId !== event.brand_id) {
        throw new ValidationError(
          isEventPageImage
            ? 'brandId must match the event brand for content event page images'
            : 'brandId must match the event brand for content email images',
        );
      }
      tenantId = event.tenant_id;
      organizationId = event.organization_id;
      brandId = event.brand_id;
      if (contentDocumentId) {
        await requireContentDocumentForUpload(db, contentDocumentId, {
          tenantId,
          organizationId,
          brandId,
          eventId,
          channel: isEventPageImage ? 'event_page' : 'email',
        });
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
    requireUploadArtifactAccess(principal, artifact, 'complete');
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
    requireUploadArtifactAccess(principal, artifact, 'download');

    if (artifact.purpose === 'brand_logo') {
      return {
        downloadUrl: `/v1/public/brand-logos/${artifactId}`,
        durable: true,
      };
    }

    if (artifact.purpose === 'content_email_image') {
      return {
        downloadUrl: `/v1/public/content-email-images/${artifactId}`,
        durable: true,
      };
    }

    if (artifact.purpose === 'content_event_page_image') {
      return {
        downloadUrl: `/v1/public/content-event-page-images/${artifactId}`,
        durable: true,
      };
    }
    if (artifact.purpose === 'event_cover' || artifact.purpose === 'event_seo_image') {
      return {
        downloadUrl: `/v1/public/event-media/${artifact.purpose}/${artifactId}`,
        durable: true,
      };
    }

    const downloadUrl = await getUploadArtifactDownloadUrl(db, artifactId);
    return { downloadUrl };
  });
};
