package com.tixkit.sdk.example

import com.tixkit.sdk.TixkitAndroid
import com.tixkit.sdk.TixkitCheckoutOptions
import com.tixkit.sdk.TixkitMemorySecureStorage
import com.tixkit.sdk.TixkitOfflineManifest
import com.tixkit.sdk.TixkitOfflineTicket
import com.tixkit.sdk.TixkitScannerController
import com.tixkit.sdk.TixkitScannerMode
import com.tixkit.sdk.signTixkitOfflineManifest
import com.tixkit.sdk.tixkitQrHashForPayload
import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset

object TixkitExampleSmoke {
  private val clock: Clock = Clock.fixed(Instant.parse("2026-06-27T12:00:00Z"), ZoneOffset.UTC)

  fun run(): String {
    val checkout = TixkitAndroid.checkoutUrl(
      TixkitCheckoutOptions(
        checkoutBaseUrl = "https://checkout.example.test",
        eventId = "evt_demo",
        organizationId = "org_demo",
        successUrl = "https://app.example.test/success",
        cancelUrl = "https://app.example.test/cancel",
        ticketTypes = mapOf("tt_demo" to 1),
      ),
    )
    val manifest = signedManifest()
    val scanner = TixkitAndroid.scannerClient(storage = TixkitMemorySecureStorage(), clock = clock)
    val controller = TixkitScannerController(
      scannerClient = scanner,
      mode = TixkitScannerMode.OFFLINE,
      manifestProvider = { manifest },
    )
    val scan = controller.handlePayload("ticket:evt_demo:tkt_demo_001")
    return "checkout:$checkout\nscan:${scan.outcome.wireValue}:${scan.ticketId}"
  }

  private fun signedManifest(): TixkitOfflineManifest {
    val unsigned = TixkitOfflineManifest(
      eventId = "evt_demo",
      checkInListId = "cil_demo",
      generatedAt = Instant.parse("2026-06-27T11:55:00Z"),
      expiresAt = Instant.parse("2026-06-27T13:00:00Z"),
      keyId = "manifest:demo",
      signature = "",
      tickets = listOf(
        TixkitOfflineTicket(
          ticketId = "tkt_demo_001",
          ticketTypeId = "tt_demo",
          attendeeName = "Demo Buyer",
          qrHash = tixkitQrHashForPayload("ticket:evt_demo:tkt_demo_001"),
          status = "valid",
        ),
      ),
    )
    return unsigned.copy(signature = signTixkitOfflineManifest(unsigned, "manifest-secret"))
  }
}
