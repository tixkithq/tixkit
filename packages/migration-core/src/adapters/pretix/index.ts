import {
  MIGRATION_ENTITY_DEPENDENCY_ORDER,
  createHistoricalFinancialSnapshot,
  validateCanonicalMigrationEntity,
  type AdapterContext,
  type ExtractedMigrationRow,
  type MigrationAdapter,
  type MigrationDiscovery,
  type MigrationEntityType,
  type MigrationIssue,
  type NormalizedMigrationEntity,
} from '../../index.js';

export const PRETIX_SUPPORTED_VERSIONS = [
  'REST API v1 (pretix 2023.7-2026.x)',
  'pretix Organizer Data Shredder-compatible JSON export',
] as const;

export const PRETIX_API_RESOURCE_PLAN = [
  {
    resource: 'organizers',
    path: '/api/v1/organizers/{organizer}/',
    scope: 'organizer',
  },
  {
    resource: 'events',
    path: '/api/v1/organizers/{organizer}/events/',
    scope: 'organizer',
  },
  {
    resource: 'quotas',
    path: '/api/v1/organizers/{organizer}/events/{event}/quotas/',
    scope: 'event',
  },
  {
    resource: 'items',
    path: '/api/v1/organizers/{organizer}/events/{event}/items/',
    scope: 'event',
  },
  {
    resource: 'questions',
    path: '/api/v1/organizers/{organizer}/events/{event}/questions/',
    scope: 'event',
  },
  {
    resource: 'vouchers',
    path: '/api/v1/organizers/{organizer}/events/{event}/vouchers/',
    scope: 'event',
  },
  {
    resource: 'orders',
    path: '/api/v1/organizers/{organizer}/events/{event}/orders/',
    scope: 'event',
  },
  {
    resource: 'payments',
    path: '/api/v1/organizers/{organizer}/events/{event}/orders/{order}/payments/',
    scope: 'order',
  },
  {
    resource: 'refunds',
    path: '/api/v1/organizers/{organizer}/events/{event}/orders/{order}/refunds/',
    scope: 'order',
  },
  {
    resource: 'checkins',
    path: '/api/v1/organizers/{organizer}/events/{event}/checkinlists/{list}/positions/',
    scope: 'event',
  },
] as const;

export type PretixResource = (typeof PRETIX_API_RESOURCE_PLAN)[number]['resource'];

export const PRETIX_FEATURE_MAPPING = {
  organizers: ['organization', 'brand'],
  events: ['venue', 'event', 'occurrence'],
  quotas: ['inventory-pool'],
  items: ['ticket-type', 'product'],
  questions: ['question'],
  vouchers: ['discount', 'access-code'],
  orders: ['buyer', 'attendee', 'historical-order', 'ticket'],
  payments: ['historical-payment'],
  refunds: ['historical-refund'],
  checkins: ['check-in'],
} as const satisfies Readonly<Record<PretixResource, readonly MigrationEntityType[]>>;

export const PRETIX_KNOWN_LOSSES = [
  'Assigned seating geometry is reported but not imported.',
  'Plugin-defined fields without a scalar export value require a bespoke mapper.',
  'Payment and refund records are historical snapshots and never generate provider-success events.',
] as const;

export const PRETIX_RATE_LIMIT_POLICY = {
  source: 'official REST API response headers',
  maximumAttempts: 6,
  retryStatuses: [429, 502, 503, 504],
  backoff: 'Honor Retry-After; otherwise deterministic exponential delay capped at 30 seconds.',
  credentialHandling:
    'Resolve credentials only in a non-replayable activity and never persist them.',
} as const;

export type PretixRecord = {
  resource: PretixResource;
  body: Readonly<Record<string, unknown>>;
};

export type PretixPage = {
  cursor: string;
  nextCursor?: string;
  records: readonly PretixRecord[];
};

export type PretixConfiguration = {
  sourceMode: 'official-api' | 'official-export';
  organizerSlug: string;
  sourceVersion: string;
  importedAt: string;
  pages: readonly PretixPage[];
  unsupportedFeatures?: readonly string[];
};

function object(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError(`${field} must be an object`);
  return value as Readonly<Record<string, unknown>>;
}

