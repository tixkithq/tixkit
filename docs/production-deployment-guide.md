# Production Deployment Guide

This guide covers the services, environment variables, migrations, workers, and monitoring required to run GateKit in production.

The local development contract is defined in `.env.local.example`, `package.json`, and `infra/docker-compose.yml`. Production uses the same code paths with production-grade managed equivalents for each dependency.

## Required Services

| Service | Purpose | Local equivalent | Production recommendation |
| --- | --- | --- | --- |
| PostgreSQL 16 | Primary database (gatekit schema) | `infra/docker-compose.yml` `postgres` | Managed Postgres (RDS, Cloud SQL, Aurora) with backups and PITR |
| MySQL 8.4 | Tier-1 secondary DB tested in CI | `infra/docker-compose.yml` `mysql` | Optional; only required if you deploy against MySQL |
| Redis 7 | Rate-limit backing, export SSE fanout | `infra/docker-compose.yml` `redis` | Managed Redis (ElastiCache, Memorystore) |
| Temporal 1.24 | Workflow engine | `infra/docker-compose.yml` `temporal` | Temporal Cloud or self-hosted Temporal with managed Postgres |
| Temporal UI (optional) | Workflow inspection | `infra/docker-compose.yml` `temporal-ui` | Internal-only UI behind auth |
| S3-compatible object storage | Export files, future upload artifacts | `infra/docker-compose.yml` `minio` | S3, GCS via S3 API, R2 |
| Clerk | Admin auth and identity sync | dev mode (no keys) | Clerk production instance |
| Stripe | Payments (Stripe Connect) | capture/mock mode | Stripe live keys + Connect |
| Telnyx | SMS transport | capture/mock mode | Telnyx production keys |
| Email transport | Transactional + bulk email | capture adapter | Provider route in `email_provider_routes` |

The API, worker, checkout app, and admin dashboard are the four deployable GateKit processes. They can be co-located or deployed independently behind a load balancer.

## Environment Variables

Copy `.env.local.example` as the starting point. Required-for-production variables:

### Core

| Variable | Required | Description |
| --- | --- | --- |
| `NODE_ENV` | yes | `production` |
| `PORT` | yes (API) | API listen port, default `4000` |
| `LOG_LEVEL` | no | `info` recommended |
| `API_BASE_URL` | yes | Public API origin, e.g. `https://api.example.com` |
| `NEXT_PUBLIC_GATEKIT_API_BASE_URL` | yes (checkout) | Public API origin with `/v1` suffix |
| `NEXT_PUBLIC_ADMIN_API_BASE_URL` | yes (admin) | Public API origin |

### Datastores

| Variable | Required | Description |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres connection string |
| `DATABASE_URL_MYSQL` | no | MySQL connection string (Tier-1 deployments) |
| `REDIS_URL` | yes | Redis connection string |

### Temporal

| Variable | Required | Description |
| --- | --- | --- |
| `TEMPORAL_ADDRESS` | yes | Temporal cluster address, e.g. `mycluster.tmprl.cloud:7233` |
| `TEMPORAL_NAMESPACE` | yes | Temporal namespace, e.g. `mytenant.production` |

### Auth (Clerk)

See [Clerk Setup Guide](./clerk-setup-guide.md). Required in production:

| Variable | Required | Description |
| --- | --- | --- |
| `CLERK_SECRET_KEY` | yes | Clerk backend secret key |
| `CLERK_PUBLISHABLE_KEY` | yes | Clerk publishable key |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | yes (admin) | Same publishable key, exposed to browser |
| `CLERK_WEBHOOK_SECRET` | yes | Svix signing secret for Clerk webhooks |

### Payments (Stripe)

