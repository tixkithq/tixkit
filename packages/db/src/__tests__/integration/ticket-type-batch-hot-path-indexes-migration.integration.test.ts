import { sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../../client.js';
import { dropAllTables, TixkitMigrationProvider } from '../../migrate.js';
import { TicketTypeDependencyIndexesMigration } from '../../migrations/0099_ticket_type_batch_hot_path_indexes.js';

const driver =
  process.env.DB_INTEGRATION_DRIVER === 'mysql'
    ? 'mysql'
    : process.env.DB_INTEGRATION_DRIVER === 'postgres'
      ? 'postgres'
      : undefined;
const primaryUrl = driver === 'mysql' ? process.env.DATABASE_URL_MYSQL : process.env.DATABASE_URL;
const migrationTestUrl =
  driver === 'mysql'
    ? process.env.DATABASE_URL_MYSQL_MIGRATION_TEST
    : process.env.DATABASE_URL_MIGRATION_TEST;
const enabled = Boolean(driver && primaryUrl && migrationTestUrl);

const TARGET_TICKET_TYPE_ID = 'tt_capacity_target';
const NOISE_TICKET_TYPE_ID = 'tt_capacity_noise';
const ROW_COUNT = 1024;
const indexes = [
  ['checkout_holds', 'idx_checkout_holds_ticket_type_id'],
  ['order_line_items', 'idx_order_line_items_ticket_type_id'],
  ['tickets', 'idx_tickets_ticket_type_id'],
  ['access_rules', 'idx_access_rules_ticket_type_id'],
] as const;
const foreignKeys = [
  'checkout_holds_ticket_type_fk',
  'order_line_items_ticket_type_fk',
  'tickets_ticket_type_fk',
  'access_rules_ticket_type_fk',
  'waitlist_entries_ticket_type_fk',
] as const;

function assertDedicatedMigrationDatabase(primary: string, dedicated: string): void {
  const primaryDatabase = new URL(primary);
  const dedicatedDatabase = new URL(dedicated);
  if (
    primaryDatabase.protocol !== dedicatedDatabase.protocol ||
    primaryDatabase.hostname !== dedicatedDatabase.hostname ||
    primaryDatabase.port !== dedicatedDatabase.port ||
    primaryDatabase.pathname === dedicatedDatabase.pathname ||
    !dedicatedDatabase.pathname.endsWith('_migration_test')
  ) {
    throw new Error(
      'Ticket-type hot-path proof requires a sibling database ending in _migration_test',
    );
  }
}

function rowId(prefix: string, index: number): string {
  return `${prefix}_${String(index).padStart(6, '0')}`;
}

async function indexColumns(db: Database, tableName: string, indexName: string): Promise<string[]> {
  if (driver === 'mysql') {
    const result = await sql<{ columnName: string }>`
      select column_name as columnName
      from information_schema.statistics
      where table_schema = database()
        and table_name = ${tableName}
        and index_name = ${indexName}
      order by seq_in_index
    `.execute(db);
    return result.rows.map((row) => row.columnName);
  }
  const result = await sql<{ indexdef: string }>`
    select indexdef
    from pg_indexes
    where schemaname = current_schema()
      and tablename = ${tableName}
      and indexname = ${indexName}
  `.execute(db);
  const definition = result.rows[0]?.indexdef;
  if (!definition) return [];
  const columns = definition.match(/\(([^)]+)\)/)?.[1] ?? '';
  return columns.split(',').map((column) => column.trim().replaceAll('"', ''));
}

async function leadingTicketTypeIndexes(db: Database, tableName: string): Promise<string[]> {
  if (driver === 'mysql') {
    const result = await sql<{ indexName: string }>`
      select index_name as indexName
      from information_schema.statistics
      where table_schema = database()
        and table_name = ${tableName}
        and seq_in_index = 1
        and column_name = 'ticket_type_id'
        and index_type = 'BTREE'
        and is_visible = 'YES'
        and non_unique = 1
        and sub_part is null
      order by index_name
    `.execute(db);
    return result.rows.map((row) => row.indexName);
  }
  const result = await sql<{ indexName: string }>`
    select index_relation.relname as "indexName"
    from pg_class index_relation
    join pg_index index_definition on index_definition.indexrelid = index_relation.oid
    join pg_class table_relation on table_relation.oid = index_definition.indrelid
    join pg_namespace table_namespace on table_namespace.oid = table_relation.relnamespace
    join pg_am access_method on access_method.oid = index_relation.relam
    join pg_attribute attribute
      on attribute.attrelid = table_relation.oid
     and attribute.attnum = index_definition.indkey[0]
    where table_relation.relname = ${tableName}
      and table_namespace.nspname = current_schema()
      and attribute.attname = 'ticket_type_id'
      and access_method.amname = 'btree'
      and not index_definition.indisunique
      and index_definition.indisvalid
      and index_definition.indisready
      and index_definition.indpred is null
    order by index_relation.relname
  `.execute(db);
  return result.rows.map((row) => row.indexName);
}

