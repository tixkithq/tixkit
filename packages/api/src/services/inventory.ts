import type { Database } from '@tixkit/db';
import { InventoryExhaustedError, HoldExpiredError, ValidationError } from '@tixkit/domain';
import { ulid } from 'ulid';

export type HoldResult = {
  holdId: string;
  expiresAt: Date;
};

export type CartReservationItem = {
  inventoryPoolId: string;
  ticketTypeId: string;
  quantity: number;
};

export type CartReservationResult = {
  holds: { holdId: string; inventoryPoolId: string; ticketTypeId: string; quantity: number }[];
  primaryHoldId: string;
  expiresAt: Date;
};

export class InventoryService {
  constructor(private db: Database) {}

  /**
   * Atomically reserves inventory for an entire cart, locking each distinct
   * inventory pool exactly once and validating availability per pool using the
   * total quantity drawn from that pool across all ticket types. A hold row is
   * created per ticket type so per-ticket-type usage stays observable. The whole
   * reservation succeeds or fails as one transaction, preventing oversell and
   * partial reservations under concurrency.
   */
  async reserveCart(input: {
    items: CartReservationItem[];
    checkoutSessionId: string;
    holdTtlSeconds?: number;
  }): Promise<CartReservationResult> {
    if (input.items.length === 0) {
      throw new InventoryExhaustedError('cart', 0, 0);
    }

    // Aggregate requested quantity per pool.
    const perPool = new Map<string, number>();
    const itemsByPool = new Map<string, CartReservationItem[]>();
    for (const item of input.items) {
      if (item.quantity <= 0) {
        throw new ValidationError(
          `Reservation quantity must be positive for ticket type ${item.ticketTypeId}`,
        );
      }
      perPool.set(item.inventoryPoolId, (perPool.get(item.inventoryPoolId) ?? 0) + item.quantity);
      const poolItems = itemsByPool.get(item.inventoryPoolId) ?? [];
      poolItems.push(item);
      itemsByPool.set(item.inventoryPoolId, poolItems);
    }

    return this.db.transaction().execute(async (trx) => {
      const now = new Date();
      const holds: CartReservationResult['holds'] = [];
      let earliestExpiry: Date | null = null;

      // Lock pools in a deterministic order to avoid deadlocks.
      // eslint-disable-next-line unicorn/no-array-sort -- sorting a fresh array gives deterministic lock order without mutating shared input.
      const poolIds = [...perPool.keys()].sort();

      for (const poolId of poolIds) {
        // eslint-disable-next-line no-await-in-loop -- inventory pools must be locked sequentially in sorted order to avoid deadlocks.
        const pool = await trx
          .selectFrom('inventory_pools')
          .selectAll()
          .where('id', '=', poolId)
          .forUpdate()
          .executeTakeFirstOrThrow();

        // Lazy cleanup of expired holds for this pool.
        // eslint-disable-next-line no-await-in-loop -- each locked pool is cleaned before its availability is recalculated.
        await trx
          .updateTable('checkout_holds')
          .set({ status: 'expired', updated_at: now })
          .where('inventory_pool_id', '=', poolId)
          .where('status', '=', 'active')
          .where('expires_at', '<', now)
          .execute();

        // eslint-disable-next-line no-await-in-loop -- availability must be read after cleanup while this pool remains locked.
        const activeHolds = await trx
          .selectFrom('checkout_holds')
          .select(trx.fn.sum('quantity').as('total_held'))
          .where('inventory_pool_id', '=', poolId)
          .where('status', '=', 'active')
          .executeTakeFirst();

        const held = Number(activeHolds?.total_held ?? 0);
        const requested = perPool.get(poolId)!;
        const available = pool.total_capacity - pool.sold_count - held;

        if (available < requested) {
          throw new InventoryExhaustedError(poolId, requested, available);
        }

        const ttl = input.holdTtlSeconds ?? pool.hold_ttl_seconds;
        const expiresAt = new Date(now.getTime() + ttl * 1000);
        if (!earliestExpiry || expiresAt < earliestExpiry) earliestExpiry = expiresAt;

        for (const item of itemsByPool.get(poolId) ?? []) {
          const holdId = `hld_${ulid()}`;
          // eslint-disable-next-line no-await-in-loop -- hold rows are inserted sequentially under the pool lock so partial failure rolls back the transaction.
          await trx
            .insertInto('checkout_holds')
            .values({
              id: holdId,
              inventory_pool_id: poolId,
              checkout_session_id: input.checkoutSessionId,
              ticket_type_id: item.ticketTypeId,
              quantity: item.quantity,
              expires_at: expiresAt,
              status: 'active',
              created_at: now,
              updated_at: now,
            })
            .execute();
          holds.push({
            holdId,
            inventoryPoolId: poolId,
            ticketTypeId: item.ticketTypeId,
            quantity: item.quantity,
          });
        }
      }

      return {
        holds,
        primaryHoldId: holds[0].holdId,
        expiresAt: earliestExpiry!,
      };
    });
  }

