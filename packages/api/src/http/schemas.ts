import { z } from 'zod';
import { ValidationError, WEBHOOK_EVENT_TYPES } from '@tixkit/domain';

// Reusable primitives
const ulidSchema = z.string().min(1);
const currencySchema = z.string().length(3);
const iso8601Schema = z.string().datetime();
export const MAX_OFFLINE_SYNC_SCANS = 100_000;
export const OFFLINE_SYNC_JSON_BODY_LIMIT_BYTES = 32 * 1024 * 1024;
export const MAX_BULK_OFFLINE_SYNC_CHUNKS = 1_000;
export const MAX_BULK_OFFLINE_SYNC_CHUNK_SCANS = 50_000;
export const MAX_BULK_OFFLINE_SYNC_TOTAL_SCANS = 250_000;
export const MAX_MESSAGE_TEMPLATE_KEY_LENGTH = 128;
export const MAX_MESSAGE_VARIABLES_BYTES = 16 * 1024;
export const MAX_MESSAGE_VARIABLE_DEPTH = 6;
export const MAX_MESSAGE_TEMPLATE_SUBJECT_LENGTH = 500;
export const MAX_MESSAGE_TEMPLATE_HTML_LENGTH = 50_000;
export const MAX_MESSAGE_TEMPLATE_TEXT_LENGTH = 5_000;
export const MAX_MESSAGE_OPT_OUT_TOKEN_LENGTH = 256;
const eventSlugSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must be URL-safe lowercase text');
const hostnameLabelSchema = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const urlSchema = z
  .string()
  .url()
  .refine(
    (val) => {
      try {
        const url = new URL(val);
        return url.protocol === 'https:' || url.protocol === 'http:';
      } catch {
        return false;
      }
    },
    {
      message:
        'URL must use http or https scheme; javascript:, data:, and file: schemes are not allowed',
    },
  );
const brandLegalUrlsSchema = z
  .object({
    terms: urlSchema.optional(),
    privacy: urlSchema.optional(),
    refundPolicy: urlSchema.optional(),
  })
  .strict();

function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function jsonDepth(value: unknown): number {
  if (value === null || typeof value !== 'object') return 0;
  if (Array.isArray(value)) {
    return value.length === 0 ? 1 : 1 + Math.max(...value.map((item) => jsonDepth(item)));
  }
  const entries = Object.values(value as Record<string, unknown>);
  return entries.length === 0 ? 1 : 1 + Math.max(...entries.map((item) => jsonDepth(item)));
}

const messageTemplateKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_MESSAGE_TEMPLATE_KEY_LENGTH)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
    'Template keys may contain only letters, numbers, dots, underscores, colons, and hyphens',
  );

const boundedMessageRecordSchema = z
  .record(z.string().min(1).max(128), z.unknown())
  .refine((value) => jsonByteLength(value) <= MAX_MESSAGE_VARIABLES_BYTES, {
    message: `Message variables must be ${MAX_MESSAGE_VARIABLES_BYTES} bytes or smaller`,
  })
  .refine((value) => jsonDepth(value) <= MAX_MESSAGE_VARIABLE_DEPTH, {
    message: `Message variables may be nested at most ${MAX_MESSAGE_VARIABLE_DEPTH} levels`,
  });

function isDevelopmentLike(): boolean {
  return process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
}

function isLocalhost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '[::1]'
  );
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map((part) => Number(part));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }

  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    isLocalhost(host) ||
    isPrivateIpv4(host) ||
    host === '::1' ||
    host.startsWith('fc') ||
    host.startsWith('fd') ||
    host.startsWith('fe80') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    !host.includes('.')
  );
}

function normalizeCustomDomain(value: string): string | null {
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed.includes('://') ||
    /[\s,/?#:[\]]/.test(trimmed) ||
    trimmed.startsWith('.') ||
    trimmed.includes('..')
  ) {
    return null;
  }

  const hostname = trimmed.toLowerCase().replace(/\.$/, '');
  const labels = hostname.split('.');
  if (labels.length < 2 || labels.some((label) => !hostnameLabelSchema.test(label))) {
    return null;
  }
  if (isPrivateHostname(hostname)) return null;
  return hostname;
}

