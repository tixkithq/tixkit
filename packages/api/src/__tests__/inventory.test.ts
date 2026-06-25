import { describe, it, expect, beforeEach } from 'vitest';
import { InventoryService } from '../services/inventory.js';
import { InventoryExhaustedError, HoldExpiredError, ValidationError } from '@gatekit/domain';

/**
 * In-memory mock database that simulates inventory_pools and checkout_holds
 * tables with transaction support and the Kysely query-builder chain patterns
 * used by InventoryService.
 */
type Pool = {
  id: string;
  total_capacity: number;
  sold_count: number;
  reserved_count: number;
  hold_ttl_seconds: number;
};

type Hold = {
  id: string;
  inventory_pool_id: string;
  checkout_session_id: string;
  ticket_type_id: string;
  quantity: number;
  expires_at: Date;
  status: string;
  created_at: Date;
  updated_at: Date;
};

class MockTable {
  constructor(
    private rows: Map<string, any>,
  ) {}

  private matches(row: any, conds: Array<{ col: string; val: any }>): boolean {
    return conds.every((c) => {
      if (c.col === 'expires_at') return new Date(row.expires_at) < new Date(c.val);
      return row[c.col] === c.val;
    });
  }

  selectFrom() {
    const conds: Array<{ col: string; val: any }> = [];
    let sumCol: string | null = null;
    let idOnly = false;

    const chain: any = {
      selectAll: () => chain,
      select: (arg: any) => {
        if (typeof arg === 'string') {
          if (arg === 'id') idOnly = true;
        } else if (arg && arg.__sumCol) {
          sumCol = arg.__sumCol;
        }
        return chain;
      },
      where: (col: string, _op: string, val: any) => {
        conds.push({ col, val });
        return chain;
      },
      forUpdate: () => chain,
      executeTakeFirst: () => {
        const rows = this.getRows(conds, sumCol, idOnly);
        return Promise.resolve(rows[0] ?? undefined);
      },
      executeTakeFirstOrThrow: () => {
        const rows = this.getRows(conds, sumCol, idOnly);
        if (!rows[0]) throw new Error('not found');
        return Promise.resolve(rows[0]);
      },
      execute: () => {
        const rows = this.getRows(conds, sumCol, idOnly);
        return Promise.resolve(rows);
      },
    };
    return chain;
  }

  private getRows(conds: Array<{ col: string; val: any }>, sumCol: string | null, idOnly: boolean) {
    let rows = [...this.rows.values()];
    rows = rows.filter((r) => this.matches(r, conds));
    if (sumCol) {
      const total = rows.reduce((s, r) => s + Number(r[sumCol] ?? 0), 0);
      return [{ total_held: total }];
    }
    if (idOnly) return rows.map((r) => ({ id: r.id }));
    return rows;
  }

  updateTable() {
    const conds: Array<{ col: string; val: any }> = [];
    let setFn: ((eb: any) => Record<string, unknown>) | Record<string, unknown> = {};

    const chain: any = {
      set: (values: any) => { setFn = values; return chain; },
      where: (col: string, _op: string, val: any) => {
        conds.push({ col, val });
        return chain;
      },
      executeTakeFirst: () =>
        chain.execute().then(() => ({ numUpdatedRows: BigInt(conds.length > 0 ? 1 : 0) })),
      execute: async () => {
        const rows = [...this.rows.values()].filter((r) => this.matches(r, conds));
        for (const row of rows) {
          if (typeof setFn === 'function') {
            const eb = (col: string, op: string, value: any) => {
              const current = Number(row[col] ?? 0);
              if (op === '+') return current + Number(value);
              if (op === '-') return current - Number(value);
              return value;
            };
            const resolved = setFn(eb);
            for (const [k, v] of Object.entries(resolved)) row[k] = v;
          } else {
            for (const [k, v] of Object.entries(setFn as Record<string, unknown>)) row[k] = v;
          }
        }
      },
    };
    return chain;
  }

  insertInto() {
    let vals: Record<string, unknown> = {};
    const chain: any = {
      values: (v: Record<string, unknown>) => { vals = v; return chain; },
      execute: async () => {
        this.rows.set(vals.id as string, vals as any);
      },
    };
    return chain;
  }
}

