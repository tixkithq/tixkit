# `@tixkit/vue`

## Purpose

Vue/Nuxt-oriented server/client integration over `@tixkit/js`.

## Consumers

Vue SSR and Nuxt server routes plus browser checkout UI.

## Status

Public SDK at version 0.1.0 and API version `2026-08-31`; pre-1.0 exports may evolve with release notes.

Resale writes require the exact `2026-07-16` terms acceptance. Settlement helpers replace provider-delegated listing completion.

## Installation

bun add @tixkit/vue.

## Example

const client = createTixkitClient({ apiKey: process.env.TIXKIT_API_KEY!, baseUrl: process.env.TIXKIT_API_BASE_URL });

## Public exports

`./server` client/webhook/action/load helpers and `./client` widget URL/message helpers.

## Runtime

TypeScript ES modules; build and runtime peers are declared in `package.json`.

## Configuration

Pass `apiKey` and optional `baseUrl` explicitly. Use `TIXKIT_API_KEY` and `TIXKIT_API_BASE_URL` in server environment configuration.

## Security

Keep credentials in Nitro/server code and pass only public values to hydrated components.

## Validation

bun run --filter @tixkit/vue typecheck && bun run --filter @tixkit/vue lint && bun run --filter @tixkit/vue test:unit && bun run --filter @tixkit/vue build

## Compatibility

Tracks API version `2026-08-31`; framework peer versions and subpath exports are the compatibility boundary.

## Related guides

[Vue and Nuxt SDK guide](../../docs/public/sdks/vue-and-nuxt.mdx)
