import { describe, expect, it } from 'vitest';
import {
  assertMigrationSecretReference,
  assessRollback,
  assertHistoricalFinancialEntity,
  buildDryRunReport,
  canCommitDryRun,
  chunkMigrationEntities,
  createHistoricalFinancialSnapshot,
  InMemoryExternalReferenceStore,
  migrationIdempotencyKey,
  parseMigrationPreparationConfiguration,
  sortEntitiesByDependency,
  type DryRunRow,
  type NormalizedMigrationEntity,
} from '../index.js';

const entity = (
  entityType: NormalizedMigrationEntity['entityType'],
  externalId: string,
): NormalizedMigrationEntity => ({
  entityType,
  externalId,
  sourcePosition: externalId,
  attributes: {},
});

describe('migration core', () => {
  it('accepts only exact identifier-only production source locators', () => {
    expect(
      parseMigrationPreparationConfiguration(
        {
          sourceMode: 'official-export',
          sourceSystem: 'generic-csv',
          artifactIds: ['upl_abcdefgh'],
        },
        'generic-csv',
      ),
    ).toEqual({
      sourceMode: 'official-export',
      sourceSystem: 'generic-csv',
      artifactIds: ['upl_abcdefgh'],
    });
    expect(
      parseMigrationPreparationConfiguration({
        sourceMode: 'official-export',
        sourceSystem: 'tixkit-portable',
        artifactIds: ['upl_portable1'],
      }),
    ).toEqual({
      sourceMode: 'official-export',
      sourceSystem: 'tixkit-portable',
      artifactIds: ['upl_portable1'],
    });
    expect(
      parseMigrationPreparationConfiguration({
        sourceMode: 'official-api',
        sourceSystem: 'pretix',
        organizerSlug: 'tickets',
        baseUrl: 'https://tickets.example.com',
        eventSlugs: ['festival-2026'],
      }),
    ).toMatchObject({ baseUrl: 'https://tickets.example.com' });
    for (const invalid of [
      {
        sourceMode: 'official-export',
        sourceSystem: 'tixkit-portable',
        artifactIds: ['upl_portable1', 'upl_portable2'],
      },
      {
        sourceMode: 'official-api',
        sourceSystem: 'generic-csv',
        accountId: 'account',
      },
      {
        sourceMode: 'official-api',
        sourceSystem: 'eventbrite',
        organizationId: 'org',
        baseUrl: 'https://attacker.example',
      },
      {
        sourceMode: 'official-export',
        sourceSystem: 'pretix',
        artifactIds: ['upl_abcdefgh'],
        records: [{ id: 'raw-record' }],
      },
      {
        sourceMode: 'official-api',
        sourceSystem: 'hi-events',
        accountId: 'account',
        baseUrl: 'http://127.0.0.1:8080',
      },
    ]) {
      expect(() => parseMigrationPreparationConfiguration(invalid)).toThrow();
    }
  });
  it('accepts only canonical opaque secret-manager references', () => {
    expect(() =>
      assertMigrationSecretReference(
        'aws-secretsmanager://arn:aws:secretsmanager:us-east-1:123456789012:secret/tixkit-source',
      ),
    ).not.toThrow();
    expect(() =>
      assertMigrationSecretReference('vault://team/migrations/source_api'),
    ).not.toThrow();
    for (const reference of [
      'Vault://team/secret',
      'vault://team//secret',
      'vault://team/../secret',
      'vault://team/secret/',
      'vault://team/secret?version=1',
      'vault://team/%2e%2e/secret',
      ' vault://team/secret',
    ]) {
      expect(() => assertMigrationSecretReference(reference)).toThrow(/canonical/u);
    }
  });
  it('orders and chunks entities deterministically by dependency then external id', () => {
    const input = [entity('ticket', 'z'), entity('organization', 'b'), entity('organization', 'a')];
    expect(sortEntitiesByDependency(input).map(({ externalId }) => externalId)).toEqual([
      'a',
      'b',
      'z',
    ]);
    expect(
      chunkMigrationEntities(input, 2).map((chunk) => chunk.map(({ externalId }) => externalId)),
    ).toEqual([['a', 'b'], ['z']]);
    expect(() => chunkMigrationEntities(input, 0)).toThrow(RangeError);
  });

  it('creates collision-resistant canonical mapping keys', () => {
    expect(
      migrationIdempotencyKey({
        tenantId: 'tenant:a',
        sourceSystem: 'CSV',
        entityType: 'event',
        externalId: ' café ',
      }),
    ).toBe('tenant%3Aa:CSV:event:caf%C3%A9');
  });

  it('summarizes dry runs without domain writes and blocks errors or conflicts', () => {
    const rows: DryRunRow[] = [
      {
        entity: entity('event', 'same'),
        disposition: 'create',
        issues: [{ code: 'TIMEZONE_UNKNOWN', severity: 'warning', message: 'Unknown timezone' }],
      },
      {
        entity: entity('event', 'same'),
        disposition: 'conflict',
        issues: [
          {
            code: 'MAPPING_MISSING',
            severity: 'error',
            message: 'Missing mapping',
            externalId: 'same',
          },
        ],
      },
    ];
    const report = buildDryRunReport({
      rows,
      unsupportedFeatures: ['seating', 'seating'],
      bytesPerRow: 10,
      millisecondsPerRow: 2,
    });
    expect(report).toMatchObject({
      mode: 'dry-run',
      domainWrites: 0,
      counts: { create: 1, update: 0, skip: 0, conflict: 1 },
      timezoneIssues: 1,
      estimate: { runtimeMs: 4, storageBytes: 20 },
    });
    expect(report.duplicateExternalIds).toEqual(['event:same']);
    expect(report.unsupportedFeatures).toEqual(['seating']);
    expect(canCommitDryRun(report)).toBe(false);
  });

  it('requires side-effect-suppressed historical financial provenance', () => {
    const snapshot = createHistoricalFinancialSnapshot({
      kind: 'historical-payment',
      amountMinor: 1200,
      currency: 'USD',
      occurredAt: '2025-01-01T00:00:00Z',
      provenance: {
        sourceSystem: 'csv',
        sourceExternalId: 'pay-1',
        importedAt: '2026-01-01T00:00:00Z',
      },
      reconciliationStatus: 'unreconciled',
    });
    expect(snapshot.sideEffects).toBe('suppressed');
    expect(() =>
      assertHistoricalFinancialEntity({
        ...entity('historical-payment', 'pay-1'),
        financialSnapshot: snapshot,
      }),
    ).not.toThrow();
    expect(() => assertHistoricalFinancialEntity(entity('historical-payment', 'pay-1'))).toThrow();
  });

  it('does not treat ingestion time as historical financial content', () => {
    const snapshot = createHistoricalFinancialSnapshot({
      kind: 'historical-payment',
      amountMinor: 1200,
      currency: 'USD',
      occurredAt: '2025-01-01T00:00:00Z',
      provenance: {
        sourceSystem: 'csv',
        sourceExternalId: 'pay-1',
        importedAt: '2026-01-01T00:00:00Z',
      },
      reconciliationStatus: 'unreconciled',
    });
    const original: NormalizedMigrationEntity = {
      ...entity('historical-payment', 'pay-1'),
      dependencies: [{ entityType: 'historical-order', externalId: 'order-1' }],
      financialSnapshot: snapshot,
    };
    const store = new InMemoryExternalReferenceStore();
    store.commit({ tenantId: 'tenant-1', sourceSystem: 'csv', entities: [original] });
    expect(
      store.disposition({
        tenantId: 'tenant-1',
        sourceSystem: 'csv',
        entity: {
          ...original,
          financialSnapshot: {
            ...snapshot,
            provenance: { ...snapshot.provenance, importedAt: '2026-02-01T00:00:00Z' },
          },
        },
      }),
    ).toBe('skip');
  });

  it('fails rollback closed when activity evidence is missing or live activity exists', () => {
    expect(assessRollback({ committed: false, activated: false, createdEntities: [] })).toEqual({
      eligible: true,
      mode: 'cancel-before-commit',
      entityIds: [],
    });
    expect(
      assessRollback({ committed: true, activated: false, createdEntities: [{ id: 'one' }] }),
    ).toMatchObject({ eligible: false, mode: 'corrective-plan' });
    expect(
      assessRollback({
        committed: true,
        activated: false,
        createdEntities: [
          {
            id: 'one',
            activity: {
              newSales: 1,
              scans: 0,
              transfers: 0,
              edits: 0,
              providerEvents: 0,
              downstreamReferences: 0,
            },
          },
        ],
      }),
    ).toMatchObject({ eligible: false });
    expect(
      assessRollback({
        committed: true,
        activated: false,
        createdEntities: [
          {
            id: 'one',
            activity: {
              newSales: 0,
              scans: 0,
              transfers: 0,
              edits: 0,
              providerEvents: 0,
              downstreamReferences: 0,
            },
          },
        ],
      }),
    ).toEqual({ eligible: true, mode: 'delete-untouched-before-activation', entityIds: ['one'] });
  });
});
