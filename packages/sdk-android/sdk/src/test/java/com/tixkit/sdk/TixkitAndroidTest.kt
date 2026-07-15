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
  fun buildsHostedCheckoutHandoffUrlForResaleListing() {
    val url = TixkitAndroid.checkoutUrl(
      TixkitCheckoutOptions(
        checkoutBaseUrl = "https://checkout.example.test/",
        eventId = "evt_123",
        organizationId = "org_123",
        successUrl = "https://app.example.test/success",
        cancelUrl = "https://app.example.test/cancel",
        resaleListingId = "lst_1",
      ),
    )

    assertEquals(
      "https://checkout.example.test/checkout?eventId=evt_123&organizationId=org_123&successUrl=https%3A%2F%2Fapp.example.test%2Fsuccess&cancelUrl=https%3A%2F%2Fapp.example.test%2Fcancel&resaleListing=lst_1",
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
      if (url.contains("/resale-listings")) {
        """
        {
          "items": [{
            "id": "lst_1",
            "eventId": "evt_1",
            "status": "listed",
            "priceCents": 5500,
            "currency": "USD",
            "faceValueCents": 5000
          }],
          "hasMore": false
        }
        """.trimIndent()
      } else if (url.endsWith("/discovery-card")) {
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
            "publishedAt": "2026-06-02T00:00:00.000Z"
          },
          "page": {
            "provider": "@puckeditor/core",
            "puckData": {
              "content": [{"type": "Hero", "props": {"id": "Hero-hero", "headline": "All Access"}}],
              "root": {"props": {"title": "All Access"}}
            },
            "settings": {"locale": "en"},
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
    assertEquals("@puckeditor/core", contentPage.page.provider)
    assertEquals("Hero", contentPage.page.puckData.content.single().type)
    client.getEventPage("evt_1", locale = "en")
    client.getEventPageBySlug("all-access", host = "events.example.com", locale = "en")
    val card = client.getEventDiscoveryCard("evt_1")
    assertEquals("The Salt Shed", card.venueName)
    val listings = client.listResaleListings("evt_1", cursor = "lst_0", limit = 25)
    assertEquals("lst_1", listings.items.single().id)

    assertEquals(
      listOf(
        "https://api.test/v1/public/events/evt_1/content-page?locale=en",
        "https://api.test/v1/public/events/evt_1/page?locale=en",
        "https://api.test/v1/public/events/by-slug/all-access/page?host=events.example.com&locale=en",
        "https://api.test/v1/public/events/evt_1/discovery-card",
        "https://api.test/v1/public/events/evt_1/resale-listings?cursor=lst_0&limit=25",
      ),
      urls,
    )
    headersSeen.forEach { headers ->
      assertEquals("2026-08-02", headers["X-Tixkit-Version"])
      assertFalse(headers.containsKey("Authorization"))
      assertFalse(headers.containsKey("X-Device-Id"))
      assertFalse(headers.containsKey("X-Device-Secret"))
    }
  }

  @Test
  fun resaleClientUsesVersionedRequestsAndRequiredHeaders() {
    val requests = mutableListOf<String>()
    val methods = mutableListOf<String>()
    val idempotencyKeys = mutableListOf<String?>()
    val sessionTokens = mutableListOf<String?>()
    val bodies = mutableListOf<String?>()
    val transport = TixkitResaleTransport { method, url, headers, body ->
      requests.add(url)
      methods.add(method)
      idempotencyKeys.add(headers["Idempotency-Key"])
      sessionTokens.add(headers["X-Checkout-Session-Token"])
      bodies.add(body)
      assertEquals("2026-08-02", headers["X-Tixkit-Version"])
      assertEquals("Bearer tk_test_123", headers["Authorization"])

      when {
        method == "GET" && url.contains("/events/evt_1/resale-listings") ->
          """
          {
            "items": [{
              "id": "lst_1",
              "eventId": "evt_1",
              "ticketId": "tkt_1",
              "status": "listed",
              "priceCents": 5500,
              "currency": "USD"
            }],
            "hasMore": false
          }
          """.trimIndent()
        url.endsWith("/complete") ->
          """
          {
            "listing": {
              "id": "lst_2",
              "eventId": "evt_1",
              "ticketId": "tkt_1",
              "status": "sold",
              "priceCents": 5500,
              "currency": "USD"
            },
            "buyerTicket": {"id": "tkt_2"},
            "buyerAttendee": {"id": "att_2"}
          }
          """.trimIndent()
        else ->
          """
          {
            "id": "${if (url.endsWith("/resale-listing")) "lst_3" else "lst_2"}",
            "eventId": "evt_1",
            "ticketId": "tkt_1",
            "status": "${if (url.endsWith("/delist")) "delisted" else "listed"}",
            "priceCents": 5500,
            "currency": "USD"
          }
          """.trimIndent()
      }
    }
    val client = TixkitAndroid.resaleClient(
      apiBaseUrl = "https://api.test",
      apiKey = "tk_test_123",
      transport = transport,
    )

    val page = client.listResaleListings("evt_1", cursor = "lst_0", limit = 25)
    assertEquals("lst_1", page.items.single().id)
    client.createTicketResaleListing("tkt_1", priceCents = 5500, idempotencyKey = "idem_create")
    client.createCheckoutTicketResaleListing(
      "cs_1",
      "tkt_1",
      priceCents = 5500,
      sessionToken = "client_token",
      idempotencyKey = "idem_checkout",
    )
    client.delistResaleListing("lst_2", idempotencyKey = "idem_delist")
    val completed = client.completeResaleListing(
      "lst_2",
      buyerId = "usr_1",
      buyerEmail = "buyer@example.test",
      idempotencyKey = "idem_complete",
      externalPaymentReference = "pi_1",
    )

    assertEquals("sold", completed.listing.status)
    assertEquals("tkt_2", completed.buyerTicketId)
    assertEquals(listOf("GET", "POST", "POST", "POST", "POST"), methods)
    assertEquals(
      "https://api.test/v1/events/evt_1/resale-listings?cursor=lst_0&limit=25",
      requests.first(),
    )
    assertEquals(listOf(null, "idem_create", "idem_checkout", "idem_delist", "idem_complete"), idempotencyKeys)
    assertEquals(listOf(null, null, "client_token", null, null), sessionTokens)
    assertTrue(bodies[1]!!.contains("\"priceCents\":5500"))
    assertTrue(bodies[4]!!.contains("\"externalPaymentReference\":\"pi_1\""))
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
  fun verifiesApiSignedOfflineManifestFixture() {
    val apiClock = Clock.fixed(Instant.parse("2026-06-01T00:00:30Z"), ZoneOffset.UTC)
    val manifest = TixkitOfflineManifest(
      eventId = "evt_1",
      checkInListId = "cil_1",
      generatedAt = Instant.parse("2026-06-01T00:00:00Z"),
      expiresAt = Instant.parse("2026-06-01T00:01:00Z"),
      keyId = "manifest:test",
      signature = "d8fdb5795ec9219c5cb880dd2bee328cb6298e976098008cfe730e7a2b71be48",
      tickets = listOf(
        TixkitOfflineTicket(
          ticketId = "tkt_b",
          ticketTypeId = "tt_vip",
          eventOccurrenceId = "occ_1",
          attendeeName = "Grace Hopper",
          qrHash = "hash_b",
          status = "valid",
        ),
        TixkitOfflineTicket(
          ticketId = "tkt_a",
          ticketTypeId = "tt_ga",
          attendeeName = "",
          qrHash = "hash_a",
          status = "issued",
        ),
      ),
    )

    assertTrue(verifyTixkitOfflineManifest(manifest, "manifest-secret", apiClock))
    assertFalse(verifyTixkitOfflineManifest(manifest.copy(eventId = "evt_tampered"), "manifest-secret", apiClock))
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
