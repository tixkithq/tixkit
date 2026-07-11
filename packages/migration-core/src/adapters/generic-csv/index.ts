import {
  validateCanonicalMigrationEntity,
  type AdapterContext,
  type ExtractedMigrationRow,
  type MigrationAdapter,
  type MigrationDiscovery,
  type MigrationEntityType,
  type MigrationIssue,
  type NormalizedMigrationEntity,
} from '../../index.js';
import { GENERIC_CSV_LIMITS, parseCsv, csvSyntaxIssue } from './parser.js';
import {
  GENERIC_CSV_ENTITY_TYPES,
  GENERIC_CSV_SUPPORTED_VERSIONS,
  type GenericCsvConfiguration,
  type GenericCsvDocument,
  type GenericCsvEntityType,
  type GenericCsvErrorExportRow,
  type GenericCsvFieldMapping,
  type GenericCsvMappingProfile,
  type GenericCsvPreview,
} from './types.js';

export * from './parser.js';
export * from './templates.js';
export * from './types.js';

const aliases: Readonly<Record<string, GenericCsvEntityType>> = {
  event: 'event',
  events: 'event',
  tickettype: 'ticket-type',
  tickettypes: 'ticket-type',
  tickets_type: 'ticket-type',
  attendee: 'attendee',
  attendees: 'attendee',
  order: 'historical-order',
  orders: 'historical-order',
  historicalorders: 'historical-order',
  ticket: 'ticket',
  tickets: 'ticket',
  discount: 'discount',
  discounts: 'discount',
  promo: 'discount',
  promos: 'discount',
  promocodes: 'discount',
  checkin: 'check-in',
  checkins: 'check-in',
  checkinhistory: 'check-in',
};

const requiredFields: Readonly<Record<GenericCsvEntityType, readonly string[]>> = {
  event: ['external_id', 'brand_external_id', 'name', 'starts_at', 'timezone', 'currency'],
  'ticket-type': [
    'external_id',
    'event_external_id',
    'inventory_pool_external_id',
    'name',
    'price_minor',
    'currency',
  ],
  attendee: ['external_id', 'event_external_id', 'ticket_type_external_id', 'email'],
  'historical-order': [
    'external_id',
    'brand_external_id',
    'event_external_id',
    'attendee_external_id',
    'order_number',
    'currency',
    'total_minor',
    'buyer_email',
  ],
  ticket: [
    'external_id',
    'event_external_id',
    'order_external_id',
    'ticket_type_external_id',
    'attendee_external_id',
    'code',
  ],
  discount: ['external_id', 'event_external_id', 'code', 'kind'],
  'check-in': ['external_id', 'ticket_external_id', 'checked_in_at'],
};

function normalizedName(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9_]+/gu, '');
}

function detectEntityType(
  document: GenericCsvDocument,
  headers: readonly string[],
): GenericCsvEntityType | undefined {
  if (document.entityType) return document.entityType;
  const filename = normalizedName(document.name.replace(/\.[^.]+$/u, ''));
  if (aliases[filename]) return aliases[filename];
  const normalizedHeaders = new Set(headers.map(normalizedName));
  let best: { type: GenericCsvEntityType; score: number } | undefined;
  for (const type of GENERIC_CSV_ENTITY_TYPES) {
    const score = requiredFields[type].filter((field) => normalizedHeaders.has(field)).length;
    if (!best || score > best.score) best = { type, score };
  }
  return best && best.score >= 2 ? best.type : undefined;
}

function profileFor(
  configuration: GenericCsvConfiguration,
  document: GenericCsvDocument,
  entityType: GenericCsvEntityType,
): GenericCsvMappingProfile | undefined {
  const requested = configuration.profileByDocument?.[document.name];
  if (!requested) return undefined;
  const profile = configuration.profiles?.find(({ id }) => id === requested);
  if (!profile) throw new TypeError(`Mapping profile ${requested} does not exist`);
  if (profile.entityType !== entityType)
    throw new TypeError(
      `Mapping profile ${requested} targets ${profile.entityType}, not ${entityType}`,
    );
  return profile;
}

function mapRow(
  row: Readonly<Record<string, string>>,
  mapping?: GenericCsvFieldMapping,
): Record<string, string> {
  if (!mapping)
    return Object.fromEntries(
      Object.entries(row).map(([field, value]) => [normalizedName(field), value.trim()]),
    );
  return Object.fromEntries(
    Object.entries(mapping).map(([target, source]) => [target, (row[source] ?? '').trim()]),
  );
}

