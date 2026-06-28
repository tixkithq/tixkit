import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '@tixkit/domain';
import type { Database } from '@tixkit/db';
import type { AppContext } from '../app.js';
import {
  buildOfflineManifest,
  checkInRoutes,
  processScan,
  verifyOfflineManifestSignature,
} from '../routes/modules/checkin.js';

const list = {
  id: 'cil_1',
  event_id: 'evt_1',
  ticket_type_ids: JSON.stringify(['tt_allowed']),
};

function ticket(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tkt_1',
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

type OfflineSyncMockOverrides = {
  list?: Record<string, unknown> | null;
  event?: Record<string, unknown> | null;
  ticket?: Record<string, unknown> | null;
  checkInSucceeds?: boolean;
  existingIdempotency?: Record<string, unknown> | null;
};

function buildOfflineSyncMockDb(overrides: OfflineSyncMockOverrides = {}) {
  const inserts: Array<{ table: string; values: Record<string, unknown> }> = [];
  const updates: Array<{ table: string; values: Record<string, unknown> }> = [];
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
          event_id: 'evt_1',
          ticket_type_id: 'tt_allowed',
          qr_hash: 'hash_1',
          status: 'valid',
        };

  // Table-aware query builder: returns the right mock data per table.
  function makeQuery(table: string) {
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
      where() {
        return q;
      },
      orderBy() {
        return q;
      },
      limit() {
        return q;
      },
      async executeTakeFirst() {
        if (table === 'check_in_lists') return checkInList;
        if (table === 'events') return event;
        if (table === 'tickets') return ticketRow;
        if (table === 'idempotency_records') return overrides.existingIdempotency ?? null;
        return null;
      },
      async executeTakeFirstOrThrow() {
        const result = await q.executeTakeFirst();
        if (result === null || result === undefined) throw new Error(`No row for ${table}`);
        return result;
      },
      async execute() {
        if (table === 'check_in_lists') return checkInList ? [checkInList] : [];
        if (table === 'tickets') return ticketRow ? [ticketRow] : [];
        return [];
      },
    };
    return q;
  }

  const db = {
    selectFrom: vi.fn((table: string) => makeQuery(table)),
    insertInto: vi.fn((table: string) => ({
      values: (values: Record<string, unknown>) => ({
        returningAll: () => ({
          executeTakeFirstOrThrow: vi.fn(async () => {
            inserts.push({ table, values });
            return { id: 'slog_1', ...values };
          }),
        }),
        execute: vi.fn(async () => {
          inserts.push({ table, values });
          return [];
        }),
      }),
    })),
    updateTable: vi.fn((table: string) => {
      const updateChain = {
        set: (values: Record<string, unknown>) => {
          updates.push({ table, values });
          return updateChain;
        },
        where: () => updateChain,
        async executeTakeFirst() {
          return { numUpdatedRows: 1n };
        },
        async execute() {
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
      execute: async (cb: (trx: unknown) => Promise<unknown>) => cb(db),
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

  it('rejects tickets whose type is not on the check-in list', async () => {
    const result = await processScan({
      ticketRepo: repo(ticket({ ticket_type_id: 'tt_other' })) as never,
      list: list as never,
      qrHash: 'hash_1',
      deviceId: 'sd_1',
      scannedAt: new Date('2026-06-01T00:00:00Z'),
      verification: { valid: true, ticketId: 'tkt_1' },
      requireVerifiedTicketId: true,
    });

    expect(result.outcome).toBe('wrong_list');
  });

  it('accepts valid tickets only when the atomic check-in wins', async () => {
    const ticketRepo = repo(ticket(), true);
    const result = await processScan({
      ticketRepo: ticketRepo as never,
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
    const app = Fastify();
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

  it('rejects a tampered manifest signature', () => {
    const manifest = buildOfflineManifest({
      eventId: 'evt_1',
      checkInListId: 'cil_1',
      rows: [],
    });
    const tampered = { ...manifest, eventId: 'evt_tampered' };
    expect(verifyOfflineManifestSignature(tampered)).toBe(false);
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

describe('offline sync endpoint', () => {
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
        async execute() {
          return [];
        },
      };
      return updateChain;
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
