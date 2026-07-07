import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockRow = Record<string, any>;

const dbState = {
  tables: {} as Record<string, MockRow[]>,
  emailJobs: [] as MockRow[],
  destroy: vi.fn(),
};

function baseTable(table: string): string {
  return table.split(/\s+as\s+/i)[0];
}

function getRows(table: string): MockRow[] {
  const base = baseTable(table);
  dbState.tables[base] ??= [];
  return dbState.tables[base];
}

function readColumn(row: MockRow, col: string): any {
  if (col in row) return row[col];
  const unqualified = col.includes('.') ? col.slice(col.lastIndexOf('.') + 1) : col;
  return row[unqualified];
}

function matches(row: MockRow, filters: Array<{ col: string; op: string; val: any }>): boolean {
  return filters.every((filter) => {
    const value = readColumn(row, filter.col);
    if (filter.op === '<') return new Date(value) < new Date(filter.val);
    if (filter.op === '<=') return new Date(value) <= new Date(filter.val);
    if (filter.op === '>') {
      if (value instanceof Date || filter.val instanceof Date) return new Date(value) > new Date(filter.val);
      return Number(value) > Number(filter.val);
    }
    if (filter.op === 'is') return filter.val === null ? value == null : value === filter.val;
    return value === filter.val;
  });
}

