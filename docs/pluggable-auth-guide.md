# Pluggable Auth Providers

Tixkit authenticates API requests through an `AuthProvider` boundary. Clerk remains the production default, local development uses a deterministic dev provider by default, and self-hosters can use a standard OIDC provider such as Keycloak, Auth0, or Okta.

## Provider Selection

Set `AUTH_PROVIDER` to one of:

| Value | Use case |
| --- | --- |
| `clerk` | Hosted production default. Wraps existing Clerk token verification plus existing API key, OAuth access token, scanner-device, and local-dev fallback behavior. |
| `dev` | Local development only. Returns the deterministic local dev principal and refuses to start in production. |
| `oidc` | Self-hosted OIDC. Verifies bearer JWTs against the issuer JWKS and maps the OIDC subject to a Tixkit user profile. |

When `AUTH_PROVIDER` is unset, development defaults to `dev`; every other environment defaults to `clerk`.

The hosted admin frontend also reads `NEXT_PUBLIC_AUTH_PROVIDER`. Keep it aligned
with `AUTH_PROVIDER` whenever Clerk or another hosted provider is enabled, because
browser bundles cannot rely on server-only environment variables. A valid
`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` also selects Clerk when the public provider
flag is omitted, but deployments should set both variables explicitly.

## Shared Interface

The shared contract lives at `packages/shared/src/auth-provider.ts`.

```typescript
export interface AuthProvider<Request = unknown> {
  readonly name: AuthProviderName;
  authenticateUser(request: Request): Promise<AuthProviderResult>;
  authenticateApiKey(token: string): Promise<AuthProviderResult>;
  authenticateOAuthAccessToken(token: string): Promise<AuthProviderResult>;
  authenticateScannerDevice(token: string): Promise<AuthProviderResult>;
  authenticateLocalDev(): Promise<AuthProviderResult>;
  isLocalDevMode(): boolean;
}
```

The API constructs the active provider in `packages/api/src/app.ts` and the auth middleware consumes the interface instead of depending directly on Clerk.

## Clerk

`ClerkAdapter` wraps the existing Clerk auth service. It preserves the current Clerk session-token path, API key auth, OAuth access-token auth, scanner device auth, and local development seed behavior.

Required production variables:

```bash
AUTH_PROVIDER=clerk
NEXT_PUBLIC_AUTH_PROVIDER=clerk
CLERK_SECRET_KEY=<clerk-secret-key>
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=<clerk-publishable-key>
CLERK_WEBHOOK_SECRET=<clerk-webhook-secret>
```

## Dev

`DevAdapter` is for local development only. It fails closed when `NODE_ENV=production`, so a missing hosted auth configuration cannot silently become a dev principal in production.

```bash
NODE_ENV=development
AUTH_PROVIDER=dev
NEXT_PUBLIC_AUTH_PROVIDER=dev
```

## OIDC

`OIDCAdapter` verifies JWT bearer tokens with the issuer's JWKS and expected audience. A user profile must exist with:

```text
clerk_user_id = oidc:<issuer-url>:<subject>
```

The mapped user must have an active tenant membership. If an organization claim is supplied, it must map to an active organization membership. Missing issuer/audience, invalid tokens, missing user profiles, suspended profiles, or ambiguous tenant mappings fail closed.

Required variables:

```bash
AUTH_PROVIDER=oidc
OIDC_ISSUER_URL=https://issuer.example.com
OIDC_AUDIENCE=tixkit-api
```

Recommended token claims:

| Claim | Purpose |
| --- | --- |
| `sub` | Stable provider subject. Required. |
| `email` | Auditing and operator visibility. |
| `org_id` or `organization_id` | Optional organization selection. |
| `tenant_id` | Optional tenant hint. The database grant remains authoritative. |

## Validation

Local evidence from the implementation pass:

- `bun run --filter @tixkit/shared build`
- `bun run --filter @tixkit/shared typecheck`
- `bun run --filter @tixkit/shared lint`
- `bun run --filter @tixkit/api typecheck`
- `bun run --filter @tixkit/api test:unit`
- `bun run --filter @tixkit/api lint`
