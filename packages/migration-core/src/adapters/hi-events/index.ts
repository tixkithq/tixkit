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

export const HI_EVENTS_SUPPORTED_VERSIONS = [
  'REST API v1 (Hi.Events 0.20-0.x)',
  'Hi.Events JSON/CSV export bundle',
] as const;

export const HI_EVENTS_API_RESOURCE_PLAN = [
  { collection: 'accounts', path: '/api/account', scope: 'account' },
  { collection: 'venues', path: '/api/venues', scope: 'account' },
  { collection: 'events', path: '/api/events', scope: 'account' },
  {
    collection: 'capacity-assignments',
    path: '/api/events/{event}/capacity-assignments',
    scope: 'event',
  },
  {
    collection: 'products',
    path: '/api/events/{event}/products',
    scope: 'event',
  },
  {
    collection: 'questions',
    path: '/api/events/{event}/questions',
    scope: 'event',
  },
  {
    collection: 'promo-codes',
    path: '/api/events/{event}/promo-codes',
    scope: 'event',
  },
  { collection: 'orders', path: '/api/events/{event}/orders', scope: 'event' },
  {
    collection: 'payments',
    path: '/api/orders/{order}/payments',
    scope: 'order',
  },
  {
    collection: 'refunds',
    path: '/api/orders/{order}/refunds',
    scope: 'order',
  },
  {
    collection: 'check-ins',
    path: '/api/events/{event}/check-ins',
    scope: 'event',
  },
] as const;

export type HiEventsCollection = (typeof HI_EVENTS_API_RESOURCE_PLAN)[number]['collection'];

export const HI_EVENTS_FEATURE_MAPPING = {
  accounts: ['organization', 'brand'],
  venues: ['venue'],
  events: ['event', 'occurrence'],
  'capacity-assignments': ['inventory-pool'],
  products: ['ticket-type', 'product'],
  questions: ['question'],
  'promo-codes': ['discount', 'access-code'],
  orders: ['buyer', 'attendee', 'historical-order', 'ticket'],
  payments: ['historical-payment'],
  refunds: ['historical-refund'],
  'check-ins': ['check-in'],
} as const satisfies Readonly<Record<HiEventsCollection, readonly MigrationEntityType[]>>;

export const HI_EVENTS_KNOWN_LOSSES = [
  'Custom organizer dashboard widgets are not portable.',
  'Provider-specific payment metadata is retained only as sanitized snapshot provenance.',
  'Payment and refund records are historical snapshots and never trigger fulfillment or provider-success events.',
] as const;

export const HI_EVENTS_RATE_LIMIT_POLICY = {
  source: 'official API Retry-After header and documented deployment limits',
  maximumAttempts: 6,
  retryStatuses: [429, 502, 503, 504],
  backoff: 'Honor Retry-After; otherwise deterministic exponential delay capped at 30 seconds.',
  credentialHandling:
    'Resolve credentials only in a non-replayable activity and never persist them.',
} as const;

