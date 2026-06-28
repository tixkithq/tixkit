# Tixkit Flutter Example

This app exercises the package-level checkout handoff, ticket display, scanner status, and adapter-based camera scanner surfaces.

Run it with a Flutter toolchain:

```sh
cd packages/sdk-flutter/example
flutter pub get
flutter build web --release
flutter run
```

This example intentionally stays adapter-based so teams can use their preferred scanner package.

```dart
TixkitCameraScanner(
  client: client,
  checkInListId: 'cil_123',
  mode: TixkitScannerMode.auto,
  cameraBuilder: (context, onPayload) {
    return MyQrCamera(onDetected: onPayload);
  },
  onResult: (result) {
    // Show accepted, duplicate, invalid, revoked, wrong_event, or wrong_list.
  },
);
```
