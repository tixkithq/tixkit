# Tixkit Flutter Example

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
