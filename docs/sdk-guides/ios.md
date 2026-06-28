# iOS SDK

API version: `2026-01-01`

Use `TixkitIOS` through SwiftPM for checkout handoff, SwiftUI ticket/status views, scanner clients, Keychain storage, and HMAC-verified offline manifest sync.

```swift
import TixkitIOS

let client = TixkitScannerClient(
  apiBaseURL: URL(string: "https://api.example.com/v1")!,
  deviceId: "scanner_123",
  deviceSecret: "secret",
  manifestSigningKey: "manifest-secret"
)

let ticketView = TixkitTicketView(ticketId: "tkt_123", status: "valid")
```

## Validation

Run `swift build`, `swift test`, and `cd Examples/TixkitIOSExample && swift run TixkitIOSExample` from `packages/sdk-ios`.
