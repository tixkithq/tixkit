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
  bumpEventPublicRevision,
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
  PUCK_EVENT_PAGE_PROVIDER,
  normalizeEventPageDocumentV2,
  normalizeOrMigrateEventPageDocumentV2,
  resolveEventPageDocumentV2Discovery,
  validateEventPageDocumentV2,
  type EventPageDiscoveryCard,
  type EventPagePuckData,
  type EventPageRenderContext,
  type EventPageSettings,
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
import { ClerkAuthService } from '../../auth/clerk.js';
import {
  createPublicAvailabilityMetadataCache,
  loadPublicAvailability,
  loadPublicEventById,
  loadPublicMarketingIntegrations,
  loadPublicResaleListings,
  serializePublicEvent,
  type PublicEventRow,
} from './public.js';

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
    publishedAt?: string;
  };
  page: {
    provider: typeof PUCK_EVENT_PAGE_PROVIDER;
    puckData: EventPagePuckData;
    settings: EventPageSettings;
    discovery: EventPageDiscoveryCard;
  };
};

type PublicEventPageBootstrap = {
  event: ReturnType<typeof serializePublicEvent>;
  contentPage: PublicContentPage | null;
  availability: Awaited<ReturnType<typeof loadPublicAvailability>>;
  resaleListings: Awaited<ReturnType<typeof loadPublicResaleListings>>;
};

type PublicContentPageCacheEntry = {
  expiresAt: number;
  value: PublicContentPage;
};

type PublicContentPageCache = Map<string, PublicContentPageCacheEntry>;

type EventPagePreviewOutput = {
  provider: typeof PUCK_EVENT_PAGE_PROVIDER;
  puckData: EventPagePuckData;
  settings: EventPageSettings;
  discovery: EventPageDiscoveryCard;
};

type ContentPreviewOutput = RenderOutput | EventPagePreviewOutput;

const DEFAULT_PUBLIC_CONTENT_PAGE_CACHE_TTL_MS = 60_000;
const MAX_PUBLIC_CONTENT_PAGE_CACHE_TTL_MS = 300_000;
const MAX_PUBLIC_CONTENT_PAGE_CACHE_ENTRIES = 256;

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
    const document = normalizeEventPageDocumentV2(body.contentJson);
    if (!document) return invalidEventPageValidation();
    return validateEventPageDocumentV2(document);
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

