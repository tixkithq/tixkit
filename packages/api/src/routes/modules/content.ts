import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  createDefaultChannelRegistry,
  renderPreview,
  validateContentVersion,
  variableDefinitionsForChannel,
  RENDER_CONTRACTS,
  type ContentChannel,
  type ContentDocument,
  type ContentDocumentVersion,
  type RenderOutput,
} from '@tixkit/content-core';
import {
  BrandRepository,
  ContentRepository,
  EventRepository,
  type Database,
} from '@tixkit/db';
import { NotFoundError, ValidationError, type Principal } from '@tixkit/domain';
import { ClerkAuthService } from '../../auth/clerk.js';

const contentChannelSchema = z.enum(['event_page', 'email', 'sms', 'imessage', 'social_invite']);

type PublicContentPage = {
  document: {
    eventId: string;
    channel: 'event_page';
    key: string;
    name: string;
    locale: string;
    updatedAt: string;
  };
  version: {
    versionNumber: number;
    subject?: string;
    previewText?: string;
    renderedHtml?: string;
    renderedText?: string;
    publishedAt?: string;
  };
};

const createDocumentSchema = z
  .object({
    organizationId: z.string().min(1),
    brandId: z.string().min(1),
    eventId: z.string().min(1).optional(),
    channel: contentChannelSchema,
    key: z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9._-]*$/),
    name: z.string().min(1).max(160),
    locale: z.string().min(2).max(16).default('en'),
  })
  .strict();

const saveVersionSchema = z
  .object({
    subject: z.string().max(256).optional(),
    previewText: z.string().max(512).optional(),
    contentJson: z.unknown().default({}),
    renderedHtml: z.string().optional(),
    renderedText: z.string().optional(),
  })
  .strict();

const previewSchema = saveVersionSchema
  .extend({
    versionId: z.string().min(1).optional(),
    context: z.record(z.string(), z.unknown()).default({}),
    optOutToken: z.string().optional(),
  })
  .strict();