function assertConfiguration(configuration: GenericCsvConfiguration): void {
  if (!Array.isArray(configuration.documents) || configuration.documents.length === 0)
    throw new TypeError('At least one CSV document is required');
  if (configuration.documents.length > GENERIC_CSV_LIMITS.maxDocuments)
    throw new RangeError(
      `Generic CSV configuration exceeds the ${GENERIC_CSV_LIMITS.maxDocuments}-document limit`,
    );
  const names = new Set<string>();
  for (const document of configuration.documents) {
    if (!document.name.trim()) throw new TypeError('CSV document names cannot be empty');
    if (names.has(document.name))
      throw new TypeError(`Duplicate CSV document name: ${document.name}`);
    names.add(document.name);
    if (typeof document.content !== 'string')
      throw new TypeError(`CSV document ${document.name} has no text content`);
  }
}

function collectRows(configuration: GenericCsvConfiguration): ExtractedMigrationRow[] {
  const output: ExtractedMigrationRow[] = [];
  for (const document of configuration.documents) {
    const parsed = parseCsv(document.content, document.delimiter);
    const entityType = detectEntityType(document, parsed.headers);
    if (!entityType) throw new TypeError(`Unable to detect entity type for ${document.name}`);
    const profile = profileFor(configuration, document, entityType);
    parsed.rows.forEach((row, index) => {
      const data = mapRow(row, profile?.fields);
      const externalId = data.external_id?.trim();
      output.push({
        entityType,
        externalId: externalId || `${document.name}:${index + 2}`,
        sourcePosition: `${document.name}:${index + 2}`,
        data: {
          ...data,
          source_default_currency: configuration.defaultCurrency,
          source_default_timezone: configuration.defaultTimezone,
        },
      });
    });
  }
  return output;
}

function dependency(entityType: MigrationEntityType, externalId: unknown) {
  return typeof externalId === 'string' && externalId.length > 0
    ? { entityType, externalId }
    : undefined;
}

function dependenciesFor(
  type: GenericCsvEntityType,
  attributes: Readonly<Record<string, unknown>>,
) {
  const values =
    type === 'ticket-type' || type === 'historical-order' || type === 'discount'
      ? type === 'ticket-type'
        ? [
            dependency('event', attributes.event_external_id),
            dependency('inventory-pool', attributes.inventory_pool_external_id),
            dependency('occurrence', attributes.occurrence_external_id),
          ]
        : type === 'historical-order'
          ? [
              dependency('brand', attributes.brand_external_id),
              dependency('event', attributes.event_external_id),
              dependency('attendee', attributes.attendee_external_id),
            ]
          : [dependency('event', attributes.event_external_id)]
      : type === 'attendee'
        ? [
            dependency('event', attributes.event_external_id),
            dependency('ticket-type', attributes.ticket_type_external_id),
            dependency('occurrence', attributes.occurrence_external_id),
            dependency('historical-order', attributes.order_external_id),
          ]
        : type === 'ticket'
          ? [
              dependency('event', attributes.event_external_id),
              dependency('historical-order', attributes.order_external_id),
              dependency('ticket-type', attributes.ticket_type_external_id),
              dependency('attendee', attributes.attendee_external_id),
            ]
          : type === 'check-in'
            ? [dependency('ticket', attributes.ticket_external_id)]
            : type === 'event'
              ? [
                  dependency('brand', attributes.brand_external_id),
                  dependency('venue', attributes.venue_external_id),
                ]
              : [];
  return values.filter((value): value is NonNullable<typeof value> => Boolean(value));
}

function issue(
  entity: NormalizedMigrationEntity,
  input: Omit<MigrationIssue, 'entityType' | 'externalId' | 'sourcePosition'>,
): MigrationIssue {
  return {
    ...input,
    entityType: entity.entityType,
    externalId: entity.externalId,
    sourcePosition: entity.sourcePosition,
  };
}

function validateDate(
  entity: NormalizedMigrationEntity,
  field: string,
  required = false,
): MigrationIssue[] {
  const value = entity.attributes[field];
  if ((value === undefined || value === '') && !required) return [];
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))
    return [
      issue(entity, {
        code: 'DATE_INVALID',
        severity: 'error',
        message: `${field} must be an ISO-compatible date`,
        field,
      }),
    ];
  return [];
}

