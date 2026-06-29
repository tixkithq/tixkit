package com.tixkit.sdk

import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

class TixkitAndroidTest {
  private val clock = Clock.fixed(Instant.parse("2026-06-27T12:00:00Z"), ZoneOffset.UTC)

  @Test
  fun buildsHostedCheckoutHandoffUrl() {
    val url = TixkitAndroid.checkoutUrl(
      TixkitCheckoutOptions(
        checkoutBaseUrl = "https://checkout.example.test/",
        eventId = "evt_123",
        organizationId = "org_123",
        successUrl = "https://app.example.test/success",
        cancelUrl = "https://app.example.test/cancel",
        ticketTypes = linkedMapOf("tt_1" to 2, "prod_1" to 1),
        attendeeEmail = "buyer@example.test",
        promoCode = "SAVE 10",
        tracking = "mobile-app",
      ),
    )

    assertEquals(
      "https://checkout.example.test/checkout?eventId=evt_123&organizationId=org_123&successUrl=https%3A%2F%2Fapp.example.test%2Fsuccess&cancelUrl=https%3A%2F%2Fapp.example.test%2Fcancel&items=tt_1%3D2%2Cprod_1%3D1&attendeeEmail=buyer%40example.test&promoCode=SAVE%2010&tracking=mobile-app",
      url,
    )
  }

  @Test
  fun hashesQrPayloadsWithSha256() {
    assertEquals(
      "a587564d544459dd049a043aee1aa25285ec90ac11e61311a0cd30f558a36914",
      tixkitQrHashForPayload("ticket:evt_123:tkt_demo_001"),
    )
  }

  @Test
  fun fetchesPublicEventPagesWithoutScannerHeaders() {
    val urls = mutableListOf<String>()
    val headersSeen = mutableListOf<Map<String, String>>()
    val transport = TixkitPublicEventPageTransport { url, headers ->
      urls.add(url)
      headersSeen.add(headers)
      if (url.endsWith("/discovery-card")) {
        """
        {
          "title": "All Access",
          "summary": "Chicago",
          "tags": ["music"],
          "venueName": "The Salt Shed"
        }
        """.trimIndent()
      } else {
        """
        {
          "document": {
            "eventId": "evt_1",
            "channel": "event_page",
            "key": "main",
            "name": "Main event page",
            "locale": "en",
            "updatedAt": "2026-06-01T00:00:00.000Z"
          },
          "version": {
            "versionNumber": 3,
            "renderedHtml": "<main class=\"tixkit-event-page\">All Access</main>",
            "renderedText": "All Access",
            "publishedAt": "2026-06-02T00:00:00.000Z"
          },
          "page": {
            "html": "<main>All Access</main>",
            "text": "All Access",
            "headless": [{"type": "hero", "id": "hero", "title": "All Access"}],
            "discovery": {
              "title": "All Access",
              "summary": "Chicago",
              "tags": ["music"]
            }
          }
        }
        """.trimIndent()
      }
    }
    val client = TixkitAndroid.publicEventPageClient(
      apiBaseUrl = "https://api.test",
      transport = transport,
    )

    val contentPage = client.getContentPage("evt_1", locale = "en")
    assertEquals("evt_1", contentPage.document.eventId)
    assertEquals("All Access", contentPage.page.discovery.title)
    client.getEventPage("evt_1", locale = "en")
    client.getEventPageBySlug("all-access", host = "events.example.com", locale = "en")
    val card = client.getEventDiscoveryCard("evt_1")
    assertEquals("The Salt Shed", card.venueName)

    assertEquals(
      listOf(
        "https://api.test/v1/public/events/evt_1/content-page?locale=en",
        "https://api.test/v1/public/events/evt_1/page?locale=en",
        "https://api.test/v1/public/events/by-slug/all-access/page?host=events.example.com&locale=en",
        "https://api.test/v1/public/events/evt_1/discovery-card",
      ),
      urls,
    )
    headersSeen.forEach { headers ->
      assertEquals("2026-01-01", headers["X-Tixkit-Version"])
      assertFalse(headers.containsKey("Authorization"))
      assertFalse(headers.containsKey("X-Device-Id"))
      assertFalse(headers.containsKey("X-Device-Secret"))
    }
  }

  @Test
  fun signsAndVerifiesOfflineManifest() {
    val unsigned = manifest(signature = "")
    val signed = unsigned.copy(signature = signTixkitOfflineManifest(unsigned, "manifest-secret"))

    assertTrue(verifyTixkitOfflineManifest(signed, "manifest-secret", clock))
    assertFalse(verifyTixkitOfflineManifest(signed.copy(keyId = "manifest:other"), "manifest-secret", clock))
    assertFalse(verifyTixkitOfflineManifest(signed, "wrong-secret", clock))
  }

  @Test
  fun acceptsOfflineTicketThenDeduplicatesDeviceReplay() {
    val client = TixkitAndroid.scannerClient(storage = TixkitMemorySecureStorage(), clock = clock)
    val signedManifest = signedManifest()

    val first = client.scanOffline("ticket:evt_123:tkt_demo_001", signedManifest)
    val replay = client.scanOffline("ticket:evt_123:tkt_demo_001", signedManifest)

    assertEquals(TixkitScanOutcome.ACCEPTED, first.outcome)
    assertEquals("tkt_demo_001", first.ticketId)
    assertEquals(TixkitScanOutcome.DUPLICATE, replay.outcome)
    assertEquals(listOf(tixkitQrHashForPayload("ticket:evt_123:tkt_demo_001")), client.pendingOfflineScanHashes())
  }

