import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import { createDb, type Database } from '../../client.js';
import { runMigrations, truncateAllData } from '../../migrate.js';
import {
  BrandRepository,
  EventRepository,
  OrganizationRepository,
  TenantRepository,
} from '../../repositories/index.js';

type DriverCase = { driver: 'postgres' | 'mysql' | 'mssql'; url: string };
const requestedDriver = process.env.DB_INTEGRATION_DRIVER;
const driverCases = [
  { driver: 'postgres', url: process.env.DATABASE_URL ?? '' },
  { driver: 'mysql', url: process.env.DATABASE_URL_MYSQL ?? '' },
  { driver: 'mssql', url: process.env.DATABASE_URL_MSSQL ?? '' },
].filter(
  (candidate) =>
    candidate.url.length > 0 && (!requestedDriver || candidate.driver === requestedDriver),
) as DriverCase[];

if (driverCases.length === 0)
  it.skip('dashboard action revision integration (database URLs are not configured)', () => {});

describe.sequential.each(driverCases)(
  'dashboard action revision ledger: $driver',
  ({ driver, url }) => {
    let db: Database;
    let tenantId: string;
    let organizationId: string;
    let brandId: string;
    let eventIds: [string, string];

    beforeAll(async () => {
      process.env.DB_DRIVER = driver;
      await runMigrations(url);
      db = createDb(url);
      await truncateAllData(db);
      const runId = ulid().toLowerCase();
      tenantId = (await new TenantRepository(db).create({ name: `Revision ${runId}` })).id;
      organizationId = (
        await new OrganizationRepository(db).create({
          tenantId,
          name: `Revision ${runId}`,
          slug: `revision-${runId}`,
        })
      ).id;
      brandId = (
        await new BrandRepository(db).create({
          tenantId,
          organizationId,
          name: `Revision ${runId}`,
          slug: `revision-${runId}`,
        })
      ).id;
      const events = new EventRepository(db);
      const created = [];
      for (const label of ['a', 'b']) {
        created.push(
          await events.create({
            tenantId,
            organizationId,
            brandId,
            slug: `revision-${label}-${runId}`,
            title: `Revision ${label.toUpperCase()}`,
            currency: 'USD',
            timezone: 'UTC',
            startsAt: new Date('2027-01-01T18:00:00.000Z'),
          }),
        );
      }
      eventIds = [created[0]!.id, created[1]!.id];
    });

    afterAll(async () => {
      await db?.destroy();
    });

    async function revision(): Promise<bigint> {
      const row = await db
        .selectFrom('dashboard_action_revisions')
        .select('revision')
        .where('tenant_id', '=', tenantId)
        .where('organization_id', '=', organizationId)
        .where('brand_id', '=', brandId)
        .executeTakeFirstOrThrow();
      return BigInt(row.revision);
    }

    it('deduplicates same-brand scopes for multi-row check-in and export mutations', async () => {
      const beforeCheckIns = await revision();
      const now = new Date('2026-01-01T00:00:00.000Z');
      await db
        .insertInto('check_in_lists')
        .values(
          eventIds.map((eventId, index) => ({
            id: `cil_${ulid()}`,
            event_id: eventId,
            event_occurrence_id: null,
            name: `Door ${index + 1}`,
            ticket_type_ids: JSON.stringify([]),
            status: 'active',
            created_at: now,
            updated_at: now,
          })),
        )
        .execute();
      expect(await revision()).toBeGreaterThan(beforeCheckIns);

      const exportIds = [`exp_${ulid()}`, `exp_${ulid()}`];
      await db
        .insertInto('export_jobs')
        .values(
          eventIds.map((eventId, index) => ({
            id: exportIds[index]!,
            tenant_id: tenantId,
            event_id: eventId,
            type: 'attendees',
            format: 'csv',
            status: 'completed',
            file_url: null,
            requested_by: 'revision_integration',
            filters: JSON.stringify({}),
            created_at: now,
            completed_at: now,
          })),
        )
        .execute();
      const beforeExports = await revision();
      await db
        .updateTable('export_jobs')
        .set({ status: 'failed', completed_at: null })
        .where('id', 'in', exportIds)
        .execute();
      expect(await revision()).toBeGreaterThan(beforeExports);
    });
  },
);