const customDomainSchema = z.string().transform((value, ctx) => {
  const normalized = normalizeCustomDomain(value);
  if (!normalized) {
    ctx.addIssue({
      code: 'custom',
      message: 'Domain must be a public hostname without scheme, port, path, query, or fragment',
    });
    return z.NEVER;
  }
  return normalized;
});

const webhookUrlSchema = z
  .string()
  .url()
  .refine(
    (val) => {
      try {
        const url = new URL(val);
        return url.protocol === 'https:' && !isPrivateHostname(url.hostname);
      } catch {
        return false;
      }
    },
    {
      message:
        'Webhook URL must use https and must not target localhost, private, or internal hosts',
    },
  );

export const oauthRedirectUrlSchema = z
  .string()
  .url()
  .refine(
    (val) => {
      try {
        const url = new URL(val);
        if (url.protocol === 'https:') return true;
        return isDevelopmentLike() && url.protocol === 'http:' && isLocalhost(url.hostname);
      } catch {
        return false;
      }
    },
    { message: 'OAuth redirect URI must use https, except localhost http in development/test' },
  );

/**
 * Validates that a URL uses an allowed scheme (https in production, http in dev).
 * Rejects javascript:, data:, file: schemes.
 */
export function safeRedirectUrl(devMode: boolean): z.ZodString {
  return z.string().refine(
    (val) => {
      try {
        const url = new URL(val);
        if (url.protocol === 'https:') return true;
        if (devMode && url.protocol === 'http:' && isLocalhost(url.hostname)) return true;
        return false;
      } catch {
        return false;
      }
    },
    {
      message:
        'URL must use https scheme (or http in development); javascript:, data:, and file: schemes are not allowed',
    },
  );
}

// Checkout schemas
export const createCheckoutSessionSchema = (devMode: boolean) =>
  z
    .object({
      eventId: ulidSchema,
      items: z
        .array(
          z
            .object({
              ticketTypeId: ulidSchema.optional(),
              occurrenceId: ulidSchema.optional(),
              productId: ulidSchema.optional(),
              resaleListingId: ulidSchema.optional(),
              quantity: z.number().int().min(1),
              unitAmountCents: z.number().int().min(0).optional(),
              attendeeFields: z.array(z.record(z.string(), z.unknown())).optional(),
            })
            .refine(
              (item) =>
                [item.ticketTypeId, item.productId, item.resaleListingId].filter(Boolean).length ===
                1,
              {
                message:
                  'Each checkout item must include exactly one of ticketTypeId, productId, or resaleListingId',
              },
            )
            .refine((item) => Boolean(item.ticketTypeId) || item.unitAmountCents === undefined, {
              message: 'unitAmountCents is only accepted for ticket items',
            })
            .refine((item) => Boolean(item.ticketTypeId) || item.attendeeFields === undefined, {
              message: 'attendeeFields are only accepted for ticket items',
            })
            .refine((item) => Boolean(item.ticketTypeId) || item.occurrenceId === undefined, {
              message: 'occurrenceId is only accepted for ticket items',
            })
            .refine((item) => !item.resaleListingId || item.quantity === 1, {
              message: 'Resale listing checkout items must have quantity 1',
            }),
        )
        .min(1),
      discountCode: z.string().optional(),
      affiliateCode: z.string().optional(),
      trackingId: z.string().optional(),
      accessCode: z.string().optional(),
      waitlistClaimToken: z.string().min(16).optional(),
      buyer: z
        .object({
          email: z.string().email().optional(),
          firstName: z.string().optional(),
          lastName: z.string().optional(),
          phone: z.string().optional(),
        })
        .optional(),
      buyerFields: z.record(z.string(), z.unknown()).optional(),
      successUrl: safeRedirectUrl(devMode).optional(),
      cancelUrl: safeRedirectUrl(devMode).optional(),
    })
    .strict();

