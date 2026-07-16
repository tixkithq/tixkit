# `tixkit`

## Purpose

Async Rust client for Tixkit resources, pagination, retries, idempotency, and webhook verification.

## Consumers

Tokio-based server applications integrating Tixkit.

## Status

Supported crate version 0.1.0 pinned to API version `2026-08-09`.

## Installation

`cargo add tixkit`.

## Example

`let client = tixkit::Client::new(std::env::var("TIXKIT_API_KEY")?);`

## Public exports

Async client/configuration, typed services/resources, API errors, pagination, idempotency support, and HMAC webhook verification.

## Runtime

Rust 1.93, edition 2024, Tokio, Reqwest with rustls.

## Configuration

Supply API key, base URL, timeouts, and retry settings through client construction.

## Security

Keep credentials server-side, verify webhooks from raw bodies, and redact authorization and payload data from errors/logs.

## Validation

`cd packages/sdk-rust && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test`

## Compatibility

Cargo semantic versions track API version `2026-08-09`; public Rust types and behavior are the compatibility boundary.

## Related guides

[Rust SDK guide](../../docs/public/sdks/rust.mdx)
