import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TixkitMigrationProvider } from '../../migrate.js';
import { AffiliateReportIndexesMigration } from '../../migrations/0100_affiliate_report_indexes.js';

const source = readFileSync(
  new URL('../../migrations/0100_affiliate_report_indexes.ts', import.meta.url),
  'utf8',
);

describe('AffiliateReportIndexesMigration', () => {
  it('is the final registered migration', async () => {
    const migrations = await new TixkitMigrationProvider().getMigrations();

    expect(Object.keys(migrations).at(-1)).toBe('0100_affiliate_report_indexes');
    expect(migrations['0100_affiliate_report_indexes']).toBe(AffiliateReportIndexesMigration);
  });

  it('declares the scoped affiliate and attribution join indexes', () => {
    expect(source).toContain("'idx_affiliates_tenant_organization_id'");
    expect(source).toContain("['tenant_id', 'organization_id', 'id']");
    expect(source).toContain("'idx_attributions_affiliate_order_id'");
    expect(source).toContain("['affiliate_id', 'order_id']");
  });

  it('fails closed on same-name definition drift before up or down', () => {
    expect(source).toContain('assertIndexDefinition(tableName, indexName, existing, columns)');
    expect(source).toContain('actual.columns.some((column, index) => column !== expected[index])');
    expect(source).toContain('!actual.ordinaryBtree');
  });
});