export const updateCheckoutSessionSchema = (devMode: boolean) =>
  z
    .object({
      buyer: z
        .object({
          email: z.string().email().optional(),
          firstName: z.string().optional(),
          lastName: z.string().optional(),
          phone: z.string().optional(),
        })
        .optional(),
      successUrl: safeRedirectUrl(devMode).optional(),
      cancelUrl: safeRedirectUrl(devMode).optional(),
    })
    .strict();

export const confirmCheckoutSchema = z
  .object({
    paymentMethodId: z.string().optional(),
  })
  .strict();

export const createBoxOfficeOrderSchema = z
  .object({
    tenderType: z.enum(['comp', 'cash', 'manual_card']),
    amountCents: z.number().int().min(0),
    items: z
      .array(
        z
          .object({
            ticketTypeId: ulidSchema,
            occurrenceId: ulidSchema.optional(),
            quantity: z.number().int().min(1),
            attendeeFields: z.array(z.record(z.string(), z.unknown())).optional(),
          })
          .strict(),
      )
      .min(1),
    buyer: z
      .object({
        email: z.string().email().optional(),
        firstName: z.string().optional(),
        lastName: z.string().optional(),
        phone: z.string().optional(),
      })
      .optional(),
    buyerFields: z.record(z.string(), z.unknown()).optional(),
    notes: z.string().max(2000).optional(),
  })
  .strict();

// Order/refund schemas
export const refundSchema = z
  .object({
    amountCents: z.number().int().positive().optional(),
    reason: z.string().min(1),
    voidTickets: z.boolean().optional(),
    restoreInventory: z.boolean().optional(),
  })
  .strict();

// Event schemas
export const createEventSchema = z
  .object({
    organizationId: ulidSchema,
    brandId: ulidSchema,
    slug: eventSlugSchema,
    title: z.string().min(1),
    description: z.string().optional(),
    currency: currencySchema,
    timezone: z.string().min(1),
    startsAt: iso8601Schema,
    endsAt: iso8601Schema.optional(),
    venue: z.record(z.string(), z.unknown()).optional(),
    visibility: z.enum(['public', 'unlisted', 'private']).optional(),
    seo: z.record(z.string(), z.unknown()).optional(),
    capacity: z.number().int().positive().optional(),
    coverImageUrl: urlSchema.optional(),
    externalUrl: urlSchema.optional(),
  })
  .strict();

export const updateEventSchema = z
  .object({
    title: z.string().min(1).optional(),
    slug: eventSlugSchema.optional(),
    description: z.string().optional(),
    currency: currencySchema.optional(),
    timezone: z.string().min(1).optional(),
    startsAt: iso8601Schema.optional(),
    endsAt: iso8601Schema.nullable().optional(),
    venue: z.record(z.string(), z.unknown()).nullable().optional(),
    visibility: z.enum(['public', 'unlisted', 'private']).optional(),
    seo: z.record(z.string(), z.unknown()).optional(),
    capacity: z.number().int().positive().nullable().optional(),
    coverImageUrl: urlSchema.nullable().optional(),
    externalUrl: urlSchema.nullable().optional(),
    status: z.enum(['draft', 'published', 'paused', 'archived']).optional(),
  })
  .strict();

export const createEventOccurrenceSchema = z
  .object({
    title: z.string().min(1),
    startsAt: iso8601Schema,
    endsAt: iso8601Schema,
    timezone: z.string().min(1),
    venue: z.record(z.string(), z.unknown()).nullable().optional(),
    capacity: z.number().int().positive().nullable().optional(),
    sortOrder: z.number().int().min(0).optional(),
    status: z.enum(['scheduled', 'cancelled', 'completed']).optional(),
  })
  .strict();

export const updateEventOccurrenceSchema = createEventOccurrenceSchema.partial().strict();

