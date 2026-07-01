# Deployment Guide

Tixkit is a monorepo with four runtime apps (API, worker, checkout, admin-dashboard) and requires PostgreSQL, Redis, Temporal, and S3-compatible storage. This guide covers deploying to Railway, Fly.io, and Render.

## Prerequisites

- Node.js 22+ and Bun 1.3+
- A managed PostgreSQL instance (Neon, Supabase, Aurora, or equivalent)
- A managed Redis instance (Upstash, Redis Cloud, or equivalent)
- A Temporal cluster (Temporal Cloud, or self-hosted via Docker)
- An S3-compatible storage service (AWS S3, MinIO, Cloudflare R2)

## Environment Variables

All four apps share these core variables. See `.env.local.example` for the full list.

| Variable                | Required   | Description                             |
| ----------------------- | ---------- | --------------------------------------- |
| `DATABASE_URL`          | Yes        | PostgreSQL connection string            |
| `REDIS_URL`             | Yes        | Redis connection string                 |
| `TEMPORAL_ADDRESS`      | Yes        | Temporal cluster address                |
| `TEMPORAL_NAMESPACE`    | Yes        | Temporal namespace (default: `default`) |
| `S3_ENDPOINT`           | Yes        | S3-compatible storage endpoint          |
| `S3_BUCKET`             | Yes        | S3 bucket name                          |
| `S3_ACCESS_KEY_ID`      | Yes        | S3 access key                           |
| `S3_SECRET_ACCESS_KEY`  | Yes        | S3 secret key                           |
| `CLERK_SECRET_KEY`      | Yes (prod) | Clerk secret key                        |
| `STRIPE_SECRET_KEY`     | Yes (prod) | Stripe secret key                       |
| `STRIPE_WEBHOOK_SECRET` | Yes (prod) | Stripe webhook signing secret           |
| `PORT`                  | No         | API port (default: 4000)                |

Auth provider selection:

| Variable          | Required  | Description                                                         |
| ----------------- | --------- | ------------------------------------------------------------------- |
| `AUTH_PROVIDER`   | No        | `clerk`, `dev`, or `oidc`. Defaults to `clerk` outside development. |
| `OIDC_ISSUER_URL` | OIDC only | Issuer URL for self-hosted OIDC auth.                               |
| `OIDC_AUDIENCE`   | OIDC only | Expected API audience for OIDC JWTs.                                |

Database target selection:

| Variable             | Required   | Description                                                                 |
| -------------------- | ---------- | --------------------------------------------------------------------------- |
| `DB_DRIVER`          | No         | `postgres`, `mysql`, or `mssql`. Defaults from the configured database URL. |
| `DATABASE_URL_MSSQL` | MSSQL only | SQL Server connection string for `DB_DRIVER=mssql`.                         |

## Docker Images

Root Dockerfiles are provided for the four deployable processes:

| Process  | Dockerfile            | Default start command                             |
| -------- | --------------------- | ------------------------------------------------- |
| API      | `Dockerfile.api`      | `bun run --filter @tixkit/api start`              |
| Worker   | `Dockerfile.worker`   | `bun run --filter @tixkit/workflows start:worker` |
| Checkout | `Dockerfile.checkout` | `bun run --filter @tixkit/checkout start`         |
| Admin    | `Dockerfile.admin`    | `bun run --filter @tixkit/admin-dashboard start`  |

Each image uses `oven/bun:1.3`, installs workspace dependencies with the frozen lockfile, builds the workspace, and starts the target app. Validate syntax locally with:

```bash
docker build --check -f Dockerfile.api .
docker build --check -f Dockerfile.worker .
docker build --check -f Dockerfile.checkout .
docker build --check -f Dockerfile.admin .
```

## Railway

Railway supports monorepo deployments via Nixpacks. Each app gets its own service.

1. Create a new Railway project from your Tixkit repository.
2. Add services for each app:
   - **API**: Build from root, start command `bun run --filter @tixkit/api start`
   - **Worker**: Build from root, start command `bun run --filter @tixkit/workflows start:worker`
   - **Checkout**: Build from root, start command `bun run --filter @tixkit/checkout start`
   - **Admin**: Build from root, start command `bun run --filter @tixkit/admin-dashboard start`
3. Add managed PostgreSQL and Redis from Railway's database marketplace.
4. Set all environment variables in each service.
5. Run migrations: `bun run db:migrate` as a one-off command.
6. Deploy and verify health endpoints.

## Fly.io

Fly.io deploys via `fly.toml` per app. See `infra/fly/api.toml`, `infra/fly/worker.toml`, `infra/fly/checkout.toml`, and `infra/fly/admin.toml` for templates.

1. Install the Fly CLI: `curl -L https://fly.io/install.sh | sh`
2. Create apps:
   ```sh
   fly apps create tixkit-api
   fly apps create tixkit-worker
   fly apps create tixkit-checkout
   fly apps create tixkit-admin
   ```
3. Set secrets for each app:
   ```sh
   fly secrets set --app tixkit-api DATABASE_URL="..." REDIS_URL="..." TEMPORAL_ADDRESS="..."
   ```
4. Deploy each app:
   ```sh
   fly deploy --config infra/fly/api.toml
   fly deploy --config infra/fly/worker.toml
   fly deploy --config infra/fly/checkout.toml
   fly deploy --config infra/fly/admin.toml
   ```
5. Run migrations: `fly ssh console --app tixkit-api --command "bun run db:migrate"`

## Render

Render supports monorepo deployments via `render.yaml`. See `infra/render.yaml` for the blueprint.

1. Connect your Tixkit repository to Render.
2. Use the blueprint at `infra/render.yaml` to create all services.
3. Let the blueprint create managed PostgreSQL and Key Value resources.
4. Set environment variables in each service.
5. Run migrations as a render shell command.

## Post-Deploy Smoke Validation

After deploying, verify:

1. **API health**: `curl https://your-api-url/health` returns 200
2. **Checkout health**: `curl https://your-checkout-url/health` returns 200
3. **Admin health**: `curl https://your-admin-url/` returns 200
4. **Migrations**: `bun run db:migrate` completes without errors
5. **Temporal connectivity**: Worker logs show successful Temporal connection
6. **S3 connectivity**: Upload and retrieve a test file

## Managed Services

### PostgreSQL

See [Managed Database Compatibility](./managed-database-compatibility.md) for supported providers and caveats.

### Redis

- **Upstash**: Serverless Redis, TLS-enabled, compatible with `REDIS_URL=rediss://...`
- **Redis Cloud**: Managed Redis with auto-scaling
- **Self-hosted**: Use the Docker Compose Redis for development

### Temporal

- **Temporal Cloud**: Managed Temporal service
- **Self-hosted**: Deploy Temporal via Docker or Kubernetes using the official Helm chart

### S3-Compatible Storage

- **AWS S3**: Standard S3 with IAM credentials
- **Cloudflare R2**: S3-compatible, no egress fees
- **MinIO**: Self-hosted S3-compatible storage
