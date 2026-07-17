# `sdk-ios`

## Purpose

Swift package `TixkitIOS` for hosted checkout, ticket/scanner SwiftUI, online check-in, and signed offline sync.

## Consumers

iOS 15+ and macOS 12+ applications.

## Status

Supported Swift package pinned to API version `2026-08-20`.

Resale writes include the exact `2026-07-16` terms acceptance. Settlement helpers replace provider-delegated listing completion.

## Installation

Add this repository’s `packages/sdk-ios` package in Swift Package Manager and link `TixkitIOS`.

## Example

`let client = TixkitScannerClient(deviceId: id, deviceSecret: secret)`

## Public exports

Tixkit API/scanner clients, models, checkout URL helpers, Keychain storage, offline manifest/sync support, and SwiftUI views.

## Runtime

Swift tools 5.9; iOS 15+ or macOS 12+.

## Configuration

Pass the API base URL and device identity explicitly; secure scanner credentials through the provided Keychain store.

## Security

Never place scanner credentials in UserDefaults, URLs, logs, analytics, or screenshots; verify signed offline manifests.

## Validation

`cd packages/sdk-ios && swift build && swift test`

## Compatibility

Swift package products/platforms and API version `2026-08-20` define compatibility.

## Related guides

[iOS SDK guide](../../docs/public/sdks/ios.mdx)
