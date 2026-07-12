import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  EventReadinessAcknowledgementRepository,
  EventRepository,
  BrandRepository,
  AuditLogRepository,
} from '@tixkit/db';
import {
  humanAcknowledgementStepVersions,
  isHumanAcknowledgementStep,
  type EventLaunchReadinessStepId,
  type Permission,
} from '@tixkit/domain';
import { ClerkAuthService } from '../../auth/clerk.js';
import { NotFoundError, ValidationError } from '@tixkit/domain';
import { ReadinessService, resolvePaymentMode } from '../../services/readiness.js';
import { writeAuditLog } from '../../auth/audit.js';

const workspaceReadinessQuerySchema = z.object({ brandId: z.string().min(1) }).strict();
const acknowledgementParamsSchema = z
  .object({ eventId: z.string().min(1), stepId: z.string().min(1) })
  .strict();

function permissions(request: FastifyRequest): ReadonlySet<Permission> {
  return new Set(request.principal?.scopes ?? []);
}

export const readinessRoutes: FastifyPluginAsync = async (app) => {
  const db = app.context.db;
  const service =
    app.context.readinessServiceFactory?.(db) ?? new ReadinessService(db, resolvePaymentMode());

  app.get('/organizations/:organizationId/readiness', async (request) => {
    const startedAt = performance.now();
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'events.read');
    const { organizationId } = request.params as { organizationId: string };
    const query = workspaceReadinessQuerySchema.parse(request.query);
    ClerkAuthService.requireOrganizationScope(principal, organizationId);
    ClerkAuthService.requireBrandScope(principal, query.brandId);
    const brand = await new BrandRepository(db).findById(query.brandId);
    if (!brand || brand.organization_id !== organizationId) {
      throw new NotFoundError('Brand', query.brandId);
    }
    ClerkAuthService.requireResourceTenant(principal, brand, 'Brand', query.brandId);
    const readiness = await service.getWorkspaceReadiness({
      tenantId: principal.tenantId,
      organizationId,
      brandId: query.brandId,
      permissions: permissions(request),
    });
    request.log.info(
      {
        organizationId,
        brandId: query.brandId,
        readinessComplete: readiness.complete,
        incompleteStepIds: readiness.steps
          .filter((step) => step.status === 'incomplete' || step.status === 'blocked')
          .map((step) => step.id),
        durationMs: performance.now() - startedAt,
      },
      'Workspace readiness evaluated',
    );
    return readiness;
  });

  app.get('/events/:eventId/launch-readiness', async (request) => {
    const startedAt = performance.now();
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'events.read');
    const { eventId } = request.params as { eventId: string };
    const event = await new EventRepository(db).findById(eventId);
    if (!event) throw new NotFoundError('Event', eventId);
    ClerkAuthService.requireResourceTenant(principal, event, 'Event', eventId);
    ClerkAuthService.requireOrganizationScope(principal, event.organization_id);
    ClerkAuthService.requireBrandScope(principal, event.brand_id);
    ClerkAuthService.requireEventScope(principal, eventId);
    const readiness = await service.getEventLaunchReadiness({
      tenantId: principal.tenantId,
      organizationId: event.organization_id,
      brandId: event.brand_id,
      eventId,
      permissions: permissions(request),
    });
    app.observability?.metrics.metrics.onboardingEvents?.inc({
      stage: 'readiness_evaluated',
      outcome: readiness.launchable ? 'complete' : 'incomplete',
      reason_code: readiness.requiredBlockers[0]?.reasonCodes[0] ?? 'none',
    });
    if (readiness.launchable) {
      app.observability?.metrics.metrics.onboardingMilestoneDuration?.observe(
        { milestone: 'launchable' },
        Math.max(0, (Date.now() - new Date(event.created_at).getTime()) / 1000),
      );
    }
    request.log.info(
      {
        eventId,
        launchable: readiness.launchable,
        blockerCodes: readiness.requiredBlockers.flatMap((step) => step.reasonCodes),
        durationMs: performance.now() - startedAt,
      },
      'Event launch readiness evaluated',
    );
    return readiness;
  });

  app.post('/events/:eventId/readiness-acknowledgements/:stepId', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'events.write');
    const { eventId, stepId } = acknowledgementParamsSchema.parse(request.params) as {
      eventId: string;
      stepId: EventLaunchReadinessStepId;
    };
    if (!isHumanAcknowledgementStep(stepId)) {
      throw new ValidationError('Only human-review readiness steps can be acknowledged');
    }
    const event = await new EventRepository(db).findById(eventId);
    if (!event) throw new NotFoundError('Event', eventId);
    ClerkAuthService.requireResourceTenant(principal, event, 'Event', eventId);
    ClerkAuthService.requireOrganizationScope(principal, event.organization_id);
    ClerkAuthService.requireBrandScope(principal, event.brand_id);
    ClerkAuthService.requireEventScope(principal, eventId);

    const scope = {
      tenantId: principal.tenantId,
      organizationId: event.organization_id,
      brandId: event.brand_id,
      eventId,
    };
    const subjectFingerprint = await service.acknowledgementSubject({
      ...scope,
      stepId,
    });
    const acknowledgement = await new EventReadinessAcknowledgementRepository(db).acknowledge(
      scope,
      {
        stepId,
        stepVersion: humanAcknowledgementStepVersions[stepId],
        subjectFingerprint,
        actorId: principal.id,
      },
    );
    await writeAuditLog(new AuditLogRepository(db), request, principal, {
      action: 'event.readiness_acknowledged',
      organizationId: event.organization_id,
      brandId: event.brand_id,
      resourceType: 'Event',
      resourceId: eventId,
      diffSummary: {
        stepId,
        stepVersion: humanAcknowledgementStepVersions[stepId],
      },
    });
    app.observability?.metrics.metrics.onboardingEvents?.inc({
      stage: stepId,
      outcome: 'completed',
      reason_code: 'none',
    });
    return reply.status(201).send({
      tenantId: acknowledgement.tenant_id,
      organizationId: acknowledgement.organization_id,
      brandId: acknowledgement.brand_id,
      eventId: acknowledgement.event_id,
      stepId: acknowledgement.step_id,
      stepVersion: acknowledgement.step_version,
      subjectFingerprint: acknowledgement.subject_fingerprint,
      actorId: acknowledgement.actor_id,
      acknowledgedAt: new Date(acknowledgement.acknowledged_at).toISOString(),
    });
  });

  app.delete('/events/:eventId/readiness-acknowledgements/:stepId', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'events.write');
    const { eventId, stepId } = acknowledgementParamsSchema.parse(request.params) as {
      eventId: string;
      stepId: EventLaunchReadinessStepId;
    };
    if (!isHumanAcknowledgementStep(stepId)) {
      throw new ValidationError('Only human-review readiness steps can be acknowledged');
    }
    const event = await new EventRepository(db).findById(eventId);
    if (!event) throw new NotFoundError('Event', eventId);
    ClerkAuthService.requireResourceTenant(principal, event, 'Event', eventId);
    ClerkAuthService.requireOrganizationScope(principal, event.organization_id);
    ClerkAuthService.requireBrandScope(principal, event.brand_id);
    ClerkAuthService.requireEventScope(principal, eventId);
    await new EventReadinessAcknowledgementRepository(db).delete(
      {
        tenantId: principal.tenantId,
        organizationId: event.organization_id,
        brandId: event.brand_id,
        eventId,
      },
      stepId,
    );
    await writeAuditLog(new AuditLogRepository(db), request, principal, {
      action: 'event.readiness_acknowledgement_removed',
      organizationId: event.organization_id,
      brandId: event.brand_id,
      resourceType: 'Event',
      resourceId: eventId,
      diffSummary: { stepId },
    });
    app.observability?.metrics.metrics.onboardingEvents?.inc({
      stage: stepId,
      outcome: 'abandoned',
      reason_code: 'none',
    });
    return reply.status(204).send();
  });
};
