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
  TicketTypeRepository,
  type Database,
} from '@tixkit/db';
import { NotFoundError, ValidationError, type Principal } from '@tixkit/domain';
import {
  normalizeEventPageDocument,
  renderEventPageDocument,
  validateEventPageDocument,
  type EventPageDiscoveryCard,
  type EventPageHeadlessBlock,
  type EventPageRenderContext,
} from '@tixkit/content-event-page';
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
  page: {
    html: string;
    text: string;
    headless: EventPageHeadlessBlock[];
    discovery: EventPageDiscoveryCard;
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
  if (channel === 'event_page') {
    const document = normalizeEventPageDocument(body.contentJson);
    if (!document) {
      return {
        valid: false,
        severity: 'error' as const,
        issues: [
          {
            code: 'invalid_event_page_document',
            message: 'Event-page versions must store canonical TipTap event-page JSON',
            severity: 'error' as const,
            field: 'contentJson',
          },
        ],
      };
    }
    return validateEventPageDocument(document);
  }
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
  context: EventPageRenderContext;
}): PublicContentPage {
  if (
    input.document.channel !== 'event_page' ||
    !input.document.eventId ||
    input.version.documentId !== input.document.id
  ) {
    throw new NotFoundError('ContentDocument', input.document.eventId ?? input.document.id);
  }
  const pageDocument = normalizeEventPageDocument(input.version.contentJson);
  if (!pageDocument) {
    throw new ValidationError('Published event page is not a valid event-page document', {
      code: 'invalid_event_page_document',
      eventId: input.document.eventId,
    });
  }
  const rendered = renderEventPageDocument(pageDocument, input.context);
  if (!rendered.validation.valid) {
    throw new ValidationError('Published event page has render blockers', {
      issues: rendered.validation.issues,
      eventId: input.document.eventId,
    });
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
      renderedHtml: rendered.html,
      renderedText: rendered.text,
      publishedAt: input.version.publishedAt,
    },
    page: {
      html: rendered.html,
      text: rendered.text,
      headless: rendered.headless,
      discovery: rendered.discovery,
    },
  };
}

function firstQueryParam(value: unknown): string {
  return Array.isArray(value) ? String(value[0] ?? '') : typeof value === 'string' ? value : '';
}

