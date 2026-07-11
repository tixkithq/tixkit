import {
  createHistoricalFinancialSnapshot,
  validateCanonicalMigrationEntity,
  type ExtractedMigrationRow,
  type MigrationAdapter,
  type MigrationDiscovery,
  type MigrationEntityType,
  type MigrationIssue,
  type NormalizedMigrationEntity,
} from '../../index.js';

export const TICKET_TAILOR_ADAPTER_METADATA = {
  supportedVersions: [
    'Ticket Tailor API v1',
    'Ticket Tailor Orders export 2024-01 through 2026-07',
  ],
  featureMap: {
    event: 'event',
    ticket_type: 'ticket-type',
    order: 'historical-order',
    issued_ticket: 'ticket',
    voucher: 'discount',
    check_in: 'check-in',
    payment: 'historical-payment',
    refund: 'historical-refund',
  },
  knownLosses: [
    'Ticket Tailor waitlist notification history and broadcast audiences are not imported.',
    'Custom checkout form layout is flattened into question records by the migration platform.',
    'Historical payment and refund records remain side-effect-suppressed snapshots.',
  ],
  rateLimits: {
    strategy:
      'follow Link/next cursor pagination, honor Retry-After, and retry 429/5xx with deterministic bounded exponential delay',
    maximumPageSize: 100,
  },
} as const;

export type TicketTailorRecord = {
  resource: keyof typeof TICKET_TAILOR_ADAPTER_METADATA.featureMap;
  id: string;
  body: Readonly<Record<string, unknown>>;
};

export type TicketTailorConfiguration = {
  accountId: string;
  records: readonly TicketTailorRecord[];
  sourceVersion?: string;
  importedAt: string;
};

function text(value: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const candidate = value[key];
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : undefined;
}

function dependencies(
  body: Readonly<Record<string, unknown>>,
  pairs: readonly [string, MigrationEntityType][],
) {
  return pairs.flatMap(([field, entityType]) => {
    const externalId = text(body, field);
    return externalId ? [{ entityType, externalId }] : [];
  });
}

function assertConfiguration(configuration: TicketTailorConfiguration): void {
  if (!configuration || typeof configuration !== 'object')
    throw new TypeError('Ticket Tailor configuration must be an object');
  if (typeof configuration.accountId !== 'string' || !configuration.accountId.trim())
    throw new TypeError('accountId is required');
  if (configuration.sourceVersion !== undefined && configuration.sourceVersion !== 'v1')
    throw new TypeError(`unsupported Ticket Tailor source version: ${configuration.sourceVersion}`);
  if (
    typeof configuration.importedAt !== 'string' ||
    !Number.isFinite(Date.parse(configuration.importedAt))
  )
    throw new TypeError('importedAt must be an ISO timestamp');
  if (!Array.isArray(configuration.records))
    throw new TypeError('Ticket Tailor records must be an array');
  const keys = new Set<string>();
  for (const record of configuration.records) {
    if (!record || typeof record !== 'object' || !record.body || typeof record.body !== 'object')
      throw new TypeError('Ticket Tailor records and bodies must be objects');
    if (!(record.resource in TICKET_TAILOR_ADAPTER_METADATA.featureMap))
      throw new TypeError(`unsupported Ticket Tailor resource: ${record.resource}`);
    if (typeof record.id !== 'string' || !record.id.trim())
      throw new TypeError('record id is required');
    const key = `${record.resource}:${record.id}`;
    if (keys.has(key)) throw new TypeError(`duplicate Ticket Tailor record: ${key}`);
    keys.add(key);
  }
}

function cursorOffset(cursor: string | undefined, maximum: number): number {
  if (!cursor) return 0;
  const match = /^ticket-tailor-v1:(\d+)$/u.exec(cursor);
  if (!match) throw new TypeError('invalid Ticket Tailor cursor');
  const offset = Number(match[1]);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > maximum)
    throw new RangeError('Ticket Tailor cursor is out of range');
  return offset;
}

