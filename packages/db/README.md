# `@tixkit/db`

## Purpose

Kysely database client, dialects, migrations, generated table types, and tenant-aware repositories.

## Consumers

API routes, workflows, CLI setup/seed commands, and integration tests.

## Status

Private persistence boundary; migrations are forward-applied operational artifacts.

## Installation

Add it as a `workspace:*` dependency; configure the selected database before creating a client.

## Example

`const db = createDatabase({ connectionString: process.env.DATABASE_URL! });`

## Public exports

Root client/types/repositories plus `./repositories`, `./migrations`, and `./migrate` subpaths.

## Runtime

Node.js 22+ with PostgreSQL, MySQL, or SQL Server drivers.

## Configuration

`DATABASE_URL` and `DB_DRIVER`; migration/reset commands use the same database environment. Reset commands are development-only.

## Security

Always scope repository calls by tenant, organization, and brand; use parameterized Kysely queries and least-privilege database credentials.

## Validation

`bun run --filter @tixkit/db typecheck && bun run --filter @tixkit/db lint && bun run --filter @tixkit/db test:unit && bun run --filter @tixkit/db test:integration`

## Compatibility

Schema and repository changes require migrations and parity across supported dialect integration tiers.

## Related guides

[Database operations](../../docs/public/self-hosting/databases.mdx)
