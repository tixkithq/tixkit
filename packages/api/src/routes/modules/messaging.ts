import type { FastifyPluginAsync } from 'fastify';
import {
  type Database,
  AuditLogRepository,
  ContentRepository,
  EmailDeliveryRepository,
  EmailJobRepository,
  EmailProviderEventRepository,
  EmailProviderRouteRepository,
  EventRepository,
  SmsDeliveryRepository,
  SmsJobRepository,
  SmsProviderEventRepository,
  SmsProviderRouteRepository,
} from '@tixkit/db';
import { ClerkAuthService } from '../../auth/clerk.js';
import { writeAuditLog } from '../../auth/audit.js';
import { NotFoundError, type Principal, ValidationError } from '@tixkit/domain';
import {
  normalizeSmsTemplateDocument,
  renderSmsTemplate,
  type SmsTemplateDocument,
} from '@tixkit/content-message';
import {
  renderMergeTags,
  validateMergeTags,
  countSmsSegments,
  type MergeTagContext,
  type MergeTagChannel,
} from '@tixkit/domain/messaging';
import { renderMessagePreviewSchema, sendMessageSchema } from '../../http/schemas.js';
import { hashRequest, withIdempotency } from '../../services/idempotency.js';
import {
  resolveMessageAudience,
  type MessageAttendee,
  type MessageAudience,
  type MessageChannel,
} from '../../services/message-audience.js';

type QueuedEmailJob = {
  jobId: string;
  toEmail: string;
  toName?: string;
  templateVersionId: string;
  providerRouteId: string;
  variables: Record<string, unknown>;
};

type QueuedSmsJob = {
  jobId: string;
  providerRouteId: string;
};

const MAX_INLINE_CAMPAIGN_ID_LENGTH = 128;

function campaignIdFromIdempotencyKey(idempotencyKey: string): string {
  return idempotencyKey.length <= MAX_INLINE_CAMPAIGN_ID_LENGTH
    ? idempotencyKey
    : `msg_${hashRequest(idempotencyKey)}`;
}

