# Tixkit Android SDK

The Kotlin Android SDK mirrors the React Native, Flutter, and iOS scanner contract:

- hosted checkout handoff URL generation
- scanner-device check-in helpers for online and offline scans
- native ticket and scanner-status display views
- HMAC-verified offline manifest support
- offline scan persistence and sync conflict callbacks
- Android Keystore-backed SharedPreferences storage for scanner credentials
- adapter-style scanner controller for app-owned camera/QR readers
- Maven publication metadata for `com.tixkit:tixkit-android`

Run locally with the Gradle wrapper:

```sh
cd packages/sdk-android
./gradlew build test
./gradlew :example:testDebugUnitTest
```

The example app renders the checkout handoff URL and runs an offline scanner
happy-path smoke through `TixkitExampleSmoke`.
