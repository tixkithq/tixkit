import type { FastifyPluginAsync } from 'fastify';
import {
  type Database,
  EmailDeliveryRepository,
  EmailJobRepository,
  EmailProviderEventRepository,
  EmailProviderRouteRepository,
  EmailSuppressionRepository,
  EventRepository,
  MessageConsentRepository,
  NotificationTemplateRepository,
  NotificationTemplateVersionRepository,
  SmsDeliveryRepository,
  SmsJobRepository,
  SmsProviderEventRepository,
  SmsProviderRouteRepository,
} from '@tixkit/db';
import { ClerkAuthService } from '../../auth/clerk.js';
import { type Principal, ValidationError } from '@tixkit/domain';
import {
  renderMergeTags,
  validateMergeTags,
  countSmsSegments,
  injectOptOutToken,
  type MergeTagContext,
  type MergeTagChannel,
} from '@tixkit/domain/messaging';
import { sendMessageSchema } from '../../http/schemas.js';
import { hashRequest, withIdempotency } from '../../services/idempotency.js';

type MessageAudience = 'all' | 'checked_in' | 'not_checked_in' | 'specific';
type MessageChannel = 'email' | 'sms' | 'both';

type MessageAttendee = {
  id: string;
  event_id?: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  status: string;
};

type ChannelDecision =
  | {
      status: 'eligible';
      attendee: MessageAttendee;
      consentExcluded: false;
      suppressionExcluded: false;
    }
  | {
      status: 'suppressed';
      attendee: MessageAttendee;
      consentExcluded: boolean;
      suppressionExcluded: boolean;
    }
  | {
      status: 'missing_contact';
      attendee: MessageAttendee;
      consentExcluded: false;
      suppressionExcluded: false;
    };

type QueuedEmailJob = {
  jobId: string;
  toEmail: string;
  toName?: string;
  templateVersionId: string;
  providerRouteId: string;
  variables: Record<string, unknown>;
};