export const ticketTailorAdapter: MigrationAdapter<TicketTailorConfiguration, string> = {
  id: 'ticket-tailor',
  supportedVersions: TICKET_TAILOR_ADAPTER_METADATA.supportedVersions,

  async discover(configuration): Promise<MigrationDiscovery> {
    assertConfiguration(configuration);
    const counts = new Map<MigrationEntityType, number>();
    for (const record of configuration.records) {
      const type = TICKET_TAILOR_ADAPTER_METADATA.featureMap[record.resource];
      counts.set(type, (counts.get(type) ?? 0) + 1);
    }
    return {
      source: {
        sourceSystem: 'ticket-tailor',
        sourceVersion: configuration.sourceVersion ?? 'v1',
        accountId: configuration.accountId,
      },
      entities: [...counts].map(([type, estimatedRows]) => ({
        type,
        estimatedRows,
      })),
      unsupportedFeatures: TICKET_TAILOR_ADAPTER_METADATA.knownLosses,
    };
  },

  async extract({ configuration, cursor, limit, context }) {
    assertConfiguration(configuration);
    if (context.signal?.aborted) throw context.signal.reason;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > TICKET_TAILOR_ADAPTER_METADATA.rateLimits.maximumPageSize
    )
      throw new RangeError('Ticket Tailor extraction limit must be between 1 and 100');
    const offset = cursorOffset(cursor, configuration.records.length);
    const selected = configuration.records.slice(offset, offset + limit);
    const rows = selected.flatMap((record, index): ExtractedMigrationRow[] => {
      const ticket: ExtractedMigrationRow = {
        externalId: record.id,
        entityType: TICKET_TAILOR_ADAPTER_METADATA.featureMap[record.resource],
        sourcePosition: `ticket-tailor:${record.resource}:${offset + index}`,
        data: {
          ...record.body,
          migrationResource: record.resource,
          migrationImportedAt: configuration.importedAt,
        },
      };
      return record.resource === 'issued_ticket'
        ? [
            {
              ...ticket,
              externalId: `${record.id}:attendee`,
              entityType: 'attendee',
              data: {
                ...ticket.data,
                migrationResource: 'issued_ticket_attendee',
              },
            },
            ticket,
          ]
        : [ticket];
    });
    const next = offset + selected.length;
    return {
      rows,
      nextCursor: next < configuration.records.length ? `ticket-tailor-v1:${next}` : undefined,
    };
  },

  async normalize(row): Promise<NormalizedMigrationEntity> {
    const body = row.data;
    const resource = text(body, 'migrationResource');
    if (
      !resource ||
      (resource !== 'issued_ticket_attendee' &&
        !(resource in TICKET_TAILOR_ADAPTER_METADATA.featureMap)) ||
      (resource !== 'issued_ticket_attendee' &&
        TICKET_TAILOR_ADAPTER_METADATA.featureMap[
          resource as keyof typeof TICKET_TAILOR_ADAPTER_METADATA.featureMap
        ] !== row.entityType)
    )
      throw new TypeError('Ticket Tailor resource does not match entity type');
    const dependencyPairs: readonly [string, MigrationEntityType][] =
      row.entityType === 'attendee'
        ? [
            ['event_id', 'event'],
            ['ticket_type_id', 'ticket-type'],
          ]
        : row.entityType === 'event'
          ? [['brand_id', 'brand']]
          : row.entityType === 'ticket-type'
            ? [
                ['event_id', 'event'],
                ['inventory_pool_id', 'inventory-pool'],
              ]
            : row.entityType === 'historical-order'
              ? [
                  ['brand_id', 'brand'],
                  ['event_id', 'event'],
                  ['attendee_id', 'attendee'],
                ]
              : row.entityType === 'ticket'
                ? [
                    ['order_id', 'historical-order'],
                    ['event_id', 'event'],
                    ['ticket_type_id', 'ticket-type'],
                    ['attendee_id', 'attendee'],
                  ]
                : row.entityType === 'check-in'
                  ? [['issued_ticket_id', 'ticket']]
                  : row.entityType === 'historical-payment' ||
                      row.entityType === 'historical-refund'
                    ? [['order_id', 'historical-order']]
                    : [];
    const attributes: Record<string, unknown> = Object.fromEntries(
      Object.entries(body).filter(([key]) => !key.startsWith('migration')),
    );
    if (row.entityType === 'attendee') attributes.email = text(body, 'attendee_email');
    else if (row.entityType === 'event') {
      attributes.title = text(body, 'name');
      attributes.startsAt = text(body, 'start');
      attributes.timezone = text(body, 'timezone');
    } else if (row.entityType === 'ticket-type') attributes.priceMinor = Number(body.price_minor);
    else if (row.entityType === 'historical-order') {
      attributes.orderNumber = text(body, 'order_number');
      attributes.totalMinor = Number(body.total_minor);
      attributes.buyerEmail = text(body, 'buyer_email');
    } else if (row.entityType === 'ticket') attributes.code = text(body, 'barcode');
    else if (row.entityType === 'check-in') attributes.occurredAt = text(body, 'checked_in_at');
    const entity: NormalizedMigrationEntity = {
      ...row,
      attributes,
      dependencies: dependencies(body, dependencyPairs),
    };
    if (row.entityType !== 'historical-payment' && row.entityType !== 'historical-refund')
      return entity;
    return {
      ...entity,
      financialSnapshot: createHistoricalFinancialSnapshot({
        kind: row.entityType,
        amountMinor: Number(body.total),
        currency: String(body.currency).toUpperCase(),
        providerReference: text(body, 'transaction_id'),
        occurredAt: String(body.created_at),
        provenance: {
          sourceSystem: 'ticket-tailor',
          sourceExternalId: row.externalId,
          importedAt: String(body.migrationImportedAt),
        },
        reconciliationStatus: 'unreconciled',
      }),
    };
  },

  async validate(entity): Promise<readonly MigrationIssue[]> {
    const required =
      entity.entityType === 'event'
        ? ['name', 'start', 'end']
        : entity.entityType === 'ticket-type'
          ? ['name', 'event_id']
          : entity.entityType === 'historical-order'
            ? ['event_id', 'created_at']
            : entity.entityType === 'ticket'
              ? ['order_id', 'ticket_type_id']
              : entity.entityType === 'check-in'
                ? ['issued_ticket_id', 'checked_in_at']
                : [];
    const issues: MigrationIssue[] = [...validateCanonicalMigrationEntity(entity)];
    for (const field of required)
      if (entity.attributes[field] === undefined || entity.attributes[field] === '')
        issues.push({
          code: 'TICKET_TAILOR_REQUIRED_FIELD',
          severity: 'error',
          message: `Ticket Tailor ${entity.entityType} requires ${field}.`,
          entityType: entity.entityType,
          externalId: entity.externalId,
          sourcePosition: entity.sourcePosition,
          field,
        });
    return issues;
  },
};