function createMockDb() {
  const pools = new Map<string, Pool>();
  const holds = new Map<string, Hold>();

  const poolTable = new MockTable(pools);
  const holdTable = new MockTable(holds);

  const baseApi = {
    selectFrom: (table: string) =>
      table === 'inventory_pools' ? poolTable.selectFrom() : holdTable.selectFrom(),
    updateTable: (table: string) =>
      table === 'inventory_pools' ? poolTable.updateTable() : holdTable.updateTable(),
    insertInto: (table: string) =>
      table === 'checkout_holds' ? holdTable.insertInto() : { values: () => ({ execute: () => Promise.resolve() }) },
    fn: {
      sum: (col: string) => ({ __sumCol: col, as: () => ({ __sumCol: col }) }),
    },
  };

  const db: any = {
    ...baseApi,
    transaction: () => ({
      execute: async (fn: (trx: any) => Promise<any>) => {
        const poolSnapshot = new Map([...pools.entries()].map(([id, row]) => [id, { ...row }]));
        const holdSnapshot = new Map([...holds.entries()].map(([id, row]) => [id, { ...row }]));
        try {
          return await fn(baseApi);
        } catch (err) {
          pools.clear();
          for (const [id, row] of poolSnapshot) pools.set(id, row);
          holds.clear();
          for (const [id, row] of holdSnapshot) holds.set(id, row);
          throw err;
        }
      },
    }),
  };

  function addPool(p: Partial<Pool> & { id: string }) {
    pools.set(p.id, {
      total_capacity: 100,
      sold_count: 0,
      reserved_count: 0,
      hold_ttl_seconds: 300,
      ...p,
    } as Pool);
  }

  function addHold(h: Partial<Hold> & { id: string }) {
    holds.set(h.id, {
      inventory_pool_id: 'pool_1',
      checkout_session_id: 'cs_1',
      ticket_type_id: 'tt_1',
      quantity: 1,
      expires_at: new Date(Date.now() + 300_000),
      status: 'active',
      created_at: new Date(),
      updated_at: new Date(),
      ...h,
    } as Hold);
  }

  return {
    db,
    addPool,
    addHold,
    getPool: (id: string) => pools.get(id),
    getHold: (id: string) => holds.get(id),
    pools,
    holds,
  };
}

