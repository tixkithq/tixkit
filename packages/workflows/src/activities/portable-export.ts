import type { Database } from '@tixkit/db';
import type {
  PortableBundleManifest,
  PortableLogicalRecord,
  PortableSection,
} from '@tixkit/portability';
import { comparePortableCodeUnits } from '@tixkit/portability';

function dependency(section: PortableSection, portableId: string) {
  return { section, portableId };
}

function iso(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error('portable export timestamp is invalid');
  return date.toISOString();
}

function logicalJson(value: unknown, field: string): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`portable export ${field} contains invalid JSON`);
  }
}

const PORTABLE_THEME_KEYS = new Set([
  'primaryColor',
  'secondaryColor',
  'accentColor',
  'backgroundColor',
  'textColor',
  'fontFamily',
  'borderRadius',
]);
const DEFERRED_THEME_KEYS = new Set([
  'logoArtifactId',
  'iconArtifactId',
  'logoUrl',
  'iconUrl',
  'faviconUrl',
  'customCss',
]);

function portableBrandTheme(value: unknown): Readonly<Record<string, unknown>> {
  const parsed = logicalJson(value, 'theme');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('portable export theme must be an object');
  }
  const entries = Object.entries(parsed);
  const unknown = entries
    .filter(([key]) => !PORTABLE_THEME_KEYS.has(key) && !DEFERRED_THEME_KEYS.has(key))
    .map(([key]) => key);
  if (unknown.length > 0) {
    throw new Error(`PORTABLE_EXPORT_THEME_FIELD_UNSUPPORTED:${unknown.sort().join(',')}`);
  }
  return Object.fromEntries(entries.filter(([key]) => PORTABLE_THEME_KEYS.has(key)));
}

function logicalNumber(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number))
    throw new Error(`portable export ${field} is not a safe integer`);
  return number;
}

function logicalBoolean(value: unknown, field: string): boolean {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  throw new Error(`portable export ${field} is not a boolean`);
}

