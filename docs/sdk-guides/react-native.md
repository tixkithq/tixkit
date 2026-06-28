# React Native SDK

API version: `2026-01-01`

Use `@tixkit/react-native` for checkout handoff, scanner clients, secure-storage adapters, ticket display components, and offline manifest sync.

```ts
import {
  TIXKIT_API_VERSION,
  TixkitScannerClient,
  createTixkitSecureStorage,
} from '@tixkit/react-native';

const storage = createTixkitSecureStorage({
  getItem: (key) => SecureStore.getItemAsync(key),
  setItem: (key, value) => SecureStore.setItemAsync(key, value),
  deleteItem: (key) => SecureStore.deleteItemAsync(key),
});

const scanner = new TixkitScannerClient({
  apiBaseUrl: 'https://api.example.com/v1',
  apiVersion: TIXKIT_API_VERSION,
  deviceId: 'scanner_123',
  deviceSecret: 'secret',
  manifestSigningKey: 'manifest-secret',
  storage,
});
```

## Validation

Run `bun run --filter @tixkit/react-native test:unit`, `bun run --filter @tixkit/react-native build`, and `npm pack --dry-run` from `packages/sdk-react-native`.
