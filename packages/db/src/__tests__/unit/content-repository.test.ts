import { describe, expect, it } from 'vitest';
import type { Database } from '../../client.js';
import { ContentRepository } from '../../repositories/content.js';

function createSelectDb() {
  const whereCalls: Array<[string, string, unknown]> = [];
  const query = {
    selectAll() {
      return query;
    },
    where(column: string, op: string, value: unknown) {
      whereCalls.push([column, op, value]);
      return query;
    },
    orderBy() {
      return query;
    },
    limit() {
      return query;
    },
    execute() {
      return Promise.resolve([]);
    },
  };

  return {
    whereCalls,
    db: {
      selectFrom(table: string) {
        expect(table).toBe('content_documents');
        return query;
      },
    } as unknown as Database,
  };
}

describe('ContentRepository', () => {
  it('applies tenant, scope, and channel filters when listing documents', async () => {
    const { db, whereCalls } = createSelectDb();

    await new ContentRepository(db).listDocuments({
      tenantId: 'tnt_1',
      organizationIds: ['org_1'],
      brandIds: ['brd_1'],
      eventIds: ['evt_1'],
      brandId: 'brd_1',
      eventId: 'evt_1',
      channel: 'email',
    });

    expect(whereCalls).toEqual([
      ['tenant_id', '=', 'tnt_1'],
      ['organization_id', 'in', ['org_1']],
      ['brand_id', 'in', ['brd_1']],
      ['event_id', 'in', ['evt_1']],
      ['channel', '=', 'email'],
      ['brand_id', '=', 'brd_1'],
      ['event_id', '=', 'evt_1'],
    ]);
  });
});
