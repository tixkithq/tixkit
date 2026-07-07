import { describe, it, expect, vi } from 'vitest';
import { hashRequest, withIdempotency } from '../services/idempotency.js';
import { IdempotencyConflictError, IdempotencyInProgressError } from '@tixkit/domain';

type IdempotencyPayloadScenario = {
  surface: string;
  base: unknown;
  reordered: unknown;
  changed: unknown;
};

describe('hashRequest', () => {
  it('produces a deterministic hash for the same payload', () => {
    const h1 = hashRequest({ foo: 'bar' });
    const h2 = hashRequest({ foo: 'bar' });
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64);
  });

  it('produces different hashes for different payloads', () => {
    const h1 = hashRequest({ foo: 'bar' });
    const h2 = hashRequest({ foo: 'baz' });
    expect(h1).not.toBe(h2);
  });

  it('does not depend on object key insertion order', () => {
    const h1 = hashRequest({
      eventId: 'evt_1',
      buyer: { email: 'buyer@test.com', firstName: 'Ada' },
      items: [{ ticketTypeId: 'tt_1', quantity: 1 }],
    });
    const h2 = hashRequest({
      items: [{ quantity: 1, ticketTypeId: 'tt_1' }],
      buyer: { firstName: 'Ada', email: 'buyer@test.com' },
      eventId: 'evt_1',
    });
    expect(h1).toBe(h2);
  });

  it('changes when material checkout create-session fields change', () => {
    const base = {
      eventId: 'evt_1',
      items: [
        {
          ticketTypeId: 'tt_1',
          quantity: 1,
          attendeeFields: [{ q_attendee: 'Ada' }],
        },
      ],
      buyer: {
        email: 'buyer@test.com',
        firstName: 'Ada',
        lastName: 'Lovelace',
        phone: '+15555550123',
      },
      buyerFields: { q_buyer: 'yes' },
      discountCode: 'SAVE25',
      accessCode: 'VIP',
      affiliateCode: 'AFF1',
      successUrl: 'https://example.com/success',
      cancelUrl: 'https://example.com/cancel',
    };

    const baseHash = hashRequest(base);
    expect(hashRequest({ ...base, discountCode: 'SAVE50' })).not.toBe(baseHash);
    expect(hashRequest({ ...base, accessCode: 'STAFF' })).not.toBe(baseHash);
    expect(hashRequest({ ...base, affiliateCode: 'AFF2' })).not.toBe(baseHash);
    expect(hashRequest({ ...base, buyerFields: { q_buyer: 'no' } })).not.toBe(baseHash);
    expect(hashRequest({ ...base, successUrl: 'https://example.com/thanks' })).not.toBe(baseHash);
    expect(
      hashRequest({
        ...base,
        items: [{ ticketTypeId: 'tt_1', quantity: 1, attendeeFields: [{ q_attendee: 'Grace' }] }],
      }),
    ).not.toBe(baseHash);
  });

  const payloadScenarios: IdempotencyPayloadScenario[] = [
    {
      surface: 'checkout session creation',
      base: {
        eventId: 'evt_1',
        items: [
          {
            ticketTypeId: 'tt_vip',
            quantity: 2,
            attendeeFields: [{ name: 'Ada Lovelace' }, { name: 'Grace Hopper' }],
          },
        ],
        buyer: { email: 'buyer@example.com', firstName: 'Ada', lastName: 'Lovelace' },
        buyerFields: { company: 'Analytical Engines' },
        discountCode: 'SAVE20',
        accessCode: 'VIP',
      },
      reordered: {
        accessCode: 'VIP',
        discountCode: 'SAVE20',
        buyerFields: { company: 'Analytical Engines' },
        buyer: { lastName: 'Lovelace', firstName: 'Ada', email: 'buyer@example.com' },
        items: [
          {
            quantity: 2,
            attendeeFields: [{ name: 'Ada Lovelace' }, { name: 'Grace Hopper' }],
            ticketTypeId: 'tt_vip',
          },
        ],
        eventId: 'evt_1',
      },
      changed: {
        eventId: 'evt_1',
        items: [{ ticketTypeId: 'tt_vip', quantity: 1 }],
        buyer: { email: 'buyer@example.com', firstName: 'Ada', lastName: 'Lovelace' },
        buyerFields: { company: 'Analytical Engines' },
        discountCode: 'SAVE20',
        accessCode: 'VIP',
      },
    },
    {
      surface: 'checkout confirmation',
      base: { paymentMethodId: 'pm_1', expectedTotalCents: 12500, acceptedTerms: true },
      reordered: { acceptedTerms: true, expectedTotalCents: 12500, paymentMethodId: 'pm_1' },
      changed: { paymentMethodId: 'pm_2', expectedTotalCents: 12500, acceptedTerms: true },
    },
    {
      surface: 'order refund',
      base: {
        amountCents: 4200,
        reason: 'requested_by_customer',
        ticketIds: ['tic_1', 'tic_2'],
        notifyBuyer: true,
      },
      reordered: {
        notifyBuyer: true,
        ticketIds: ['tic_1', 'tic_2'],
        reason: 'requested_by_customer',
        amountCents: 4200,
      },
      changed: {
        amountCents: 4100,
        reason: 'requested_by_customer',
        ticketIds: ['tic_1', 'tic_2'],
        notifyBuyer: true,
      },
    },
    {
      surface: 'message campaign',
      base: {
        channel: 'email',
        subject: 'Tonight starts soon',
        body: '<p>Hello {{buyer.firstName}}</p>',
        segmentId: 'seg_vip',
        scheduledAt: '2026-07-07T19:00:00.000Z',
      },
      reordered: {
        scheduledAt: '2026-07-07T19:00:00.000Z',
        segmentId: 'seg_vip',
        body: '<p>Hello {{buyer.firstName}}</p>',
        subject: 'Tonight starts soon',
        channel: 'email',
      },
      changed: {
        channel: 'sms',
        body: 'Hello {{buyer.firstName}}',
        segmentId: 'seg_vip',
        scheduledAt: '2026-07-07T19:00:00.000Z',
      },
    },
    {
      surface: 'ticket transfer',
      base: { recipientEmail: 'new@example.com', recipientName: 'New Owner' },
      reordered: { recipientName: 'New Owner', recipientEmail: 'new@example.com' },
      changed: { recipientEmail: 'other@example.com', recipientName: 'New Owner' },
    },
    {
      surface: 'offline scan sync',
      base: {
        deviceId: 'dev_1',
        scans: [
          { ticketId: 'tic_1', scannedAt: '2026-07-07T18:00:00.000Z', result: 'accepted' },
          { ticketId: 'tic_2', scannedAt: '2026-07-07T18:00:02.000Z', result: 'duplicate' },
        ],
      },
      reordered: {
        scans: [
          { result: 'accepted', scannedAt: '2026-07-07T18:00:00.000Z', ticketId: 'tic_1' },
          { result: 'duplicate', scannedAt: '2026-07-07T18:00:02.000Z', ticketId: 'tic_2' },
        ],
        deviceId: 'dev_1',
      },
      changed: {
        deviceId: 'dev_1',
        scans: [{ ticketId: 'tic_1', scannedAt: '2026-07-07T18:00:00.000Z', result: 'rejected' }],
      },
    },
    {
      surface: 'report export',
      base: {
        format: 'csv',
        range: { from: '2026-07-01', to: '2026-07-07' },
        filters: { channel: 'online', status: 'paid' },
      },
      reordered: {
        filters: { status: 'paid', channel: 'online' },
        range: { to: '2026-07-07', from: '2026-07-01' },
        format: 'csv',
      },
      changed: {
        format: 'csv',
        range: { from: '2026-07-01', to: '2026-07-08' },
        filters: { channel: 'online', status: 'paid' },
      },
    },
    {
      surface: 'resale listing',
      base: { priceCents: 3800, expiresAt: '2026-07-14T18:00:00.000Z' },
      reordered: { expiresAt: '2026-07-14T18:00:00.000Z', priceCents: 3800 },
      changed: { priceCents: 3900, expiresAt: '2026-07-14T18:00:00.000Z' },
    },
  ];

  it.each(payloadScenarios)(
    'keeps $surface idempotency hashes stable for equivalent payloads and distinct for changed payloads',
    ({ base, reordered, changed }) => {
      const baseHash = hashRequest(base);

      expect(hashRequest(reordered)).toBe(baseHash);
      expect(hashRequest(changed)).not.toBe(baseHash);
      expect(baseHash).toMatch(/^[a-f0-9]{64}$/);
    },
  );

  it('handles null and undefined payloads', () => {
    const h1 = hashRequest(null);
    const h2 = hashRequest(undefined);
    expect(h1).toBe(h2); // both serialize to null
  });

  it('handles primitive payloads', () => {
    const h = hashRequest(42);
    expect(h).toHaveLength(64);
  });
});