describe('InventoryService', () => {
  let mock: ReturnType<typeof createMockDb>;
  let service: InventoryService;

  beforeEach(() => {
    mock = createMockDb();
    service = new InventoryService(mock.db);
  });

  describe('reserveCart', () => {
    it('reserves inventory for a single-item cart', async () => {
      mock.addPool({ id: 'pool_1', total_capacity: 10, sold_count: 0 });

      const result = await service.reserveCart({
        items: [{ inventoryPoolId: 'pool_1', ticketTypeId: 'tt_1', quantity: 2 }],
        checkoutSessionId: 'cs_1',
      });

      expect(result.holds).toHaveLength(1);
      expect(result.holds[0].quantity).toBe(2);
      expect(result.primaryHoldId).toBeDefined();
    });

    it('throws InventoryExhaustedError when insufficient availability', async () => {
      mock.addPool({ id: 'pool_1', total_capacity: 5, sold_count: 4 });

      await expect(
        service.reserveCart({
          items: [{ inventoryPoolId: 'pool_1', ticketTypeId: 'tt_1', quantity: 3 }],
          checkoutSessionId: 'cs_1',
        }),
      ).rejects.toThrow(InventoryExhaustedError);
    });

    it('aggregates quantity per pool across multiple ticket types', async () => {
      mock.addPool({ id: 'pool_1', total_capacity: 10, sold_count: 0 });

      const result = await service.reserveCart({
        items: [
          { inventoryPoolId: 'pool_1', ticketTypeId: 'tt_1', quantity: 3 },
          { inventoryPoolId: 'pool_1', ticketTypeId: 'tt_2', quantity: 4 },
        ],
        checkoutSessionId: 'cs_1',
      });

      expect(result.holds).toHaveLength(2);
    });

    it('throws on empty cart', async () => {
      await expect(
        service.reserveCart({ items: [], checkoutSessionId: 'cs_1' }),
      ).rejects.toThrow(InventoryExhaustedError);
    });

    it('rejects non-positive quantities before creating holds', async () => {
      mock.addPool({ id: 'pool_1', total_capacity: 10, sold_count: 0 });

      await expect(
        service.reserveCart({
          items: [{ inventoryPoolId: 'pool_1', ticketTypeId: 'tt_1', quantity: 0 }],
          checkoutSessionId: 'cs_1',
        }),
      ).rejects.toThrow(ValidationError);

      expect(mock.holds.size).toBe(0);
    });

    it('accounts for existing active holds', async () => {
      mock.addPool({ id: 'pool_1', total_capacity: 10, sold_count: 0 });
      mock.addHold({
        id: 'hld_existing',
        inventory_pool_id: 'pool_1',
        quantity: 6,
        status: 'active',
      });

      await expect(
        service.reserveCart({
          items: [{ inventoryPoolId: 'pool_1', ticketTypeId: 'tt_1', quantity: 5 }],
          checkoutSessionId: 'cs_2',
        }),
      ).rejects.toThrow(InventoryExhaustedError);
    });

    it('rolls back all hold inserts when any pool in the cart is exhausted', async () => {
      mock.addPool({ id: 'pool_1', total_capacity: 10, sold_count: 0 });
      mock.addPool({ id: 'pool_2', total_capacity: 1, sold_count: 0 });

      await expect(
        service.reserveCart({
          items: [
            { inventoryPoolId: 'pool_1', ticketTypeId: 'tt_1', quantity: 2 },
            { inventoryPoolId: 'pool_2', ticketTypeId: 'tt_2', quantity: 2 },
          ],
          checkoutSessionId: 'cs_1',
        }),
      ).rejects.toThrow(InventoryExhaustedError);

      expect(mock.holds.size).toBe(0);
    });
  });

  describe('convertHoldsForSession', () => {
    it('converts active holds and increments sold_count', async () => {
      mock.addPool({ id: 'pool_1', total_capacity: 10, sold_count: 0 });
      mock.addHold({
        id: 'hld_1',
        inventory_pool_id: 'pool_1',
        checkout_session_id: 'cs_1',
        quantity: 3,
        status: 'active',
      });

      await service.convertHoldsForSession('cs_1');

      expect(mock.getHold('hld_1')!.status).toBe('converted');
      expect(mock.getPool('pool_1')!.sold_count).toBe(3);
    });

    it('is idempotent: already-converted holds are skipped', async () => {
      mock.addPool({ id: 'pool_1', total_capacity: 10, sold_count: 3 });
      mock.addHold({
        id: 'hld_1',
        inventory_pool_id: 'pool_1',
        checkout_session_id: 'cs_1',
        quantity: 3,
        status: 'converted',
      });

      await service.convertHoldsForSession('cs_1');

      expect(mock.getPool('pool_1')!.sold_count).toBe(3);
    });
  });

  describe('releaseHoldsForSession', () => {
    it('releases active holds for a session', async () => {
      mock.addPool({ id: 'pool_1', total_capacity: 10, sold_count: 0 });
      mock.addHold({
        id: 'hld_1',
        inventory_pool_id: 'pool_1',
        checkout_session_id: 'cs_1',
        quantity: 2,
        status: 'active',
      });

      await service.releaseHoldsForSession('cs_1');

      expect(mock.getHold('hld_1')!.status).toBe('released');
    });

    it('does not release already-converted holds', async () => {
      mock.addHold({
        id: 'hld_1',
        checkout_session_id: 'cs_1',
        status: 'converted',
      });

      await service.releaseHoldsForSession('cs_1');

      expect(mock.getHold('hld_1')!.status).toBe('converted');
    });
  });

  describe('reserveInventory (single)', () => {
    it('reserves a single item', async () => {
      mock.addPool({ id: 'pool_1', total_capacity: 10, sold_count: 0 });

      const result = await service.reserveInventory({
        inventoryPoolId: 'pool_1',
        ticketTypeId: 'tt_1',
        quantity: 2,
        checkoutSessionId: 'cs_1',
      });

      expect(result.holdId).toBeDefined();
      expect(result.expiresAt).toBeInstanceOf(Date);
    });

    it('throws on oversell', async () => {
      mock.addPool({ id: 'pool_1', total_capacity: 3, sold_count: 2 });

      await expect(
        service.reserveInventory({
          inventoryPoolId: 'pool_1',
          ticketTypeId: 'tt_1',
          quantity: 5,
          checkoutSessionId: 'cs_1',
        }),
      ).rejects.toThrow(InventoryExhaustedError);
    });

    it('rejects non-positive quantities before creating a hold', async () => {
      mock.addPool({ id: 'pool_1', total_capacity: 10, sold_count: 0 });

      await expect(
        service.reserveInventory({
          inventoryPoolId: 'pool_1',
          ticketTypeId: 'tt_1',
          quantity: 0,
          checkoutSessionId: 'cs_1',
        }),
      ).rejects.toThrow(ValidationError);

      expect(mock.holds.size).toBe(0);
    });
  });

  describe('convertHold (single)', () => {
    it('converts an active hold', async () => {
      mock.addPool({ id: 'pool_1', total_capacity: 10, sold_count: 0 });
      mock.addHold({ id: 'hld_1', inventory_pool_id: 'pool_1', quantity: 2, status: 'active' });

      await service.convertHold('hld_1');

      expect(mock.getHold('hld_1')!.status).toBe('converted');
      expect(mock.getPool('pool_1')!.sold_count).toBe(2);
    });

    it('throws HoldExpiredError for expired hold', async () => {
      mock.addHold({ id: 'hld_1', status: 'expired' });

      await expect(service.convertHold('hld_1')).rejects.toThrow(HoldExpiredError);
    });

    it('is idempotent for already-converted holds', async () => {
      mock.addPool({ id: 'pool_1', total_capacity: 10, sold_count: 2 });
      mock.addHold({ id: 'hld_1', inventory_pool_id: 'pool_1', quantity: 2, status: 'converted' });

      await service.convertHold('hld_1');

      expect(mock.getPool('pool_1')!.sold_count).toBe(2);
    });
  });

  describe('releaseHold (single)', () => {
    it('releases an active hold', async () => {
      mock.addHold({ id: 'hld_1', status: 'active' });

      await service.releaseHold('hld_1');

      expect(mock.getHold('hld_1')!.status).toBe('released');
    });

    it('does nothing for non-active hold', async () => {
      mock.addHold({ id: 'hld_1', status: 'converted' });

      await service.releaseHold('hld_1');

      expect(mock.getHold('hld_1')!.status).toBe('converted');
    });
  });

  describe('getAvailability', () => {
    it('returns correct availability', async () => {
      mock.addPool({ id: 'pool_1', total_capacity: 100, sold_count: 30 });
      mock.addHold({ id: 'hld_1', inventory_pool_id: 'pool_1', quantity: 20, status: 'active' });

      const avail = await service.getAvailability('pool_1');

      expect(avail.total).toBe(100);
      expect(avail.sold).toBe(30);
      expect(avail.reserved).toBe(20);
      expect(avail.available).toBe(50);
    });

    it('expires stale active holds before calculating availability', async () => {
      mock.addPool({ id: 'pool_1', total_capacity: 10, sold_count: 2 });
      mock.addHold({
        id: 'hld_stale',
        inventory_pool_id: 'pool_1',
        quantity: 5,
        status: 'active',
        expires_at: new Date(Date.now() - 10_000),
      });
      mock.addHold({
        id: 'hld_fresh',
        inventory_pool_id: 'pool_1',
        quantity: 3,
        status: 'active',
        expires_at: new Date(Date.now() + 10_000),
      });

      const avail = await service.getAvailability('pool_1');

      expect(mock.getHold('hld_stale')!.status).toBe('expired');
      expect(avail).toEqual({ total: 10, sold: 2, reserved: 3, available: 5 });
    });

    it('returns zeros for non-existent pool', async () => {
      const avail = await service.getAvailability('nonexistent');
      expect(avail).toEqual({ total: 0, sold: 0, reserved: 0, available: 0 });
    });
  });

  describe('expireStaleHolds', () => {
    it('expires holds past their expiry', async () => {
      mock.addHold({
        id: 'hld_stale',
        status: 'active',
        expires_at: new Date(Date.now() - 10000),
      });
      mock.addHold({
        id: 'hld_fresh',
        status: 'active',
        expires_at: new Date(Date.now() + 10000),
      });

      const count = await service.expireStaleHolds();

      expect(count).toBe(1);
      expect(mock.getHold('hld_stale')!.status).toBe('expired');
      expect(mock.getHold('hld_fresh')!.status).toBe('active');
    });

    it('returns 0 when no stale holds', async () => {
      const count = await service.expireStaleHolds();
      expect(count).toBe(0);
    });
  });
});
