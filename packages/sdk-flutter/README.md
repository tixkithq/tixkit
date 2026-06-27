# Tixkit Flutter SDK

The Flutter SDK mirrors the React Native scanner contract:

- hosted checkout handoff URL generation
- online scanner-device check-in
- signed offline manifest download and HMAC verification
- offline scan persistence and sync with conflict callbacks
- adapter-based camera scanner widget
- ticket display and scanner status widgets

The package keeps camera choice app-owned. Pass a `cameraBuilder` that adapts `mobile_scanner`, `camera`, or another QR scanner package and calls the supplied `onPayload` callback when a QR payload is detected.

```dart
final client = TixkitScannerClient(
  deviceId: 'sd_public_123',
  deviceSecret: 'scanner-secret',
  manifestSigningKey: 'offline-manifest-signing-key',
  storage: TixkitMemoryScannerStorage(),
);

TixkitCameraScanner(
  client: client,
  checkInListId: 'cil_123',
  mode: TixkitScannerMode.auto,
  cameraBuilder: (context, onPayload) {
    return MyQrScanner(onQrCode: onPayload);
  },
  onResult: (result) {
    debugPrint(result.message);
  },
);
```

Run locally with a Flutter toolchain:

```sh
cd packages/sdk-flutter
flutter test
```
