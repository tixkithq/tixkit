import { describe, expect, it, vi } from 'vitest';
import { MediaObjectCleanupJobsMigration } from '../../migrations/0076_media_object_cleanup_jobs.js';

describe('MediaObjectCleanupJobsMigration', () => {
  it('is unconditionally irreversible before performing any database operation', async () => {
    const db = {
      selectFrom: vi.fn(),
      executeQuery: vi.fn(),
      schema: {
        alterTable: vi.fn(),
        dropTable: vi.fn(),
      },
    };

    await expect(MediaObjectCleanupJobsMigration.down!(db as never)).rejects.toThrow(
      'Media object cleanup jobs are irreversible without an archival migration',
    );
    expect(db.selectFrom).not.toHaveBeenCalled();
    expect(db.executeQuery).not.toHaveBeenCalled();
    expect(db.schema.alterTable).not.toHaveBeenCalled();
    expect(db.schema.dropTable).not.toHaveBeenCalled();
  });

  it('refuses rollback even when the caller presents an empty database handle', async () => {
    await expect(MediaObjectCleanupJobsMigration.down!({} as never)).rejects.toThrow(
      'Media object cleanup jobs are irreversible without an archival migration',
    );
  });
});
