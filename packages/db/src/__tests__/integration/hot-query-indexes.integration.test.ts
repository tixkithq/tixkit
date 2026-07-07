import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import type { Database } from '../../client.js';
import { createDb } from '../../client.js';
import { runMigrations } from '../../migrate.js';

type PlanRow = {
  'QUERY PLAN': string;
};

type ExplainCase = {
  name: string;
  indexName: string;
  expectedIndexColumns: readonly string[];
  explain: (db: Database) => Promise<{ rows: PlanRow[] }>;
};

const postgresUrl = process.env.DATABASE_URL ?? '';
const requestedDriver = process.env.DB_INTEGRATION_DRIVER;
const canRunPostgresExplain =
  postgresUrl.length > 0 && (requestedDriver === undefined || requestedDriver === 'postgres');

const tenantId = 'tenant_explain';
const eventId = 'event_explain';
const orderId = 'order_explain';

if (!canRunPostgresExplain) {
  it.skip('hot-query index EXPLAIN ANALYZE verification (skipped: DATABASE_URL/DB_INTEGRATION_DRIVER is not postgres)', () => {});
}

describe.skipIf(!canRunPostgresExplain)(
  'hot-query index EXPLAIN ANALYZE verification (real postgres)',
  () => {
    let db: Database;

    beforeAll(async () => {
      process.env.DB_DRIVER = 'postgres';
      await runMigrations(postgresUrl);
      db = createDb(postgresUrl, { pool: { max: 1 } });
    }, 120_000);

    afterAll(async () => {
      await db?.destroy();
    }, 60_000);

    const explainCases: ExplainCase[] = [
      {
        name: 'public marketing integrations by event/status',
        indexName: 'idx_marketing_integrations_event',
        expectedIndexColumns: ['event_id', 'status'],
        explain: (database) =>
          sql<PlanRow>`
            explain (analyze, costs off, timing off, summary off)
            select provider, config, consent_required, status
            from marketing_integrations
            where event_id = ${eventId}
              and status = 'active'
          `.execute(database),
      },
      {
        name: 'published event content documents by event/channel/status/locale',
        indexName: 'idx_content_documents_event_channel_status_locale',
        expectedIndexColumns: ['event_id', 'channel', 'status', 'locale'],
        explain: (database) =>
          sql<PlanRow>`
            explain (analyze, costs off, timing off, summary off)
            select id, published_version_id
            from content_documents
            where event_id = ${eventId}
              and channel = 'event_page'
              and status = 'published'
              and locale = 'en'
          `.execute(database),
      },
      {
        name: 'legacy hosted event pages by event/locale/default flag',
        indexName: 'idx_event_pages_event_locale_default',
        expectedIndexColumns: ['event_id', 'locale', 'is_default'],
        explain: (database) =>
          sql<PlanRow>`
            explain (analyze, costs off, timing off, summary off)
            select id, title, content_html
            from event_pages
            where event_id = ${eventId}
              and locale = 'en'
              and is_default = true
          `.execute(database),
      },
      {
        name: 'published checkout questions by event/status/sort order',
        indexName: 'idx_questions_event_status_sort',
        expectedIndexColumns: ['event_id', 'status', 'sort_order', 'id'],
        explain: (database) =>
          sql<PlanRow>`
            explain (analyze, costs off, timing off, summary off)
            select id, label, sort_order
            from questions
            where event_id = ${eventId}
              and status = 'active'
            order by sort_order asc, id asc
          `.execute(database),
      },
      {
        name: 'checkout sessions by tenant/event/status',
        indexName: 'idx_checkout_sessions_tenant_event_status',
        expectedIndexColumns: ['tenant_id', 'event_id', 'status'],
        explain: (database) =>
          sql<PlanRow>`
            explain (analyze, costs off, timing off, summary off)
            select id, expires_at
            from checkout_sessions
            where tenant_id = ${tenantId}
              and event_id = ${eventId}
              and status = 'open'
          `.execute(database),
      },
      {
        name: 'report orders by tenant/event/status/date',
        indexName: 'idx_orders_report_event_status_created',
        expectedIndexColumns: ['tenant_id', 'event_id', 'status', 'created_at', 'id'],
        explain: (database) =>
          sql<PlanRow>`
            explain (analyze, costs off, timing off, summary off)
            select id, total_cents, created_at
            from orders
            where tenant_id = ${tenantId}
              and event_id = ${eventId}
              and status in ('paid', 'partially_refunded', 'refunded')
              and created_at >= '2026-01-01T00:00:00Z'::timestamptz
              and created_at < '2027-01-01T00:00:00Z'::timestamptz
            order by created_at desc, id desc
          `.execute(database),
      },
      {
        name: 'refund rollups by order/status/date',
        indexName: 'idx_refunds_order_status_created',
        expectedIndexColumns: ['order_id', 'status', 'created_at'],
        explain: (database) =>
          sql<PlanRow>`
            explain (analyze, costs off, timing off, summary off)
            select amount_cents
            from refunds
            where order_id = ${orderId}
              and status = 'succeeded'
              and created_at >= '2026-01-01T00:00:00Z'::timestamptz
              and created_at < '2027-01-01T00:00:00Z'::timestamptz
          `.execute(database),
      },
      {
        name: 'export/report line items by order/ticket type',
        indexName: 'idx_order_line_items_order_ticket',
        expectedIndexColumns: ['order_id', 'ticket_type_id'],
        explain: (database) =>
          sql<PlanRow>`
            explain (analyze, costs off, timing off, summary off)
            select id, quantity
            from order_line_items
            where order_id = ${orderId}
              and ticket_type_id = 'tt_explain'
          `.execute(database),
      },
      {
        name: 'tax snapshot lookups by order/rule/rate',
        indexName: 'idx_order_tax_snapshots_order_rule',
        expectedIndexColumns: ['order_id', 'tax_rule_name', 'rate'],
        explain: (database) =>
          sql<PlanRow>`
            explain (analyze, costs off, timing off, summary off)
            select id, tax_cents
            from order_tax_snapshots
            where order_id = ${orderId}
              and tax_rule_name = 'state'
              and rate = 0.0825
          `.execute(database),
      },
    ];

    it.each(explainCases)(
      'has $indexName and runs an index-backed EXPLAIN ANALYZE for $name',
      async ({ indexName, expectedIndexColumns, explain }) => {
        const indexRow = await sql<{ indexdef: string }>`
          select indexdef
          from pg_indexes
          where schemaname = current_schema()
            and indexname = ${indexName}
        `.execute(db);

        const indexDefinition = indexRow.rows[0]?.indexdef ?? '';
        expect(indexDefinition).toContain(indexName);
        for (const columnName of expectedIndexColumns) {
          expect(indexDefinition).toContain(columnName);
        }

        await db.transaction().execute(async (trx) => {
          await sql`set local enable_seqscan = off`.execute(trx);

          const result = await explain(trx);
          const plan = result.rows.map((row) => row['QUERY PLAN']).join('\n');

          expect(plan).toMatch(/(?:Index|Bitmap) Scan/);
        });
      },
    );
  },
);
