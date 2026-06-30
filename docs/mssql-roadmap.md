# MSSQL Database Support

Tixkit supports PostgreSQL as the reference database, MySQL as a tier-1 parity target, and an initial Microsoft SQL Server target for enterprise deployments.

## Configuration

Use `DB_DRIVER=mssql` with `DATABASE_URL_MSSQL`:

```bash
DB_DRIVER=mssql
DATABASE_URL_MSSQL=sqlserver://<user>:<password>@<host>:1433/<database>?encrypt=true&trustServerCertificate=false
```

The MSSQL URL parser also accepts `mssql://`. The driver uses `tedious` through Kysely's `MssqlDialect`, with `tarn` for pooling.

## Implemented Surface

The MSSQL support code lives in `packages/db/src/dialects/mssql.ts`.

Implemented helpers:

| Helper                    | Purpose                                                                |
| ------------------------- | ---------------------------------------------------------------------- |
| `parseMssqlConnectionUrl` | Parses SQL Server URLs into tedious-compatible connection settings.    |
| `createMssqlDialect`      | Creates a Kysely MSSQL dialect backed by `tedious`.                    |
| `createMssqlLimitPlugin`  | Rewrites select `.limit()` nodes to SQL Server `TOP` / `OFFSET FETCH`. |
| `mssqlObjectIdExists`     | Generates `OBJECT_ID()` existence checks for migration helpers.        |
| `mssqlDropTableIfExists`  | Generates SQL Server-safe conditional table drops.                     |
| `buildMssqlMergeUpsert`   | Generates `MERGE` SQL for upsert semantics.                            |
| `mssqlForUpdateTable`     | Produces `WITH (UPDLOCK, HOLDLOCK)` table hints for row-locking reads. |
| `executeMssqlForUpdate`   | Executes a raw locked read through Kysely.                             |

`packages/db/src/client.ts` recognizes:

- `DB_DRIVER=mssql`
- `DB_DRIVER=sqlserver`
- `DATABASE_URL_MSSQL`
- `mssql://...`
- `sqlserver://...`

## Migration Notes

SQL Server does not support every PostgreSQL/MySQL migration idiom. MSSQL migrations should use:

- `IF EXISTS` checks for destructive operations.
- `OBJECT_ID()` checks for table existence.
- explicit foreign-key cleanup order when resetting schemas.
- `MERGE` for upsert behavior instead of PostgreSQL `ON CONFLICT` or MySQL `ON DUPLICATE KEY UPDATE`.
- `WITH (UPDLOCK, HOLDLOCK)` where Tixkit needs `SELECT ... FOR UPDATE` semantics.

## Validation

Local validation evidence:

```bash
bun run --filter @tixkit/db typecheck
bun run --filter @tixkit/db test:unit
bun run --filter @tixkit/db lint
```

Run the gated DB integration suite against a SQL Server instance:

```bash
DB_INTEGRATION_DRIVER=mssql \
DATABASE_URL_MSSQL=<sqlserver-connection-url> \
bun run --filter @tixkit/db test:mssql
```

CI includes a gated `integration-tests-mssql` job. It only runs when `RUN_MSSQL_TESTS` is enabled because the SQL Server container is heavier than the default Postgres/MySQL services. The current parity proof (migrations applied and DB integration suite passing on SQL Server) is recorded against backlog item C-055 in `docs/completion/backlog.md`.

## Scope

The MSSQL target provides dialect construction, migrations, reset/truncate helpers, correctness-critical SQL helpers, and core DB integration coverage against SQL Server. Broader API/workflow/E2E MSSQL matrices can be expanded if production customers select SQL Server as their primary database.