export const messagingRoutes: FastifyPluginAsync = async (app) => {
  const db = app.context.db;

  app.get('/events/:eventId/messages', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'messages.write');
    const { eventId } = request.params as { eventId: string };
    const event = await loadAuthorizedEvent(eventId, principal, db);
    const [emailJobs, smsJobs] = await Promise.all([
      new EmailJobRepository(db).findByBrand(principal.tenantId, event.brand_id),
      new SmsJobRepository(db).findByBrand(principal.tenantId, event.brand_id),
    ]);

    return {
      items: buildCampaignSummaries({
        eventId,
        emailJobs: emailJobs.filter((job) => jobVariables(job).eventId === eventId),
        smsJobs: smsJobs.filter((job) => jobVariables(job).eventId === eventId),
      }),
    };
  });

  app.get('/events/:eventId/messages/:campaignId', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'messages.write');
    const { eventId, campaignId } = request.params as { eventId: string; campaignId: string };
    const { emailJobs: campaignEmailJobs, smsJobs: campaignSmsJobs } = await loadAuthorizedCampaign(
      eventId,
      campaignId,
      principal,
      db,
    );
    const [emailDeliveries, smsDeliveries] = await Promise.all([
      new EmailDeliveryRepository(db).findByJobIds(
        principal.tenantId,
        campaignEmailJobs.map((job) => job.id),
      ),
      new SmsDeliveryRepository(db).findByJobIds(
        principal.tenantId,
        campaignSmsJobs.map((job) => job.id),
      ),
    ]);
    const campaignEmailDeliveries = filterDeliveriesByJobs(emailDeliveries, campaignEmailJobs);
    const campaignSmsDeliveries = filterDeliveriesByJobs(smsDeliveries, campaignSmsJobs);
    const [summary] = buildCampaignSummaries({
      eventId,
      emailJobs: campaignEmailJobs,
      smsJobs: campaignSmsJobs,
    });

    return {
      ...summary,
      emailJobs: campaignEmailJobs,
      smsJobs: campaignSmsJobs,
      emailDeliveries: campaignEmailDeliveries,
      smsDeliveries: campaignSmsDeliveries,
    };
  });

  app.get('/events/:eventId/messages/:campaignId/jobs', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'messages.write');
    const { eventId, campaignId } = request.params as { eventId: string; campaignId: string };
    const { emailJobs, smsJobs } = await loadAuthorizedCampaign(eventId, campaignId, principal, db);

    return {
      items: buildJobItems(eventId, campaignId, emailJobs, smsJobs),
    };
  });

  app.get('/events/:eventId/messages/:campaignId/jobs/:channel/:jobId', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'messages.write');
    const { eventId, campaignId, channel, jobId } = request.params as {
      eventId: string;
      campaignId: string;
      channel: string;
      jobId: string;
    };
    const { emailJobs, smsJobs } = await loadAuthorizedCampaign(eventId, campaignId, principal, db);
    const items = buildJobItems(eventId, campaignId, emailJobs, smsJobs);
    const item = items.find(
      (candidate) => candidate.channel === channel && candidate.job.id === jobId,
    );
    if (!item) {
      throw new ValidationError('Message job not found');
    }
    return item;
  });

  app.get('/events/:eventId/messages/:campaignId/delivery-logs', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'messages.write');
    const { eventId, campaignId } = request.params as { eventId: string; campaignId: string };
    const { emailJobs, smsJobs } = await loadAuthorizedCampaign(eventId, campaignId, principal, db);
    const [emailDeliveries, smsDeliveries] = await Promise.all([
      new EmailDeliveryRepository(db).findByJobIds(
        principal.tenantId,
        emailJobs.map((job) => job.id),
      ),
      new SmsDeliveryRepository(db).findByJobIds(
        principal.tenantId,
        smsJobs.map((job) => job.id),
      ),
    ]);

    return {
      items: buildDeliveryLogItems(
        eventId,
        campaignId,
        filterDeliveriesByJobs(emailDeliveries, emailJobs),
        filterDeliveriesByJobs(smsDeliveries, smsJobs),
      ),
    };
  });

  app.get(
    '/events/:eventId/messages/:campaignId/delivery-logs/:channel/:deliveryId',
    async (request) => {
      const principal = request.principal!;
      ClerkAuthService.requirePermission(principal, 'messages.write');
      const { eventId, campaignId, channel, deliveryId } = request.params as {
        eventId: string;
        campaignId: string;
        channel: string;
        deliveryId: string;
      };
      const { emailJobs, smsJobs } = await loadAuthorizedCampaign(
        eventId,
        campaignId,
        principal,
        db,
      );
      const [emailDeliveries, smsDeliveries] = await Promise.all([
        new EmailDeliveryRepository(db).findByJobIds(
          principal.tenantId,
          emailJobs.map((job) => job.id),
        ),
        new SmsDeliveryRepository(db).findByJobIds(
          principal.tenantId,
          smsJobs.map((job) => job.id),
        ),
      ]);
      const items = buildDeliveryLogItems(
        eventId,
        campaignId,
        filterDeliveriesByJobs(emailDeliveries, emailJobs),
        filterDeliveriesByJobs(smsDeliveries, smsJobs),
      );
      const item = items.find(
        (candidate) => candidate.channel === channel && candidate.delivery.id === deliveryId,
      );
      if (!item) {
        throw new ValidationError('Message delivery log not found');
      }
      return item;
    },
  );

  app.get('/events/:eventId/messages/:campaignId/provider-events', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'messages.write');
    const { eventId, campaignId } = request.params as { eventId: string; campaignId: string };
    const items = await loadCampaignProviderEventItems(eventId, campaignId, principal, db);
    return { items };
  });

  app.get(
    '/events/:eventId/messages/:campaignId/provider-events/:providerEventId',
    async (request) => {
      const principal = request.principal!;
      ClerkAuthService.requirePermission(principal, 'messages.write');
      const { eventId, campaignId, providerEventId } = request.params as {
        eventId: string;
        campaignId: string;
        providerEventId: string;
      };
      const items = await loadCampaignProviderEventItems(eventId, campaignId, principal, db);
      const item = items.find(
        (candidate) =>
          candidate.event.id === providerEventId ||
          candidate.event.provider_event_id === providerEventId,
      );
      if (!item) {
        throw new ValidationError('Message provider event not found');
      }
      return item;
    },
  );

  app.post('/events/:eventId/messages/preview', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'messages.write');
    const { eventId } = request.params as { eventId: string };
    const parsed = sendMessageSchema
      .pick({
        audience: true,
        attendeeIds: true,
        channel: true,
        templateKey: true,
      })
      .safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError('Invalid message preview request', {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }
    if (
      parsed.data.audience === 'specific' &&
      (!parsed.data.attendeeIds || parsed.data.attendeeIds.length === 0)
    ) {
      throw new ValidationError('attendeeIds is required when audience is specific', {
        field: 'attendeeIds',
      });
    }

    await loadAuthorizedEvent(eventId, principal, db);
    const resolved = await resolveMessageAudience({
      db,
      tenantId: principal.tenantId,
      eventId,
      audience: parsed.data.audience,
      attendeeIds: parsed.data.attendeeIds,
      channel: parsed.data.channel,
    });

    return {
      audience: audienceToResponse(parsed.data.audience),
      audienceCount: resolved.attendees.length,
      eligibleCount: resolved.eligibleRecipients.length,
      suppressedRecipients: resolved.suppressedRecipients,
      consentExclusions: resolved.consentExclusions,
      skippedRecipients: resolved.skippedRecipients,
      recipients: resolved.eligibleRecipients.slice(0, 25).map((attendee) => ({
        id: attendee.id,
        name: attendeeName(attendee) ?? attendee.email ?? attendee.phone ?? attendee.id,
        email: attendee.email ?? undefined,
        phone: attendee.phone ?? undefined,
        status: attendee.status,
      })),
    };
  });

  // C-076/C-077: render a template body with a sample merge-tag context for admin live preview.
  app.post('/events/:eventId/messages/render-preview', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'messages.write');
    const { eventId } = request.params as { eventId: string };
    const body = request.body as {
      channel?: MergeTagChannel;
      subjectTemplate?: string;
      htmlTemplate?: string;
      textTemplate?: string;
      context?: MergeTagContext;
      optOutToken?: string;
    };
    const channel: MergeTagChannel = body.channel === 'sms' ? 'sms' : 'email';
    const context: MergeTagContext = body.context ?? {};
    const subjectTemplate = body.subjectTemplate ?? '';
    const htmlTemplate = body.htmlTemplate ?? '';
    const textTemplate = body.textTemplate ?? '';

    const subjectValidation = validateMergeTags(subjectTemplate);
    const htmlValidation = validateMergeTags(htmlTemplate);
    const textValidation = validateMergeTags(textTemplate);
    const unknownTags = [
      ...subjectValidation.unknownTags,
      ...htmlValidation.unknownTags,
      ...textValidation.unknownTags,
    ];

    await loadAuthorizedEvent(eventId, principal, db);

    const subject = renderMergeTags(subjectTemplate, context, {
      channel: 'email',
      escape: 'plain',
    });
    const html = renderMergeTags(htmlTemplate, context, { channel: 'email', escape: 'html' });
    const text = textTemplate
      ? renderMergeTags(textTemplate, context, {
          channel: 'sms',
          escape: 'plain',
          optOutToken: body.optOutToken,
        })
      : undefined;

    const smsBody = channel === 'sms' ? (text ?? subject) : text;
    const segments =
      channel === 'sms' && smsBody
        ? countSmsSegments(
            body.optOutToken ? injectOptOutToken(smsBody, body.optOutToken) : smsBody,
          )
        : undefined;

    return {
      channel,
      subject,
      html,
      text,
      segments,
      validation: {
        valid: unknownTags.length === 0,
        unknownTags: [...new Set(unknownTags)],
      },
    };
  });

  app.post('/events/:eventId/messages', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'messages.write');
    const { eventId } = request.params as { eventId: string };
    const idempotencyKey = request.headers['idempotency-key'];
    if (typeof idempotencyKey !== 'string' || idempotencyKey.trim().length === 0) {
      throw new ValidationError('Idempotency-Key header is required for message campaigns');
    }

    const parsed = sendMessageSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError('Invalid message request', {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }

    const body = parsed.data;

    if (body.audience === 'specific' && (!body.attendeeIds || body.attendeeIds.length === 0)) {
      throw new ValidationError('attendeeIds is required when audience is specific', {
        field: 'attendeeIds',
      });
    }

    const campaignId = idempotencyKey.trim();
    await loadAuthorizedEvent(eventId, principal, db);
    const result = await withIdempotency(
      db,
      {
        key: campaignId,
        tenantId: principal.tenantId,
        requestHash: hashRequest({ eventId, body }),
      },
      async () => {
        const event = await loadAuthorizedEvent(eventId, principal, db);

        const audienceResolution = await resolveMessageAudience({
          db,
          tenantId: principal.tenantId,
          eventId,
          audience: body.audience,
          attendeeIds: body.attendeeIds,
          channel: body.channel,
        });
        if (audienceResolution.attendees.length === 0) {
          throw new ValidationError('No matching recipients for this message campaign');
        }

        const notificationType = 'bulk' as const;
        const variables: Record<string, unknown> = {
          ...body.variables,
          campaignAudience: body.audience,
          campaignAudienceAttendeeIds: body.audience === 'specific' ? (body.attendeeIds ?? []) : [],
          campaignAudienceCount: audienceResolution.attendees.length,
        };
        let queuedEmailJobs: QueuedEmailJob[] = [];
        const queuedSmsJobIds: string[] = [];
        if (body.channel === 'email' || body.channel === 'both') {
          const template = await new NotificationTemplateRepository(db).findByKeyForBrand(
            principal.tenantId,
            body.templateKey,
            event.brand_id,
          );
          if (!template) {
            throw new ValidationError(`Notification template not found: ${body.templateKey}`);
          }
          const templateVersion = await new NotificationTemplateVersionRepository(db).findDefault(
            template.id,
          );
          if (!templateVersion) {
            throw new ValidationError(`Default template version not found: ${body.templateKey}`);
          }
          const emailRoutes = await new EmailProviderRouteRepository(db).findActiveByBrand(
            event.brand_id,
          );
          const emailRoute =
            emailRoutes.find((route) =>
              safeJsonArray(route.allowed_categories).includes(notificationType),
            ) ?? emailRoutes[0];
          if (!emailRoute) {
            throw new ValidationError('No active email provider route for this brand');
          }

          const emailRepo = new EmailJobRepository(db);
          const emailJobResults = await Promise.all(
            audienceResolution.emailDecisions.map(
              async (decision): Promise<QueuedEmailJob | undefined> => {
                const attendee = decision.attendee;
                if (decision.status === 'missing_contact' || !attendee.email) {
                  return undefined;
                }
                if (decision.status === 'suppressed') {
                  const jobKey = `${campaignId}:email:${attendee.id}`;
                  const existing = await emailRepo.findByIdempotencyKey(principal.tenantId, jobKey);
                  const job =
                    existing ??
                    (await emailRepo.create({
                      tenantId: principal.tenantId,
                      brandId: event.brand_id,
                      templateKey: body.templateKey,
                      templateVersionId: templateVersion.id,
                      toEmail: attendee.email,
                      toName: attendeeName(attendee),
                      variables: {
                        ...variables,
                        attendeeId: attendee.id,
                        eventId,
                        notificationType,
                        consentExcluded: decision.consentExcluded,
                        suppressionExcluded: decision.suppressionExcluded,
                      },
                      providerRouteId: emailRoute.id,
                      priority: 'low',
                      idempotencyKey: jobKey,
                      status: 'suppressed',
                    }));
                  if (job.status !== 'suppressed') {
                    await emailRepo.update(job.id, { status: 'suppressed' });
                  }
                  return undefined;
                }
                const jobKey = `${campaignId}:email:${attendee.id}`;
                const existing = await emailRepo.findByIdempotencyKey(principal.tenantId, jobKey);
                const job =
                  existing ??
                  (await emailRepo.create({
                    tenantId: principal.tenantId,
                    brandId: event.brand_id,
                    templateKey: body.templateKey,
                    templateVersionId: templateVersion.id,
                    toEmail: attendee.email,
                    toName:
                      [attendee.first_name, attendee.last_name].filter(Boolean).join(' ') ||
                      undefined,
                    variables: {
                      ...variables,
                      attendeeId: attendee.id,
                      eventId,
                      notificationType,
                    },
                    providerRouteId: emailRoute.id,
                    priority: 'low',
                    idempotencyKey: jobKey,
                  }));
                if (job.status !== 'suppressed') {
                  return {
                    jobId: job.id,
                    toEmail: attendee.email,
                    toName: attendeeName(attendee),
                    templateVersionId: templateVersion.id,
                    providerRouteId: emailRoute.id,
                    variables: {
                      ...variables,
                      attendeeId: attendee.id,
                      eventId,
                      notificationType,
                    },
                  };
                }
                return undefined;
              },
            ),
          );
          queuedEmailJobs = emailJobResults.filter((job): job is QueuedEmailJob => Boolean(job));
        }

        if (body.channel === 'sms' || body.channel === 'both') {
          const smsRoutes = await new SmsProviderRouteRepository(db).findActiveByBrand(
            event.brand_id,
          );
          const smsRoute =
            smsRoutes.find((route) =>
              safeJsonArray(route.allowed_categories).includes(notificationType),
            ) ?? smsRoutes[0];
          if (!smsRoute) {
            throw new ValidationError('No active SMS provider route for this brand');
          }

          const smsBody =
            typeof variables.body === 'string' && variables.body.trim().length > 0
              ? variables.body
              : body.templateKey;
          const smsRepo = new SmsJobRepository(db);
          const smsJobResults = await Promise.all(
            audienceResolution.smsDecisions.map(async (decision) => {
              const attendee = decision.attendee;
              if (decision.status === 'missing_contact' || !attendee.phone) {
                return undefined;
              }
              const jobKey = `${campaignId}:sms:${attendee.id}`;
              if (decision.status === 'suppressed') {
                const existing = await smsRepo.findByIdempotencyKey(principal.tenantId, jobKey);
                const job =
                  existing ??
                  (await smsRepo.create({
                    tenantId: principal.tenantId,
                    brandId: event.brand_id,
                    toPhone: attendee.phone,
                    body: smsBody,
                    templateKey: body.templateKey,
                    variables: {
                      ...variables,
                      attendeeId: attendee.id,
                      eventId,
                      notificationType,
                      consentExcluded: true,
                    },
                    providerRouteId: smsRoute.id,
                    priority: 'low',
                    idempotencyKey: jobKey,
                    status: 'suppressed',
                  }));
                if (job.status !== 'suppressed') {
                  await smsRepo.update(job.id, { status: 'suppressed' });
                }
                return undefined;
              }
              const existing = await smsRepo.findByIdempotencyKey(principal.tenantId, jobKey);
              const job =
                existing ??
                (await smsRepo.create({
                  tenantId: principal.tenantId,
                  brandId: event.brand_id,
                  toPhone: attendee.phone,
                  body: smsBody,
                  templateKey: body.templateKey,
                  variables: {
                    ...variables,
                    attendeeId: attendee.id,
                    eventId,
                    notificationType,
                  },
                  providerRouteId: smsRoute.id,
                  priority: 'low',
                  idempotencyKey: jobKey,
                }));
              if (job.status !== 'suppressed') {
                return job.id;
              }
              return undefined;
            }),
          );
          queuedSmsJobIds.push(
            ...smsJobResults.filter((jobId): jobId is string => typeof jobId === 'string'),
          );
        }

        await Promise.all(
          queuedEmailJobs.map((job) =>
            app.context.temporalClient.startNotificationDelivery({
              jobId: job.jobId,
              tenantId: principal.tenantId,
              brandId: event.brand_id,
              templateKey: body.templateKey,
              templateVersionId: job.templateVersionId,
              toEmail: job.toEmail,
              toName: job.toName,
              variables: job.variables,
              providerRouteId: job.providerRouteId,
              notificationType,
            }),
          ),
        );

        if (body.channel === 'sms' || body.channel === 'both') {
          const smsRouteId = await getSmsProviderRouteId(db, event.brand_id, notificationType);
          await Promise.all(
            queuedSmsJobIds.map((jobId) =>
              app.context.temporalClient.startSmsDelivery({
                jobId,
                tenantId: principal.tenantId,
                brandId: event.brand_id,
                providerRouteId: smsRouteId,
                notificationType,
              }),
            ),
          );
        }

        return {
          status: 202,
          body: {
            campaignId,
            eventId,
            templateKey: body.templateKey,
            channel: body.channel,
            status: queuedEmailJobs.length + queuedSmsJobIds.length > 0 ? 'queued' : 'suppressed',
            audienceCount: audienceResolution.attendees.length,
            queuedEmailJobs: queuedEmailJobs.length,
            queuedSmsJobs: queuedSmsJobIds.length,
            suppressedRecipients: audienceResolution.suppressedRecipients,
            consentExclusions: audienceResolution.consentExclusions,
            skippedRecipients: audienceResolution.skippedRecipients,
            emailJobIds: queuedEmailJobs.map((job) => job.jobId),
            smsJobIds: queuedSmsJobIds,
          },
        };
      },
    );

    return reply.status(result.status).send(result.body);
  });
};

