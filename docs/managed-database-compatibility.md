# Managed Database Compatibility

Tixkit supports PostgreSQL (reference) and MySQL (Tier 1) via Kysely. This document lists managed database providers that work via connection string, along with operational caveats.

## PostgreSQL (Reference Driver)

### Supported Providers

| Provider | Format | Caveats |
| --- | --- | --- |
| Neon | `postgres://` + `<user>:<password>@<host>/db?sslmode=require` | Serverless compute; use pooled connection endpoint for API/worker |
| Supabase | `postgresql://` + `<user>:<password>@<host>:6543/db?sslmode=require` | Use connection pooler port 6543 for API/worker |
| Aurora Serverless v2 | `postgres://` + `<user>:<password>@<cluster-host>:5432/db` | Enable Data API for serverless; standard JDBC/PG for persistent |
| Google Cloud SQL | `postgres://` + `<user>:<password>@<host>:5432/db?sslmode=require` | Use Cloud SQL Auth Proxy for local dev |
| Azure Database for PostgreSQL | `postgres://` + `<user>:<password>@<host>:5432/db?sslmode=require` | Flexible server recommended |

### Configuration

Set `DATABASE_URL` to the managed provider connection string and `DB_DRIVER=postgres` (default).

### Connection Pooling

Use PgBouncer or the provider's built-in pooler (Neon pooled endpoint, Supabase pooler port). Tixkit's Kysely dialect uses a connection pool; ensure the managed pooler supports prepared statements or use session mode.

## MySQL (Tier 1 Driver)

### Supported Providers

| Provider | Format | Caveats |
| --- | --- | --- |
| PlanetScale | `mysql://` + `<user>:<password>@<host>/db` | **Does not enforce foreign keys** — see caveat below |
| Aurora Serverless v2 MySQL | `mysql://` + `<user>:<password>@<cluster-host>:3306/db` | Enable HTTP proxy for serverless |
| Google Cloud SQL for MySQL | `mysql://` + `<user>:<password>@<host>:3306/db` | Use Cloud SQL Auth Proxy for local dev |
| Azure Database for MySQL | `mysql://` + `<user>:<password>@<host>:3306/db` | Flexible server recommended |

### Configuration

Set `DATABASE_URL_MYSQL` to the managed provider connection string and `DB_DRIVER=mysql` to switch the primary driver.

### PlanetScale Foreign Key Caveat

PlanetScale does not enforce foreign key constraints by default. Tixkit's schema relies heavily on foreign keys for referential integrity across tenants, organizations, brands, events, tickets, orders, and attendees. Using PlanetScale without foreign key enforcement risks orphaned records and data corruption.

**Recommendation**: Use PlanetScale only with an explicit foreign key compatibility mode or compensating application-level validation. For production deployments requiring referential integrity, prefer Neon, Supabase, Aurora, or Google Cloud SQL.

## SSL/TLS Requirements

Managed databases typically require SSL/TLS connections. Set `sslmode=require` in the PostgreSQL connection string or configure SSL in the MySQL connection options. Tixkit's Kysely dialect passes connection string options through to the underlying driver.

## Migration Guidance

Run `bun run db:migrate` with the managed database connection string. For zero-downtime migrations on managed databases:
- Use online schema changes where supported (Neon, Aurora)
- Test migrations on a staging instance first
- For MySQL, use `pt-online-schema-change` or `gh-ost` for large tables

## Environment Variables

| Variable | Description | Default |
| --- | --- | --- |
| `DATABASE_URL` | PostgreSQL connection string | Local dev default uses localhost |
| `DATABASE_URL_MYSQL` | MySQL connection string (required when `DB_DRIVER=mysql`) | Local dev default uses localhost |
| `DB_DRIVER` | Primary database driver: `postgres` or `mysql` | `postgres` |
| `DB_INTEGRATION_DRIVER` | Integration test database driver | `postgres` |