/**
 * Minimal mock database that simulates the idempotency_records table.
 * Supports the exact query chain used by withIdempotency:
 *   db.selectFrom('idempotency_records').selectAll().where(...).where(...).executeTakeFirst()
 *   db.insertInto('idempotency_records').values(...).execute()
 *   db.updateTable('idempotency_records').set(...).where(...).execute()
 */
type InsertFailureOptions =
  | boolean
  | {
      failCount: number;
      beforeFail?: (records: Record<string, unknown>[]) => void;
    };

function createMockDb(
  existingRecords: Record<string, unknown>[] = [],
  insertFailure: InsertFailureOptions = false,
  updateFailure: InsertFailureOptions = false,
) {
  const records = [...existingRecords];
  let remainingInsertFailures =
    typeof insertFailure === 'boolean'
      ? insertFailure
        ? Number.POSITIVE_INFINITY
        : 0
      : insertFailure.failCount;
  const beforeInsertFailure =
    typeof insertFailure === 'boolean' ? undefined : insertFailure.beforeFail;
  let remainingUpdateFailures =
    typeof updateFailure === 'boolean'
      ? updateFailure
        ? Number.POSITIVE_INFINITY
        : 0
      : updateFailure.failCount;
  const beforeUpdateFailure =
    typeof updateFailure === 'boolean' ? undefined : updateFailure.beforeFail;

  const chainable = {
    selectFrom(_table: string) {
      return {
        selectAll() {
          return {
            where(_col: string, _op: string, val: unknown) {
              return {
                where(_col2: string, _op2: string, val2: unknown) {
                  return {
                    executeTakeFirst() {
                      const found = records.find((r) => r.key === val && r.tenant_id === val2);
                      return Promise.resolve(found);
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
    insertInto(_table: string) {
      return {
        values(vals: Record<string, unknown>) {
          return {
            execute() {
              if (remainingInsertFailures > 0) {
                remainingInsertFailures -= 1;
                beforeInsertFailure?.(records);
                return Promise.reject(new Error('unique constraint violation'));
              }
              records.push(vals);
              return Promise.resolve();
            },
          };
        },
      };
    },
    updateTable(_table: string) {
      return {
        set(vals: Record<string, unknown>) {
          return {
            where(_col: string, _op: string, val: unknown) {
              return {
                execute() {
                  if (remainingUpdateFailures > 0) {
                    remainingUpdateFailures -= 1;
                    beforeUpdateFailure?.(records);
                    return Promise.reject(new Error('temporary completion write failure'));
                  }
                  const found = records.find((r) => r.id === val);
                  if (found) {
                    Object.assign(found, vals);
                  }
                  return Promise.resolve();
                },
              };
            },
          };
        },
      };
    },
    deleteFrom(_table: string) {
      return {
        where(_col: string, _op: string, val: unknown) {
          return {
            execute() {
              const index = records.findIndex((r) => r.id === val);
              if (index >= 0) records.splice(index, 1);
              return Promise.resolve();
            },
          };
        },
      };
    },
  };

  return { db: chainable as unknown as any, records };
}

describe('withIdempotency', () => {
  it('runs the handler on first use and persists the response', async () => {
    const { db, records } = createMockDb();
    const handler = vi.fn(async () => ({ status: 201, body: { id: 'ord_1' } }));

    const result = await withIdempotency(
      db,
      {
        key: 'idem-key-1',
        tenantId: 'tnt_1',
        requestHash: hashRequest({ cart: { items: [] } }),
      },
      handler,
    );

    expect(result.status).toBe(201);
    expect(result.body).toEqual({ id: 'ord_1' });
    expect(handler).toHaveBeenCalledOnce();
    expect(records[0]?.status).toBe('completed');
    expect(records[0]?.response_status).toBe(201);
  });

  it('retries completed response persistence after a transient update failure', async () => {
    const requestHash = hashRequest({ export: 'sales' });
    const { db, records } = createMockDb([], false, { failCount: 1 });
    const handler = vi.fn(async () => ({ status: 202, body: { exportId: 'exp_1' } }));

    const result = await withIdempotency(
      db,
      {
        key: 'idem-completion-retry',
        tenantId: 'tnt_1',
        requestHash,
      },
      handler,
    );

    expect(result).toEqual({ status: 202, body: { exportId: 'exp_1' } });
    expect(handler).toHaveBeenCalledOnce();
    expect(records[0]).toMatchObject({
      key: 'idem-completion-retry',
      status: 'completed',
      response_status: 202,
      response_body: JSON.stringify({ exportId: 'exp_1' }),
    });

    const replayHandler = vi.fn(async () => ({ status: 202, body: { exportId: 'duplicate' } }));
    const replayed = await withIdempotency(
      db,
      {
        key: 'idem-completion-retry',
        tenantId: 'tnt_1',
        requestHash,
      },
      replayHandler,
    );

    expect(replayed).toEqual({ status: 202, body: { exportId: 'exp_1' } });
    expect(replayHandler).not.toHaveBeenCalled();
  });

  it('replays the non-expired stored response on second use with same payload', async () => {
    const reqHash = hashRequest({ cart: { items: [] } });
    const { db } = createMockDb([
      {
        id: 'idm_1',
        key: 'idem-key-2',
        tenant_id: 'tnt_1',
        request_hash: reqHash,
        response_status: 200,
        response_body: JSON.stringify({ ok: true }),
        status: 'completed',
        expires_at: new Date(Date.now() + 60_000),
      },
    ]);

    const handler = vi.fn(async () => ({ status: 201, body: { ok: false } }));

    const result = await withIdempotency(
      db,
      {
        key: 'idem-key-2',
        tenantId: 'tnt_1',
        requestHash: reqHash,
      },
      handler,
    );

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true });
    expect(handler).not.toHaveBeenCalled();
  });

  it('replays an expired completed record instead of rerunning the handler', async () => {
    const reqHash = hashRequest({ cart: { items: ['fresh'] } });
    const { db, records } = createMockDb([
      {
        id: 'idm_expired_completed',
        key: 'idem-expired-completed',
        tenant_id: 'tnt_1',
        request_hash: reqHash,
        response_status: 200,
        response_body: JSON.stringify({ id: 'stale' }),
        status: 'completed',
        expires_at: new Date(Date.now() - 1_000),
      },
    ]);

    const handler = vi.fn(async () => ({ status: 201, body: { id: 'fresh' } }));

    const result = await withIdempotency(
      db,
      {
        key: 'idem-expired-completed',
        tenantId: 'tnt_1',
        requestHash: reqHash,
      },
      handler,
    );

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ id: 'stale' });
    expect(handler).not.toHaveBeenCalled();
    expect(records).toHaveLength(1);
    expect(records[0]?.id).toBe('idm_expired_completed');
    expect(records[0]?.status).toBe('completed');
    expect(records[0]?.response_status).toBe(200);
    expect(JSON.parse(records[0]?.response_body as string)).toEqual({ id: 'stale' });
  });

  it('throws conflict for changed payloads even when the completed record is expired', async () => {
    const { db, records } = createMockDb([
      {
        id: 'idm_expired_completed_changed',
        key: 'idem-expired-completed-changed',
        tenant_id: 'tnt_1',
        request_hash: hashRequest({ cart: { items: ['original'] } }),
        response_status: 201,
        response_body: JSON.stringify({ id: 'original-session' }),
        status: 'completed',
        expires_at: new Date(Date.now() - 1_000),
      },
    ]);

    const handler = vi.fn(async () => ({ status: 201, body: { id: 'changed-session' } }));

    await expect(
      withIdempotency(
        db,
        {
          key: 'idem-expired-completed-changed',
          tenantId: 'tnt_1',
          requestHash: hashRequest({ cart: { items: ['changed'] } }),
        },
        handler,
      ),
    ).rejects.toThrow(IdempotencyConflictError);

    expect(handler).not.toHaveBeenCalled();
    expect(records).toHaveLength(1);
    expect(records[0]?.id).toBe('idm_expired_completed_changed');
  });

  it('does not treat an expired in-progress record as stuck and persists a new response', async () => {
    const reqHash = hashRequest({ cart: { items: ['retry'] } });
    const { db, records } = createMockDb([
      {
        id: 'idm_expired_in_progress',
        key: 'idem-expired-in-progress',
        tenant_id: 'tnt_1',
        request_hash: reqHash,
        response_status: 0,
        response_body: 'null',
        status: 'in_progress',
        expires_at: new Date(Date.now() - 1_000),
      },
    ]);

    const handler = vi.fn(async () => ({ status: 202, body: { id: 'completed-after-expiry' } }));

    const result = await withIdempotency(
      db,
      {
        key: 'idem-expired-in-progress',
        tenantId: 'tnt_1',
        requestHash: reqHash,
      },
      handler,
    );

    expect(result.status).toBe(202);
    expect(result.body).toEqual({ id: 'completed-after-expiry' });
    expect(handler).toHaveBeenCalledOnce();
    expect(records).toHaveLength(1);
    expect(records[0]?.id).not.toBe('idm_expired_in_progress');
    expect(records[0]?.status).toBe('completed');
    expect(records[0]?.response_status).toBe(202);
  });

  it('throws IdempotencyConflictError when same key is reused with different payload', async () => {
    const { db } = createMockDb([
      {
        id: 'idm_1',
        key: 'idem-key-3',
        tenant_id: 'tnt_1',
        request_hash: hashRequest({ cart: { items: ['a'] } }),
        response_status: 200,
        response_body: '{}',
        status: 'completed',
      },
    ]);

    const handler = vi.fn(async () => ({ status: 201, body: {} }));

    await expect(
      withIdempotency(
        db,
        {
          key: 'idem-key-3',
          tenantId: 'tnt_1',
          requestHash: hashRequest({ cart: { items: ['b'] } }),
        },
        handler,
      ),
    ).rejects.toThrow(IdempotencyConflictError);

    expect(handler).not.toHaveBeenCalled();
  });

  it('throws a retryable in-progress error when the winning request has not completed within the replay window', async () => {
    const requestHash = hashRequest({ operation: 'offline-sync', batch: 'large' });
    const { db } = createMockDb([
      {
        id: 'idm_in_progress',
        key: 'idem-in-progress',
        tenant_id: 'tnt_1',
        request_hash: requestHash,
        response_status: 0,
        response_body: 'null',
        status: 'in_progress',
        expires_at: new Date(Date.now() + 60_000),
      },
    ]);
    const handler = vi.fn(async () => ({ status: 200, body: { ok: true } }));

    await expect(
      withIdempotency(
        db,
        {
          key: 'idem-in-progress',
          tenantId: 'tnt_1',
          requestHash,
          inProgressWaitMs: 0,
        },
        handler,
      ),
    ).rejects.toMatchObject({
      name: 'IdempotencyInProgressError',
      code: 'IDEMPOTENCY_IN_PROGRESS',
      statusCode: 409,
    } satisfies Partial<IdempotencyInProgressError>);

    expect(handler).not.toHaveBeenCalled();
  });

  it('falls back to replaying winner result when insert race is lost', async () => {
    const reqHash = hashRequest({ foo: 'bar' });
    const { db } = createMockDb(
      [
        {
          id: 'idm_winner',
          key: 'idem-race',
          tenant_id: 'tnt_1',
          request_hash: reqHash,
          response_status: 201,
          response_body: JSON.stringify({ id: 'winner' }),
          status: 'completed',
        },
      ],
      true, // insert fails to simulate a concurrent winner
    );

    const handler = vi.fn(async () => ({ status: 201, body: { id: 'loser' } }));

    const result = await withIdempotency(
      db,
      {
        key: 'idem-race',
        tenantId: 'tnt_1',
        requestHash: reqHash,
      },
      handler,
    );

    // Handler runs but insert fails, so we replay the winner's response.
    expect(result.body).toEqual({ id: 'winner' });
    expect(result.status).toBe(201);
    expect(handler).not.toHaveBeenCalled();
  });

  it('throws conflict when insert race winner has different payload', async () => {
    const { db } = createMockDb(
      [
        {
          id: 'idm_winner',
          key: 'idem-race-2',
          tenant_id: 'tnt_1',
          request_hash: hashRequest({ different: true }),
          response_status: 200,
          response_body: '{}',
          status: 'completed',
        },
      ],
      true,
    );

    const handler = vi.fn(async () => ({ status: 201, body: {} }));

    await expect(
      withIdempotency(
        db,
        {
          key: 'idem-race-2',
          tenantId: 'tnt_1',
          requestHash: hashRequest({ foo: 'bar' }),
        },
        handler,
      ),
    ).rejects.toThrow(IdempotencyConflictError);
  });

  it('replays an expired completed insert race winner', async () => {
    const reqHash = hashRequest({ foo: 'bar' });
    const { db, records } = createMockDb([], {
      failCount: 1,
      beforeFail: (currentRecords) => {
        currentRecords.push({
          id: 'idm_expired_winner',
          key: 'idem-expired-race',
          tenant_id: 'tnt_1',
          request_hash: reqHash,
          response_status: 200,
          response_body: JSON.stringify({ id: 'stale-winner' }),
          status: 'completed',
          expires_at: new Date(Date.now() - 1_000),
        });
      },
    });

    const handler = vi.fn(async () => ({ status: 201, body: { id: 'fresh-after-race' } }));

    const result = await withIdempotency(
      db,
      {
        key: 'idem-expired-race',
        tenantId: 'tnt_1',
        requestHash: reqHash,
      },
      handler,
    );

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ id: 'stale-winner' });
    expect(handler).not.toHaveBeenCalled();
    expect(records).toHaveLength(1);
    expect(records[0]?.id).toBe('idm_expired_winner');
    expect(records[0]?.status).toBe('completed');
    expect(records[0]?.response_status).toBe(200);
  });

  it('persists handler failures as completed idempotent error responses', async () => {
    const { db, records } = createMockDb();
    const handler = vi.fn(async () => {
      const error = new Error('Refund already processed') as Error & {
        statusCode: number;
        code: string;
        details: Record<string, unknown>;
        internalReason: string;
      };
      error.statusCode = 409;
      error.code = 'REFUND_CONFLICT';
      error.details = {
        providerError: 'refund_already_exists',
        paymentIntentId: 'pi_internal_123',
      };
      error.internalReason = 'stripe_refund_duplicate';
      throw error;
    });
    const requestHash = hashRequest({ refund: true });

    await expect(
      withIdempotency(
        db,
        {
          key: 'idem-failure',
          tenantId: 'tnt_1',
          requestHash,
        },
        handler,
      ),
    ).rejects.toThrow('Refund already processed');

    expect(records[0]?.status).toBe('completed');
    expect(records[0]?.response_status).toBe(409);
    expect(JSON.parse(records[0]?.response_body as string)).toEqual({
      error: {
        code: 'REFUND_CONFLICT',
        message: 'Refund already processed',
      },
    });
    expect(records[0]?.response_body).not.toContain('providerError');
    expect(records[0]?.response_body).not.toContain('paymentIntentId');
    expect(records[0]?.response_body).not.toContain('internalReason');

    const replayHandler = vi.fn(async () => ({ status: 201, body: { ok: true } }));
    const replayed = await withIdempotency(
      db,
      {
        key: 'idem-failure',
        tenantId: 'tnt_1',
        requestHash,
      },
      replayHandler,
    );

    expect(replayed).toEqual({
      status: 409,
      body: {
        error: {
          code: 'REFUND_CONFLICT',
          message: 'Refund already processed',
        },
      },
    });
    expect(replayHandler).not.toHaveBeenCalled();
  });

  it('does not persist transient 5xx handler failures', async () => {
    const { db, records } = createMockDb();
    const handler = vi.fn(async () => {
      const error = new Error('Payment intent is being created') as Error & {
        statusCode: number;
        code: string;
      };
      error.statusCode = 503;
      error.code = 'SERVICE_UNAVAILABLE';
      throw error;
    });

    await expect(
      withIdempotency(
        db,
        {
          key: 'idem-transient-failure',
          tenantId: 'tnt_1',
          requestHash: hashRequest({ confirm: true }),
        },
        handler,
      ),
    ).rejects.toThrow('Payment intent is being created');

    expect(records).toHaveLength(0);
  });

  it('does not persist returned 5xx responses', async () => {
    const { db, records } = createMockDb();
    const handler = vi.fn(async () => ({
      status: 503,
      body: { error: { code: 'SERVICE_UNAVAILABLE', message: 'Payment intent is being created' } },
    }));

    const result = await withIdempotency(
      db,
      {
        key: 'idem-returned-5xx',
        tenantId: 'tnt_1',
        requestHash: hashRequest({ confirm: true }),
      },
      handler,
    );

    expect(result.status).toBe(503);
    expect(records).toHaveLength(0);
  });
});
