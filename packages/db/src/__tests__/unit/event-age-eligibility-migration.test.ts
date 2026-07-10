import { describe, expect, it } from 'vitest';
import { EventAgeEligibilityMigration } from '../../migrations/0052_event_age_eligibility.js';

class FakeAlterTable {
  constructor(
    private readonly table: string,
    private readonly operations: string[],
  ) {}

  addColumn(column: string, type: string) {
    this.operations.push(`add:${this.table}:${column}:${type}`);
    return this;
  }

  dropColumn(column: string) {
    this.operations.push(`drop:${this.table}:${column}`);
    return this;
  }

  async execute() {}
}

describe('EventAgeEligibilityMigration', () => {
  it('adds and removes event, order, and attendee eligibility columns', async () => {
    const operations: string[] = [];
    const db = {
      schema: {
        alterTable: (table: string) => new FakeAlterTable(table, operations),
      },
    };

    await EventAgeEligibilityMigration.up(db as never);
    expect(operations).toEqual([
      'add:events:minimum_age:integer',
      'add:orders:buyer_date_of_birth:varchar(10)',
      'add:attendees:date_of_birth:varchar(10)',
    ]);

    operations.length = 0;
    await EventAgeEligibilityMigration.down?.(db as never);
    expect(operations).toEqual([
      'drop:attendees:date_of_birth',
      'drop:orders:buyer_date_of_birth',
      'drop:events:minimum_age',
    ]);
  });
});
