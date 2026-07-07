import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '@tixkit/domain';
import type { Database } from '@tixkit/db';
import type { AppContext } from '../app.js';
import {
  buildOfflineManifest,
  checkInRoutes,
  MAX_OFFLINE_MANIFEST_TICKETS,
  processPendingBulkSyncChunks,
  processPendingBulkSyncJobs,
  processScan,
  verifyOfflineManifestSignature,
} from '../routes/modules/checkin.js';
import {
  MAX_BULK_OFFLINE_SYNC_CHUNK_SCANS,
  MAX_BULK_OFFLINE_SYNC_TOTAL_SCANS,
  MAX_OFFLINE_SYNC_SCANS,
  OFFLINE_SYNC_JSON_BODY_LIMIT_BYTES,
} from '../http/schemas.js';

const list = {
  id: 'cil_1',
  event_id: 'evt_1',
  ticket_type_ids: JSON.stringify(['tt_allowed']),
};

function ticket(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tkt_1',
    tenant_id: 'tnt_1',
    event_id: 'evt_1',
    ticket_type_id: 'tt_allowed',
    qr_hash: 'hash_1',
    status: 'valid',
    ...overrides,
  };
}

function repo(row: Record<string, unknown> | null, checkInResult = true) {
  return {
    findById: vi.fn(async () => row),
    findByQrHash: vi.fn(async () => row),
    checkInIfValid: vi.fn(async () => checkInResult),
  };
}

async function createBulkJob(
  app: FastifyInstance,
  payloadOverrides: Partial<{
    checkInListId: string;
    totalChunks: number;
    totalScans: number;
  }> = {},
) {
  const response = await app.inject({
    method: 'POST',
    url: '/check-ins/bulk-sync-jobs',
    headers: { 'Idempotency-Key': 'idem_bulk_job_1' },
    payload: {
      checkInListId: 'cil_1',
      totalChunks: 2,
      ...payloadOverrides,
    },
  });
  expect(response.statusCode).toBe(202);
  return response.json() as { id: string };
}

async function flushBulkSyncScheduler() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

type OfflineSyncMockOverrides = {
  list?: Record<string, unknown> | null;
  event?: Record<string, unknown> | null;
  ticket?: Record<string, unknown> | Record<string, unknown>[] | null;
  checkInSucceeds?: boolean;
  existingIdempotency?: Record<string, unknown> | null;
  failScanLogInsert?: boolean;
  onBulkSyncJobClaimed?: (job: Record<string, unknown>) => Promise<void> | void;
  onUnclaimedBulkSyncJob?: () => Promise<void> | void;
};

type MockCondition =
  | { column: string; op: string; value: unknown }
  | ((row: Record<string, unknown>) => boolean);

function matchesMockCondition(row: Record<string, unknown>, condition: MockCondition) {
  if (typeof condition === 'function') return condition(row);
  const { column, op, value } = condition;
  if (typeof column !== 'string') return true;
  const key = column.includes('.') ? column.split('.').at(-1)! : column;
  if (op === '=') return row[key] === value;
  if (op === '<>') return row[key] !== value;
  if (op === '<') return Number(row[key] ?? 0) < Number(value);
  if (op === 'in') return Array.isArray(value) && value.includes(row[key]);
  if (op === 'ref>=') return Number(row[key] ?? 0) >= Number(row[value as string] ?? 0);
  if (op === 'is') return value === null ? row[key] === null || row[key] === undefined : true;
  if (op === '<=') {
    const left =
      row[key] instanceof Date ? row[key].getTime() : new Date(row[key] as string).getTime();
    const right = value instanceof Date ? value.getTime() : new Date(value as string).getTime();
    return Number.isFinite(left) && Number.isFinite(right) ? left <= right : true;
  }
  return true;
}

function buildOfflineSyncMockDb(overrides: OfflineSyncMockOverrides = {}) {
  const inserts: Array<{ table: string; values: Record<string, unknown> }> = [];
  const updates: Array<{ table: string; values: Record<string, unknown> }> = [];
  let unclaimedBulkSyncJobCallbackInvoked = false;
  const checkInList =
    overrides.list !== undefined
      ? overrides.list
      : {
          id: 'cil_1',
          event_id: 'evt_1',
          ticket_type_ids: JSON.stringify(['tt_allowed']),
          status: 'active',
        };
  const event = overrides.event ?? {
    id: 'evt_1',
    tenant_id: 'tnt_1',
    brand_id: 'brd_1',
    organization_id: 'org_1',
  };
  const ticketRow =
    overrides.ticket !== undefined
      ? overrides.ticket
      : {
          id: 'tkt_1',
          tenant_id: 'tnt_1',
          attendee_id: 'att_1',
          event_id: 'evt_1',
          ticket_type_id: 'tt_allowed',
          qr_hash: 'hash_1',
          status: 'valid',
        };
  const ticketRows = ticketRow === null ? [] : Array.isArray(ticketRow) ? ticketRow : [ticketRow];
  const expressionBuilder = Object.assign(
    (column: string, op: string, value: unknown) => (row: Record<string, unknown>) =>
      matchesMockCondition(row, { column, op, value }),
    {
      or:
        (predicates: Array<(row: Record<string, unknown>) => boolean>) =>
        (row: Record<string, unknown>) =>
          predicates.some((predicate) => predicate(row)),
      and:
        (predicates: Array<(row: Record<string, unknown>) => boolean>) =>
        (row: Record<string, unknown>) =>
          predicates.every((predicate) => predicate(row)),
    },
  );

  // Table-aware query builder: returns the right mock data per table.
  function makeQuery(table: string) {
    const conditions: MockCondition[] = [];
    let limitValue: number | undefined;
    const matchesConditions = (row: Record<string, unknown>) =>
      conditions.every((condition) => matchesMockCondition(row, condition));
    const tableRows = () => {
      if (table === 'check_in_lists') return checkInList ? [checkInList] : [];
      if (table === 'events') return event ? [event] : [];
      if (table === 'tickets') return ticketRows;
      if (table === 'idempotency_records') {
        return overrides.existingIdempotency ? [overrides.existingIdempotency] : [];
      }
      return inserts.filter((insert) => insert.table === table).map((insert) => insert.values);
    };
    const q = {
      innerJoin() {
        return q;
      },
      select() {
        return q;
      },
      selectAll() {
        return q;
      },
      where(
        column:
          | string
          | ((eb: typeof expressionBuilder) => (row: Record<string, unknown>) => boolean),
        op?: string,
        value?: unknown,
      ) {
        conditions.push(
          typeof column === 'function'
            ? column(expressionBuilder)
            : { column, op: op ?? '=', value },
        );
        return q;
      },
      whereRef(left: string, op: string, right: string) {
        conditions.push({ column: left, op: op === '>=' ? 'ref>=' : op, value: right });
        return q;
      },
      orderBy() {
        return q;
      },
      limit(value: number) {
        limitValue = value;
        return q;
      },
      forUpdate() {
        return q;
      },
      async executeTakeFirst() {
        return tableRows().find((row) => matchesConditions(row)) ?? null;
      },
      async executeTakeFirstOrThrow() {
        const result = await q.executeTakeFirst();
        if (result === null || result === undefined) throw new Error(`No row for ${table}`);
        return result;
      },
      async execute() {
        const rows = tableRows().filter((row) => matchesConditions(row));
        return limitValue === undefined ? rows : rows.slice(0, limitValue);
      },
    };
    return q;
  }

  const applyMockUpdate = (
    table: string,
    conditions: MockCondition[],
    values: Record<string, unknown>,
  ) => {
    const matchesConditions = (row: Record<string, unknown>) =>
      conditions.every((condition) => matchesMockCondition(row, condition));
    const rows = inserts
      .filter((insert) => insert.table === table)
      .map((insert) => insert.values)
      .filter((row) => matchesConditions(row));
    for (const row of rows) {
      for (const [key, value] of Object.entries(values)) {
        const increment = value as { __increment?: number; column?: string };
        const incrementValue = increment?.['__increment'];
        if (increment && typeof increment === 'object' && incrementValue !== undefined) {
          row[key] = Number(row[key] ?? 0) + incrementValue;
        } else {
          row[key] = value;
        }
      }
    }
    return rows.length;
  };

  const db = {
    selectFrom: vi.fn((table: string) => makeQuery(table)),
    insertInto: vi.fn((table: string) => ({
      values: (values: Record<string, unknown> | Record<string, unknown>[]) => {
        const persistedValues = (Array.isArray(values) ? values : [values]).map((value) => {
          if (table !== 'scan_logs' || value.metadata == null) return value;
          return Object.assign({}, value, {
            metadata:
              typeof value.metadata === 'string' ? value.metadata : JSON.stringify(value.metadata),
          });
        });
        const firstPersistedValue = persistedValues[0] ?? {};
        return {
          returningAll: () => ({
            executeTakeFirstOrThrow: vi.fn(async () => {
              for (const value of persistedValues) inserts.push({ table, values: value });
              return { id: 'slog_1', ...firstPersistedValue };
            }),
          }),
          execute: vi.fn(async () => {
            if (table === 'scan_logs' && overrides.failScanLogInsert) {
              throw new Error('scan log insert failed');
            }
            for (const value of persistedValues) inserts.push({ table, values: value });
            return [];
          }),
        };
      },
    })),
    updateTable: vi.fn((table: string) => {
      const conditions: MockCondition[] = [];
      let pendingValues: Record<string, unknown> = {};
      const updateChain = {
        set: (
          values:
            | Record<string, unknown>
            | ((
                eb: (column: string, op: string, amount: number) => unknown,
              ) => Record<string, unknown>),
        ) => {
          const resolvedValues =
            typeof values === 'function'
              ? values((column: string, op: string, amount: number) =>
                  op === '+' ? { __increment: amount, column } : { __op: op, amount, column },
                )
              : values;
          pendingValues = resolvedValues;
          updates.push({ table, values: resolvedValues });
          return updateChain;
        },
        where: (
          column:
            | string
            | ((eb: typeof expressionBuilder) => (row: Record<string, unknown>) => boolean),
          op?: string,
          value?: unknown,
        ) => {
          conditions.push(
            typeof column === 'function'
              ? column(expressionBuilder)
              : { column, op: op ?? '=', value },
          );
          return updateChain;
        },
        whereRef: (left: string, op: string, right: string) => {
          conditions.push({ column: left, op: op === '>=' ? 'ref>=' : op, value: right });
          return updateChain;
        },
        async executeTakeFirst() {
          if (table === 'offline_check_in_sync_jobs' || table === 'offline_check_in_sync_chunks') {
            return { numUpdatedRows: BigInt(applyMockUpdate(table, conditions, pendingValues)) };
          }
          return { numUpdatedRows: 1n };
        },
        returning: () => ({
          execute: vi.fn(async () => {
            if (overrides.checkInSucceeds === false) return [];
            if (table !== 'tickets') return ticketRows.map((row) => ({ id: row.id as string }));
            const acceptedRows = ticketRows.filter((row) => row.status === 'valid');
            for (const row of acceptedRows) row.status = 'checked_in';
            return acceptedRows.map((row) => ({ id: row.id as string }));
          }),
        }),
        returningAll: () => ({
          executeTakeFirst: vi.fn(async () => {
            const matched = inserts
              .filter((insert) => insert.table === table)
              .map((insert) => insert.values)
              .find((row) => conditions.every((condition) => matchesMockCondition(row, condition)));
            if (!matched) {
              if (
                table === 'offline_check_in_sync_jobs' &&
                pendingValues.status === 'processing' &&
                !unclaimedBulkSyncJobCallbackInvoked
              ) {
                unclaimedBulkSyncJobCallbackInvoked = true;
                await overrides.onUnclaimedBulkSyncJob?.();
              }
              return null;
            }
            applyMockUpdate(table, conditions, pendingValues);
            if (table === 'offline_check_in_sync_jobs' && pendingValues.status === 'processing') {
              await overrides.onBulkSyncJobClaimed?.(matched);
            }
            return matched;
          }),
        }),
        async execute() {
          if (table === 'offline_check_in_sync_jobs' || table === 'offline_check_in_sync_chunks') {
            applyMockUpdate(table, conditions, pendingValues);
          }
          return [];
        },
      };
      return updateChain;
    }),
    deleteFrom: vi.fn(() => ({
      where: () => ({
        execute: vi.fn(async () => []),
      }),
    })),
    transaction: vi.fn(() => ({
      execute: async (cb: (trx: unknown) => Promise<unknown>) => {
        const insertCount = inserts.length;
        const updateCount = updates.length;
        try {
          return await cb(db);
        } catch (error) {
          inserts.length = insertCount;
          updates.length = updateCount;
          throw error;
        }
      },
    })),
    destroy: vi.fn(async () => {}),
  };

  return { db, inserts, updates };
}

