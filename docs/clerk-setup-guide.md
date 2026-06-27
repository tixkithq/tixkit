# Clerk Setup Guide

Tixkit uses [Clerk](https://clerk.com) for admin dashboard authentication, organization/tenant mapping, and identity synchronization. This guide covers dashboard auth, API auth, organizations, webhooks, metadata limits, and key rotation.

The Clerk integration lives in `packages/api/src/auth/clerk.ts` and the webhook handler in `packages/api/src/routes/modules/clerk-webhooks.ts`. The admin dashboard uses `@clerk/nextjs` (see `apps/admin-dashboard`).

## Local Development Without Clerk

The admin dashboard renders without Clerk keys using a deterministic local-dev principal. Leave these env vars empty in `.env.local` to enable local dev mode:

```
CLERK_SECRET_KEY=
CLERK_PUBLISHABLE_KEY=
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=
CLERK_WEBHOOK_SECRET=
```

In this mode, the dashboard uses fixture/local state for empty screens and the API accepts the local principal. **Local dev mode never grants production access** and must not be enabled in deployed environments.

## Local Development With Clerk

When `NODE_ENV=development` and Clerk keys are configured, Tixkit verifies the Clerk session normally. If the verified Clerk user does not yet have a `user_profiles` row, the API auto-provisions that user into the deterministic local development tenant and organization with local-dev permissions. This keeps dev Clerk sign-in usable without requiring public Clerk webhooks or a completed Temporal identity-sync run on every workstation.

Production does not use this path. Outside `NODE_ENV=development`, missing `user_profiles` rows still fail closed with `401 User profile not found. Identity sync may be pending.`

## Production Configuration

### 1. Create a Clerk application

Create a Clerk app in the dashboard. Note the **Secret key** and **Publishable key** for your instance (use test keys first, then production keys).

Set these env vars on the API, admin dashboard, and worker:

```
CLERK_SECRET_KEY=sk_live_...
CLERK_PUBLISHABLE_KEY=pk_live_...
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_...
CLERK_WEBHOOK_SECRET=whsec_...
```

`CLERK_SECRET_KEY` is used by the API to verify session JWTs via `@clerk/backend`'s `verifyToken`. `CLERK_WEBHOOK_SECRET` is the Svix signing secret from the Clerk dashboard webhook endpoint.

### 2. Dashboard auth

The admin dashboard (`apps/admin-dashboard`) wraps the app in Clerk's `<ClerkProvider>` and uses `<SignIn />` / `<SignedIn>` / `<SignedOut>` components. After sign-in, the dashboard calls `GET /v1/me` with the Clerk session JWT to load the Tixkit principal and permissions.

Product authorization comes from **Tixkit permission grants**, not Clerk roles alone. The API resolves a `user_profiles` row from the Clerk `sub` claim and loads `permission_grants` for the active tenant.

### 3. API auth

Admin and integration API routes accept Clerk session JWTs as bearer tokens:

```
Authorization: Bearer <clerk-session-jwt>
```

The API verifies the JWT with `CLERK_SECRET_KEY`, resolves the active organization from the Clerk `org_id` claim, and maps it to a Tixkit tenant via `organizations.clerk_organization_id`. If the user belongs to multiple tenants and no `org_id` is present, the client must send `X-Tenant-Id: <tenantId>`. Ambiguous cases return `401 UNAUTHORIZED` with a message asking for the active organization or header.

Suspended `user_profiles` are rejected with `403 FORBIDDEN`.

### 4. Clerk organizations

Tixkit maps Clerk organizations to Tixkit organizations and tenants:

- A Clerk `organization.created` webhook starts the `clerkIdentitySyncWorkflow`, which calls `syncOrganizationActivity` to insert/update the `organizations` row with `clerk_organization_id`.
- A Clerk `user.created` / `user.updated` webhook calls `syncUserActivity` to upsert a `user_profiles` row.
- A Clerk `user.deleted` webhook calls `deleteUserActivity` to suspend the profile.

Enable these webhook events in the Clerk dashboard:

- `user.created`, `user.updated`, `user.deleted`
- `organization.created`, `organization.updated`

Point the webhook at:

```
POST https://api.<your-domain>/v1/webhooks/clerk
```

### 5. Metadata limits

Clerk public/private metadata is **not** the source of truth for Tixkit permissions. Permission grants are persisted in the Tixkit `permission_grants` table and resolved by the API at request time. Do not rely on Clerk `publicMetadata`/`privateMetadata` for authorization decisions; use it only for non-authoritative display hints (e.g. display name).

Clerk metadata has a 4 KB limit per object. Keep Tixkit-related metadata minimal; store structured data in the Tixkit database instead.

### 6. Webhook signing and dedupe

Clerk webhooks are delivered by Svix. The handler verifies the signature using these headers:

| Header | Purpose |
| --- | --- |
| `svix-id` | Unique message ID (used for dedupe) |
| `svix-timestamp` | Unix seconds; must be within 5 minutes of server time |
| `svix-signature` | Space-delimited `v1,<base64>` candidates |

The verifier (`verifySvixSignature` in `packages/api/src/routes/modules/clerk-webhooks.ts`):

1. Strips the `whsec_` prefix and base64-decodes the secret.
2. HMAC-SHA256 over `${msgId}.${timestamp}.${rawBody}`.
3. Constant-time compares against each `v1` candidate.
4. Rejects if the timestamp is outside ±5 minutes (replay protection).

The handler persists each event in `payment_events` keyed by `(provider='clerk', providerEventId=msgId)` before processing. Duplicate deliveries return `{ "received": true, "duplicate": true }` without starting a new workflow. Identity sync runs as `clerkIdentitySyncWorkflow`, keyed by Clerk user/org ID, so duplicate webhook starts are idempotent at the Temporal level too.

If `CLERK_WEBHOOK_SECRET` is empty, the handler returns `503 WEBHOOK_NOT_CONFIGURED` rather than accepting unsigned events.

### 7. Key rotation

Rotate Clerk keys from the Clerk dashboard:

1. **Secret key**: Generate a new key in Clerk, deploy the new `CLERK_SECRET_KEY` to the API and worker, then revoke the old key in Clerk. Active sessions will refresh; new requests verify against the new key.
2. **Webhook secret**: In the Clerk dashboard, regenerate the webhook signing secret. Update `CLERK_WEBHOOK_SECRET` and deploy. Svix will start signing new deliveries with the new secret; the API accepts the new key immediately. Keep the previous secret briefly if you want to verify in-flight deliveries during the rollout, but the verifier only supports one active secret at a time.
3. **Publishable key**: Rotate alongside the secret key. Update both `CLERK_PUBLISHABLE_KEY` and `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` so the dashboard and API agree.

Never commit real Clerk keys to the repository. If a real key is copied into `.env.local`, rotate it before sharing logs, screenshots, or branches. `.env.local` is gitignored; `.env.local.example` is tracked and contains only placeholders.

## Verifying the Setup

With Clerk keys configured:

1. `http://localhost:3001/dashboard` should resolve a Tixkit principal and permissions (no local-dev fallback).
2. `GET /v1/me` with a Clerk session JWT returns the principal with `permissions: [...]`.
3. Clerk user/org webhook deliveries to `POST /v1/webhooks/clerk` return `{ "received": true }` and start identity sync workflows visible in Temporal UI at `http://localhost:8080`.
4. The `user_profiles` and `organizations` tables reflect Clerk sync state.

If `GET /v1/me` returns `401 User profile not found. Identity sync may be pending.`, confirm the `user.created` webhook fired and the `clerkIdentitySyncWorkflow` completed in Temporal UI.
