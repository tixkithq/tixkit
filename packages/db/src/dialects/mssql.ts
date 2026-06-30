import {
  FetchNode,
  MssqlDialect,
  OperationNodeTransformer,
  sql,
  TopNode,
  ValueNode,
  type Kysely,
  type KyselyPlugin,
  type PluginTransformQueryArgs,
  type PluginTransformResultArgs,
  type QueryResult,
  type RootOperationNode,
  type SelectQueryNode,
  type UnknownRow,
} from 'kysely';
import * as Tarn from 'tarn';
import * as Tedious from 'tedious';

type MssqlConnectionOptions = {
  server: string;
  port: number;
  userName: string;
  password: string;
  database: string;
  encrypt: boolean;
  trustServerCertificate: boolean;
};

export type MssqlUpsertInput = {
  table: string;
  targetAlias?: string;
  sourceAlias?: string;
  keyColumns: string[];
  insertColumns: string[];
  updateColumns: string[];
};

export function parseMssqlConnectionUrl(url: string): MssqlConnectionOptions {
  const parsed = new URL(url);
  if (parsed.protocol !== 'sqlserver:' && parsed.protocol !== 'mssql:') {
    throw new Error('MSSQL URL must use sqlserver:// or mssql://');
  }

  const database = parsed.pathname.replace(/^\//, '');
  if (!database) {
    throw new Error('MSSQL URL must include a database name');
  }

  return {
    server: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 1433,
    userName: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database,
    encrypt: parsed.searchParams.get('encrypt') !== 'false',
    trustServerCertificate: parsed.searchParams.get('trustServerCertificate') === 'true',
  };
}

export function createMssqlDialect(url: string): MssqlDialect {
  const options = parseMssqlConnectionUrl(url);
  return new MssqlDialect({
    tarn: {
      ...Tarn,
      options: {
        min: 0,
        max: Number(process.env.MSSQL_POOL_MAX ?? 10),
      },
    },
    tedious: {
      ...Tedious,
      connectionFactory: () =>
        new Tedious.Connection({
          authentication: {
            type: 'default',
            options: {
              userName: options.userName,
              password: options.password,
            },
          },
          server: options.server,
          options: {
            database: options.database,
            port: options.port,
            encrypt: options.encrypt,
            trustServerCertificate: options.trustServerCertificate,
          },
        }),
    },
  });
}

class MssqlLimitTransformer extends OperationNodeTransformer {
  protected override transformSelectQuery(
    node: SelectQueryNode,
    queryId?: Parameters<OperationNodeTransformer['transformNode']>[1],
  ): SelectQueryNode {
    const transformed = super.transformSelectQuery(node, queryId);
    if (!transformed.limit) return transformed;

    const limitNode = transformed.limit.limit;
    if (!ValueNode.is(limitNode)) {
      throw new Error('MSSQL select limits must be numeric literals');
    }

    const limit = limitNode.value;
    if (typeof limit !== 'number' && typeof limit !== 'bigint') {
      throw new Error('MSSQL select limits must be numeric literals');
    }

    return transformed.offset
      ? { ...transformed, limit: undefined, fetch: FetchNode.create(limit, 'only') }
      : { ...transformed, limit: undefined, top: TopNode.create(limit) };
  }
}

export function createMssqlLimitPlugin(): KyselyPlugin {
  const transformer = new MssqlLimitTransformer();

  return {
    transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
      return transformer.transformNode(args.node);
    },
    async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
      return args.result;
    },
  };
}

export function mssqlObjectIdExists(objectName: string): string {
  return `OBJECT_ID(N'${escapeSqlString(objectName)}', N'U') IS NOT NULL`;
}

export function mssqlDropTableIfExists(tableName: string): string {
  return `IF ${mssqlObjectIdExists(tableName)} DROP TABLE ${quoteMssqlIdentifierPath(tableName)};`;
}

export function mssqlForUpdateTable(tableName: string, alias?: string): string {
  const table = quoteMssqlIdentifierPath(tableName);
  return alias
    ? `${table} AS ${quoteMssqlIdentifier(alias)} WITH (UPDLOCK, HOLDLOCK)`
    : `${table} WITH (UPDLOCK, HOLDLOCK)`;
}

export function buildMssqlMergeUpsert(input: MssqlUpsertInput): string {
  if (input.keyColumns.length === 0) {
    throw new Error('MSSQL upsert requires at least one key column');
  }
  if (input.insertColumns.length === 0) {
    throw new Error('MSSQL upsert requires at least one insert column');
  }

  const targetAlias = input.targetAlias ?? 'target';
  const sourceAlias = input.sourceAlias ?? 'source';
  const target = quoteMssqlIdentifier(targetAlias);
  const source = quoteMssqlIdentifier(sourceAlias);
  const keyPredicate = input.keyColumns
    .map(
      (column) =>
        `${target}.${quoteMssqlIdentifier(column)} = ${source}.${quoteMssqlIdentifier(column)}`,
    )
    .join(' AND ');
  const updateSet = input.updateColumns
    .map((column) => `${quoteMssqlIdentifier(column)} = ${source}.${quoteMssqlIdentifier(column)}`)
    .join(', ');
  const insertColumns = input.insertColumns.map(quoteMssqlIdentifier).join(', ');
  const insertValues = input.insertColumns
    .map((column) => `${source}.${quoteMssqlIdentifier(column)}`)
    .join(', ');

  return [
    `MERGE INTO ${quoteMssqlIdentifierPath(input.table)} AS ${target}`,
    `USING (SELECT ${input.insertColumns.map((column) => `@${column} AS ${quoteMssqlIdentifier(column)}`).join(', ')}) AS ${source}`,
    `ON ${keyPredicate}`,
    updateSet ? `WHEN MATCHED THEN UPDATE SET ${updateSet}` : undefined,
    `WHEN NOT MATCHED THEN INSERT (${insertColumns}) VALUES (${insertValues});`,
  ]
    .filter(Boolean)
    .join('\n');
}

export async function executeMssqlForUpdate<T>(
  db: Kysely<unknown>,
  tableName: string,
  whereSql: string,
): Promise<T[]> {
  const result =
    await sql<T>`SELECT * FROM ${sql.raw(mssqlForUpdateTable(tableName))} WHERE ${sql.raw(whereSql)}`.execute(
      db,
    );
  return result.rows;
}

function quoteMssqlIdentifier(identifier: string): string {
  return `[${identifier.replaceAll(']', ']]')}]`;
}

function quoteMssqlIdentifierPath(path: string): string {
  return path.split('.').map(quoteMssqlIdentifier).join('.');
}

function escapeSqlString(value: string): string {
  return value.replaceAll("'", "''");
}