describe('processScan', () => {
  it('rejects online scans with invalid QR signatures before looking up tickets', async () => {
    const ticketRepo = repo(ticket());
    const result = await processScan({
      ticketRepo: ticketRepo as never,
      tenantId: 'tnt_1',
      list: list as never,
      qrHash: 'hash_1',
      deviceId: 'sd_1',
      scannedAt: new Date('2026-06-01T00:00:00Z'),
      verification: { valid: false },
      requireVerifiedTicketId: true,
    });

    expect(result).toEqual({
      outcome: 'invalid',
      qrHash: 'hash_1',
      metadata: { reason: 'signature_invalid' },
    });
    expect(ticketRepo.findById).not.toHaveBeenCalled();
  });

  it('rejects tickets for another event', async () => {
    const result = await processScan({
      ticketRepo: repo(ticket({ event_id: 'evt_other' })) as never,
      tenantId: 'tnt_1',
      list: list as never,
      qrHash: 'hash_1',
      deviceId: 'sd_1',
      scannedAt: new Date('2026-06-01T00:00:00Z'),
      verification: { valid: true, ticketId: 'tkt_1' },
      requireVerifiedTicketId: true,
    });

    expect(result.outcome).toBe('wrong_event');
    expect(result.ticketId).toBe('tkt_1');
  });

  it('does not expose ticket ids from another tenant during online scans', async () => {
    const ticketRepo = repo(ticket({ tenant_id: 'tnt_other' }));
    const result = await processScan({
      ticketRepo: ticketRepo as never,
      tenantId: 'tnt_1',
      list: list as never,
      qrHash: 'hash_1',
      deviceId: 'sd_1',
      scannedAt: new Date('2026-06-01T00:00:00Z'),
      verification: { valid: true, ticketId: 'tkt_1' },
      requireVerifiedTicketId: true,
    });

    expect(result).toEqual({ outcome: 'not_found', qrHash: 'hash_1' });
    expect(ticketRepo.checkInIfValid).not.toHaveBeenCalled();
  });

  it('rejects tickets whose type is not on the check-in list', async () => {
    const result = await processScan({
      ticketRepo: repo(ticket({ ticket_type_id: 'tt_other' })) as never,
      tenantId: 'tnt_1',
      list: list as never,
      qrHash: 'hash_1',
      deviceId: 'sd_1',
      scannedAt: new Date('2026-06-01T00:00:00Z'),
      verification: { valid: true, ticketId: 'tkt_1' },
      requireVerifiedTicketId: true,
    });

    expect(result.outcome).toBe('wrong_list');
  });

  it('rejects same-event tickets from another occurrence on occurrence-scoped lists', async () => {
    const ticketRepo = repo(ticket({ event_occurrence_id: 'occ_other' }));
    const result = await processScan({
      ticketRepo: ticketRepo as never,
      tenantId: 'tnt_1',
      list: { ...list, event_occurrence_id: 'occ_allowed' } as never,
      qrHash: 'hash_1',
      deviceId: 'sd_1',
      scannedAt: new Date('2026-06-01T00:00:00Z'),
      verification: { valid: true, ticketId: 'tkt_1' },
      requireVerifiedTicketId: true,
    });

    expect(result).toEqual({
      outcome: 'wrong_list',
      ticketId: 'tkt_1',
      qrHash: 'hash_1',
      metadata: {
        reason: 'wrong_event_occurrence',
        expectedEventOccurrenceId: 'occ_allowed',
        actualEventOccurrenceId: 'occ_other',
      },
    });
    expect(ticketRepo.checkInIfValid).not.toHaveBeenCalled();
  });

  it('accepts valid tickets only when the atomic check-in wins', async () => {
    const ticketRepo = repo(ticket(), true);
    const result = await processScan({
      ticketRepo: ticketRepo as never,
      tenantId: 'tnt_1',
      list: list as never,
      qrHash: 'hash_1',
      deviceId: 'sd_1',
      scannedAt: new Date('2026-06-01T00:00:00Z'),
      verification: { valid: true, ticketId: 'tkt_1' },
      requireVerifiedTicketId: true,
    });

    expect(result.outcome).toBe('accepted');
    expect(ticketRepo.checkInIfValid).toHaveBeenCalledWith(
      'tkt_1',
      'sd_1',
      new Date('2026-06-01T00:00:00Z'),
    );
  });

  it('returns duplicate when another scan already claimed the ticket', async () => {
    const result = await processScan({
      ticketRepo: repo(ticket(), false) as never,
      tenantId: 'tnt_1',
      list: list as never,
      qrHash: 'hash_1',
      deviceId: 'sd_1',
      scannedAt: new Date('2026-06-01T00:00:00Z'),
      verification: { valid: true, ticketId: 'tkt_1' },
      requireVerifiedTicketId: true,
    });

    expect(result.outcome).toBe('duplicate');
  });
});