  /**
   * Converts every active hold for a checkout session into sold inventory,
   * incrementing each affected pool's sold_count. Idempotent: already-converted
   * holds are skipped. Expired holds are terminal even when a background
   * expiration worker has already marked them expired.
   */
  async convertHoldsForSession(checkoutSessionId: string): Promise<void> {
    const expiredHoldId = await this.db.transaction().execute(async (trx) => {
      const now = new Date();
      const candidateHolds = await trx
        .selectFrom('checkout_holds')
        .select(['id', 'inventory_pool_id'])
        .where('checkout_session_id', '=', checkoutSessionId)
        .execute();

      // Match reserveCart lock ordering: inventory pools first, sorted, then
      // checkout holds. This avoids MySQL deadlocks during reserve/finalize races.
      const poolIds = [
        ...new Set(candidateHolds.map((hold) => hold.inventory_pool_id as string)),
      ];
      // oxlint-disable-next-line unicorn/no-array-sort -- sorts a fresh array for deterministic lock order under ES2022.
      poolIds.sort();
      for (const poolId of poolIds) {
        // eslint-disable-next-line no-await-in-loop -- deterministic sequential pool locking prevents deadlocks across dialects.
        await trx
          .selectFrom('inventory_pools')
          .select('id')
          .where('id', '=', poolId)
          .forUpdate()
          .executeTakeFirstOrThrow();
      }

      const holds = await trx
        .selectFrom('checkout_holds')
        .selectAll()
        .where('checkout_session_id', '=', checkoutSessionId)
        .forUpdate()
        .execute();

      const expiredHold = holds.find(
        (hold) =>
          hold.status === 'expired' ||
          (hold.status === 'active' && new Date(hold.expires_at) <= now),
      );
      if (expiredHold) {
        await trx
          .updateTable('checkout_holds')
          .set({ status: 'expired', updated_at: now })
          .where('checkout_session_id', '=', checkoutSessionId)
          .where('status', '=', 'active')
          .where('expires_at', '<', now)
          .execute();
        return expiredHold.id as string;
      }

      for (const hold of holds.filter((candidate) => candidate.status === 'active')) {
        // eslint-disable-next-line no-await-in-loop -- hold conversion must update each hold before incrementing its matching pool count.
        await trx
          .updateTable('checkout_holds')
          .set({ status: 'converted', updated_at: now })
          .where('id', '=', hold.id)
          .execute();
        // eslint-disable-next-line no-await-in-loop -- inventory increments are paired with the just-converted hold inside the same transaction.
        await trx
          .updateTable('inventory_pools')
          .set((eb) => ({ sold_count: eb('sold_count', '+', hold.quantity), updated_at: now }))
          .where('id', '=', hold.inventory_pool_id)
          .execute();
      }
      return null;
    });

    if (expiredHoldId) {
      throw new HoldExpiredError(expiredHoldId);
    }
  }

