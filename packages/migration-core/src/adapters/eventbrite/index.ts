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

export const EVENTBRITE_ADAPTER_METADATA = {
  supportedVersions: ['Eventbrite API v3', 'Eventbrite attendee CSV 2024-01 through 2026-07'],
  featureMap: {
    event: 'event',
    ticket_class: 'ticket-type',
    attendee: 'attendee',
    order: 'historical-order',
    ticket: 'ticket',
    discount: 'discount',
    checkin: 'check-in',
    payment: 'historical-payment',
    refund: 'historical-refund',
  },
  knownLosses: [
    'Eventbrite organizer payout schedules are retained only in source provenance.',
    'Reserved-seating geometry and Eventbrite marketing audiences are not imported.',
    'Historical payments and refunds are immutable snapshots and never produce provider-success events.',
  ],
  rateLimits: {
    strategy:
      'honor Retry-After, use the response continuation token, and apply bounded exponential backoff',
    maximumPageSize: 100,
  },
} as const;

export type EventbriteRecord = {
  resource: keyof typeof EVENTBRITE_ADAPTER_METADATA.featureMap;
  id: string;
  changed?: string;
  body: Readonly<Record<string, unknown>>;
};

export type EventbriteConfiguration = {
  accountId: string;
  records: readonly EventbriteRecord[];
  sourceVersion?: string;
  importedAt: string;
};

function requireObject(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError(`${field} must be an object`);
  return value as Readonly<Record<string, unknown>>;
}

function stringField(value: Readonly<Record<string, unknown>>, field: string): string | undefined {
  const candidate = value[field];
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : undefined;
}

function dependency(
  body: Readonly<Record<string, unknown>>,
  field: string,
  entityType: MigrationEntityType,
) {
  const externalId = stringField(body, field);
  return externalId ? [{ entityType, externalId }] : [];
}

function validateConfiguration(configuration: EventbriteConfiguration): void {
  if (!configuration || typeof configuration !== 'object')
    throw new TypeError('Eventbrite configuration must be an object');
  if (typeof configuration.accountId !== 'string' || !configuration.accountId.trim())
    throw new TypeError('accountId is required');
  if (configuration.sourceVersion !== undefined && configuration.sourceVersion !== 'v3')
    throw new TypeError(`unsupported Eventbrite source version: ${configuration.sourceVersion}`);
  if (
    typeof configuration.importedAt !== 'string' ||
    !Number.isFinite(Date.parse(configuration.importedAt))
  )
    throw new TypeError('importedAt must be an ISO timestamp');
  if (!Array.isArray(configuration.records))
    throw new TypeError('Eventbrite records must be an array');
  const ids = new Set<string>();
  for (const record of configuration.records) {
    if (!record || typeof record !== 'object')
      throw new TypeError('Eventbrite records must be objects');
    if (!(record.resource in EVENTBRITE_ADAPTER_METADATA.featureMap))
      throw new TypeError(`unsupported Eventbrite resource: ${record.resource}`);
    if (typeof record.id !== 'string' || !record.id.trim())
      throw new TypeError('record id is required');
    requireObject(record.body, `Eventbrite ${record.resource} body`);
    if (record.changed !== undefined && !Number.isFinite(Date.parse(record.changed)))
      throw new TypeError('Eventbrite changed must be an ISO timestamp');
    const stableId = `${record.resource}:${record.id}`;
    if (ids.has(stableId)) throw new TypeError(`duplicate Eventbrite record: ${stableId}`);
    ids.add(stableId);
  }
}

function encodeCursor(offset: number): string {
  return `eventbrite-v1:${offset}`;
}

function decodeCursor(cursor: string | undefined, maximum: number): number {
  if (!cursor) return 0;
  const match = /^eventbrite-v1:(\d+)$/u.exec(cursor);
  if (!match) throw new TypeError('invalid Eventbrite cursor');
  const offset = Number(match[1]);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > maximum)
    throw new RangeError('Eventbrite cursor is out of range');
  return offset;
}

