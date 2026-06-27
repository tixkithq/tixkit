# Production Deployment Guide

This guide covers the services, environment variables, migrations, workers, and monitoring required to run Tixkit in production.

The local development contract is defined in `.env.local.example`, `package.json`, and `infra/docker-compose.yml`. Production uses the same code paths with production-grade managed equivalents for each dependency.

> Status (2026-06-27): C-019 infrastructure automation is now committed. `infra/helm/tixkit` renders API, worker, checkout, admin, migration hook, Postgres, Redis, Temporal, and MinIO resources. `infra/scripts` contains backup/restore, migration rehearsal, and release dry-run helpers. `.github/workflows/release-dry-run.yml` validates build, migrations, Helm render, and manifest smoke checks on PRs and pushes.

## Required Services

| Service | Purpose | Local equivalent | Production recommendation |
| --- | --- | --- | --- |
| PostgreSQL 16 | Primary database (tixkit schema) | `infra/docker-compose.yml` `postgres` | Managed Postgres (RDS, Cloud SQL, Aurora) with backups and PITR |
| MySQL 8.4 | Tier-1 secondary DB tested in CI | `infra/docker-compose.yml` `mysql` | Optional; only required if you deploy against MySQL |
| Redis 7 | Rate-limit backing, export SSE fanout | `infra/docker-compose.yml` `redis` | Managed Redis (ElastiCache, Memorystore) |
| Temporal 1.24 | Workflow engine | `infra/docker-compose.yml` `temporal` | Temporal Cloud or self-hosted Temporal with managed Postgres |
| Temporal UI (optional) | Workflow inspection | `infra/docker-compose.yml` `temporal-ui` | Internal-only UI behind auth |
| S3-compatible object storage | Export files, upload artifacts, branding assets, avatar assets | `infra/docker-compose.yml` `minio` | S3, GCS via S3 API, R2 |
| Clerk | Admin auth and identity sync | dev mode (no keys) | Clerk production instance |
| Stripe | Payments (Stripe Connect) | capture/mock mode | Stripe live keys + Connect, connected-account webhooks, and at least one onboarded charges-enabled test account for release validation |
| Telnyx | SMS transport | capture/mock mode | Telnyx production keys |
| Email transport | Transactional + bulk email | capture adapter | Provider route in `email_provider_routes` |
| OpenTelemetry collector | Trace collection | OTLP endpoint on `localhost:4318` if configured | Managed collector or vendor OTLP ingest |
| Prometheus | Metrics scrape | Internal API `GET /metrics`; optional Pushgateway for worker metrics | Prometheus-compatible scrape and alerting |

The API, worker, checkout app, and admin dashboard are the four deployable Tixkit processes. They can be co-located or deployed independently behind a load balancer.

## Infrastructure-As-Code

Tixkit ships a Helm chart at `infra/helm/tixkit`.

Local chart validation:

```bash
bun run iac:lint
bun run iac:template >/tmp/tixkit-rendered.yaml
```

Default chart values provision a portable single-node target:

- API deployment and service.
- Worker deployment.
- Checkout deployment and service.
- Admin deployment and service.
- Pre-install/pre-upgrade migration job.
- Postgres with PVC.
- Redis.
- Temporal plus its Postgres store.
- MinIO with PVC.
- Optional ingress for API, checkout, and admin hosts.

For production, prefer managed Postgres, Redis, Temporal Cloud, and object storage. Disable bundled backing services and point secrets at managed endpoints:

```bash
helm upgrade --install tixkit infra/helm/tixkit \
  --namespace tixkit \
  --create-namespace \
  --set postgres.enabled=false \
  --set redis.enabled=false \
  --set temporal.enabled=false \
  --set minio.enabled=false \
  --set secrets.create=false \
  --set secrets.name=tixkit-production-secrets
```

`tixkit-production-secrets` must contain the keys documented in this guide (`DATABASE_URL`, `REDIS_URL`, `TEMPORAL_ADDRESS`, provider keys, signing keys, and S3 credentials). Signing and provider secrets must come from a managed secret store; do not commit values files containing real secrets.

