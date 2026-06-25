import { createDb } from '@gatekit/db';
import type { WorkflowActivityResult } from '../shared/types.js';
import { okResult, errResult } from '../shared/types.js';

export async function expireStaleHoldsActivity(): Promise<WorkflowActivityResult<{ expiredCount: number }>> {
  const db = createDb();
  try {
    const result = await db
      .updateTable('checkout_holds')
      .set({ status: 'expired', updated_at: new Date() })
      .where('status', '=', 'active')
      .where('expires_at', '<', new Date())
      .execute();
    return okResult({ expiredCount: Number((result[0] as { numUpdatedRows?: bigint } | undefined)?.numUpdatedRows ?? 0) });
  } catch (err) {
    return errResult('EXPIRE_HOLDS_FAILED', err instanceof Error ? err.message : 'Unknown error', true);
  } finally {
    await db.destroy();
  }
}

export async function expireStaleSessionsActivity(): Promise<WorkflowActivityResult<{ expiredCount: number }>> {
  const db = createDb();
  try {
    const result = await db
      .updateTable('checkout_sessions')
      .set({ status: 'expired', updated_at: new Date() })
      .where('status', '=', 'open')
      .where('expires_at', '<', new Date())
      .execute();
    return okResult({ expiredCount: Number((result[0] as { numUpdatedRows?: bigint } | undefined)?.numUpdatedRows ?? 0) });
  } catch (err) {
    return errResult('EXPIRE_SESSIONS_FAILED', err instanceof Error ? err.message : 'Unknown error', true);
  } finally {
    await db.destroy();
  }
}