function requireMessageIdempotencyKey(headers: Record<string, unknown>): string {
  const value = headers['idempotency-key'];
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 255 ||
    value.trim() !== value ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  ) {
    throw new ValidationError(
      'Idempotency-Key must contain 1-255 safe token characters with no surrounding whitespace',
    );
  }
  return value;
}

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
      emailJobs: campaignEmailJobs.map((job) => sanitizeMessageJob('email', job)),
      smsJobs: campaignSmsJobs.map((job) => sanitizeMessageJob('sms', job)),
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
    const parsed = renderMessagePreviewSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError('Invalid message render preview request', {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }
    const body = parsed.data;
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
    const segments = channel === 'sms' && smsBody ? countSmsSegments(smsBody) : undefined;

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
    const idempotencyKey = requireMessageIdempotencyKey(request.headers);

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
    const scheduledAt = body.scheduledAt ? new Date(body.scheduledAt) : undefined;

    if (body.audience === 'specific' && (!body.attendeeIds || body.attendeeIds.length === 0)) {
      throw new ValidationError('attendeeIds is required when audience is specific', {
        field: 'attendeeIds',
      });
    }
    const templateKeys = resolveCampaignTemplateKeys(body);

    const campaignId = campaignIdFromIdempotencyKey(idempotencyKey);
    const requestSha256 = hashRequest({ eventId, body });
    const campaignIdSha256 = hashRequest(campaignId);
    const auditCampaignId = `msg_${campaignIdSha256.slice(0, 28)}`;
    await loadAuthorizedEvent(eventId, principal, db);
    await app.context.messageCampaignWriteCheckpoint?.({
      stage: 'before_transaction',
      eventId,
      campaignId,
    });
    const result = await withIdempotency(
      db,
      {
        key: idempotencyKey,
        tenantId: principal.tenantId,
        requestHash: requestSha256,
        discardErrorCodes: ['NOT_FOUND', 'FORBIDDEN'],
      },
      async ({ completeInTransaction }) => {
        if (scheduledAt && scheduledAt.getTime() <= Date.now()) {
          throw new ValidationError('scheduledAt must be in the future', {
            field: 'scheduledAt',
          });
        }

        const prepared = await db.transaction().execute(async (transaction) => {
          const event = await loadLockedAuthorizedEvent(eventId, principal, transaction);
          let emailTemplateVersionId: string | undefined;
          let smsTemplateVersionId: string | undefined;

          const audienceResolution = await resolveMessageAudience({
            db: transaction,
            tenantId: principal.tenantId,
            eventId,
            audience: body.audience,
            attendeeIds: body.attendeeIds,
            channel: body.channel,
          });
          if (audienceResolution.attendees.length === 0) {
            throw new ValidationError('No matching recipients for this message campaign');
          }
          if (audienceResolution.eligibleRecipients.length === 0) {
            throw new ValidationError('No eligible recipients for this message campaign', {
              audienceCount: audienceResolution.attendees.length,
              suppressedRecipients: audienceResolution.suppressedRecipients,
              consentExclusions: audienceResolution.consentExclusions,
              skippedRecipients: audienceResolution.skippedRecipients,
            });
          }

          const notificationType = 'bulk' as const;
          const variables: Record<string, unknown> = {
            ...body.variables,
            campaignEmailTemplateKey: templateKeys.emailTemplateKey,
            campaignSmsTemplateKey: templateKeys.smsTemplateKey,
            campaignAudience: body.audience,
            campaignAudienceAttendeeIds:
              body.audience === 'specific' ? (body.attendeeIds ?? []) : [],
            campaignAudienceCount: audienceResolution.attendees.length,
            campaignSuppressedRecipients: audienceResolution.suppressedRecipients,
            campaignConsentExclusions: audienceResolution.consentExclusions,
            campaignSkippedRecipients: audienceResolution.skippedRecipients,
          };
          let queuedEmailJobs: QueuedEmailJob[] = [];
          const queuedSmsJobs: QueuedSmsJob[] = [];
          if (body.channel === 'email' || body.channel === 'both') {
            const emailTemplateKey = templateKeys.emailTemplateKey;
            if (!emailTemplateKey) {
              throw new ValidationError(
                'emailTemplateKey is required for email message campaigns',
                {
                  field: 'emailTemplateKey',
                },
              );
            }
            const publishedContentTemplate = await new ContentRepository(
              transaction,
            ).findPublishedEmailTemplate({
              tenantId: principal.tenantId,
              brandId: event.brand_id,
              eventId,
              key: emailTemplateKey,
            });
            const templateVersionId = publishedContentTemplate?.version.id;
            if (!templateVersionId) {
              throw new ValidationError(
                `Published email content template not found: ${emailTemplateKey}`,
              );
            }
            emailTemplateVersionId = templateVersionId;
            const emailRoutes = await new EmailProviderRouteRepository(
              transaction,
            ).findActiveByBrand(event.brand_id);
            const emailRoute = selectCampaignProviderRoute(emailRoutes, notificationType);
            if (!emailRoute) {
              throw new ValidationError('No active email provider route for this brand');
            }

            const emailRepo = new EmailJobRepository(transaction);
            const emailJobResults = await Promise.all(
              audienceResolution.emailDecisions.map(
                async (decision): Promise<QueuedEmailJob | undefined> => {
                  const attendee = decision.attendee;
                  if (decision.status === 'missing_contact' || !attendee.email) {
                    return undefined;
                  }
                  if (decision.status === 'suppressed') {
                    return undefined;
                  }
                  const recipientVariables = campaignRecipientVariables(variables, event, attendee);
                  const jobKey = `${campaignId}:email:${attendee.id}`;
                  const existing = await emailRepo.findByIdempotencyKey(principal.tenantId, jobKey);
                  const job =
                    existing ??
                    (await emailRepo.create({
                      tenantId: principal.tenantId,
                      brandId: event.brand_id,
                      templateKey: emailTemplateKey,
                      templateVersionId,
                      toEmail: attendee.email,
                      toName:
                        [attendee.first_name, attendee.last_name].filter(Boolean).join(' ') ||
                        undefined,
                      variables: {
                        ...recipientVariables,
                        attendeeId: attendee.id,
                        eventId,
                        notificationType,
                      },
                      providerRouteId: emailRoute.id,
                      priority: 'low',
                      scheduledAt,
                      idempotencyKey: jobKey,
                    }));
                  if (job.status !== 'suppressed') {
                    return {
                      jobId: job.id,
                      toEmail: attendee.email,
                      toName: attendeeName(attendee),
                      templateVersionId,
                      providerRouteId: emailRoute.id,
                      variables: {
                        ...recipientVariables,
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
            const smsTemplateKey = templateKeys.smsTemplateKey;
            if (!smsTemplateKey) {
              throw new ValidationError('smsTemplateKey is required for SMS message campaigns', {
                field: 'smsTemplateKey',
              });
            }
            const publishedSmsTemplate = await new ContentRepository(
              transaction,
            ).findPublishedSmsTemplate({
              tenantId: principal.tenantId,
              brandId: event.brand_id,
              eventId,
              key: smsTemplateKey,
            });
            if (!publishedSmsTemplate) {
              throw new ValidationError(
                `Published SMS content template not found: ${smsTemplateKey}`,
              );
            }
            smsTemplateVersionId = publishedSmsTemplate.version.id;
            const smsTemplate = normalizeSmsTemplateDocument(
              publishedSmsTemplate.version.contentJson,
            );
            if (!smsTemplate) {
              throw new ValidationError(
                'Published SMS content template is not canonical SMS JSON',
                {
                  templateKey: smsTemplateKey,
                },
              );
            }
            const smsRoutes = await new SmsProviderRouteRepository(transaction).findActiveByBrand(
              event.brand_id,
            );
            const smsRoute = selectCampaignProviderRoute(smsRoutes, notificationType);
            if (!smsRoute) {
              throw new ValidationError('No active SMS provider route for this brand');
            }

            const smsRepo = new SmsJobRepository(transaction);
            const smsJobResults = await Promise.all(
              audienceResolution.smsDecisions.map(async (decision) => {
                const attendee = decision.attendee;
                if (decision.status === 'missing_contact' || !attendee.phone) {
                  return undefined;
                }
                const jobKey = `${campaignId}:sms:${attendee.id}`;
                if (decision.status === 'suppressed') {
                  return undefined;
                }
                const existing = await smsRepo.findByIdempotencyKey(principal.tenantId, jobKey);
                const job =
                  existing ??
                  (await smsRepo.create({
                    tenantId: principal.tenantId,
                    brandId: event.brand_id,
                    toPhone: attendee.phone,
                    body: renderCampaignSmsBody(smsTemplate, event, attendee, variables),
                    templateKey: smsTemplateKey,
                    variables: {
                      ...variables,
                      contentVersionId: publishedSmsTemplate.version.id,
                      attendeeId: attendee.id,
                      eventId,
                      notificationType,
                    },
                    providerRouteId: smsRoute.id,
                    priority: 'low',
                    scheduledAt,
                    idempotencyKey: jobKey,
                  }));
                if (job.status !== 'suppressed') {
                  return { jobId: job.id, providerRouteId: smsRoute.id };
                }
                return undefined;
              }),
            );
            queuedSmsJobs.push(
              ...smsJobResults.filter((job): job is QueuedSmsJob => job !== undefined),
            );
          }

          await app.context.messageCampaignWriteCheckpoint?.({
            stage: 'after_email_jobs',
            eventId,
            campaignId,
          });
          const queuedBody = {
            campaignId,
            eventId,
            emailTemplateKey: templateKeys.emailTemplateKey,
            smsTemplateKey: templateKeys.smsTemplateKey,
            channel: body.channel,
            status:
              queuedEmailJobs.length + queuedSmsJobs.length > 0
                ? ('queued' as const)
                : ('suppressed' as const),
            audienceCount: audienceResolution.attendees.length,
            queuedEmailJobs: queuedEmailJobs.length,
            queuedSmsJobs: queuedSmsJobs.length,
            startFailedEmailJobs: 0,
            startFailedSmsJobs: 0,
            scheduledAt: scheduledAt?.toISOString(),
            suppressedRecipients: audienceResolution.suppressedRecipients,
            consentExclusions: audienceResolution.consentExclusions,
            skippedRecipients: audienceResolution.skippedRecipients,
            emailJobIds: queuedEmailJobs.map((job) => job.jobId),
            smsJobIds: queuedSmsJobs.map((job) => job.jobId),
          };
          await app.context.messageCampaignWriteCheckpoint?.({
            stage: 'before_audit',
            eventId,
            campaignId,
          });
          await writeAuditLog(
            new AuditLogRepository(transaction),
            request,
            principal,
            {
              action: 'event.message_campaign.queued',
              organizationId: event.organization_id,
              brandId: event.brand_id,
              resourceType: 'MessageCampaign',
              resourceId: auditCampaignId,
              diffSummary: {
                eventId,
                campaignIdSha256,
                channel: body.channel,
                audience: body.audience,
                emailTemplateKey: templateKeys.emailTemplateKey,
                smsTemplateKey: templateKeys.smsTemplateKey,
                emailTemplateVersionId,
                smsTemplateVersionId,
                requestSha256,
                audienceCount: audienceResolution.attendees.length,
                queuedEmailJobs: queuedEmailJobs.length,
                queuedSmsJobs: queuedSmsJobs.length,
                suppressedRecipients: audienceResolution.suppressedRecipients,
                consentExclusions: audienceResolution.consentExclusions,
                skippedRecipients: audienceResolution.skippedRecipients,
                emailJobIds: queuedEmailJobs.map((job) => job.jobId),
                smsJobIds: queuedSmsJobs.map((job) => job.jobId),
              },
            },
            { failClosed: true },
          );
          const queuedResponse = { status: 202, body: queuedBody };
          await completeInTransaction(transaction, queuedResponse);
          return {
            event,
            notificationType,
            queuedEmailJobs,
            queuedSmsJobs,
            queuedBody,
          };
        });
        const { event, notificationType, queuedEmailJobs, queuedSmsJobs, queuedBody } = prepared;

        const startFailedEmailJobIds: string[] = [];
        const startFailedSmsJobIds: string[] = [];
        if (queuedEmailJobs.length > 0) {
          const emailTemplateKey = templateKeys.emailTemplateKey;
          if (!emailTemplateKey) {
            throw new ValidationError('emailTemplateKey is required for email message campaigns', {
              field: 'emailTemplateKey',
            });
          }
          const emailStartResults = await Promise.allSettled(
            queuedEmailJobs.map(async (job) => {
              await app.context.temporalClient.startNotificationDelivery({
                jobId: job.jobId,
                tenantId: principal.tenantId,
                brandId: event.brand_id,
                templateKey: emailTemplateKey,
                templateVersionId: job.templateVersionId,
                toEmail: job.toEmail,
                toName: job.toName,
                variables: job.variables,
                providerRouteId: job.providerRouteId,
                notificationType,
                scheduledAt: scheduledAt?.toISOString(),
              });
              return job.jobId;
            }),
          );
          for (let index = 0; index < emailStartResults.length; index++) {
            if (emailStartResults[index].status === 'fulfilled') continue;
            const jobId = queuedEmailJobs[index].jobId;
            startFailedEmailJobIds.push(jobId);
            // eslint-disable-next-line no-await-in-loop -- each failed start must be durably marked before the campaign response is persisted.
            await new EmailJobRepository(db).update(jobId, { status: 'start_failed' });
          }
        }

        if (body.channel === 'sms' || body.channel === 'both') {
          const smsStartResults = await Promise.allSettled(
            queuedSmsJobs.map(async (job) => {
              await app.context.temporalClient.startSmsDelivery({
                jobId: job.jobId,
                tenantId: principal.tenantId,
                brandId: event.brand_id,
                providerRouteId: job.providerRouteId,
                notificationType,
                scheduledAt: scheduledAt?.toISOString(),
              });
              return job.jobId;
            }),
          );
          for (let index = 0; index < smsStartResults.length; index++) {
            if (smsStartResults[index].status === 'fulfilled') continue;
            const jobId = queuedSmsJobs[index].jobId;
            startFailedSmsJobIds.push(jobId);
            // eslint-disable-next-line no-await-in-loop -- each failed start must be durably marked before the campaign response is persisted.
            await new SmsJobRepository(db).update(jobId, { status: 'start_failed' });
          }
        }

        const startedEmailJobs = queuedEmailJobs.length - startFailedEmailJobIds.length;
        const startedSmsJobs = queuedSmsJobs.length - startFailedSmsJobIds.length;
        const startFailedJobs = startFailedEmailJobIds.length + startFailedSmsJobIds.length;
        return {
          status: 202,
          body: {
            ...queuedBody,
            status:
              startFailedJobs > 0
                ? 'failed'
                : queuedEmailJobs.length + queuedSmsJobs.length > 0
                  ? 'queued'
                  : 'suppressed',
            queuedEmailJobs: startedEmailJobs,
            queuedSmsJobs: startedSmsJobs,
            startFailedEmailJobs: startFailedEmailJobIds.length,
            startFailedSmsJobs: startFailedSmsJobIds.length,
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
    throw new NotFoundError('Event', eventId);
  }
  ClerkAuthService.requireResourceTenant(principal, event, 'Event', eventId);
  ClerkAuthService.requireOrganizationScope(principal, event.organization_id as string | undefined);
  ClerkAuthService.requireBrandScope(principal, event.brand_id as string | undefined);
  ClerkAuthService.requireEventScope(principal, eventId);
  return event;
}

async function loadLockedAuthorizedEvent(eventId: string, principal: Principal, db: Database) {
  const event = await db
    .selectFrom('events')
    .selectAll()
    .where('id', '=', eventId)
    .forUpdate()
    .executeTakeFirst();
  if (!event) throw new NotFoundError('Event', eventId);
  ClerkAuthService.requireResourceTenant(principal, event, 'Event', eventId);
  ClerkAuthService.requireOrganizationScope(principal, event.organization_id);
  ClerkAuthService.requireBrandScope(principal, event.brand_id);
  ClerkAuthService.requireEventScope(principal, eventId);
  return event;
}

function audienceToResponse(audience: MessageAudience) {
  if (audience === 'all') return 'all_attendees';
  if (audience === 'specific') return 'custom';
  return audience;
}

function normalizedTemplateKey(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function resolveCampaignTemplateKeys(input: {
  channel: MessageChannel;
  emailTemplateKey?: string;
  smsTemplateKey?: string;
}) {
  const emailTemplateKey =
    input.channel === 'email' || input.channel === 'both'
      ? normalizedTemplateKey(input.emailTemplateKey)
      : undefined;
  const smsTemplateKey =
    input.channel === 'sms' || input.channel === 'both'
      ? normalizedTemplateKey(input.smsTemplateKey)
      : undefined;

  if ((input.channel === 'email' || input.channel === 'both') && !emailTemplateKey) {
    throw new ValidationError('emailTemplateKey is required for email message campaigns', {
      field: 'emailTemplateKey',
    });
  }
  if ((input.channel === 'sms' || input.channel === 'both') && !smsTemplateKey) {
    throw new ValidationError('smsTemplateKey is required for SMS message campaigns', {
      field: 'smsTemplateKey',
    });
  }

  return {
    emailTemplateKey,
    smsTemplateKey,
  };
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
    (job) =>
      job.brand_id === event.brand_id &&
      jobVariables(job).eventId === eventId &&
      jobBelongsToCampaign(job, campaignId),
  );
  const campaignSmsJobs = smsJobs.filter(
    (job) =>
      job.brand_id === event.brand_id &&
      jobVariables(job).eventId === eventId &&
      jobBelongsToCampaign(job, campaignId),
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
        job: sanitizeMessageJob('email', job),
      })),
      ...smsJobs.map((job) => ({
        channel: 'sms' as const,
        campaignId,
        eventId,
        job: sanitizeMessageJob('sms', job),
      })),
    ],
    (item) => item.job.created_at,
  );
}

function maskEmail(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  const [localPart, domain] = value.trim().split('@');
  if (!localPart || !domain) return '***';
  return `${localPart.slice(0, 1)}***@${domain}`;
}

function maskPhone(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  const digits = value.replace(/\D/g, '');
  if (digits.length <= 4) return '***';
  return `***${digits.slice(-4)}`;
}

function sanitizeMessageJob(channel: 'email' | 'sms', job: Record<string, unknown>) {
  return {
    id: job.id,
    tenant_id: job.tenant_id,
    brand_id: job.brand_id,
    template_key: job.template_key,
    template_version_id: job.template_version_id,
    provider_route_id: job.provider_route_id,
    status: job.status,
    priority: job.priority,
    scheduled_at: job.scheduled_at,
    workflow_id: job.workflow_id,
    recipient: channel === 'email' ? maskEmail(job.to_email) : maskPhone(job.to_phone),
    created_at: job.created_at,
    updated_at: job.updated_at,
  };
}

function sanitizeProviderEvent(event: Record<string, unknown>) {
  return {
    id: event.id,
    tenant_id: event.tenant_id,
    provider: event.provider,
    provider_event_id: event.provider_event_id,
    event_type: event.event_type,
    provider_message_id: event.provider_message_id,
    processed_at: event.processed_at,
    created_at: event.created_at,
  };
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
          event: sanitizeProviderEvent(event),
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
          event: sanitizeProviderEvent(event),
        })),
    ],
    (item) => item.event.created_at,
  );
}

