import { describe, expect, test } from 'vitest';
import type { MigrationAdapter } from '../../../index.js';
import { defineBespokeAdapter, runBespokeAdapterConformance } from '../index.js';

type Configuration = { rows: readonly { id: string; name: string }[] };

const adapter: MigrationAdapter<Configuration, number> = {
  id: 'sample-official-export',
  supportedVersions: ['2026-01'],
  async discover(configuration) {
    return {
      source: { sourceSystem: this.id, sourceVersion: '2026-01' },
      entities: [{ type: 'event', estimatedRows: configuration.rows.length }],
    };
  },
  async extract({ configuration, cursor = 0, limit }) {
    const rows = configuration.rows.slice(cursor, cursor + limit).map((row, index) => ({
      externalId: row.id,
      entityType: 'event' as const,
      sourcePosition: `events:${cursor + index}`,
      data: row,
    }));
    const next = cursor + rows.length;
    return { rows, nextCursor: next < configuration.rows.length ? next : undefined };
  },
  async normalize(row) {
    return { ...row, attributes: row.data };
  },
  async validate(entity) {
    return entity.attributes.name
      ? []
      : [{ code: 'NAME_REQUIRED', severity: 'error' as const, message: 'name is required' }];
  },
};

const definition = defineBespokeAdapter({
  adapter,
  metadata: {
    displayName: 'Sample Official Export',
    officialSource: 'Vendor-supported JSON export',
    supportedVersions: ['2026-01'],
    featureMap: { events: 'event' },
    knownLosses: [],
    rateLimit: { strategy: 'offline export; no remote requests', maximumPageSize: 50 },
  },
});

describe('bespoke adapter conformance', () => {
  test('certifies deterministic identity, normalization, and validation', async () => {
    const result = await runBespokeAdapterConformance({
      definition,
      configuration: { rows: [{ id: 'event-1', name: 'Sample' }] },
      context: { tenantId: 'tenant-1', organizationId: 'organization-1' },
    });
    expect(result.entities).toHaveLength(1);
    expect(result.issues).toEqual([]);
    expect(result.idempotencyKeys[0]).toContain('sample-official-export:event:event-1');
  });

  test('rejects metadata that overstates supported versions', () => {
    expect(() =>
      defineBespokeAdapter({
        ...definition,
        metadata: { ...definition.metadata, supportedVersions: ['2099-01'] },
      }),
    ).toThrow('declared by the adapter');
  });

  test('rejects nondeterministic extraction', async () => {
    let sequence = 0;
    const nondeterministic = {
      ...adapter,
      async extract() {
        sequence += 1;
        return {
          rows: [
            {
              externalId: `${sequence}`,
              entityType: 'event' as const,
              sourcePosition: 'events:0',
              data: { name: 'Sample' },
            },
          ],
        };
      },
    };
    await expect(
      runBespokeAdapterConformance({
        definition: { ...definition, adapter: nondeterministic },
        configuration: { rows: [] },
        context: { tenantId: 'tenant-1', organizationId: 'organization-1' },
      }),
    ).rejects.toThrow('deterministic');
  });
});
