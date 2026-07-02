import { describe, it, expect, beforeEach } from 'vitest';
import { InventoryService } from '../services/inventory.js';
import { InventoryExhaustedError, HoldExpiredError, ValidationError } from '@tixkit/domain';

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

type Occurrence = {
  id: string;
  capacity: number | null;
};

type Hold = {
  id: string;
  inventory_pool_id: string;
  checkout_session_id: string;
  ticket_type_id: string;
  event_occurrence_id: string | null;
  quantity: number;
  expires_at: Date;
  status: string;
  created_at: Date;
  updated_at: Date;
};

type Ticket = {
  id: string;
  event_occurrence_id: string | null;
  status: string;
};

class MockTable {
  constructor(private rows: Map<string, any>) {}

  private matches(row: any, conds: Array<{ col: string; op: string; val: any }>): boolean {
    return conds.every((c) => {
      if (c.op === 'in') return Array.isArray(c.val) && c.val.includes(row[c.col]);
      if (c.col === 'expires_at' && c.op === '<') {
        return new Date(row.expires_at) < new Date(c.val);
      }
      return row[c.col] === c.val;
    });
  }

  selectFrom() {
    const conds: Array<{ col: string; op: string; val: any }> = [];
    let sumCol: string | null = null;
    let countAlias: string | null = null;
    let groupCol: string | null = null;
    let idOnly = false;

    const chain: any = {
      selectAll: () => chain,
      select: (arg: any) => {
        if (typeof arg === 'string') {
          if (arg === 'id') idOnly = true;
        } else if (typeof arg === 'function') {
          const selected = arg({
            fn: {
              countAll: () => ({
                as: (alias: string) => ({ countAlias: alias }),
              }),
            },
          });
          if (selected?.countAlias) countAlias = selected.countAlias;
        } else if (arg && arg.sumColumn) {
          sumCol = arg.sumColumn;
        }
        return chain;
      },
      where: (col: string, op: string, val: any) => {
        conds.push({ col, op, val });
        return chain;
      },
      forUpdate: () => chain,
      groupBy: (col: string) => {
        groupCol = col;
        return chain;
      },
      executeTakeFirst: () => {
        const rows = this.getRows(conds, sumCol, countAlias, groupCol, idOnly);
        return Promise.resolve(rows[0] ?? undefined);
      },
      executeTakeFirstOrThrow: () => {
        const rows = this.getRows(conds, sumCol, countAlias, groupCol, idOnly);
        if (!rows[0]) throw new Error('not found');
        return Promise.resolve(rows[0]);
      },
      execute: () => {
        const rows = this.getRows(conds, sumCol, countAlias, groupCol, idOnly);
        return Promise.resolve(rows);
      },
    };
    return chain;
  }

  private getRows(
    conds: Array<{ col: string; op: string; val: any }>,
    sumCol: string | null,
    countAlias: string | null,
    groupCol: string | null,
    idOnly: boolean,
  ) {
    let rows = [...this.rows.values()];
    rows = rows.filter((r) => this.matches(r, conds));
    if (groupCol && sumCol) {
      const grouped = new Map<string, number>();
      for (const row of rows) {
        const key = row[groupCol];
        if (key === null || key === undefined) continue;
        grouped.set(key, (grouped.get(key) ?? 0) + Number(row[sumCol] ?? 0));
      }
      return [...grouped.entries()].map(([key, total]) => ({
        [groupCol]: key,
        total_held: total,
      }));
    }
    if (groupCol && countAlias) {
      const grouped = new Map<string, number>();
      for (const row of rows) {
        const key = row[groupCol];
        if (key === null || key === undefined) continue;
        grouped.set(key, (grouped.get(key) ?? 0) + 1);
      }
      return [...grouped.entries()].map(([key, total]) => ({
        [groupCol]: key,
        [countAlias]: total,
      }));
    }
    if (sumCol) {
      const total = rows.reduce((s, r) => s + Number(r[sumCol] ?? 0), 0);
      return [{ total_held: total }];
    }
    if (countAlias) return [{ [countAlias]: rows.length }];
    if (idOnly) return rows.map((r) => ({ id: r.id }));
    return rows;
  }