function attendeeName(attendee: { first_name: string | null; last_name: string | null }) {
  return [attendee.first_name, attendee.last_name].filter(Boolean).join(' ') || undefined;
}

function renderCampaignSmsBody(
  document: SmsTemplateDocument,
  event: {
    title?: string | null;
    starts_at?: Date | string | null;
    ends_at?: Date | string | null;
    timezone?: string | null;
  },
  attendee: MessageAttendee,
  variables: Record<string, unknown>,
): string {
  const rendered = renderSmsTemplate(document, {
    ...variables,
    event: {
      ...recordValue(variables.event),
      title: event.title ?? undefined,
      startsAt: optionalIso(event.starts_at),
      endsAt: optionalIso(event.ends_at),
      timezone: event.timezone ?? undefined,
    },
    recipient: {
      ...recordValue(variables.recipient),
      name: attendeeName(attendee),
      email: attendee.email ?? undefined,
      phone: attendee.phone ?? undefined,
    },
    attendee: {
      ...recordValue(variables.attendee),
      name: attendeeName(attendee),
      checkedIn: attendee.status === 'checked_in',
    },
  });
  if (!rendered.validation.valid) {
    throw new ValidationError('Published SMS content template has render blockers', {
      issues: rendered.validation.issues,
      templateKey: document.settings.templateKey,
      attendeeId: attendee.id,
    });
  }
  return rendered.text;
}

