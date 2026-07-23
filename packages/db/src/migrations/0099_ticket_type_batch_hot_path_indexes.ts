import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

type IndexDefinition = {
  columns: string[];
  ordinaryBtree: boolean;
  state: string;
};

const INDEXES = [
  [
    'checkout_holds',
    'idx_checkout_holds_ticket_type_id',
    ['ticket_type_id'],
    'checkout_holds_ticket_type_fk',
  ],
  [
    'order_line_items',
    'idx_order_line_items_ticket_type_id',
    ['ticket_type_id'],
    'order_line_items_ticket_type_fk',
  ],
  ['tickets', 'idx_tickets_ticket_type_id', ['ticket_type_id'], 'tickets_ticket_type_fk'],
  [
    'access_rules',
    'idx_access_rules_ticket_type_id',
    ['ticket_type_id'],
    'access_rules_ticket_type_fk',
  ],
] as const;

const WAITLIST_INDEX = [
  'waitlist_entries',
  'idx_waitlist_entries_ticket_status',
  ['ticket_type_id', 'status', 'created_at'],
] as const;

function numericFlag(value: boolean | number | string): boolean {
  return value === true || Number(value) === 1;
}

async function indexDefinition(
  db: Kysely<unknown>,
  tableName: string,
  indexName: string,
): Promise<IndexDefinition | undefined> {
  if (process.env.DB_DRIVER === 'mysql') {
    const result = await sql<{
      columnName: string;
      indexType: string;
      isVisible: string;
      nonUnique: number | string;
      subPart: number | null;
    }>`
      select column_name as columnName,
             index_type as indexType,
             is_visible as isVisible,
             non_unique as nonUnique,
             sub_part as subPart
      from information_schema.statistics
      where table_schema = database()
        and table_name = ${tableName}
        and index_name = ${indexName}
      order by seq_in_index
    `.execute(db);
    const first = result.rows[0];
    if (!first) return undefined;
    return {
      columns: result.rows.map((row) => row.columnName),
      ordinaryBtree:
        first.indexType.toUpperCase() === 'BTREE' &&
        first.isVisible.toUpperCase() === 'YES' &&
        numericFlag(first.nonUnique) &&
        result.rows.every((row) => row.subPart === null),
      state: `type=${first.indexType}, visible=${first.isVisible}, nonUnique=${first.nonUnique}, prefix=${result.rows.some((row) => row.subPart !== null)}`,
    };
  }
  if (process.env.DB_DRIVER === 'mssql') {
    const result = await sql<{
      columnName: string;
      hasFilter: boolean | number;
      isDisabled: boolean | number;
      isHypothetical: boolean | number;
      isIncluded: boolean | number;
      isUnique: boolean | number;
      typeDescription: string;
    }>`
      select col.name as columnName,
             idx.type_desc as typeDescription,
             idx.is_unique as isUnique,
             idx.has_filter as hasFilter,
             idx.is_disabled as isDisabled,
             idx.is_hypothetical as isHypothetical,
             ic.is_included_column as isIncluded
      from sys.indexes idx
      join sys.index_columns ic
        on ic.object_id = idx.object_id
       and ic.index_id = idx.index_id
      join sys.columns col
        on col.object_id = ic.object_id
       and col.column_id = ic.column_id
      where idx.object_id = object_id(${tableName})
        and idx.name = ${indexName}
      order by ic.is_included_column, ic.key_ordinal, ic.index_column_id
    `.execute(db);
    const first = result.rows[0];
    if (!first) return undefined;
    return {
      columns: result.rows
        .filter((row) => !numericFlag(row.isIncluded))
        .map((row) => row.columnName),
      ordinaryBtree:
        first.typeDescription === 'NONCLUSTERED' &&
        !numericFlag(first.isUnique) &&
        !numericFlag(first.hasFilter) &&
        !numericFlag(first.isDisabled) &&
        !numericFlag(first.isHypothetical) &&
        result.rows.every((row) => !numericFlag(row.isIncluded)),
      state: `type=${first.typeDescription}, unique=${first.isUnique}, filter=${first.hasFilter}, disabled=${first.isDisabled}, hypothetical=${first.isHypothetical}`,
    };
  }
  const result = await sql<{
    accessMethod: string;
    columnName: string;
    isReady: boolean;
    isUnique: boolean;
    isValid: boolean;
    predicate: string | null;
  }>`
    select attribute.attname as "columnName",
           access_method.amname as "accessMethod",
           index_definition.indisunique as "isUnique",
           index_definition.indisvalid as "isValid",
           index_definition.indisready as "isReady",
           pg_get_expr(index_definition.indpred, index_definition.indrelid) as predicate
    from pg_class index_relation
    join pg_index index_definition on index_definition.indexrelid = index_relation.oid
    join pg_class table_relation on table_relation.oid = index_definition.indrelid
    join pg_namespace table_namespace on table_namespace.oid = table_relation.relnamespace
    join pg_am access_method on access_method.oid = index_relation.relam
    join lateral unnest(index_definition.indkey) with ordinality as key(attnum, ordinal)
      on true
    join pg_attribute attribute
      on attribute.attrelid = table_relation.oid
     and attribute.attnum = key.attnum
    where table_relation.relname = ${tableName}
      and table_namespace.nspname = current_schema()
      and index_relation.relname = ${indexName}
    order by key.ordinal
  `.execute(db);
  const first = result.rows[0];
  if (!first) return undefined;
  return {
    columns: result.rows.map((row) => row.columnName),
    ordinaryBtree:
      first.accessMethod === 'btree' &&
      !first.isUnique &&
      first.isValid &&
      first.isReady &&
      first.predicate === null,
    state: `method=${first.accessMethod}, unique=${first.isUnique}, valid=${first.isValid}, ready=${first.isReady}, predicate=${first.predicate ?? 'none'}`,
  };
}