export async function loadPortableConfigurationRebindings(
  db: Database,
  input: { tenantId: string; organizationId: string },
): Promise<PortableBundleManifest['rebindings']> {
  const brandIds = (
    await db
      .selectFrom('brands')
      .select('id')
      .where('tenant_id', '=', input.tenantId)
      .where('organization_id', '=', input.organizationId)
      .execute()
  ).map(({ id }) => id);
  const [paymentAccounts, webhooks, oauthApplications, senderIdentities, marketingIntegrations] =
    await Promise.all([
      db
        .selectFrom('payment_accounts')
        .select(['id', 'status'])
        .where('tenant_id', '=', input.tenantId)
        .where('organization_id', '=', input.organizationId)
        .execute(),
      db
        .selectFrom('webhook_endpoints')
        .select(['id', 'status'])
        .where('tenant_id', '=', input.tenantId)
        .where('organization_id', '=', input.organizationId)
        .execute(),
      db
        .selectFrom('oauth_applications')
        .select(['id', 'status'])
        .where('tenant_id', '=', input.tenantId)
        .where('organization_id', '=', input.organizationId)
        .execute(),
      db
        .selectFrom('sender_identities')
        .select(['id', 'verified'])
        .where('tenant_id', '=', input.tenantId)
        .where('organization_id', '=', input.organizationId)
        .execute(),
      db
        .selectFrom('marketing_integrations')
        .select(['id', 'status'])
        .where('tenant_id', '=', input.tenantId)
        .where('organization_id', '=', input.organizationId)
        .execute(),
    ]);
  const [domains, brandSenders, smsSenders, emailRoutes, smsRoutes] =
    brandIds.length === 0
      ? [[], [], [], [], []]
      : await Promise.all([
          db
            .selectFrom('brand_domains')
            .select(['id', 'is_verified', 'ssl_status'])
            .where('brand_id', 'in', brandIds)
            .execute(),
          db
            .selectFrom('brand_sender_identities')
            .select(['id', 'verified'])
            .where('tenant_id', '=', input.tenantId)
            .where('brand_id', 'in', brandIds)
            .execute(),
          db
            .selectFrom('sms_sender_identities')
            .select(['id', 'verified'])
            .where('tenant_id', '=', input.tenantId)
            .where('brand_id', 'in', brandIds)
            .execute(),
          db
            .selectFrom('email_provider_routes')
            .select(['id', 'status', 'smoke_send_verified'])
            .where('tenant_id', '=', input.tenantId)
            .where('brand_id', 'in', brandIds)
            .execute(),
          db
            .selectFrom('sms_provider_routes')
            .select(['id', 'status', 'smoke_send_verified'])
            .where('tenant_id', '=', input.tenantId)
            .where('brand_id', 'in', brandIds)
            .execute(),
        ]);
  return [
    ...paymentAccounts.map(({ id, status }) => ({
      kind: 'payment_provider_account' as const,
      portableId: `payment_provider_account:${id}`,
      required: status === 'active',
    })),
    ...emailRoutes.map(({ id, status, smoke_send_verified }) => ({
      kind: 'email_delivery_route' as const,
      portableId: `email_delivery_route:${id}`,
      required:
        status === 'active' && logicalBoolean(smoke_send_verified, 'emailRoute.smokeVerified'),
    })),
    ...smsRoutes.map(({ id, status, smoke_send_verified }) => ({
      kind: 'sms_delivery_route' as const,
      portableId: `sms_delivery_route:${id}`,
      required:
        status === 'active' && logicalBoolean(smoke_send_verified, 'smsRoute.smokeVerified'),
    })),
    ...marketingIntegrations.map(({ id, status }) => ({
      kind: 'marketing_integration' as const,
      portableId: `marketing_integration:${id}`,
      required: status === 'active',
    })),
    ...domains.map(({ id, is_verified, ssl_status }) => ({
      kind: 'custom_domain' as const,
      portableId: `custom_domain:${id}`,
      required: logicalBoolean(is_verified, 'brandDomain.isVerified') && ssl_status === 'active',
    })),
    ...senderIdentities.map(({ id, verified }) => ({
      kind: 'sending_identity' as const,
      portableId: `sending_identity:organization:${id}`,
      required: logicalBoolean(verified, 'senderIdentity.verified'),
    })),
    ...brandSenders.map(({ id, verified }) => ({
      kind: 'sending_identity' as const,
      portableId: `sending_identity:email:${id}`,
      required: logicalBoolean(verified, 'brandSenderIdentity.verified'),
    })),
    ...smsSenders.map(({ id, verified }) => ({
      kind: 'sending_identity' as const,
      portableId: `sending_identity:sms:${id}`,
      required: logicalBoolean(verified, 'smsSenderIdentity.verified'),
    })),
    ...webhooks.map(({ id, status }) => ({
      kind: 'webhook_endpoint' as const,
      portableId: `webhook_endpoint:${id}`,
      required: status === 'active',
    })),
    ...oauthApplications.map(({ id, status }) => ({
      kind: 'oauth_redirect_origin' as const,
      portableId: `oauth_redirect_origin:${id}`,
      required: status === 'active',
    })),
  ].sort((left, right) => comparePortableCodeUnits(left.portableId, right.portableId));
}

