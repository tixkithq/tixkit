import { describe, expect, it } from 'vitest';
import {
  assessRollback, assertHistoricalFinancialEntity, buildDryRunReport, canCommitDryRun,
  chunkMigrationEntities, createHistoricalFinancialSnapshot, migrationIdempotencyKey,
  sortEntitiesByDependency, type DryRunRow, type NormalizedMigrationEntity,
} from '../index.js';

const entity = (entityType: NormalizedMigrationEntity['entityType'], externalId: string): NormalizedMigrationEntity => ({
  entityType, externalId, sourcePosition: externalId, attributes: {},
});

describe('migration core', () => {
  it('orders and chunks entities deterministically by dependency then external id', () => {
    const input = [entity('ticket', 'z'), entity('organization', 'b'), entity('organization', 'a')];
    expect(sortEntitiesByDependency(input).map(({ externalId }) => externalId)).toEqual(['a', 'b', 'z']);
    expect(chunkMigrationEntities(input, 2).map((chunk) => chunk.map(({ externalId }) => externalId))).toEqual([['a', 'b'], ['z']]);
    expect(() => chunkMigrationEntities(input, 0)).toThrow(RangeError);
  });

  it('creates collision-resistant canonical mapping keys', () => {
    expect(migrationIdempotencyKey({ tenantId: 'tenant:a', sourceSystem: 'CSV', entityType: 'event', externalId: ' café ' }))
      .toBe('tenant%3Aa:CSV:event:caf%C3%A9');
  });

  it('summarizes dry runs without domain writes and blocks errors or conflicts', () => {
    const rows: DryRunRow[] = [
      { entity: entity('event', 'same'), disposition: 'create', issues: [{ code: 'TIMEZONE_UNKNOWN', severity: 'warning', message: 'Unknown timezone' }] },
      { entity: entity('event', 'same'), disposition: 'conflict', issues: [{ code: 'MAPPING_MISSING', severity: 'error', message: 'Missing mapping', externalId: 'same' }] },
    ];
    const report = buildDryRunReport({ rows, unsupportedFeatures: ['seating', 'seating'], bytesPerRow: 10, millisecondsPerRow: 2 });
    expect(report).toMatchObject({ mode: 'dry-run', domainWrites: 0, counts: { create: 1, update: 0, skip: 0, conflict: 1 }, timezoneIssues: 1, estimate: { runtimeMs: 4, storageBytes: 20 } });
    expect(report.duplicateExternalIds).toEqual(['event:same']);
    expect(report.unsupportedFeatures).toEqual(['seating']);
    expect(canCommitDryRun(report)).toBe(false);
  });

  it('requires side-effect-suppressed historical financial provenance', () => {
    const snapshot = createHistoricalFinancialSnapshot({ kind: 'historical-payment', amountMinor: 1200, currency: 'USD', occurredAt: '2025-01-01T00:00:00Z', provenance: { sourceSystem: 'csv', sourceExternalId: 'pay-1', importedAt: '2026-01-01T00:00:00Z' }, reconciliationStatus: 'unreconciled' });
    expect(snapshot.sideEffects).toBe('suppressed');
    expect(() => assertHistoricalFinancialEntity({ ...entity('historical-payment', 'pay-1'), financialSnapshot: snapshot })).not.toThrow();
    expect(() => assertHistoricalFinancialEntity(entity('historical-payment', 'pay-1'))).toThrow();
  });

  it('fails rollback closed when activity evidence is missing or live activity exists', () => {
    expect(assessRollback({ committed: false, activated: false, createdEntities: [] })).toEqual({ eligible: true, mode: 'cancel-before-commit', entityIds: [] });
    expect(assessRollback({ committed: true, activated: false, createdEntities: [{ id: 'one' }] })).toMatchObject({ eligible: false, mode: 'corrective-plan' });
    expect(assessRollback({ committed: true, activated: false, createdEntities: [{ id: 'one', activity: { newSales: 1, scans: 0, transfers: 0, edits: 0, providerEvents: 0, downstreamReferences: 0 } }] })).toMatchObject({ eligible: false });
    expect(assessRollback({ committed: true, activated: false, createdEntities: [{ id: 'one', activity: { newSales: 0, scans: 0, transfers: 0, edits: 0, providerEvents: 0, downstreamReferences: 0 } }] })).toEqual({ eligible: true, mode: 'delete-untouched-before-activation', entityIds: ['one'] });
  });
});