function normalizeHost(value: unknown): string {
  const host = firstQueryParam(value).trim();
  if (!host) return '';
  if (host.includes('://') || /[\s,/?#]/.test(host)) return '';
  try {
    const url = new URL(`https://${host}`);
    if (
      url.port ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      return '';
    }
    return url.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return '';
  }
}

function boolValue(value: unknown): boolean {
  return value === true || value === 1;
}

function parseJsonValue<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function isPubliclyReadableEvent(event: { status: string; visibility?: string | null }): boolean {
  return event.status === 'published' && event.visibility !== 'private';
}

function publicEventUrl(eventId: string): string {
  const base = process.env.PUBLIC_CHECKOUT_URL?.trim() || process.env.CHECKOUT_PUBLIC_URL?.trim();
  if (!base) return `https://checkout.tixkit.com/e/${encodeURIComponent(eventId)}`;
  try {
    return new URL(`/e/${encodeURIComponent(eventId)}`, base).toString();
  } catch {
    return `https://checkout.tixkit.com/e/${encodeURIComponent(eventId)}`;
  }
}

function checkoutUrl(eventId: string): string {
  const base = process.env.PUBLIC_CHECKOUT_URL?.trim() || process.env.CHECKOUT_PUBLIC_URL?.trim();
  if (!base) return `https://checkout.tixkit.com/checkout?eventId=${encodeURIComponent(eventId)}`;
  try {
    const url = new URL('/checkout', base);
    url.searchParams.set('eventId', eventId);
    return url.toString();
  } catch {
    return `https://checkout.tixkit.com/checkout?eventId=${encodeURIComponent(eventId)}`;
  }
}

function venueContext(value: unknown): { name?: string; city?: string } {
  const venue = parseJsonValue<Record<string, unknown> | null>(value, null);
  if (!venue) return {};
  return {
    name: typeof venue.name === 'string' ? venue.name : undefined,
    city: typeof venue.city === 'string' ? venue.city : undefined,
  };
}

function priceLabel(row: { kind: string; price_cents: unknown; minimum_price_cents?: unknown; currency: string }): string {
  if (row.kind === 'free') return 'Free';
  const cents = row.kind === 'donation' && row.minimum_price_cents != null
    ? Number(row.minimum_price_cents)
    : Number(row.price_cents);
  const formatted = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: row.currency,
  }).format(cents / 100);
  return row.kind === 'donation' ? `From ${formatted}` : formatted;
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

  async function contextForEvent(event: {
    id: string;
    title: string;
    starts_at?: Date | string | null;
    ends_at?: Date | string | null;
    timezone?: string | null;
    venue?: unknown;
  }): Promise<EventPageRenderContext> {
    const venue = venueContext(event.venue);
    const tickets = await new TicketTypeRepository(db).findPublicByEvent(event.id);
    return {
      event: {
        title: event.title,
        startsAt: event.starts_at ? new Date(event.starts_at).toISOString() : undefined,
        endsAt: event.ends_at ? new Date(event.ends_at).toISOString() : undefined,
        timezone: event.timezone ?? undefined,
        venueName: venue.name,
        venueCity: venue.city,
        publicUrl: publicEventUrl(event.id),
        checkoutUrl: checkoutUrl(event.id),
      },
      tickets: tickets.map((ticket) => ({
        id: ticket.id,
        name: ticket.name,
        description: ticket.description ?? undefined,
        status: ticket.status === 'sold_out' ? 'sold_out' : 'active',
        priceLabel: priceLabel(ticket),
      })),
    };
  }

  async function loadPublicPage(eventId: string, locale?: string): Promise<PublicContentPage> {
    const event = await new EventRepository(db).findById(eventId);
    if (!event || !isPubliclyReadableEvent(event)) throw new NotFoundError('Event', eventId);
    const result = await new ContentRepository(db).findPublishedEventPage({
      tenantId: event.tenant_id,
      eventId,
      locale,
    });
    if (!result) throw new NotFoundError('ContentDocument', eventId);
    return toPublicContentPage({ ...result, context: await contextForEvent(event) });
  }

  async function resolveEventIdBySlug(slug: string, host: unknown): Promise<string> {
    const normalizedHost = normalizeHost(host);
    if (!normalizedHost) throw new NotFoundError('Event', slug);
    const brandDomain = await db
      .selectFrom('brand_domains')
      .selectAll()
      .where('domain', '=', normalizedHost)
      .where('is_verified', '=', true)
      .where('ssl_status', '=', 'active')
      .executeTakeFirst();
    if (
      !brandDomain ||
      !boolValue(brandDomain.is_verified) ||
      brandDomain.ssl_status !== 'active'
    ) {
      throw new NotFoundError('Event', slug);
    }
    const brand = await db
      .selectFrom('brands')
      .selectAll()
      .where('id', '=', brandDomain.brand_id)
      .executeTakeFirst();
    if (!brand || !boolValue(brand.white_label)) throw new NotFoundError('Event', slug);
    const event = await new EventRepository(db).findByBrandSlug(brandDomain.brand_id as string, slug);
    if (!event || !isPubliclyReadableEvent(event)) throw new NotFoundError('Event', slug);
    const tenant = await db
      .selectFrom('tenants')
      .selectAll()
      .where('id', '=', event.tenant_id)
      .executeTakeFirst();
    if (!tenant || tenant.plan === 'free') throw new NotFoundError('Event', slug);
    return event.id;
  }

  app.get('/public/events/:eventId/page', async (request) => {
    const { eventId } = request.params as { eventId: string };
    const { locale } = request.query as { locale?: string };
    return loadPublicPage(eventId, locale);
  });

  app.get('/public/events/:eventId/content-page', async (request) => {
    const { eventId } = request.params as { eventId: string };
    const { locale } = request.query as { locale?: string };
    return loadPublicPage(eventId, locale);
  });

  app.get('/public/events/by-slug/:slug/page', async (request) => {
    const { slug } = request.params as { slug: string };
    const query = request.query as { host?: unknown; locale?: string };
    const eventId = await resolveEventIdBySlug(slug, query.host);
    return loadPublicPage(eventId, query.locale);
  });

  app.get('/public/events/:eventId/discovery-card', async (request) => {
    const { eventId } = request.params as { eventId: string };
    const { locale } = request.query as { locale?: string };
    return (await loadPublicPage(eventId, locale)).page.discovery;
  });
};
