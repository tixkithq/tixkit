# `@tixkit/email-transport`

## Purpose

Email and SMS transport interfaces plus production provider, capture, mock, and fallback implementations.

## Consumers

Notification workflows and tests that need provider-neutral delivery behavior.

## Status

Private adapter boundary; capture/mock transports are for controlled environments, not production delivery.

## Installation

Add it as a `workspace:*` dependency and inject an implementation into notification activities.

## Example

`const transport = new CaptureEmailTransport(); await transport.send(message);`

## Public exports

Transport interfaces and capture, mock, fallback, Resend, SMTP, and SMS provider implementations.

## Runtime

TypeScript ES modules on server runtimes.

## Configuration

Provider routes resolve named environment references. Unresolved references fail closed; they are never transmitted as credentials.

For SMTP, set the route's `credentials_ref` to the name of an environment variable containing an
`smtp://` or `smtps://` connection URL. `smtp://` requires STARTTLS; `smtps://` uses implicit TLS.
Username and password components must both be present or both omitted, and reserved characters must
be percent-encoded. `SMTP_URL` is the fallback reference. Plaintext SMTP is available only to an
explicit non-production loopback test with `SMTP_ALLOW_INSECURE_LOOPBACK=1`.

## Security

Do not use mock/capture delivery as a production success signal; redact message content from logs and enforce consent upstream. SMTP errors expose only normalized failure categories and numeric response codes. Ambiguous failures after message submission are never automatically retried or failed over.

## Validation

`bun run --filter @tixkit/email-transport typecheck && bun run --filter @tixkit/email-transport lint && bun run --filter @tixkit/email-transport test:unit`

## Compatibility

Implementations must preserve transport contracts used by workflow retry and failure handling.

## Related guides

[Messaging operations](../../docs/public/operators/messaging.mdx)
