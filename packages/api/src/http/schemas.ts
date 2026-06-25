import { z } from 'zod';
import { ValidationError } from '@gatekit/domain';

// Reusable primitives
const ulidSchema = z.string().min(1);
const currencySchema = z.string().length(3);
const iso8601Schema = z.string().datetime();
const urlSchema = z.string().url().refine(
  (val) => {
    try {
      const url = new URL(val);
      return url.protocol === 'https:' || url.protocol === 'http:';
    } catch {
      return false;
    }
  },
  { message: 'URL must use http or https scheme; javascript:, data:, and file: schemes are not allowed' },
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
        if (devMode && url.protocol === 'http:') return true;
        return false;
      } catch {
        return false;
      }
    },
    { message: 'URL must use https scheme (or http in development); javascript:, data:, and file: schemes are not allowed' },
  );
}

// Checkout schemas
export const createCheckoutSessionSchema = (devMode: boolean) =>
  z.object({
    eventId: ulidSchema,
    items: z
      .array(
        z.object({
          ticketTypeId: ulidSchema,
          quantity: z.number().int().min(1),
          unitAmountCents: z.number().int().min(0).optional(),
          attendeeFields: z.array(z.record(z.string(), z.unknown())).optional(),
        }),
      )
      .min(1),
    discountCode: z.string().optional(),
    affiliateCode: z.string().optional(),
    accessCode: z.string().optional(),
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
  }).strict();

export const updateCheckoutSessionSchema = (devMode: boolean) =>
  z.object({
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
  }).strict();

export const confirmCheckoutSchema = z.object({
  paymentMethodId: z.string().optional(),
}).strict();

// Order/refund schemas
export const refundSchema = z.object({
  amountCents: z.number().int().positive().optional(),
  reason: z.string().min(1),
  voidTickets: z.boolean().optional(),
  restoreInventory: z.boolean().optional(),
}).strict();

// Event schemas
export const createEventSchema = z.object({
  organizationId: ulidSchema,
  brandId: ulidSchema,
  slug: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  timezone: z.string().min(1),
  startsAt: iso8601Schema,
  endsAt: iso8601Schema.optional(),
  venue: z.record(z.string(), z.unknown()).optional(),
  visibility: z.enum(['public', 'unlisted', 'private']).optional(),
  seo: z.record(z.string(), z.unknown()).optional(),
  capacity: z.number().int().positive().optional(),
}).strict();

export const updateEventSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  timezone: z.string().min(1).optional(),
  startsAt: iso8601Schema.optional(),
  endsAt: iso8601Schema.nullable().optional(),
  visibility: z.enum(['public', 'unlisted', 'private']).optional(),
  capacity: z.number().int().positive().nullable().optional(),
  status: z.enum(['draft', 'published', 'paused', 'archived']).optional(),
}).strict();

// Tenant schemas
export const createOrganizationSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1),
  clerkOrganizationId: z.string().optional(),
}).strict();

export const createBrandSchema = z.object({
  organizationId: ulidSchema,
  name: z.string().min(1),
  slug: z.string().min(1),
  theme: z.record(z.string(), z.unknown()).optional(),
  whiteLabel: z.boolean().optional(),
}).strict();

export const updateBrandSchema = z.object({
  name: z.string().min(1).optional(),
  slug: z.string().min(1).optional(),
  status: z.enum(['draft', 'active', 'suspended']).optional(),
  theme: z.record(z.string(), z.unknown()).optional(),
  supportUrl: urlSchema.optional(),
  legalUrls: z.record(z.string(), z.string()).optional(),
  whiteLabel: z.boolean().optional(),
}).strict();

export const addBrandDomainSchema = z.object({
  domain: z.string().min(1),
  isPrimary: z.boolean().optional(),
}).strict();

// Ticketing schemas
export const createTicketTypeSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  kind: z.enum(['free', 'paid', 'donation']),
  visibility: z.enum(['public', 'hidden', 'locked']).optional(),
  currency: currencySchema,
  priceCents: z.number().int().min(0),
  minimumPriceCents: z.number().int().min(0).optional(),
  salesStartAt: iso8601Schema.optional(),
  salesEndAt: iso8601Schema.optional(),
  minPerOrder: z.number().int().min(1).optional(),
  maxPerOrder: z.number().int().min(1).optional(),
  inventoryPoolId: ulidSchema,
  requiresAccessCode: z.boolean().optional(),
  accessCodeHint: z.string().optional(),
}).strict();

