# `@tixkit/next`

## Purpose

Next.js integration over `@tixkit/js`, including server helpers, route handlers, and React client UI.

## Consumers

Next.js App Router applications.

## Status

Public SDK at version 0.1.0 and API version `2026-07-13`; pre-1.0 exports may evolve with release notes.

## Installation

bun add @tixkit/next.

## Example

const client = createTixkitClient({ apiKey: process.env.TIXKIT_API_KEY!, baseUrl: process.env.TIXKIT_API_BASE_URL });

## Public exports

Root React exports plus `./server`, `./client`, and `./route-handlers`.

## Runtime

TypeScript ES modules; build and runtime peers are declared in `package.json`.

## Configuration

Pass `apiKey` and optional `baseUrl` explicitly. Use `TIXKIT_API_KEY` and `TIXKIT_API_BASE_URL` in server environment configuration.

## Security

Instantiate credentialed clients only in server modules; route handlers must enforce authorization.

## Validation

bun run --filter @tixkit/next typecheck && bun run --filter @tixkit/next lint && bun run --filter @tixkit/next test:unit && bun run --filter @tixkit/next build

## Compatibility

Tracks API version `2026-07-13`; framework peer versions and subpath exports are the compatibility boundary.

## Related guides

[Next.js SDK guide](../../docs/public/sdks/nextjs.mdx)
