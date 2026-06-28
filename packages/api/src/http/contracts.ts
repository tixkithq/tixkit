import type { Principal, Permission } from '@tixkit/domain';
import { ForbiddenError, ValidationError } from '@tixkit/domain';
export { signWebhookPayload, verifyWebhookSignature } from '@tixkit/domain/developer';

export type PageEnvelope<T> = {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
};

export type PaginationInput = {
  cursor?: string;
  limit: number;
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const INTEGER_STRING = /^\d+$/;
export function parseJsonValue<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value !== 'string') return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function toIso(value: Date | string | null | undefined): string | undefined {
  if (value == null) return undefined;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function parsePagination(query: unknown): PaginationInput {
  const raw = (query ?? {}) as Record<string, unknown>;
  const parsedLimit =
    typeof raw.limit === 'number'
      ? raw.limit
      : typeof raw.limit === 'string'
        ? INTEGER_STRING.test(raw.limit)
          ? Number(raw.limit)
          : Number.NaN
        : DEFAULT_LIMIT;

  if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1) {
    throw new ValidationError('limit must be a positive integer');
  }

  const cursor = typeof raw.cursor === 'string' && raw.cursor.length > 0 ? raw.cursor : undefined;
  return { cursor, limit: Math.min(parsedLimit, MAX_LIMIT) };
}

export function pageEnvelope<T>(rows: T[], limit: number): PageEnvelope<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1) as { id?: unknown } | undefined;
  const nextCursor = typeof last?.id === 'string' ? last.id : null;
  return {
    items,
    nextCursor: hasMore ? nextCursor : null,
    hasMore,
  };
}

export function pickAllowedFields(
  body: Record<string, unknown>,
  allowedFields: readonly string[],
  fieldMap: Record<string, string> = {},
): Record<string, unknown> {
  const allowed = new Set(allowedFields);
  const unknownFields = Object.keys(body).filter((field) => !allowed.has(field));
  if (unknownFields.length > 0) {
    throw new ValidationError('Request body contains unsupported fields', {
      fields: unknownFields,
    });
  }

  const result: Record<string, unknown> = {};
  for (const field of allowedFields) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      result[fieldMap[field] ?? field] = body[field];
    }
  }
  return result;
}

export function requireAssignableScopes(principal: Principal, requestedScopes: Permission[]): void {
  for (const scope of requestedScopes) {
    if (!principal.scopes.includes(scope)) {
      throw new ForbiddenError(`Cannot grant scope the principal does not have: ${scope}`);
    }
  }
}

export function serializeEvent(row: Record<string, unknown>) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    organizationId: row.organization_id,
    brandId: row.brand_id,
    slug: row.slug,
    title: row.title,
    description: row.description ?? undefined,
    status: row.status,
    currency: row.currency ?? 'USD',
    timezone: row.timezone,
    startsAt: toIso(row.starts_at as Date | string),
    endsAt: toIso(row.ends_at as Date | string | null),
    venue: parseJsonValue(row.venue, null),
    visibility: row.visibility,
    seo: parseJsonValue(row.seo, {}),
    capacity: row.capacity ?? undefined,
    coverImageUrl: row.cover_image_url ?? undefined,
    externalUrl: row.external_url ?? undefined,
    createdAt: toIso(row.created_at as Date | string),
    updatedAt: toIso(row.updated_at as Date | string),
  };
}

export function serializeEventOccurrence(row: Record<string, unknown>) {
  return {
    id: row.id,
    eventId: row.event_id,
    title: row.title,
    startsAt: toIso(row.starts_at as Date | string),
    endsAt: toIso(row.ends_at as Date | string),
    timezone: row.timezone,
    venue: parseJsonValue(row.venue, null),
    capacity: row.capacity ?? undefined,
    sortOrder: row.sort_order,
    status: row.status,
    createdAt: toIso(row.created_at as Date | string),
    updatedAt: toIso(row.updated_at as Date | string),
  };
}

export function serializeMarketingIntegration(
  row: Record<string, unknown>,
  options: { public?: boolean } = {},
) {
  const base = {
    provider: row.provider,
    config: parseJsonValue(row.config, {}),
    consentRequired: Boolean(row.consent_required),
    status: row.status,
  };
  if (options.public) return base;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    organizationId: row.organization_id,
    brandId: row.brand_id,
    eventId: row.event_id ?? undefined,
    ...base,
    createdAt: toIso(row.created_at as Date | string),
    updatedAt: toIso(row.updated_at as Date | string),
  };
}

