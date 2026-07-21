import { describe, expect, it } from 'vitest';
import type { Database } from '../../client.js';
import { TicketListingRepository } from '../../repositories/ticket.js';

describe('TicketListingRepository', () => {
  it('binds admin keyset reads to tenant, event, id order, cursor and limit', async () => {
    const whereCalls: Array<[string, string, unknown]> = [];
    const orderByCalls: Array<[string, string]> = [];
    const limitCalls: number[] = [];
    const query = {
      selectAll() {
        return query;
      },
      where(column: string, operator: string, value: unknown) {
        whereCalls.push([column, operator, value]);
        return query;
      },
      orderBy(column: string, direction: string) {
        orderByCalls.push([column, direction]);
        return query;
      },
      limit(value: number) {
        limitCalls.push(value);
        return query;
      },
      execute() {
        return Promise.resolve([]);
      },
    };
    const db = {
      selectFrom(tableName: string) {
        expect(tableName).toBe('ticket_listings');
        return query;
      },
    } as unknown as Database;

    await new TicketListingRepository(db).findByEvent('tnt_1', 'evt_1', 2, 'lst_1');

    expect(whereCalls).toEqual([
      ['tenant_id', '=', 'tnt_1'],
      ['event_id', '=', 'evt_1'],
      ['id', '>', 'lst_1'],
    ]);
    expect(orderByCalls).toEqual([['id', 'asc']]);
    expect(limitCalls).toEqual([2]);
  });
});