  /**
   * Releases every active hold for a checkout session back to available
   * inventory.
   */
  async releaseHoldsForSession(checkoutSessionId: string): Promise<void> {
    await this.db
      .updateTable('checkout_holds')
      .set({ status: 'released', updated_at: new Date() })
      .where('checkout_session_id', '=', checkoutSessionId)
      .where('status', '=', 'active')
      .execute();
  }

  /**
   * Atomically reserves inventory in a transaction with row-level locking.
   * Prevents oversells under concurrent checkout attempts.
   */
  async reserveInventory(input: {
    inventoryPoolId: string;
    ticketTypeId: string;
    quantity: number;
    checkoutSessionId: string;
    holdTtlSeconds?: number;
  }): Promise<HoldResult> {
    if (input.quantity <= 0) {
      throw new ValidationError(
        `Reservation quantity must be positive for ticket type ${input.ticketTypeId}`,
      );
    }

    return this.db.transaction().execute(async (trx) => {
      const now = new Date();
      // Lock the inventory pool row for update
      const pool = await trx
        .selectFrom('inventory_pools')
        .selectAll()
        .where('id', '=', input.inventoryPoolId)
        .forUpdate()
        .executeTakeFirstOrThrow();

      // Release expired holds first (lazy cleanup)
      await trx
        .updateTable('checkout_holds')
        .set({ status: 'expired', updated_at: now })
        .where('inventory_pool_id', '=', input.inventoryPoolId)
        .where('status', '=', 'active')
        .where('expires_at', '<', now)
        .execute();

      // Recalculate available after cleanup
      const activeHolds = await trx
        .selectFrom('checkout_holds')
        .select(trx.fn.sum('quantity').as('total_held'))
        .where('inventory_pool_id', '=', input.inventoryPoolId)
        .where('status', '=', 'active')
        .executeTakeFirst();

      const heldQty = Number(activeHolds?.total_held ?? 0);
      const available = pool.total_capacity - pool.sold_count - heldQty;

      if (available < input.quantity) {
        throw new InventoryExhaustedError(input.ticketTypeId, input.quantity, available);
      }

      // Create hold
      const ttl = input.holdTtlSeconds ?? pool.hold_ttl_seconds;
      const expiresAt = new Date(now.getTime() + ttl * 1000);
      const holdId = `hld_${ulid()}`;

      await trx
        .insertInto('checkout_holds')
        .values({
          id: holdId,
          inventory_pool_id: input.inventoryPoolId,
          checkout_session_id: input.checkoutSessionId,
          ticket_type_id: input.ticketTypeId,
          quantity: input.quantity,
          expires_at: expiresAt,
          status: 'active',
          created_at: now,
          updated_at: now,
        })
        .execute();

      return { holdId, expiresAt };
    });
  }

  /**
   * Converts a hold into sold inventory. Called when payment is confirmed.
   */
  async convertHold(holdId: string): Promise<void> {
    const expiredHoldId = await this.db.transaction().execute(async (trx) => {
      const now = new Date();
      const candidateHold = await trx
        .selectFrom('checkout_holds')
        .select(['id', 'inventory_pool_id'])
        .where('id', '=', holdId)
        .executeTakeFirstOrThrow();

      await trx
        .selectFrom('inventory_pools')
        .select('id')
        .where('id', '=', candidateHold.inventory_pool_id)
        .forUpdate()
        .executeTakeFirstOrThrow();

      const hold = await trx
        .selectFrom('checkout_holds')
        .selectAll()
        .where('id', '=', holdId)
        .forUpdate()
        .executeTakeFirstOrThrow();

      if (hold.status === 'expired') {
        return holdId;
      }

      if (hold.status === 'converted') {
        return null; // Idempotent
      }

      if (hold.status !== 'active' || new Date(hold.expires_at) <= now) {
        if (hold.status === 'active') {
          await trx
            .updateTable('checkout_holds')
            .set({ status: 'expired', updated_at: now })
            .where('id', '=', holdId)
            .where('status', '=', 'active')
            .execute();
        }
        return holdId;
      }

      await trx
        .updateTable('checkout_holds')
        .set({ status: 'converted', updated_at: now })
        .where('id', '=', holdId)
        .execute();

      // Increment sold count on the pool
      await trx
        .updateTable('inventory_pools')
        .set((eb) => ({
          sold_count: eb('sold_count', '+', hold.quantity),
          updated_at: now,
        }))
        .where('id', '=', hold.inventory_pool_id)
        .execute();
      return null;
    });

    if (expiredHoldId) {
      throw new HoldExpiredError(expiredHoldId);
    }
  }

