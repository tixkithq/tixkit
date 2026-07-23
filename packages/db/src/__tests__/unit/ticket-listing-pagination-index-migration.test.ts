import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TixkitMigrationProvider } from '../../migrate.js';
import { TicketListingPaginationIndexMigration } from '../../migrations/0098_ticket_listing_pagination_index.js';

const source = readFileSync(
  new URL('../../migrations/0098_ticket_listing_pagination_index.ts', import.meta.url),
  'utf8',
);

describe('TicketListingPaginationIndexMigration', () => {
  it('remains registered immediately before the ticket-type hot-path migration', async () => {
    const migrations = await new TixkitMigrationProvider().getMigrations();

    expect(Object.keys(migrations).at(-1)).toBe('0100_affiliate_report_indexes');
    expect(migrations['0098_ticket_listing_pagination_index']).toBe(
      TicketListingPaginationIndexMigration,
    );
  });

  it('declares the exact tenant/event/id keyset index', () => {
    expect(source).toContain("'idx_ticket_listings_event_id'");
    expect(source).toContain("const columns = ['tenant_id', 'event_id', 'id']");
    expect(source).not.toContain("dropIndex('idx_ticket_listings_event_status')");
  });

  it('fails closed on ordered-column and unusable same-name drift before create or drop', () => {
    expect(source).toContain('assertIndexDefinition(existingDefinition, columns)');
    expect(source).toContain(
      "assertIndexDefinition(existingDefinition, ['tenant_id', 'event_id', 'id'])",
    );
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
