# Android SDK

API version: `2026-01-01`

Use `com.tixkit:tixkit-android` for checkout handoff, native ticket/scanner-status views, scanner clients, Android Keystore storage, and HMAC-verified offline manifest sync.

```kotlin
import com.tixkit.sdk.TixkitAndroid
import com.tixkit.sdk.TixkitCheckoutOptions

val checkoutUrl = TixkitAndroid.checkoutUrl(
  TixkitCheckoutOptions(
    checkoutBaseUrl = "https://checkout.example.com",
    eventId = "evt_123",
    organizationId = "org_123",
    successUrl = "https://app.example.com/success",
    cancelUrl = "https://app.example.com/cancel",
    ticketTypes = mapOf("tt_123" to 1),
  ),
)
```

## Validation

Run `./gradlew build test`, `./gradlew :example:testDebugUnitTest`, and `./gradlew :sdk:publishToMavenLocal` from `packages/sdk-android`.