  @Test
  fun rejectsRevokedOfflineTicket() {
    val client = TixkitAndroid.scannerClient(storage = TixkitMemorySecureStorage(), clock = clock)
    val result = client.scanOffline("ticket:evt_123:tkt_revoked", signedManifest())

    assertEquals(TixkitScanOutcome.REVOKED, result.outcome)
    assertEquals("tkt_revoked", result.ticketId)
  }

  @Test
  fun syncRemovesAcceptedScansAndKeepsDuplicateConflictsPending() {
    val client = TixkitAndroid.scannerClient(storage = TixkitMemorySecureStorage(), clock = clock)
    client.scanOffline("ticket:evt_123:tkt_demo_001", signedManifest())
    client.scanOffline("ticket:evt_123:tkt_other", signedManifest())
    val conflicts = mutableListOf<String>()

    val result = client.syncScans(
      uploader = { hashes ->
        TixkitSyncResult(
          accepted = 1,
          duplicates = 1,
          invalid = 0,
          results = listOf(
            mapOf("qrHash" to hashes[0], "outcome" to "accepted"),
            mapOf("qrHash" to hashes[1], "outcome" to "duplicate"),
          ),
        )
      },
      onConflict = { qrHash, outcome -> conflicts.add("$qrHash:$outcome") },
    )

    assertEquals(1, result.accepted)
    assertEquals(1, result.duplicates)
    assertTrue(conflicts.single().endsWith(":duplicate"))
    assertEquals(listOf(tixkitQrHashForPayload("ticket:evt_123:tkt_other")), client.pendingOfflineScanHashes())
  }

  @Test
  fun storesCredentialsInSecureStorageAdapter() {
    val storage = TixkitMemorySecureStorage()
    val store = TixkitAndroid.scannerCredentialStore(storage)
    val credentials = TixkitScannerCredentials(
      apiKey = "tk_live_scanner",
      deviceId = "device_123",
      organizationId = "org_123",
      eventId = "evt_123",
      checkInListId = "cil_123",
    )

    store.save(credentials)

    assertEquals(credentials, store.load())
    assertNotEquals(credentials.apiKey, storage.getItem("tixkit.scanner.credentials"))
    store.clear()
    assertEquals(null, store.load())
  }

  @Test
  fun restoresPersistedOfflineScans() {
    val storage = TixkitMemorySecureStorage()
    val firstClient = TixkitAndroid.scannerClient(storage = storage, clock = clock)
    firstClient.scanOffline("ticket:evt_123:tkt_demo_001", signedManifest())

    val secondClient = TixkitAndroid.scannerClient(storage = storage, clock = clock)

    assertEquals(
      listOf(tixkitQrHashForPayload("ticket:evt_123:tkt_demo_001")),
      secondClient.pendingOfflineScanHashes(),
    )
  }

  @Test
  fun controllerAdaptsAppOwnedQrReaders() {
    val client = TixkitAndroid.scannerClient(storage = TixkitMemorySecureStorage(), clock = clock)
    val controller = TixkitScannerController(
      scannerClient = client,
      mode = TixkitScannerMode.OFFLINE,
      manifestProvider = { signedManifest() },
    )

    val result = controller.handlePayload("ticket:evt_123:tkt_demo_001")

    assertEquals(TixkitScanOutcome.ACCEPTED, result.outcome)
  }

  private fun signedManifest(): TixkitOfflineManifest {
    val unsigned = manifest(signature = "")
    return unsigned.copy(signature = signTixkitOfflineManifest(unsigned, "manifest-secret"))
  }

  private fun manifest(signature: String): TixkitOfflineManifest =
    TixkitOfflineManifest(
      eventId = "evt_123",
      checkInListId = "cil_123",
      generatedAt = Instant.parse("2026-06-27T11:55:00Z"),
      expiresAt = Instant.parse("2026-06-27T13:00:00Z"),
      keyId = "manifest:test",
      signature = signature,
      tickets = listOf(
        TixkitOfflineTicket(
          ticketId = "tkt_demo_001",
          ticketTypeId = "tt_vip",
          attendeeName = "Demo Buyer",
          qrHash = tixkitQrHashForPayload("ticket:evt_123:tkt_demo_001"),
          status = "valid",
        ),
        TixkitOfflineTicket(
          ticketId = "tkt_other",
          ticketTypeId = "tt_ga",
          attendeeName = "Other Buyer",
          qrHash = tixkitQrHashForPayload("ticket:evt_123:tkt_other"),
          status = "issued",
        ),
        TixkitOfflineTicket(
          ticketId = "tkt_revoked",
          ticketTypeId = "tt_ga",
          attendeeName = "Revoked Buyer",
          qrHash = tixkitQrHashForPayload("ticket:evt_123:tkt_revoked"),
          status = "revoked",
        ),
      ),
    )
}
