import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Database } from '../../client.js';
import { createDb } from '../../client.js';
import { runMigrations, truncateAllData } from '../../migrate.js';
import { TenantRepository, ShortLinkRepository } from '../../repositories/index.js';

type DriverCase = { driver: 'postgres' | 'mysql' | 'mssql'; url: string };

const allDriverCases: DriverCase[] = [
  { driver: 'postgres', url: process.env.DATABASE_URL ?? '' },
  { driver: 'mysql', url: process.env.DATABASE_URL_MYSQL ?? '' },
  { driver: 'mssql', url: process.env.DATABASE_URL_MSSQL ?? '' },
];

const requestedDriver = process.env.DB_INTEGRATION_DRIVER;
const driverCases = (
  requestedDriver ? allDriverCases.filter((c) => c.driver === requestedDriver) : allDriverCases
).filter((c) => c.url.length > 0);

if (driverCases.length === 0) {
  it.skip('short-links integration (skipped: no DATABASE_URL configured)', () => {});
}

describe.each(driverCases)('short-links integration: $driver', ({ driver, url }) => {
  let db: Database;
  let tenantId: string;

  beforeAll(async () => {
    process.env.DB_DRIVER = driver;
    await runMigrations(url);
    db = createDb(url);
  }, 120_000);

  beforeEach(async () => {
    await truncateAllData(db);
    const tenant = await new TenantRepository(db).create({ name: 'Short Link Tenant' });
    tenantId = tenant.id;
  }, 60_000);

  afterAll(async () => {
    await db?.destroy();
  }, 60_000);

  it('creates a short link, resolves it by slug, and counts clicks privacy-safely', async () => {
    const repo = new ShortLinkRepository(db);
    const created = await repo.create({
      tenantId,
      slug: 'abc1234',
      destinationUrl: 'https://example.test/e/evt_1',
      utmParams: { utm_source: 'email' },
    });
    expect(created.slug).toBe('abc1234');
    expect(created.clicks).toBe(0);

    const resolved = await repo.findBySlugGlobal('abc1234');
    expect(resolved?.destination_url).toBe('https://example.test/e/evt_1');

    expect(await repo.slugExists('abc1234')).toBe(true);
    expect(await repo.slugExists('nope')).toBe(false);

    const clickTimes = [
      ...Array.from(
        { length: 12 },
        (_, hour) => new Date(`2026-06-28T${String(hour).padStart(2, '0')}:00:00Z`),
      ),
      ...Array.from(
        { length: 7 },
        (_, hour) => new Date(`2026-06-29T${String(hour).padStart(2, '0')}:00:00Z`),
      ),
      new Date('2026-06-30T09:00:00Z'),
    ];
    await Promise.all(clickTimes.map((at) => repo.recordClick(created.id, tenantId, at)));

    const aggregate = await repo.getClickAggregate(created.id);
    expect(aggregate.totalClicks).toBe(20);
    expect(aggregate.byDay).toEqual({
      '2026-06-28': 12,
      '2026-06-29': 7,
      '2026-06-30': 1,
    });

    const refreshed = await repo.findById(created.id);
    expect(refreshed?.clicks).toBe(20);
  });

  it('enforces slug uniqueness', async () => {
    const repo = new ShortLinkRepository(db);
    await repo.create({
      tenantId,
      slug: 'unique1',
      destinationUrl: 'https://example.test/a',
    });
    await expect(
      repo.create({ tenantId, slug: 'unique1', destinationUrl: 'https://example.test/b' }),
    ).rejects.toThrow();
  });
});