export function serializeTicketType(row: Record<string, unknown>) {
  return {
    id: row.id,
    eventId: row.event_id,
    name: row.name,
    description: row.description ?? undefined,
    kind: row.kind,
    status: row.status,
    visibility: row.visibility,
    currency: row.currency,
    priceCents: Number(row.price_cents),
    minimumPriceCents:
      row.minimum_price_cents == null ? undefined : Number(row.minimum_price_cents),
    salesStartAt: toIso(row.sales_start_at as Date | string | null),
    salesEndAt: toIso(row.sales_end_at as Date | string | null),
    minPerOrder: row.min_per_order,
    maxPerOrder: row.max_per_order,
    inventoryPoolId: row.inventory_pool_id,
    sortOrder: row.sort_order,
    requiresAccessCode: row.requires_access_code,
    accessCodeHint: row.access_code_hint ?? undefined,
    eventOccurrenceId: row.event_occurrence_id ?? undefined,
    createdAt: toIso(row.created_at as Date | string),
    updatedAt: toIso(row.updated_at as Date | string),
  };
}

export function serializeInventoryPool(row: Record<string, unknown>) {
  return {
    id: row.id,
    eventId: row.event_id,
    name: row.name,
    totalCapacity: row.total_capacity,
    reservedCount: row.reserved_count,
    soldCount: row.sold_count,
    holdTtlSeconds: row.hold_ttl_seconds,
    createdAt: toIso(row.created_at as Date | string),
    updatedAt: toIso(row.updated_at as Date | string),
  };
}

export function serializeAccessRule(row: Record<string, unknown>) {
  return {
    id: row.id,
    ticketTypeId: row.ticket_type_id,
    type: row.type,
    value: row.value,
    maxUses: row.max_uses == null ? undefined : Number(row.max_uses),
    usesCount: Number(row.uses_count ?? 0),
    expiresAt: toIso(row.expires_at as Date | string | null),
    createdAt: toIso(row.created_at as Date | string),
    updatedAt: toIso(row.updated_at as Date | string),
  };
}

export function serializeProductCategory(row: Record<string, unknown>) {
  return {
    id: row.id,
    eventId: row.event_id,
    name: row.name,
    sortOrder: row.sort_order,
    createdAt: toIso(row.created_at as Date | string),
    updatedAt: toIso(row.updated_at as Date | string),
  };
}

export function serializeProduct(row: Record<string, unknown>) {
  return {
    id: row.id,
    eventId: row.event_id,
    name: row.name,
    description: row.description ?? undefined,
    priceCents: Number(row.price_cents),
    currency: row.currency,
    categoryId: row.category_id ?? undefined,
    maxPerOrder: row.max_per_order,
    availableFrom: toIso(row.available_from as Date | string | null),
    availableUntil: toIso(row.available_until as Date | string | null),
    status: row.status,
    sortOrder: row.sort_order,
    createdAt: toIso(row.created_at as Date | string),
    updatedAt: toIso(row.updated_at as Date | string),
  };
}

export function serializeOrder(row: Record<string, unknown>) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    organizationId: row.organization_id,
    brandId: row.brand_id,
    eventId: row.event_id,
    checkoutSessionId: row.checkout_session_id,
    orderNumber: row.order_number,
    status: row.status,
    currency: row.currency,
    subtotalCents: Number(row.subtotal_cents),
    discountCents: Number(row.discount_cents),
    taxCents: Number(row.tax_cents),
    feeCents: Number(row.fee_cents),
    totalCents: Number(row.total_cents),
    refundedCents: Number(row.refunded_cents),
    buyerEmail: row.buyer_email,
    buyerFirstName: row.buyer_first_name ?? undefined,
    buyerLastName: row.buyer_last_name ?? undefined,
    buyerPhone: row.buyer_phone ?? undefined,
    paymentIntentId: row.payment_intent_id ?? undefined,
    paymentProvider: row.payment_provider ?? undefined,
    paidAt: toIso(row.paid_at as Date | string | null),
    refundedAt: toIso(row.refunded_at as Date | string | null),
    cancelledAt: toIso(row.cancelled_at as Date | string | null),
    createdAt: toIso(row.created_at as Date | string),
    updatedAt: toIso(row.updated_at as Date | string),
  };
}

