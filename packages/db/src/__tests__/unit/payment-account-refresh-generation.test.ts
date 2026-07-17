import { describe, expect, it, vi } from 'vitest';
import { PaymentAccountRepository } from '../../repositories/tenant.js';

function queryResult(row: Record<string, unknown> | undefined) {
  const whereCalls: unknown[][] = [];
  const query = {
    select: vi.fn(() => query),
    selectAll: vi.fn(() => query),
    where: vi.fn((...args: unknown[]) => {
      whereCalls.push(args);
      return query;
    }),
    forUpdate: vi.fn(() => query),
    executeTakeFirst: vi.fn(async () => row),
  };
  return { query, whereCalls };
}

function reservationDb(input: { maintenance: number; account?: Record<string, unknown> }) {
  const control = queryResult({ id: 'singleton', maintenance: input.maintenance });
  const account = queryResult(input.account);
  const updateWhereCalls: unknown[][] = [];
  const update = {
    where: vi.fn((...args: unknown[]) => {
      updateWhereCalls.push(args);
      return update;
    }),
    executeTakeFirst: vi.fn(async () => ({ numUpdatedRows: 1n })),
  };
  const set = vi.fn(() => update);
  const trx = {
    selectFrom: vi.fn().mockReturnValueOnce(control.query).mockReturnValueOnce(account.query),
    updateTable: vi.fn(() => ({ set })),
  };
  const db = {
    transaction: vi.fn(() => ({
      execute: vi.fn(async (callback: (transaction: unknown) => Promise<unknown>) => callback(trx)),
    })),
  };
  return { account, control, db, set, trx, updateWhereCalls };
}

describe('PaymentAccountRepository refresh generation fencing', () => {
  it('fails closed on the maintenance fence before touching the payment account', async () => {
    const fixture = reservationDb({ maintenance: 1 });
    const repository = new PaymentAccountRepository(fixture.db as never);

    await expect(
      repository.reserveRefreshGeneration({
        id: 'pa_1',
        tenantId: 'tnt_1',
        organizationId: 'org_1',
        provider: 'stripe_connect',
      }),
    ).rejects.toThrow('Payment account refreshes are paused for maintenance');

    expect(fixture.trx.selectFrom).toHaveBeenCalledTimes(1);
    expect(fixture.set).not.toHaveBeenCalled();
  });

  it('locks the maintenance row before atomically reserving the next generation', async () => {
    const fixture = reservationDb({
      maintenance: 0,
      account: {
        id: 'pa_1',
        tenant_id: 'tnt_1',
        organization_id: 'org_1',
        provider: 'stripe_connect',
        refresh_generation: 4,
      },
    });
    const repository = new PaymentAccountRepository(fixture.db as never);

    const reserved = await repository.reserveRefreshGeneration({
      id: 'pa_1',
      tenantId: 'tnt_1',
      organizationId: 'org_1',
      provider: 'stripe_connect',
    });

    expect(reserved).toMatchObject({ id: 'pa_1', refresh_generation: 5 });
    expect(fixture.trx.selectFrom.mock.calls.map(([table]) => table)).toEqual([
      'payment_account_refresh_control',
      'payment_accounts',
    ]);
    expect(fixture.control.query.forUpdate).toHaveBeenCalledTimes(1);
    expect(fixture.account.query.forUpdate).toHaveBeenCalledTimes(1);
    expect(fixture.set).toHaveBeenCalledWith({ refresh_generation: 5 });
    expect(fixture.updateWhereCalls).toContainEqual(['refresh_generation', '=', 4]);
  });
});
