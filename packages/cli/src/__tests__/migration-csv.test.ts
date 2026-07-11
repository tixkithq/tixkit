import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GENERIC_CSV_LIMITS } from '@tixkit/migration-core';
import { previewCsvFile } from '../migration-csv.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('Generic CSV CLI preview', () => {
  it('auto-detects an event document without uploading buyer data', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tixkit-csv-preview-'));
    directories.push(directory);
    const path = join(directory, 'events.csv');
    await writeFile(
      path,
      'external_id,title,starts_at,timezone,currency\nevt_1,Launch,2026-10-01T18:00:00Z,America/Chicago,USD\n',
    );
    const preview = await previewCsvFile({ path });
    expect(preview[0]).toMatchObject({ entityType: 'event' });
    expect(preview[0]?.rows).toHaveLength(1);
  });

  it('rejects unsupported explicit entity types', async () => {
    await expect(previewCsvFile({ path: 'unused.csv', entityType: 'payment' })).rejects.toThrow(
      'Unsupported Generic CSV entity type',
    );
  });

  it('rejects an oversized file from metadata before reading it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tixkit-csv-preview-'));
    directories.push(directory);
    const path = join(directory, 'oversized.csv');
    await writeFile(path, '');
    await truncate(path, GENERIC_CSV_LIMITS.maxBytes + 1);

    await expect(previewCsvFile({ path })).rejects.toThrow(/byte limit/u);
  });
});
