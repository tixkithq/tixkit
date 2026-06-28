import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import type { Database } from '@tixkit/db';
import { IdempotencyConflictError } from '@tixkit/domain';

export type IdempotentResponse = {
  status: number;
  body: unknown;
};

type IdempotencyRecord = {
  id: string;
  key: string;
  tenant_id: string;
  request_hash: string;
  response_status: number;
  response_body: string;
  expires_at?: Date | string | null;
  status?: string;
};

export function hashRequest(payload: unknown): string {
  return createHash('sha256')
    .update(stableStringify(payload ?? null))
    .digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }

  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    // eslint-disable-next-line unicorn/no-array-sort -- Object.keys creates a fresh array and sorting is required for stable idempotency hashes.
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

/**
 * Executes a mutation under an idempotency guard scoped by tenant + key.
 *
 * - Re-using a key with the SAME request payload replays the stored response.
 * - Re-using a key with a DIFFERENT payload raises an IdempotencyConflictError.
 * - First use reserves the key, runs the handler, then persists the response.
 *
 * A unique constraint on (key, tenant_id) makes the reservation race-safe. If a
 * concurrent request wins the reservation, this request waits briefly for the
 * completed response and replays it without running side effects.
 */
export async function withIdempotency(
  db: Database,
  input: {
    key: string;
    tenantId: string;
    requestHash: string;
    ttlSeconds?: number;
  },
  handler: () => Promise<IdempotentResponse>,
): Promise<IdempotentResponse> {
  const replayExisting = async (): Promise<IdempotentResponse | null> => {
    const deadline = Date.now() + 10_000;

    while (Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop -- idempotency replay must poll sequentially until the winning request commits its response.
      const existing = await findRecord(db, input.key, input.tenantId);
      if (!existing) return null;
      if (isExpired(existing)) {
        // eslint-disable-next-line no-await-in-loop -- expired records must be removed before this key can be reserved again.
        await deleteRecord(db, existing.id);
        return null;
      }
      if (existing.request_hash !== input.requestHash) {
        throw new IdempotencyConflictError(input.key);
      }
      if ((existing.status ?? 'completed') === 'completed') {
        return { status: existing.response_status, body: JSON.parse(existing.response_body) };
      }
      // eslint-disable-next-line no-await-in-loop -- backoff is intentionally sequential between replay polling attempts.
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    throw new Error('Idempotent request is still in progress');
  };

  const replayed = await replayExisting();
  if (replayed) return replayed;

  let recordId = `idm_${ulid()}`;
  let reserved = false;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop -- reservation retries must observe the winning idempotency record before trying a new id.
      await db
        .insertInto('idempotency_records')
        .values({
          id: recordId,
          key: input.key,
          tenant_id: input.tenantId,
          request_hash: input.requestHash,
          response_status: 0,
          response_body: 'null',
          status: 'in_progress',
          created_at: new Date(),
          expires_at: new Date(Date.now() + (input.ttlSeconds ?? 86400) * 1000),
        })
        .execute();
      reserved = true;
      break;
    } catch {
      // eslint-disable-next-line no-await-in-loop -- duplicate-key races must replay the committed winner before generating a replacement id.
      const winner = await replayExisting();
      if (winner) return winner;
      recordId = `idm_${ulid()}`;
    }
  }

  if (!reserved) {
    throw new Error('Unable to reserve idempotency key');
  }

  let result: IdempotentResponse;
  try {
    result = await handler();
  } catch (err) {
    const error = err as Error & {
      statusCode?: number;
      code?: string;
      details?: Record<string, unknown>;
    };
    if ((error.statusCode ?? 500) >= 500) {
      await deleteRecord(db, recordId);
      throw err;
    }
    await db
      .updateTable('idempotency_records')
      .set({
        response_status: error.statusCode ?? 500,
        response_body: JSON.stringify({
          error: {
            code: error.code ?? 'INTERNAL_ERROR',
            message: error.message,
            details: error.details,
          },
        }),
        status: 'completed',
      })
      .where('id', '=', recordId)
      .execute();
    throw err;
  }

  if (result.status >= 500) {
    await deleteRecord(db, recordId);
  } else {
    await db
      .updateTable('idempotency_records')
      .set({
        response_status: result.status,
        response_body: JSON.stringify(result.body),
        status: 'completed',
      })
      .where('id', '=', recordId)
      .execute();
  }

  return result;
}

async function findRecord(
  db: Database,
  key: string,
  tenantId: string,
): Promise<IdempotencyRecord | undefined> {
  return db
    .selectFrom('idempotency_records')
    .selectAll()
    .where('key', '=', key)
    .where('tenant_id', '=', tenantId)
    .executeTakeFirst() as Promise<IdempotencyRecord | undefined>;
}

async function deleteRecord(db: Database, recordId: string): Promise<void> {
  await db.deleteFrom('idempotency_records').where('id', '=', recordId).execute();
}

function isExpired(record: IdempotencyRecord): boolean {
  if (!record.expires_at) return false;
  const expiresAt =
    record.expires_at instanceof Date
      ? record.expires_at.getTime()
      : new Date(record.expires_at).getTime();
  return Number.isFinite(expiresAt) && expiresAt <= Date.now();
}