function assertIndexDefinition(
  tableName: string,
  indexName: string,
  actual: IndexDefinition,
  expectedColumns: readonly string[],
): void {
  if (
    actual.columns.length !== expectedColumns.length ||
    actual.columns.some((column, index) => column !== expectedColumns[index]) ||
    !actual.ordinaryBtree
  ) {
    throw new Error(
      `Index ${indexName} on ${tableName} has columns [${actual.columns.join(', ')}] and state [${actual.state}], expected an ordinary visible valid B-tree on [${expectedColumns.join(', ')}]`,
    );
  }
}

async function mysqlHasEquivalentLeadingIndex(
  db: Kysely<unknown>,
  tableName: string,
  firstColumn: string,
  excludedIndexName?: string,
): Promise<boolean> {
  if (process.env.DB_DRIVER !== 'mysql') return false;
  const result = await sql<{
    indexName: string;
    indexType: string;
    isVisible: string;
    nonUnique: number | string;
    subPart: number | null;
  }>`
    select index_name as indexName,
           index_type as indexType,
           is_visible as isVisible,
           non_unique as nonUnique,
           sub_part as subPart
    from information_schema.statistics
    where table_schema = database()
      and table_name = ${tableName}
      and seq_in_index = 1
      and column_name = ${firstColumn}
  `.execute(db);
  return result.rows.some(
    (row) =>
      row.indexType.toUpperCase() === 'BTREE' &&
      row.isVisible.toUpperCase() === 'YES' &&
      numericFlag(row.nonUnique) &&
      row.subPart === null &&
      row.indexName !== excludedIndexName,
  );
}

async function restoreMysqlForeignKeySupportIndex(
  db: Kysely<unknown>,
  tableName: string,
  ownedIndexName: string,
  supportIndexName: string,
  columns: readonly string[],
): Promise<void> {
  if (process.env.DB_DRIVER !== 'mysql') return;
  if (await mysqlHasEquivalentLeadingIndex(db, tableName, columns[0]!, ownedIndexName)) return;
  const existingSupport = await indexDefinition(db, tableName, supportIndexName);
  if (existingSupport) {
    assertIndexDefinition(tableName, supportIndexName, existingSupport, columns);
    return;
  }
  await db.schema
    .createIndex(supportIndexName)
    .on(tableName)
    .columns([...columns])
    .execute();
}

async function ensureIndex(
  db: Kysely<unknown>,
  tableName: string,
  indexName: string,
  columns: readonly string[],
): Promise<void> {
  const existing = await indexDefinition(db, tableName, indexName);
  if (existing) {
    assertIndexDefinition(tableName, indexName, existing, columns);
    return;
  }
  if (await mysqlHasEquivalentLeadingIndex(db, tableName, columns[0]!)) return;
  await db.schema
    .createIndex(indexName)
    .on(tableName)
    .columns([...columns])
    .execute();
}

async function dropOwnedIndex(
  db: Kysely<unknown>,
  tableName: string,
  indexName: string,
  columns: readonly string[],
): Promise<void> {
  const existing = await indexDefinition(db, tableName, indexName);
  if (!existing) return;
  assertIndexDefinition(tableName, indexName, existing, columns);
  if (process.env.DB_DRIVER === 'mysql') {
    await db.schema.dropIndex(indexName).on(tableName).execute();
    return;
  }
  if (process.env.DB_DRIVER === 'mssql') {
    await sql.raw(`drop index [${indexName}] on [${tableName}]`).execute(db);
    return;
  }
  await db.schema.dropIndex(indexName).execute();
}

async function assertWaitlistIndex(db: Kysely<unknown>): Promise<void> {
  const [tableName, indexName, columns] = WAITLIST_INDEX;
  const definition = await indexDefinition(db, tableName, indexName);
  if (!definition) {
    throw new Error(`Required pre-existing index ${indexName} on ${tableName} is missing`);
  }
  assertIndexDefinition(tableName, indexName, definition, columns);
}

export const TicketTypeDependencyIndexesMigration: Migration = {
  async up(db): Promise<void> {
    await assertWaitlistIndex(db);
    for (const [tableName, indexName, columns] of INDEXES) {
      // eslint-disable-next-line no-await-in-loop -- definitions are validated and created in deterministic migration order.
      await ensureIndex(db, tableName, indexName, columns);
    }
  },

  async down(db): Promise<void> {
    await assertWaitlistIndex(db);
    for (let index = INDEXES.length - 1; index >= 0; index -= 1) {
      const [tableName, indexName, columns, supportIndexName] = INDEXES[index]!;
      // eslint-disable-next-line no-await-in-loop -- MySQL may adopt an owned index as FK support, so an alternate support key is restored before removal.
      await restoreMysqlForeignKeySupportIndex(db, tableName, indexName, supportIndexName, columns);
      // eslint-disable-next-line no-await-in-loop -- owned indexes are removed in reverse deterministic order.
      await dropOwnedIndex(db, tableName, indexName, columns);
    }
  },
};