export async function loadPortableConfigurationSections(
  db: Database,
  input: { tenantId: string; organizationId: string },
): Promise<ReadonlyMap<PortableSection, readonly PortableLogicalRecord[]>> {
  const organization = await db
    .selectFrom('organizations')
    .selectAll()
    .where('id', '=', input.organizationId)
    .where('tenant_id', '=', input.tenantId)
    .executeTakeFirst();
  if (!organization) throw new Error('PORTABLE_EXPORT_ORGANIZATION_NOT_FOUND');

  const [brands, venues, events] = await Promise.all([
    db
      .selectFrom('brands')
      .selectAll()
      .where('tenant_id', '=', input.tenantId)
      .where('organization_id', '=', input.organizationId)
      .orderBy('id', 'asc')
      .execute(),
    db
      .selectFrom('venues')
      .selectAll()
      .where('tenant_id', '=', input.tenantId)
      .where('organization_id', '=', input.organizationId)
      .orderBy('id', 'asc')
      .execute(),
    db
      .selectFrom('events')
      .selectAll()
      .where('tenant_id', '=', input.tenantId)
      .where('organization_id', '=', input.organizationId)
      .orderBy('id', 'asc')
      .execute(),
  ]);
  const eventIds = events.map(({ id }) => id);
  const sections = new Map<PortableSection, PortableLogicalRecord[]>();
  sections.set('organizations', [
    {
      portableId: organization.id,
      attributes: {
        name: organization.name,
        slug: organization.slug,
        status: organization.status,
        boxOfficeSettings: logicalJson(organization.box_office_settings, 'boxOfficeSettings'),
        eventDefaults: logicalJson(organization.event_defaults, 'eventDefaults'),
      },
    },
  ]);
  sections.set(
    'brands',
    brands.map((brand) => ({
      portableId: brand.id,
      attributes: {
        name: brand.name,
        slug: brand.slug,
        status: brand.status,
        theme: portableBrandTheme(brand.theme),
        supportUrl: brand.support_url,
        legalUrls: logicalJson(brand.legal_urls, 'legalUrls'),
        whiteLabel: logicalBoolean(brand.white_label, 'brand.whiteLabel'),
      },
      dependencies: [dependency('organizations', organization.id)],
    })),
  );
  sections.set(
    'venues',
    venues.map((venue) => ({
      portableId: venue.id,
      attributes: { name: venue.name, address: venue.address, timezone: venue.timezone },
      dependencies: [dependency('organizations', organization.id)],
    })),
  );
  sections.set(
    'events',
    events.map((event) => ({
      portableId: event.id,
      attributes: {
        title: event.title,
        slug: event.slug,
        description: event.description,
        status: event.status,
        currency: event.currency,
        timezone: event.timezone,
        startsAt: iso(event.starts_at),
        endsAt: iso(event.ends_at),
        visibility: event.visibility,
        capacity: logicalNumber(event.capacity, 'capacity'),
        minimumAge: logicalNumber(event.minimum_age, 'minimumAge'),
        codeFormat: logicalJson(event.code_format, 'codeFormat'),
      },
      dependencies: [
        dependency('brands', event.brand_id),
        ...(event.venue_id ? [dependency('venues', event.venue_id)] : []),
      ],
    })),
  );
  if (eventIds.length === 0) {
    for (const section of [
      'occurrences',
      'inventory',
      'ticket_types',
      'products',
      'checkout_questions',
      'discounts',
      'access_codes',
    ] as const) {
      sections.set(section, []);
    }
    return sections;
  }
  const [occurrences, pools, ticketTypes, products, questions, discounts] = await Promise.all([
    db.selectFrom('event_occurrences').selectAll().where('event_id', 'in', eventIds).execute(),
    db.selectFrom('inventory_pools').selectAll().where('event_id', 'in', eventIds).execute(),
    db.selectFrom('ticket_types').selectAll().where('event_id', 'in', eventIds).execute(),
    db.selectFrom('products').selectAll().where('event_id', 'in', eventIds).execute(),
    db.selectFrom('questions').selectAll().where('event_id', 'in', eventIds).execute(),
    db.selectFrom('discount_codes').selectAll().where('event_id', 'in', eventIds).execute(),
  ]);
  const ticketTypeIds = ticketTypes.map(({ id }) => id);
  const accessRules = ticketTypeIds.length
    ? await db
        .selectFrom('access_rules')
        .selectAll()
        .where('ticket_type_id', 'in', ticketTypeIds)
        .orderBy('id', 'asc')
        .execute()
    : [];

  sections.set(
    'occurrences',
    occurrences.map((occurrence) => ({
      portableId: occurrence.id,
      attributes: {
        title: occurrence.title,
        startsAt: iso(occurrence.starts_at),
        endsAt: iso(occurrence.ends_at),
        timezone: occurrence.timezone,
        capacity: logicalNumber(occurrence.capacity, 'occurrence.capacity'),
        status: occurrence.status,
        sortOrder: logicalNumber(occurrence.sort_order, 'occurrence.sortOrder'),
      },
      dependencies: [
        dependency('events', occurrence.event_id),
        ...(occurrence.venue_id ? [dependency('venues', occurrence.venue_id)] : []),
      ],
    })),
  );
  sections.set(
    'inventory',
    pools.map((pool) => ({
      portableId: pool.id,
      attributes: {
        name: pool.name,
        totalCapacity: logicalNumber(pool.total_capacity, 'inventory.totalCapacity'),
        holdTtlSeconds: logicalNumber(pool.hold_ttl_seconds, 'inventory.holdTtlSeconds'),
      },
      dependencies: [dependency('events', pool.event_id)],
    })),
  );
  sections.set(
    'ticket_types',
    ticketTypes.map((ticketType) => ({
      portableId: ticketType.id,
      attributes: {
        name: ticketType.name,
        description: ticketType.description,
        kind: ticketType.kind,
        status: ticketType.status,
        visibility: ticketType.visibility,
        currency: ticketType.currency,
        priceMinor: logicalNumber(ticketType.price_cents, 'ticketType.priceMinor'),
        minimumPriceMinor: logicalNumber(
          ticketType.minimum_price_cents,
          'ticketType.minimumPriceMinor',
        ),
        salesStartAt: iso(ticketType.sales_start_at),
        salesEndAt: iso(ticketType.sales_end_at),
        minPerOrder: logicalNumber(ticketType.min_per_order, 'ticketType.minPerOrder'),
        maxPerOrder: logicalNumber(ticketType.max_per_order, 'ticketType.maxPerOrder'),
        sortOrder: logicalNumber(ticketType.sort_order, 'ticketType.sortOrder'),
        requiresAccessCode: logicalBoolean(
          ticketType.requires_access_code,
          'ticketType.requiresAccessCode',
        ),
      },
      dependencies: [
        dependency('events', ticketType.event_id),
        dependency('inventory', ticketType.inventory_pool_id),
        ...(ticketType.event_occurrence_id
          ? [dependency('occurrences', ticketType.event_occurrence_id)]
          : []),
      ],
    })),
  );
  sections.set(
    'products',
    products.map((product) => ({
      portableId: product.id,
      attributes: {
        name: product.name,
        description: product.description,
        currency: product.currency,
        priceMinor: logicalNumber(product.price_cents, 'product.priceMinor'),
        maxPerOrder: logicalNumber(product.max_per_order, 'product.maxPerOrder'),
        availableFrom: iso(product.available_from),
        availableUntil: iso(product.available_until),
        status: product.status,
        sortOrder: logicalNumber(product.sort_order, 'product.sortOrder'),
      },
      dependencies: [dependency('events', product.event_id)],
    })),
  );
  sections.set(
    'checkout_questions',
    questions.map((question) => ({
      portableId: question.id,
      attributes: {
        label: question.label,
        type: question.type,
        description: question.description,
        required: logicalBoolean(question.required, 'question.required'),
        appliesTo: question.applies_to,
        options: logicalJson(question.options, 'options'),
        placeholder: question.placeholder,
        sortOrder: logicalNumber(question.sort_order, 'question.sortOrder'),
        isConsentField: logicalBoolean(question.is_consent_field, 'question.isConsentField'),
        consentText: question.consent_text,
        consentVersion: question.consent_version,
      },
      dependencies: [
        dependency('events', question.event_id),
        ...(question.ticket_type_id ? [dependency('ticket_types', question.ticket_type_id)] : []),
      ],
    })),
  );
  sections.set(
    'discounts',
    discounts.map((discount) => ({
      portableId: discount.id,
      attributes: {
        code: discount.code,
        type: discount.type,
        value: logicalNumber(discount.value, 'discount.value'),
        currency: discount.currency,
        maxUses: logicalNumber(discount.max_uses, 'discount.maxUses'),
        validFrom: iso(discount.valid_from),
        validUntil: iso(discount.valid_until),
        minOrderMinor: logicalNumber(discount.min_order_cents, 'discount.minOrderMinor'),
        maxDiscountMinor: logicalNumber(discount.max_discount_cents, 'discount.maxDiscountMinor'),
        status: discount.status,
      },
      dependencies: [dependency('events', discount.event_id)],
    })),
  );
  sections.set(
    'access_codes',
    accessRules.map((rule) => ({
      portableId: rule.id,
      attributes: {
        code: rule.value,
        type: rule.type,
        maxUses: logicalNumber(rule.max_uses, 'accessCode.maxUses'),
        expiresAt: iso(rule.expires_at),
      },
      dependencies: [dependency('ticket_types', rule.ticket_type_id)],
    })),
  );
  return sections;
}