| Variable | Required | Description |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` | yes | Stripe secret key (live or test) |
| `STRIPE_WEBHOOK_SECRET` | yes | Stripe webhook signing secret |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | yes (checkout) | Stripe publishable key for Elements |

Leave Stripe keys empty to run in capture/mock mode (no real provider calls). This is useful for staging without Stripe credentials.

### SMS (Telnyx)

| Variable | Required | Description |
| --- | --- | --- |
| `TELNYX_API_KEY` | no | Telnyx API key for outbound SMS |
| `TELNYX_WEBHOOK_PUBLIC_KEY` | yes (prod) | Telnyx Ed25519 public key for webhook verification. In production, missing key returns `503`. |

See `docs/telnyx-sms-local.md` for fallback providers (Twilio, Vonage, Plivo) and capture testing.

### Object Storage

| Variable | Required | Description |
| --- | --- | --- |
| `S3_ENDPOINT` | yes | S3-compatible endpoint |
| `S3_BUCKET` | yes | Bucket name |
| `S3_ACCESS_KEY_ID` | yes | Access key |
| `S3_SECRET_ACCESS_KEY` | yes | Secret key |
| `S3_REGION` | yes | Region, e.g. `us-east-1` |

## Migrations

Run database migrations before starting the API or worker:

```bash
bun run db:migrate          # Postgres
bun run db:migrate:mysql    # MySQL (if used)
```

Migrations are idempotent and safe to re-run. Apply migrations in a release pipeline step before rolling new code. The worker depends on the migrated schema for activity writes; running the worker against a stale schema will surface SQL errors in activity retries.

## Process Topology

| Process | Command (local) | Port | Purpose |
| --- | --- | --- | --- |
| API | `bun run dev:api` | `4000` | REST API, inbound webhooks |
| Worker | `bun run dev:worker` | n/a | Temporal worker on `gatekit` task queue |
| Checkout | `bun run dev:checkout` | `3000` | Hosted checkout + widget assets |
| Admin | `bun run dev:admin` | `3001` | Admin dashboard |

In production, run the API and worker as separate processes so they can scale and roll independently. The checkout and admin apps are static Next.js builds served by your CDN or Node server.

### Worker deploy checklist

1. Set `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `DATABASE_URL`, `REDIS_URL`.
2. Deploy the worker image.
3. Confirm the worker logs show `Worker started` (no startup diagnostic).
4. Confirm the `hold-expiration:scheduled` workflow is running in Temporal UI.
5. Run a smoke checkout (free order) and verify the `checkout-session:<id>` workflow completes.

See [Temporal Operations Guide](./temporal-operations-guide.md) for versioning and replay safety during worker rollouts.

## Inbound Webhooks

Configure provider webhooks to point at the API:

| Provider | URL | Signature header |
| --- | --- | --- |
| Clerk | `https://api.example.com/v1/webhooks/clerk` | Svix `svix-signature` |
| Stripe | `https://api.example.com/v1/webhooks/stripe` | `stripe-signature` |
| Telnyx | `https://api.example.com/v1/webhooks/telnyx/sms` | `telnyx-signature-ed25519` |

All three handlers store the provider event before processing and skip duplicates by provider event ID. If the API is down, the provider's own retry policy will redeliver; GateKit's idempotency handles the replay.

## Health Checks

- `GET /health` returns `200 { "status": "ok", "timestamp": "..." }` with no auth. Use this for load balancer and container health checks.
- Worker health: monitor process liveness and Temporal worker metrics. The worker exits non-zero on startup failure with an actionable diagnostic.
- Checkout/admin: standard Next.js health checks; both should render their entry shell without crashing.

## Monitoring

Recommended alerts:

| Signal | Source | Action |
| --- | --- | --- |
| `GET /health` non-200 | uptime probe | Page on-call |
| API 5xx rate | Fastify logs / APM | Investigate `requestId` |
| Worker startup failure | process exit / logs | Check Temporal + DB reachability |
| `workflow_failed` | Temporal metrics | Inspect failing workflow type in UI |
| `activity_failed` rate | Temporal metrics | Inspect activity + downstream provider |
| Dead-lettered webhook deliveries | `webhook_deliveries.status = 'dead_lettered'` | Triage endpoint and replay |
| Stripe webhook signature failures | API logs | Verify `STRIPE_WEBHOOK_SECRET` rotation |
| Idempotency conflicts | API logs | Investigate client retry behavior |

Tail Fastify logs with `pino-pretty` in dev and structured JSON in production. Each request log includes `requestId` for tracing across services.

## Security Checklist

- Never commit real secrets. Rotate any real keys that touch `.env.local` before sharing.
- `.env.local` is gitignored; `.env.local.example` is tracked with placeholders only.
- Use HTTPS for all public endpoints. The API rejects `javascript:`, `data:`, and `file:` URL schemes in checkout `successUrl`/`cancelUrl`; production requires `https:`.
- Restrict Temporal UI and admin dashboard to internal networks or authenticated access.
- Rotate Clerk, Stripe, and Telnyx keys on a schedule and after personnel changes.
- Enforce API key scopes and revocation from the admin Developer settings.
- See `docs/security-tenant-isolation-audit.md` for the tenant isolation audit.

## Smoke Test After Deploy

```bash
# API health
curl -f https://api.example.com/health

# Public event (replace with a real published event ID)
curl https://api.example.com/v1/public/events/evt_smoke

# Authenticated principal
curl https://api.example.com/v1/me -H "Authorization: Bearer <clerk-jwt>"

# Complete a free checkout through the checkout app, then verify the order and webhook delivery
```

Confirm in Temporal UI that the `checkout-session:<id>` workflow completed and the `order.paid` webhook delivery succeeded.
