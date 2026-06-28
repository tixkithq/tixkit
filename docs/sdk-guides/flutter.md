# Flutter SDK

API version: `2026-01-01`

Use `tixkit_flutter` for hosted checkout handoff, ticket/status widgets, scanner clients, and HMAC-verified offline manifest sync.

```dart
import 'package:tixkit_flutter/tixkit_flutter.dart';

final scanner = TixkitScannerClient(
  apiBaseUrl: 'https://api.example.com/v1',
  deviceId: 'scanner_123',
  deviceSecret: 'secret',
  manifestSigningKey: 'manifest-secret',
);

final url = tixkitCheckoutHandoffUri(
  const TixkitCheckoutHandoffOptions(
    eventId: 'evt_123',
    items: [TixkitCheckoutHandoffItem(ticketTypeId: 'tt_123', quantity: 1)],
  ),
);
```

## Validation

Run `flutter analyze`, `flutter test`, `cd example && flutter build web --release`, and `flutter pub publish --dry-run` from `packages/sdk-flutter`.