function campaignRecipientVariables(
  variables: Record<string, unknown>,
  event: {
    title?: string | null;
    starts_at?: Date | string | null;
    ends_at?: Date | string | null;
    timezone?: string | null;
  },
  attendee: MessageAttendee,
): Record<string, unknown> {
  return {
    ...variables,
    event: {
      ...recordValue(variables.event),
      title: event.title ?? undefined,
      startsAt: optionalIso(event.starts_at),
      endsAt: optionalIso(event.ends_at),
      timezone: event.timezone ?? undefined,
    },
    recipient: {
      ...recordValue(variables.recipient),
      name: attendeeName(attendee),
      email: attendee.email ?? undefined,
      phone: attendee.phone ?? undefined,
    },
    attendee: {
      ...recordValue(variables.attendee),
      name: attendeeName(attendee),
      checkedIn: attendee.status === 'checked_in',
    },
  };
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

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function optionalIso(value: unknown): string | undefined {
  if (!value) return undefined;
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'string') return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
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

function jobBelongsToCampaign(job: { idempotency_key?: unknown }, campaignId: string) {
  return typeof job.idempotency_key === 'string' && campaignKey(job.idempotency_key) === campaignId;
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
      const exclusionMetadata = campaignExclusionMetadata(jobs);
      const statuses = jobs.map((job) => String(job.status));
      const suppressedRecipients =
        exclusionMetadata.suppressedRecipients ??
        statuses.filter((status) => status === 'suppressed').length;
      const consentExclusions =
        exclusionMetadata.consentExclusions ??
        jobs.filter((job) => jobVariables(job).consentExcluded === true).length;
      const skippedRecipients = exclusionMetadata.skippedRecipients ?? 0;
      const emailQueued = group.emailJobs.filter((job) => job.status !== 'suppressed').length;
      const smsQueued = group.smsJobs.filter((job) => job.status !== 'suppressed').length;
      const emailTemplateKey = group.emailJobs
        .map((job) => String(job.template_key ?? ''))
        .find((key) => key.length > 0);
      const smsTemplateKey = group.smsJobs
        .map((job) => String(job.template_key ?? ''))
        .find((key) => key.length > 0);
      const templateKey =
        emailTemplateKey && smsTemplateKey && emailTemplateKey !== smsTemplateKey
          ? `${emailTemplateKey} + ${smsTemplateKey}`
          : (emailTemplateKey ??
            smsTemplateKey ??
            String(
              variables.campaignEmailTemplateKey ??
                variables.campaignSmsTemplateKey ??
                'message-campaign',
            ));
      const createdAt = jobs.reduce((earliest, job) => {
        const created = new Date(String(job.created_at)).getTime();
        return Number.isFinite(created) && created < earliest ? created : earliest;
      }, Number.POSITIVE_INFINITY);
      const updatedAt = jobs.reduce((latest, job) => {
        const updated = new Date(String(job.updated_at)).getTime();
        return Number.isFinite(updated) && updated > latest ? updated : latest;
      }, 0);
      const scheduledAt = jobs.reduce<number | undefined>((earliest, job) => {
        if (!job.scheduled_at) return earliest;
        const scheduled = new Date(String(job.scheduled_at)).getTime();
        if (!Number.isFinite(scheduled)) return earliest;
        return earliest === undefined || scheduled < earliest ? scheduled : earliest;
      }, undefined);

      return {
        id,
        eventId: input.eventId,
        tenantId: String(firstJob.tenant_id),
        brandId: String(firstJob.brand_id),
        templateKey,
        emailTemplateKey,
        smsTemplateKey,
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
        skippedRecipients,
        scheduledAt: scheduledAt === undefined ? undefined : new Date(scheduledAt).toISOString(),
        createdAt: toIso(Number.isFinite(createdAt) ? new Date(createdAt) : firstJob.created_at),
        updatedAt: toIso(updatedAt > 0 ? new Date(updatedAt) : firstJob.updated_at),
      };
    }),
    (summary) => summary.createdAt,
  );
}

