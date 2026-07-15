# `@tixkit/react-native`

## Purpose

React Native client for ticket display, scanner check-in, checkout handoff, and offline synchronization.

## Consumers

React Native 0.73+ applications and Expo-compatible integrations.

## Status

Public SDK at version 0.1.0 and API version `2026-08-08`; pre-1.0 exports may evolve with release notes.

## Installation

bun add @tixkit/react-native.

## Example

const client = createTixkitClient({ apiKey: process.env.TIXKIT_API_KEY!, baseUrl: process.env.TIXKIT_API_BASE_URL });

## Public exports

Client/resource types, scanner helpers, offline manifest/sync APIs, components, hashing, and checkout URLs.

## Runtime

TypeScript ES modules; build and runtime peers are declared in `package.json`.

## Configuration

Pass `apiKey` and optional `baseUrl` explicitly. Use `TIXKIT_API_KEY` and `TIXKIT_API_BASE_URL` in server environment configuration.

## Security

Store scanner credentials in native secure storage, not AsyncStorage or logs.

## Validation

bun run --filter @tixkit/react-native typecheck && bun run --filter @tixkit/react-native lint && bun run --filter @tixkit/react-native test:unit && bun run --filter @tixkit/react-native build

## Compatibility

Tracks API version `2026-08-08`; framework peer versions and subpath exports are the compatibility boundary.

## Related guides

[React Native SDK guide](../../docs/public/sdks/react-native.mdx)