// Tenant schemas
const boxOfficeTenderTypes = ['cash', 'manual_card', 'comp'] as const;
const boxOfficeReceiptModes = ['print', 'email', 'both'] as const;
const defaultBoxOfficeSettings = {
  enabled: true,
  allowedTenderTypes: [...boxOfficeTenderTypes],
  requireBuyerEmail: false,
  receiptMode: 'email' as const,
};

export const boxOfficeSettingsSchema = z
  .object({
    enabled: z.boolean(),
    allowedTenderTypes: z
      .array(z.enum(boxOfficeTenderTypes))
      .min(1)
      .max(boxOfficeTenderTypes.length)
      .refine((values) => new Set(values).size === values.length, {
        message: 'Box-office tender types must be unique',
      }),
    requireBuyerEmail: z.boolean(),
    receiptMode: z.enum(boxOfficeReceiptModes),
  })
  .strict();

export const createOrganizationSchema = z
  .object({
    name: z.string().trim().min(1),
    slug: z.string().trim().min(1),
    clerkOrganizationId: z.string().optional(),
    boxOfficeSettings: boxOfficeSettingsSchema.optional().default(defaultBoxOfficeSettings),
  })
  .strict();

export const updateOrganizationSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    slug: z.string().trim().min(1).optional(),
    clerkOrganizationId: z.string().nullable().optional(),
    boxOfficeSettings: boxOfficeSettingsSchema.optional(),
  })
  .strict();

export const createOrganizationInvitationSchema = z
  .object({
    email: z.string().trim().toLowerCase().email(),
    role: z.enum(['admin', 'organizer', 'viewer']).optional().default('viewer'),
  })
  .strict();

export const createBrandSchema = z
  .object({
    organizationId: ulidSchema,
    name: z.string().trim().min(1),
    slug: z.string().trim().min(1),
    theme: z.record(z.string(), z.unknown()).optional(),
    whiteLabel: z.boolean().optional(),
  })
  .strict();

export const updateBrandSchema = z
  .object({
    name: z.string().min(1).optional(),
    slug: z.string().min(1).optional(),
    status: z.enum(['draft', 'active', 'suspended']).optional(),
    theme: z.record(z.string(), z.unknown()).optional(),
    supportUrl: urlSchema.optional(),
    legalUrls: brandLegalUrlsSchema.optional(),
    whiteLabel: z.boolean().optional(),
    paymentAccountId: ulidSchema.nullable().optional(),
  })
  .strict();

export const addBrandDomainSchema = z
  .object({
    domain: customDomainSchema,
    isPrimary: z.boolean().optional(),
  })
  .strict();

// Ticketing schemas
export const createTicketTypeSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    kind: z.enum(['free', 'paid', 'donation']),
    visibility: z.enum(['public', 'hidden', 'locked']).optional(),
    currency: currencySchema,
    priceCents: z.number().int().min(0),
    minimumPriceCents: z.number().int().min(0).nullable().optional(),
    salesStartAt: iso8601Schema.optional(),
    salesEndAt: iso8601Schema.optional(),
    minPerOrder: z.number().int().min(1).optional(),
    maxPerOrder: z.number().int().min(1).optional(),
    inventoryPoolId: ulidSchema,
    eventOccurrenceId: ulidSchema.nullable().optional(),
    requiresAccessCode: z.boolean().optional(),
    accessCodeHint: z.string().nullable().optional(),
  })
  .strict();

export const updateTicketTypeSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    kind: z.enum(['free', 'paid', 'donation']).optional(),
    status: z.enum(['draft', 'active', 'paused', 'sold_out', 'ended']).optional(),
    visibility: z.enum(['public', 'hidden', 'locked']).optional(),
    currency: currencySchema.optional(),
    priceCents: z.number().int().min(0).optional(),
    minimumPriceCents: z.number().int().min(0).nullable().optional(),
    salesStartAt: iso8601Schema.nullable().optional(),
    salesEndAt: iso8601Schema.nullable().optional(),
    minPerOrder: z.number().int().min(1).optional(),
    maxPerOrder: z.number().int().min(1).optional(),
    inventoryPoolId: ulidSchema.optional(),
    eventOccurrenceId: ulidSchema.nullable().optional(),
    requiresAccessCode: z.boolean().optional(),
    accessCodeHint: z.string().nullable().optional(),
    sortOrder: z.number().int().optional(),
  })
  .strict();