export function serializeOrderLineItem(row: Record<string, unknown>) {
  return {
    id: row.id,
    orderId: row.order_id,
    ticketTypeId: row.ticket_type_id ?? undefined,
    eventOccurrenceId: row.event_occurrence_id ?? undefined,
    productId: row.product_id ?? undefined,
    attendeeId: row.attendee_id ?? undefined,
    description: row.description,
    quantity: row.quantity,
    unitPriceCents: Number(row.unit_price_cents),
    subtotalCents: Number(row.subtotal_cents),
    discountCents: Number(row.discount_cents),
    taxCents: Number(row.tax_cents),
    feeCents: Number(row.fee_cents),
    totalCents: Number(row.total_cents),
    currency: row.currency,
    createdAt: toIso(row.created_at as Date | string),
    updatedAt: toIso(row.updated_at as Date | string),
  };
}

export function serializeRefund(row: Record<string, unknown>) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    orderId: row.order_id,
    paymentIntentId: row.payment_intent_id ?? undefined,
    provider: row.provider,
    providerRefundId: row.provider_refund_id,
    amountCents: Number(row.amount_cents),
    currency: row.currency,
    status: row.status,
    reason: row.reason,
    metadata: parseJsonValue(row.metadata, {}),
    createdAt: toIso(row.created_at as Date | string),
    updatedAt: toIso(row.updated_at as Date | string),
  };
}

export function serializeTaxSnapshot(row: Record<string, unknown>) {
  return {
    id: row.id,
    orderId: row.order_id,
    orderLineItemId: row.order_line_item_id,
    eventId: row.event_id,
    taxRuleId: row.tax_rule_id ?? undefined,
    taxRuleName: row.tax_rule_name,
    rate: Number(row.rate),
    type: row.type,
    appliedTo: row.applied_to,
    jurisdictionCountry: row.jurisdiction_country ?? undefined,
    jurisdictionRegion: row.jurisdiction_region ?? undefined,
    taxableAmountCents: Number(row.taxable_amount_cents),
    taxCents: Number(row.tax_cents),
    currency: row.currency,
    inclusive: Boolean(row.inclusive),
    provider: row.provider,
    providerCalculationId: row.provider_calculation_id ?? undefined,
    metadata: parseJsonValue(row.metadata, undefined),
    createdAt: toIso(row.created_at as Date | string),
  };
}

export function serializeInvoice(row: Record<string, unknown>) {
  return {
    id: row.id,
    orderId: row.order_id,
    tenantId: row.tenant_id,
    organizationId: row.organization_id,
    brandId: row.brand_id,
    eventId: row.event_id,
    invoiceNumber: row.invoice_number,
    status: row.status,
    currency: row.currency,
    subtotalCents: Number(row.subtotal_cents),
    discountCents: Number(row.discount_cents),
    taxCents: Number(row.tax_cents),
    feeCents: Number(row.fee_cents),
    totalCents: Number(row.total_cents),
    refundedCents: Number(row.refunded_cents),
    buyerEmail: row.buyer_email,
    buyerName: row.buyer_name ?? undefined,
    buyerTaxId: row.buyer_tax_id ?? undefined,
    sellerName: row.seller_name,
    sellerTaxId: row.seller_tax_id ?? undefined,
    reverseCharge: Boolean(row.reverse_charge),
    issuedAt: toIso(row.issued_at as Date | string),
    voidedAt: toIso(row.voided_at as Date | string | null),
    metadata: parseJsonValue(row.metadata, undefined),
    createdAt: toIso(row.created_at as Date | string),
    updatedAt: toIso(row.updated_at as Date | string),
  };
}

export function serializeTimelineEvent(row: Record<string, unknown>) {
  return {
    id: row.id,
    orderId: row.order_id,
    type: row.type,
    description: row.description,
    metadata: parseJsonValue(row.metadata, undefined),
    actorId: row.actor_id ?? undefined,
    createdAt: toIso(row.created_at as Date | string),
  };
}

export function serializeAttendee(row: Record<string, unknown>) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    orderId: row.order_id,
    eventId: row.event_id,
    ticketTypeId: row.ticket_type_id,
    eventOccurrenceId: row.event_occurrence_id ?? undefined,
    ticketId: row.ticket_id ?? undefined,
    firstName: row.first_name ?? undefined,
    lastName: row.last_name ?? undefined,
    email: row.email,
    phone: row.phone ?? undefined,
    status: row.status,
    customAnswers: parseJsonValue(row.custom_answers, undefined),
    checkedInAt: toIso(row.checked_in_at as Date | string | null),
    checkInDeviceId: row.check_in_device_id ?? undefined,
    createdAt: toIso(row.created_at as Date | string),
    updatedAt: toIso(row.updated_at as Date | string),
  };
}

