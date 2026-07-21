import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TixkitMigrationProvider } from '../../migrate.js';
import { ProductCatalogPaginationIndexesMigration } from '../../migrations/0097_product_catalog_pagination_indexes.js';

const source = readFileSync(
  new URL('../../migrations/0097_product_catalog_pagination_indexes.ts', import.meta.url),
  'utf8',
);

describe('ProductCatalogPaginationIndexesMigration', () => {
  it('is the final registered migration', async () => {
    const migrations = await new TixkitMigrationProvider().getMigrations();

    expect(Object.keys(migrations).at(-1)).toBe('0097_product_catalog_pagination_indexes');
    expect(migrations['0097_product_catalog_pagination_indexes']).toBe(
      ProductCatalogPaginationIndexesMigration,
    );
  });

  it('declares exact product-catalog keyset indexes', () => {
    expect(source).toContain("name: 'idx_product_categories_event_id'");
    expect(source).toContain("name: 'idx_products_event_id'");
    expect(source.match(/columns: \['event_id', 'id'\]/g)).toHaveLength(2);
    expect(source).toContain("name: 'product_categories_event_fk'");
    expect(source).toContain("name: 'products_event_fk'");
    expect(source.match(/columns: \['event_id'\]/g)).toHaveLength(2);
  });

  it('normalizes MySQL foreign-key support indexes without an unindexed transition', () => {
    const upSource = source.slice(source.indexOf('async up'), source.indexOf('async down'));
    const downSource = source.slice(source.indexOf('async down'));

    expect(upSource.indexOf("name: 'idx_products_event_id'")).toBeLessThan(
      upSource.indexOf("dropIndex(db, 'products', 'products_event_fk'"),
    );
    expect(upSource.indexOf("name: 'idx_product_categories_event_id'")).toBeLessThan(
      upSource.indexOf("dropIndex(db, 'product_categories', 'product_categories_event_fk'"),
    );
    expect(downSource.indexOf("name: 'products_event_fk'")).toBeLessThan(
      downSource.indexOf("dropIndex(db, 'products', 'idx_products_event_id'"),
    );
    expect(downSource.indexOf("name: 'product_categories_event_fk'")).toBeLessThan(
      downSource.indexOf("dropIndex(db, 'product_categories', 'idx_product_categories_event_id'"),
    );
  });

  it('fails closed on ordered-column and unusable same-name drift before create or drop', () => {
    expect(source).toContain('assertIndexDefinition(input.table, input.name');
    expect(source).toContain('assertIndexDefinition(tableName, indexName');
    expect(source).toContain('actual.columns.some((column, index) => column !== expected[index])');
    expect(source).toContain('!actual.ordinaryBtree');
    expect(source).toContain('is_visible as isVisible');
    expect(source).toContain('index_definition.indisvalid');
    expect(source).toContain('index_definition.indisready');
    expect(source).toContain('pg_get_expr(index_definition.indpred');
    expect(source).toContain('idx.is_disabled as isDisabled');
    expect(source).toContain('idx.has_filter as hasFilter');
  });
});
