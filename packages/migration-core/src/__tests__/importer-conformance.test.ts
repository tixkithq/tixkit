import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { eventbriteApiV3Fixture } from '../adapters/eventbrite/fixture.js';
import { eventbriteAdapter } from '../adapters/eventbrite/index.js';
import {
  GenericCsvMigrationAdapter,
  type GenericCsvConfiguration,
} from '../adapters/generic-csv/index.js';
import { SANITIZED_HI_EVENTS_OFFICIAL_API_FIXTURE } from '../adapters/hi-events/fixtures.js';
import { hiEventsMigrationAdapter } from '../adapters/hi-events/index.js';
import { SANITIZED_PRETIX_OFFICIAL_API_FIXTURE } from '../adapters/pretix/fixtures.js';
import { pretixMigrationAdapter } from '../adapters/pretix/index.js';
import {
  MIGRATION_IMPORTER_ORDER,
  migrationAdapterCatalog,
  type MigrationImporterId,
} from '../adapters/registry.js';
import { ticketTailorApiV1Fixture } from '../adapters/ticket-tailor/fixture.js';
import { ticketTailorAdapter } from '../adapters/ticket-tailor/index.js';
import {
  MIGRATION_ENTITY_DEPENDENCY_ORDER,
  runMigrationAdapterConformance,
  type MigrationAdapter,
} from '../index.js';

const sampleEventsCsv = readFileSync(
  new URL('../adapters/generic-csv/__fixtures__/events.csv', import.meta.url),
  'utf8',
);

const genericCsvConfiguration: GenericCsvConfiguration = {
  documents: [
    { name: 'events.csv', content: sampleEventsCsv },
    {
      name: 'ticket-types.csv',
      entityType: 'ticket-type',
      content:
        'external_id,event_external_id,inventory_pool_external_id,name,price_minor,currency\ntype-1,event-1,pool-1,General,2500,USD\n',
    },
    {
      name: 'attendees.csv',
      entityType: 'attendee',
      content:
        'external_id,event_external_id,ticket_type_external_id,order_external_id,email\nattendee-1,event-1,type-1,order-1,buyer@example.test\n',
    },
    {
      name: 'orders.csv',
      entityType: 'historical-order',
      content:
        'external_id,brand_external_id,event_external_id,attendee_external_id,order_number,created_at,currency,total_minor,buyer_email\norder-1,brand-1,event-1,attendee-1,ORDER-1,2027-01-02T03:04:05Z,USD,2500,buyer@example.test\n',
    },
    {
      name: 'tickets.csv',
      entityType: 'ticket',
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
  ],
};

type ConformanceCase = {
  id: MigrationImporterId;
  adapter: MigrationAdapter<unknown, string>;
  configuration: unknown;
  expectedRows: number;
  sourceRows?: number;
};

const cases: readonly ConformanceCase[] = [
  {
    id: 'generic-csv',
    adapter: new GenericCsvMigrationAdapter() as MigrationAdapter<unknown, string>,
    configuration: genericCsvConfiguration,
    expectedRows: 7,
  },
  {
    id: 'pretix',
    adapter: pretixMigrationAdapter as MigrationAdapter<unknown, string>,
    configuration: SANITIZED_PRETIX_OFFICIAL_API_FIXTURE,
    expectedRows: 18,
  },
  {
    id: 'hi-events',
    adapter: hiEventsMigrationAdapter as MigrationAdapter<unknown, string>,
    configuration: SANITIZED_HI_EVENTS_OFFICIAL_API_FIXTURE,
    expectedRows: 18,
  },
  {
    id: 'eventbrite',
    adapter: eventbriteAdapter as MigrationAdapter<unknown, string>,
    configuration: eventbriteApiV3Fixture,
    expectedRows: 7,
  },
  {
    id: 'ticket-tailor',
    adapter: ticketTailorAdapter as MigrationAdapter<unknown, string>,
    configuration: ticketTailorApiV1Fixture,
    expectedRows: 7,
    sourceRows: 6,
  },
];

describe('migration importer acceptance profile', () => {
  it('keeps official importer order, version support, and operational metadata complete', () => {
    expect(cases.map(({ id }) => id)).toEqual(MIGRATION_IMPORTER_ORDER);
    for (const { id, adapter } of cases) {
      const metadata = migrationAdapterCatalog().find((entry) => entry.id === id);
      expect(metadata).toBeDefined();
      expect(adapter.supportedVersions).toEqual(metadata?.supportedVersions);
      expect(metadata?.supportedVersions.length).toBeGreaterThan(0);
      expect(metadata?.sourceModes.length).toBeGreaterThan(0);
      expect(Object.keys(metadata?.featureMapping ?? {})).not.toHaveLength(0);
      expect(Object.keys(metadata?.rateLimitPolicy ?? {})).not.toHaveLength(0);
    }
  });

  it.each(cases)('$id passes the executable adoption contract', async (testCase) => {
    const result = await runMigrationAdapterConformance({
      adapter: testCase.adapter,
      configuration: testCase.configuration,
      tenantId: 'tenant-conformance',
      organizationId: 'organization-conformance',
      pageSize: 2,
    });

    expect(result.discoverySourceSystem).toBe(testCase.id);
    expect(result.extractedRows).toBe(testCase.expectedRows);
    expect(result.pageCount).toBeGreaterThanOrEqual(
      Math.ceil((testCase.sourceRows ?? testCase.expectedRows) / 2),
    );
    expect(result.validationIssues).toEqual([]);
    expect(result.dryRun).toMatchObject({
      mode: 'dry-run',
      domainWrites: 0,
      counts: { create: testCase.expectedRows, update: 0, skip: 0, conflict: 0 },
    });
    expect(result.firstCommit.dispositions).toEqual(
      Array.from({ length: testCase.expectedRows }, () => 'create'),
    );
    expect(result.unchangedReimport.dispositions).toEqual(
      Array.from({ length: testCase.expectedRows }, () => 'skip'),
    );
    expect(result.changedFinancialDisposition).toBe('conflict');
    expect(result.untouchedRollback).toMatchObject({
      eligible: true,
      mode: 'delete-untouched-before-activation',
    });
    expect(result.activeRollback).toMatchObject({
      eligible: false,
      mode: 'corrective-plan',
    });
    expect(result.activeRollback.reasons?.some((reason) => reason.includes('has scans'))).toBe(
      true,
    );

    const dependencyRanks = result.normalizedEntities.map(({ entityType }) =>
      MIGRATION_ENTITY_DEPENDENCY_ORDER.indexOf(entityType),
    );
    // oxlint-disable-next-line unicorn/no-array-sort -- the spread creates a local copy.
    expect(dependencyRanks).toEqual([...dependencyRanks].sort((left, right) => left - right));
  });

  it('ships sanitized, non-secret sample corpora and a parseable generic CSV fixture', () => {
    expect(sampleEventsCsv).toContain('event-1');
    expect(sampleEventsCsv).toContain('America/Chicago');
    const serialized = JSON.stringify([
      SANITIZED_PRETIX_OFFICIAL_API_FIXTURE,
      SANITIZED_HI_EVENTS_OFFICIAL_API_FIXTURE,
      eventbriteApiV3Fixture,
      ticketTailorApiV1Fixture,
    ]);
    expect(serialized).toContain('SANITIZED');
    expect(serialized).not.toMatch(/(?:bearer\s+|sk_(?:live|test)_|api[_-]?key["']?\s*[:=])/iu);
    expect(serialized).not.toMatch(/@[a-z0-9.-]+\.[a-z]{2,}/iu);
  });
});