  /**
   * Releases a hold back to available inventory.
   */
  async releaseHold(holdId: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const hold = await trx
        .selectFrom('checkout_holds')
        .selectAll()
        .where('id', '=', holdId)
        .forUpdate()
        .executeTakeFirst();

      if (!hold || hold.status !== 'active') return;

      await trx
        .updateTable('checkout_holds')
        .set({ status: 'released', updated_at: new Date() })
        .where('id', '=', holdId)
        .execute();
    });
  }

  /**
   * Restores inventory after a refund (if configured).
   */
  async restoreInventory(holdId: string, quantity: number): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const candidateHold = await trx
        .selectFrom('checkout_holds')
        .select(['id', 'inventory_pool_id'])
        .where('id', '=', holdId)
        .executeTakeFirst();

      if (!candidateHold) return;

      await trx
        .selectFrom('inventory_pools')
        .select('id')
        .where('id', '=', candidateHold.inventory_pool_id)
        .forUpdate()
        .executeTakeFirstOrThrow();

      const hold = await trx
        .selectFrom('checkout_holds')
        .selectAll()
        .where('id', '=', holdId)
        .forUpdate()
        .executeTakeFirst();

      if (!hold) return;

      await trx
        .updateTable('inventory_pools')
        .set((eb) => ({
          sold_count: eb('sold_count', '-', quantity),
          updated_at: new Date(),
        }))
        .where('id', '=', hold.inventory_pool_id)
        .execute();
    });
  }

  /**
   * Expires all stale holds. Called by the HoldExpirationWorkflow.
   */
  async expireStaleHolds(): Promise<number> {
    const now = new Date();
    const stale = await this.db
      .selectFrom('checkout_holds')
      .select('id')
      .where('status', '=', 'active')
      .where('expires_at', '<', now)
      .execute();

    if (stale.length === 0) return 0;

    await this.db
      .updateTable('checkout_holds')
      .set({ status: 'expired', updated_at: now })
      .where('status', '=', 'active')
      .where('expires_at', '<', now)
      .execute();

    return stale.length;
  }

  /**
   * Gets current availability for a pool.
   */
  async getAvailability(inventoryPoolId: string): Promise<{
    total: number;
    sold: number;
    reserved: number;
    available: number;
  }> {
    return this.db.transaction().execute(async (trx) => {
      const pool = await trx
        .selectFrom('inventory_pools')
        .selectAll()
        .where('id', '=', inventoryPoolId)
        .executeTakeFirst();

      if (!pool) return { total: 0, sold: 0, reserved: 0, available: 0 };

      const now = new Date();
      await trx
        .updateTable('checkout_holds')
        .set({ status: 'expired', updated_at: now })
        .where('inventory_pool_id', '=', inventoryPoolId)
        .where('status', '=', 'active')
        .where('expires_at', '<', now)
        .execute();

      const activeHolds = await trx
        .selectFrom('checkout_holds')
        .select(trx.fn.sum('quantity').as('total_held'))
        .where('inventory_pool_id', '=', inventoryPoolId)
        .where('status', '=', 'active')
        .executeTakeFirst();

      const reserved = Number(activeHolds?.total_held ?? 0);
      const available = pool.total_capacity - pool.sold_count - reserved;

      return {
        total: pool.total_capacity,
        sold: pool.sold_count,
        reserved,
        available,
      };
    });
  }
}
