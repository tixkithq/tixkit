# `sdk-android`

## Purpose

Kotlin Android SDK for hosted checkout handoff, ticket/scanner UI, online check-in, and signed offline synchronization.

## Consumers

Android applications integrating Tixkit attendee or scanner experiences.

## Status

Supported source package with Maven coordinates `com.tixkit:tixkit-android`; API version is `2026-08-27`.

Resale writes include the exact `2026-07-16` terms acceptance. Settlement helpers replace provider-delegated listing completion.

## Installation

Use the repository Gradle build or the published Maven coordinate for a released version.

## Example

`val client = TixkitScannerClient(deviceId, deviceSecret, baseUrl)`

## Public exports

Kotlin API client and models, scanner controller, encrypted credential storage, offline manifest/sync helpers, and Compose views.

## Runtime

Android API/toolchain levels declared in `sdk/build.gradle.kts`; Kotlin 2.1.20 build.

## Configuration

Pass API base URL and scanner identifiers explicitly; credential storage uses Android Keystore-backed preferences.

## Security

Scanner device secrets belong in Keystore-backed storage and must never enter intents, logs, analytics, or screenshots.

## Validation

`cd packages/sdk-android && ./gradlew build test`

## Compatibility

Android SDK API version `2026-08-27`; Maven coordinates and public Kotlin signatures define compatibility.

## Related guides

[Android SDK guide](../../docs/public/sdks/android.mdx)
