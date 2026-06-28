# Pluggable Auth Provider Design

Tixkit currently uses Clerk as its sole auth provider. This document describes the design for abstracting auth behind an `AuthProvider` boundary so self-hosters can use alternative providers.

## Current State

Auth is Clerk-bound: the API validates Clerk session tokens, the admin dashboard uses Clerk's React SDK, and the worker syncs identity via Clerk webhooks. Local development works without Clerk keys by falling back to a deterministic dev principal, but production requires Clerk.

## Proposed Architecture

### AuthProvider Interface

```typescript
interface AuthProvider {
  name: string;
  verifyToken(token: string): Promise<AuthPrincipal | null>;
  getPrincipal(userId: string): Promise<AuthPrincipal | null>;
  syncWebhooks?: (event: WebhookEvent) => Promise<void>;
}
```

### AuthPrincipal

```typescript
interface AuthPrincipal {
  userId: string;
  email: string;
  tenantId?: string;
  organizationId?: string;
  role: string;
  metadata?: Record<string, unknown>;
}
```

### Adapters

1. **ClerkAdapter** (default, production) — wraps existing Clerk token verification and identity sync.
2. **DevAdapter** (local development) — deterministic email/password principal without external auth service.
3. **OIDCAdapter** (self-hosted) — standard OpenID Connect integration for Keycloak, Auth0, Okta, or any OIDC provider.

### Configuration

Set `AUTH_PROVIDER=clerk|dev|oidc` to select the active provider. Production fails closed when the configured provider is incomplete (missing keys, unverified tokens).

### Migration Path

1. Extract the `AuthProvider` interface in `packages/shared/src/auth-provider.ts`.
2. Wrap existing Clerk logic in `ClerkAdapter`.
3. Implement `DevAdapter` (already partially exists as the dev principal fallback).
4. Implement `OIDCAdapter` for self-hosters.
5. Update API middleware, admin dashboard, and worker to use the provider abstraction.
6. Add tests for each adapter.

### Coordination with Phase 3

C-053 requires modifying the API auth middleware (`packages/api/src/middleware/`), admin dashboard auth (`apps/admin-dashboard/src/app/(auth)/`), and worker identity sync (`packages/workflows/src/activities/clerk-identity-sync.ts`). These are Phase 3-owned surfaces. Phase 4 will provide the interface and adapters; Phase 3 will integrate them into the existing auth flow.

## Status

- **Interface design**: This document
- **Implementation**: Pending Phase 3 coordination
- **DevAdapter**: Partially exists as the dev principal fallback in the API