async function foreignKeyNames(db: Database): Promise<string[]> {
  if (driver === 'mysql') {
    const result = await sql<{ constraintName: string }>`
      select constraint_name as constraintName
      from information_schema.table_constraints
      where table_schema = database()
        and constraint_type = 'FOREIGN KEY'
        and constraint_name in (${sql.join(foreignKeys)})
      order by constraint_name
    `.execute(db);
    return result.rows.map((row) => row.constraintName);
  }
  const result = await sql<{ constraintName: string }>`
    select conname as "constraintName"
    from pg_constraint
    where contype = 'f'
      and conname in (${sql.join(foreignKeys)})
    order by conname
  `.execute(db);
  return result.rows.map((row) => row.constraintName);
}

async function createIndex(
  db: Database,
  tableName: string,
  indexName: string,
  columns: string[],
  unique = false,
): Promise<void> {
  let builder = db.schema.createIndex(indexName).on(tableName).columns(columns);
  if (unique) builder = builder.unique();
  await builder.execute();
}

async function dropIndex(db: Database, tableName: string, indexName: string): Promise<void> {
  if (driver === 'mysql') {
    await db.schema.dropIndex(indexName).on(tableName).execute();
    return;
  }
  await db.schema.dropIndex(indexName).execute();
}

async function expectDependencyIndexState(db: Database, migrated: boolean): Promise<void> {
  for (const [tableName, indexName] of indexes) {
    const ownedColumns = await indexColumns(db, tableName, indexName);
    if (driver === 'postgres') {
      expect(ownedColumns).toEqual(migrated ? ['ticket_type_id'] : []);
    } else if (ownedColumns.length > 0) {
      expect(ownedColumns).toEqual(['ticket_type_id']);
    }
    const equivalent = await leadingTicketTypeIndexes(db, tableName);
    if (migrated || driver === 'mysql') {
      expect(
        equivalent.length,
        `${tableName} must retain a leading ticket_type_id B-tree`,
      ).toBeGreaterThan(0);
    } else {
      expect(equivalent).toEqual([]);
    }
  }
  await expect(
    indexColumns(db, 'waitlist_entries', 'idx_waitlist_entries_ticket_status'),
  ).resolves.toEqual(['ticket_type_id', 'status', 'created_at']);
  await expect(foreignKeyNames(db)).resolves.toEqual([...foreignKeys].sort());
}

