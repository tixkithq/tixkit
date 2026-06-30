# Tixkit

**A headless, white-label engine for event ticketing and commerce.**

Tixkit gives you everything you need to sell tickets, run checkout, fulfill orders, and check people in at the door, exposed as a clean API with first-class SDKs, an embeddable widget, hosted pages, and a self-hostable admin dashboard. Own your data, your branding, and your stack.

![License: see export](https://img.shields.io/badge/License-see%20export-blue.svg)
![Bun](https://img.shields.io/badge/Bun-%3E%3D1.3-black)
![Node](https://img.shields.io/badge/Node-%3E%3D20-339933)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6)
![OpenAPI](https://img.shields.io/badge/OpenAPI-3.1-6BA539)
![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)

---

## Table of contents

- [Why Tixkit](#why-tixkit)
- [Features](#features)
- [Architecture](#architecture)
- [Quickstart](#quickstart)
- [Configuration](#configuration)
- [Use the API and SDKs](#use-the-api-and-sdks)
- [Embed the checkout widget](#embed-the-checkout-widget)
- [Webhooks](#webhooks)
- [Deploy and self-host](#deploy-and-self-host)
- [Testing and quality](#testing-and-quality)
- [Documentation](#documentation)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

---

## Why Tixkit

- **Headless first.** Every capability is an API call. Build your own storefront, or use the hosted checkout and event pages that ship in the box.
- **White-label by design.** Multi-tenant with organization and brand scoping, so one deployment can serve many organizers under their own branding.
- **Self-hostable.** Docker images, a Helm chart, and a one-command local quickstart. No vendor lock-in, no required SaaS.
- **Batteries included.** Inventory, promotions, refunds, transfers, QR check-in, offline scanning, Apple and Google Wallet passes, exports, and analytics are all built in.
- **Typed and contract-driven.** A single OpenAPI 3.1 spec drives generated client contracts and framework/native SDK surfaces that stay in parity with the API.
- **Durable by default.** Money, inventory, fulfillment, and webhook side effects run through Temporal workflows so they are idempotent and recoverable.

---

## Features

### Ticketing and inventory

- Ticket types: free, paid, donation, hidden, locked, tiered, and access-code based.
- Capacity limits, shared inventory pools, min/max order rules, and oversell prevention.
- Waitlists and sold-out handling.
- Custom checkout questions and per-attendee data capture.

### Pricing and promotions

- Promo codes, discount redemptions, and access codes.
- Referral and affiliate primitives.
- Tax and fee primitives with all-in pricing support.

### Checkout and payments

- Hosted checkout flow and public event pages.
- Stripe payments, including Connect for multi-account payouts.
- Local capture/mock mode so you can build and test checkout without live keys.
- Refunds, voids, ticket transfers, and ticket resend.

### Entry and fulfillment

- Signed QR tickets, check-in, and scan logs.
- Offline scanner manifests for door entry without connectivity.
- Apple Wallet and Google Wallet pass generation.
- Scanner device registration and check-in lists.

### Distribution

- Embeddable checkout widget with inline, modal, and redirect modes.
- SDKs for JavaScript, Next.js, SvelteKit, Vue/Nuxt, Astro, Remix, React Native, Flutter, iOS, Android, Go, and Rust.
- Generated client contracts kept in parity with the OpenAPI spec.

### Operations and growth

- Import and export for attendees, orders, reports, and operational data.
- Basic analytics: sales, attendance, conversion, tax, promo, and affiliate reporting.
- Email and SMS via bring-your-own transport adapters (provider-agnostic).
- Message campaigns, delivery logs, and suppression handling.

### Developer platform

- Fastify API with a single OpenAPI 3.1 specification.
- Signed webhooks, API keys, and OAuth applications.
- Multi-tenant model: tenant, organization, and brand scoping on every resource.
- Pluggable authentication: a zero-config dev mode, plus Clerk and generic OIDC.
- Postgres as the reference database and MySQL as a tier-1 tested parity database.

---

## Architecture

Tixkit is a Bun + Turborepo monorepo. Apps are runnable surfaces; packages are the reusable engine and integrations.

```
tixkit/
├─ apps/
│  ├─ admin-dashboard/      Next.js admin for organizers and self-hosters
│  ├─ checkout/             Hosted checkout and public event pages
│  └─ sdk-*-demo/           Runnable demos for each framework SDK
├─ packages/
│  ├─ api/                  Fastify API, auth, route modules, provider webhooks
│  ├─ db/                   Kysely client, migrations, repositories (Postgres + MySQL)
│  ├─ domain/               Shared domain types and business rules
│  ├─ workflows/            Temporal workflows, activities, and worker
│  ├─ email-transport/      Provider-agnostic email/SMS adapters
│  ├─ openapi/              OpenAPI spec and generated-client contract tests
│  ├─ widget/               Embeddable browser widget bundle
│  ├─ cli/                  Developer CLI: quickstart, setup checks, local webhooks
│  ├─ shared/               Shared utilities
│  └─ sdk-*/                JS, framework, mobile, Go, and Rust SDK surfaces
├─ infra/                   docker-compose, Helm chart, and operational scripts
├─ e2e/                     Playwright end-to-end suites
└─ docs/                    Self-host, deploy, API, SDK, and operations guides
```

**Core stack:** Bun, TypeScript, Fastify, Next.js, Kysely, Temporal, Zod, OpenAPI 3.1, Playwright. Local infrastructure runs on Postgres, MySQL, Redis, Temporal, and MinIO (S3-compatible) via Docker Compose.

---

## Quickstart

### Prerequisites

- [Bun](https://bun.sh) `>= 1.3`
- [Node.js](https://nodejs.org) `>= 20`
- Docker (Docker Desktop or a Docker daemon)

### One command

```bash
# 1. Clone and enter the repository
git clone https://github.com/your-org/tixkit.git
cd tixkit

# 2. Install dependencies
bun install

# 3. Create your local environment file
cp .env.local.example .env.local

# 4. Start everything: infra + API + worker + checkout + admin, then seed sample data
bun run quickstart
```

`bun run quickstart` checks Docker and required ports, starts Postgres, MySQL, Redis, Temporal, and MinIO, runs migrations, boots the API, worker, checkout, and admin, waits for health checks, seeds sample data, and opens the admin dashboard. Use `--no-open` to skip opening the browser and `--skip-seed` to start without sample data.

Once it is running:

| Surface         | URL                   |
| --------------- | --------------------- |
| Admin dashboard | http://localhost:3001 |
| Hosted checkout | http://localhost:3000 |
| API             | http://localhost:4000 |
| Temporal UI     | http://localhost:8080 |
| MinIO console   | http://localhost:9001 |

### Manual steps

Prefer to run pieces yourself? The quickstart maps to:

```bash
bun run infra:up            # start Postgres, MySQL, Redis, Temporal, MinIO
bun run setup:check         # validate .env.local
bun run db:migrate          # run Postgres migrations
bun run db:migrate:mysql    # optional: MySQL parity migrations
bun run dev:all             # run API (4000), worker, checkout (3000), admin (3001)
bun run seed:sample-data    # optional: load demo brand, event, and tickets
```

Stop infrastructure with `bun run infra:down`.

---

## Configuration

All local configuration lives in `.env.local`, seeded from `.env.local.example`. Run `bun run setup:check` to validate it, or `bun run setup:check --mode production` to validate production readiness.

Highlights:

- **Authentication** (`AUTH_PROVIDER`): defaults to `dev` in development, which creates a deterministic local principal plus a seeded tenant, organization, and brand. Use `clerk` or `oidc` for real deployments. The `dev` path fails closed outside development.
- **Payments** (Stripe): leave keys empty to run in capture/mock mode for local development. Provide test keys to exercise the real provider flow.
- **Signing secrets**: `QR_SIGNING_SECRET`, `OFFLINE_MANIFEST_SIGNING_KEY`, and `WIDGET_IMPRESSION_HASH_SECRET` are required in production.
- **Wallet passes**: Apple and Google Wallet are disabled by default locally and fail closed in production if enabled without signing material.
- **Storage**: S3-compatible, pointing at local MinIO by default.

See [`docs/pluggable-auth-guide.md`](docs/pluggable-auth-guide.md) and [`docs/clerk-setup-guide.md`](docs/clerk-setup-guide.md) for auth, and the [deploy guide](docs/deploy-guide.md) for production configuration.

---

## Use the API and SDKs

The API is served under `/v1` (for example, `http://localhost:4000/v1`). The fastest way to call it is an official SDK.

| Package                | Install                        | Use it for                            |
| ---------------------- | ------------------------------ | ------------------------------------- |
| `@tixkit/js`           | `bun add @tixkit/js`           | Core client, server and browser-safe  |
| `@tixkit/next`         | `bun add @tixkit/next`         | Next.js apps                          |
| `@tixkit/sveltekit`    | `bun add @tixkit/sveltekit`    | SvelteKit apps                        |
| `@tixkit/vue`          | `bun add @tixkit/vue`          | Vue and Nuxt apps                     |
| `@tixkit/astro`        | `bun add @tixkit/astro`        | Astro sites                           |
| `@tixkit/remix`        | `bun add @tixkit/remix`        | Remix apps                            |
| `@tixkit/react-native` | `bun add @tixkit/react-native` | React Native scanner and ticket flows |
| Flutter                | `packages/sdk-flutter`         | Flutter apps                          |
| iOS (Swift)            | `packages/sdk-ios`             | Native iOS apps                       |
| Android (Kotlin)       | `packages/sdk-android`         | Native Android apps                   |
| Go                     | `packages/sdk-go`              | Go backend integrators                |
| Rust                   | `packages/sdk-rust`            | Rust backend integrators              |

Example with the core JavaScript SDK:

```ts
import { TixkitClient } from '@tixkit/js';

const tixkit = new TixkitClient({
  apiKey: process.env.TIXKIT_API_KEY,
  apiBaseUrl: 'http://localhost:4000/v1',
});

// List events
const events = await tixkit.events.list();

// Start a checkout session
const session = await tixkit.checkout.create({
  eventId: events.data[0].id,
  items: [{ ticketTypeId: 'tt_general', quantity: 2 }],
});

console.log(session.url);
```

Secret API keys are server-only; the SDK refuses to use them in a browser runtime. Full, framework-specific guides live in [`docs/sdk-guides`](docs/sdk-guides/README.md), and the complete endpoint reference is in [`docs/api-reference.md`](docs/api-reference.md).

---

## Embed the checkout widget

Drop tickets into any website with a single custom element. No build step required.

```html
<script type="module" src="http://localhost:3000/tixkit-widget.js"></script>

<tixkit-widget brand="brand_demo" event="evt_demo" checkout-mode="inline"></tixkit-widget>
```

Modes are `inline` (sandboxed iframe in the page), `modal` (shadow-DOM modal), and `redirect` (navigate to hosted checkout). See the [widget embed guide](docs/widget-embed-guide.md) and the [embed generator](docs/embed-generator.html).

---

## Webhooks

Tixkit emits signed webhooks for order, payment, fulfillment, and lifecycle events. Develop against them locally with:

```bash
bun run dev:webhooks
```

Signature verification helpers ship in the SDKs. See the [webhook guide](docs/webhook-guide.md).

---

## Deploy and self-host

- **Containers:** `Dockerfile.api`, `Dockerfile.admin`, `Dockerfile.checkout`, and `Dockerfile.worker`.
- **Kubernetes:** a Helm chart in `infra/helm/tixkit`. Lint it with `bun run iac:lint` and render it with `bun run iac:template`.
- **Databases:** Postgres is the reference engine; MySQL is a tier-1, tested parity engine. See [`docs/managed-database-compatibility.md`](docs/managed-database-compatibility.md).
- **Guides:** [deploy guide](docs/deploy-guide.md), [production deployment guide](docs/production-deployment-guide.md), [Temporal operations](docs/temporal-operations-guide.md), and [incident runbooks](docs/incident-runbooks.md).

---

## Testing and quality

```bash
bun run typecheck     # TypeScript across the monorepo
bun run lint          # oxlint
bun run test          # unit + integration (Postgres and MySQL)
bun run test:e2e      # Playwright on Chromium, Firefox, and WebKit (with accessibility checks)
```

End-to-end suites run across three browsers and include accessibility assertions. Integration tests run against both Postgres and MySQL to keep database parity honest.

---

## Documentation

- [API reference](docs/api-reference.md)
- [Admin dashboard user guide](docs/admin-dashboard-user-guide.md)
- [SDK guides](docs/sdk-guides/README.md)
- [Widget embed guide](docs/widget-embed-guide.md)
- [Webhook guide](docs/webhook-guide.md)
- [Pluggable auth guide](docs/pluggable-auth-guide.md)
- [Deploy guide](docs/deploy-guide.md) and [production deployment guide](docs/production-deployment-guide.md)
- [Managed database compatibility](docs/managed-database-compatibility.md)
- [Email and SMS deliverability runbook](docs/email-sms-deliverability-runbook.md)
- [Accessibility conformance statement](docs/accessibility-conformance-statement.md)
- [Privacy and retention policy](docs/privacy-retention-policy.md)
- [Security and tenant isolation audit](docs/security-tenant-isolation-audit.md)

---

## Roadmap

Tixkit is actively developed. Recent releases shipped internationalization and localized checkout/templates, box-office and point-of-sale sales, paid ticket resale, configurable scanning code formats, advanced fraud and Stripe Radar controls, email/SMS personalization, link shortening, first-class Go and Rust integrator SDKs, and a multi-channel content studio for event pages, email, and SMS.

Genuinely near-term areas include additional payment providers (PayPal, then Adyen and Square in the managed tier), more channel adapters (such as WhatsApp, iMessage, and social invites), and further integrator SDKs. Contributions in these areas are especially welcome.

---

## Contributing

Contributions are welcome. Before opening a pull request:

1. Read [`AGENTS.md`](AGENTS.md) for repository conventions and workflow.
2. Match the existing code style and keep API, OpenAPI, SDKs, and tests in sync within a single change.
3. Run the gates locally: `bun run format:check`, `bun run typecheck`, `bun run lint`, `bun run test`, and `bun run test:e2e`.

---

## License

This private development tree is `UNLICENSED`. The sanitized public OSS export generated by `bun run export:oss` rewrites public package metadata to MIT and injects the export `LICENSE`.