const testSendSchema = z
  .object({
    versionId: z.string().min(1),
    recipient: z.string().min(1).max(256),
    context: z.record(z.string(), z.unknown()).default({}),
    optOutToken: z.string().optional(),
  })
  .strict();

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError('Invalid content request', {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}

function parseChannel(value: unknown): ContentChannel | undefined {
  const parsed = contentChannelSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function assertChannelAvailable(channel: ContentChannel): void {
  try {
    createDefaultChannelRegistry().assertAvailable(channel);
  } catch {
    throw new ValidationError(`Content channel is unavailable: ${channel}`, {
      channel,
      code: 'channel_unavailable',
    });
  }
}

function requireContentPermission(
  principal: Principal,
  channel: ContentChannel,
  operation: 'read' | 'write',
): void {
  if (channel === 'event_page') {
    ClerkAuthService.requirePermission(principal, operation === 'read' ? 'events.read' : 'events.write');
    return;
  }
  ClerkAuthService.requirePermission(principal, 'messages.write');
}

function requireContentListPermission(principal: Principal, channel?: ContentChannel): void {
  if (channel) {
    requireContentPermission(principal, channel, 'read');
    return;
  }

  ClerkAuthService.requirePermission(principal, 'events.read');
  ClerkAuthService.requirePermission(principal, 'messages.write');
}

async function authorizeScope(
  db: Database,
  principal: Principal,
  input: { organizationId: string; brandId: string; eventId?: string | null },
): Promise<void> {
  ClerkAuthService.requireOrganizationScope(principal, input.organizationId);
  ClerkAuthService.requireBrandScope(principal, input.brandId);
  const brand = await new BrandRepository(db).findById(input.brandId);
  if (!brand) throw new NotFoundError('Brand', input.brandId);
  ClerkAuthService.requireResourceTenant(principal, brand, 'Brand', input.brandId);
  if (brand.organization_id !== input.organizationId) throw new NotFoundError('Brand', input.brandId);

  if (!input.eventId) return;
  ClerkAuthService.requireEventScope(principal, input.eventId);
  const event = await new EventRepository(db).findById(input.eventId);
  if (!event) throw new NotFoundError('Event', input.eventId);
  ClerkAuthService.requireResourceTenant(principal, event, 'Event', input.eventId);
  if (event.organization_id !== input.organizationId || event.brand_id !== input.brandId) {
    throw new NotFoundError('Event', input.eventId);
  }
}

async function loadAuthorizedDocument(
  repo: ContentRepository,
  db: Database,
  principal: Principal,
  documentId: string,
  operation: 'read' | 'write',
): Promise<ContentDocument> {
  const document = await repo.findDocumentById(documentId);
  if (!document) throw new NotFoundError('ContentDocument', documentId);
  if (document.tenantId !== principal.tenantId) throw new NotFoundError('ContentDocument', documentId);
  requireContentPermission(principal, document.channel, operation);
  await authorizeScope(db, principal, {
    organizationId: document.organizationId,
    brandId: document.brandId,
    eventId: document.eventId,
  });
  return document;
}

function contentFromVersion(version: ContentDocumentVersion) {
  return {
    subject: version.subject,
    html: version.renderedHtml,
    text: version.renderedText,
  };
}

function validationFor(channel: ContentChannel, body: z.infer<typeof saveVersionSchema>) {
  const preview =
    channel === 'sms' && body.renderedText
      ? renderPreview(channel, RENDER_CONTRACTS[channel], { text: body.renderedText }, {})
      : undefined;
  return validateContentVersion(
    {
      subject: body.subject,
      previewText: body.previewText,
      contentJson: body.contentJson,
      renderedHtml: body.renderedHtml,
      renderedText: body.renderedText,
    },
    channel,
    { smsSegmentCount: preview?.segments },
  );
}

function renderDocumentPreview(
  channel: ContentChannel,
  content: { subject?: string; html?: string; text?: string },
  context: Record<string, unknown>,
  optOutToken?: string,
): RenderOutput {
  return renderPreview(channel, RENDER_CONTRACTS[channel], content, context, optOutToken);
}

function toPublicContentPage(input: {
  document: ContentDocument;
  version: ContentDocumentVersion;
}): PublicContentPage {
  if (
    input.document.channel !== 'event_page' ||
    !input.document.eventId ||
    input.version.documentId !== input.document.id
  ) {
    throw new NotFoundError('ContentDocument', input.document.eventId ?? input.document.id);
  }

  return {
    document: {
      eventId: input.document.eventId,
      channel: 'event_page',
      key: input.document.key,
      name: input.document.name,
      locale: input.document.locale,
      updatedAt: input.document.updatedAt,
    },
    version: {
      versionNumber: input.version.versionNumber,
      subject: input.version.subject,
      previewText: input.version.previewText,
      renderedHtml: input.version.renderedHtml,
      renderedText: input.version.renderedText,
      publishedAt: input.version.publishedAt,
    },
  };
}

export const contentRoutes: FastifyPluginAsync = async (app) => {
  const db = app.context.db;
  const repo = () => new ContentRepository(db);

  app.get('/content-documents', async (request) => {
    const principal = request.principal!;
    const query = request.query as {
      channel?: string;
      brandId?: string;
      eventId?: string;
      limit?: string;
    };
    const channel = parseChannel(query.channel);
    if (query.channel && !channel) throw new ValidationError('Invalid content channel');
    requireContentListPermission(principal, channel);
    if (query.brandId) ClerkAuthService.requireBrandScope(principal, query.brandId);
    if (query.eventId) ClerkAuthService.requireEventScope(principal, query.eventId);
    if (principal.type !== 'system' && principal.organizationIds.length === 0) {
      return { items: [] };
    }
    const documents = await repo().listDocuments({
      tenantId: principal.tenantId,
      organizationIds: principal.type === 'system' ? undefined : principal.organizationIds,
      brandIds: principal.brandIds,
      eventIds: principal.eventIds,
      channel,
      brandId: query.brandId,
      eventId: query.eventId,
      limit: query.limit ? Number(query.limit) : 50,
    });
    return { items: documents };
  });

  app.post('/content-documents', async (request, reply) => {
    const principal = request.principal!;
    const body = parseBody(createDocumentSchema, request.body);
    assertChannelAvailable(body.channel);
    requireContentPermission(principal, body.channel, 'write');
    await authorizeScope(db, principal, body);
    const created = await repo().createDocument({
      tenantId: principal.tenantId,
      organizationId: body.organizationId,
      brandId: body.brandId,
      eventId: body.eventId,
      channel: body.channel,
      key: body.key,
      name: body.name,
      locale: body.locale,
    });
    return reply.status(201).send(created);
  });

  app.get('/content-documents/:documentId', async (request) => {
    const { documentId } = request.params as { documentId: string };
    return loadAuthorizedDocument(repo(), db, request.principal!, documentId, 'read');
  });

  app.get('/content-documents/:documentId/versions', async (request) => {
    const { documentId } = request.params as { documentId: string };
    await loadAuthorizedDocument(repo(), db, request.principal!, documentId, 'read');
    return { items: await repo().listVersions(documentId) };
  });

  app.post('/content-documents/:documentId/versions', async (request, reply) => {
    const { documentId } = request.params as { documentId: string };
    const document = await loadAuthorizedDocument(repo(), db, request.principal!, documentId, 'write');
    assertChannelAvailable(document.channel);
    const body = parseBody(saveVersionSchema, request.body);
    const validation = validationFor(document.channel, body);
    const version = await repo().createVersion({
      documentId,
      subject: body.subject,
      previewText: body.previewText,
      contentJson: body.contentJson,
      renderedHtml: body.renderedHtml,
      renderedText: body.renderedText,
      variables: variableDefinitionsForChannel(document.channel),
      validation,
      createdBy: request.principal!.id,
    });
    return reply.status(201).send(version);
  });

  app.post('/content-documents/:documentId/preview', async (request) => {
    const { documentId } = request.params as { documentId: string };
    const document = await loadAuthorizedDocument(repo(), db, request.principal!, documentId, 'read');
    assertChannelAvailable(document.channel);
    const body = parseBody(previewSchema, request.body);
    const version = body.versionId ? await repo().findVersionById(body.versionId) : undefined;
    if (body.versionId && (!version || version.documentId !== documentId)) {
      throw new NotFoundError('ContentDocumentVersion', body.versionId);
    }
    const content = version
      ? contentFromVersion(version)
      : { subject: body.subject, html: body.renderedHtml, text: body.renderedText };
    const output = renderDocumentPreview(document.channel, content, body.context, body.optOutToken);
    const validation = validateContentVersion(
      {
        subject: content.subject,
        contentJson: version?.contentJson ?? body.contentJson,
        renderedHtml: content.html,
        renderedText: content.text,
      },
      document.channel,
      { smsSegmentCount: output.segments },
    );
    return { channel: document.channel, output, validation };
  });

  app.post('/content-documents/:documentId/versions/:versionId/publish', async (request) => {
    const { documentId, versionId } = request.params as { documentId: string; versionId: string };
    const document = await loadAuthorizedDocument(repo(), db, request.principal!, documentId, 'write');
    assertChannelAvailable(document.channel);
    const version = await repo().findVersionById(versionId);
    if (!version || version.documentId !== documentId) {
      throw new NotFoundError('ContentDocumentVersion', versionId);
    }
    if (!version.validation.valid) {
      throw new ValidationError('Content version has publish blockers', {
        issues: version.validation.issues,
      });
    }
    return repo().publishVersion({ documentId, versionId });
  });

  app.post('/content-documents/:documentId/archive', async (request) => {
    const { documentId } = request.params as { documentId: string };
    await loadAuthorizedDocument(repo(), db, request.principal!, documentId, 'write');
    return repo().archiveDocument(documentId);
  });

  app.post('/content-documents/:documentId/test-sends', async (request, reply) => {
    const { documentId } = request.params as { documentId: string };
    const document = await loadAuthorizedDocument(repo(), db, request.principal!, documentId, 'write');
    assertChannelAvailable(document.channel);
    const body = parseBody(testSendSchema, request.body);
    const version = await repo().findVersionById(body.versionId);
    if (!version || version.documentId !== documentId) {
      throw new NotFoundError('ContentDocumentVersion', body.versionId);
    }
    const output = renderDocumentPreview(
      document.channel,
      contentFromVersion(version),
      body.context,
      body.optOutToken,
    );
    const send = await repo().recordTestSend({
      tenantId: principalTenant(request.principal!),
      documentId,
      versionId: version.id,
      channel: document.channel,
      recipient: body.recipient,
      status: 'captured',
      renderedSubject: output.subject,
      renderedHtml: output.html,
      renderedText: output.text,
    });
    return reply.status(202).send({ testSend: send, output });
  });
};

function principalTenant(principal: Principal): string {
  return principal.tenantId;
}

export const publicContentRoutes: FastifyPluginAsync = async (app) => {
  const db = app.context.db;

  app.get('/public/events/:eventId/content-page', async (request) => {
    const { eventId } = request.params as { eventId: string };
    const { locale } = request.query as { locale?: string };
    const event = await new EventRepository(db).findById(eventId);
    if (!event || event.status !== 'published') throw new NotFoundError('Event', eventId);
    const result = await new ContentRepository(db).findPublishedEventPage({
      tenantId: event.tenant_id,
      eventId,
      locale,
    });
    if (!result) throw new NotFoundError('ContentDocument', eventId);
    return toPublicContentPage(result);
  });
};