async function seedPlanFixture(db: Database): Promise<void> {
  const now = new Date('2026-07-22T00:00:00.000Z');
  const later = new Date('2027-07-22T00:00:00.000Z');
  await db
    .insertInto('tenants')
    .values({
      id: 'tnt_capacity',
      name: 'Capacity tenant',
      status: 'active',
      plan: 'test',
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('organizations')
    .values({
      id: 'org_capacity',
      tenant_id: 'tnt_capacity',
      name: 'Capacity organization',
      slug: 'capacity-organization',
      clerk_organization_id: null,
      box_office_settings: '{}',
      status: 'active',
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('brands')
    .values({
      id: 'brd_capacity',
      tenant_id: 'tnt_capacity',
      organization_id: 'org_capacity',
      name: 'Capacity brand',
      slug: 'capacity-brand',
      status: 'active',
      theme: '{}',
      support_url: null,
      legal_urls: '{}',
      white_label: false,
      payment_account_id: null,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('events')
    .values({
      id: 'evt_capacity',
      tenant_id: 'tnt_capacity',
      organization_id: 'org_capacity',
      brand_id: 'brd_capacity',
      slug: 'capacity-event',
      title: 'Capacity event',
      description: null,
      status: 'published',
      currency: 'USD',
      timezone: 'UTC',
      starts_at: later,
      ends_at: null,
      visibility: 'public',
      seo: '{}',
      capacity: null,
      cover_image_url: null,
      external_url: null,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('inventory_pools')
    .values([
      {
        id: 'inv_capacity_target',
        event_id: 'evt_capacity',
        name: 'Target pool',
        total_capacity: ROW_COUNT * 4,
        reserved_count: 0,
        sold_count: 0,
        hold_ttl_seconds: 600,
        created_at: now,
        updated_at: now,
      },
      {
        id: 'inv_capacity_noise',
        event_id: 'evt_capacity',
        name: 'Noise pool',
        total_capacity: ROW_COUNT * 4,
        reserved_count: 0,
        sold_count: 0,
        hold_ttl_seconds: 600,
        created_at: now,
        updated_at: now,
      },
    ])
    .execute();
  await db
    .insertInto('ticket_types')
    .values([
      {
        id: TARGET_TICKET_TYPE_ID,
        event_id: 'evt_capacity',
        name: 'Target ticket',
        description: null,
        kind: 'paid',
        status: 'active',
        visibility: 'public',
        currency: 'USD',
        price_cents: 1000,
        minimum_price_cents: null,
        sales_start_at: null,
        sales_end_at: null,
        min_per_order: 1,
        max_per_order: 10,
        inventory_pool_id: 'inv_capacity_target',
        sort_order: 0,
        requires_access_code: false,
        access_code_hint: null,
        event_occurrence_id: null,
        created_at: now,
        updated_at: now,
      },
      {
        id: NOISE_TICKET_TYPE_ID,
        event_id: 'evt_capacity',
        name: 'Noise ticket',
        description: null,
        kind: 'paid',
        status: 'active',
        visibility: 'public',
        currency: 'USD',
        price_cents: 1000,
        minimum_price_cents: null,
        sales_start_at: null,
        sales_end_at: null,
        min_per_order: 1,
        max_per_order: 10,
        inventory_pool_id: 'inv_capacity_noise',
        sort_order: 1,
        requires_access_code: false,
        access_code_hint: null,
        event_occurrence_id: null,
        created_at: now,
        updated_at: now,
      },
    ])
    .execute();
  await db
    .insertInto('checkout_sessions')
    .values({
      id: 'cs_capacity',
      tenant_id: 'tnt_capacity',
      event_id: 'evt_capacity',
      brand_id: 'brd_capacity',
      status: 'open',
      hold_id: 'hld_capacity_primary',
      currency: 'USD',
      cart: '{}',
      buyer: '{}',
      quote: '{}',
      payment_intent_id: null,
      order_id: null,
      success_url: null,
      cancel_url: null,
      expires_at: later,
      idempotency_key: 'capacity-idempotency',
      client_token: 'capacity-client-token',
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('orders')
    .values({
      id: 'ord_capacity',
      tenant_id: 'tnt_capacity',
      organization_id: 'org_capacity',
      brand_id: 'brd_capacity',
      event_id: 'evt_capacity',
      checkout_session_id: 'cs_capacity',
      order_number: 'CAPACITY-ORDER',
      status: 'paid',
      currency: 'USD',
      subtotal_cents: 1000,
      discount_cents: 0,
      tax_cents: 0,
      fee_cents: 0,
      total_cents: 1000,
      refunded_cents: 0,
      buyer_email: 'capacity@example.test',
      buyer_first_name: null,
      buyer_last_name: null,
      buyer_phone: null,
      payment_intent_id: null,
      payment_provider: null,
      paid_at: now,
      refunded_at: null,
      cancelled_at: null,
      created_at: now,
      updated_at: now,
      sales_channel: 'online',
    })
    .execute();
  await db
    .insertInto('attendees')
    .values({
      id: 'att_capacity',
      tenant_id: 'tnt_capacity',
      order_id: 'ord_capacity',
      event_id: 'evt_capacity',
      ticket_type_id: TARGET_TICKET_TYPE_ID,
      ticket_id: null,
      first_name: null,
      last_name: null,
      email: 'capacity@example.test',
      phone: null,
      status: 'confirmed',
      custom_answers: null,
      checked_in_at: null,
      check_in_device_id: null,
      event_occurrence_id: null,
      created_at: now,
      updated_at: now,
    })
    .execute();

  const ticketTypeForRow = (index: number): string =>
    index === 0 ? TARGET_TICKET_TYPE_ID : NOISE_TICKET_TYPE_ID;
  await db
    .insertInto('checkout_holds')
    .values(
      Array.from({ length: ROW_COUNT + 1 }, (_, index) => ({
        id: rowId('hld', index),
        inventory_pool_id: index === 0 ? 'inv_capacity_target' : 'inv_capacity_noise',
        checkout_session_id: 'cs_capacity',
        ticket_type_id: ticketTypeForRow(index),
        event_occurrence_id: null,
        quantity: 1,
        expires_at: later,
        status: 'active',
        created_at: now,
        updated_at: now,
      })),
    )
    .execute();
  await db
    .insertInto('order_line_items')
    .values(
      Array.from({ length: ROW_COUNT + 1 }, (_, index) => ({
        id: rowId('oli', index),
        order_id: 'ord_capacity',
        ticket_type_id: ticketTypeForRow(index),
        attendee_id: null,
        description: `Capacity line ${index}`,
        quantity: 1,
        unit_price_cents: 1000,
        subtotal_cents: 1000,
        discount_cents: 0,
        tax_cents: 0,
        fee_cents: 0,
        total_cents: 1000,
        currency: 'USD',
        event_occurrence_id: null,
        product_id: null,
        created_at: now,
        updated_at: now,
      })),
    )
    .execute();
  await db
    .insertInto('tickets')
    .values(
      Array.from({ length: ROW_COUNT + 1 }, (_, index) => ({
        id: rowId('tkt', index),
        tenant_id: 'tnt_capacity',
        order_id: 'ord_capacity',
        attendee_id: 'att_capacity',
        event_id: 'evt_capacity',
        ticket_type_id: ticketTypeForRow(index),
        event_occurrence_id: null,
        status: 'valid',
        code: rowId('code', index),
        qr_payload: rowId('payload', index),
        qr_hash: rowId('hash', index),
        transferred_to_email: null,
        transferred_at: null,
        checked_in_at: null,
        checked_in_by_device_id: null,
        wallet_pass_id: null,
        created_at: now,
        updated_at: now,
      })),
    )
    .execute();
  await db
    .insertInto('access_rules')
    .values(
      Array.from({ length: ROW_COUNT + 1 }, (_, index) => ({
        id: rowId('acr', index),
        ticket_type_id: ticketTypeForRow(index),
        type: 'code',
        value: rowId('rule', index),
        max_uses: null,
        uses_count: 0,
        expires_at: null,
        created_at: now,
        updated_at: now,
      })),
    )
    .execute();
  await db
    .insertInto('waitlist_entries')
    .values(
      Array.from({ length: ROW_COUNT + 1 }, (_, index) => ({
        id: rowId('wle', index),
        tenant_id: 'tnt_capacity',
        organization_id: 'org_capacity',
        brand_id: 'brd_capacity',
        event_id: 'evt_capacity',
        ticket_type_id: TARGET_TICKET_TYPE_ID,
        buyer_email: `capacity-${index}@example.test`,
        buyer_first_name: null,
        buyer_last_name: null,
        buyer_phone: null,
        quantity: 1,
        status: index === 0 ? 'joined' : 'cancelled',
        offer_expires_at: null,
        claim_token_hash: null,
        offered_at: null,
        claimed_at: null,
        cancelled_at: index === 0 ? null : now,
        reserved_checkout_session_id: null,
        reserved_until: null,
        created_at: now,
        updated_at: now,
      })),
    )
    .execute();
}

function recordsIn(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap((entry) => recordsIn(entry));
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  return [record, ...Object.values(record).flatMap((entry) => recordsIn(entry))];
}

async function explainProbe(
  db: Database,
  tableName: string,
  expectedIndexNames: string[],
  includeStatus = false,
): Promise<void> {
  await sql.raw(`analyze ${driver === 'mysql' ? 'table ' : ''}${tableName}`).execute(db);
  const predicate = includeStatus
    ? sql`ticket_type_id = ${TARGET_TICKET_TYPE_ID} and status in ('joined', 'offered')`
    : sql`ticket_type_id = ${TARGET_TICKET_TYPE_ID}`;
  const result =
    driver === 'mysql'
      ? await sql<Record<string, unknown>>`
          explain format=json
          select id from ${sql.table(tableName)} where ${predicate} limit 1
        `.execute(db)
      : await sql<Record<string, unknown>>`
          explain (analyze, buffers, format json)
          select id from ${sql.table(tableName)} where ${predicate} limit 1
        `.execute(db);
  const rawPlan = Object.values(result.rows[0] ?? {})[0];
  const plan = typeof rawPlan === 'string' ? (JSON.parse(rawPlan) as unknown) : rawPlan;
  const nodes = recordsIn(plan);
  if (driver === 'mysql') {
    const selected = nodes.find(
      (node) =>
        typeof node.key === 'string' &&
        expectedIndexNames.includes(node.key) &&
        Array.isArray(node.used_key_parts) &&
        node.used_key_parts[0] === 'ticket_type_id',
    );
    expect(selected, `MySQL did not select a ticket_type_id index for ${tableName}`).toBeDefined();
    return;
  }
  expect(nodes.some((node) => node['Node Type'] === 'Seq Scan')).toBe(false);
  const selected = nodes.find(
    (node) =>
      (node['Node Type'] === 'Index Scan' || node['Node Type'] === 'Index Only Scan') &&
      typeof node['Index Name'] === 'string' &&
      expectedIndexNames.includes(node['Index Name']),
  );
  expect(selected, `PostgreSQL did not select the expected index for ${tableName}`).toBeDefined();
}

(enabled ? describe.sequential : describe.skip)(
  `ticket-type batch hot-path index migration parity (real ${driver ?? 'database'})`,
  () => {
    let db: Database;
    let lockDb: Database;
    let lockLifetime: Promise<void> | undefined;
    let releaseLock: (() => void) | undefined;
    let previousDriver: string | undefined;

    beforeAll(async () => {
      assertDedicatedMigrationDatabase(primaryUrl!, migrationTestUrl!);
      previousDriver = process.env.DB_DRIVER;
      process.env.DB_DRIVER = driver!;
      db = createDb(migrationTestUrl);
      lockDb = createDb(migrationTestUrl);
      let lockReady: (() => void) | undefined;
      const ready = new Promise<void>((resolve) => {
        lockReady = resolve;
      });
      const hold = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      lockLifetime = lockDb.connection().execute(async (connection) => {
        if (driver === 'mysql') {
          const acquired = await sql<{ acquired: number | string }>`
            select get_lock('tixkit-migration-test-database', 30) as acquired
          `.execute(connection);
          if (Number(acquired.rows[0]?.acquired) !== 1) {
            throw new Error('Timed out acquiring the shared MySQL migration-test lock');
          }
        } else {
          await sql`select pg_advisory_lock(hashtext('tixkit-migration-test-database'))`.execute(
            connection,
          );
        }
        lockReady?.();
        await hold;
        if (driver === 'mysql') {
          await sql`select release_lock('tixkit-migration-test-database')`.execute(connection);
        } else {
          await sql`select pg_advisory_unlock(hashtext('tixkit-migration-test-database'))`.execute(
            connection,
          );
        }
      });
      await Promise.race([ready, lockLifetime]);
      await dropAllTables(db);
      const migration = await new Migrator({
        db,
        provider: new TixkitMigrationProvider(),
      }).migrateTo('0098_ticket_listing_pagination_index');
      expect(migration.error).toBeUndefined();
    }, 120_000);

    afterAll(async () => {
      let dropFailure: unknown;
      try {
        if (db) await dropAllTables(db);
      } catch (error) {
        dropFailure = error;
      }
      releaseLock?.();
      const cleanup = await Promise.allSettled([lockLifetime, db?.destroy(), lockDb?.destroy()]);
      if (previousDriver === undefined) delete process.env.DB_DRIVER;
      else process.env.DB_DRIVER = previousDriver;
      const failures = cleanup
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason);
      if (dropFailure !== undefined) failures.unshift(dropFailure);
      if (failures.length > 0) {
        throw new AggregateError(failures, 'Ticket-type hot-path migration-test cleanup failed');
      }
    }, 120_000);

    it('rejects drift, repairs partial states, rolls back, and reapplies without changing FKs', async () => {
      const migrator = new Migrator({ db, provider: new TixkitMigrationProvider() });
      const up = await migrator.migrateTo('0099_ticket_type_batch_hot_path_indexes');
      expect(up.error).toBeUndefined();
      await expectDependencyIndexState(db, true);
      await TicketTypeDependencyIndexesMigration.up(db);

      const down = await migrator.migrateTo('0098_ticket_listing_pagination_index');
      expect(down.error).toBeUndefined();
      await expectDependencyIndexState(db, false);
      await TicketTypeDependencyIndexesMigration.down!(db);

      const partialTable = driver === 'mysql' ? 'access_rules' : 'checkout_holds';
      const partialOwnedIndex =
        driver === 'mysql'
          ? 'idx_access_rules_ticket_type_id'
          : 'idx_checkout_holds_ticket_type_id';
      await createIndex(db, partialTable, partialOwnedIndex, ['ticket_type_id']);
      await TicketTypeDependencyIndexesMigration.up(db);
      await expectDependencyIndexState(db, true);
      if (driver === 'mysql') {
        if ((await indexColumns(db, 'access_rules', 'access_rules_ticket_type_fk')).length > 0) {
          await dropIndex(db, 'access_rules', 'access_rules_ticket_type_fk');
        }
        await expect(
          indexColumns(db, 'access_rules', 'access_rules_ticket_type_fk'),
        ).resolves.toEqual([]);
      }
      await TicketTypeDependencyIndexesMigration.down!(db);
      if (driver === 'mysql') {
        await expect(
          indexColumns(db, 'access_rules', 'access_rules_ticket_type_fk'),
        ).resolves.toEqual(['ticket_type_id']);
        await expect(
          indexColumns(db, 'access_rules', 'idx_access_rules_ticket_type_id'),
        ).resolves.toEqual([]);
        await expect(
          db
            .insertInto('access_rules')
            .values({
              id: 'acr_missing_parent',
              ticket_type_id: 'tt_missing_parent',
              type: 'code',
              value: 'missing-parent',
              max_uses: null,
              uses_count: 0,
              expires_at: null,
              created_at: new Date('2026-07-22T00:00:00.000Z'),
              updated_at: new Date('2026-07-22T00:00:00.000Z'),
            })
            .execute(),
        ).rejects.toBeDefined();
        await expect(foreignKeyNames(db)).resolves.toEqual([...foreignKeys].sort());
      }

      await createIndex(db, 'checkout_holds', 'idx_checkout_holds_ticket_type_id', ['id']);
      await expect(TicketTypeDependencyIndexesMigration.up(db)).rejects.toThrow(
        'expected an ordinary visible valid B-tree on [ticket_type_id]',
      );
      if (
        driver === 'mysql' &&
        (await indexColumns(db, 'checkout_holds', 'checkout_holds_ticket_type_fk')).length === 0
      ) {
        await createIndex(db, 'checkout_holds', 'checkout_holds_ticket_type_fk', [
          'ticket_type_id',
        ]);
      }
      await dropIndex(db, 'checkout_holds', 'idx_checkout_holds_ticket_type_id');

      await createIndex(
        db,
        'checkout_holds',
        'idx_checkout_holds_ticket_type_id',
        ['ticket_type_id'],
        true,
      );
      await expect(TicketTypeDependencyIndexesMigration.up(db)).rejects.toThrow(
        'expected an ordinary visible valid B-tree on [ticket_type_id]',
      );
      if (
        driver === 'mysql' &&
        (await indexColumns(db, 'checkout_holds', 'checkout_holds_ticket_type_fk')).length === 0
      ) {
        await createIndex(db, 'checkout_holds', 'checkout_holds_ticket_type_fk', [
          'ticket_type_id',
        ]);
      }
      await dropIndex(db, 'checkout_holds', 'idx_checkout_holds_ticket_type_id');

      if (driver === 'postgres') {
        await sql`
          create index idx_checkout_holds_ticket_type_id
          on checkout_holds (ticket_type_id)
          where status = 'active'
        `.execute(db);
      } else {
        await createIndex(db, 'checkout_holds', 'idx_checkout_holds_ticket_type_id', [
          'ticket_type_id',
        ]);
        await sql`
          alter table checkout_holds alter index idx_checkout_holds_ticket_type_id invisible
        `.execute(db);
      }
      await expect(TicketTypeDependencyIndexesMigration.up(db)).rejects.toThrow(
        'expected an ordinary visible valid B-tree on [ticket_type_id]',
      );
      await dropIndex(db, 'checkout_holds', 'idx_checkout_holds_ticket_type_id');

      await TicketTypeDependencyIndexesMigration.up(db);
      await expectDependencyIndexState(db, true);
    }, 120_000);

    it('selects the leading ticket-type indexes for cardinality-heavy dependency probes', async () => {
      await seedPlanFixture(db);
      for (const [tableName, ownedIndexName] of indexes) {
        const eligibleIndexes = await leadingTicketTypeIndexes(db, tableName);
        if (driver === 'postgres') expect(eligibleIndexes).toContain(ownedIndexName);
        else expect(eligibleIndexes.length).toBeGreaterThan(0);
        await explainProbe(db, tableName, eligibleIndexes);
      }
      await explainProbe(db, 'waitlist_entries', ['idx_waitlist_entries_ticket_status'], true);
    }, 120_000);
  },
);
