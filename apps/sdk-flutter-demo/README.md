# Tixkit Flutter Demo

Demonstrates the `tixkit_flutter` SDK: scanner, ticket display, checkout handoff, and offline manifest sync.

## Run

Requires a Flutter toolchain (>= 3.22.0):

```sh
cd apps/sdk-flutter-demo
flutter pub get

# Run on a simulator or connected device
flutter run

# Or build for web
flutter build web --release
```

## Tabs

| Tab      | SDK surface                                                              |
| -------- | ------------------------------------------------------------------------ |
| Checkout | `tixkitCheckoutHandoffUri` / `TixkitScannerClient.checkoutUrl`           |
| Tickets  | `TixkitTicketCard`                                                       |
| Scanner  | `TixkitCameraScanner` (adapter-based) + `TixkitScannerStatus`            |
| Sync     | `TixkitScannerClient.downloadManifest` + `TixkitScannerClient.syncScans` |

## Configuration

The demo uses placeholder credentials (`sd_demo_device`, `demo-device-secret`). Replace them with real scanner device credentials from your Tixkit dashboard before testing against a live backend.

Set `apiBaseUrl` and `checkoutBaseUrl` in `lib/main.dart` to point to your Tixkit API and checkout app.
