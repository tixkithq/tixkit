# `github.com/tixkit/tixkit-go`

## Purpose

Typed Go client for Tixkit endpoints, cursor pagination, retries, idempotency, and webhook verification.

## Consumers

Go services integrating Tixkit from trusted server environments.

## Status

Supported module pinned to API version `2026-08-04`.

## Installation

`go get github.com/tixkit/tixkit-go`.

## Example

`client := tixkit.NewClient(os.Getenv("TIXKIT_API_KEY"))`

## Public exports

Client/configuration, typed services and resources, API errors, pagination, idempotency support, and webhook verification.

## Runtime

Go 1.26 as declared by `go.mod`.

## Configuration

Supply API key, base URL, HTTP client, timeout, and retry policy through client configuration.

## Security

Keep keys server-side, verify webhook signatures against raw bodies, and avoid logging request authorization headers.

## Validation

`cd packages/sdk-go && go test ./... && go vet ./...`

## Compatibility

Semantic module releases track API version `2026-08-04`; exported Go identifiers are the compatibility boundary.

## Related guides

[Go SDK guide](../../docs/public/sdks/go.mdx)