describe('check-in routes', () => {
  it('requires an Idempotency-Key for offline sync replay safety', async () => {
    const principal: Principal = {
      type: 'mobile_device',
      id: 'sd_1',
      tenantId: 'tnt_1',
      organizationIds: ['org_1'],
      scopes: ['checkins.write'],
      eventIds: ['evt_1'],
    };
    const app = Fastify({ bodyLimit: OFFLINE_SYNC_JSON_BODY_LIMIT_BYTES });
    app.decorate('context', {
      db: {} as Database,
      pricingEngine: {},
      inventoryService: {},
      qrService: {},
      authService: {},
      temporalClient: {},
    } as unknown as AppContext);
    app.addHook('onRequest', async (request) => {
      request.principal = principal;
    });
    await app.register(checkInRoutes);

    const response = await app.inject({
      method: 'POST',
      url: '/check-ins/sync',
      payload: {
        checkInListId: 'cil_1',
        scans: [{ qrHash: 'hash_1', scannedAt: '2026-06-01T12:00:00.000Z', offline: true }],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Idempotency-Key header is required for offline scan sync',
    });

    await app.close();
  });
});

describe('buildOfflineManifest', () => {
  it('serializes persisted ticket rows for offline scanner use with HMAC signature and no plaintext email', () => {
    const manifest = buildOfflineManifest({
      eventId: 'evt_1',
      checkInListId: 'cil_1',
      generatedAt: new Date('2026-06-01T00:00:00.000Z'),
      ttlMs: 60_000,
      rows: [
        {
          ticket_id: 'tkt_1',
          ticket_type_id: 'tt_allowed',
          event_occurrence_id: null,
          qr_hash: 'hash_1',
          status: 'valid',
          first_name: 'Ada',
          last_name: 'Lovelace',
          email: 'ada@example.com',
        },
        {
          ticket_id: 'tkt_2',
          ticket_type_id: 'tt_allowed',
          event_occurrence_id: null,
          qr_hash: 'hash_2',
          status: 'transferred',
          first_name: null,
          last_name: null,
          email: 'buyer@example.com',
        },
      ],
    });

    expect(manifest.eventId).toBe('evt_1');
    expect(manifest.checkInListId).toBe('cil_1');
    expect(manifest.generatedAt).toBe('2026-06-01T00:00:00.000Z');
    expect(manifest.expiresAt).toBe('2026-06-01T00:01:00.000Z');
    expect(manifest.keyId).toBeDefined();
    expect(manifest.signature).toBeDefined();
    expect(typeof manifest.signature).toBe('string');
    expect(manifest.signature.length).toBe(64);
    expect(manifest.tickets).toHaveLength(2);
    // attendeeName should not contain email as fallback
    expect(manifest.tickets[0].attendeeName).toBe('Ada Lovelace');
    expect(manifest.tickets[1].attendeeName).toBe(''); // No name, no email fallback
  });

  it('produces a verifiable HMAC signature', () => {
    const manifest = buildOfflineManifest({
      eventId: 'evt_1',
      checkInListId: 'cil_1',
      rows: [],
    });
    expect(verifyOfflineManifestSignature(manifest)).toBe(true);
  });

  it('matches the cross-SDK offline manifest contract fixture', () => {
    const originalManifestKey = process.env.OFFLINE_MANIFEST_SIGNING_KEY;
    const originalKeyId = process.env.OFFLINE_MANIFEST_KEY_ID;
    process.env.OFFLINE_MANIFEST_SIGNING_KEY = 'manifest-secret';
    process.env.OFFLINE_MANIFEST_KEY_ID = 'manifest:test';

    try {
      const manifest = buildOfflineManifest({
        eventId: 'evt_1',
        checkInListId: 'cil_1',
        generatedAt: new Date('2026-06-01T00:00:00.000Z'),
        ttlMs: 60_000,
        rows: [
          {
            ticket_id: 'tkt_b',
            ticket_type_id: 'tt_vip',
            event_occurrence_id: 'occ_1',
            qr_hash: 'hash_b',
            status: 'valid',
            first_name: 'Grace',
            last_name: 'Hopper',
            email: 'grace@example.com',
          },
          {
            ticket_id: 'tkt_a',
            ticket_type_id: 'tt_ga',
            event_occurrence_id: null,
            qr_hash: 'hash_a',
            status: 'issued',
            first_name: null,
            last_name: null,
            email: 'buyer@example.com',
          },
        ],
      });

      expect(manifest).toMatchObject({
        eventId: 'evt_1',
        checkInListId: 'cil_1',
        generatedAt: '2026-06-01T00:00:00.000Z',
        expiresAt: '2026-06-01T00:01:00.000Z',
        keyId: 'manifest:test',
        signature: 'd8fdb5795ec9219c5cb880dd2bee328cb6298e976098008cfe730e7a2b71be48',
        tickets: [
          {
            ticketId: 'tkt_b',
            ticketTypeId: 'tt_vip',
            eventOccurrenceId: 'occ_1',
            attendeeName: 'Grace Hopper',
            qrHash: 'hash_b',
            status: 'valid',
          },
          {
            ticketId: 'tkt_a',
            ticketTypeId: 'tt_ga',
            attendeeName: '',
            qrHash: 'hash_a',
            status: 'issued',
          },
        ],
      });
      expect(verifyOfflineManifestSignature(manifest)).toBe(true);
    } finally {
      if (originalManifestKey === undefined) {
        delete process.env.OFFLINE_MANIFEST_SIGNING_KEY;
      } else {
        process.env.OFFLINE_MANIFEST_SIGNING_KEY = originalManifestKey;
      }
      if (originalKeyId === undefined) {
        delete process.env.OFFLINE_MANIFEST_KEY_ID;
      } else {
        process.env.OFFLINE_MANIFEST_KEY_ID = originalKeyId;
      }
    }
  });

  it('rejects a tampered manifest signature', () => {
    const manifest = buildOfflineManifest({
      eventId: 'evt_1',
      checkInListId: 'cil_1',
      rows: [],
    });
    const tampered = { ...manifest, eventId: 'evt_tampered' };
    expect(verifyOfflineManifestSignature(tampered)).toBe(false);
  });

  it('rejects malformed manifest signatures', () => {
    const manifest = buildOfflineManifest({
      eventId: 'evt_1',
      checkInListId: 'cil_1',
      rows: [],
    });

    for (const signature of ['not-hex', 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64)]) {
      expect(verifyOfflineManifestSignature({ ...manifest, signature })).toBe(false);
    }
  });

  it('requires an explicit manifest signing secret in production', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalManifestKey = process.env.OFFLINE_MANIFEST_SIGNING_KEY;
    const originalQrSigningSecret = process.env.QR_SIGNING_SECRET;
    process.env.NODE_ENV = 'production';
    delete process.env.OFFLINE_MANIFEST_SIGNING_KEY;
    delete process.env.QR_SIGNING_SECRET;

    try {
      expect(() =>
        buildOfflineManifest({
          eventId: 'evt_1',
          checkInListId: 'cil_1',
          rows: [],
        }),
      ).toThrow('OFFLINE_MANIFEST_SIGNING_KEY or QR_SIGNING_SECRET is required in production');
    } finally {
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
      if (originalManifestKey === undefined) {
        delete process.env.OFFLINE_MANIFEST_SIGNING_KEY;
      } else {
        process.env.OFFLINE_MANIFEST_SIGNING_KEY = originalManifestKey;
      }
      if (originalQrSigningSecret === undefined) {
        delete process.env.QR_SIGNING_SECRET;
      } else {
        process.env.QR_SIGNING_SECRET = originalQrSigningSecret;
      }
    }
  });
});

describe('offline manifest endpoint', () => {
  it('rejects single-download manifests above the ticket cap before signing', async () => {
    const principal: Principal = {
      type: 'user',
      id: 'usr_1',
      tenantId: 'tnt_1',
      organizationIds: ['org_1'],
      scopes: ['checkins.read'],
    };
    const tickets = Array.from({ length: MAX_OFFLINE_MANIFEST_TICKETS + 1 }, (_, index) => ({
      id: `tkt_${index}`,
      ticket_id: `tkt_${index}`,
      tenant_id: 'tnt_1',
      attendee_id: `att_${index}`,
      event_id: 'evt_1',
      ticket_type_id: 'tt_allowed',
      event_occurrence_id: null,
      qr_hash: `hash_${index}`,
      status: 'valid',
      first_name: 'Scan',
      last_name: String(index),
      email: `scan-${index}@example.com`,
    }));
    const { db } = buildOfflineSyncMockDb({ ticket: tickets });
    const app = Fastify();
    app.decorate('context', {
      db,
      pricingEngine: {},
      inventoryService: {},
      qrService: {},
      authService: {},
      temporalClient: {},
    } as unknown as AppContext);
    app.addHook('onRequest', async (request) => {
      request.principal = principal;
    });
    await app.register(checkInRoutes);

    const response = await app.inject({
      method: 'GET',
      url: '/events/evt_1/check-in-lists/cil_1/manifest',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: `Offline manifest exceeds maximum ticket count of ${MAX_OFFLINE_MANIFEST_TICKETS}`,
    });

    await app.close();
  });
});