function text(body: Readonly<Record<string, unknown>>, field: string): string | undefined {
  const value = body[field];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function identifier(body: Readonly<Record<string, unknown>>, resource: PretixResource): string {
  const value =
    resource === 'organizers' || resource === 'events' ? body.slug : (body.id ?? body.code);
  if ((typeof value !== 'string' && typeof value !== 'number') || !String(value).trim())
    throw new TypeError(`pretix ${resource} record requires a stable official ID`);
  return String(value);
}

function externalId(
  configuration: PretixConfiguration,
  resource: PretixResource,
  id: string,
  type: MigrationEntityType,
): string {
  return `${configuration.organizerSlug}:${resource}:${id}:${type}`;
}

function dependency(
  configuration: PretixConfiguration,
  resource: PretixResource,
  id: unknown,
  entityType: MigrationEntityType,
) {
  if ((typeof id !== 'string' && typeof id !== 'number') || !String(id).trim()) return undefined;
  return {
    entityType,
    externalId: externalId(configuration, resource, String(id), entityType),
  };
}

function projectedRow(input: {
  configuration: PretixConfiguration;
  pageCursor: string;
  resource: PretixResource;
  sourceId: string;
  entityType: MigrationEntityType;
  attributes: Record<string, unknown>;
  dependencies?: readonly ({ entityType: MigrationEntityType; externalId: string } | undefined)[];
}): ExtractedMigrationRow {
  return {
    externalId: externalId(input.configuration, input.resource, input.sourceId, input.entityType),
    entityType: input.entityType,
    sourcePosition: `pretix:${input.pageCursor}:${input.resource}:${input.sourceId}:${input.entityType}`,
    data: {
      ...input.attributes,
      dependencies: input.dependencies?.filter(Boolean),
      _importedAt: input.configuration.importedAt,
    },
  };
}

function projectOfficialRecord(
  configuration: PretixConfiguration,
  pageCursor: string,
  record: PretixRecord,
): ExtractedMigrationRow[] {
  const body = object(record.body, `pretix ${record.resource} body`);
  const sourceId = identifier(body, record.resource);
  const event = body.event ?? body.event_slug;
  const organizer = configuration.organizerSlug;
  switch (record.resource) {
    case 'organizers':
      return [
        projectedRow({
          configuration,
          pageCursor,
          resource: record.resource,
          sourceId,
          entityType: 'organization',
          attributes: { name: text(body, 'name') },
        }),
        projectedRow({
          configuration,
          pageCursor,
          resource: record.resource,
          sourceId,
          entityType: 'brand',
          attributes: { name: text(body, 'name'), slug: sourceId },
        }),
      ];
    case 'events': {
      const venueId = body.venue_id;
      return [
        projectedRow({
          configuration,
          pageCursor,
          resource: record.resource,
          sourceId: String(venueId),
          entityType: 'venue',
          attributes: {
            name: text(body, 'venue_name') ?? `Venue ${String(venueId)}`,
            address: text(body, 'location'),
            timezone: text(body, 'timezone'),
          },
        }),
        projectedRow({
          configuration,
          pageCursor,
          resource: record.resource,
          sourceId,
          entityType: 'event',
          attributes: {
            title: text(body, 'name'),
            slug: sourceId,
            currency: text(body, 'currency')?.toUpperCase(),
            timezone: text(body, 'timezone'),
            startsAt: text(body, 'date_from'),
          },
          dependencies: [
            dependency(configuration, 'organizers', organizer, 'brand'),
            dependency(configuration, 'events', venueId, 'venue'),
          ],
        }),
        projectedRow({
          configuration,
          pageCursor,
          resource: record.resource,
          sourceId,
          entityType: 'occurrence',
          attributes: {
            title: text(body, 'name'),
            startsAt: text(body, 'date_from'),
            endsAt: text(body, 'date_to'),
            timezone: text(body, 'timezone'),
          },
          dependencies: [
            dependency(configuration, 'events', sourceId, 'event'),
            dependency(configuration, 'events', venueId, 'venue'),
          ],
        }),
      ];
    }
    case 'quotas':
      return [
        projectedRow({
          configuration,
          pageCursor,
          resource: record.resource,
          sourceId,
          entityType: 'inventory-pool',
          attributes: {
            name: text(body, 'name') ?? `Quota ${sourceId}`,
            totalCapacity: Number(body.size),
          },
          dependencies: [dependency(configuration, 'events', event, 'event')],
        }),
      ];
    case 'items': {
      const isAdmission = body.admission !== false;
      const entityType = isAdmission ? 'ticket-type' : 'product';
      return [
        projectedRow({
          configuration,
          pageCursor,
          resource: record.resource,
          sourceId,
          entityType,
          attributes: {
            name: text(body, 'name'),
            currency: text(body, 'currency')?.toUpperCase(),
            priceMinor: Number(body.price_minor ?? body.default_price),
          },
          dependencies: [
            dependency(configuration, 'events', event, 'event'),
            isAdmission
              ? dependency(configuration, 'quotas', body.quota_id, 'inventory-pool')
              : undefined,
            isAdmission ? dependency(configuration, 'events', event, 'occurrence') : undefined,
          ],
        }),
      ];
    }
    case 'questions':
      return [
        projectedRow({
          configuration,
          pageCursor,
          resource: record.resource,
          sourceId,
          entityType: 'question',
          attributes: {
            label: text(body, 'question'),
            type: text(body, 'type') ?? 'text',
          },
          dependencies: [
            dependency(configuration, 'events', event, 'event'),
            dependency(configuration, 'items', body.item_id, 'ticket-type'),
          ],
        }),
      ];
    case 'vouchers': {
      const entityType = body.access_only === true ? 'access-code' : 'discount';
      return [
        projectedRow({
          configuration,
          pageCursor,
          resource: record.resource,
          sourceId,
          entityType,
          attributes:
            entityType === 'access-code'
              ? { code: text(body, 'code') }
              : {
                  code: text(body, 'code'),
                  type: text(body, 'discount_mode') ?? 'percentage',
                  value: Number(body.value),
                  currency: text(body, 'currency')?.toUpperCase(),
                },
          dependencies:
            entityType === 'access-code'
              ? [dependency(configuration, 'items', body.item_id, 'ticket-type')]
              : [dependency(configuration, 'events', event, 'event')],
        }),
      ];
    }
    case 'orders': {
      const positions = Array.isArray(body.positions)
        ? body.positions.map((item) => object(item, 'pretix order position'))
        : [];
      if (positions.length !== 1)
        throw new TypeError('pretix fixture order must contain exactly one position');
      const position = positions[0]!;
      const attendeeId = String(position.id);
      const orderCode = text(body, 'code') ?? sourceId;
      const buyerEmail = text(body, 'email');
      return [
        projectedRow({
          configuration,
          pageCursor,
          resource: record.resource,
          sourceId: orderCode,
          entityType: 'buyer',
          attributes: { email: buyerEmail },
        }),
        projectedRow({
          configuration,
          pageCursor,
          resource: record.resource,
          sourceId: attendeeId,
          entityType: 'attendee',
          attributes: {
            email: text(position, 'attendee_email') ?? buyerEmail,
            firstName: text(position, 'attendee_name'),
          },
          dependencies: [
            dependency(configuration, 'events', event, 'event'),
            dependency(configuration, 'items', position.item, 'ticket-type'),
            dependency(configuration, 'events', event, 'occurrence'),
          ],
        }),
        projectedRow({
          configuration,
          pageCursor,
          resource: record.resource,
          sourceId: orderCode,
          entityType: 'historical-order',
          attributes: {
            orderNumber: orderCode,
            currency: text(body, 'currency')?.toUpperCase(),
            totalMinor: Number(body.total_minor),
            buyerEmail,
          },
          dependencies: [
            dependency(configuration, 'organizers', organizer, 'brand'),
            dependency(configuration, 'events', event, 'event'),
            dependency(configuration, 'orders', attendeeId, 'attendee'),
          ],
        }),
        projectedRow({
          configuration,
          pageCursor,
          resource: record.resource,
          sourceId: attendeeId,
          entityType: 'ticket',
          attributes: { code: text(position, 'secret') },
          dependencies: [
            dependency(configuration, 'events', event, 'event'),
            dependency(configuration, 'items', position.item, 'ticket-type'),
            dependency(configuration, 'orders', attendeeId, 'attendee'),
            dependency(configuration, 'orders', orderCode, 'historical-order'),
            dependency(configuration, 'events', event, 'occurrence'),
          ],
        }),
      ];
    }
    case 'payments':
    case 'refunds': {
      const entityType =
        record.resource === 'payments' ? 'historical-payment' : 'historical-refund';
      return [
        projectedRow({
          configuration,
          pageCursor,
          resource: record.resource,
          sourceId,
          entityType,
          attributes: {
            amountMinor: Number(body.amount_minor ?? body.amount),
            currency: text(body, 'currency')?.toUpperCase(),
            occurredAt: text(body, 'created'),
            providerReference: text(body, 'provider_reference'),
          },
          dependencies: [dependency(configuration, 'orders', body.order, 'historical-order')],
        }),
      ];
    }
    case 'checkins':
      return [
        projectedRow({
          configuration,
          pageCursor,
          resource: record.resource,
          sourceId,
          entityType: 'check-in',
          attributes: {
            occurredAt: text(body, 'datetime'),
            result: body.type === 'exit' ? 'rejected' : 'accepted',
          },
          dependencies: [dependency(configuration, 'orders', body.position_id, 'ticket')],
        }),
      ];
  }
}

function requireConfiguration(configuration: PretixConfiguration): void {
  if (!configuration || typeof configuration !== 'object')
    throw new TypeError('pretix configuration must be an object');
  if (configuration.sourceMode !== 'official-api' && configuration.sourceMode !== 'official-export')
    throw new TypeError('pretix sourceMode is invalid');
  if (typeof configuration.organizerSlug !== 'string' || !configuration.organizerSlug.trim())
    throw new TypeError('organizerSlug is required');
  if (
    typeof configuration.sourceVersion !== 'string' ||
    !/^(?:202[3-6]|\d{2,})\./u.test(configuration.sourceVersion)
  )
    throw new TypeError(`Unsupported pretix source version: ${configuration.sourceVersion}`);
  if (
    typeof configuration.importedAt !== 'string' ||
    !Number.isFinite(Date.parse(configuration.importedAt))
  )
    throw new TypeError('importedAt must be an ISO timestamp');
  if (!Array.isArray(configuration.pages) || configuration.pages.length === 0)
    throw new TypeError('pretix pages cannot be empty');
  const cursors = new Set<string>();
  for (const page of configuration.pages) {
    if (!page || typeof page.cursor !== 'string' || !page.cursor || cursors.has(page.cursor))
      throw new TypeError('pretix page cursors must be non-empty and unique');
    if (!Array.isArray(page.records)) throw new TypeError('pretix page records must be an array');
    cursors.add(page.cursor);
    if (page.records.length === 0 && page.nextCursor)
      throw new TypeError(`pretix page ${page.cursor} cannot be empty before the final page`);
    for (const record of page.records) {
      if (!record || !PRETIX_API_RESOURCE_PLAN.some(({ resource }) => resource === record.resource))
        throw new TypeError(`unsupported pretix resource: ${String(record?.resource)}`);
      object(record.body, `pretix ${record.resource} body`);
      identifier(record.body, record.resource);
    }
  }
  const reached = new Set<string>();
  let cursor: string | undefined = configuration.pages[0]?.cursor;
  while (cursor) {
    if (reached.has(cursor)) throw new TypeError(`pretix page cursor cycle at ${cursor}`);
    reached.add(cursor);
    const page = configuration.pages.find((candidate) => candidate.cursor === cursor);
    if (!page) throw new TypeError(`pretix page references unknown cursor: ${cursor}`);
    cursor = page.nextCursor;
  }
  if (reached.size !== configuration.pages.length)
    throw new TypeError('pretix page graph contains unreachable pages');
}

function projectedPages(configuration: PretixConfiguration) {
  return configuration.pages.map((page) => ({
    ...page,
    rows: page.records.flatMap((record) =>
      projectOfficialRecord(configuration, page.cursor, record),
    ),
  }));
}

function decodeCursor(cursor: string): { pageCursor: string; offset: number } {
  const match = /^(.*)#offset=(\d+)$/u.exec(cursor);
  return match
    ? { pageCursor: match[1]!, offset: Number(match[2]) }
    : { pageCursor: cursor, offset: 0 };
}

function dependencies(
  data: Readonly<Record<string, unknown>>,
): NormalizedMigrationEntity['dependencies'] {
  return Array.isArray(data.dependencies)
    ? (data.dependencies as NormalizedMigrationEntity['dependencies'])
    : undefined;
}

export class PretixMigrationAdapter implements MigrationAdapter<PretixConfiguration, string> {
  readonly id = 'pretix';
  readonly supportedVersions = PRETIX_SUPPORTED_VERSIONS;

  async discover(
    configuration: PretixConfiguration,
    context: AdapterContext,
  ): Promise<MigrationDiscovery> {
    requireConfiguration(configuration);
    context.signal?.throwIfAborted();
    const counts = new Map<MigrationEntityType, number>();
    for (const { rows } of projectedPages(configuration))
      for (const projected of rows)
        counts.set(projected.entityType, (counts.get(projected.entityType) ?? 0) + 1);
    return {
      source: {
        sourceSystem: this.id,
        sourceVersion: configuration.sourceVersion,
        accountId: configuration.organizerSlug,
      },
      entities: MIGRATION_ENTITY_DEPENDENCY_ORDER.filter((type) => counts.has(type)).map(
        (type) => ({ type, estimatedRows: counts.get(type) }),
      ),
      unsupportedFeatures: [...PRETIX_KNOWN_LOSSES, ...(configuration.unsupportedFeatures ?? [])],
    };
  }

  async extract(input: {
    configuration: PretixConfiguration;
    discovery: MigrationDiscovery;
    cursor?: string;
    limit: number;
    context: AdapterContext;
  }): Promise<{ rows: readonly ExtractedMigrationRow[]; nextCursor?: string }> {
    requireConfiguration(input.configuration);
    input.context.signal?.throwIfAborted();
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100)
      throw new RangeError('pretix extraction limit must be between 1 and 100');
    if (input.discovery.source.sourceSystem !== this.id)
      throw new TypeError('discovery does not belong to the pretix adapter');
    const pages = projectedPages(input.configuration);
    const decoded = decodeCursor(input.cursor ?? pages[0]!.cursor);
    const page = pages.find(({ cursor }) => cursor === decoded.pageCursor);
    if (!page) throw new TypeError(`unknown pretix cursor: ${decoded.pageCursor}`);
    if (
      !Number.isSafeInteger(decoded.offset) ||
      decoded.offset < 0 ||
      decoded.offset > page.rows.length
    )
      throw new RangeError('pretix cursor offset is out of range');
    const rows = page.rows.slice(decoded.offset, decoded.offset + input.limit);
    const nextOffset = decoded.offset + rows.length;
    return {
      rows,
      nextCursor:
        nextOffset < page.rows.length ? `${page.cursor}#offset=${nextOffset}` : page.nextCursor,
    };
  }

  async normalize(
    row: ExtractedMigrationRow,
    context: AdapterContext,
  ): Promise<NormalizedMigrationEntity> {
    context.signal?.throwIfAborted();
    const attributes = Object.fromEntries(
      Object.entries(row.data).filter(([key]) => !key.startsWith('_') && key !== 'dependencies'),
    );
    const importedAt = text(row.data, '_importedAt');
    const financialKind =
      row.entityType === 'historical-payment' || row.entityType === 'historical-refund'
        ? row.entityType
        : undefined;
    return {
      externalId: row.externalId,
      entityType: row.entityType,
      sourcePosition: row.sourcePosition,
      attributes,
      dependencies: dependencies(row.data),
      financialSnapshot:
        financialKind && importedAt
          ? createHistoricalFinancialSnapshot({
              kind: financialKind,
              amountMinor: Number(row.data.amountMinor),
              currency: String(row.data.currency),
              occurredAt: String(row.data.occurredAt),
              providerReference: text(row.data, 'providerReference'),
              provenance: {
                sourceSystem: this.id,
                sourceExternalId: row.externalId,
                importedAt,
              },
              reconciliationStatus: 'unreconciled',
            })
          : undefined,
    };
  }

  async validate(
    entity: NormalizedMigrationEntity,
    context: AdapterContext,
  ): Promise<readonly MigrationIssue[]> {
    context.signal?.throwIfAborted();
    return validateCanonicalMigrationEntity(entity);
  }
}

export const pretixMigrationAdapter = new PretixMigrationAdapter();
