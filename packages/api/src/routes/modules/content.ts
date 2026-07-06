import { createHash } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { ulid } from 'ulid';
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
  type ContentValidationResult,
  type RenderOutput,
} from '@tixkit/content-core';
import {
  BrandRepository,
  ContentRepository,
  EmailProviderRouteRepository,
  EventRepository,
  SmsProviderRouteRepository,
  SmsSenderIdentityRepository,
  TicketListingRepository,
  TicketTypeRepository,
  type Database,
} from '@tixkit/db';
import {
  NotFoundError,
  ValidationError,
  type EmailTransport,
  type Principal,
  type SmsTransport,
} from '@tixkit/domain';
import {
  normalizeEventPageDocument,
  renderEventPageDocument,
  renderResolvedEventPageHeadless,
  renderResolvedEventPageHtml,
  renderResolvedEventPageText,
  resolveEventPageDocument,
  validateEventPageDocument,
  type EventPageDiscoveryCard,
  type EventPageHeadlessBlock,
  type EventPageRenderContext,
  type ResolvedEventPage,
} from '@tixkit/content-event-page';
import {
  normalizeSmsTemplateDocument,
  createSmsTestSend,
  renderSmsTemplate,
  validateSmsTemplate,
  type RenderedSmsTemplate,
  type SmsTemplateDocument,
} from '@tixkit/content-message';
import {
  normalizeEmailTemplateDocument,
  createEmailTestSend,
  renderEmailTemplate,
  validateEmailTemplate,
  type EmailTemplateDocument,
  type RenderedEmailTemplate,
} from '@tixkit/content-email';
import { signPayload, verifySignature } from '@tixkit/shared';
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
    renderModel: ResolvedEventPage;
    discovery: EventPageDiscoveryCard;
  };
};

type DraftPreviewPage = {
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
    status: string;
    subject?: string;
    previewText?: string;
  };
  contentJson: unknown;
  context: EventPageRenderContext;
  renderModel: ResolvedEventPage;
  validation: ContentValidationResult;
};

type PreviewTokenPayload = {
  documentId: string;
  versionId: string;
  eventId: string;
  exp: number;
};

const PREVIEW_TOKEN_TTL_SECONDS = 900;

function previewTokenSecret(): string {
  const secret = process.env.TIXKIT_PREVIEW_TOKEN_SECRET?.trim();
  if (!secret) throw new Error('TIXKIT_PREVIEW_TOKEN_SECRET is not configured');
  return secret;
}

function mintPreviewToken(input: {
  documentId: string;
  versionId: string;
  eventId: string;
  ttlSeconds?: number;
}): { token: string; expiresAt: string } {
  const exp = Math.floor(Date.now() / 1000) + (input.ttlSeconds ?? PREVIEW_TOKEN_TTL_SECONDS);
  const payload: PreviewTokenPayload = {
    documentId: input.documentId,
    versionId: input.versionId,
    eventId: input.eventId,
    exp,
  };
  const payloadStr = JSON.stringify(payload);
  const signature = signPayload(payloadStr, previewTokenSecret());
  const token = `${Buffer.from(payloadStr).toString('base64url')}.${Buffer.from(signature).toString('base64url')}`;
  return { token, expiresAt: new Date(exp * 1000).toISOString() };
}

function verifyPreviewToken(token: string): PreviewTokenPayload | undefined {
  const parts = token.split('.');
  if (parts.length !== 2) return undefined;
  const [payloadB64, sigB64] = parts;
  let payloadStr: string;
  let signature: string;
  try {
    payloadStr = Buffer.from(payloadB64, 'base64url').toString('utf8');
    signature = Buffer.from(sigB64, 'base64url').toString('utf8');
  } catch {
    return undefined;
  }
  if (!verifySignature(payloadStr, signature, previewTokenSecret())) return undefined;
  let payload: PreviewTokenPayload;
  try {
    payload = JSON.parse(payloadStr) as PreviewTokenPayload;
  } catch {
    return undefined;
  }
  if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) {
    return undefined;
  }
  return payload;
}

const createDocumentSchema = z
  .object({
    organizationId: z.string().min(1),
    brandId: z.string().min(1),
    eventId: z.string().min(1).optional(),
    channel: contentChannelSchema,
    key: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9][a-z0-9._-]*$/),
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