describe('offline sync endpoint', () => {
  it('rejects oversized sync batches before repository work', async () => {
    const principal: Principal = {
      type: 'mobile_device',
      id: 'sd_public',
      tenantId: 'tnt_1',
      organizationIds: ['org_1'],
      scopes: ['checkins.write'],
      eventIds: ['evt_1'],
    };
    const db = { selectFrom: vi.fn() } as unknown as Database;
    const app = Fastify();
    app.decorate('context', {
      db,
      pricingEngine: {},
      inventoryService: {},
      qrService: {},
      authService: {},
      temporalClient: {},
    } as unknown as AppContext);
    app.addHook('onRequest', async (request) => {
      request.principal = principal;
    });
    await app.register(checkInRoutes);

    const response = await app.inject({
      method: 'POST',
      url: '/check-ins/sync',
      headers: { 'Idempotency-Key': 'idem_sync_oversized' },
      payload: {
        checkInListId: 'cil_1',
        deviceId: 'sd_public',
        scans: Array.from({ length: MAX_OFFLINE_SYNC_SCANS + 1 }, (_, index) => ({
          qrHash: `hash_${index}`,
          scannedAt: '2026-06-01T12:00:00.000Z',
          offline: true,
        })),
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(db.selectFrom).not.toHaveBeenCalled();

    await app.close();
  });

  it('processes offline scans and returns accepted/duplicate/invalid counts', async () => {
    const principal: Principal = {
      type: 'mobile_device',
      id: 'sd_public',
      tenantId: 'tnt_1',
      organizationIds: ['org_1'],
      scopes: ['checkins.write'],
      eventIds: ['evt_1'],
    };
    const { db, inserts, updates } = buildOfflineSyncMockDb();
    const app = Fastify();
    app.decorate('context', {
      db,
      pricingEngine: {},
      inventoryService: {},
      qrService: {},
      authService: {},
      temporalClient: {},
    } as unknown as AppContext);
    app.addHook('onRequest', async (request) => {
      request.principal = principal;
    });
    await app.register(checkInRoutes);

    const response = await app.inject({
      method: 'POST',
      url: '/check-ins/sync',
      headers: { 'Idempotency-Key': 'idem_sync_1' },
      payload: {
        checkInListId: 'cil_1',
        deviceId: 'sd_public',
        scans: [{ qrHash: 'hash_1', scannedAt: '2026-06-01T12:00:00.000Z', offline: true }],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.accepted).toBe(1);
    expect(body.duplicates).toBe(0);
    expect(body.invalid).toBe(0);
    expect(body.results).toHaveLength(1);
    expect(body.results[0].qrHash).toBe('hash_1');
    expect(body.results[0].outcome).toBe('accepted');
    expect(updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: 'tickets',
          values: expect.objectContaining({ checked_in_by_device_id: 'sd_public' }),
        }),
        expect.objectContaining({
          table: 'attendees',
          values: expect.objectContaining({ check_in_device_id: 'sd_public' }),
        }),
      ]),
    );
    expect(inserts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: 'scan_logs',
          values: expect.objectContaining({ device_id: 'sd_public' }),
        }),
      ]),
    );

    await app.close();
  });

  it('persists each accepted offline scan with its own scannedAt timestamp', async () => {
    const principal: Principal = {
      type: 'mobile_device',
      id: 'sd_public',
      tenantId: 'tnt_1',
      organizationIds: ['org_1'],
      scopes: ['checkins.write'],
      eventIds: ['evt_1'],
    };
    const { db, inserts } = buildOfflineSyncMockDb({
      ticket: [
        {
          id: 'tkt_early',
          tenant_id: 'tnt_1',
          attendee_id: 'att_early',
          event_id: 'evt_1',
          ticket_type_id: 'tt_allowed',
          qr_hash: 'hash_early',
          status: 'valid',
        },
        {
          id: 'tkt_late',
          tenant_id: 'tnt_1',
          attendee_id: 'att_late',
          event_id: 'evt_1',
          ticket_type_id: 'tt_allowed',
          qr_hash: 'hash_late',
          status: 'valid',
        },
      ],
    });
    const app = Fastify();
    app.decorate('context', {
      db,
      pricingEngine: {},
      inventoryService: {},
      qrService: {},
      authService: {},
      temporalClient: {},
    } as unknown as AppContext);
    app.addHook('onRequest', async (request) => {
      request.principal = principal;
    });
    await app.register(checkInRoutes);

    const earlyScan = '2026-06-01T12:00:00.000Z';
    const lateScan = '2026-06-01T12:05:00.000Z';
    const response = await app.inject({
      method: 'POST',
      url: '/check-ins/sync',
      headers: { 'Idempotency-Key': 'idem_sync_distinct_scan_times' },
      payload: {
        checkInListId: 'cil_1',
        deviceId: 'sd_public',
        scans: [
          { qrHash: 'hash_late', scannedAt: lateScan, offline: true },
          { qrHash: 'hash_early', scannedAt: earlyScan, offline: true },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ accepted: 2, duplicates: 0, invalid: 0 });
    expect(inserts.filter((insert) => insert.table === 'scan_logs')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          values: expect.objectContaining({
            qr_hash: 'hash_early',
            scanned_at: new Date(earlyScan),
          }),
        }),
        expect.objectContaining({
          values: expect.objectContaining({
            qr_hash: 'hash_late',
            scanned_at: new Date(lateScan),
          }),
        }),
      ]),
    );

    await app.close();
  });

  it('logs same-event wrong-occurrence offline scans as invalid without checking in the ticket', async () => {
    const principal: Principal = {
      type: 'mobile_device',
      id: 'sd_public',
      tenantId: 'tnt_1',
      organizationIds: ['org_1'],
      scopes: ['checkins.write'],
      eventIds: ['evt_1'],
    };
    const { db, inserts, updates } = buildOfflineSyncMockDb({
      list: {
        id: 'cil_1',
        event_id: 'evt_1',
        event_occurrence_id: 'occ_allowed',
        ticket_type_ids: JSON.stringify(['tt_allowed']),
        status: 'active',
      },
      ticket: {
        id: 'tkt_1',
        tenant_id: 'tnt_1',
        event_id: 'evt_1',
        event_occurrence_id: 'occ_other',
        ticket_type_id: 'tt_allowed',
        qr_hash: 'hash_1',
        status: 'valid',
      },
    });
    const app = Fastify();
    app.decorate('context', {
      db,
      pricingEngine: {},
      inventoryService: {},
      qrService: {},
      authService: {},
      temporalClient: {},
    } as unknown as AppContext);
    app.addHook('onRequest', async (request) => {
      request.principal = principal;
    });
    await app.register(checkInRoutes);

    const response = await app.inject({
      method: 'POST',
      url: '/check-ins/sync',
      headers: { 'Idempotency-Key': 'idem_sync_wrong_occurrence' },
      payload: {
        checkInListId: 'cil_1',
        deviceId: 'sd_public',
        scans: [{ qrHash: 'hash_1', scannedAt: '2026-06-01T12:00:00.000Z', offline: true }],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      accepted: 0,
      duplicates: 0,
      invalid: 1,
      results: [{ qrHash: 'hash_1', outcome: 'wrong_list' }],
    });
    expect(updates).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: 'tickets',
          values: expect.objectContaining({ checked_in_by_device_id: 'sd_public' }),
        }),
      ]),
    );
    const scanLogInsert = inserts.find((insert) => insert.table === 'scan_logs');
    expect(scanLogInsert?.values).toMatchObject({
      device_id: 'sd_public',
      outcome: 'wrong_list',
    });
    const metadata = scanLogInsert?.values.metadata;
    expect(typeof metadata === 'string' ? JSON.parse(metadata) : metadata).toEqual({
      reason: 'wrong_event_occurrence',
      expectedEventOccurrenceId: 'occ_allowed',
      actualEventOccurrenceId: 'occ_other',
    });

    await app.close();
  });

  it('does not expose or persist ticket ids from another tenant during offline sync', async () => {
    const principal: Principal = {
      type: 'mobile_device',
      id: 'sd_public',
      tenantId: 'tnt_1',
      organizationIds: ['org_1'],
      scopes: ['checkins.write'],
      eventIds: ['evt_1'],
    };
    const { db, inserts, updates } = buildOfflineSyncMockDb({
      ticket: {
        id: 'tkt_foreign',
        tenant_id: 'tnt_other',
        attendee_id: 'att_foreign',
        event_id: 'evt_foreign',
        ticket_type_id: 'tt_allowed',
        qr_hash: 'hash_foreign',
        status: 'valid',
      },
    });
    const app = Fastify();
    app.decorate('context', {
      db,
      pricingEngine: {},
      inventoryService: {},
      qrService: {},
      authService: {},
      temporalClient: {},
    } as unknown as AppContext);
    app.addHook('onRequest', async (request) => {
      request.principal = principal;
    });
    await app.register(checkInRoutes);

    const response = await app.inject({
      method: 'POST',
      url: '/check-ins/sync',
      headers: { 'Idempotency-Key': 'idem_sync_foreign_tenant_ticket' },
      payload: {
        checkInListId: 'cil_1',
        deviceId: 'sd_public',
        scans: [{ qrHash: 'hash_foreign', scannedAt: '2026-06-01T12:00:00.000Z', offline: true }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      accepted: 0,
      duplicates: 0,
      invalid: 1,
      results: [{ qrHash: 'hash_foreign', outcome: 'not_found' }],
    });
    expect(updates).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: 'tickets',
          values: expect.objectContaining({ checked_in_by_device_id: 'sd_public' }),
        }),
      ]),
    );
    expect(inserts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: 'scan_logs',
          values: expect.objectContaining({
            ticket_id: null,
            qr_hash: 'hash_foreign',
            outcome: 'not_found',
          }),
        }),
      ]),
    );

    await app.close();
  });

  it('rejects a mobile scanner submitting scans for another device', async () => {
    const principal: Principal = {
      type: 'mobile_device',
      id: 'sd_public',
      tenantId: 'tnt_1',
      organizationIds: ['org_1'],
      scopes: ['checkins.write'],
      eventIds: ['evt_1'],
    };
    const { db, inserts, updates } = buildOfflineSyncMockDb();
    const app = Fastify();
    app.decorate('context', {
      db,
      pricingEngine: {},
      inventoryService: {},
      qrService: {},
      authService: {},
      temporalClient: {},
    } as unknown as AppContext);
    app.addHook('onRequest', async (request) => {
      request.principal = principal;
    });
    await app.register(checkInRoutes);

    const response = await app.inject({
      method: 'POST',
      url: '/check-ins/sync',
      headers: { 'Idempotency-Key': 'idem_sync_other_device' },
      payload: {
        checkInListId: 'cil_1',
        deviceId: 'sd_other',
        scans: [{ qrHash: 'hash_1', scannedAt: '2026-06-01T12:00:00.000Z', offline: true }],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Scanner device cannot submit scans for another device',
    });
    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);

    await app.close();
  });

  it('attributes non-mobile offline syncs to the authenticated principal', async () => {
    const principal: Principal = {
      type: 'user',
      id: 'usr_checkin_admin',
      tenantId: 'tnt_1',
      organizationIds: ['org_1'],
      scopes: ['checkins.write'],
      eventIds: ['evt_1'],
    };
    const { db, inserts, updates } = buildOfflineSyncMockDb();
    const app = Fastify();
    app.decorate('context', {
      db,
      pricingEngine: {},
      inventoryService: {},
      qrService: {},
      authService: {},
      temporalClient: {},
    } as unknown as AppContext);
    app.addHook('onRequest', async (request) => {
      request.principal = principal;
    });
    await app.register(checkInRoutes);

    const response = await app.inject({
      method: 'POST',
      url: '/check-ins/sync',
      headers: { 'Idempotency-Key': 'idem_sync_user_device_forge' },
      payload: {
        checkInListId: 'cil_1',
        deviceId: 'sd_victim',
        scans: [{ qrHash: 'hash_1', scannedAt: '2026-06-01T12:00:00.000Z', offline: true }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: 'tickets',
          values: expect.objectContaining({ checked_in_by_device_id: 'usr_checkin_admin' }),
        }),
        expect.objectContaining({
          table: 'attendees',
          values: expect.objectContaining({ check_in_device_id: 'usr_checkin_admin' }),
        }),
      ]),
    );
    expect(inserts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: 'scan_logs',
          values: expect.objectContaining({ device_id: 'usr_checkin_admin' }),
        }),
      ]),
    );
    expect(updates).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          values: expect.objectContaining({ checked_in_by_device_id: 'sd_victim' }),
        }),
        expect.objectContaining({
          values: expect.objectContaining({ check_in_device_id: 'sd_victim' }),
        }),
      ]),
    );
    expect(inserts).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          values: expect.objectContaining({ device_id: 'sd_victim' }),
        }),
      ]),
    );

    await app.close();
  });

  it('rolls back ticket and attendee updates when offline scan logging fails', async () => {
    const principal: Principal = {
      type: 'mobile_device',
      id: 'sd_1',
      tenantId: 'tnt_1',
      organizationIds: ['org_1'],
      scopes: ['checkins.write'],
      eventIds: ['evt_1'],
    };
    const { db, inserts, updates } = buildOfflineSyncMockDb({ failScanLogInsert: true });
    const app = Fastify();
    app.decorate('context', {
      db,
      pricingEngine: {},
      inventoryService: {},
      qrService: {},
      authService: {},
      temporalClient: {},
    } as unknown as AppContext);
    app.addHook('onRequest', async (request) => {
      request.principal = principal;
    });
    await app.register(checkInRoutes);

    const response = await app.inject({
      method: 'POST',
      url: '/check-ins/sync',
      headers: { 'Idempotency-Key': 'idem_sync_log_failure' },
      payload: {
        checkInListId: 'cil_1',
        scans: [{ qrHash: 'hash_1', scannedAt: '2026-06-01T12:00:00.000Z', offline: true }],
      },
    });

    expect(response.statusCode).toBe(500);
    expect(db.transaction).toHaveBeenCalled();
    expect(updates).toHaveLength(0);
    expect(inserts).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ table: 'scan_logs' })]),
    );

    await app.close();
  });

  it('does not count already-checked-in non-Postgres fallback rows as accepted', async () => {
    const originalDbDriver = process.env.DB_DRIVER;
    process.env.DB_DRIVER = 'mysql';
    const principal: Principal = {
      type: 'mobile_device',
      id: 'sd_1',
      tenantId: 'tnt_1',
      organizationIds: ['org_1'],
      scopes: ['checkins.write'],
      eventIds: ['evt_1'],
    };
    const { db, inserts } = buildOfflineSyncMockDb();
    db.updateTable = vi.fn(() => {
      const updateChain = {
        set: () => updateChain,
        where: () => updateChain,
        returning: () => ({
          execute: vi.fn(async () => [{ id: 'tkt_1' }]),
        }),
        executeTakeFirst: vi.fn(async () => ({ numUpdatedRows: 0n })),
        execute: vi.fn(async () => []),
      };
      return updateChain;
    }) as never;
    const app = Fastify();
    app.decorate('context', {
      db,
      pricingEngine: {},
      inventoryService: {},
      qrService: {},
      authService: {},
      temporalClient: {},
    } as unknown as AppContext);
    app.addHook('onRequest', async (request) => {
      request.principal = principal;
    });
    await app.register(checkInRoutes);

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/check-ins/sync',
        headers: { 'Idempotency-Key': 'idem_sync_mysql_duplicate' },
        payload: {
          checkInListId: 'cil_1',
          scans: [{ qrHash: 'hash_1', scannedAt: '2026-06-01T12:00:00.000Z', offline: true }],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        accepted: 0,
        duplicates: 1,
        invalid: 0,
        results: [{ qrHash: 'hash_1', outcome: 'duplicate' }],
      });
      expect(inserts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            table: 'scan_logs',
            values: expect.objectContaining({ outcome: 'duplicate' }),
          }),
        ]),
      );
    } finally {
      if (originalDbDriver === undefined) delete process.env.DB_DRIVER;
      else process.env.DB_DRIVER = originalDbDriver;
      await app.close();
    }
  });

  it('sorts scans by scannedAt so earliest scan wins (deterministic conflict resolution)', async () => {
    const principal: Principal = {
      type: 'mobile_device',
      id: 'sd_1',
      tenantId: 'tnt_1',
      organizationIds: ['org_1'],
      scopes: ['checkins.write'],
      eventIds: ['evt_1'],
    };
    // Track checkInIfValid calls: first succeeds, second fails (duplicate).
    let checkInCallCount = 0;
    const { db } = buildOfflineSyncMockDb({});
    // Override updateTable to track calls and fail on second check-in.
    db.updateTable = vi.fn(() => {
      const updateChain = {
        set: () => updateChain,
        where: () => updateChain,
        async executeTakeFirst() {
          checkInCallCount++;
          return { numUpdatedRows: checkInCallCount === 1 ? 1n : 0n };
        },
        returning: () => ({
          execute: vi.fn(async () => {
            checkInCallCount++;
            return checkInCallCount === 1 ? [{ id: 'tkt_1' }] : [];
          }),
        }),
        async execute() {
          return [];
        },
      };
      return updateChain;
    }) as never;
    const app = Fastify();
    app.decorate('context', {
      db,
      pricingEngine: {},
      inventoryService: {},
      qrService: {},
      authService: {},
      temporalClient: {},
    } as unknown as AppContext);
    app.addHook('onRequest', async (request) => {
      request.principal = principal;
    });
    await app.register(checkInRoutes);

    const response = await app.inject({
      method: 'POST',
      url: '/check-ins/sync',
      headers: { 'Idempotency-Key': 'idem_sync_2' },
      payload: {
        checkInListId: 'cil_1',
        scans: [
          { qrHash: 'hash_1', scannedAt: '2026-06-01T12:05:00.000Z', offline: true },
          { qrHash: 'hash_1', scannedAt: '2026-06-01T12:00:00.000Z', offline: true },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    // First scan (earliest by scannedAt) is accepted, second is duplicate
    expect(body.accepted).toBe(1);
    expect(body.duplicates).toBe(1);
    expect(body.results).toHaveLength(2);

    await app.close();
  });

  it('returns 404 when check-in list does not exist', async () => {
    const principal: Principal = {
      type: 'mobile_device',
      id: 'sd_1',
      tenantId: 'tnt_1',
      organizationIds: ['org_1'],
      scopes: ['checkins.write'],
      eventIds: ['evt_1'],
    };
    const { db } = buildOfflineSyncMockDb({ list: null });
    const app = Fastify();
    app.decorate('context', {
      db,
      pricingEngine: {},
      inventoryService: {},
      qrService: {},
      authService: {},
      temporalClient: {},
    } as unknown as AppContext);
    app.addHook('onRequest', async (request) => {
      request.principal = principal;
    });
    await app.register(checkInRoutes);

    const response = await app.inject({
      method: 'POST',
      url: '/check-ins/sync',
      headers: { 'Idempotency-Key': 'idem_sync_3' },
      payload: {
        checkInListId: 'cil_missing',
        scans: [{ qrHash: 'hash_1', scannedAt: '2026-06-01T12:00:00.000Z', offline: true }],
      },
    });

    expect(response.statusCode).toBe(404);

    await app.close();
  });
});

describe('bulk offline sync endpoint', () => {
  const principal: Principal = {
    type: 'mobile_device',
    id: 'sd_bulk',
    tenantId: 'tnt_1',
    organizationIds: ['org_1'],
    scopes: ['checkins.read', 'checkins.write'],
    eventIds: ['evt_1'],
  };

  async function setupBulkApp(overrides: OfflineSyncMockOverrides = {}) {
    const mock = buildOfflineSyncMockDb(overrides);
    const app = Fastify();
    let activePrincipal = principal;
    app.decorate('context', {
      db: mock.db,
      pricingEngine: {},
      inventoryService: {},
      qrService: {},
      authService: {},
      temporalClient: {},
    } as unknown as AppContext);
    app.addHook('onRequest', async (request) => {
      request.principal = activePrincipal;
    });
    await app.register(checkInRoutes);
    return {
      app,
      setPrincipal: (nextPrincipal: Principal) => {
        activePrincipal = nextPrincipal;
      },
      ...mock,
    };
  }

  it('creates a bounded async job for an authorized active check-in list', async () => {
    const { app } = await setupBulkApp();

    const job = await createBulkJob(app);

    expect(job).toMatchObject({
      checkInListId: 'cil_1',
      eventId: 'evt_1',
      deviceId: 'sd_bulk',
      totalChunks: 2,
      chunksReceived: 0,
      chunksProcessed: 0,
      status: 'pending',
      accepted: 0,
      duplicates: 0,
      invalid: 0,
      sampleErrors: [],
    });
    expect(job).not.toHaveProperty('results');

    await app.close();
  });

  it('rejects inactive check-in lists before creating a bulk job', async () => {
    const { app, inserts } = await setupBulkApp({
      list: {
        id: 'cil_1',
        event_id: 'evt_1',
        ticket_type_ids: JSON.stringify(['tt_allowed']),
        status: 'disabled',
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/check-ins/bulk-sync-jobs',
      headers: { 'Idempotency-Key': 'idem_bulk_inactive_list' },
      payload: {
        checkInListId: 'cil_1',
        totalChunks: 1,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ message: 'Check-in list is not active' });
    expect(inserts).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ table: 'offline_check_in_sync_jobs' })]),
    );

    await app.close();
  });

  it('allows owning read-only scanner principals to poll async job and chunk summaries', async () => {
    const { app, setPrincipal } = await setupBulkApp();
    const job = await createBulkJob(app);
    const chunk = await app.inject({
      method: 'PUT',
      url: `/check-ins/bulk-sync-jobs/${job.id}/chunks/1`,
      headers: { 'Idempotency-Key': 'idem_bulk_read_only_chunk_1' },
      payload: {
        scans: [{ qrHash: 'hash_1', scannedAt: '2026-06-01T12:00:00.000Z', offline: true }],
      },
    });
    expect(chunk.statusCode).toBe(202);

    setPrincipal({
      ...principal,
      scopes: ['checkins.read'],
    });

    const status = await app.inject({
      method: 'GET',
      url: `/check-ins/bulk-sync-jobs/${job.id}`,
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ id: job.id, status: 'receiving' });

    const chunks = await app.inject({
      method: 'GET',
      url: `/check-ins/bulk-sync-jobs/${job.id}/chunks`,
    });
    expect(chunks.statusCode).toBe(200);
    expect(chunks.json()).toMatchObject({
      total: 1,
      items: [expect.objectContaining({ sequence: 1, status: 'uploaded' })],
    });

    await app.close();
  });

  it('hides async job polling and chunks from non-owner scanner principals without scheduling', async () => {
    const { app, setPrincipal, inserts } = await setupBulkApp();
    const job = await createBulkJob(app);
    const storedJob = inserts.find(
      (insert) => insert.table === 'offline_check_in_sync_jobs',
    )?.values;
    expect(storedJob).toBeDefined();
    Object.assign(storedJob!, {
      status: 'receiving',
      chunks_received: 2,
      updated_at: new Date('2026-06-01T12:02:00.000Z'),
    });
    inserts.push({
      table: 'offline_check_in_sync_chunks',
      values: {
        id: 'bch_non_owner_1',
        tenant_id: 'tnt_1',
        job_id: job.id,
        sequence: 1,
        scan_count: 1,
        payload_hash: 'hash_1',
        payload: JSON.stringify([
          {
            qrHash: 'hash_1',
            scannedAt: new Date('2026-06-01T12:01:00.000Z'),
            scannedAtIso: '2026-06-01T12:01:00.000Z',
            offline: true,
          },
        ]),
        accepted_count: 0,
        duplicate_count: 0,
        invalid_count: 0,
        sample_errors: JSON.stringify([]),
        clock_warning_count: 0,
        status: 'uploaded',
        attempt_count: 0,
        failure_message: null,
        locked_at: null,
        processed_at: null,
        created_at: new Date('2026-06-01T12:00:00.000Z'),
        updated_at: new Date('2026-06-01T12:00:00.000Z'),
      },
    });
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    setPrincipal({
      ...principal,
      id: 'sd_bulk_non_owner',
      scopes: ['checkins.read'],
    });
    setTimeoutSpy.mockClear();

    const status = await app.inject({
      method: 'GET',
      url: `/check-ins/bulk-sync-jobs/${job.id}`,
    });
    expect(status.statusCode).toBe(404);
    expect(setTimeoutSpy).not.toHaveBeenCalled();

    const chunks = await app.inject({
      method: 'GET',
      url: `/check-ins/bulk-sync-jobs/${job.id}/chunks`,
    });
    expect(chunks.statusCode).toBe(404);
    expect(setTimeoutSpy).not.toHaveBeenCalled();

    setTimeoutSpy.mockRestore();
    await app.close();
  });

  it('lets read-only async job polling reschedule eligible stuck processing work', async () => {
    const { app, setPrincipal, inserts } = await setupBulkApp();
    const job = await createBulkJob(app);
    const storedJob = inserts.find(
      (insert) => insert.table === 'offline_check_in_sync_jobs',
    )?.values;
    expect(storedJob).toBeDefined();
    Object.assign(storedJob!, {
      status: 'receiving',
      chunks_received: 2,
      updated_at: new Date('2026-06-01T12:02:00.000Z'),
    });
    for (const [sequence, qrHash] of [
      [1, 'hash_1'],
      [2, 'missing_hash'],
    ] as const) {
      inserts.push({
        table: 'offline_check_in_sync_chunks',
        values: {
          id: `bch_poll_${sequence}`,
          tenant_id: 'tnt_1',
          job_id: job.id,
          sequence,
          scan_count: 1,
          payload_hash: `hash_${sequence}`,
          payload: JSON.stringify([
            {
              qrHash,
              scannedAt: new Date(`2026-06-01T12:0${sequence}:00.000Z`),
              scannedAtIso: `2026-06-01T12:0${sequence}:00.000Z`,
              offline: true,
            },
          ]),
          accepted_count: 0,
          duplicate_count: 0,
          invalid_count: 0,
          sample_errors: JSON.stringify([]),
          clock_warning_count: 0,
          status: 'uploaded',
          attempt_count: 0,
          failure_message: null,
          locked_at: null,
          processed_at: null,
          created_at: new Date('2026-06-01T12:00:00.000Z'),
          updated_at: new Date('2026-06-01T12:00:00.000Z'),
        },
      });
    }
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    setPrincipal({
      ...principal,
      scopes: ['checkins.read'],
    });
    setTimeoutSpy.mockClear();

    const status = await app.inject({
      method: 'GET',
      url: `/check-ins/bulk-sync-jobs/${job.id}`,
    });

    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ id: job.id, status: 'receiving', chunksReceived: 2 });
    expect(setTimeoutSpy).toHaveBeenCalled();

    setTimeoutSpy.mockRestore();
    await app.close();
  });

  it('does not reschedule read-only async job polling until all chunks are uploaded', async () => {
    const { app, setPrincipal } = await setupBulkApp();
    const job = await createBulkJob(app);
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    setPrincipal({
      ...principal,
      scopes: ['checkins.read'],
    });
    setTimeoutSpy.mockClear();

    const status = await app.inject({
      method: 'GET',
      url: `/check-ins/bulk-sync-jobs/${job.id}`,
    });

    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ id: job.id, status: 'pending', chunksReceived: 0 });
    expect(setTimeoutSpy).not.toHaveBeenCalled();

    setTimeoutSpy.mockRestore();
    await app.close();
  });

  it('rejects read-only scanner principals when creating async jobs or uploading chunks', async () => {
    const { app, setPrincipal } = await setupBulkApp();
    const job = await createBulkJob(app);

    setPrincipal({
      ...principal,
      id: 'sd_bulk_read_only',
      scopes: ['checkins.read'],
    });

    const create = await app.inject({
      method: 'POST',
      url: '/check-ins/bulk-sync-jobs',
      headers: { 'Idempotency-Key': 'idem_bulk_read_only_create' },
      payload: {
        checkInListId: 'cl_1',
        totalChunks: 1,
        totalScans: 1,
      },
    });
    expect(create.statusCode).toBe(403);

    const upload = await app.inject({
      method: 'PUT',
      url: `/check-ins/bulk-sync-jobs/${job.id}/chunks/1`,
      headers: { 'Idempotency-Key': 'idem_bulk_read_only_upload' },
      payload: {
        scans: [{ qrHash: 'hash_1', scannedAt: '2026-06-01T12:00:00.000Z', offline: true }],
      },
    });
    expect(upload.statusCode).toBe(403);

    await app.close();
  });

  it('rejects scanner principals uploading chunks to another scanner device job', async () => {
    const { app, setPrincipal, inserts } = await setupBulkApp();
    const job = await createBulkJob(app);

    setPrincipal({
      ...principal,
      id: 'sd_other_writer',
      scopes: ['checkins.read', 'checkins.write'],
    });

    const response = await app.inject({
      method: 'PUT',
      url: `/check-ins/bulk-sync-jobs/${job.id}/chunks/1`,
      headers: { 'Idempotency-Key': 'idem_bulk_wrong_device_upload' },
      payload: {
        scans: [{ qrHash: 'hash_1', scannedAt: '2026-06-01T12:00:00.000Z', offline: true }],
      },
    });

    expect(response.statusCode).toBe(404);
    expect(inserts).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ table: 'offline_check_in_sync_chunks' })]),
    );

    await app.close();
  });

  it('rejects oversized async chunks before persisting chunk state', async () => {
    const { app, inserts } = await setupBulkApp();
    const job = await createBulkJob(app);

    const response = await app.inject({
      method: 'PUT',
      url: `/check-ins/bulk-sync-jobs/${job.id}/chunks/1`,
      headers: { 'Idempotency-Key': 'idem_bulk_chunk_oversized' },
      payload: {
        scans: Array.from({ length: MAX_BULK_OFFLINE_SYNC_CHUNK_SCANS + 1 }, (_, index) => ({
          qrHash: `hash_${index}`,
          scannedAt: '2026-06-01T12:00:00.000Z',
          offline: true,
        })),
      },
    });

    expect(response.statusCode).toBe(400);
    expect(inserts).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ table: 'offline_check_in_sync_chunks' })]),
    );

    await app.close();
  });

  it('rejects chunk uploads that exceed the global async scan cap when totalScans is omitted', async () => {
    const { app, inserts } = await setupBulkApp();
    const job = await createBulkJob(app);
    inserts.push({
      table: 'offline_check_in_sync_chunks',
      values: {
        id: 'bch_existing_max',
        tenant_id: 'tnt_1',
        job_id: job.id,
        sequence: 1,
        scan_count: MAX_BULK_OFFLINE_SYNC_TOTAL_SCANS,
        payload_hash: 'existing_hash',
        payload: JSON.stringify([]),
        accepted_count: 0,
        duplicate_count: 0,
        invalid_count: 0,
        sample_errors: JSON.stringify([]),
        status: 'uploaded',
        attempt_count: 0,
        failure_message: null,
        locked_at: null,
        processed_at: null,
        created_at: new Date('2026-06-01T12:00:00.000Z'),
        updated_at: new Date('2026-06-01T12:00:00.000Z'),
      },
    });

    const response = await app.inject({
      method: 'PUT',
      url: `/check-ins/bulk-sync-jobs/${job.id}/chunks/2`,
      headers: { 'Idempotency-Key': 'idem_bulk_global_cap' },
      payload: {
        scans: [{ qrHash: 'hash_1', scannedAt: '2026-06-01T12:00:00.000Z', offline: true }],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      message: 'Uploaded chunk scans exceed maximum bulk sync scan count',
    });
    expect(
      inserts.filter(
        (insert) =>
          insert.table === 'offline_check_in_sync_chunks' &&
          insert.values.id !== 'bch_existing_max',
      ),
    ).toHaveLength(0);

    await app.close();
  });

  it('fails completed async jobs whose uploaded chunk scan count is below totalScans', async () => {
    const { app, db, inserts } = await setupBulkApp();
    const job = await createBulkJob(app, { totalScans: 3 });

    for (const [sequence, qrHash] of [
      [1, 'hash_1'],
      [2, 'missing_hash'],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop -- each chunk upload assertion uses the sequence-specific response.
      const response = await app.inject({
        method: 'PUT',
        url: `/check-ins/bulk-sync-jobs/${job.id}/chunks/${sequence}`,
        headers: { 'Idempotency-Key': `idem_bulk_truncated_${sequence}` },
        payload: {
          scans: [{ qrHash, scannedAt: '2026-06-01T12:00:00.000Z', offline: true }],
        },
      });
      expect(response.statusCode).toBe(202);
    }

    await processPendingBulkSyncChunks(db as unknown as Database, job.id);

    expect(inserts.filter((insert) => insert.table === 'scan_logs')).toHaveLength(0);
    const status = await app.inject({
      method: 'GET',
      url: `/check-ins/bulk-sync-jobs/${job.id}`,
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      status: 'failed',
      totalScans: 3,
      chunksReceived: 2,
      chunksProcessed: 0,
      failureMessage: 'Bulk sync chunk processing failed',
    });

    await app.close();
  });

  it('accepts out-of-order chunks and processes each chunk once across replay', async () => {
    const { app, db, inserts } = await setupBulkApp();
    const job = await createBulkJob(app);

    const secondChunk = await app.inject({
      method: 'PUT',
      url: `/check-ins/bulk-sync-jobs/${job.id}/chunks/2`,
      headers: { 'Idempotency-Key': 'idem_bulk_chunk_2' },
      payload: {
        scans: [{ qrHash: 'hash_1', scannedAt: '2026-06-01T12:05:00.000Z', offline: true }],
      },
    });
    expect(secondChunk.statusCode).toBe(202);
    await processPendingBulkSyncChunks(db as unknown as Database, job.id);
    expect(inserts.filter((insert) => insert.table === 'scan_logs')).toHaveLength(0);

    const firstChunk = await app.inject({
      method: 'PUT',
      url: `/check-ins/bulk-sync-jobs/${job.id}/chunks/1`,
      headers: { 'Idempotency-Key': 'idem_bulk_chunk_1' },
      payload: {
        scans: [
          { qrHash: 'hash_1', scannedAt: '2026-06-01T12:00:00.000Z', offline: true },
          { qrHash: 'missing_hash', scannedAt: '2026-06-01T12:01:00.000Z', offline: true },
        ],
      },
    });
    expect(firstChunk.statusCode).toBe(202);

    await processPendingBulkSyncChunks(db as unknown as Database, job.id);
    const logsAfterFirstProcessing = inserts.filter((insert) => insert.table === 'scan_logs');
    expect(logsAfterFirstProcessing).toHaveLength(3);
    expect(logsAfterFirstProcessing).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          values: expect.objectContaining({ qr_hash: 'hash_1', outcome: 'accepted' }),
        }),
        expect.objectContaining({
          values: expect.objectContaining({ qr_hash: 'hash_1', outcome: 'duplicate' }),
        }),
        expect.objectContaining({
          values: expect.objectContaining({ qr_hash: 'missing_hash', outcome: 'not_found' }),
        }),
      ]),
    );

    await processPendingBulkSyncChunks(db as unknown as Database, job.id);
    expect(inserts.filter((insert) => insert.table === 'scan_logs')).toHaveLength(3);

    const status = await app.inject({
      method: 'GET',
      url: `/check-ins/bulk-sync-jobs/${job.id}`,
    });

    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      status: 'completed',
      chunksReceived: 2,
      chunksProcessed: 2,
      accepted: 1,
      duplicates: 1,
      invalid: 1,
      sampleErrors: [
        expect.objectContaining({
          sequence: 1,
          scanIndex: 1,
          outcome: 'not_found',
        }),
      ],
    });
    expect(status.json().sampleErrors[0]).not.toHaveProperty('qrHash');
    expect(status.json()).not.toHaveProperty('results');

    await app.close();
  });

  it('reruns async processing when the final chunk arrives during an in-flight incomplete pass', async () => {
    let appRef: FastifyInstance | null = null;
    let jobId = '';
    let uploadedFinalChunkDuringWorker = false;
    const { app, inserts } = await setupBulkApp({
      onUnclaimedBulkSyncJob: async () => {
        if (!appRef || uploadedFinalChunkDuringWorker) return;
        uploadedFinalChunkDuringWorker = true;
        const finalChunk = await appRef.inject({
          method: 'PUT',
          url: `/check-ins/bulk-sync-jobs/${jobId}/chunks/2`,
          headers: { 'Idempotency-Key': 'idem_bulk_rerun_chunk_2' },
          payload: {
            scans: [
              { qrHash: 'missing_hash', scannedAt: '2026-06-01T12:01:00.000Z', offline: true },
            ],
          },
        });
        expect(finalChunk.statusCode).toBe(202);
      },
    });
    appRef = app;
    const job = await createBulkJob(app);
    jobId = job.id;

    const firstChunk = await app.inject({
      method: 'PUT',
      url: `/check-ins/bulk-sync-jobs/${job.id}/chunks/1`,
      headers: { 'Idempotency-Key': 'idem_bulk_rerun_chunk_1' },
      payload: {
        scans: [{ qrHash: 'hash_1', scannedAt: '2026-06-01T12:00:00.000Z', offline: true }],
      },
    });
    expect(firstChunk.statusCode).toBe(202);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop -- scheduler flushes are retried until the worker writes scan logs.
      await flushBulkSyncScheduler();
      if (inserts.some((insert) => insert.table === 'scan_logs')) break;
    }

    expect(uploadedFinalChunkDuringWorker).toBe(true);
    expect(inserts.filter((insert) => insert.table === 'scan_logs')).toHaveLength(2);
    const status = await app.inject({
      method: 'GET',
      url: `/check-ins/bulk-sync-jobs/${job.id}`,
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      status: 'completed',
      chunksReceived: 2,
      chunksProcessed: 2,
      accepted: 1,
      invalid: 1,
    });

    await app.close();
  });

  it('redacts raw worker failures from bulk sync status responses', async () => {
    const { app, db } = await setupBulkApp({ failScanLogInsert: true });
    const job = await createBulkJob(app);

    const firstChunk = await app.inject({
      method: 'PUT',
      url: `/check-ins/bulk-sync-jobs/${job.id}/chunks/1`,
      headers: { 'Idempotency-Key': 'idem_bulk_failed_chunk_1' },
      payload: {
        scans: [{ qrHash: 'hash_1', scannedAt: '2026-06-01T12:00:00.000Z', offline: true }],
      },
    });
    expect(firstChunk.statusCode).toBe(202);

    const secondChunk = await app.inject({
      method: 'PUT',
      url: `/check-ins/bulk-sync-jobs/${job.id}/chunks/2`,
      headers: { 'Idempotency-Key': 'idem_bulk_failed_chunk_2' },
      payload: {
        scans: [{ qrHash: 'missing_hash', scannedAt: '2026-06-01T12:01:00.000Z', offline: true }],
      },
    });
    expect(secondChunk.statusCode).toBe(202);

    await processPendingBulkSyncChunks(db as unknown as Database, job.id);

    const status = await app.inject({
      method: 'GET',
      url: `/check-ins/bulk-sync-jobs/${job.id}`,
    });

    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      status: 'failed',
      failureMessage: 'Bulk sync chunk processing failed',
    });
    expect(JSON.stringify(status.json())).not.toContain('scan log insert failed');

    await app.close();
  });

  it('uses earliest scannedAt across all async chunks before marking duplicates', async () => {
    const { app, db, inserts } = await setupBulkApp();
    const job = await createBulkJob(app);

    const lateFirstChunk = await app.inject({
      method: 'PUT',
      url: `/check-ins/bulk-sync-jobs/${job.id}/chunks/1`,
      headers: { 'Idempotency-Key': 'idem_bulk_global_order_chunk_1' },
      payload: {
        scans: [{ qrHash: 'hash_1', scannedAt: '2026-06-01T12:05:00.000Z', offline: true }],
      },
    });
    expect(lateFirstChunk.statusCode).toBe(202);

    const earlySecondChunk = await app.inject({
      method: 'PUT',
      url: `/check-ins/bulk-sync-jobs/${job.id}/chunks/2`,
      headers: { 'Idempotency-Key': 'idem_bulk_global_order_chunk_2' },
      payload: {
        scans: [{ qrHash: 'hash_1', scannedAt: '2026-06-01T12:00:00.000Z', offline: true }],
      },
    });
    expect(earlySecondChunk.statusCode).toBe(202);

    await processPendingBulkSyncChunks(db as unknown as Database, job.id);

    const scanLogs = inserts
      .filter((insert) => insert.table === 'scan_logs')
      .map((insert) => insert.values);
    expect(scanLogs).toEqual([
      expect.objectContaining({
        qr_hash: 'hash_1',
        outcome: 'accepted',
        scanned_at: new Date('2026-06-01T12:00:00.000Z'),
      }),
      expect.objectContaining({
        qr_hash: 'hash_1',
        outcome: 'duplicate',
        scanned_at: new Date('2026-06-01T12:05:00.000Z'),
      }),
    ]);

    const status = await app.inject({
      method: 'GET',
      url: `/check-ins/bulk-sync-jobs/${job.id}`,
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      status: 'completed',
      accepted: 1,
      duplicates: 1,
      invalid: 0,
    });

    await app.close();
  });

  it('claims one worker lease when multiple workers process the same completed job', async () => {
    const { app, db, inserts } = await setupBulkApp();
    const job = await createBulkJob(app);

    for (const [sequence, qrHash] of [
      [1, 'hash_1'],
      [2, 'missing_hash'],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop -- each chunk upload assertion uses the sequence-specific response.
      const response = await app.inject({
        method: 'PUT',
        url: `/check-ins/bulk-sync-jobs/${job.id}/chunks/${sequence}`,
        headers: { 'Idempotency-Key': `idem_bulk_worker_race_${sequence}` },
        payload: {
          scans: [{ qrHash, scannedAt: '2026-06-01T12:00:00.000Z', offline: true }],
        },
      });
      expect(response.statusCode).toBe(202);
    }

    await Promise.all([
      processPendingBulkSyncChunks(db as unknown as Database, job.id, { workerId: 'worker-a' }),
      processPendingBulkSyncChunks(db as unknown as Database, job.id, { workerId: 'worker-b' }),
    ]);
    await processPendingBulkSyncChunks(db as unknown as Database, job.id, { workerId: 'worker-c' });

    expect(inserts.filter((insert) => insert.table === 'scan_logs')).toHaveLength(2);
    const chunkRows = inserts
      .filter((insert) => insert.table === 'offline_check_in_sync_chunks')
      .map((insert) => insert.values);
    expect(chunkRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'processed', payload: null }),
        expect.objectContaining({ status: 'processed', payload: null }),
      ]),
    );

    await app.close();
  });

  it('retries a stuck processing job after the lease expires', async () => {
    const { app, db, inserts } = await setupBulkApp();
    const job = await createBulkJob(app);

    for (const sequence of [1, 2]) {
      // eslint-disable-next-line no-await-in-loop -- chunk uploads intentionally set up ordered worker lease state.
      const response = await app.inject({
        method: 'PUT',
        url: `/check-ins/bulk-sync-jobs/${job.id}/chunks/${sequence}`,
        headers: { 'Idempotency-Key': `idem_bulk_stuck_retry_${sequence}` },
        payload: {
          scans: [
            {
              qrHash: sequence === 1 ? 'hash_1' : 'missing_hash',
              scannedAt: `2026-06-01T12:0${sequence}:00.000Z`,
              offline: true,
            },
          ],
        },
      });
      expect(response.statusCode).toBe(202);
    }

    const expiredLease = new Date(Date.now() - 60_000);
    const jobRow = inserts.find((insert) => insert.table === 'offline_check_in_sync_jobs')!.values;
    Object.assign(jobRow, {
      status: 'processing',
      lease_owner: 'dead-worker',
      leased_until: expiredLease,
      next_attempt_at: expiredLease,
      attempt_count: 1,
    });
    for (const chunk of inserts.filter(
      (insert) => insert.table === 'offline_check_in_sync_chunks',
    )) {
      Object.assign(chunk.values, {
        status: 'processing',
        locked_at: expiredLease,
      });
    }

    const processed = await processPendingBulkSyncJobs(db as unknown as Database, {
      workerId: 'replacement-worker',
      limit: 10,
    });

    expect(processed).toBeGreaterThanOrEqual(1);
    expect(inserts.filter((insert) => insert.table === 'scan_logs')).toHaveLength(2);
    expect(jobRow).toEqual(
      expect.objectContaining({
        status: 'completed',
        lease_owner: null,
        leased_until: null,
        rows_processed: 2,
      }),
    );

    await app.close();
  });

  it('does not let a stale worker overwrite or replay a replacement worker result', async () => {
    let replacementStarted = false;
    let replacementFinished = false;
    let dbForReplacement: unknown;
    let replacementJobId = '';
    const { app, db, inserts } = await setupBulkApp({
      onBulkSyncJobClaimed: async (claimedJob) => {
        if (claimedJob.lease_owner !== 'worker-a' || replacementStarted) return;
        replacementStarted = true;
        claimedJob.leased_until = new Date(Date.now() - 60_000);
        await processPendingBulkSyncChunks(dbForReplacement as Database, replacementJobId, {
          workerId: 'worker-b',
        });
        replacementFinished = true;
      },
    });
    dbForReplacement = db;
    const job = await createBulkJob(app);
    replacementJobId = job.id;

    for (const [sequence, qrHash] of [
      [1, 'hash_1'],
      [2, 'missing_hash'],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop -- sequence-specific setup makes the stale claim scenario explicit.
      const response = await app.inject({
        method: 'PUT',
        url: `/check-ins/bulk-sync-jobs/${job.id}/chunks/${sequence}`,
        headers: { 'Idempotency-Key': `idem_bulk_stale_worker_${sequence}` },
        payload: {
          scans: [{ qrHash, scannedAt: '2026-06-01T12:00:00.000Z', offline: true }],
        },
      });
      expect(response.statusCode).toBe(202);
    }

    await processPendingBulkSyncChunks(db as unknown as Database, job.id, { workerId: 'worker-a' });

    const jobRow = inserts.find((insert) => insert.table === 'offline_check_in_sync_jobs')!.values;
    expect(replacementStarted).toBe(true);
    expect(replacementFinished).toBe(true);
    expect(inserts.filter((insert) => insert.table === 'scan_logs')).toHaveLength(2);
    expect(jobRow).toEqual(
      expect.objectContaining({
        status: 'completed',
        lease_owner: null,
        leased_until: null,
        rows_processed: 2,
        attempt_count: 2,
      }),
    );

    await app.close();
  });

  it('processes ready jobs when older incomplete jobs fill the worker limit', async () => {
    const { app, db, inserts } = await setupBulkApp();
    const job = await createBulkJob(app);

    for (const sequence of [1, 2]) {
      // eslint-disable-next-line no-await-in-loop -- chunk uploads intentionally create a ready job after stale rows.
      const response = await app.inject({
        method: 'PUT',
        url: `/check-ins/bulk-sync-jobs/${job.id}/chunks/${sequence}`,
        headers: { 'Idempotency-Key': `idem_bulk_ready_after_incomplete_${sequence}` },
        payload: {
          scans: [
            {
              qrHash: sequence === 1 ? 'hash_1' : 'missing_hash',
              scannedAt: `2026-06-01T12:0${sequence}:00.000Z`,
              offline: true,
            },
          ],
        },
      });
      expect(response.statusCode).toBe(202);
    }

    const readyJob = inserts.find(
      (insert) => insert.table === 'offline_check_in_sync_jobs',
    )!.values;
    Object.assign(readyJob, {
      updated_at: new Date('2026-06-01T12:10:00.000Z'),
    });
    inserts.unshift(
      {
        table: 'offline_check_in_sync_jobs',
        values: {
          ...readyJob,
          id: 'bsj_incomplete_1',
          status: 'receiving',
          chunks_received: 0,
          total_chunks: 2,
          updated_at: new Date('2026-06-01T12:00:00.000Z'),
        },
      },
      {
        table: 'offline_check_in_sync_jobs',
        values: {
          ...readyJob,
          id: 'bsj_incomplete_2',
          status: 'receiving',
          chunks_received: 1,
          total_chunks: 2,
          updated_at: new Date('2026-06-01T12:01:00.000Z'),
        },
      },
    );

    const processed = await processPendingBulkSyncJobs(db as unknown as Database, {
      workerId: 'ready-worker',
      limit: 1,
    });

    expect(processed).toBe(1);
    expect(inserts.filter((insert) => insert.table === 'scan_logs')).toHaveLength(2);
    expect(readyJob).toEqual(expect.objectContaining({ status: 'completed', rows_processed: 2 }));

    await app.close();
  });

  it('processes ready jobs when older failed jobs are still in backoff', async () => {
    const { app, db, inserts } = await setupBulkApp();
    const job = await createBulkJob(app);

    for (const sequence of [1, 2]) {
      // eslint-disable-next-line no-await-in-loop -- chunk uploads intentionally create a ready job after backoff rows.
      const response = await app.inject({
        method: 'PUT',
        url: `/check-ins/bulk-sync-jobs/${job.id}/chunks/${sequence}`,
        headers: { 'Idempotency-Key': `idem_bulk_ready_after_backoff_${sequence}` },
        payload: {
          scans: [
            {
              qrHash: sequence === 1 ? 'hash_1' : 'missing_hash',
              scannedAt: `2026-06-01T12:0${sequence}:00.000Z`,
              offline: true,
            },
          ],
        },
      });
      expect(response.statusCode).toBe(202);
    }

    const readyJob = inserts.find(
      (insert) => insert.table === 'offline_check_in_sync_jobs',
    )!.values;
    Object.assign(readyJob, {
      updated_at: new Date('2026-06-01T12:10:00.000Z'),
    });
    inserts.unshift({
      table: 'offline_check_in_sync_jobs',
      values: {
        ...readyJob,
        id: 'bsj_failed_backoff',
        status: 'failed',
        failure_message: 'Bulk sync chunk processing failed',
        chunks_received: 2,
        total_chunks: 2,
        next_attempt_at: new Date(Date.now() + 15 * 60 * 1000),
        updated_at: new Date('2026-06-01T12:00:00.000Z'),
      },
    });

    const processed = await processPendingBulkSyncJobs(db as unknown as Database, {
      workerId: 'ready-worker',
      limit: 1,
    });

    expect(processed).toBe(1);
    expect(inserts.filter((insert) => insert.table === 'scan_logs')).toHaveLength(2);
    expect(readyJob).toEqual(expect.objectContaining({ status: 'completed', rows_processed: 2 }));

    await app.close();
  });

  it('does not retry a failed bulk sync job before next_attempt_at', async () => {
    const { app, db, inserts } = await setupBulkApp();
    const job = await createBulkJob(app);

    const chunkUploadResponses = await Promise.all(
      [1, 2].map((sequence) =>
        app.inject({
          method: 'PUT',
          url: `/check-ins/bulk-sync-jobs/${job.id}/chunks/${sequence}`,
          headers: { 'Idempotency-Key': `idem_bulk_retry_backoff_${sequence}` },
          payload: {
            scans: [
              {
                qrHash: sequence === 1 ? 'hash_1' : 'missing_hash',
                scannedAt: `2026-06-01T12:0${sequence}:00.000Z`,
                offline: true,
              },
            ],
          },
        }),
      ),
    );
    for (const response of chunkUploadResponses) {
      expect(response.statusCode).toBe(202);
    }

    const futureAttempt = new Date(Date.now() + 15 * 60 * 1000);
    const jobRow = inserts.find((insert) => insert.table === 'offline_check_in_sync_jobs')!.values;
    Object.assign(jobRow, {
      status: 'failed',
      failure_message: 'Bulk sync chunk processing failed',
      lease_owner: null,
      leased_until: null,
      next_attempt_at: futureAttempt,
      attempt_count: 1,
    });
    for (const chunk of inserts.filter(
      (insert) => insert.table === 'offline_check_in_sync_chunks',
    )) {
      Object.assign(chunk.values, {
        status: 'failed',
        failure_message: 'Bulk sync chunk processing failed',
      });
    }

    await processPendingBulkSyncChunks(db as unknown as Database, job.id, {
      workerId: 'early-worker',
    });

    expect(inserts.filter((insert) => insert.table === 'scan_logs')).toHaveLength(0);
    expect(jobRow).toEqual(
      expect.objectContaining({
        status: 'failed',
        lease_owner: null,
        leased_until: null,
        next_attempt_at: futureAttempt,
        attempt_count: 1,
      }),
    );

    await app.close();
  });

  it('rejects extreme future async scannedAt values before storing chunks', async () => {
    const { app, inserts } = await setupBulkApp();
    const job = await createBulkJob(app);

    const response = await app.inject({
      method: 'PUT',
      url: `/check-ins/bulk-sync-jobs/${job.id}/chunks/1`,
      headers: { 'Idempotency-Key': 'idem_bulk_future_clock' },
      payload: {
        scans: [{ qrHash: 'hash_1', scannedAt: '2099-01-01T00:00:00.000Z', offline: true }],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ message: 'scan.scannedAt is too far in the future' });
    expect(
      inserts.filter((insert) => insert.table === 'offline_check_in_sync_chunks'),
    ).toHaveLength(0);

    await app.close();
  });

  it('records stale device-clock warnings on async jobs and scan logs', async () => {
    const { app, db, inserts } = await setupBulkApp();
    const job = await createBulkJob(app);

    for (const sequence of [1, 2]) {
      // eslint-disable-next-line no-await-in-loop -- chunk uploads intentionally set up ordered device-clock warning state.
      const response = await app.inject({
        method: 'PUT',
        url: `/check-ins/bulk-sync-jobs/${job.id}/chunks/${sequence}`,
        headers: { 'Idempotency-Key': `idem_bulk_clock_warning_${sequence}` },
        payload: {
          scans: [
            {
              qrHash: sequence === 1 ? 'hash_1' : 'missing_hash',
              scannedAt: `2020-01-01T00:0${sequence}:00.000Z`,
              offline: true,
            },
          ],
        },
      });
      expect(response.statusCode).toBe(202);
    }

    await processPendingBulkSyncChunks(db as unknown as Database, job.id, {
      workerId: 'clock-worker',
    });

    const status = await app.inject({
      method: 'GET',
      url: `/check-ins/bulk-sync-jobs/${job.id}`,
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      status: 'completed',
      processingMetrics: expect.objectContaining({ clockWarnings: 2 }),
    });
    const logMetadata = inserts
      .filter((insert) => insert.table === 'scan_logs')
      .map((insert) => JSON.parse(insert.values.metadata as string));
    expect(logMetadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ clockWarning: 'stale_device_clock' }),
        expect.objectContaining({ clockWarning: 'stale_device_clock' }),
      ]),
    );

    await app.close();
  });

  it('replays identical chunk uploads and rejects same-sequence payload conflicts', async () => {
    const { app, inserts } = await setupBulkApp();
    const job = await createBulkJob(app);
    const payload = {
      scans: [{ qrHash: 'hash_1', scannedAt: '2026-06-01T12:00:00.000Z', offline: true }],
    };

    const first = await app.inject({
      method: 'PUT',
      url: `/check-ins/bulk-sync-jobs/${job.id}/chunks/1`,
      headers: { 'Idempotency-Key': 'idem_bulk_chunk_replay_1' },
      payload,
    });
    expect(first.statusCode).toBe(202);

    const replay = await app.inject({
      method: 'PUT',
      url: `/check-ins/bulk-sync-jobs/${job.id}/chunks/1`,
      headers: { 'Idempotency-Key': 'idem_bulk_chunk_replay_2' },
      payload,
    });
    expect(replay.statusCode).toBe(202);
    expect(
      inserts.filter((insert) => insert.table === 'offline_check_in_sync_chunks'),
    ).toHaveLength(1);

    const conflict = await app.inject({
      method: 'PUT',
      url: `/check-ins/bulk-sync-jobs/${job.id}/chunks/1`,
      headers: { 'Idempotency-Key': 'idem_bulk_chunk_conflict' },
      payload: {
        scans: [{ qrHash: 'hash_other', scannedAt: '2026-06-01T12:00:00.000Z', offline: true }],
      },
    });

    expect(conflict.statusCode).toBe(400);
    expect(conflict.json()).toMatchObject({
      message: 'Chunk sequence was already uploaded with different scans',
    });

    await app.close();
  });
});