function invalidEventPageValidation() {
  return {
    valid: false,
    severity: 'error' as const,
    issues: [
      {
        code: 'invalid_event_page_document',
        message: 'Event-page versions must store Tixkit Puck event-page JSON',
        severity: 'error' as const,
        field: 'contentJson',
      },
    ],
  };
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
): Promise<{
  output: ContentPreviewOutput;
  validation: ReturnType<typeof validateContentVersion>;
}> {
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
    const document = normalizeEventPageDocumentV2(content.contentJson);
    if (!document) {
      throw new ValidationError('Event-page preview requires Tixkit Puck event-page JSON', {
        code: 'invalid_event_page_document',
      });
    }
    return {
      output: {
        provider: PUCK_EVENT_PAGE_PROVIDER,
        puckData: document.editor.data,
        settings: document.settings,
        discovery: resolveEventPageDocumentV2Discovery(document, context as EventPageRenderContext),
      },
      validation: validateEventPageDocumentV2(document),
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

function checksumRenderOutput(output: ContentPreviewOutput): string {
  return createHash('sha256')
    .update(JSON.stringify(normalizeForChecksum(output)))
    .digest('hex');
}

function renderOutputForPersistence(output: ContentPreviewOutput): RenderOutput {
  return 'provider' in output ? {} : output;
}

function publicContentPageCacheTtlMs(): number {
  const raw = process.env.PUBLIC_CONTENT_PAGE_CACHE_TTL_MS;
  if (!raw) return DEFAULT_PUBLIC_CONTENT_PAGE_CACHE_TTL_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_PUBLIC_CONTENT_PAGE_CACHE_TTL_MS;
  return Math.min(Math.max(parsed, 0), MAX_PUBLIC_CONTENT_PAGE_CACHE_TTL_MS);
}

function clonePublicContentPage(value: PublicContentPage): PublicContentPage {
  return JSON.parse(JSON.stringify(value)) as PublicContentPage;
}

function publicContentPageCacheKey(input: {
  event: PublicEventRow;
  document: ContentDocument;
  version: ContentDocumentVersion;
  host?: string;
}): string {
  return JSON.stringify({
    eventId: input.event.id,
    publicRevision: input.event.public_revision ?? null,
    documentId: input.document.id,
    documentUpdatedAt: input.document.updatedAt,
    versionId: input.version.id,
    publishedAt: input.version.publishedAt ?? null,
    host: input.host ?? '',
  });
}

function readPublicContentPageCache(
  cache: PublicContentPageCache,
  key: string,
  now: number,
): PublicContentPage | undefined {
  const cached = cache.get(key);
  if (!cached) return undefined;
  if (cached.expiresAt <= now) {
    cache.delete(key);
    return undefined;
  }
  return clonePublicContentPage(cached.value);
}

function rememberPublicContentPage(
  cache: PublicContentPageCache,
  key: string,
  value: PublicContentPage,
  expiresAt: number,
): void {
  cache.set(key, { expiresAt, value: clonePublicContentPage(value) });
  while (cache.size > MAX_PUBLIC_CONTENT_PAGE_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (typeof oldestKey !== 'string') break;
    cache.delete(oldestKey);
  }
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
  const pageDocument = normalizeEventPageDocumentV2(input.version.contentJson);
  if (!pageDocument) {
    throw new ValidationError('Published event page is not a valid Puck event-page document', {
      code: 'invalid_event_page_document',
      eventId: input.document.eventId,
    });
  }
  const validation = validateEventPageDocumentV2(pageDocument);
  if (!validation.valid) {
    throw new ValidationError('Published event page has render blockers', {
      issues: validation.issues,
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
      publishedAt: input.version.publishedAt,
    },
    page: {
      provider: PUCK_EVENT_PAGE_PROVIDER,
      puckData: pageDocument.editor.data,
      settings: pageDocument.settings,
      discovery: resolveEventPageDocumentV2Discovery(pageDocument, input.context),
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
        : principal.type === 'system'
          ? undefined
          : principal.organizationIds,
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
    const eventPageDocument =
      document.channel === 'event_page'
        ? normalizeOrMigrateEventPageDocumentV2(body.contentJson)
        : undefined;
    if (document.channel === 'event_page' && !eventPageDocument) {
      throw new ValidationError('Event-page versions must store Tixkit Puck event-page JSON', {
        code: 'invalid_event_page_document',
      });
    }
    const contentJson = eventPageDocument ?? body.contentJson;
    const validation = validationFor(document.channel, { ...body, contentJson });
    const smsDocument =
      document.channel === 'sms' ? normalizeSmsTemplateDocument(body.contentJson) : undefined;
    const emailDocument =
      document.channel === 'email' ? normalizeEmailTemplateDocument(body.contentJson) : undefined;
    const renderedEmail = emailDocument ? await renderEmailTemplate(emailDocument, {}) : undefined;
    const version = await repo().createVersion({
      documentId,
      schemaVersion: eventPageDocument?.schemaVersion,
      subject: emailDocument ? emailDocument.settings.subject : body.subject,
      previewText: emailDocument ? emailDocument.settings.previewText : body.previewText,
      contentJson,
      renderedHtml: renderedEmail
        ? renderedEmail.html
        : document.channel === 'event_page'
          ? undefined
          : body.renderedHtml,
      renderedText: renderedEmail
        ? renderedEmail.text
        : smsDocument
          ? smsDocument.editor.body
          : document.channel === 'event_page'
            ? undefined
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
    const publishValidation =
      document.channel === 'event_page'
        ? (() => {
            const eventPageDocument = normalizeEventPageDocumentV2(version.contentJson);
            if (!eventPageDocument) {
              throw new ValidationError('Event-page publish requires Tixkit Puck event-page JSON', {
                code: 'invalid_event_page_document',
              });
            }
            return validateEventPageDocumentV2(eventPageDocument);
          })()
        : version.validation;
    if (!publishValidation.valid) {
      throw new ValidationError('Content version has publish blockers', {
        issues: publishValidation.issues,
      });
    }
    const published = await repo().publishVersion({ documentId, versionId });
    if (document.channel === 'event_page' && document.eventId) {
      await bumpEventPublicRevision(db, document.eventId);
    }
    return published;
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
    const outputForPersistence = renderOutputForPersistence(output);
    const send = await repo().recordTestSend({
      tenantId: principalTenant(request.principal!),
      documentId,
      versionId: version.id,
      channel: document.channel,
      recipient: body.recipient,
      status: 'captured',
      renderedSubject: outputForPersistence.subject,
      renderedHtml: outputForPersistence.html,
      renderedText: outputForPersistence.text,
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

  app.post('/content-documents/migrate-event-page-puck', async (request) => {
    const principal = request.principal!;
    requireContentPermission(principal, 'event_page', 'write');
    if (principal.type !== 'system' && principal.organizationIds.length === 0) {
      return {
        documentsScanned: 0,
        versionsChecked: 0,
        versionsMigrated: 0,
        migrated: [],
      };
    }

    const documents = await repo().listDocuments({
      tenantId: principal.tenantId,
      channel: 'event_page',
      organizationIds: principal.type === 'system' ? undefined : principal.organizationIds,
      brandIds: principal.brandIds,
      eventIds: principal.eventIds,
      limit: 1000,
    });

    let versionsChecked = 0;
    let versionsMigrated = 0;
    const migrated: { documentId: string; versionId: string; versionNumber: number }[] = [];

    for (const doc of documents) {
      const versions = await repo().listVersions(doc.id);
      for (const version of versions) {
        versionsChecked += 1;
        if (normalizeEventPageDocumentV2(version.contentJson)) continue;
        const normalized = normalizeOrMigrateEventPageDocumentV2(version.contentJson);
        if (!normalized) continue;
        const before = JSON.stringify(version.contentJson);
        const after = JSON.stringify(normalized);
        if (before === after) continue;

        const validation = validateEventPageDocumentV2(normalized);
        await repo().updateVersionContent({
          versionId: version.id,
          contentJson: normalized,
          schemaVersion: normalized.schemaVersion,
          renderedHtml: null,
          renderedText: null,
          validation,
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
  const availabilityMetadataCache = createPublicAvailabilityMetadataCache();
  const publicContentPageCache: PublicContentPageCache = new Map();

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
        publicUrl: publicEventUrl(event, host),
      },
      brand: brand
        ? {
            name: brand.name,
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
    return loadPublicPageForEvent(event, locale, host);
  }

  async function loadPublicPageForEvent(
    event: PublicEventRow,
    locale?: string,
    host?: string,
  ): Promise<PublicContentPage> {
    const result = await new ContentRepository(db).findPublishedEventPage({
      tenantId: event.tenant_id,
      eventId: event.id,
      locale,
    });
    if (!result) throw new NotFoundError('ContentDocument', event.id);
    const ttlMs = publicContentPageCacheTtlMs();
    const cacheKey =
      ttlMs > 0
        ? publicContentPageCacheKey({
            event,
            document: result.document,
            version: result.version,
            host,
          })
        : null;
    const now = Date.now();
    if (cacheKey) {
      const cached = readPublicContentPageCache(publicContentPageCache, cacheKey, now);
      if (cached) return cached;
    }
    const page = toPublicContentPage({ ...result, context: await contextForEvent(event, host) });
    if (cacheKey) rememberPublicContentPage(publicContentPageCache, cacheKey, page, now + ttlMs);
    return page;
  }

  async function loadOptionalPublicPage(
    event: PublicEventRow,
    locale?: string,
    host?: string,
  ): Promise<PublicContentPage | null> {
    try {
      return await loadPublicPageForEvent(event, locale, host);
    } catch (err) {
      if (err instanceof NotFoundError) return null;
      throw err;
    }
  }

  async function loadEventPageBootstrap(
    event: PublicEventRow,
    locale?: string,
    host?: string,
  ): Promise<PublicEventPageBootstrap> {
    const [marketingIntegrations, contentPage, availability, resaleListings] = await Promise.all([
      loadPublicMarketingIntegrations(db, event.id),
      loadOptionalPublicPage(event, locale, host),
      loadPublicAvailability(
        db,
        app.context.inventoryService,
        event.id,
        [],
        availabilityMetadataCache,
      ),
      loadPublicResaleListings(db, event, { limit: 50 }),
    ]);

    return {
      event: serializePublicEvent(event, marketingIntegrations),
      contentPage,
      availability,
      resaleListings,
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

  app.get('/public/events/:eventId/page-bootstrap', async (request) => {
    const { eventId } = request.params as { eventId: string };
    const { locale } = request.query as { locale?: string };
    const event = await loadPublicEventById(db, eventId);
    return loadEventPageBootstrap(event, locale);
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

  app.get('/public/events/by-slug/:slug/page-bootstrap', async (request) => {
    const { slug } = request.params as { slug: string };
    const query = request.query as { host?: unknown; locale?: string };
    const resolved = await resolveEventBySlug(slug, query.host);
    const event = await loadPublicEventById(db, resolved.id);
    return loadEventPageBootstrap(event, query.locale, resolved.host);
  });

  app.get('/public/events/:eventId/discovery-card', async (request) => {
    const { eventId } = request.params as { eventId: string };
    const { locale } = request.query as { locale?: string };
    return (await loadPublicPage(eventId, locale)).page.discovery;
  });
};
