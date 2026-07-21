import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

type IndexDefinition = {
  columns: string[];
  ordinaryBtree: boolean;
  state: string;
};

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
    }>`
      select column_name as columnName,
             index_type as indexType,
             is_visible as isVisible,
             non_unique as nonUnique
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
        numericFlag(first.nonUnique),
      state: `type=${first.indexType}, visible=${first.isVisible}, nonUnique=${first.nonUnique}`,
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
  expected: readonly string[],
): void {
  if (
    actual.columns.length !== expected.length ||
    actual.columns.some((column, index) => column !== expected[index]) ||
    !actual.ordinaryBtree
  ) {
    throw new Error(
      `Index ${indexName} on ${tableName} has columns [${actual.columns.join(', ')}] and state [${actual.state}], expected an ordinary visible valid B-tree on [${expected.join(', ')}]`,
    );
  }
}

async function ensureIndex(
  db: Kysely<unknown>,
  input: { columns: string[]; name: string; table: string },
): Promise<void> {
  const existingDefinition = await indexDefinition(db, input.table, input.name);
  if (existingDefinition) {
    assertIndexDefinition(input.table, input.name, existingDefinition, input.columns);
    return;
  }
  await db.schema.createIndex(input.name).on(input.table).columns(input.columns).execute();
}

async function dropIndex(
  db: Kysely<unknown>,
  tableName: string,
  indexName: string,
  expectedColumns: readonly string[],
): Promise<void> {
  const actualDefinition = await indexDefinition(db, tableName, indexName);
  if (!actualDefinition) return;
  assertIndexDefinition(tableName, indexName, actualDefinition, expectedColumns);
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

export const ProductCatalogPaginationIndexesMigration: Migration = {
  async up(db): Promise<void> {
    await ensureIndex(db, {
      name: 'idx_product_categories_event_id',
      table: 'product_categories',
      columns: ['event_id', 'id'],
    });
    await ensureIndex(db, {
      name: 'idx_products_event_id',
      table: 'products',
      columns: ['event_id', 'id'],
    });
    if (process.env.DB_DRIVER === 'mysql') {
      await dropIndex(db, 'product_categories', 'product_categories_event_fk', ['event_id']);
      await dropIndex(db, 'products', 'products_event_fk', ['event_id']);
    }
  },

  async down(db): Promise<void> {
    if (process.env.DB_DRIVER === 'mysql') {
      await ensureIndex(db, {
        name: 'product_categories_event_fk',
        table: 'product_categories',
        columns: ['event_id'],
      });
      await ensureIndex(db, {
        name: 'products_event_fk',
        table: 'products',
        columns: ['event_id'],
      });
    }
    await dropIndex(db, 'products', 'idx_products_event_id', ['event_id', 'id']);
    await dropIndex(db, 'product_categories', 'idx_product_categories_event_id', [
      'event_id',
      'id',
    ]);
  },
};
