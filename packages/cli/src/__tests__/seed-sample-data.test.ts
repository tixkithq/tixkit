import { describe, it, expect } from 'vitest';
import {
  makeId,
  SAMPLE_TENANT_ID,
  SAMPLE_ORGANIZATION_ID,
  SAMPLE_BRAND_ID,
  SAMPLE_EVENT_SLUG,
  seedSampleData,
} from '../seed-sample-data.js';

describe('seed-sample-data', () => {
  it('generates stable sample IDs and a prefixed UUID', () => {
    expect(SAMPLE_TENANT_ID).toBe('tnt_sample_data');
    expect(SAMPLE_ORGANIZATION_ID).toBe('org_sample_data');
    expect(SAMPLE_BRAND_ID).toBe('brd_sample_data');
    expect(SAMPLE_EVENT_SLUG).toBe('sample-summer-showcase');

    const id = makeId('tt');
    expect(id.startsWith('tt_')).toBe(true);
    expect(id.length).toBeLessThanOrEqual(32);
  });

  it('fails gracefully when DATABASE_URL is missing', async () => {
    const original = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;

    const result = await seedSampleData();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('DATABASE_URL');

    if (original !== undefined) {
      process.env.DATABASE_URL = original;
    }
  });
});
