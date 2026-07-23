import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TixkitMigrationProvider } from '../../migrate.js';
import { TicketTypeDependencyIndexesMigration } from '../../migrations/0099_ticket_type_batch_hot_path_indexes.js';

const source = readFileSync(
  new URL('../../migrations/0099_ticket_type_batch_hot_path_indexes.ts', import.meta.url),
  'utf8',
);

describe('TicketTypeDependencyIndexesMigration', () => {
  it('is the final registered migration', async () => {
    const migrations = await new TixkitMigrationProvider().getMigrations();
    expect(Object.keys(migrations).at(-1)).toBe('0099_ticket_type_batch_hot_path_indexes');
    expect(migrations['0099_ticket_type_batch_hot_path_indexes']).toBe(
      TicketTypeDependencyIndexesMigration,
    );
  });

  it('declares the four dependency probes and validates the existing waitlist index', () => {
    for (const indexName of [
      'idx_checkout_holds_ticket_type_id',
      'idx_order_line_items_ticket_type_id',
      'idx_tickets_ticket_type_id',
      'idx_access_rules_ticket_type_id',
    ]) {
      expect(source).toContain(indexName);
    }
    for (const supportIndexName of [
      'checkout_holds_ticket_type_fk',
      'order_line_items_ticket_type_fk',
      'tickets_ticket_type_fk',
      'access_rules_ticket_type_fk',
    ]) {
      expect(source).toContain(supportIndexName);
    }
    expect(source).toContain('idx_waitlist_entries_ticket_status');
    expect(source).toContain("['ticket_type_id', 'status', 'created_at']");
  });

  it('fails closed on invalid same-name definitions and restores MySQL FK support', () => {
    expect(source).toContain('expected an ordinary visible valid B-tree');
    expect(source).toContain('actual.ordinaryBtree');
    expect(source).toContain('restoreMysqlForeignKeySupportIndex');
  });
});