async function loadAuthorizedEvent(eventId: string, principal: Principal, db: Database) {
  const eventRepo = new EventRepository(db);
  const event = await eventRepo.findById(eventId);
  if (!event) {
    throw new ValidationError('Event not found');
  }
  ClerkAuthService.requireResourceTenant(principal, event, 'Event', eventId);
  ClerkAuthService.requireOrganizationScope(principal, event.organization_id as string | undefined);
  ClerkAuthService.requireBrandScope(principal, event.brand_id as string | undefined);
  ClerkAuthService.requireEventScope(principal, eventId);
  return event;
}

function audienceToResponse(audience: MessageAudience) {
  if (audience === 'all') return 'all_attendees';
  if (audience === 'specific') return 'custom';
  return audience;
}

function rawAudienceFromVariables(variables: Record<string, unknown>): MessageAudience | undefined {
  const audience = variables.campaignAudience;
  if (
    audience === 'all' ||
    audience === 'checked_in' ||
    audience === 'not_checked_in' ||
    audience === 'specific'
  ) {
    return audience;
  }
  return undefined;
}

async function loadMessageAudienceAttendees(input: {
  db: Database;
  eventId: string;
  audience: MessageAudience;
  attendeeIds?: string[];
}) {
  let attendeeQuery = input.db
    .selectFrom('attendees')
    .select(['id', 'event_id', 'first_name', 'last_name', 'email', 'phone', 'status'])
    .where('event_id', '=', input.eventId)
    .where('status', 'in', ['confirmed', 'checked_in']);

  if (input.audience === 'checked_in') {
    attendeeQuery = attendeeQuery.where('status', '=', 'checked_in');
  } else if (input.audience === 'not_checked_in') {
    attendeeQuery = attendeeQuery.where('status', '=', 'confirmed');
  } else if (input.audience === 'specific') {
    attendeeQuery = attendeeQuery.where('id', 'in', input.attendeeIds ?? []);
  }

  const rows = await attendeeQuery.execute();
  const requested = new Set(input.attendeeIds ?? []);
  return rows
    .filter(
      (attendee) =>
        typeof attendee.id === 'string' &&
        (typeof attendee.event_id !== 'string' || attendee.event_id === input.eventId) &&
        (attendee.status === 'confirmed' || attendee.status === 'checked_in') &&
        (input.audience !== 'specific' || requested.has(attendee.id)) &&
        (input.audience !== 'checked_in' || attendee.status === 'checked_in') &&
        (input.audience !== 'not_checked_in' || attendee.status === 'confirmed'),
    )
    .map((attendee) => ({
      id: attendee.id,
      event_id: attendee.event_id,
      first_name: attendee.first_name ?? null,
      last_name: attendee.last_name ?? null,
      email: attendee.email ?? null,
      phone: attendee.phone ?? null,
      status: attendee.status,
    }));
}