const duplicateDocumentSchema = z
  .object({
    key: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9][a-z0-9._-]*$/)
      .optional(),
    name: z.string().min(1).max(160).optional(),
  })
  .strict();

const listDocumentsQuerySchema = z
  .object({
    channel: contentChannelSchema.optional(),
    organizationId: z.string().min(1).optional(),
    brandId: z.string().min(1).optional(),
    eventId: z.string().min(1).optional(),
    limit: z
      .string()
      .regex(/^[1-9]\d*$/)
      .transform(Number)
      .pipe(z.number().int().min(1).max(100))
      .optional(),
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

function parseQuery<T>(schema: z.ZodType<T>, query: unknown): T {
  const parsed = schema.safeParse(query);
  if (!parsed.success) {
    throw new ValidationError('Invalid content query', {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return parsed.data;
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
    ClerkAuthService.requirePermission(
      principal,
      operation === 'read' ? 'events.read' : 'events.write',
    );
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
  if (brand.organization_id !== input.organizationId)
    throw new NotFoundError('Brand', input.brandId);

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
  if (document.tenantId !== principal.tenantId)
    throw new NotFoundError('ContentDocument', documentId);
  requireContentPermission(principal, document.channel, operation);
  await authorizeScope(db, principal, {
    organizationId: document.organizationId,
    brandId: document.brandId,
    eventId: document.eventId,
  });
  return document;
}

type PreviewContent = {
  subject?: string;
  html?: string;
  text?: string;
  contentJson: unknown;
};

function contentFromVersion(version: ContentDocumentVersion): PreviewContent {
  return {
    subject: version.subject,
    html: version.renderedHtml,
    text: version.renderedText,
    contentJson: version.contentJson,
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
  if (channel === 'sms') {
    const document = normalizeSmsTemplateDocument(body.contentJson);
    if (!document) return invalidSmsTemplateValidation();
    return validateSmsTemplate(document);
  }
  if (channel === 'email') {
    const document = normalizeEmailTemplateDocument(body.contentJson);
    if (!document) return invalidEmailTemplateValidation();
    return validateEmailTemplate(document);
  }
  return validateContentVersion(
    {
      subject: body.subject,
      previewText: body.previewText,
      contentJson: body.contentJson,
      renderedHtml: body.renderedHtml,
      renderedText: body.renderedText,
    },
    channel,
  );
}

function invalidSmsTemplateValidation() {
  return {
    valid: false,
    severity: 'error' as const,
    issues: [
      {
        code: 'invalid_sms_template_document',
        message: 'SMS versions must store canonical Tixkit SMS template JSON',
        severity: 'error' as const,
        field: 'contentJson',
      },
    ],
  };
}

function invalidEmailTemplateValidation() {
  return {
    valid: false,
    severity: 'error' as const,
    issues: [
      {
        code: 'invalid_email_template_document',
        message: 'Email versions must store canonical Tixkit React Email template JSON',
        severity: 'error' as const,
        field: 'contentJson',
      },
    ],
  };
}

async function renderDocumentPreview(
  channel: ContentChannel,
  content: PreviewContent,
  context: Record<string, unknown>,
  optOutToken?: string,
): Promise<{ output: RenderOutput; validation: ReturnType<typeof validateContentVersion> }> {
  if (channel === 'email') {
    const document = normalizeEmailTemplateDocument(content.contentJson);
    if (!document) {
      throw new ValidationError('Email preview requires canonical React Email template JSON', {
        code: 'invalid_email_template_document',
      });
    }
    const rendered = await renderEmailTemplate(document, context);
    return {
      output: {
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      },
      validation: rendered.validation,
    };
  }
  if (channel === 'sms') {
    const document = normalizeSmsTemplateDocument(content.contentJson);
    if (!document) {
      throw new ValidationError('SMS preview requires canonical SMS template JSON', {
        code: 'invalid_sms_template_document',
      });
    }
    const rendered = renderSmsTemplate(document, context, { optOutToken });
    return {
      output: {
        text: rendered.text,
        segments: rendered.segments,
      },
      validation: rendered.validation,
    };
  }
  if (channel === 'event_page') {
    const document = normalizeEventPageDocument(content.contentJson);
    if (!document) {
      throw new ValidationError('Event-page preview requires canonical event-page JSON', {
        code: 'invalid_event_page_document',
      });
    }
    const rendered = renderEventPageDocument(document, context as EventPageRenderContext);
    return {
      output: {
        html: rendered.html,
        text: rendered.text,
      },
      validation: rendered.validation,
    };
  }
  const output = renderPreview(channel, RENDER_CONTRACTS[channel], content, context, optOutToken);
  const validation = validateContentVersion(
    {
      subject: content.subject,
      contentJson: content.contentJson,
      renderedHtml: content.html,
      renderedText: content.text,
    },
    channel,
  );
  return { output, validation };
}

type EmailProviderRouteRow = Awaited<
  ReturnType<EmailProviderRouteRepository['findActiveByBrand']>
>[number];
type SmsProviderRouteRow = Awaited<
  ReturnType<SmsProviderRouteRepository['findActiveByBrand']>
>[number];

function parseAllowedCategories(route: { allowed_categories: unknown }): string[] {
  if (Array.isArray(route.allowed_categories)) return route.allowed_categories as string[];
  if (typeof route.allowed_categories !== 'string') return [];
  try {
    const parsed = JSON.parse(route.allowed_categories);
    return Array.isArray(parsed) ? parsed.filter((value) => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

function selectEmailProviderRoute(
  routes: EmailProviderRouteRow[],
  category: EmailTemplateDocument['settings']['category'],
): EmailProviderRouteRow | undefined {
  return (
    [...routes]
      .filter((route) => parseAllowedCategories(route).includes(category))
      // eslint-disable-next-line unicorn/no-array-sort -- sorting a fresh copied array preserves provider priority without mutating repository output.
      .sort((left, right) => {
        if (left.is_fallback !== right.is_fallback) return left.is_fallback ? 1 : -1;
        return Number(left.priority) - Number(right.priority);
      })[0]
  );
}

function selectSmsProviderRoute(
  routes: SmsProviderRouteRow[],
  category: SmsTemplateDocument['settings']['category'],
): SmsProviderRouteRow | undefined {
  return (
    [...routes]
      .filter((route) => parseAllowedCategories(route).includes(category))
      // eslint-disable-next-line unicorn/no-array-sort -- sorting a fresh copied array preserves provider priority without mutating repository output.
      .sort((left, right) => {
        if (left.is_fallback !== right.is_fallback) return left.is_fallback ? 1 : -1;
        return Number(left.priority) - Number(right.priority);
      })[0]
  );
}

async function sendEmailTestThroughProvider(input: {
  db: Database;
  document: ContentDocument;
  version: ContentDocumentVersion;
  recipient: string;
  rendered: RenderedEmailTemplate;
  emailDocument: EmailTemplateDocument;
  transport: EmailTransport;
}): Promise<void> {
  const routes = await new EmailProviderRouteRepository(input.db).findActiveByBrand(
    input.document.brandId,
  );
  const route = selectEmailProviderRoute(routes, input.emailDocument.settings.category);
  if (!route) {
    throw new ValidationError('Email test send requires an active verified provider route', {
      code: 'email_provider_route_unavailable',
      brandId: input.document.brandId,
    });
  }

  const send = createEmailTestSend(input.emailDocument, input.rendered, {
    tenantId: input.document.tenantId,
    organizationId: input.document.organizationId,
    brandId: input.document.brandId,
    templateVersionId: input.version.id,
    providerRouteId: route.id,
    deliveryId: `cts_${ulid()}`,
    to: [{ email: input.recipient }],
    idempotencyKey: `content-test-send:${input.document.id}:${input.version.id}:${input.recipient}`,
    metadata: {
      notificationType: input.emailDocument.settings.category,
      eventId: input.document.eventId,
    },
  });
  const result = await input.transport.send(send);
  if (result.status === 'failed') {
    throw new ValidationError('Email test send provider rejected the message', {
      code: 'email_provider_send_failed',
      provider: result.provider,
    });
  }
}

async function sendSmsTestThroughProvider(input: {
  db: Database;
  document: ContentDocument;
  version: ContentDocumentVersion;
  recipient: string;
  rendered: RenderedSmsTemplate;
  smsDocument: SmsTemplateDocument;
  transport: SmsTransport;
}): Promise<void> {
  const routes = await new SmsProviderRouteRepository(input.db).findActiveByBrand(
    input.document.brandId,
  );
  const route = selectSmsProviderRoute(routes, input.smsDocument.settings.category);
  if (!route) {
    throw new ValidationError('SMS test send requires an active verified provider route', {
      code: 'sms_provider_route_unavailable',
      brandId: input.document.brandId,
    });
  }
  const senderIdentity = await new SmsSenderIdentityRepository(input.db).findById(
    route.sender_identity_id,
  );
  if (
    !senderIdentity ||
    !senderIdentity.verified ||
    senderIdentity.brand_id !== input.document.brandId
  ) {
    throw new ValidationError('SMS test send requires a verified sender identity', {
      code: 'sms_sender_identity_unavailable',
      brandId: input.document.brandId,
    });
  }

  const send = createSmsTestSend(input.smsDocument, input.rendered, {
    tenantId: input.document.tenantId,
    organizationId: input.document.organizationId,
    brandId: input.document.brandId,
    jobId: `ctsms_${ulid()}`,
    templateVersionId: input.version.id,
    providerRouteId: route.id,
    deliveryId: `cts_${ulid()}`,
    from: senderIdentity.sender,
    to: input.recipient,
    idempotencyKey: `content-test-send:${input.document.id}:${input.version.id}:${input.recipient}`,
    metadata: input.document.eventId ? { eventId: input.document.eventId } : undefined,
  });
  const result = await input.transport.send(send);
  if (result.status === 'failed') {
    throw new ValidationError('SMS test send provider rejected the message', {
      code: 'sms_provider_send_failed',
      provider: result.provider,
    });
  }
}

function normalizeForChecksum(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeForChecksum(item));
  }
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    const keys: string[] = [];
    for (const key of Object.keys(object)) {
      const index = keys.findIndex((candidate) => key.localeCompare(candidate) < 0);
      if (index === -1) {
        keys.push(key);
      } else {
        keys.splice(index, 0, key);
      }
    }
    return Object.fromEntries(keys.map((key) => [key, normalizeForChecksum(object[key])]));
  }
  return value;
}

function checksumRenderOutput(output: RenderOutput): string {
  return createHash('sha256')
    .update(JSON.stringify(normalizeForChecksum(output)))
    .digest('hex');
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
  const renderModel = resolveEventPageDocument(pageDocument, input.context);
  if (!renderModel.validation.valid) {
    throw new ValidationError('Published event page has render blockers', {
      issues: renderModel.validation.issues,
      eventId: input.document.eventId,
    });
  }

  const html = renderResolvedEventPageHtml(renderModel);
  const text = renderResolvedEventPageText(renderModel);

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
      renderedHtml: html,
      renderedText: text,
      publishedAt: input.version.publishedAt,
    },
    page: {
      html,
      text,
      headless: renderResolvedEventPageHeadless(renderModel),
      renderModel,
      discovery: renderModel.discovery,
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

function publicEventUrl(event: { id: string; slug?: string | null }, host?: string): string {
  if (host && event.slug) return `https://${host}/${encodeURIComponent(event.slug)}`;
  const base = process.env.PUBLIC_CHECKOUT_URL?.trim() || process.env.CHECKOUT_PUBLIC_URL?.trim();
  if (!base) return `https://checkout.tixkit.com/e/${encodeURIComponent(event.id)}`;
  try {
    return new URL(`/e/${encodeURIComponent(event.id)}`, base).toString();
  } catch {
    return `https://checkout.tixkit.com/e/${encodeURIComponent(event.id)}`;
  }
}

function checkoutUrl(eventId: string, host?: string): string {
  if (host) return `https://${host}/checkout?eventId=${encodeURIComponent(eventId)}`;
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

function priceLabel(row: {
  kind: string;
  price_cents: unknown;
  minimum_price_cents?: unknown;
  currency: string;
}): string {
  if (row.kind === 'free') return 'Free';
  const cents =
    row.kind === 'donation' && row.minimum_price_cents != null
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
    const query = parseQuery(listDocumentsQuerySchema, request.query);
    const channel = query.channel;
    requireContentListPermission(principal, channel);
    if (query.organizationId)
      ClerkAuthService.requireOrganizationScope(principal, query.organizationId);
    if (query.brandId) ClerkAuthService.requireBrandScope(principal, query.brandId);
    if (query.eventId) ClerkAuthService.requireEventScope(principal, query.eventId);
    if (principal.type !== 'system' && principal.organizationIds.length === 0) {
      return { items: [] };
    }
    const documents = await repo().listDocuments({
      tenantId: principal.tenantId,
      organizationIds: query.organizationId
        ? [query.organizationId]
        : (principal.type === 'system' ? undefined : principal.organizationIds),
      brandIds: principal.brandIds,
      eventIds: principal.eventIds,
      channel,
      brandId: query.brandId,
      eventId: query.eventId,
      limit: query.limit ?? 50,
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

  app.post('/content-documents/:documentId/duplicate', async (request, reply) => {
    const { documentId } = request.params as { documentId: string };
    const document = await loadAuthorizedDocument(
      repo(),
      db,
      request.principal!,
      documentId,
      'write',
    );
    assertChannelAvailable(document.channel);
    const body = parseBody(duplicateDocumentSchema, request.body ?? {});
    const duplicated = await repo().duplicateDocument({
      documentId,
      tenantId: request.principal!.tenantId,
      key: body.key,
      name: body.name,
      createdBy: request.principal!.id,
    });
    return reply.status(201).send(duplicated);
  });

  app.get('/content-documents/:documentId/versions', async (request) => {
    const { documentId } = request.params as { documentId: string };
    await loadAuthorizedDocument(repo(), db, request.principal!, documentId, 'read');
    return { items: await repo().listVersions(documentId) };
  });

  app.post('/content-documents/:documentId/versions', async (request, reply) => {
    const { documentId } = request.params as { documentId: string };
    const document = await loadAuthorizedDocument(
      repo(),
      db,
      request.principal!,
      documentId,
      'write',
    );
    assertChannelAvailable(document.channel);
    const body = parseBody(saveVersionSchema, request.body);
    const validation = validationFor(document.channel, body);
    const smsDocument =
      document.channel === 'sms' ? normalizeSmsTemplateDocument(body.contentJson) : undefined;
    const emailDocument =
      document.channel === 'email' ? normalizeEmailTemplateDocument(body.contentJson) : undefined;
    const eventPageDocument =
      document.channel === 'event_page' ? normalizeEventPageDocument(body.contentJson) : undefined;
    const renderedEmail = emailDocument ? await renderEmailTemplate(emailDocument, {}) : undefined;
    const renderedEventPage = eventPageDocument
      ? renderEventPageDocument(eventPageDocument, {} as EventPageRenderContext)
      : undefined;
    const version = await repo().createVersion({
      documentId,
      subject: emailDocument ? emailDocument.settings.subject : body.subject,
      previewText: emailDocument ? emailDocument.settings.previewText : body.previewText,
      contentJson: body.contentJson,
      renderedHtml: renderedEmail
        ? renderedEmail.html
        : renderedEventPage
          ? renderedEventPage.html
          : body.renderedHtml,
      renderedText: renderedEmail
        ? renderedEmail.text
        : smsDocument
          ? smsDocument.editor.body
          : renderedEventPage
            ? renderedEventPage.text
            : body.renderedText,
      variables: variableDefinitionsForChannel(document.channel),
      validation,
      createdBy: request.principal!.id,
    });
    return reply.status(201).send(version);
  });

  app.post('/content-documents/:documentId/preview', async (request) => {
    const { documentId } = request.params as { documentId: string };
    const document = await loadAuthorizedDocument(
      repo(),
      db,
      request.principal!,
      documentId,
      'read',
    );
    assertChannelAvailable(document.channel);
    const body = parseBody(previewSchema, request.body);
    const version = body.versionId ? await repo().findVersionById(body.versionId) : undefined;
    if (body.versionId && (!version || version.documentId !== documentId)) {
      throw new NotFoundError('ContentDocumentVersion', body.versionId);
    }
    const content = version
      ? contentFromVersion(version)
      : {
          subject: body.subject,
          html: body.renderedHtml,
          text: body.renderedText,
          contentJson: body.contentJson,
        };
    const { output, validation } = await renderDocumentPreview(
      document.channel,
      content,
      body.context,
      body.optOutToken,
    );
    if (!version) return { channel: document.channel, output, validation };
    const checksum = checksumRenderOutput(output);
    const renderArtifact = await repo().recordRenderArtifact({
      tenantId: principalTenant(request.principal!),
      documentId,
      versionId: version.id,
      channel: document.channel,
      outputType: 'preview',
      artifactRef: `content-preview:${documentId}:${version.id}:${checksum}`,
      checksum,
    });
    return { channel: document.channel, output, validation, renderArtifact };
  });

  app.post('/content-documents/:documentId/preview-token', async (request) => {
    const { documentId } = request.params as { documentId: string };
    const document = await loadAuthorizedDocument(
      repo(),
      db,
      request.principal!,
      documentId,
      'read',
    );
    if (document.channel !== 'event_page' || !document.eventId) {
      throw new NotFoundError('ContentDocument', documentId);
    }
    const body = parseBody(
      z.object({ versionId: z.string().min(1).optional() }).strict(),
      request.body,
    );
    let versionId = body.versionId;
    if (!versionId) {
      if (document.currentDraftVersionId) {
        versionId = document.currentDraftVersionId;
      } else {
        const versions = await repo().listVersions(documentId);
        const latest = versions.find((v) => v.status === 'draft') ?? versions[0];
        if (!latest) throw new NotFoundError('ContentDocumentVersion', documentId);
        versionId = latest.id;
      }
    } else {
      const version = await repo().findVersionById(versionId);
      if (!version || version.documentId !== documentId) {
        throw new NotFoundError('ContentDocumentVersion', versionId);
      }
    }
    const { token, expiresAt } = mintPreviewToken({
      documentId,
      versionId,
      eventId: document.eventId,
    });
    const baseUrl =
      process.env.PUBLIC_CHECKOUT_URL?.trim() ||
      process.env.CHECKOUT_PUBLIC_URL?.trim() ||
      'https://checkout.tixkit.com';
    const url = new URL(`/e/${encodeURIComponent(document.eventId)}`, baseUrl);
    url.searchParams.set('token', token);
    url.searchParams.set('edit', '1');
    return { token, url: url.toString(), expiresAt, versionId };
  });

  app.post('/content-documents/:documentId/versions/:versionId/publish', async (request) => {
    const { documentId, versionId } = request.params as { documentId: string; versionId: string };
    const document = await loadAuthorizedDocument(
      repo(),
      db,
      request.principal!,
      documentId,
      'write',
    );
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
    const document = await loadAuthorizedDocument(
      repo(),
      db,
      request.principal!,
      documentId,
      'write',
    );
    assertChannelAvailable(document.channel);
    const body = parseBody(testSendSchema, request.body);
    const version = await repo().findVersionById(body.versionId);
    if (!version || version.documentId !== documentId) {
      throw new NotFoundError('ContentDocumentVersion', body.versionId);
    }
    const content = contentFromVersion(version);
    const { output, validation } = await renderDocumentPreview(
      document.channel,
      content,
      body.context,
      body.optOutToken,
    );
    if ((document.channel === 'sms' || document.channel === 'email') && !validation.valid) {
      throw new ValidationError(
        `${document.channel === 'sms' ? 'SMS' : 'Email'} test send has render blockers`,
        {
          issues: validation.issues,
        },
      );
    }
    if (document.channel === 'email') {
      const emailDocument = normalizeEmailTemplateDocument(content.contentJson);
      if (!emailDocument) {
        throw new ValidationError('Email test send requires canonical React Email template JSON', {
          code: 'invalid_email_template_document',
        });
      }
      const rendered = await renderEmailTemplate(emailDocument, body.context);
      await sendEmailTestThroughProvider({
        db,
        document,
        version,
        recipient: body.recipient,
        rendered,
        emailDocument,
        transport: app.context.emailTransport,
      });
    }
    if (document.channel === 'sms') {
      const smsDocument = normalizeSmsTemplateDocument(content.contentJson);
      if (!smsDocument) {
        throw new ValidationError('SMS test send requires canonical SMS template JSON', {
          code: 'invalid_sms_template_document',
        });
      }
      const rendered = renderSmsTemplate(smsDocument, body.context, {
        optOutToken: body.optOutToken,
      });
      await sendSmsTestThroughProvider({
        db,
        document,
        version,
        recipient: body.recipient,
        rendered,
        smsDocument,
        transport: app.context.smsTransport,
      });
    }
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
    const checksum = checksumRenderOutput(output);
    const renderArtifact = await repo().recordRenderArtifact({
      tenantId: principalTenant(request.principal!),
      documentId,
      versionId: version.id,
      channel: document.channel,
      outputType: 'test_send',
      artifactRef: `content-test-send:${send.id}`,
      checksum,
    });
    return reply.status(202).send({ testSend: send, output, renderArtifact });
  });

  app.post('/content-documents/migrate-event-page-chrome', async (request) => {
    const principal = request.principal!;
    requireContentListPermission(principal, 'event_page');

    const documents = await repo().listDocuments({
      tenantId: principal.tenantId,
      channel: 'event_page',
      organizationIds:
        principal.type === 'system' ? undefined : principal.organizationIds,
      limit: 1000,
    });

    let versionsChecked = 0;
    let versionsMigrated = 0;
    const migrated: { documentId: string; versionId: string; versionNumber: number }[] = [];

    for (const doc of documents) {
      const versions = await repo().listVersions(doc.id);
      for (const version of versions) {
        versionsChecked += 1;
        const normalized = normalizeEventPageDocument(version.contentJson);
        if (!normalized) continue;
        const before = JSON.stringify(version.contentJson);
        const after = JSON.stringify(normalized);
        if (before === after) continue;

        await repo().updateVersionContent({
          versionId: version.id,
          contentJson: normalized,
        });
        versionsMigrated += 1;
        migrated.push({
          documentId: doc.id,
          versionId: version.id,
          versionNumber: version.versionNumber,
        });
      }
    }

    return {
      documentsScanned: documents.length,
      versionsChecked,
      versionsMigrated,
      migrated,
    };
  });
};

function principalTenant(principal: Principal): string {
  return principal.tenantId;
}

export const publicContentRoutes: FastifyPluginAsync = async (app) => {
  const db = app.context.db;

  async function contextForEvent(
    event: {
      id: string;
      slug?: string | null;
      title: string;
      description?: string | null;
      starts_at?: Date | string | null;
      ends_at?: Date | string | null;
      timezone?: string | null;
      venue?: unknown;
      brand_id?: string | null;
      tenant_id?: string;
    },
    host?: string,
  ): Promise<EventPageRenderContext> {
    const venue = venueContext(event.venue);
    const tickets = await new TicketTypeRepository(db).findPublicByEvent(event.id);
    const brand = event.brand_id
      ? await new BrandRepository(db).findById(event.brand_id)
      : undefined;
    const legalUrls = brand ? parseJsonValue<Record<string, unknown>>(brand.legal_urls, {}) : {};
    const resaleListings = event.tenant_id
      ? await new TicketListingRepository(db).findPublicAvailableByEvent({
          tenantId: event.tenant_id,
          eventId: event.id,
          limit: 50,
        })
      : [];
    return {
      event: {
        title: event.title,
        description: event.description ?? undefined,
        startsAt: event.starts_at ? new Date(event.starts_at).toISOString() : undefined,
        endsAt: event.ends_at ? new Date(event.ends_at).toISOString() : undefined,
        timezone: event.timezone ?? undefined,
        venueName: venue.name,
        venueCity: venue.city,
        publicUrl: publicEventUrl(event, host),
        checkoutUrl: checkoutUrl(event.id, host),
      },
      brand: brand
        ? {
            name: brand.name,
            supportUrl: brand.support_url ?? undefined,
            termsUrl: typeof legalUrls.terms === 'string' ? legalUrls.terms : undefined,
            privacyUrl: typeof legalUrls.privacy === 'string' ? legalUrls.privacy : undefined,
            refundUrl:
              typeof legalUrls.refundPolicy === 'string' ? legalUrls.refundPolicy : undefined,
          }
        : undefined,
      tickets: tickets.map((ticket) => ({
        id: ticket.id,
        name: ticket.name,
        description: ticket.description ?? undefined,
        status: ticket.status === 'sold_out' ? 'sold_out' : 'active',
        priceLabel: priceLabel(ticket),
      })),
      resaleListings: resaleListings.map((listing) => ({
        id: listing.id,
        priceLabel: new Intl.NumberFormat('en-US', {
          style: 'currency',
          currency: listing.currency,
        }).format(Number(listing.price_cents) / 100),
        expiresAt: listing.expires_at ? new Date(listing.expires_at).toISOString() : undefined,
      })),
    };
  }

  async function loadPublicPage(
    eventId: string,
    locale?: string,
    host?: string,
  ): Promise<PublicContentPage> {
    const event = await new EventRepository(db).findById(eventId);
    if (!event || !isPubliclyReadableEvent(event)) throw new NotFoundError('Event', eventId);
    const result = await new ContentRepository(db).findPublishedEventPage({
      tenantId: event.tenant_id,
      eventId,
      locale,
    });
    if (!result) throw new NotFoundError('ContentDocument', eventId);
    return toPublicContentPage({ ...result, context: await contextForEvent(event, host) });
  }

  async function loadDraftPreview(
    eventId: string,
    token: string,
    host?: string,
  ): Promise<DraftPreviewPage> {
    const payload = verifyPreviewToken(token);
    if (!payload || payload.eventId !== eventId) throw new NotFoundError('Event', eventId);
    const event = await new EventRepository(db).findById(eventId);
    if (!event) throw new NotFoundError('Event', eventId);
    const contentRepo = new ContentRepository(db);
    const version = await contentRepo.findVersionById(payload.versionId);
    if (!version) throw new NotFoundError('ContentDocumentVersion', payload.versionId);
    const document = await contentRepo.findDocumentById(version.documentId);
    if (
      !document ||
      document.channel !== 'event_page' ||
      document.eventId !== eventId ||
      document.id !== payload.documentId ||
      document.tenantId !== event.tenant_id
    ) {
      throw new NotFoundError('ContentDocument', eventId);
    }
    const pageDocument = normalizeEventPageDocument(version.contentJson);
    if (!pageDocument) {
      throw new ValidationError('Draft preview requires canonical event-page JSON', {
        code: 'invalid_event_page_document',
        eventId,
      });
    }
    const context = await contextForEvent(event, host);
    const renderModel = resolveEventPageDocument(pageDocument, context);
    return {
      document: {
        eventId: document.eventId!,
        channel: 'event_page',
        key: document.key,
        name: document.name,
        locale: document.locale,
        updatedAt: document.updatedAt,
      },
      version: {
        versionNumber: version.versionNumber,
        status: version.status,
        subject: version.subject,
        previewText: version.previewText,
      },
      contentJson: pageDocument,
      context,
      renderModel,
      validation: renderModel.validation,
    };
  }

  async function resolveEventBySlug(
    slug: string,
    host: unknown,
  ): Promise<{ id: string; host: string }> {
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
    const event = await new EventRepository(db).findByBrandSlug(
      brandDomain.brand_id as string,
      slug,
    );
    if (!event || !isPubliclyReadableEvent(event)) throw new NotFoundError('Event', slug);
    const tenant = await db
      .selectFrom('tenants')
      .selectAll()
      .where('id', '=', event.tenant_id)
      .executeTakeFirst();
    if (!tenant || tenant.plan === 'free') throw new NotFoundError('Event', slug);
    return { id: event.id, host: normalizedHost };
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
    const event = await resolveEventBySlug(slug, query.host);
    return loadPublicPage(event.id, query.locale, event.host);
  });

  app.get('/public/events/:eventId/discovery-card', async (request) => {
    const { eventId } = request.params as { eventId: string };
    const { locale } = request.query as { locale?: string };
    return (await loadPublicPage(eventId, locale)).page.discovery;
  });

  app.get('/public/events/:eventId/draft-preview', async (request) => {
    const { eventId } = request.params as { eventId: string };
    const query = request.query as { token?: unknown; host?: unknown };
    const token = firstQueryParam(query.token);
    if (!token) throw new NotFoundError('Event', eventId);
    const host = normalizeHost(query.host);
    return loadDraftPreview(eventId, token, host);
  });
};