export const createAccessRuleSchema = z
  .object({
    type: z.enum(['code', 'email_domain']),
    value: z.string().min(1),
    maxUses: z.number().int().positive().nullable().optional(),
    expiresAt: iso8601Schema.nullable().optional(),
  })
  .strict();

export const createInventoryPoolSchema = z
  .object({
    name: z.string().min(1),
    totalCapacity: z.number().int().min(1),
    holdTtlSeconds: z.number().int().min(1).optional(),
  })
  .strict();

export const createTicketTypeBatchSchema = z
  .object({
    ticketType: createTicketTypeSchema.omit({ inventoryPoolId: true }).extend({
      inventoryPoolId: ulidSchema.optional(),
    }),
    inventoryPool: createInventoryPoolSchema.optional(),
    accessRules: z.array(createAccessRuleSchema).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (!data.ticketType.inventoryPoolId && !data.inventoryPool) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['inventoryPoolId'],
        message: 'Provide inventoryPoolId or inventoryPool',
      });
    }
  });

export const updateTicketTypeBatchSchema = z
  .object({
    ticketType: updateTicketTypeSchema,
    accessRules: z.array(createAccessRuleSchema).optional(),
  })
  .strict();

export const createProductCategorySchema = z
  .object({
    name: z.string().min(1),
    sortOrder: z.number().int().optional(),
  })
  .strict();

export const createProductSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    priceCents: z.number().int().min(0),
    currency: currencySchema,
    categoryId: ulidSchema.optional(),
    maxPerOrder: z.number().int().min(1).optional(),
    availableFrom: iso8601Schema.optional(),
    availableUntil: iso8601Schema.optional(),
    status: z.enum(['active', 'inactive']).optional(),
    sortOrder: z.number().int().optional(),
  })
  .strict();

export const updateProductSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    priceCents: z.number().int().min(0).optional(),
    currency: currencySchema.optional(),
    categoryId: ulidSchema.nullable().optional(),
    maxPerOrder: z.number().int().min(1).optional(),
    availableFrom: iso8601Schema.nullable().optional(),
    availableUntil: iso8601Schema.nullable().optional(),
    status: z.enum(['active', 'inactive']).optional(),
    sortOrder: z.number().int().optional(),
  })
  .strict();

// Developer schemas
export const createApiKeySchema = z
  .object({
    organizationId: ulidSchema,
    name: z.string().min(1),
    scopes: z.array(z.string().min(1)),
    brandIds: z.array(ulidSchema).optional(),
    eventIds: z.array(ulidSchema).optional(),
    expiresAt: iso8601Schema.optional(),
  })
  .strict();

export const createScannerDeviceSchema = z
  .object({
    organizationId: ulidSchema,
    name: z.string().min(1),
    eventIds: z.array(ulidSchema).optional(),
    scopes: z
      .array(z.enum(['checkins.read', 'checkins.write']))
      .min(1)
      .optional(),
  })
  .strict();

// Webhook schemas
const webhookEventTypeSchema = z.enum(WEBHOOK_EVENT_TYPES);
const webhookEndpointEventsSchema = z
  .array(webhookEventTypeSchema)
  .min(1)
  .max(WEBHOOK_EVENT_TYPES.length)
  .superRefine((events, ctx) => {
    const seen = new Set<string>();
    events.forEach((event, index) => {
      if (seen.has(event)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message: 'Webhook endpoint events must be unique',
        });
      }
      seen.add(event);
    });
  });