async function resolveMessageAudience(input: {
  db: Database;
  tenantId: string;
  eventId: string;
  audience: MessageAudience;
  attendeeIds?: string[];
  channel: MessageChannel;
}) {
  const attendees = await loadMessageAudienceAttendees(input);
  const consents = await new MessageConsentRepository(input.db).findActiveByAttendeeIds(
    input.tenantId,
    attendees.map((attendee) => attendee.id),
  );
  const consentByAttendee = new Map<string, (typeof consents)[number]>();
  for (const consent of consents) {
    if (!consentByAttendee.has(consent.attendee_id)) {
      consentByAttendee.set(consent.attendee_id, consent);
    }
  }

  const emailSuppressionByAttendee = new Map<string, Record<string, unknown>>();
  if (input.channel === 'email' || input.channel === 'both') {
    const suppressionRepo = new EmailSuppressionRepository(input.db);
    const suppressions = await Promise.all(
      attendees.map(async (attendee) => {
        if (!attendee.email) return undefined;
        const suppression = await suppressionRepo.findByEmail(input.tenantId, attendee.email);
        return suppression ? { attendeeId: attendee.id, suppression } : undefined;
      }),
    );
    for (const result of suppressions) {
      if (result) emailSuppressionByAttendee.set(result.attendeeId, result.suppression);
    }
  }

  let skippedRecipients = 0;
  let suppressedRecipients = 0;
  let consentExclusions = 0;
  const eligibleRecipientIds = new Set<string>();
  const emailDecisions: ChannelDecision[] = [];
  const smsDecisions: ChannelDecision[] = [];
  for (const attendee of attendees) {
    const consent = consentByAttendee.get(attendee.id);
    if (input.channel === 'email' || input.channel === 'both') {
      if (!attendee.email) {
        skippedRecipients += 1;
        emailDecisions.push({
          attendee,
          status: 'missing_contact',
          consentExcluded: false,
          suppressionExcluded: false,
        });
      } else if (
        !consent?.email_opt_in ||
        consent.revoked_at ||
        emailSuppressionByAttendee.has(attendee.id)
      ) {
        const consentExcluded = !consent?.email_opt_in || Boolean(consent.revoked_at);
        const suppressionExcluded = emailSuppressionByAttendee.has(attendee.id);
        suppressedRecipients += 1;
        consentExclusions += consentExcluded ? 1 : 0;
        emailDecisions.push({
          attendee,
          status: 'suppressed',
          consentExcluded,
          suppressionExcluded,
        });
      } else {
        eligibleRecipientIds.add(attendee.id);
        emailDecisions.push({
          attendee,
          status: 'eligible',
          consentExcluded: false,
          suppressionExcluded: false,
        });
      }
    }
    if (input.channel === 'sms' || input.channel === 'both') {
      if (!attendee.phone) {
        skippedRecipients += 1;
        smsDecisions.push({
          attendee,
          status: 'missing_contact',
          consentExcluded: false,
          suppressionExcluded: false,
        });
      } else if (!consent?.sms_opt_in || consent.revoked_at) {
        suppressedRecipients += 1;
        consentExclusions += 1;
        smsDecisions.push({
          attendee,
          status: 'suppressed',
          consentExcluded: true,
          suppressionExcluded: false,
        });
      } else {
        eligibleRecipientIds.add(attendee.id);
        smsDecisions.push({
          attendee,
          status: 'eligible',
          consentExcluded: false,
          suppressionExcluded: false,
        });
      }
    }
  }

  return {
    attendees,
    consentByAttendee,
    emailSuppressionByAttendee,
    emailDecisions,
    smsDecisions,
    eligibleRecipients: attendees.filter((attendee) => eligibleRecipientIds.has(attendee.id)),
    skippedRecipients,
    suppressedRecipients,
    consentExclusions,
  };
}