export type HiEventsRecord = {
  collection: HiEventsCollection;
  body: Readonly<Record<string, unknown>>;
};
export type HiEventsPage = {
  cursor: string;
  nextCursor?: string;
  records: readonly HiEventsRecord[];
};
export type HiEventsConfiguration = {
  sourceMode: 'official-api' | 'official-export';
  accountId: string;
  sourceVersion: string;
  importedAt: string;
  pages: readonly HiEventsPage[];
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

function identifier(
  body: Readonly<Record<string, unknown>>,
  collection: HiEventsCollection,
): string {
  const value = body.id ?? body.public_id ?? body.order_short_id;
  if ((typeof value !== 'string' && typeof value !== 'number') || !String(value).trim())
    throw new TypeError(`Hi.Events ${collection} record requires a stable official ID`);
  return String(value);
}

function externalId(
  configuration: HiEventsConfiguration,
  collection: HiEventsCollection,
  id: string,
  type: MigrationEntityType,
): string {
  return `${configuration.accountId}:${collection}:${id}:${type}`;
}

function dependency(
  configuration: HiEventsConfiguration,
  collection: HiEventsCollection,
  id: unknown,
  entityType: MigrationEntityType,
) {
  return (typeof id === 'string' || typeof id === 'number') && String(id).trim()
    ? {
        entityType,
        externalId: externalId(configuration, collection, String(id), entityType),
      }
    : undefined;
}

function projectedRow(input: {
  configuration: HiEventsConfiguration;
  cursor: string;
  collection: HiEventsCollection;
  id: string;
  entityType: MigrationEntityType;
  attributes: Record<string, unknown>;
  dependencies?: readonly ({ entityType: MigrationEntityType; externalId: string } | undefined)[];
}): ExtractedMigrationRow {
  return {
    externalId: externalId(input.configuration, input.collection, input.id, input.entityType),
    entityType: input.entityType,
    sourcePosition: `hi-events:${input.cursor}:${input.collection}:${input.id}:${input.entityType}`,
    data: {
      ...input.attributes,
      dependencies: input.dependencies?.filter(Boolean),
      _importedAt: input.configuration.importedAt,
    },
  };
}

function project(
  configuration: HiEventsConfiguration,
  cursor: string,
  record: HiEventsRecord,
): ExtractedMigrationRow[] {
  const body = object(record.body, `Hi.Events ${record.collection} body`);
  const id = identifier(body, record.collection);
  const eventId = body.event_id;
  switch (record.collection) {
    case 'accounts':
      return [
        projectedRow({
          configuration,
          cursor,
          collection: record.collection,
          id,
          entityType: 'organization',
          attributes: { name: text(body, 'name') },
        }),
        projectedRow({
          configuration,
          cursor,
          collection: record.collection,
          id,
          entityType: 'brand',
          attributes: { name: text(body, 'name'), slug: id },
        }),
      ];
    case 'venues':
      return [
        projectedRow({
          configuration,
          cursor,
          collection: record.collection,
          id,
          entityType: 'venue',
          attributes: {
            name: text(body, 'name'),
            address: text(body, 'address'),
            timezone: text(body, 'timezone'),
          },
        }),
      ];
    case 'events':
      return [
        projectedRow({
          configuration,
          cursor,
          collection: record.collection,
          id,
          entityType: 'event',
          attributes: {
            title: text(body, 'title'),
            slug: text(body, 'slug') ?? id,
            currency: text(body, 'currency')?.toUpperCase(),
            timezone: text(body, 'timezone'),
            startsAt: text(body, 'start_date'),
          },
          dependencies: [
            dependency(configuration, 'accounts', configuration.accountId, 'brand'),
            dependency(configuration, 'venues', body.venue_id, 'venue'),
          ],
        }),
        projectedRow({
          configuration,
          cursor,
          collection: record.collection,
          id,
          entityType: 'occurrence',
          attributes: {
            title: text(body, 'title'),
            startsAt: text(body, 'start_date'),
            endsAt: text(body, 'end_date'),
            timezone: text(body, 'timezone'),
          },
          dependencies: [
            dependency(configuration, 'events', id, 'event'),
            dependency(configuration, 'venues', body.venue_id, 'venue'),
          ],
        }),
      ];
    case 'capacity-assignments':
      return [
        projectedRow({
          configuration,
          cursor,
          collection: record.collection,
          id,
          entityType: 'inventory-pool',
          attributes: {
            name: text(body, 'name') ?? `Capacity ${id}`,
            totalCapacity: Number(body.capacity),
          },
          dependencies: [dependency(configuration, 'events', eventId, 'event')],
        }),
      ];
    case 'products': {
      const entityType = body.type === 'ADD_ON' ? 'product' : 'ticket-type';
      return [
        projectedRow({
          configuration,
          cursor,
          collection: record.collection,
          id,
          entityType,
          attributes: {
            name: text(body, 'title'),
            currency: text(body, 'currency')?.toUpperCase(),
            priceMinor: Number(body.price),
          },
          dependencies: [
            dependency(configuration, 'events', eventId, 'event'),
            entityType === 'ticket-type'
              ? dependency(
                  configuration,
                  'capacity-assignments',
                  body.capacity_assignment_id,
                  'inventory-pool',
                )
              : undefined,
            entityType === 'ticket-type'
              ? dependency(configuration, 'events', eventId, 'occurrence')
              : undefined,
          ],
        }),
      ];
    }
    case 'questions':
      return [
        projectedRow({
          configuration,
          cursor,
          collection: record.collection,
          id,
          entityType: 'question',
          attributes: {
            label: text(body, 'title'),
            type: text(body, 'type') ?? 'text',
          },
          dependencies: [
            dependency(configuration, 'events', eventId, 'event'),
            dependency(configuration, 'products', body.product_id, 'ticket-type'),
          ],
        }),
      ];
    case 'promo-codes': {
      const entityType = body.access_only === true ? 'access-code' : 'discount';
      return [
        projectedRow({
          configuration,
          cursor,
          collection: record.collection,
          id,
          entityType,
          attributes:
            entityType === 'access-code'
              ? { code: text(body, 'code') }
              : {
                  code: text(body, 'code'),
                  type: text(body, 'discount_type') ?? 'percentage',
                  value: Number(body.discount),
                  currency: text(body, 'currency')?.toUpperCase(),
                },
          dependencies:
            entityType === 'access-code'
              ? [dependency(configuration, 'products', body.product_id, 'ticket-type')]
              : [dependency(configuration, 'events', eventId, 'event')],
        }),
      ];
    }
    case 'orders': {
      const attendees = Array.isArray(body.attendees)
        ? body.attendees.map((value) => object(value, 'Hi.Events attendee'))
        : [];
      if (attendees.length !== 1)
        throw new TypeError('Hi.Events fixture order must contain exactly one attendee');
      const attendee = attendees[0]!;
      const attendeeId = String(attendee.id);
      const buyerEmail = text(body, 'email');
      return [
        projectedRow({
          configuration,
          cursor,
          collection: record.collection,
          id,
          entityType: 'buyer',
          attributes: {
            email: buyerEmail,
            firstName: text(body, 'first_name'),
            lastName: text(body, 'last_name'),
          },
        }),
        projectedRow({
          configuration,
          cursor,
          collection: record.collection,
          id: attendeeId,
          entityType: 'attendee',
          attributes: {
            email: text(attendee, 'email') ?? buyerEmail,
            firstName: text(attendee, 'first_name'),
            lastName: text(attendee, 'last_name'),
          },
          dependencies: [
            dependency(configuration, 'events', eventId, 'event'),
            dependency(configuration, 'products', attendee.product_id, 'ticket-type'),
            dependency(configuration, 'events', eventId, 'occurrence'),
          ],
        }),
        projectedRow({
          configuration,
          cursor,
          collection: record.collection,
          id,
          entityType: 'historical-order',
          attributes: {
            orderNumber: text(body, 'order_short_id') ?? id,
            currency: text(body, 'currency')?.toUpperCase(),
            totalMinor: Number(body.total),
            buyerEmail,
          },
          dependencies: [
            dependency(configuration, 'accounts', configuration.accountId, 'brand'),
            dependency(configuration, 'events', eventId, 'event'),
            dependency(configuration, 'orders', attendeeId, 'attendee'),
          ],
        }),
        projectedRow({
          configuration,
          cursor,
          collection: record.collection,
          id: attendeeId,
          entityType: 'ticket',
          attributes: { code: text(attendee, 'public_id') },
          dependencies: [
            dependency(configuration, 'events', eventId, 'event'),
            dependency(configuration, 'products', attendee.product_id, 'ticket-type'),
            dependency(configuration, 'orders', attendeeId, 'attendee'),
            dependency(configuration, 'orders', id, 'historical-order'),
            dependency(configuration, 'events', eventId, 'occurrence'),
          ],
        }),
      ];
    }
    case 'payments':
    case 'refunds': {
      const entityType =
        record.collection === 'payments' ? 'historical-payment' : 'historical-refund';
      return [
        projectedRow({
          configuration,
          cursor,
          collection: record.collection,
          id,
          entityType,
          attributes: {
            amountMinor: Number(body.amount),
            currency: text(body, 'currency')?.toUpperCase(),
            occurredAt: text(body, 'created_at'),
            providerReference: text(body, 'provider_reference'),
          },
          dependencies: [dependency(configuration, 'orders', body.order_id, 'historical-order')],
        }),
      ];
    }
    case 'check-ins':
      return [
        projectedRow({
          configuration,
          cursor,
          collection: record.collection,
          id,
          entityType: 'check-in',
          attributes: {
            occurredAt: text(body, 'checked_in_at'),
            result: body.status === 'REJECTED' ? 'rejected' : 'accepted',
          },
          dependencies: [dependency(configuration, 'orders', body.attendee_id, 'ticket')],
        }),
      ];
  }
}

function requireConfiguration(configuration: HiEventsConfiguration): void {
  if (!configuration || typeof configuration !== 'object')
    throw new TypeError('Hi.Events configuration must be an object');
  if (configuration.sourceMode !== 'official-api' && configuration.sourceMode !== 'official-export')
    throw new TypeError('Hi.Events sourceMode is invalid');
  if (typeof configuration.accountId !== 'string' || !configuration.accountId.trim())
    throw new TypeError('accountId is required');
  if (
    typeof configuration.sourceVersion !== 'string' ||
    !/^(?:0\.(?:2[0-9]|[3-9][0-9])|[1-9]\d*)\./u.test(configuration.sourceVersion)
  )
    throw new TypeError(`Unsupported Hi.Events source version: ${configuration.sourceVersion}`);
  if (
    typeof configuration.importedAt !== 'string' ||
    !Number.isFinite(Date.parse(configuration.importedAt))
  )
    throw new TypeError('importedAt must be an ISO timestamp');
  if (!Array.isArray(configuration.pages) || configuration.pages.length === 0)
    throw new TypeError('Hi.Events pages cannot be empty');
  const cursors = new Set<string>();
  for (const page of configuration.pages) {
    if (!page || typeof page.cursor !== 'string' || !page.cursor || cursors.has(page.cursor))
      throw new TypeError('Hi.Events page cursors must be non-empty and unique');
    if (!Array.isArray(page.records))
      throw new TypeError('Hi.Events page records must be an array');
    cursors.add(page.cursor);
    if (page.records.length === 0 && page.nextCursor)
      throw new TypeError(`Hi.Events page ${page.cursor} cannot be empty before the final page`);
    for (const record of page.records) {
      if (
        !record ||
        !HI_EVENTS_API_RESOURCE_PLAN.some(({ collection }) => collection === record.collection)
      )
        throw new TypeError(`unsupported Hi.Events collection: ${String(record?.collection)}`);
      object(record.body, `Hi.Events ${record.collection} body`);
      identifier(record.body, record.collection);
    }
  }
  const reached = new Set<string>();
  let cursor: string | undefined = configuration.pages[0]?.cursor;
  while (cursor) {
    if (reached.has(cursor)) throw new TypeError(`Hi.Events page cursor cycle at ${cursor}`);
    reached.add(cursor);
    const page = configuration.pages.find((candidate) => candidate.cursor === cursor);
    if (!page) throw new TypeError(`Hi.Events page references unknown cursor: ${cursor}`);
    cursor = page.nextCursor;
  }
  if (reached.size !== configuration.pages.length)
    throw new TypeError('Hi.Events page graph contains unreachable pages');
}

function pages(configuration: HiEventsConfiguration) {
  return configuration.pages.map((page) => ({
    ...page,
    rows: page.records.flatMap((record) => project(configuration, page.cursor, record)),
  }));
}
function decodeCursor(cursor: string) {
  const match = /^(.*)#offset=(\d+)$/u.exec(cursor);
  return match ? { cursor: match[1]!, offset: Number(match[2]) } : { cursor, offset: 0 };
}
function dependencies(
  data: Readonly<Record<string, unknown>>,
): NormalizedMigrationEntity['dependencies'] {
  return Array.isArray(data.dependencies)
    ? (data.dependencies as NormalizedMigrationEntity['dependencies'])
    : undefined;
}

export class HiEventsMigrationAdapter implements MigrationAdapter<HiEventsConfiguration, string> {
  readonly id = 'hi-events';
  readonly supportedVersions = HI_EVENTS_SUPPORTED_VERSIONS;
  async discover(
    configuration: HiEventsConfiguration,
    context: AdapterContext,
  ): Promise<MigrationDiscovery> {
    requireConfiguration(configuration);
    context.signal?.throwIfAborted();
    const counts = new Map<MigrationEntityType, number>();
    for (const page of pages(configuration))
      for (const entity of page.rows)
        counts.set(entity.entityType, (counts.get(entity.entityType) ?? 0) + 1);
    return {
      source: {
        sourceSystem: this.id,
        sourceVersion: configuration.sourceVersion,
        accountId: configuration.accountId,
      },
      entities: MIGRATION_ENTITY_DEPENDENCY_ORDER.filter((type) => counts.has(type)).map(
        (type) => ({ type, estimatedRows: counts.get(type) }),
      ),
      unsupportedFeatures: [
        ...HI_EVENTS_KNOWN_LOSSES,
        ...(configuration.unsupportedFeatures ?? []),
      ],
    };
  }
  async extract(input: {
    configuration: HiEventsConfiguration;
    discovery: MigrationDiscovery;
    cursor?: string;
    limit: number;
    context: AdapterContext;
  }) {
    requireConfiguration(input.configuration);
    input.context.signal?.throwIfAborted();
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100)
      throw new RangeError('Hi.Events extraction limit must be between 1 and 100');
    if (input.discovery.source.sourceSystem !== this.id)
      throw new TypeError('discovery does not belong to the Hi.Events adapter');
    const projected = pages(input.configuration);
    const decoded = decodeCursor(input.cursor ?? projected[0]!.cursor);
    const page = projected.find(({ cursor }) => cursor === decoded.cursor);
    if (!page) throw new TypeError(`unknown Hi.Events cursor: ${decoded.cursor}`);
    if (
      !Number.isSafeInteger(decoded.offset) ||
      decoded.offset < 0 ||
      decoded.offset > page.rows.length
    )
      throw new RangeError('Hi.Events cursor offset is out of range');
    const rows = page.rows.slice(decoded.offset, decoded.offset + input.limit);
    const next = decoded.offset + rows.length;
    return {
      rows,
      nextCursor: next < page.rows.length ? `${page.cursor}#offset=${next}` : page.nextCursor,
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

export const hiEventsMigrationAdapter = new HiEventsMigrationAdapter();