## Environment Variables

Copy `.env.local.example` as the starting point. Required-for-production variables:

### Core

| Variable | Required | Description |
| --- | --- | --- |
| `NODE_ENV` | yes | `production` |
| `PORT` | yes (API) | API listen port, default `4000` |
| `LOG_LEVEL` | no | `info` recommended |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | yes | OTLP HTTP collector base URL, e.g. `https://otel.example.com` |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | no | Explicit trace endpoint; overrides `<OTEL_EXPORTER_OTLP_ENDPOINT>/v1/traces` |
| `OTEL_SDK_DISABLED` | no | Set `true` only for local debugging |
| `PROMETHEUS_PUSHGATEWAY_URL` | no | Optional Pushgateway URL for worker activity metrics when workers cannot be scraped |
| `METRICS_BEARER_TOKEN` | yes | Bearer token required for API `GET /metrics` in production. Prometheus must send `Authorization: Bearer <token>`. |
| `API_BASE_URL` | yes | Public API origin, e.g. `https://api.example.com` |
| `NEXT_PUBLIC_TIXKIT_API_BASE_URL` | yes (checkout) | Public API origin with `/v1` suffix |
| `NEXT_PUBLIC_ADMIN_API_BASE_URL` | yes (admin) | Public API origin |
| `CORS_ALLOWED_ORIGINS` | yes | Comma-separated browser origins allowed to make credentialed API requests, e.g. checkout and admin origins |
| `TRUST_PROXY` | yes (behind ingress) | Fastify trusted proxy setting for `X-Forwarded-For`; use ingress/controller CIDRs or trusted hop count |

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

### Wallet Passes

Development skips wallet pass generation unless a provider is fully configured. Production fails closed for each enabled provider when signing keys are incomplete.

| Variable | Required | Description |
| --- | --- | --- |
| `APPLE_WALLET_ENABLED` | no | Set `false` only to intentionally disable Apple Wallet generation. Production defaults to enabled. |
| `APPLE_WALLET_PASS_TYPE_ID` | yes (Apple enabled) | Apple pass type identifier, e.g. `pass.com.example.tickets` |
| `APPLE_WALLET_TEAM_ID` | yes (Apple enabled) | Apple developer team identifier |
| `APPLE_WALLET_ORGANIZATION_NAME` | yes (Apple enabled) | Organization name shown in Apple Wallet |
| `APPLE_WALLET_SIGNER_CERT` | yes (Apple enabled) | PEM signer certificate; escaped `\n` is accepted |
| `APPLE_WALLET_SIGNER_KEY` | yes (Apple enabled) | PEM private key; escaped `\n` is accepted |
| `APPLE_WALLET_SIGNER_KEY_PASSPHRASE` | no | Private-key passphrase when the signer key is encrypted |
| `APPLE_WALLET_WWDR_CERT` | yes (Apple enabled) | Apple WWDR certificate PEM |
| `GOOGLE_WALLET_ENABLED` | no | Set `false` only to intentionally disable Google Wallet generation. Production defaults to enabled. |
| `GOOGLE_WALLET_ISSUER_ID` | yes (Google enabled) | Google Wallet issuer ID |
| `GOOGLE_WALLET_CLASS_SUFFIX` | yes (Google enabled) | Event ticket class suffix, e.g. `tixkit_event` |
| `GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL` | yes (Google enabled) | Service account email used as JWT issuer |
| `GOOGLE_WALLET_PRIVATE_KEY` | yes (Google enabled) | Service account RSA private key PEM; escaped `\n` is accepted |
| `GOOGLE_WALLET_ORIGIN` | yes (Google enabled) | Allowed save-link origin(s), comma-separated |

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
| `UPLOAD_MALWARE_SCANNER` | yes | `clamav` in production; `eicar` is only for local/test validation |
| `CLAMAV_HOST` | yes when `UPLOAD_MALWARE_SCANNER=clamav` | ClamAV TCP host |
| `CLAMAV_PORT` | no | ClamAV TCP port, defaults to `3310` |

## Migrations

Run database migrations before starting the API or worker:

```bash
bun run db:migrate          # Postgres
bun run db:migrate:mysql    # MySQL (if used)
```

Migrations are idempotent and safe to re-run. Apply migrations in a release pipeline step before rolling new code. The worker depends on the migrated schema for activity writes; running the worker against a stale schema will surface SQL errors in activity retries.

The Helm chart includes a pre-install/pre-upgrade migration job. The release dry-run workflow also validates migrations against Postgres and MySQL before rendering Kubernetes manifests.

### Migration Rollback / Forward Strategy

Tixkit migrations are forward-only Kysely migrations. Rollback is performed by restoring the pre-migration database backup, then redeploying the last known-good application image. This avoids unsafe partial down-migrations on commerce ledgers, payment events, inventory holds, refunds, and audit logs.

Required release procedure:

1. Create a fresh Postgres backup:
   ```bash
   DATABASE_URL=<postgres-url> BACKUP_DIR=backups/release bun run dr:backup:postgres
   ```
2. If deploying a MySQL Tier-1 target, snapshot the managed MySQL instance through the cloud provider before `db:migrate:mysql`.
3. Run the rehearsal:
   ```bash
   DATABASE_URL=<postgres-url> DATABASE_URL_MYSQL=<mysql-url> bun run dr:migration-rehearsal
   ```
4. Run forward migrations:
   ```bash
   bun run --env-file=.env.local db:migrate
   bun run --env-file=.env.local db:migrate:mysql
   ```
5. Deploy the new image set.
6. If rollback is required before new writes are accepted, restore the pre-migration backup:
   ```bash
   DATABASE_URL=<postgres-url> POSTGRES_BACKUP_FILE=<backup.dump> bun run dr:restore:postgres
   ```

After buyer traffic has reached the new schema, rollback by database restore is a disaster-recovery operation, not an application rollback. Preserve provider event IDs and replay webhooks after restore so Stripe/Clerk/Telnyx state catches up.

## Backup And Restore

### RPO/RTO Targets

| Data store | RPO target | RTO target | Mechanism |
| --- | --- | --- | --- |
| Postgres | 5 minutes | 30 minutes | Managed PITR plus `infra/scripts/backup-postgres.sh` before releases |
| MySQL Tier-1 deployment | 5 minutes | 30 minutes | Managed PITR/snapshot before releases |
| Object storage | 15 minutes | 60 minutes | Bucket versioning/replication plus `infra/scripts/backup-object-storage.sh` |
| Temporal visibility/history | 15 minutes | 60 minutes | Temporal Cloud managed retention or backing-store snapshots |

Postgres backup:

```bash
DATABASE_URL=<postgres-url> BACKUP_DIR=backups/postgres bun run dr:backup:postgres
```

Postgres restore:

```bash
DATABASE_URL=<postgres-url> POSTGRES_BACKUP_FILE=backups/postgres/tixkit-postgres-<timestamp>.dump bun run dr:restore:postgres
```

Object storage backup:

```bash
S3_ENDPOINT=<endpoint> \
S3_BUCKET=<bucket> \
S3_ACCESS_KEY_ID=<key> \
S3_SECRET_ACCESS_KEY=<secret> \
BACKUP_DIR=backups/object-storage \
bun run dr:backup:object-storage
```

Object storage restore:

```bash
S3_ENDPOINT=<endpoint> \
S3_BUCKET=<bucket> \
S3_ACCESS_KEY_ID=<key> \
S3_SECRET_ACCESS_KEY=<secret> \
OBJECT_STORAGE_BACKUP_FILE=backups/object-storage/tixkit-object-storage-<timestamp>.tar.gz \
bun run dr:restore:object-storage
```

Every backup script writes a `.sha256` file. Restore scripts verify checksums when the checksum file is present.

## Release Pipeline

The reproducible dry-run pipeline is:

```bash
bun run release:dry-run
```

CI runs the same release path through `.github/workflows/release-dry-run.yml`:

1. Install dependencies.
2. Build all packages/apps.
3. Run Postgres and MySQL migrations against disposable services.
4. Run `helm lint infra/helm/tixkit`.
5. Render the chart with `helm template`.
6. Smoke-check the rendered manifest for API, worker, checkout, and admin resources.
7. Upload the rendered manifest as an artifact.

