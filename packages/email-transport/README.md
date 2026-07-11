# `@tixkit/email-transport`

## Purpose

Email and SMS transport interfaces plus capture, mock, and fallback implementations.

## Consumers

Notification workflows and tests that need provider-neutral delivery behavior.

## Status

Private adapter boundary; capture/mock transports are for controlled environments, not production delivery.

## Installation

Add it as a `workspace:*` dependency and inject an implementation into notification activities.

## Example

`const transport = new CaptureEmailTransport(); await transport.send(message);`

## Public exports

Transport interfaces and capture, mock, fallback email/SMS implementations.

## Runtime

TypeScript ES modules on server runtimes.

## Configuration

No provider environment variables are read directly; callers construct configured provider transports.

## Security

Do not use mock/capture delivery as a production success signal; redact message content from logs and enforce consent upstream.

## Validation

`bun run --filter @tixkit/email-transport typecheck && bun run --filter @tixkit/email-transport lint && bun run --filter @tixkit/email-transport test:unit`

## Compatibility

Implementations must preserve transport contracts used by workflow retry and failure handling.

## Related guides

[Messaging operations](../../docs/public/operators/messaging.mdx)