export function serializeTicket(row: Record<string, unknown>) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    orderId: row.order_id,
    attendeeId: row.attendee_id,
    eventId: row.event_id,
    ticketTypeId: row.ticket_type_id,
    eventOccurrenceId: row.event_occurrence_id ?? undefined,
    status: row.status,
    code: row.code,
    qrPayload: row.qr_payload,
    qrHash: row.qr_hash,
    transferredToEmail: row.transferred_to_email ?? undefined,
    transferredAt: toIso(row.transferred_at as Date | string | null),
    checkedInAt: toIso(row.checked_in_at as Date | string | null),
    checkedInByDeviceId: row.checked_in_by_device_id ?? undefined,
    walletPassId: row.wallet_pass_id ?? undefined,
    createdAt: toIso(row.created_at as Date | string),
    updatedAt: toIso(row.updated_at as Date | string),
  };
}

export function serializeCheckInList(row: Record<string, unknown>) {
  return {
    id: row.id,
    eventId: row.event_id,
    name: row.name,
    ticketTypeIds: parseJsonValue<string[]>(row.ticket_type_ids, []),
    status: row.status,
    createdAt: toIso(row.created_at as Date | string),
    updatedAt: toIso(row.updated_at as Date | string),
  };
}

export function serializeOrganization(row: Record<string, unknown>) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    slug: row.slug,
    clerkOrganizationId: row.clerk_organization_id ?? undefined,
    status: row.status,
    createdAt: toIso(row.created_at as Date | string),
    updatedAt: toIso(row.updated_at as Date | string),
  };
}

export function serializeBrand(row: Record<string, unknown>) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    organizationId: row.organization_id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    theme: parseJsonValue(row.theme, {}),
    emailIdentityId: row.email_identity_id ?? undefined,
    smsIdentityId: row.sms_identity_id ?? undefined,
    paymentAccountId: row.payment_account_id ?? undefined,
    supportUrl: row.support_url ?? undefined,
    legalUrls: parseJsonValue(row.legal_urls, {}),
    whiteLabel: row.white_label,
    createdAt: toIso(row.created_at as Date | string),
    updatedAt: toIso(row.updated_at as Date | string),
  };
}

export function serializeBrandDomain(row: Record<string, unknown>) {
  return {
    id: row.id,
    brandId: row.brand_id,
    domain: row.domain,
    isPrimary: row.is_primary,
    isVerified: row.is_verified,
    verificationToken: row.verification_token ?? undefined,
    sslStatus: row.ssl_status,
    createdAt: toIso(row.created_at as Date | string),
    updatedAt: toIso(row.updated_at as Date | string),
  };
}

export function serializeApiKey(row: Record<string, unknown>) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    organizationId: row.organization_id,
    name: row.name,
    keyPrefix: row.key_prefix,
    scopes: parseJsonValue<string[]>(row.scopes, []),
    brandIds: parseJsonValue<string[] | undefined>(row.brand_ids, undefined),
    eventIds: parseJsonValue<string[] | undefined>(row.event_ids, undefined),
    lastUsedAt: toIso(row.last_used_at as Date | string | null),
    expiresAt: toIso(row.expires_at as Date | string | null),
    revokedAt: toIso(row.revoked_at as Date | string | null),
    createdAt: toIso(row.created_at as Date | string),
    updatedAt: toIso(row.updated_at as Date | string),
  };
}

export function serializeScannerDevice(row: Record<string, unknown>) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    organizationId: row.organization_id,
    name: row.name,
    deviceId: row.device_id,
    eventIds: parseJsonValue<string[]>(row.event_ids, []),
    status: row.status,
    lastSeenAt: toIso(row.last_seen_at as Date | string | null),
    createdAt: toIso(row.created_at as Date | string),
    updatedAt: toIso(row.updated_at as Date | string),
  };
}

export function serializeWebhookEndpoint(row: Record<string, unknown>, includeSecret = false) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    organizationId: row.organization_id,
    url: row.url,
    secret: includeSecret ? row.secret : undefined,
    events: parseJsonValue<string[]>(row.events, []),
    status: row.status,
    description: row.description ?? undefined,
    createdAt: toIso(row.created_at as Date | string),
    updatedAt: toIso(row.updated_at as Date | string),
  };
}

export function serializeWebhookEvent(row: Record<string, unknown>) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    organizationId: row.organization_id,
    type: row.type,
    payload: parseJsonValue(row.payload, {}),
    status: row.status,
    createdAt: toIso(row.created_at as Date | string),
  };
}