function validateCurrency(entity: NormalizedMigrationEntity): MigrationIssue[] {
  const value = entity.attributes.currency ?? entity.attributes.source_default_currency;
  if (value === undefined || value === '') return [];
  return typeof value === 'string' && /^[A-Z]{3}$/u.test(value)
    ? []
    : [
        issue(entity, {
          code: 'CURRENCY_INVALID',
          severity: 'error',
          message: 'currency must be an uppercase ISO 4217 code',
          field: 'currency',
        }),
      ];
}

export class GenericCsvMigrationAdapter implements MigrationAdapter<
  GenericCsvConfiguration,
  string
> {
  readonly id = 'generic-csv';
  readonly supportedVersions = GENERIC_CSV_SUPPORTED_VERSIONS;

  async discover(
    configuration: GenericCsvConfiguration,
    context: AdapterContext,
  ): Promise<MigrationDiscovery> {
    context.signal?.throwIfAborted();
    assertConfiguration(configuration);
    const counts = new Map<GenericCsvEntityType, number>();
    for (const document of configuration.documents) {
      const parsed = parseCsv(document.content, document.delimiter);
      const type = detectEntityType(document, parsed.headers);
      if (!type) throw new TypeError(`Unable to detect entity type for ${document.name}`);
      profileFor(configuration, document, type);
      counts.set(type, (counts.get(type) ?? 0) + parsed.rows.length);
    }
    return {
      source: { sourceSystem: this.id, sourceVersion: GENERIC_CSV_SUPPORTED_VERSIONS[0] },
      entities: GENERIC_CSV_ENTITY_TYPES.filter((type) => counts.has(type)).map((type) => ({
        type,
        estimatedRows: counts.get(type),
      })),
      unsupportedFeatures: ['reserved-seating', 'provider-payment-state', 'source-automations'],
    };
  }

  async extract(input: {
    configuration: GenericCsvConfiguration;
    discovery: MigrationDiscovery;
    cursor?: string;
    limit: number;
    context: AdapterContext;
  }): Promise<{ rows: readonly ExtractedMigrationRow[]; nextCursor?: string }> {
    input.context.signal?.throwIfAborted();
    if (!Number.isSafeInteger(input.limit) || input.limit < 1)
      throw new RangeError('limit must be a positive safe integer');
    const offset = input.cursor === undefined ? 0 : Number(input.cursor);
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      (input.cursor !== undefined && String(offset) !== input.cursor)
    )
      throw new TypeError('cursor must be a canonical non-negative integer');
    const rows = collectRows(input.configuration);
    const page = rows.slice(offset, offset + input.limit);
    const nextOffset = offset + page.length;
    return { rows: page, ...(nextOffset < rows.length ? { nextCursor: String(nextOffset) } : {}) };
  }

  async normalize(
    row: ExtractedMigrationRow,
    context: AdapterContext,
  ): Promise<NormalizedMigrationEntity> {
    context.signal?.throwIfAborted();
    if (!GENERIC_CSV_ENTITY_TYPES.includes(row.entityType as GenericCsvEntityType))
      throw new TypeError(`Unsupported generic CSV entity type: ${row.entityType}`);
    const source = row.data;
    const attributes: Record<string, unknown> = { ...source };
    if (row.entityType === 'event')
      Object.assign(attributes, {
        title: source.name,
        startsAt: source.starts_at,
        endsAt: source.ends_at,
        timezone: source.timezone ?? source.source_default_timezone,
        currency: source.currency ?? source.source_default_currency,
      });
    else if (row.entityType === 'ticket-type')
      Object.assign(attributes, {
        name: source.name,
        currency: source.currency ?? source.source_default_currency,
        priceMinor: Number(source.price_minor),
      });
    else if (row.entityType === 'attendee')
      Object.assign(attributes, {
        email: source.email,
        firstName: source.first_name,
        lastName: source.last_name,
      });
    else if (row.entityType === 'historical-order')
      Object.assign(attributes, {
        orderNumber: source.order_number,
        currency: source.currency ?? source.source_default_currency,
        totalMinor: Number(source.total_minor),
        buyerEmail: source.buyer_email,
      });
    else if (row.entityType === 'ticket') attributes.code = source.code;
    else if (row.entityType === 'discount')
      Object.assign(attributes, {
        code: source.code,
        type: source.kind,
        value: Number(source.percentage ?? source.amount_minor),
        currency: source.currency ?? source.source_default_currency,
      });
    else if (row.entityType === 'check-in')
      Object.assign(attributes, {
        occurredAt: source.checked_in_at,
        result: source.action === 'check-out' ? 'rejected' : 'accepted',
      });
    return {
      entityType: row.entityType,
      externalId: row.externalId.trim().normalize('NFC'),
      sourcePosition: row.sourcePosition,
      attributes,
      dependencies: dependenciesFor(row.entityType as GenericCsvEntityType, attributes),
    };
  }

  async validate(
    entity: NormalizedMigrationEntity,
    context: AdapterContext,
  ): Promise<readonly MigrationIssue[]> {
    context.signal?.throwIfAborted();
    const type = entity.entityType as GenericCsvEntityType;
    if (!GENERIC_CSV_ENTITY_TYPES.includes(type))
      return [
        issue(entity, {
          code: 'ENTITY_UNSUPPORTED',
          severity: 'fatal',
          message: `Unsupported entity type: ${entity.entityType}`,
        }),
      ];
    const issues: MigrationIssue[] = [...validateCanonicalMigrationEntity(entity)];
    for (const field of requiredFields[type]) {
      if (!entity.attributes[field])
        issues.push(
          issue(entity, {
            code: 'MAPPING_REQUIRED',
            severity: 'error',
            message: `${field} is required`,
            field,
          }),
        );
    }
    if (type === 'event') {
      issues.push(...validateDate(entity, 'starts_at', true), ...validateDate(entity, 'ends_at'));
      const timezone = entity.attributes.timezone ?? entity.attributes.source_default_timezone;
      if (typeof timezone !== 'string' || timezone.length === 0)
        issues.push(
          issue(entity, {
            code: 'TIMEZONE_REQUIRED',
            severity: 'error',
            message: 'timezone or defaultTimezone is required',
            field: 'timezone',
          }),
        );
      else {
        try {
          new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
        } catch {
          issues.push(
            issue(entity, {
              code: 'TIMEZONE_INVALID',
              severity: 'error',
              message: 'timezone must be a valid IANA time zone',
              field: 'timezone',
            }),
          );
        }
      }
    }
    if (type === 'historical-order') issues.push(...validateDate(entity, 'created_at', true));
    if (type === 'check-in') issues.push(...validateDate(entity, 'checked_in_at', true));
    issues.push(...validateCurrency(entity));
    return issues;
  }
}

