import { describe, expect, it } from 'vitest';
import {
  createGenericCsvErrorExport,
  createGenericCsvTemplate,
  detectCsvDelimiter,
  GENERIC_CSV_LIMITS,
  GenericCsvMigrationAdapter,
  parseCsv,
  previewGenericCsv,
  type GenericCsvConfiguration,
} from '../index.js';

const documents: GenericCsvConfiguration['documents'] = [
  {
    name: 'events.csv',
    content:
      'external_id,brand_external_id,name,starts_at,timezone,currency\r\nevent-1,brand-1,"Summer, Live",2027-07-10T18:00:00-05:00,America/Chicago,USD\r\n',
  },
  {
    name: 'ticket-types.csv',
    entityType: 'ticket-type',
    content:
      'external_id,event_external_id,inventory_pool_external_id,name,price_minor,currency\ntype-1,event-1,pool-1,General,2500,USD\n',
  },
  {
    name: 'attendees.csv',
    content:
      'external_id,event_external_id,ticket_type_external_id,order_external_id,email\nattendee-1,event-1,type-1,order-1,buyer@example.test\n',
  },
  {
    name: 'orders.csv',
    content:
      'external_id;brand_external_id;event_external_id;attendee_external_id;order_number;created_at;currency;total_minor;buyer_email\norder-1;brand-1;event-1;attendee-1;ORDER-1;2027-01-02T03:04:05Z;USD;2500;buyer@example.test\n',
  },
  {
    name: 'tickets.csv',
    content:
      'external_id,event_external_id,order_external_id,ticket_type_external_id,attendee_external_id,code\nticket-1,event-1,order-1,type-1,attendee-1,TICKET-1\n',
  },
  {
    name: 'promo-codes.csv',
    entityType: 'discount',
    content:
      'external_id,event_external_id,code,kind,percentage\npromo-1,event-1,SAVE10,percentage,10\n',
  },
  {
    name: 'check-in-history.csv',
    entityType: 'check-in',
    content:
      'external_id,ticket_external_id,checked_in_at,action\nscan-1,ticket-1,2027-07-10T18:30:00Z,check-in\n',
  },
];
const context = { tenantId: 'tenant-1', organizationId: 'organization-1' };