async function loadAuthorizedCampaign(
  eventId: string,
  campaignId: string,
  principal: Principal,
  db: Database,
) {
  const event = await loadAuthorizedEvent(eventId, principal, db);
  const [emailJobs, smsJobs] = await Promise.all([
    new EmailJobRepository(db).findByCampaignKey(principal.tenantId, campaignId),
    new SmsJobRepository(db).findByCampaignKey(principal.tenantId, campaignId),
  ]);
  const campaignEmailJobs = emailJobs.filter(
    (job) => job.brand_id === event.brand_id && jobVariables(job).eventId === eventId,
  );
  const campaignSmsJobs = smsJobs.filter(
    (job) => job.brand_id === event.brand_id && jobVariables(job).eventId === eventId,
  );

  if (campaignEmailJobs.length === 0 && campaignSmsJobs.length === 0) {
    throw new ValidationError('Message campaign not found');
  }

  return {
    event,
    emailJobs: campaignEmailJobs,
    smsJobs: campaignSmsJobs,
  };
}

function buildJobItems(
  eventId: string,
  campaignId: string,
  emailJobs: Array<Record<string, unknown>>,
  smsJobs: Array<Record<string, unknown>>,
) {
  return sortNewestFirst(
    [
      ...emailJobs.map((job) => ({
        channel: 'email' as const,
        campaignId,
        eventId,
        job,
      })),
      ...smsJobs.map((job) => ({
        channel: 'sms' as const,
        campaignId,
        eventId,
        job,
      })),
    ],
    (item) => item.job.created_at,
  );
}

