import type { Database } from '@tixkit/db';
import { describe, expect, it } from 'vitest';
import { loadPublicEventMedia } from '../routes/modules/public.js';

describe('public event media scope', () => {
  it('requires every ownership dimension before reading event media assets', async () => {
    const whereCalls: Array<[string, string, unknown]> = [];
    const orderByCalls: Array<[string, string]> = [];
    const query = {
      select() {
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
      execute() {
        return Promise.resolve([]);
      },
    };
    const db = {
      selectFrom(tableName: string) {
        expect(tableName).toBe('event_media_assets');
        return query;
      },
    } as unknown as Database;

    await expect(
      loadPublicEventMedia(db, {
        eventId: 'evt_1',
        tenantId: 'tnt_1',
        organizationId: 'org_1',
        brandId: 'brd_1',
      }),
    ).resolves.toEqual([]);

    expect(whereCalls).toEqual([
      ['tenant_id', '=', 'tnt_1'],
      ['organization_id', '=', 'org_1'],
      ['brand_id', '=', 'brd_1'],
      ['event_id', '=', 'evt_1'],
    ]);
    expect(orderByCalls).toEqual([['role', 'asc']]);
  });
});