describe('GenericCsvMigrationAdapter', () => {
  it('parses RFC 4180 quoting, CRLF, embedded newlines, and deterministic delimiters', () => {
    const parsed = parseCsv('id,notes\r\n1,"line one\r\nline two"\r\n2,"a ""quote"""\r\n');
    expect(parsed.rows).toEqual([
      { id: '1', notes: 'line one\r\nline two' },
      { id: '2', notes: 'a "quote"' },
    ]);
    expect(detectCsvDelimiter('id;name\n1;Test\n')).toBe(';');
    expect(() => parseCsv('id,name\n1\n')).toThrow(/expected 2/u);
    expect(() => parseCsv('id,id\n1,2\n')).toThrow(/unique/u);
  });

  it('enforces byte, row, column, header, and cell limits at their boundaries', () => {
    expect(() =>
      parseCsv(`id\n${'x'.repeat(GENERIC_CSV_LIMITS.maxCellCharacters)}\n`),
    ).not.toThrow();
    expect(() => parseCsv(`id\n${'x'.repeat(GENERIC_CSV_LIMITS.maxCellCharacters + 1)}\n`)).toThrow(
      /cell exceeding/u,
    );
    expect(() =>
      parseCsv(`${'h'.repeat(GENERIC_CSV_LIMITS.maxHeaderCharacters)}\n1\n`),
    ).not.toThrow();
    expect(() =>
      parseCsv(`${'h'.repeat(GENERIC_CSV_LIMITS.maxHeaderCharacters + 1)}\n1\n`),
    ).toThrow(/headers cannot exceed/u);
    const columns = Array.from(
      { length: GENERIC_CSV_LIMITS.maxColumns },
      (_, index) => `h${index}`,
    );
    expect(() =>
      parseCsv(`${columns.join(',')}\n${columns.map(() => '1').join(',')}\n`),
    ).not.toThrow();
    expect(() => parseCsv(`${[...columns, 'overflow'].join(',')}\n`)).toThrow(/column limit/u);
    const rows = Array.from({ length: GENERIC_CSV_LIMITS.maxRows }, () => '1');
    expect(() => parseCsv(`id\n${rows.join('\n')}\n`)).not.toThrow();
    expect(() => parseCsv(`id\n${[...rows, '2'].join('\n')}\n`)).toThrow(/row limit/u);
    expect(() => parseCsv('id\n1\n'.padEnd(GENERIC_CSV_LIMITS.maxBytes + 1, ' '))).toThrow(
      /byte limit/u,
    );
  });

  it('discovers every required generic entity and extracts with stable cursors', async () => {
    const adapter = new GenericCsvMigrationAdapter();
    const configuration = { documents };
    const discovery = await adapter.discover(configuration, context);
    expect(discovery.entities).toEqual([
      { type: 'event', estimatedRows: 1 },
      { type: 'ticket-type', estimatedRows: 1 },
      { type: 'attendee', estimatedRows: 1 },
      { type: 'historical-order', estimatedRows: 1 },
      { type: 'ticket', estimatedRows: 1 },
      { type: 'discount', estimatedRows: 1 },
      { type: 'check-in', estimatedRows: 1 },
    ]);
    const first = await adapter.extract({
      configuration,
      discovery,
      limit: 3,
      context,
    });
    const second = await adapter.extract({
      configuration,
      discovery,
      cursor: first.nextCursor,
      limit: 10,
      context,
    });
    expect(first.rows.map(({ externalId }) => externalId)).toEqual([
      'event-1',
      'type-1',
      'attendee-1',
    ]);
    expect(first.nextCursor).toBe('3');
    expect(second.rows).toHaveLength(4);
    expect(second.nextCursor).toBeUndefined();
    await expect(
      adapter.extract({
        configuration,
        discovery,
        cursor: '03',
        limit: 1,
        context,
      }),
    ).rejects.toThrow(/canonical/u);
  });

  it('normalizes dependencies, validates dates, currency and timezone, and honors mappings', async () => {
    const adapter = new GenericCsvMigrationAdapter();
    const configuration: GenericCsvConfiguration = {
      documents: [
        {
          name: 'custom.csv',
          entityType: 'event',
          content:
            'ID,Brand,Title,When,Zone,Money\ne-9,brand-1,Night,not-a-date,Mars/Olympus,usd\n',
        },
      ],
      profiles: [
        {
          id: 'event-map',
          entityType: 'event',
          fields: {
            external_id: 'ID',
            brand_external_id: 'Brand',
            name: 'Title',
            starts_at: 'When',
            timezone: 'Zone',
            currency: 'Money',
          },
        },
      ],
      profileByDocument: { 'custom.csv': 'event-map' },
    };
    const discovery = await adapter.discover(configuration, context);
    const extracted = await adapter.extract({
      configuration,
      discovery,
      limit: 1,
      context,
    });
    const normalized = await adapter.normalize(extracted.rows[0]!, context);
    const issues = await adapter.validate(normalized, context);
    expect(normalized.externalId).toBe('e-9');
    expect(issues.map(({ code }) => code)).toEqual([
      'DATE_INVALID',
      'TIMEZONE_INVALID',
      'CURRENCY_INVALID',
    ]);

    const ticket = await adapter.normalize(
      {
        externalId: 'ticket-1',
        entityType: 'ticket',
        sourcePosition: 'tickets.csv:2',
        data: {
          external_id: 'ticket-1',
          order_external_id: 'order-1',
          ticket_type_external_id: 'type-1',
          attendee_external_id: 'attendee-1',
        },
      },
      context,
    );
    expect(ticket.dependencies).toEqual([
      { entityType: 'historical-order', externalId: 'order-1' },
      { entityType: 'ticket-type', externalId: 'type-1' },
      { entityType: 'attendee', externalId: 'attendee-1' },
    ]);
    const missingId = await adapter.normalize(
      {
        externalId: 'events.csv:2',
        entityType: 'event',
        sourcePosition: 'events.csv:2',
        data: { name: 'No ID', starts_at: '2027-01-01T00:00:00Z', timezone: 'UTC' },
      },
      context,
    );
    expect((await adapter.validate(missingId, context)).map(({ code }) => code)).toContain(
      'MAPPING_REQUIRED',
    );
  });

  it('provides templates, safe previews, and spreadsheet-safe error exports', () => {
    expect(createGenericCsvTemplate('event')).toBe(
      'external_id,brand_external_id,venue_external_id,name,starts_at,ends_at,timezone,currency\r\n',
    );
    expect(previewGenericCsv({ documents }, 1)[0]).toMatchObject({
      documentName: 'events.csv',
      entityType: 'event',
      delimiter: ',',
    });
    expect(
      previewGenericCsv({ documents: [{ name: 'bad.csv', content: 'id,name\n1,"bad' }] })[0]
        ?.issues[0]?.code,
    ).toBe('CSV_SYNTAX_INVALID');
    const exported = createGenericCsvErrorExport([
      {
        sourcePosition: 'events.csv:2',
        entityType: 'event',
        externalId: '=1+1',
        field: 'name',
        severity: 'error',
        code: 'MAPPING_REQUIRED',
        message: 'Missing, required value',
      },
    ]);
    expect(exported).toContain(
      'event,\'=1+1,name,error,MAPPING_REQUIRED,"Missing, required value"',
    );
    const hostile = createGenericCsvErrorExport([
      {
        sourcePosition: '\u00A0=HYPERLINK("https://invalid.test")',
        externalId: '\u200B+1',
        severity: 'error',
        code: '\t-2',
        message: '\u0000@SUM(1,1)',
      },
    ]);
    expect(hostile).toContain("'\u00A0=HYPERLINK");
    expect(hostile).toContain("'\u200B+1");
    expect(hostile).toContain("'\t-2");
    expect(hostile).toContain("'\u0000@SUM");
    expect(exported.endsWith('\r\n')).toBe(true);
  });

  it('honors cancellation and refuses ambiguous or invalid input', async () => {
    const adapter = new GenericCsvMigrationAdapter();
    const controller = new AbortController();
    controller.abort();
    await expect(
      adapter.discover({ documents }, { ...context, signal: controller.signal }),
    ).rejects.toThrow();
    await expect(
      adapter.discover(
        { documents: [{ name: 'unknown.csv', content: 'foo,bar\none,two\n' }] },
        context,
      ),
    ).rejects.toThrow(/detect entity type/u);
    await expect(adapter.discover({ documents: [] }, context)).rejects.toThrow(/At least one/u);
  });
});
