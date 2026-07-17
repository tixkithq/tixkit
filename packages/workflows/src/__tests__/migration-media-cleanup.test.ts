import { describe, expect, it } from 'vitest';
import type { Database } from '@tixkit/db';
import {
  processMigrationMediaCleanupJobs,
  type MigrationMediaObjectStore,
} from '../activities/migration-domain-committers.js';

type Row = Record<string, any>;

function cleanupDb(seed: { jobs: Row[]; uploads?: Row[]; renditions?: Row[] }) {
  const tables: Record<string, Row[]> = {
    media_object_cleanup_jobs: seed.jobs,
    upload_artifacts: seed.uploads ?? [],
    event_media_renditions: seed.renditions ?? [],
  };
  const matches = (row: Row, conditions: Array<(row: Row) => boolean>) =>
    conditions.every((condition) => condition(row));
  const predicate = (column: string, operator: string, value: unknown) => (row: Row) => {
    if (operator === '<') return row[column].getTime() < (value as Date).getTime();
    if (operator === '<=') return row[column].getTime() <= (value as Date).getTime();
    return row[column] === value;
  };
  const expression = Object.assign(predicate, {
    or: (values: Array<(row: Row) => boolean>) => (row: Row) => values.some((value) => value(row)),
    and: (values: Array<(row: Row) => boolean>) => (row: Row) =>
      values.every((value) => value(row)),
  });
  const selectFrom = (table: string) => {
    const conditions: Array<(row: Row) => boolean> = [];
    let limit = Number.POSITIVE_INFINITY;
    const query = {
      select: () => query,
      selectAll: () => query,
      orderBy: () => query,
      limit(value: number) {
        limit = value;
        return query;
      },
      where(
        column: string | ((eb: typeof expression) => (row: Row) => boolean),
        operator?: string,
        value?: unknown,
      ) {
        conditions.push(
          typeof column === 'function' ? column(expression) : predicate(column, operator!, value),
        );
        return query;
      },
      execute: async () =>
        tables[table]!.filter((row) => matches(row, conditions))
          .slice(0, limit)
          .map((row) => ({ ...row })),
      executeTakeFirst: async () => {
        const row = tables[table]!.find((candidate) => matches(candidate, conditions));
        return row ? { ...row } : undefined;
      },
    };
    return query;
  };
  const updateTable = (table: string) => ({
    set(values: Row) {
      const conditions: Array<(row: Row) => boolean> = [];
      const query = {
        where(column: string, operator: string, value: unknown) {
          conditions.push(predicate(column, operator, value));
          return query;
        },
        executeTakeFirst: async () => {
          let count = 0;
          for (const row of tables[table]!) {
            if (!matches(row, conditions)) continue;
            Object.assign(row, values);
            count += 1;
          }
          return { numUpdatedRows: BigInt(count) };
        },
      };
      return query;
    },
  });
  return { db: { selectFrom, updateTable } as unknown as Database, tables };
}

function job(overrides: Row = {}): Row {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: 'moc_1',
    tenant_id: 'tnt_1',
    organization_id: 'org_1',
    bucket: 'media',
    object_key: 'event-media/object.webp',
    checksum_sha256: 'a'.repeat(64),
    status: 'pending',
    attempts: 0,
    available_at: now,
    created_at: now,
    updated_at: now,
    last_error: null,
    ...overrides,
  };
}

function store(deleteObject: MigrationMediaObjectStore['delete']): MigrationMediaObjectStore {
  return {
    bucket: 'media',
    putVerified: async () => {},
    verify: async () => {},
    delete: deleteObject,
  };
}

describe('migration media cleanup fencing', () => {
  it('fences a stale worker result after a replacement worker reclaims the lease', async () => {
    const { db, tables } = cleanupDb({ jobs: [job()] });
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstDelete = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    let calls = 0;
    const objectStore = store(async () => {
      calls += 1;
      if (calls === 1) {
        markFirstStarted();
        await firstDelete;
      }
    });
    const first = processMigrationMediaCleanupJobs(
      db,
      objectStore,
      new Date('2026-01-01T00:01:00Z'),
    );
    await firstStarted;
    const second = await processMigrationMediaCleanupJobs(
      db,
      objectStore,
      new Date('2026-01-01T00:17:00Z'),
    );
    releaseFirst();
    await expect(first).resolves.toEqual({ completed: 0, retained: 0, failed: 0 });
    expect(second).toEqual({ completed: 1, retained: 0, failed: 0 });
    expect(tables.media_object_cleanup_jobs[0]?.status).toBe('completed');
  });

  it('times out deletion and persists only a fixed redacted error token', async () => {
    const { db, tables } = cleanupDb({ jobs: [job()] });
    let aborted = false;
    let lateDeleteCompleted = false;
    await expect(
      processMigrationMediaCleanupJobs(
        db,
        store(
          async (_objectKey, abortSignal) =>
            new Promise<void>((resolve, reject) => {
              const lateDelete = setTimeout(() => {
                lateDeleteCompleted = true;
                resolve();
              }, 30);
              abortSignal.addEventListener(
                'abort',
                () => {
                  aborted = true;
                  clearTimeout(lateDelete);
                  reject(new Error('hostile request id req_secret_123'));
                },
                { once: true },
              );
            }),
        ),
        new Date('2026-01-01T00:01:00Z'),
        100,
        { deleteTimeoutMs: 5 },
      ),
    ).resolves.toEqual({ completed: 0, retained: 0, failed: 1 });
    expect(aborted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(lateDeleteCompleted).toBe(false);
    expect(tables.media_object_cleanup_jobs[0]?.last_error).toBe('cleanup_delete_timeout');
    expect(JSON.stringify(tables.media_object_cleanup_jobs[0])).not.toContain('req_secret_123');
  });

  it('fails closed without deleting a checksum-drifted live reference', async () => {
    let deletes = 0;
    const { db, tables } = cleanupDb({
      jobs: [job()],
      renditions: [
        {
          id: 'emr_1',
          bucket: 'media',
          object_key: 'event-media/object.webp',
          checksum_sha256: 'b'.repeat(64),
        },
      ],
    });
    await expect(
      processMigrationMediaCleanupJobs(
        db,
        store(async () => {
          deletes += 1;
        }),
        new Date('2026-01-01T00:01:00Z'),
      ),
    ).resolves.toEqual({ completed: 0, retained: 0, failed: 1 });
    expect(deletes).toBe(0);
    expect(tables.media_object_cleanup_jobs[0]?.last_error).toBe(
      'cleanup_reference_checksum_mismatch',
    );
  });

  it('redacts hostile provider deletion errors', async () => {
    const { db, tables } = cleanupDb({ jobs: [job()] });
    await expect(
      processMigrationMediaCleanupJobs(
        db,
        store(async () => {
          throw new Error('secret=https://credential@example.test');
        }),
        new Date('2026-01-01T00:01:00Z'),
      ),
    ).resolves.toEqual({ completed: 0, retained: 0, failed: 1 });
    expect(tables.media_object_cleanup_jobs[0]?.last_error).toBe('cleanup_delete_failed');
    expect(JSON.stringify(tables.media_object_cleanup_jobs[0])).not.toContain('credential');
  });
});
