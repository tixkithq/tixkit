import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import type { Database } from '@tixkit/db';
import { IdempotencyConflictError, IdempotencyInProgressError } from '@tixkit/domain';

export type IdempotentResponse = {
  status: number;
  body: unknown;
};

export type IdempotencyHandlerContext = Readonly<{
  completeInTransaction: (transactionDb: Database, response: IdempotentResponse) => Promise<void>;
}>;

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

const COMPLETION_UPDATE_MAX_ATTEMPTS = 3;
const COMPLETION_UPDATE_BASE_DELAY_MS = 10;

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
    inProgressWaitMs?: number;
    inProgressPollIntervalMs?: number;
    discardErrorCodes?: readonly string[];
  },
  handler: (context: IdempotencyHandlerContext) => Promise<IdempotentResponse>,
): Promise<IdempotentResponse> {
  const inProgressWaitMs = Math.max(0, input.inProgressWaitMs ?? 10_000);
  const inProgressPollIntervalMs = Math.max(1, input.inProgressPollIntervalMs ?? 50);

  const replayExisting = async (): Promise<IdempotentResponse | null> => {
    const deadline = Date.now() + inProgressWaitMs;

    while (true) {
      // eslint-disable-next-line no-await-in-loop -- idempotency replay must poll sequentially until the winning request commits its response.
      const existing = await findRecord(db, input.key, input.tenantId);
      if (!existing) return null;
      const status = existing.status ?? 'completed';
      if (status === 'completed') {
        if (existing.request_hash !== input.requestHash) {
          throw new IdempotencyConflictError(input.key);
        }
        return { status: existing.response_status, body: JSON.parse(existing.response_body) };
      }
      if (isExpired(existing)) {
        // eslint-disable-next-line no-await-in-loop -- expired records must be removed before this key can be reserved again.
        await deleteRecord(db, existing.id);
        return null;
      }
      if (existing.request_hash !== input.requestHash) {
        throw new IdempotencyConflictError(input.key);
      }
      if (Date.now() >= deadline) break;
      // eslint-disable-next-line no-await-in-loop -- backoff is intentionally sequential between replay polling attempts.
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(inProgressPollIntervalMs, Math.max(1, deadline - Date.now()))),
      );
    }

    throw new IdempotencyInProgressError(input.key);
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
    result = await handler({
      completeInTransaction: async (transactionDb, response) => {
        await completeRecordWithRetry(transactionDb, recordId, {
          response_status: response.status,
          response_body: JSON.stringify(response.body),
          status: 'completed',
        });
      },
    });
  } catch (err) {
    const error = err as Error & {
      statusCode?: number;
      code?: string;
    };
    if (error.code && input.discardErrorCodes?.includes(error.code)) {
      await deleteRecord(db, recordId);
      throw err;
    }
    if ((error.statusCode ?? 500) >= 500) {
      const transactionallyCompleted = await findRecord(db, input.key, input.tenantId);
      if (
        transactionallyCompleted?.status === 'completed' &&
        transactionallyCompleted.request_hash === input.requestHash
      ) {
        return {
          status: transactionallyCompleted.response_status,
          body: JSON.parse(transactionallyCompleted.response_body),
        };
      }
      await deleteRecord(db, recordId);
      throw err;
    }
    await completeRecordWithRetry(db, recordId, {
      response_status: error.statusCode ?? 500,
      response_body: JSON.stringify({
        error: {
          code: error.code ?? 'VALIDATION_ERROR',
          message: error.message,
        },
      }),
      status: 'completed',
    });
    throw err;
  }

  if (result.status >= 500) {
    await deleteRecord(db, recordId);
  } else {
    try {
      await completeRecordWithRetry(db, recordId, {
        response_status: result.status,
        response_body: JSON.stringify(result.body),
        status: 'completed',
      });
    } catch (completionError) {
      const transactionallyCompleted = await findRecord(db, input.key, input.tenantId);
      if (
        transactionallyCompleted?.status === 'completed' &&
        transactionallyCompleted.request_hash === input.requestHash
      ) {
        return {
          status: transactionallyCompleted.response_status,
          body: JSON.parse(transactionallyCompleted.response_body),
        };
      }
      throw completionError;
    }
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

async function completeRecordWithRetry(
  db: Database,
  recordId: string,
  values: {
    response_status: number;
    response_body: string;
    status: 'completed';
  },
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < COMPLETION_UPDATE_MAX_ATTEMPTS; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop -- completion persistence must retry the same reserved idempotency record before surfacing failure.
      await db.updateTable('idempotency_records').set(values).where('id', '=', recordId).execute();
      return;
    } catch (error) {
      lastError = error;
      if (attempt + 1 >= COMPLETION_UPDATE_MAX_ATTEMPTS) break;
      const delayMs = COMPLETION_UPDATE_BASE_DELAY_MS * 2 ** attempt;
      // eslint-disable-next-line no-await-in-loop -- bounded backoff keeps the original side-effect result recoverable for immediate retries.
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}

function isExpired(record: IdempotencyRecord): boolean {
  if (!record.expires_at) return false;
  const expiresAt =
    record.expires_at instanceof Date
      ? record.expires_at.getTime()
      : new Date(record.expires_at).getTime();
  return Number.isFinite(expiresAt) && expiresAt <= Date.now();
}
