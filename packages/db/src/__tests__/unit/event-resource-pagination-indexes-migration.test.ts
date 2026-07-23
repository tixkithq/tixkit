import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TixkitMigrationProvider } from '../../migrate.js';
import { EventResourcePaginationIndexesMigration } from '../../migrations/0096_event_resource_pagination_indexes.js';

const source = readFileSync(
  new URL('../../migrations/0096_event_resource_pagination_indexes.ts', import.meta.url),
  'utf8',
);

describe('EventResourcePaginationIndexesMigration', () => {
  it('remains registered before the three newer additive index migrations', async () => {
    const migrations = await new TixkitMigrationProvider().getMigrations();

    expect(Object.keys(migrations).at(-4)).toBe('0096_event_resource_pagination_indexes');
    expect(migrations['0096_event_resource_pagination_indexes']).toBe(
      EventResourcePaginationIndexesMigration,
    );
  });

  it('declares exact composite and fallback index definitions', () => {
    expect(source).toContain("name: 'idx_ticket_types_event_id'");
    expect(source).toContain("name: 'idx_inventory_pools_event_id'");
    expect(source.match(/columns: \['event_id', 'id'\]/g)).toHaveLength(2);
    expect(source).toContain("name: 'idx_ticket_types_event'");
    expect(source).toContain("name: 'idx_inventory_pools_event'");
    expect(source.match(/columns: \['event_id'\]/g)).toHaveLength(2);
  });

  it('creates replacements before dropping old indexes and restores fallbacks before rollback drops', () => {
    const upSource = source.slice(source.indexOf('async up'), source.indexOf('async down'));
    const downSource = source.slice(source.indexOf('async down'));

    expect(upSource.indexOf('createEventResourcePaginationIndexes(db)')).toBeLessThan(
      upSource.indexOf("dropIndex(db, 'ticket_types', 'idx_ticket_types_event', ['event_id'])"),
    );
    expect(upSource.indexOf('createEventResourcePaginationIndexes(db)')).toBeLessThan(
      upSource.indexOf(
        "dropIndex(db, 'inventory_pools', 'idx_inventory_pools_event', ['event_id'])",
      ),
    );
    expect(downSource.indexOf('restoreEventResourceIndexes(db)')).toBeLessThan(
      downSource.indexOf(
        "dropIndex(db, 'ticket_types', 'idx_ticket_types_event_id', ['event_id', 'id'])",
      ),
    );
    expect(downSource.indexOf('restoreEventResourceIndexes(db)')).toBeLessThan(
      downSource.indexOf(
        "dropIndex(db, 'inventory_pools', 'idx_inventory_pools_event_id', ['event_id', 'id'])",
      ),
    );
  });

  it('checks exact ordered index definitions before every additive or destructive operation', () => {
    expect(source).toContain('const existingDefinition = await indexDefinition');
    expect(source).toContain('const actualDefinition = await indexDefinition');
    expect(source).toContain('assertIndexDefinition(input.table, input.name');
    expect(source).toContain('assertIndexDefinition(tableName, indexName');
    expect(source).toContain('actual.columns.some((column, index) => column !== expected[index])');
    expect(source).toContain('!actual.ordinaryBtree');
    expect(source).toContain('information_schema.statistics');
    expect(source).toContain('is_visible as isVisible');
    expect(source).toContain('pg_index');
    expect(source).toContain('index_definition.indisvalid');
    expect(source).toContain('index_definition.indisready');
    expect(source).toContain('pg_get_expr(index_definition.indpred');
    expect(source).toContain('sys.indexes');
    expect(source).toContain('idx.is_disabled as isDisabled');
    expect(source).toContain('idx.has_filter as hasFilter');
  });
});