export const createWebhookEndpointSchema = z
  .object({
    organizationId: ulidSchema,
    url: webhookUrlSchema,
    events: webhookEndpointEventsSchema,
    description: z.string().optional(),
  })
  .strict();

export const updateWebhookEndpointSchema = z
  .object({
    url: webhookUrlSchema.optional(),
    events: webhookEndpointEventsSchema.optional(),
    status: z.enum(['active', 'disabled']).optional(),
    description: z.string().nullable().optional(),
  })
  .strict();

// Messaging schema
export const sendMessageSchema = z
  .object({
    eventId: ulidSchema.optional(),
    emailTemplateKey: messageTemplateKeySchema.optional(),
    smsTemplateKey: messageTemplateKeySchema.optional(),
    audience: z.enum(['all', 'checked_in', 'not_checked_in', 'specific']),
    attendeeIds: z.array(ulidSchema).max(5_000).optional(),
    variables: boundedMessageRecordSchema.optional(),
    channel: z.enum(['email', 'sms', 'both']),
  })
  .strict();

export const renderMessagePreviewSchema = z
  .object({
    channel: z.enum(['email', 'sms']).optional(),
    subjectTemplate: z.string().max(MAX_MESSAGE_TEMPLATE_SUBJECT_LENGTH).optional(),
    htmlTemplate: z.string().max(MAX_MESSAGE_TEMPLATE_HTML_LENGTH).optional(),
    textTemplate: z.string().max(MAX_MESSAGE_TEMPLATE_TEXT_LENGTH).optional(),
    context: boundedMessageRecordSchema.optional(),
    optOutToken: z.string().max(MAX_MESSAGE_OPT_OUT_TOKEN_LENGTH).optional(),
  })
  .strict();

// Check-in schemas
export const scanSchema = z
  .object({
    checkInListId: ulidSchema,
    qrPayload: z.string().min(1),
    scannedAt: iso8601Schema,
    offline: z.boolean().optional(),
    deviceId: z.string().optional(),
  })
  .strict();

export const syncScanSchema = z
  .object({
    checkInListId: ulidSchema,
    deviceId: z.string().optional(),
    scans: z
      .array(
        z.object({
          qrHash: z.string().min(1),
          scannedAt: iso8601Schema,
          offline: z.boolean(),
        }),
      )
      .max(MAX_OFFLINE_SYNC_SCANS),
  })
  .strict();

export const createBulkSyncJobSchema = z
  .object({
    checkInListId: ulidSchema,
    deviceId: z.string().optional(),
    totalChunks: z.number().int().min(1).max(MAX_BULK_OFFLINE_SYNC_CHUNKS),
    totalScans: z.number().int().min(1).max(MAX_BULK_OFFLINE_SYNC_TOTAL_SCANS).optional(),
  })
  .strict();

export const bulkSyncChunkSchema = z
  .object({
    scans: z
      .array(
        z.object({
          qrHash: z.string().min(1),
          scannedAt: iso8601Schema,
          offline: z.boolean(),
        }),
      )
      .min(1)
      .max(MAX_BULK_OFFLINE_SYNC_CHUNK_SCANS),
  })
  .strict();

export const updateAttendeeSchema = z
  .object({
    firstName: z.string().nullable().optional(),
    lastName: z.string().nullable().optional(),
    email: z.string().email().optional(),
    phone: z.string().nullable().optional(),
    status: z.enum(['pending', 'confirmed', 'cancelled', 'refunded', 'checked_in']).optional(),
  })
  .strict();

// Transfer schema
export const transferTicketSchema = z
  .object({
    toEmail: z.string().email(),
  })
  .strict();

export const resalePolicySchema = z
  .object({
    enabled: z.boolean(),
    maxMultiplier: z.number().finite().min(0),
    maxAbsoluteCents: z.number().int().nonnegative().nullable().optional(),
  })
  .strict();

export const createResaleListingSchema = z
  .object({
    priceCents: z.number().int().nonnegative(),
    expiresAt: iso8601Schema.optional(),
  })
  .strict();

