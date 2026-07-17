# `tixkit_flutter`

## Purpose

Flutter SDK for ticket display, hosted checkout, scanner check-in, and signed offline synchronization.

## Consumers

Flutter 3.22+ mobile applications.

## Status

Supported package version 0.1.0, pinned to API version `2026-08-15`.

Resale writes include the exact `2026-07-16` terms acceptance. Settlement helpers replace provider-delegated listing completion.

## Installation

Add `tixkit_flutter` to `pubspec.yaml` from the released package or local path.

## Example

`final client = TixkitScannerClient(deviceId: id, deviceSecret: secret);`

## Public exports

API/scanner clients, models, checkout URL helpers, offline storage/sync contracts, and ticket/scanner widgets from `tixkit_flutter.dart`.

## Runtime

Dart `>=3.4.0 <4.0.0` and Flutter `>=3.22.0`.

## Configuration

Pass API base URL, device ID, and signing material explicitly; the application chooses its camera adapter and secure storage.

## Security

Use platform secure storage for scanner secrets; verify offline manifests and exclude secrets from diagnostics.

## Validation

`cd packages/sdk-flutter && flutter analyze && flutter test`

## Compatibility

Flutter/Dart constraints in `pubspec.yaml` and API version `2026-08-15` define compatibility.

## Related guides

[Flutter SDK guide](../../docs/public/sdks/flutter.mdx)
