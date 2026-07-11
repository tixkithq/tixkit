# Tixkit Flutter Demo

This application demonstrates `tixkit_flutter`: checkout handoff, ticket presentation, barcode scanning adapters, online/offline admission state, signed manifest download, and offline scan synchronization.

## Requirements

- Flutter 3.22+ with a configured web, iOS, or Android target.
- A simulator, emulator, browser, or connected device.
- Network access from that target to Tixkit services for live calls.

The Flutter SDK is resolved from `../../packages/sdk-flutter`, so this demo exercises the current workspace source.

## Configure

`lib/main.dart` contains non-production demo origins and non-secret event values. The native host must implement the `com.tixkit.demo/scanner-credentials` method channel and return device credentials read from Keychain/Keystore after enrollment; absent credentials produce an explicit setup-required screen. Before live testing, replace the API and checkout origins with addresses reachable from the target and supply scoped test records through that bridge.

Do not commit real device credentials. A production app must obtain them through a controlled enrollment flow and retain them in platform secure storage.

## Run

```bash
cd apps/sdk-flutter-demo
flutter pub get
flutter run
```

Choose a configured device when prompted. The tabs demonstrate:

| Tab      | Expected behavior                                                 |
| -------- | ----------------------------------------------------------------- |
| Checkout | Builds and launches the configured checkout handoff URI           |
| Tickets  | Renders ticket-card state                                         |
| Scanner  | Uses the scanner adapter and reports scan authorization state     |
| Sync     | Downloads a signed offline manifest and synchronizes queued scans |

A simulated or decoded barcode is not by itself an admission decision; the SDK's online/offline verification result is authoritative.

## Validate

```bash
cd apps/sdk-flutter-demo
flutter analyze
flutter test
flutter build web --release
```

The tests cover widget behavior and the web build proves compilation. Run native builds and device tests separately for camera, secure-storage, networking, and platform-permission evidence.

## Troubleshooting

- **Target cannot reach the API:** replace loopback origins with a host reachable from the device and check platform transport-security settings.
- **Offline manifest is rejected:** verify device scope, event/check-in-list identifiers, clock, and signature integrity.
- **No camera input:** provide a compatible camera adapter and required iOS/Android permissions; the SDK does not grant permissions itself.
- **Workspace package resolution fails:** run `flutter pub get` from this directory and retain the relative path dependency in `pubspec.yaml`.

## Security and related guides

Store real scanner credentials in Keychain/Keystore-backed storage, rotate them after suspected exposure, and exclude them from source, logs, URLs, screenshots, crash reports, and analytics. Continue with the canonical [Flutter SDK guide](../../docs/public/sdks/flutter.mdx) and [operator check-in guide](../../docs/public/operators/check-in.mdx).
