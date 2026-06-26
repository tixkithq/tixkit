import { describe, it, expect, vi } from 'vitest';
import { hashRequest, withIdempotency } from '../services/idempotency.js';
import { IdempotencyConflictError } from '@gatekit/domain';

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
      buyer: { email: 'buyer@test.com', firstName: 'Ada', lastName: 'Lovelace', phone: '+15555550123' },
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
    expect(hashRequest({
      ...base,
      items: [{ ticketTypeId: 'tt_1', quantity: 1, attendeeFields: [{ q_attendee: 'Grace' }] }],
    })).not.toBe(baseHash);
  });

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
function createMockDb(existingRecords: Record<string, unknown>[] = [], insertShouldFail = false) {
  const records = [...existingRecords];

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
                      const found = records.find(
                        (r) => r.key === val && r.tenant_id === val2,
                      );
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
              if (insertShouldFail) {
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

    const result = await withIdempotency(db, {
      key: 'idem-key-1',
      tenantId: 'tnt_1',
      requestHash: hashRequest({ cart: { items: [] } }),
    }, handler);

    expect(result.status).toBe(201);
    expect(result.body).toEqual({ id: 'ord_1' });
    expect(handler).toHaveBeenCalledOnce();
    expect(records[0]?.status).toBe('completed');
    expect(records[0]?.response_status).toBe(201);
  });

  it('replays the stored response on second use with same payload', async () => {
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
      },
    ]);

    const handler = vi.fn(async () => ({ status: 201, body: { ok: false } }));

    const result = await withIdempotency(db, {
      key: 'idem-key-2',
      tenantId: 'tnt_1',
      requestHash: reqHash,
    }, handler);

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true });
    expect(handler).not.toHaveBeenCalled();
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
      withIdempotency(db, {
        key: 'idem-key-3',
        tenantId: 'tnt_1',
        requestHash: hashRequest({ cart: { items: ['b'] } }),
      }, handler),
    ).rejects.toThrow(IdempotencyConflictError);

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

    const result = await withIdempotency(db, {
      key: 'idem-race',
      tenantId: 'tnt_1',
      requestHash: reqHash,
    }, handler);

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
      withIdempotency(db, {
        key: 'idem-race-2',
        tenantId: 'tnt_1',
        requestHash: hashRequest({ foo: 'bar' }),
      }, handler),
    ).rejects.toThrow(IdempotencyConflictError);
  });

	  it('persists handler failures as completed idempotent error responses', async () => {
    const { db, records } = createMockDb();
    const handler = vi.fn(async () => {
      const error = new Error('Refund already processed') as Error & { statusCode: number; code: string };
      error.statusCode = 409;
      error.code = 'REFUND_CONFLICT';
      throw error;
    });

    await expect(
      withIdempotency(db, {
        key: 'idem-failure',
        tenantId: 'tnt_1',
        requestHash: hashRequest({ refund: true }),
      }, handler),
    ).rejects.toThrow('Refund already processed');

    expect(records[0]?.status).toBe('completed');
    expect(records[0]?.response_status).toBe(409);
	    expect(JSON.parse(records[0]?.response_body as string)).toEqual({
      error: {
        code: 'REFUND_CONFLICT',
        message: 'Refund already processed',
      },
	    });
	  });

	  it('does not persist transient 5xx handler failures', async () => {
	    const { db, records } = createMockDb();
	    const handler = vi.fn(async () => {
	      const error = new Error('Payment intent is being created') as Error & { statusCode: number; code: string };
	      error.statusCode = 503;
	      error.code = 'SERVICE_UNAVAILABLE';
	      throw error;
	    });

	    await expect(
	      withIdempotency(db, {
	        key: 'idem-transient-failure',
	        tenantId: 'tnt_1',
	        requestHash: hashRequest({ confirm: true }),
	      }, handler),
	    ).rejects.toThrow('Payment intent is being created');

	    expect(records).toHaveLength(0);
	  });

	  it('does not persist returned 5xx responses', async () => {
	    const { db, records } = createMockDb();
	    const handler = vi.fn(async () => ({
	      status: 503,
	      body: { error: { code: 'SERVICE_UNAVAILABLE', message: 'Payment intent is being created' } },
	    }));

	    const result = await withIdempotency(db, {
	      key: 'idem-returned-5xx',
	      tenantId: 'tnt_1',
	      requestHash: hashRequest({ confirm: true }),
	    }, handler);

	    expect(result.status).toBe(503);
	    expect(records).toHaveLength(0);
	  });
	});