Production rollout:

```bash
export IMAGE_TAG=<git-sha-or-release>
bun run iac:lint
helm upgrade --install tixkit infra/helm/tixkit \
  --namespace tixkit \
  --create-namespace \
  --set global.imageTag="${IMAGE_TAG}" \
  --values infra/helm/tixkit/values.production.yaml
kubectl rollout status deployment/tixkit-tixkit-api -n tixkit
kubectl rollout status deployment/tixkit-tixkit-worker -n tixkit
kubectl rollout status deployment/tixkit-tixkit-checkout -n tixkit
kubectl rollout status deployment/tixkit-tixkit-admin -n tixkit
```

Smoke after rollout:

```bash
curl -f https://api.example.com/health
kubectl -n tixkit run metrics-smoke --rm -i --restart=Never --image=curlimages/curl -- \
  curl -fsS -H "Authorization: Bearer ${METRICS_BEARER_TOKEN}" \
  http://tixkit-tixkit-api/metrics
```

## Process Topology

| Process | Command (local) | Port | Purpose |
| --- | --- | --- | --- |
| API | `bun run dev:api` | `4000` | REST API, inbound webhooks |
| Worker | `bun run dev:worker` | n/a | Temporal worker on `tixkit` task queue |
| Checkout | `bun run dev:checkout` | `3000` | Hosted checkout + widget assets |
| Admin | `bun run dev:admin` | `3001` | Admin dashboard |

In production, run the API and worker as separate processes so they can scale and roll independently. The checkout and admin apps are static Next.js builds served by your CDN or Node server.

## Observability

Tixkit emits three production signals:

- **Structured JSON logs** from the API and worker. Every API log line includes Fastify's `reqId`; error responses return the same `requestId`. Pino redaction censors authorization, cookie, signature, API key, token, secret, email, phone, buyer, attendee, and card fields.
- **OpenTelemetry traces** from the API, API-started Temporal workflow client calls, Temporal worker workflow/activity execution, Stripe provider activities, and outbound webhook delivery. Spans carry `tixkit.request_id`, `tixkit.tenant_id`, `tixkit.organization_ids`, `tixkit.brand_ids`, workflow IDs from Temporal, and provider operation fields.
- **Prometheus metrics** from `GET /metrics` on the API service. Production requires `METRICS_BEARER_TOKEN`; configure Prometheus to scrape the internal Kubernetes service with `Authorization: Bearer <token>`. The public API ingress blocks `/metrics` by default and must not be used as the scrape target. Worker activity metrics are held in-process and can be pushed by setting `PROMETHEUS_PUSHGATEWAY_URL`.

Required Prometheus series:

| Series | Purpose |
| --- | --- |
| `tixkit_http_request_duration_seconds` | HTTP latency by method, route, and status code |
| `tixkit_http_request_errors_total` | HTTP 5xx responses |
| `tixkit_checkout_events_total` | Checkout API/workflow events |
| `tixkit_payment_events_total` | Payment provider/API events |
| `tixkit_refund_events_total` | Refund provider/API events |
| `tixkit_webhook_events_total` | Inbound and outbound webhook events |
| `tixkit_export_events_total` | Export API/workflow events |
| `tixkit_scan_events_total` | Check-in and scanner events |
| `tixkit_inventory_active_holds` | Active, non-expired inventory hold quantity |
| `tixkit_temporal_activity_events_total` | Temporal activity completions by activity and outcome |
| `tixkit_temporal_activity_duration_seconds` | Temporal activity latency by activity and outcome |

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

All three handlers store the provider event before processing and skip duplicates by provider event ID. If the API is down, the provider's own retry policy will redeliver; Tixkit's idempotency handles the replay.

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
- Retain audit logs, privacy request ledgers, financial records, invoices, tax snapshots, and provider events according to [Privacy Retention Policy](./privacy-retention-policy.md). Erasure workflows redact buyer/attendee PII without deleting commerce ledgers.
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
