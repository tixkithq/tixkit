# `@tixkit/js`

## Purpose

Typed JavaScript/TypeScript client for the Tixkit API.

Readiness and lifecycle parity includes workspace readiness, event launch readiness, explicit acknowledgements, publish/pause/archive, and safe event duplication. Event mutations require `expectedVersion` and surface `stale_event_version` instead of overwriting concurrent work. Authenticated test checkout is restricted to capture/mock or provider-test mode and remains tagged outside production reporting.

## Consumers

Node.js services, server frameworks, tooling, and trusted browser calls limited to public endpoints.

## Status

Public SDK at version 0.1.0 and API version `2026-07-21`; pre-1.0 exports may evolve with release notes.

## Installation

bun add @tixkit/js.

## Example

const client = createTixkitClient({ apiKey: process.env.TIXKIT_API_KEY!, baseUrl: process.env.TIXKIT_API_BASE_URL });

## Public exports

The root exports `TixkitClient`, resources/types, webhook verification, errors, pagination, and API version constants.

## Runtime

TypeScript ES modules; build and runtime peers are declared in `package.json`.

## Configuration

Pass either `apiKey` or `accessToken` and an optional `apiBaseUrl` explicitly. Agent-control operations require a human bearer `accessToken`; the API rejects API-key principals for those tenant-wide sponsor mutations. Use server environment configuration for secret API keys.

## Security

Never bundle a secret API key into client-side JavaScript.

## Validation

bun run --filter @tixkit/js typecheck && bun run --filter @tixkit/js lint && bun run --filter @tixkit/js test:unit && bun run --filter @tixkit/js build

## Compatibility

Tracks API version `2026-07-21`; framework peer versions and subpath exports are the compatibility boundary.

## Related guides

[JavaScript SDK guide](../../docs/public/sdks/javascript.mdx)