function campaignExclusionMetadata(jobs: Array<Record<string, unknown>>) {
  const variablesByJob = jobs.map(jobVariables);
  const suppressedRecipients = variablesByJob
    .map((variables) => Number(variables.campaignSuppressedRecipients))
    .find((count) => Number.isInteger(count) && count >= 0);
  const consentExclusions = variablesByJob
    .map((variables) => Number(variables.campaignConsentExclusions))
    .find((count) => Number.isInteger(count) && count >= 0);
  const skippedRecipients = variablesByJob
    .map((variables) => Number(variables.campaignSkippedRecipients))
    .find((count) => Number.isInteger(count) && count >= 0);
  return { suppressedRecipients, consentExclusions, skippedRecipients };
}

function sortNewestFirst<T>(items: T[], createdAt: (item: T) => unknown) {
  // eslint-disable-next-line unicorn/no-array-sort -- sorting a copied response array preserves deterministic newest-first API output.
  return [...items].sort((a, b) => toIso(createdAt(b)).localeCompare(toIso(createdAt(a))));
}

function campaignStatus(statuses: string[]) {
  if (statuses.length === 0) return 'no_recipients';
  if (statuses.some((status) => status === 'failed' || status === 'start_failed')) return 'failed';
  if (statuses.every((status) => status === 'suppressed')) return 'suppressed';
  if (statuses.every((status) => status === 'sent')) return 'sent';
  if (statuses.some((status) => status === 'processing')) return 'processing';
  return 'queued';
}

export function selectCampaignProviderRoute<T extends { allowed_categories: unknown }>(
  routes: readonly T[],
  notificationType: string,
): T | undefined {
  return routes.find((candidate) =>
    safeJsonArray(candidate.allowed_categories).includes(notificationType),
  );
}

function safeJsonArray(value: unknown) {
  return safeArray(value).map(String);
}