export const updateTicketTypeSchema = z.object({
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
  requiresAccessCode: z.boolean().optional(),
  accessCodeHint: z.string().nullable().optional(),
  sortOrder: z.number().int().optional(),
}).strict();

export const createInventoryPoolSchema = z.object({
  name: z.string().min(1),
  totalCapacity: z.number().int().min(1),
  holdTtlSeconds: z.number().int().min(1).optional(),
}).strict();

// Developer schemas
export const createApiKeySchema = z.object({
  organizationId: ulidSchema,
  name: z.string().min(1),
  scopes: z.array(z.string().min(1)),
  brandIds: z.array(ulidSchema).optional(),
  eventIds: z.array(ulidSchema).optional(),
  expiresAt: iso8601Schema.optional(),
}).strict();

export const createScannerDeviceSchema = z.object({
  organizationId: ulidSchema,
  name: z.string().min(1),
  eventIds: z.array(ulidSchema).optional(),
}).strict();

// Webhook schemas
export const createWebhookEndpointSchema = z.object({
  organizationId: ulidSchema,
  url: urlSchema,
  events: z.array(z.string().min(1)),
  description: z.string().optional(),
}).strict();

export const updateWebhookEndpointSchema = z.object({
  url: urlSchema.optional(),
  events: z.array(z.string().min(1)).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  description: z.string().nullable().optional(),
}).strict();

// Messaging schema
export const sendMessageSchema = z.object({
  eventId: ulidSchema.optional(),
  templateKey: z.string().min(1),
  audience: z.enum(['all', 'checked_in', 'not_checked_in', 'specific']),
  attendeeIds: z.array(ulidSchema).optional(),
  variables: z.record(z.string(), z.unknown()).optional(),
  channel: z.enum(['email', 'sms', 'both']),
}).strict();

// Check-in schemas
export const scanSchema = z.object({
  checkInListId: ulidSchema,
  qrPayload: z.string().min(1),
  scannedAt: iso8601Schema,
  offline: z.boolean().optional(),
  deviceId: z.string().optional(),
}).strict();

export const syncScanSchema = z.object({
  checkInListId: ulidSchema,
  deviceId: z.string().optional(),
  scans: z.array(
    z.object({
      qrHash: z.string().min(1),
      scannedAt: iso8601Schema,
      offline: z.boolean(),
    }),
  ),
}).strict();

export const updateAttendeeSchema = z.object({
  firstName: z.string().nullable().optional(),
  lastName: z.string().nullable().optional(),
  email: z.string().email().optional(),
  phone: z.string().nullable().optional(),
  status: z.enum(['pending', 'confirmed', 'cancelled', 'refunded', 'checked_in']).optional(),
}).strict();

// Transfer schema
export const transferTicketSchema = z.object({
  toEmail: z.string().email(),
}).strict();

// Export schema
export const createExportSchema = z.object({
  eventId: ulidSchema.optional(),
  type: z.enum(['attendees', 'orders', 'scan_logs', 'sales', 'tax', 'tickets']),
  format: z.enum(['csv', 'xlsx', 'json']),
  filters: z.record(z.string(), z.unknown()).optional(),
}).strict();

// Question schemas
const questionTypeSchema = z.enum(['text', 'textarea', 'email', 'phone', 'select', 'multiselect', 'checkbox', 'date', 'file', 'waiver']);
const questionOptionsSchema = z.array(z.string().min(1)).max(100);
const questionConditionSchema = z.object({
  field: z.string().min(1),
  operator: z.enum(['equals', 'not_equals', 'contains']),
  value: z.string(),
});

export const createQuestionSchema = z.object({
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
}).strict();

// OAuth application schema
export const createOAuthAppSchema = z.object({
  organizationId: ulidSchema,
  name: z.string().min(1),
  redirectUris: z.array(urlSchema),
  scopes: z.array(z.string().min(1)),
}).strict();

// Question update schema (all fields optional)
export const updateQuestionSchema = z.object({
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
}).strict();

/**
 * Parses a request body against a zod schema, throwing a ValidationError on failure.
 * Uses strict mode for ZodObject schemas so unknown fields are rejected rather
 * than silently stripped.
 */
export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  // Apply .strict() to ZodObject schemas to reject unknown fields.
  const strictSchema =
    schema instanceof z.ZodObject ? (schema.strict() as z.ZodType<T>) : schema;
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