  updateTable() {
    const conds: Array<{ col: string; op: string; val: any }> = [];
    let setFn: ((eb: any) => Record<string, unknown>) | Record<string, unknown> = {};

    const chain: any = {
      set: (values: any) => {
        setFn = values;
        return chain;
      },
      where: (col: string, op: string, val: any) => {
        conds.push({ col, op, val });
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
      values: (v: Record<string, unknown>) => {
        vals = v;
        return chain;
      },
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
  const occurrences = new Map<string, Occurrence>();
  const tickets = new Map<string, Ticket>();

  const poolTable = new MockTable(pools);
  const holdTable = new MockTable(holds);
  const occurrenceTable = new MockTable(occurrences);
  const ticketTable = new MockTable(tickets);

  const tableFor = (table: string): MockTable => {
    if (table === 'inventory_pools') return poolTable;
    if (table === 'checkout_holds') return holdTable;
    if (table === 'event_occurrences') return occurrenceTable;
    if (table === 'tickets') return ticketTable;
    throw new Error(`unsupported mock table ${table}`);
  };

  const baseApi = {
    selectFrom: (table: string) => tableFor(table).selectFrom(),
    updateTable: (table: string) => tableFor(table).updateTable(),
    insertInto: (table: string) =>
      table === 'checkout_holds'
        ? holdTable.insertInto()
        : { values: () => ({ execute: () => Promise.resolve() }) },
    fn: {
      sum: (col: string) => ({ sumColumn: col, as: () => ({ sumColumn: col }) }),
    },
  };

  const db: any = {
    ...baseApi,
    transaction: () => ({
      execute: async (fn: (trx: any) => Promise<any>) => {
        const poolSnapshot = new Map([...pools.entries()].map(([id, row]) => [id, { ...row }]));
        const holdSnapshot = new Map([...holds.entries()].map(([id, row]) => [id, { ...row }]));
        const occurrenceSnapshot = new Map(
          [...occurrences.entries()].map(([id, row]) => [id, { ...row }]),
        );
        const ticketSnapshot = new Map([...tickets.entries()].map(([id, row]) => [id, { ...row }]));
        try {
          return await fn(baseApi);
        } catch (err) {
          pools.clear();
          for (const [id, row] of poolSnapshot) pools.set(id, row);
          holds.clear();
          for (const [id, row] of holdSnapshot) holds.set(id, row);
          occurrences.clear();
          for (const [id, row] of occurrenceSnapshot) occurrences.set(id, row);
          tickets.clear();
          for (const [id, row] of ticketSnapshot) tickets.set(id, row);
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
      event_occurrence_id: null,
      quantity: 1,
      expires_at: new Date(Date.now() + 300_000),
      status: 'active',
      created_at: new Date(),
      updated_at: new Date(),
      ...h,
    } as Hold);
  }

  function addOccurrence(o: Partial<Occurrence> & { id: string }) {
    occurrences.set(o.id, {
      capacity: null,
      ...o,
    } as Occurrence);
  }

  function addTicket(t: Partial<Ticket> & { id: string }) {
    tickets.set(t.id, {
      event_occurrence_id: null,
      status: 'valid',
      ...t,
    } as Ticket);
  }

  return {
    db,
    addPool,
    addHold,
    addOccurrence,
    addTicket,
    getPool: (id: string) => pools.get(id),
    getHold: (id: string) => holds.get(id),
    getOccurrence: (id: string) => occurrences.get(id),
    getTicket: (id: string) => tickets.get(id),
    pools,
    holds,
    occurrences,
    tickets,
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
      await expect(service.reserveCart({ items: [], checkoutSessionId: 'cs_1' })).rejects.toThrow(
        InventoryExhaustedError,
      );
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

    it('persists occurrence ids on hold rows', async () => {
      mock.addPool({ id: 'pool_1', total_capacity: 10, sold_count: 0 });
      mock.addOccurrence({ id: 'occ_1', capacity: 10 });

      const result = await service.reserveCart({
        items: [
          { inventoryPoolId: 'pool_1', ticketTypeId: 'tt_1', occurrenceId: 'occ_1', quantity: 2 },
        ],
        checkoutSessionId: 'cs_1',
      });

      expect(result.holds[0].occurrenceId).toBe('occ_1');
      const hold = mock.getHold(result.holds[0].holdId)!;
      expect(hold.event_occurrence_id).toBe('occ_1');
    });

    it('rejects reservations that exceed occurrence capacity while pool capacity remains', async () => {
      mock.addPool({ id: 'pool_1', total_capacity: 100, sold_count: 0 });
      mock.addOccurrence({ id: 'occ_1', capacity: 3 });
      mock.addTicket({ id: 'tkt_1', event_occurrence_id: 'occ_1', status: 'valid' });
      mock.addHold({
        id: 'hld_existing',
        inventory_pool_id: 'pool_1',
        event_occurrence_id: 'occ_1',
        quantity: 1,
        status: 'active',
      });

      await expect(
        service.reserveCart({
          items: [
            { inventoryPoolId: 'pool_1', ticketTypeId: 'tt_1', occurrenceId: 'occ_1', quantity: 2 },
          ],
          checkoutSessionId: 'cs_2',
        }),
      ).rejects.toThrow(InventoryExhaustedError);

      expect(mock.holds.size).toBe(1);
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

    it('throws when a session hold has already been marked expired', async () => {
      mock.addPool({ id: 'pool_1', total_capacity: 10, sold_count: 0 });
      mock.addHold({
        id: 'hld_1',
        inventory_pool_id: 'pool_1',
        checkout_session_id: 'cs_1',
        quantity: 2,
        status: 'expired',
      });

      await expect(service.convertHoldsForSession('cs_1')).rejects.toThrow(HoldExpiredError);

      expect(mock.getHold('hld_1')!.status).toBe('expired');
      expect(mock.getPool('pool_1')!.sold_count).toBe(0);
    });

    it('expires stale active session holds before throwing', async () => {
      mock.addPool({ id: 'pool_1', total_capacity: 10, sold_count: 0 });
      mock.addHold({
        id: 'hld_1',
        inventory_pool_id: 'pool_1',
        checkout_session_id: 'cs_1',
        quantity: 2,
        expires_at: new Date(Date.now() - 10_000),
        status: 'active',
      });

      await expect(service.convertHoldsForSession('cs_1')).rejects.toThrow(HoldExpiredError);

      expect(mock.getHold('hld_1')!.status).toBe('expired');
      expect(mock.getPool('pool_1')!.sold_count).toBe(0);
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
      mock.addPool({ id: 'pool_1', total_capacity: 10, sold_count: 0 });
      mock.addHold({ id: 'hld_1', inventory_pool_id: 'pool_1', status: 'expired' });

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

    it('batches availability across pools and expires stale holds once', async () => {
      mock.addPool({ id: 'pool_1', total_capacity: 10, sold_count: 1 });
      mock.addPool({ id: 'pool_2', total_capacity: 8, sold_count: 2 });
      mock.addHold({
        id: 'hld_1_active',
        inventory_pool_id: 'pool_1',
        quantity: 3,
        status: 'active',
      });
      mock.addHold({
        id: 'hld_1_stale',
        inventory_pool_id: 'pool_1',
        quantity: 4,
        status: 'active',
        expires_at: new Date(Date.now() - 10_000),
      });
      mock.addHold({
        id: 'hld_2_active',
        inventory_pool_id: 'pool_2',
        quantity: 2,
        status: 'active',
      });

      const availability = await service.getAvailabilityBatch(['pool_1', 'pool_2', 'pool_1']);

      expect(mock.getHold('hld_1_stale')!.status).toBe('expired');
      expect(availability.get('pool_1')).toEqual({ total: 10, sold: 1, reserved: 3, available: 6 });
      expect(availability.get('pool_2')).toEqual({ total: 8, sold: 2, reserved: 2, available: 4 });
    });

    it('returns zeros for non-existent pool', async () => {
      const avail = await service.getAvailability('nonexistent');
      expect(avail).toEqual({ total: 0, sold: 0, reserved: 0, available: 0 });
    });

    it('calculates occurrence availability from capacity, active holds, and usable tickets', async () => {
      mock.addOccurrence({ id: 'occ_1', capacity: 5 });
      mock.addOccurrence({ id: 'occ_unlimited', capacity: null });
      mock.addHold({
        id: 'hld_active',
        event_occurrence_id: 'occ_1',
        quantity: 2,
        status: 'active',
      });
      mock.addHold({
        id: 'hld_stale',
        event_occurrence_id: 'occ_1',
        quantity: 1,
        status: 'active',
        expires_at: new Date(Date.now() - 10_000),
      });
      mock.addTicket({ id: 'tkt_valid', event_occurrence_id: 'occ_1', status: 'valid' });
      mock.addTicket({ id: 'tkt_checked', event_occurrence_id: 'occ_1', status: 'checked_in' });
      mock.addTicket({
        id: 'tkt_transferred',
        event_occurrence_id: 'occ_1',
        status: 'transferred',
      });

      const availability = await service.getOccurrenceAvailabilityBatch(['occ_1', 'occ_unlimited']);

      expect(mock.getHold('hld_stale')!.status).toBe('expired');
      expect(availability.get('occ_1')).toEqual({
        total: 5,
        sold: 2,
        reserved: 2,
        available: 1,
      });
      expect(availability.get('occ_unlimited')).toEqual({
        total: null,
        sold: 0,
        reserved: 0,
        available: null,
      });
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