export const eventbriteAdapter: MigrationAdapter<EventbriteConfiguration, string> = {
  id: 'eventbrite',
  supportedVersions: EVENTBRITE_ADAPTER_METADATA.supportedVersions,

  async discover(configuration): Promise<MigrationDiscovery> {
    validateConfiguration(configuration);
    const counts = new Map<MigrationEntityType, number>();
    for (const record of configuration.records) {
      const type = EVENTBRITE_ADAPTER_METADATA.featureMap[record.resource];
      counts.set(type, (counts.get(type) ?? 0) + 1);
    }
    return {
      source: {
        sourceSystem: 'eventbrite',
        sourceVersion: configuration.sourceVersion ?? 'v3',
        accountId: configuration.accountId,
      },
      entities: [...counts].map(([type, estimatedRows]) => ({ type, estimatedRows })),
      unsupportedFeatures: EVENTBRITE_ADAPTER_METADATA.knownLosses,
    };
  },

  async extract({ configuration, cursor, limit, context }) {
    validateConfiguration(configuration);
    if (context.signal?.aborted) throw context.signal.reason;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > EVENTBRITE_ADAPTER_METADATA.rateLimits.maximumPageSize
    )
      throw new RangeError('Eventbrite extraction limit must be between 1 and 100');
    const offset = decodeCursor(cursor, configuration.records.length);
    const records = configuration.records.slice(offset, offset + limit);
    const rows = records.map(
      (record, index): ExtractedMigrationRow => ({
        externalId: record.id,
        entityType: EVENTBRITE_ADAPTER_METADATA.featureMap[record.resource],
        sourcePosition: `eventbrite:${record.resource}:${offset + index}`,
        data: {
          ...record.body,
          migrationResource: record.resource,
          migrationChanged: record.changed,
          migrationImportedAt: configuration.importedAt,
        },
      }),
    );
    const nextOffset = offset + rows.length;
    return {
      rows,
      nextCursor: nextOffset < configuration.records.length ? encodeCursor(nextOffset) : undefined,
    };
  },

  async normalize(row): Promise<NormalizedMigrationEntity> {
    const body = requireObject(row.data, 'row.data');
    const resource = stringField(body, 'migrationResource');
    if (
      !resource ||
      !(resource in EVENTBRITE_ADAPTER_METADATA.featureMap) ||
      EVENTBRITE_ADAPTER_METADATA.featureMap[
        resource as keyof typeof EVENTBRITE_ADAPTER_METADATA.featureMap
      ] !== row.entityType
    )
      throw new TypeError('Eventbrite resource does not match entity type');
    const dependencies =
      row.entityType === 'event'
        ? dependency(body, 'brand_id', 'brand')
        : row.entityType === 'ticket-type'
          ? [
              ...dependency(body, 'event_id', 'event'),
              ...dependency(body, 'inventory_pool_id', 'inventory-pool'),
            ]
          : row.entityType === 'attendee' || row.entityType === 'historical-order'
            ? row.entityType === 'attendee'
              ? [
                  ...dependency(body, 'event_id', 'event'),
                  ...dependency(body, 'ticket_class_id', 'ticket-type'),
                ]
              : [
                  ...dependency(body, 'brand_id', 'brand'),
                  ...dependency(body, 'event_id', 'event'),
                  ...dependency(body, 'attendee_id', 'attendee'),
                ]
            : row.entityType === 'ticket'
              ? [
                  ...dependency(body, 'event_id', 'event'),
                  ...dependency(body, 'order_id', 'historical-order'),
                  ...dependency(body, 'attendee_id', 'attendee'),
                  ...dependency(body, 'ticket_class_id', 'ticket-type'),
                ]
              : row.entityType === 'check-in'
                ? dependency(body, 'ticket_id', 'ticket')
                : row.entityType === 'historical-payment' || row.entityType === 'historical-refund'
                  ? dependency(body, 'order_id', 'historical-order')
                  : [];
    const attributes: Record<string, unknown> = Object.fromEntries(
      Object.entries(body).filter(([key]) => !key.startsWith('migration')),
    );
    if (row.entityType === 'event') {
      const name = requireObject(body.name, 'name');
      const start = requireObject(body.start, 'start');
      attributes.title = stringField(name, 'text');
      attributes.startsAt = stringField(start, 'utc');
      attributes.timezone = stringField(body, 'timezone');
    } else if (row.entityType === 'ticket-type') {
      attributes.priceMinor = Number(body.price_minor);
    } else if (row.entityType === 'attendee') {
      const profile = requireObject(body.profile, 'profile');
      attributes.email = stringField(profile, 'email');
      attributes.firstName = stringField(profile, 'first_name');
      attributes.lastName = stringField(profile, 'last_name');
    } else if (row.entityType === 'historical-order') {
      attributes.orderNumber = stringField(body, 'order_number');
      attributes.totalMinor = Number(body.total_minor);
      attributes.buyerEmail = stringField(body, 'buyer_email');
    } else if (row.entityType === 'ticket') attributes.code = stringField(body, 'barcode');
    else if (row.entityType === 'check-in') attributes.occurredAt = stringField(body, 'created');
    if (row.entityType === 'historical-payment' || row.entityType === 'historical-refund') {
      const amount = requireObject(body.amount, 'amount');
      return {
        ...row,
        attributes,
        dependencies,
        financialSnapshot: createHistoricalFinancialSnapshot({
          kind: row.entityType,
          amountMinor: Number(amount.value),
          currency: String(amount.currency).toUpperCase(),
          providerReference: stringField(body, 'provider_reference'),
          occurredAt: String(body.occurred_at),
          provenance: {
            sourceSystem: 'eventbrite',
            sourceExternalId: row.externalId,
            importedAt: String(body.migrationImportedAt),
          },
          reconciliationStatus: 'unreconciled',
        }),
      };
    }
    return { ...row, attributes, dependencies };
  },

  async validate(entity): Promise<readonly MigrationIssue[]> {
    const issues: MigrationIssue[] = [...validateCanonicalMigrationEntity(entity)];
    if (!entity.externalId.trim())
      issues.push({
        code: 'EVENTBRITE_EXTERNAL_ID_REQUIRED',
        severity: 'fatal',
        message: 'Stable Eventbrite ID is required.',
        entityType: entity.entityType,
        sourcePosition: entity.sourcePosition,
      });
    const required =
      entity.entityType === 'event'
        ? ['name', 'start', 'end']
        : entity.entityType === 'ticket-type'
          ? ['name', 'event_id']
          : entity.entityType === 'attendee'
            ? ['event_id']
            : entity.entityType === 'historical-order'
              ? ['event_id', 'created']
              : entity.entityType === 'ticket'
                ? ['attendee_id', 'ticket_class_id']
                : entity.entityType === 'check-in'
                  ? ['ticket_id', 'created']
                  : [];
    for (const field of required)
      if (entity.attributes[field] === undefined || entity.attributes[field] === '')
        issues.push({
          code: 'EVENTBRITE_REQUIRED_FIELD',
          severity: 'error',
          message: `Eventbrite ${entity.entityType} requires ${field}.`,
          entityType: entity.entityType,
          externalId: entity.externalId,
          sourcePosition: entity.sourcePosition,
          field,
        });
    return issues;
  },
};