function buildDeliveryLogItems(
  eventId: string,
  campaignId: string,
  emailDeliveries: Array<Record<string, unknown>>,
  smsDeliveries: Array<Record<string, unknown>>,
) {
  return sortNewestFirst(
    [
      ...emailDeliveries.map((delivery) => ({
        channel: 'email' as const,
        campaignId,
        eventId,
        delivery,
      })),
      ...smsDeliveries.map((delivery) => ({
        channel: 'sms' as const,
        campaignId,
        eventId,
        delivery,
      })),
    ],
    (item) => item.delivery.created_at,
  );
}

function filterDeliveriesByJobs(
  deliveries: Array<Record<string, unknown>>,
  jobs: Array<Record<string, unknown>>,
) {
  const jobIds = new Set(
    jobs.map((job) => job.id).filter((id): id is string => typeof id === 'string'),
  );
  return deliveries.filter(
    (delivery) => typeof delivery.job_id === 'string' && jobIds.has(delivery.job_id),
  );
}

async function loadCampaignProviderEventItems(
  eventId: string,
  campaignId: string,
  principal: Principal,
  db: Database,
) {
  const { emailJobs, smsJobs } = await loadAuthorizedCampaign(eventId, campaignId, principal, db);
  const [foundEmailDeliveries, foundSmsDeliveries] = await Promise.all([
    new EmailDeliveryRepository(db).findByJobIds(
      principal.tenantId,
      emailJobs.map((job) => job.id),
    ),
    new SmsDeliveryRepository(db).findByJobIds(
      principal.tenantId,
      smsJobs.map((job) => job.id),
    ),
  ]);
  const emailDeliveries = filterDeliveriesByJobs(foundEmailDeliveries, emailJobs);
  const smsDeliveries = filterDeliveriesByJobs(foundSmsDeliveries, smsJobs);
  const emailProviderMessageIds = [
    ...new Set(
      emailDeliveries
        .map((delivery) => delivery.provider_message_id)
        .filter(
          (providerMessageId): providerMessageId is string =>
            typeof providerMessageId === 'string' && providerMessageId.length > 0,
        ),
    ),
  ];
  const smsProviderMessageIds = [
    ...new Set(
      smsDeliveries
        .map((delivery) => delivery.provider_message_id)
        .filter(
          (providerMessageId): providerMessageId is string =>
            typeof providerMessageId === 'string' && providerMessageId.length > 0,
        ),
    ),
  ];
  const [emailProviderEvents, smsProviderEvents] = await Promise.all([
    new EmailProviderEventRepository(db).findByProviderMessageIds(
      principal.tenantId,
      emailProviderMessageIds,
    ),
    new SmsProviderEventRepository(db).findByProviderMessageIds(
      principal.tenantId,
      smsProviderMessageIds,
    ),
  ]);
  const emailProviderMessageIdSet = new Set(emailProviderMessageIds);
  const smsProviderMessageIdSet = new Set(smsProviderMessageIds);

  return sortNewestFirst(
    [
      ...emailProviderEvents
        .filter(
          (event) =>
            event.tenant_id === principal.tenantId &&
            typeof event.provider_message_id === 'string' &&
            emailProviderMessageIdSet.has(event.provider_message_id),
        )
        .map((event) => ({
          channel: 'email' as const,
          campaignId,
          eventId,
          event,
        })),
      ...smsProviderEvents
        .filter(
          (event) =>
            event.tenant_id === principal.tenantId &&
            typeof event.provider_message_id === 'string' &&
            smsProviderMessageIdSet.has(event.provider_message_id),
        )
        .map((event) => ({
          channel: 'sms' as const,
          campaignId,
          eventId,
          event,
        })),
    ],
    (item) => item.event.created_at,
  );
}

