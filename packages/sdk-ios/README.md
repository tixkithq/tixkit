# Tixkit iOS SDK

The Swift SDK mirrors the React Native and Flutter scanner contract:

- hosted checkout handoff URL generation
- scanner-device check-in helpers for online and offline scans
- HMAC-verified offline manifest support
- offline scan persistence and sync conflict callbacks
- Keychain-backed scanner credential storage
- SwiftUI ticket display and scanner status views

Run locally with a Swift toolchain:

```sh
cd packages/sdk-ios
swift build
swift test
cd Examples/TixkitIOSExample
swift build
swift run TixkitIOSExample
```
