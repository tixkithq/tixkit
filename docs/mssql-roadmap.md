# MSSQL Database Support Roadmap

Tixkit supports PostgreSQL (reference) and MySQL (Tier 1) via Kysely. This document outlines the roadmap for adding Microsoft SQL Server (MSSQL) as a third production database target.

## Motivation

Enterprise Windows-shop environments often standardize on MSSQL. Adding MSSQL support widens Tixkit's enterprise deployability without requiring customers to adopt PostgreSQL or MySQL.

## Implementation Plan

### 1. Dialect Construction

Add a MSSQL Kysely dialect using the `tedious` driver. MSSQL uses `[]` for identifier quoting and `TOP` instead of `LIMIT`.

```typescript
import { MssqlDialect } from 'kysely';
import tedious from 'tedious';

const dialect = new MssqlDialect({
  connection: {
    server: host,
    options: { port, database, encrypt: true },
    authentication: { type: 'default', options: { userName, password } },
  },
});
```

### 2. Migrations

MSSQL does not support `CREATE TABLE IF NOT EXISTS`. Migrations must use `IF EXISTS` checks or `OBJECT_ID()` queries. The migration runner needs MSSQL-specific SQL generation.

### 3. Upsert Behavior

MSSQL uses `MERGE` for upserts, which has different syntax from PostgreSQL's `ON CONFLICT` and MySQL's `ON DUPLICATE KEY UPDATE`. The Kysely `onConflict` API does not map to `MERGE`; a custom upsert helper is needed.

### 4. Transactional Locking

MSSQL uses `WITH (UPDLOCK, HOLDLOCK)` for `SELECT ... FOR UPDATE` semantics. Kysely's `forUpdate()` does not generate this; a custom locking helper is needed.

### 5. Reset/Cleanup

MSSQL reset scripts must drop tables in dependency order (respecting foreign keys) or use `DROP TABLE ... CASCADE` equivalent.

### 6. CI

Add a `test:mssql` provider job that runs correctness-critical suites against MSSQL in CI. Use a Docker-based MSSQL or Azure SQL Edge for local testing.

## Coordination with Phase 3

C-055 requires modifying `packages/db/` (dialect, migrations, repositories). These are Phase 3-owned surfaces. Phase 4 will provide the roadmap and design; Phase 3 will implement the dialect and migration helpers.

## Status

- **Design**: This document
- **Implementation**: Pending Phase 3 coordination
- **Priority**: P2 (after Postgres/MySQL surface is stable)