function attendeeName(attendee: { first_name: string | null; last_name: string | null }) {
  return [attendee.first_name, attendee.last_name].filter(Boolean).join(' ') || undefined;
}

function safeJson(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'object') return value as Record<string, unknown>;
  try {
    return JSON.parse(String(value)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function safeArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function jobVariables(job: { variables?: unknown }) {
  return safeJson(job.variables);
}

function campaignKey(idempotencyKey: string) {
  const emailIndex = idempotencyKey.lastIndexOf(':email:');
  const smsIndex = idempotencyKey.lastIndexOf(':sms:');
  const markerIndex = Math.max(emailIndex, smsIndex);
  return markerIndex > -1 ? idempotencyKey.slice(0, markerIndex) : idempotencyKey;
}

function toIso(value: unknown) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return new Date(value).toISOString();
  return new Date().toISOString();
}

function audienceLabel(audience: MessageAudience, attendeeIds: string[]) {
  if (audience === 'all') return 'All attendees';
  if (audience === 'checked_in') return 'Checked in';
  if (audience === 'not_checked_in') return 'Not checked in';
  const count = attendeeIds.length;
  return count === 1 ? 'Custom (1 attendee)' : `Custom (${count} attendees)`;
}

function campaignAudienceMetadata(jobs: Array<Record<string, unknown>>) {
  const variablesByJob = jobs.map(jobVariables);
  const audience =
    variablesByJob
      .map(rawAudienceFromVariables)
      .find((candidate): candidate is MessageAudience => Boolean(candidate)) ?? 'all';
  const attendeeIds =
    audience === 'specific'
      ? safeArray(
          variablesByJob.find((variables) => Array.isArray(variables.campaignAudienceAttendeeIds))
            ?.campaignAudienceAttendeeIds,
        ).map(String)
      : [];
  const persistedCount = variablesByJob
    .map((variables) => Number(variables.campaignAudienceCount))
    .find((count) => Number.isInteger(count) && count >= 0);
  const attendeeIdsFromJobs = new Set(
    variablesByJob
      .map((variables) => variables.attendeeId)
      .filter(
        (attendeeId): attendeeId is string =>
          typeof attendeeId === 'string' && attendeeId.length > 0,
      ),
  );
  const audienceCount =
    persistedCount ??
    (audience === 'specific' && attendeeIds.length > 0
      ? attendeeIds.length
      : attendeeIdsFromJobs.size || jobs.length);

  return {
    audience,
    responseAudience: audienceToResponse(audience),
    attendeeIds,
    audienceCount,
    label: audienceLabel(audience, attendeeIds),
  };
}

function buildCampaignSummaries(input: {
  eventId: string;
  emailJobs: Array<Record<string, unknown>>;
  smsJobs: Array<Record<string, unknown>>;
}) {
  const groups = new Map<
    string,
    { emailJobs: Array<Record<string, unknown>>; smsJobs: Array<Record<string, unknown>> }
  >();
  for (const job of input.emailJobs) {
    const id = campaignKey(String(job.idempotency_key));
    const group = groups.get(id) ?? { emailJobs: [], smsJobs: [] };
    group.emailJobs.push(job);
    groups.set(id, group);
  }
  for (const job of input.smsJobs) {
    const id = campaignKey(String(job.idempotency_key));
    const group = groups.get(id) ?? { emailJobs: [], smsJobs: [] };
    group.smsJobs.push(job);
    groups.set(id, group);
  }

  return sortNewestFirst(
    [...groups.entries()].map(([id, group]) => {
      const jobs = [...group.emailJobs, ...group.smsJobs];
      const firstJob = jobs[0] ?? {};
      const variables = jobVariables(firstJob);
      const audienceMetadata = campaignAudienceMetadata(jobs);
      const statuses = jobs.map((job) => String(job.status));
      const suppressedRecipients = statuses.filter((status) => status === 'suppressed').length;
      const consentExclusions = jobs.filter(
        (job) => jobVariables(job).consentExcluded === true,
      ).length;
      const emailQueued = group.emailJobs.filter((job) => job.status !== 'suppressed').length;
      const smsQueued = group.smsJobs.filter((job) => job.status !== 'suppressed').length;
      const createdAt = jobs.reduce((earliest, job) => {
        const created = new Date(String(job.created_at)).getTime();
        return Number.isFinite(created) && created < earliest ? created : earliest;
      }, Number.POSITIVE_INFINITY);
      const updatedAt = jobs.reduce((latest, job) => {
        const updated = new Date(String(job.updated_at)).getTime();
        return Number.isFinite(updated) && updated > latest ? updated : latest;
      }, 0);

      return {
        id,
        eventId: input.eventId,
        tenantId: String(firstJob.tenant_id),
        brandId: String(firstJob.brand_id),
        templateKey: String(firstJob.template_key ?? variables.templateKey ?? 'attendee-message'),
        channel:
          group.emailJobs.length > 0 && group.smsJobs.length > 0
            ? 'both'
            : group.smsJobs.length > 0
              ? 'sms'
              : 'email',
        status: campaignStatus(statuses),
        audience: audienceMetadata.responseAudience,
        audienceKey: audienceMetadata.audience,
        audienceAttendeeIds: audienceMetadata.attendeeIds,
        audienceLabel: audienceMetadata.label,
        audienceCount: audienceMetadata.audienceCount,
        queuedEmailJobs: emailQueued,
        queuedSmsJobs: smsQueued,
        suppressedRecipients,
        consentExclusions,
        skippedRecipients: 0,
        createdAt: toIso(Number.isFinite(createdAt) ? new Date(createdAt) : firstJob.created_at),
        updatedAt: toIso(updatedAt > 0 ? new Date(updatedAt) : firstJob.updated_at),
      };
    }),
    (summary) => summary.createdAt,
  );
}

function sortNewestFirst<T>(items: T[], createdAt: (item: T) => unknown) {
  // eslint-disable-next-line unicorn/no-array-sort -- sorting a copied response array preserves deterministic newest-first API output.
  return [...items].sort((a, b) => toIso(createdAt(b)).localeCompare(toIso(createdAt(a))));
}

function campaignStatus(statuses: string[]) {
  if (statuses.length === 0) return 'no_recipients';
  if (statuses.some((status) => status === 'failed')) return 'failed';
  if (statuses.every((status) => status === 'suppressed')) return 'suppressed';
  if (statuses.every((status) => status === 'sent')) return 'sent';
  if (statuses.some((status) => status === 'processing')) return 'processing';
  return 'queued';
}

async function getSmsProviderRouteId(db: Database, brandId: string, notificationType: string) {
  const routes = await new SmsProviderRouteRepository(db).findActiveByBrand(brandId);
  const route =
    routes.find((candidate) =>
      safeJsonArray(candidate.allowed_categories).includes(notificationType),
    ) ?? routes[0];
  if (!route) throw new ValidationError('No active SMS provider route for this brand');
  return route.id;
}

function safeJsonArray(value: unknown) {
  return safeArray(value).map(String);
}
