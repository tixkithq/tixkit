# Tixkit React Native Demo

This Expo workspace demonstrates `@tixkit/react-native`: checkout handoff, ticket presentation, barcode parsing, online/offline scan flows, signed manifest download, and offline scan synchronization.

## Requirements

- Bun 1.3+ and Node.js 20+.
- An Expo-compatible iOS simulator, Android emulator, or device.
- Dependencies installed from the monorepo root.
- Network access from the simulator/device to the configured Tixkit services for live calls.

## Configure

The checked-in demo uses local non-secret event values in `App.tsx`. Scanner credentials are read only from the in-memory `__TIXKIT_SCANNER_CREDENTIALS__` bridge, which the native host must populate after Keychain/Keystore-backed enrollment. Before live testing, set the API and checkout origins to addresses reachable from the device and enroll scoped test records.

Do not use `localhost` from a physical device unless Tixkit actually runs on that device. Use a trusted LAN or tunnel origin appropriate for the test environment, and never place a production scanner secret in committed source.

## Run

From the repository root:

```bash
bun install --frozen-lockfile
bun run --filter @tixkit/sdk-react-native-demo start
```

Use the Expo prompt to open iOS, Android, or a device. The tabs demonstrate:

| Tab      | Expected behavior                                                                                  |
| -------- | -------------------------------------------------------------------------------------------------- |
| Checkout | Builds a handoff URL and asks the platform to open it                                              |
| Tickets  | Renders ticket-card state through the React Native adapter                                         |
| Scanner  | Parses a simulated barcode and displays online/offline scan state                                  |
| Sync     | Downloads a signed offline manifest, queues scans, and synchronizes them when connectivity returns |

The simulated scan proves adapter behavior; it is not a camera integration or proof of admission authorization.

## Add a camera

Install a compatible camera package such as `expo-camera`, obtain platform permission, and pass its `CameraView` to `createTixkitReactNativeComponents`. Keep barcode parsing and scan authorization in the Tixkit client flow; a decoded QR value alone is not an admission decision.

## Validate

```bash
bun run --filter @tixkit/sdk-react-native-demo typecheck
bun run --filter @tixkit/sdk-react-native-demo lint
```

Run the application on each supported target for platform proof. Typecheck and lint do not exercise native permissions, networking, secure storage, or camera behavior.

## Troubleshooting

- **Network request fails on device:** use a reachable host, confirm transport security rules, and verify the API version and device scopes.
- **Manifest verification fails:** confirm device credentials, event/check-in-list scope, clock, and that the signed manifest was not modified.
- **Camera is unavailable:** the checked-in demo intentionally uses simulated scans; add and permission a camera adapter.
- **Expo dependency mismatch:** use the package versions in this workspace rather than upgrading one native dependency independently.

## Security and related guides

Production scanner credentials require platform secure storage and rotation; do not use AsyncStorage, logs, URLs, screenshots, or analytics. Continue with the canonical [React Native SDK guide](../../docs/public/sdks/react-native.mdx) and [operator check-in guide](../../docs/public/operators/check-in.mdx).
