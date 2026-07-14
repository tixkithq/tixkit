# `@tixkit/remix`

## Purpose

Remix server/client integration over `@tixkit/js`.

## Consumers

Remix loaders, actions, server routes, and browser checkout UI.

## Status

Public SDK at version 0.1.0 and API version `2026-07-21`; pre-1.0 exports may evolve with release notes.

## Installation

bun add @tixkit/remix.

## Example

const client = createTixkitClient({ apiKey: process.env.TIXKIT_API_KEY!, baseUrl: process.env.TIXKIT_API_BASE_URL });

## Public exports

`./server` client/webhook/action/load helpers and `./client` widget URL/message helpers.

## Runtime

TypeScript ES modules; build and runtime peers are declared in `package.json`.

## Configuration

Pass `apiKey` and optional `baseUrl` explicitly. Use `TIXKIT_API_KEY` and `TIXKIT_API_BASE_URL` in server environment configuration.

## Security

API keys and webhook secrets belong only in server loaders/actions.

## Validation

bun run --filter @tixkit/remix typecheck && bun run --filter @tixkit/remix lint && bun run --filter @tixkit/remix test:unit && bun run --filter @tixkit/remix build

## Compatibility

Tracks API version `2026-07-21`; framework peer versions and subpath exports are the compatibility boundary.

## Related guides

[Remix SDK guide](../../docs/public/sdks/remix.mdx)
