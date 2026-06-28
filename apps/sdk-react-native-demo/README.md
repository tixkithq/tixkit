# Tixkit React Native Demo

Demonstrates the `@tixkit/react-native` SDK: scanner, ticket display, checkout handoff, and offline manifest sync.

## Run

Requires Node.js, the Expo CLI, and a simulator or device:

```sh
cd apps/sdk-react-native-demo
bun install   # or npm install

# Start the Expo dev server
bun run start

# Press i for iOS simulator, a for Android emulator, or scan the QR code with Expo Go
```

## Tabs

| Tab      | SDK surface                                                                                 |
| -------- | ------------------------------------------------------------------------------------------- |
| Checkout | `checkoutHandoffUrl` / `TixkitScannerClient.openCheckout`                                   |
| Tickets  | `TixkitTicketCard` (via `createTixkitReactNativeComponents`)                                |
| Scanner  | `scanBarcodePayload` + `TixkitScannerClient.scanOnline/scanOffline` + `TixkitScannerStatus` |
| Sync     | `TixkitScannerClient.downloadManifest` + `TixkitScannerClient.syncScans`                    |

## Camera integration

The demo uses a manual "simulate scan" button. To use a real camera, install `expo-camera` and pass a `CameraView` to `createTixkitReactNativeComponents`:

```tsx
import { CameraView } from 'expo-camera';

const { TixkitCameraScanner } = createTixkitReactNativeComponents({
  createElement: React.createElement,
  View,
  Text,
  Pressable,
  CameraView,
});
```

## Configuration

The demo uses placeholder credentials (`sd_demo_device`, `demo-device-secret`). Replace them with real scanner device credentials from your Tixkit dashboard before testing against a live backend.

Set `apiBaseUrl` and `checkoutBaseUrl` in `App.tsx` to point to your Tixkit API and checkout app.