export const genericCsvMigrationAdapter = new GenericCsvMigrationAdapter();

export function previewGenericCsv(
  configuration: GenericCsvConfiguration,
  limit = 10,
): GenericCsvPreview[] {
  if (!Number.isSafeInteger(limit) || limit < 0)
    throw new RangeError('preview limit must be a non-negative safe integer');
  assertConfiguration(configuration);
  return configuration.documents.map((document) => {
    try {
      const parsed = parseCsv(document.content, document.delimiter);
      return {
        documentName: document.name,
        entityType: detectEntityType(document, parsed.headers),
        delimiter: parsed.delimiter,
        headers: parsed.headers,
        rows: parsed.rows.slice(0, limit),
        issues: [],
      };
    } catch (error) {
      return {
        documentName: document.name,
        delimiter: document.delimiter ?? ',',
        headers: [],
        rows: [],
        issues: [csvSyntaxIssue(error, document.name)],
      };
    }
  });
}

function safeSpreadsheetCell(value: string): string {
  return /^[\p{White_Space}\p{Cc}\p{Cf}]*[=+\-@]/u.test(value) ? `'${value}` : value;
}

function csvCell(value: string): string {
  const safe = safeSpreadsheetCell(value);
  return /[",\r\n]/u.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function createGenericCsvErrorExport(rows: readonly GenericCsvErrorExportRow[]): string {
  const headers = [
    'source_position',
    'entity_type',
    'external_id',
    'field',
    'severity',
    'code',
    'message',
  ];
  const body = rows.map((row) =>
    [
      row.sourcePosition,
      row.entityType ?? '',
      row.externalId ?? '',
      row.field ?? '',
      row.severity,
      row.code,
      row.message,
    ]
      .map(csvCell)
      .join(','),
  );
  return `${[headers.join(','), ...body].join('\r\n')}\r\n`;
}