vi.mock('@tixkit/db', () => {
  function joinedWaitlistCandidates(filters: Array<{ col: string; op: string; val: any }>) {
    return getRows('waitlist_entries')
      .map((entry) => {
        const ticketType = getRows('ticket_types').find((row) => row.id === entry.ticket_type_id);
        const event = getRows('events').find((row) => row.id === entry.event_id);
        if (!ticketType || !event) return undefined;
        return {
          entry_id: entry.id,
          tenant_id: entry.tenant_id,
          brand_id: entry.brand_id,
          event_id: entry.event_id,
          ticket_type_id: entry.ticket_type_id,
          buyer_email: entry.buyer_email,
          buyer_first_name: entry.buyer_first_name,
          buyer_last_name: entry.buyer_last_name,
          quantity: entry.quantity,
          ticket_name: ticketType.name,
          inventory_pool_id: ticketType.inventory_pool_id,
          event_title: event.title,
          waitlist_auto_offer_enabled: event.waitlist_auto_offer_enabled,
          waitlist_offer_ttl_minutes: event.waitlist_offer_ttl_minutes,
          'entry.status': entry.status,
          'event.waitlist_auto_offer_enabled': event.waitlist_auto_offer_enabled,
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== undefined)
      .filter((row) => matches(row, filters));
  }

  function activeOfferQuantity(filters: Array<{ col: string; op: string; val: any }>) {
    const quantity = getRows('waitlist_entries')
      .filter((entry) => {
        const ticketType = getRows('ticket_types').find((row) => row.id === entry.ticket_type_id);
        if (!ticketType) return false;
        return matches(
          {
            ...entry,
            'active_ticket_type.inventory_pool_id': ticketType.inventory_pool_id,
            'active_entry.status': entry.status,
            'active_entry.offer_expires_at': entry.offer_expires_at,
          },
          filters,
        );
      })
      .reduce((sum, entry) => sum + Number(entry.quantity ?? 0), 0);
    return { quantity };
  }

  function defaultTemplateVersion(filters: Array<{ col: string; op: string; val: any }>) {
    const template = getRows('notification_templates').find((row) =>
      matches(
        {
          ...row,
          'template.tenant_id': row.tenant_id,
          'template.brand_id': row.brand_id,
          'template.key': row.key,
        },
        filters.filter((filter) => filter.col.startsWith('template.')),
      ),
    );
    if (!template) return undefined;
    const version = getRows('notification_template_versions').find((row) =>
      matches(
        {
          ...row,
          'version.is_default': row.is_default,
        },
        filters.filter((filter) => filter.col.startsWith('version.')),
      ) && row.template_id === template.id,
    );
    return version ? { id: version.id } : undefined;
  }

  const db = {
    selectFrom: (table: string) => {
      const filters: Array<{ col: string; op: string; val: any }> = [];
      const query = {
        innerJoin() {
          return query;
        },
        select() {
          return query;
        },
        where(col: string, op: string, val: any) {
          filters.push({ col, op, val });
          return query;
        },
        orderBy() {
          return query;
        },
        limit() {
          return query;
        },
        forUpdate() {
          return query;
        },
        async execute() {
          if (table === 'waitlist_entries as entry') return joinedWaitlistCandidates(filters);
          if (table === 'waitlist_entries as active_entry') return [activeOfferQuantity(filters)];
          if (baseTable(table) === 'checkout_holds') {
            const rows = getRows(table).filter((row) => matches(row, filters));
            if (rows.length === 0) return [{ quantity: 0 }];
            return [{ quantity: rows.reduce((sum, row) => sum + Number(row.quantity ?? 0), 0) }];
          }
          return getRows(table).filter((row) => matches(row, filters));
        },
        async executeTakeFirst() {
          if (table === 'notification_templates as template') return defaultTemplateVersion(filters);
          return getRows(table).find((row) => matches(row, filters)) ?? undefined;
        },
      };
      return query;
    },
    deleteFrom: (table: string) => {
      const filters: Array<{ col: string; op: string; val: any }> = [];
      const query = {
        where(col: string, op: string, val: any) {
          filters.push({ col, op, val });
          return query;
        },
        async execute() {
          const rows = getRows(table);
          const toDelete = new Set(rows.filter((row) => matches(row, filters)).map((r) => r));
          dbState.tables[table] = rows.filter((r) => !toDelete.has(r));
          return undefined;
        },
      };
      return query;
    },
    updateTable: (table: string) => {
      const filters: Array<{ col: string; op: string; val: any }> = [];
      let updates: MockRow = {};
      const query = {
        set(values: MockRow | ((eb: (col: string, _op: string, val: any) => any) => MockRow)) {
          updates = typeof values === 'function'
            ? values((col, op, val) => {
                if (op === '-') {
                  const currentRow = getRows(table).find((row) => matches(row, filters));
                  return (currentRow?.[col] ?? 0) - val;
                }
                return val;
              })
            : values;
          return query;
        },
        where(col: string, op: string, val: any) {
          filters.push({ col, op, val });
          return query;
        },
        async execute() {
          let updatedCount = 0;
          for (const row of getRows(table)) {
            if (!matches(row, filters)) continue;
            Object.assign(row, updates);
            updatedCount += 1;
          }
          return [{ numUpdatedRows: BigInt(updatedCount) }];
        },
        async executeTakeFirst() {
          const [result] = await query.execute();
          return result;
        },
      };
      return query;
    },
    transaction: () => ({
      execute: async (fn: (trx: typeof db) => Promise<unknown>) => fn(db),
    }),
    destroy: dbState.destroy,
  };

  return {
    createDb: () => db,
    EmailJobRepository: class {
      async create(input: MockRow) {
        dbState.emailJobs.push(input);
        return { id: `emj_${dbState.emailJobs.length}`, ...input };
      }
    },
  };
});

const { expireStaleSessionsActivity, processWaitlistOffersActivity } = await import(
  '../activities/hold-expiration.js'
);

describe('expireStaleSessionsActivity', () => {
  beforeEach(() => {
    dbState.tables = {};
    dbState.emailJobs = [];
    dbState.destroy.mockClear();
  });

  it('does not expire open checkout sessions that already have a payment intent', async () => {
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 60_000);
    dbState.tables.checkout_sessions = [
      { id: 'cs_payment_owned', status: 'open', expires_at: past, payment_intent_id: 'pi_1' },
      {
        id: 'cs_stale_open',
        tenant_id: 'tnt_1',
        status: 'open',
        expires_at: past,
        payment_intent_id: null,
        cart: JSON.stringify({ waitlistEntryId: 'wle_1' }),
      },
      { id: 'cs_fresh_open', status: 'open', expires_at: future, payment_intent_id: null },
    ];
    dbState.tables.waitlist_entries = [
      {
        id: 'wle_1',
        tenant_id: 'tnt_1',
        status: 'reserved',
        reserved_checkout_session_id: 'cs_stale_open',
        reserved_until: future,
      },
      {
        id: 'wle_other',
        tenant_id: 'tnt_1',
        status: 'reserved',
        reserved_checkout_session_id: 'cs_fresh_open',
        reserved_until: future,
      },
    ];

    const result = await expireStaleSessionsActivity();

    expect(result).toEqual({ ok: true, value: { expiredCount: 1 } });
    expect(dbState.tables.checkout_sessions[0].status).toBe('open');
    expect(dbState.tables.checkout_sessions[1].status).toBe('expired');
    expect(dbState.tables.checkout_sessions[2].status).toBe('open');
    expect(dbState.tables.waitlist_entries[0]).toMatchObject({
      status: 'offered',
      reserved_checkout_session_id: null,
      reserved_until: null,
    });
    expect(dbState.tables.waitlist_entries[1]).toMatchObject({
      status: 'reserved',
      reserved_checkout_session_id: 'cs_fresh_open',
    });
    expect(dbState.destroy).toHaveBeenCalledTimes(1);
  });
});

describe('processWaitlistOffersActivity', () => {
  beforeEach(() => {
    dbState.tables = {};
    dbState.emailJobs = [];
    dbState.destroy.mockClear();
    vi.restoreAllMocks();
  });

  function seedOfferableWaitlistEntry() {
    dbState.tables.waitlist_entries = [
      {
        id: 'wle_1',
        tenant_id: 'tnt_1',
        brand_id: 'brd_1',
        event_id: 'evt_1',
        ticket_type_id: 'tt_1',
        buyer_email: 'buyer@example.test',
        buyer_first_name: 'Ada',
        buyer_last_name: 'Lovelace',
        quantity: 2,
        status: 'joined',
        created_at: new Date(Date.now() - 60_000),
      },
    ];
    dbState.tables.ticket_types = [
      { id: 'tt_1', name: 'General Admission', inventory_pool_id: 'inv_1' },
    ];
    dbState.tables.events = [
      {
        id: 'evt_1',
        title: 'Launch Night',
        waitlist_auto_offer_enabled: true,
        waitlist_offer_ttl_minutes: 30,
      },
    ];
    dbState.tables.inventory_pools = [{ id: 'inv_1', total_capacity: 10, sold_count: 1 }];
    dbState.tables.checkout_holds = [];
    dbState.tables.email_provider_routes = [
      {
        id: 'epr_1',
        tenant_id: 'tnt_1',
        brand_id: 'brd_1',
        status: 'active',
        smoke_send_verified: true,
        priority: 1,
      },
    ];
    dbState.tables.email_jobs = [];
  }

  it('queues waitlist invite emails with the registered template key', async () => {
    seedOfferableWaitlistEntry();
    dbState.tables.notification_templates = [
      { id: 'ntpl_1', tenant_id: 'tnt_1', brand_id: 'brd_1', key: 'waitlist-invite' },
    ];
    dbState.tables.notification_template_versions = [
      { id: 'ntv_1', template_id: 'ntpl_1', is_default: true },
    ];

    const result = await processWaitlistOffersActivity();

    expect(result).toEqual({
      ok: true,
      value: { expiredCount: 0, offeredCount: 1, queuedEmailCount: 1 },
    });
    expect(dbState.emailJobs).toHaveLength(1);
    expect(dbState.emailJobs[0]).toMatchObject({
      tenantId: 'tnt_1',
      brandId: 'brd_1',
      templateKey: 'waitlist-invite',
      templateVersionId: 'ntv_1',
      toEmail: 'buyer@example.test',
      toName: 'Ada Lovelace',
      providerRouteId: 'epr_1',
      priority: 'high',
      idempotencyKey: 'waitlist-invite:wle_1',
    });
    expect(dbState.emailJobs[0].variables).toMatchObject({
      eventId: 'evt_1',
      eventTitle: 'Launch Night',
      ticketTypeId: 'tt_1',
      ticketName: 'General Admission',
      quantity: 2,
      notificationType: 'transactional',
    });
    expect(String(dbState.emailJobs[0].variables.claimUrl)).toContain('claimToken=');
    expect(dbState.tables.waitlist_entries[0].status).toBe('offered');
  });

  it('warns when an offered waitlist entry cannot resolve a template', async () => {
    seedOfferableWaitlistEntry();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await processWaitlistOffersActivity();

    expect(result).toEqual({
      ok: true,
      value: { expiredCount: 0, offeredCount: 1, queuedEmailCount: 0 },
    });
    expect(dbState.emailJobs).toEqual([]);
    expect(warn).toHaveBeenCalledWith('WAITLIST_OFFER_EMAIL_SKIPPED', {
      tenantId: 'tnt_1',
      brandId: 'brd_1',
      waitlistEntryId: 'wle_1',
      templateKey: 'waitlist-invite',
      missingRoute: false,
      missingTemplateVersion: true,
    });
  });
});
