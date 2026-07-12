import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { AuditLogRepository, EventRepository } from '@tixkit/db';
import { NotFoundError } from '@tixkit/domain';
import { ClerkAuthService } from '../../auth/clerk.js';
import { writeAuditLog } from '../../auth/audit.js';
import { parseBody } from '../../http/schemas.js';
import { attachEventMedia, type EventMediaRole } from '../../services/event-media.js';

const roleSchema = z.enum(['poster', 'cover', 'social']);
const attachSchema = z
  .object({
    uploadArtifactId: z.string().min(1),
    altText: z.string().trim().min(1).max(500),
    focalPoint: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).strict(),
  })
  .strict();

async function scopedEvent(
  app: Parameters<FastifyPluginAsync>[0],
  principal: NonNullable<import('@tixkit/domain').Principal>,
  eventId: string,
) {
  const event = await new EventRepository(app.context.db).findById(eventId);
  if (!event) throw new NotFoundError('Event', eventId);
  ClerkAuthService.requireResourceTenant(principal, event, 'Event', eventId);
  ClerkAuthService.requireOrganizationScope(principal, event.organization_id);
  ClerkAuthService.requireBrandScope(principal, event.brand_id);
  ClerkAuthService.requireEventScope(principal, eventId);
  return event;
}

export const eventMediaRoutes: FastifyPluginAsync = async (app) => {
  app.get('/events/:eventId/media', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'events.read');
    const { eventId } = request.params as { eventId: string };
    await scopedEvent(app, principal, eventId);
    const assets = await app.context.db
      .selectFrom('event_media_assets')
      .selectAll()
      .where('event_id', '=', eventId)
      .where('tenant_id', '=', principal.tenantId)
      .orderBy('role', 'asc')
      .execute();
    const renditions = await app.context.db
      .selectFrom('event_media_renditions as rendition')
      .innerJoin('event_media_assets as asset', 'asset.id', 'rendition.asset_id')
      .selectAll('rendition')
      .where('asset.event_id', '=', eventId)
      .where('asset.tenant_id', '=', principal.tenantId)
      .orderBy('rendition.variant', 'asc')
      .execute();
    return assets.map((asset) => ({
      id: asset.id,
      role: asset.role,
      original: {
        uploadArtifactId: asset.upload_artifact_id,
        width: asset.width,
        height: asset.height,
        format: asset.format,
        checksumSha256: asset.checksum_sha256,
        sizeBytes: Number(asset.size_bytes),
      },
      focalPoint: { x: Number(asset.focal_x), y: Number(asset.focal_y) },
      altText: asset.alt_text,
      renditions: renditions
        .filter((rendition) => rendition.asset_id === asset.id)
        .map((rendition) => ({
          id: rendition.id,
          variant: rendition.variant,
          width: rendition.width,
          height: rendition.height,
          format: rendition.format,
          checksumSha256: rendition.checksum_sha256,
          sizeBytes: Number(rendition.size_bytes),
          url: `/v1/public/event-media/renditions/${rendition.id}`,
        })),
    }));
  });

  app.put('/events/:eventId/media/:role', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'events.write');
    const { eventId, role: rawRole } = request.params as {
      eventId: string;
      role: string;
    };
    const role = roleSchema.parse(rawRole) as EventMediaRole;
    const body = parseBody(attachSchema, request.body);
    const event = await scopedEvent(app, principal, eventId);
    const attached = await attachEventMedia({
      db: app.context.db,
      tenantId: principal.tenantId,
      organizationId: event.organization_id,
      brandId: event.brand_id,
      eventId,
      uploadArtifactId: body.uploadArtifactId,
      role,
      altText: body.altText,
      focalPoint: body.focalPoint,
      createdBy: principal.id,
    });
    await writeAuditLog(new AuditLogRepository(app.context.db), request, principal, {
      action: 'event.media.attach',
      resourceType: 'event',
      resourceId: eventId,
      organizationId: event.organization_id,
      brandId: event.brand_id,
      diffSummary: {
        role,
        assetId: attached.id,
        uploadArtifactId: body.uploadArtifactId,
        checksumSha256: attached.original.checksumSha256,
      },
    });
    return attached;
  });
};