export const completeResaleListingSchema = z
  .object({
    buyerId: z.string().trim().min(1),
    buyerEmail: z.string().trim().toLowerCase().email(),
    buyerFirstName: z.string().trim().min(1).nullable().optional(),
    buyerLastName: z.string().trim().min(1).nullable().optional(),
    buyerPhone: z.string().trim().min(1).nullable().optional(),
    externalPaymentReference: z.string().trim().min(1).max(256).nullable().optional(),
  })
  .strict();

// Export schema
export const createExportSchema = z
  .object({
    eventId: ulidSchema.optional(),
    type: z.enum(['attendees', 'orders', 'scan_logs', 'sales', 'tax', 'tickets']),
    format: z.enum(['csv', 'xlsx', 'json']),
    filters: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

// Question schemas
const questionTypeSchema = z.enum([
  'text',
  'textarea',
  'email',
  'phone',
  'select',
  'multiselect',
  'checkbox',
  'date',
  'file',
  'waiver',
]);
const questionOptionsSchema = z.array(z.string().min(1)).max(100);
const questionConditionSchema = z.object({
  field: z.string().min(1),
  operator: z.enum(['equals', 'not_equals', 'contains']),
  value: z.string(),
});

export const createQuestionSchema = z
  .object({
    ticketTypeId: ulidSchema.optional(),
    type: questionTypeSchema,
    label: z.string().min(1),
    description: z.string().optional(),
    required: z.boolean().optional(),
    appliesTo: z.enum(['buyer', 'attendee', 'both']).optional(),
    options: questionOptionsSchema.optional(),
    placeholder: z.string().optional(),
    validationPattern: z.string().optional(),
    conditionalVisibility: questionConditionSchema.optional(),
    sortOrder: z.number().int().optional(),
    isConsentField: z.boolean().optional(),
    consentText: z.string().optional(),
    consentVersion: z.string().min(1).optional(),
  })
  .strict();

// OAuth application schema
export const createOAuthAppSchema = z
  .object({
    organizationId: ulidSchema,
    name: z.string().min(1),
    redirectUris: z.array(oauthRedirectUrlSchema),
    scopes: z.array(z.string().min(1)),
  })
  .strict();

// Question update schema (all fields optional)
export const updateQuestionSchema = z
  .object({
    ticketTypeId: ulidSchema.nullable().optional(),
    type: questionTypeSchema.optional(),
    label: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    required: z.boolean().optional(),
    appliesTo: z.enum(['buyer', 'attendee', 'both']).optional(),
    options: questionOptionsSchema.nullable().optional(),
    placeholder: z.string().nullable().optional(),
    validationPattern: z.string().nullable().optional(),
    conditionalVisibility: questionConditionSchema.nullable().optional(),
    sortOrder: z.number().int().optional(),
    isConsentField: z.boolean().optional(),
    consentText: z.string().nullable().optional(),
    consentVersion: z.string().min(1).nullable().optional(),
  })
  .strict();

export const reorderQuestionsSchema = z
  .object({
    questions: z
      .array(
        z.object({
          id: ulidSchema,
          sortOrder: z.number().int(),
        }),
      )
      .min(1),
  })
  .strict();

/**
 * Parses a request body against a zod schema, throwing a ValidationError on failure.
 * Uses strict mode for ZodObject schemas so unknown fields are rejected rather
 * than silently stripped.
 */
export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  // Apply .strict() to ZodObject schemas to reject unknown fields.
  const strictSchema = schema instanceof z.ZodObject ? (schema.strict() as z.ZodType<T>) : schema;
  const result = strictSchema.safeParse(body);
  if (!result.success) {
    const firstError = result.error.issues[0];
    const message = firstError
      ? `${firstError.path.join('.')}: ${firstError.message}`
      : 'Request body validation failed';
    throw new ValidationError(message, { issues: result.error.issues });
  }
  return result.data;
}
