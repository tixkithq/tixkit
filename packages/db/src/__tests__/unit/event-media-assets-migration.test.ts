import { describe, expect, it, vi } from 'vitest';
import { EventMediaAssetsMigration } from '../../migrations/0075_event_media_assets.js';

describe('EventMediaAssetsMigration', () => {
  it('is unconditionally irreversible before performing any database operation', async () => {
    const db = {
      selectFrom: vi.fn(),
      executeQuery: vi.fn(),
      schema: {
        alterTable: vi.fn(),
        dropTable: vi.fn(),
      },
    };

    await expect(EventMediaAssetsMigration.down!(db as never)).rejects.toThrow(
      'Event media assets are irreversible without an archival migration',
    );
    expect(db.selectFrom).not.toHaveBeenCalled();
    expect(db.executeQuery).not.toHaveBeenCalled();
    expect(db.schema.alterTable).not.toHaveBeenCalled();
    expect(db.schema.dropTable).not.toHaveBeenCalled();
  });

  it('refuses rollback even when the caller presents an empty database handle', async () => {
    await expect(EventMediaAssetsMigration.down!({} as never)).rejects.toThrow(
      'Event media assets are irreversible without an archival migration',
    );
  });
});
