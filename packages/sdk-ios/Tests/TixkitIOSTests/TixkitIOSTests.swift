import CryptoKit
import XCTest

@testable import TixkitIOS

final class TixkitIOSTests: XCTestCase {
  func testBuildsCheckoutHandoffURL() throws {
    let url = tixkitCheckoutHandoffURL(
      TixkitCheckoutHandoffOptions(
        eventId: "evt_1",
        checkoutBaseURL: try XCTUnwrap(URL(string: "https://checkout.example.test")),
        brandId: "brd_1",
        items: [
          TixkitCheckoutHandoffItem(ticketTypeId: "tt_1", quantity: 2),
          TixkitCheckoutHandoffItem(productId: "prod_1", quantity: 1),
        ],
        products: ["prod_2"],
        discountCode: "SAVE20",
        accessCode: "VIP",
        trackingId: "campaign_1",
        affiliateCode: "AFF1",
        locale: "en",
        theme: "dark",
        mode: "redirect",
        successURL: "myapp://checkout/success",
        cancelURL: "myapp://checkout/cancel"
      )
    )

    XCTAssertEqual(
      url.absoluteString,
      "https://checkout.example.test/checkout?eventId=evt_1&brand=brd_1&items=tt_1%3D2,prod_1%3D1&products=prod_2&discount=SAVE20&accessCode=VIP&tracking=campaign_1&affiliate=AFF1&locale=en&theme=dark&mode=redirect&successUrl=myapp://checkout/success&cancelUrl=myapp://checkout/cancel"
    )
  }

  func testBuildsResaleCheckoutHandoffURL() throws {
    let url = tixkitCheckoutHandoffURL(
      TixkitCheckoutHandoffOptions(
        eventId: "evt_1",
        checkoutBaseURL: try XCTUnwrap(URL(string: "https://checkout.example.test")),
        items: [TixkitCheckoutHandoffItem(resaleListingId: "lst_1", quantity: 1)]
      )
    )

    XCTAssertEqual(
      url.absoluteString, "https://checkout.example.test/checkout?eventId=evt_1&resaleListing=lst_1"
    )
  }

  func testHashesQRPayloadsWithSHA256() {
    let payload = "signed-ticket-payload"
    let expected = SHA256.hash(data: Data(payload.utf8)).map { String(format: "%02x", $0) }.joined()
    XCTAssertEqual(tixkitQRHash(forPayload: payload), expected)
  }

  func testFetchesPublicEventPagesWithoutScannerHeaders() async throws {
    var requestURLs: [String] = []
    URLProtocolStub.handler = { request in
      requestURLs.append(request.url!.absoluteString)
      XCTAssertNil(request.value(forHTTPHeaderField: "X-Device-Id"))
      XCTAssertNil(request.value(forHTTPHeaderField: "X-Device-Secret"))
      XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
      let body: [String: Any]
      if request.url!.path.hasSuffix("/resale-listings") {
        body = [
          "items": [
            [
              "id": "lst_1",
              "eventId": "evt_1",
              "status": "listed",
              "priceCents": 5500,
              "currency": "USD",
              "faceValueCents": 5000,
            ]
          ],
          "hasMore": false,
        ]
      } else if request.url!.path.hasSuffix("/discovery-card") {
        body = [
          "title": "All Access",
          "summary": "Chicago",
          "tags": ["music"],
          "venueName": "The Salt Shed",
        ]
      } else {
        body = [
          "document": [
            "eventId": "evt_1",
            "channel": "event_page",
            "key": "main",
            "name": "Main event page",
            "locale": "en",
            "updatedAt": "2026-06-01T00:00:00.000Z",
          ],
          "version": [
            "versionNumber": 3,
            "publishedAt": "2026-06-02T00:00:00.000Z",
          ],
          "page": [
            "provider": "@puckeditor/core",
            "puckData": [
              "content": [
                [
                  "type": "Hero",
                  "props": ["id": "Hero-hero", "headline": "All Access"],
                ]
              ],
              "root": ["props": ["title": "All Access"]],
            ],
            "settings": ["locale": "en"],
            "discovery": [
              "title": "All Access",
              "summary": "Chicago",
              "tags": ["music"],
            ],
          ],
        ]
      }
      let data = try JSONSerialization.data(withJSONObject: body)
      return (
        HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!,
        data
      )
    }
    defer { URLProtocolStub.handler = nil }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [URLProtocolStub.self]
    let client = TixkitPublicEventPageClient(
      apiBaseURL: try XCTUnwrap(URL(string: "https://api.test")),
      urlSession: URLSession(configuration: configuration)
    )

    let contentPage = try await client.getContentPage(eventId: "evt_1", locale: "en")
    XCTAssertEqual(contentPage.document.eventId, "evt_1")
    XCTAssertEqual(contentPage.page.discovery.title, "All Access")
    XCTAssertEqual(contentPage.page.provider, "@puckeditor/core")
    XCTAssertEqual(contentPage.page.puckData.content.first?.type, "Hero")
    _ = try await client.getEventPage(eventId: "evt_1", locale: "en")
    _ = try await client.getEventPageBySlug(
      slug: "all-access", host: "events.example.com", locale: "en")
    let card = try await client.getEventDiscoveryCard(eventId: "evt_1")
    XCTAssertEqual(card.venueName, "The Salt Shed")
    let listings = try await client.listResaleListings(eventId: "evt_1", cursor: "lst_0", limit: 25)
    XCTAssertEqual(listings.items.first?.id, "lst_1")

    XCTAssertEqual(
      requestURLs,
      [
        "https://api.test/v1/public/events/evt_1/content-page?locale=en",
        "https://api.test/v1/public/events/evt_1/page?locale=en",
        "https://api.test/v1/public/events/by-slug/all-access/page?host=events.example.com&locale=en",
        "https://api.test/v1/public/events/evt_1/discovery-card",
        "https://api.test/v1/public/events/evt_1/resale-listings?cursor=lst_0&limit=25",
      ])
  }

  func testResaleClientUsesVersionedRequestsAndRequiredHeaders() async throws {
    var requestURLs: [String] = []
    var requestMethods: [String] = []
    var idempotencyKeys: [String?] = []
    var sessionTokens: [String?] = []
    URLProtocolStub.handler = { request in
      requestURLs.append(request.url!.absoluteString)
      requestMethods.append(request.httpMethod ?? "")
      idempotencyKeys.append(request.value(forHTTPHeaderField: "Idempotency-Key"))
      sessionTokens.append(request.value(forHTTPHeaderField: "X-Checkout-Session-Token"))
      XCTAssertEqual(request.value(forHTTPHeaderField: "X-Tixkit-Version"), TixkitAPIVersion)
      XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer tk_test_123")
      if request.httpMethod == "POST",
        request.url!.path.hasSuffix("/resale-listings")
          || request.url!.path.hasSuffix("/resale-listing")
      {
        let payload = try XCTUnwrap(request.httpBody)
        let json = try XCTUnwrap(
          JSONSerialization.jsonObject(with: payload) as? [String: Any])
        XCTAssertEqual(
          json["termsAcceptance"] as? NSDictionary,
          [
            "accepted": true,
            "termsVersion": "2026-07-16",
            "settlementModel": "organizer_managed",
            "refundModel": "manual_coordinated_resolution",
          ] as NSDictionary)
      }

      let body: [String: Any]
      if request.url!.path.hasSuffix("/resale-listings"), request.httpMethod == "GET" {
        body = [
          "items": [
            [
              "id": "lst_1",
              "eventId": "evt_1",
              "ticketId": "tkt_1",
              "status": "listed",
              "priceCents": 5500,
              "currency": "USD",
            ]
          ],
          "hasMore": false,
        ]
      } else if request.url!.path.hasSuffix("/settlement") {
        body = [
          "id": "rst_1", "listingId": "lst_2", "tenantId": "ten_1", "organizationId": "org_1",
          "brandId": "brd_1", "eventId": "evt_1", "sellerOrderId": "ord_seller",
          "buyerOrderId": "ord_buyer",
          "sellerTicketId": "tkt_seller", "buyerTicketId": "tkt_buyer", "currency": "USD",
          "grossCents": 5500,
          "feeCents": 500, "payableCents": 5000, "paidCents": 0, "reversedCents": 0,
          "recoveryCents": 0,
          "state": "pending", "termsVersion": "2026-07-16", "version": 1,
          "createdAt": "2026-07-16T00:00:00Z", "updatedAt": "2026-07-16T00:00:00Z",
          "entries": [
            [
              "id": "entry_1", "kind": "payable_accrued", "amountCents": 5000, "currency": "USD",
              "actorId": "system", "method": "checkout", "externalReferenceSha256": NSNull(),
              "reason": NSNull(), "createdAt": "2026-07-16T00:00:00Z",
            ]
          ],
        ]
      } else {
        body = [
          "id": request.url!.path.hasSuffix("/resale-listing") ? "lst_3" : "lst_2",
          "eventId": "evt_1",
          "ticketId": "tkt_1",
          "status": request.url!.path.hasSuffix("/delist") ? "delisted" : "listed",
          "priceCents": 5500,
          "currency": "USD",
        ]
      }

      let data = try JSONSerialization.data(withJSONObject: body)
      return (
        HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!,
        data
      )
    }
    defer { URLProtocolStub.handler = nil }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [URLProtocolStub.self]
    let client = TixkitResaleClient(
      apiBaseURL: try XCTUnwrap(URL(string: "https://api.test")),
      apiKey: "tk_test_123",
      urlSession: URLSession(configuration: configuration)
    )

    let page = try await client.listResaleListings(eventId: "evt_1", cursor: "lst_0", limit: 25)
    XCTAssertEqual(page.items.first?.id, "lst_1")
    let terms = TixkitResaleTermsAcceptance(
      accepted: true, termsVersion: "2026-07-16", settlementModel: "organizer_managed",
      refundModel: "manual_coordinated_resolution")
    _ = try await client.createTicketResaleListing(
      ticketId: "tkt_1",
      priceCents: 5500,
      idempotencyKey: "idem_create",
      termsAcceptance: terms
    )
    _ = try await client.createCheckoutTicketResaleListing(
      sessionId: "cs_1",
      ticketId: "tkt_1",
      priceCents: 5500,
      sessionToken: "client_token",
      idempotencyKey: "idem_checkout",
      termsAcceptance: terms
    )
    _ = try await client.delistResaleListing(listingId: "lst_2", idempotencyKey: "idem_delist")
    let settlement = try await client.getResaleSettlement(listingId: "lst_2")
    XCTAssertEqual(settlement.id, "rst_1")
    XCTAssertEqual(settlement.tenantId, "ten_1")
    XCTAssertEqual(settlement.entries.first?.kind, "payable_accrued")

    XCTAssertEqual(requestMethods, ["GET", "POST", "POST", "POST", "POST"])
    XCTAssertEqual(
      requestURLs.first, "https://api.test/v1/events/evt_1/resale-listings?cursor=lst_0&limit=25")
    XCTAssertEqual(
      idempotencyKeys, [nil, "idem_create", "idem_checkout", "idem_delist", "idem_complete"])
    XCTAssertEqual(sessionTokens, [nil, nil, "client_token", nil, nil])
  }

  func testVerifiesSignedOfflineManifestAndScansOffline() throws {
    let payload = "signed-ticket-payload"
    let manifest = signedManifest(ticketStatus: "valid", payload: payload)
    let client = TixkitScannerClient(
      deviceId: "sd_public_1",
      deviceSecret: "scanner-secret",
      manifestSigningKey: manifestSigningKey,
      storage: TixkitMemorySecureStorage()
    )

    XCTAssertTrue(client.verifyManifestSignature(manifest))
    client.setManifest(manifest)

    let accepted = client.scanOffline(payload, now: scanDate)
    XCTAssertEqual(
      accepted,
      TixkitScanResult(
        outcome: .accepted, message: "Check-in successful (offline)", ticketId: "tkt_1"))
    XCTAssertEqual(client.offlineScanCount, 1)

    let duplicate = client.scanOffline(payload, now: scanDate.addingTimeInterval(1))
    XCTAssertEqual(duplicate.outcome, .duplicate)
    XCTAssertEqual(duplicate.ticketId, "tkt_1")
  }

  func testVerifiesAPISignedOccurrenceScopedOfflineManifestFixture() throws {
    let manifest = TixkitOfflineManifest(
      eventId: "evt_1",
      checkInListId: "cil_1",
      generatedAt: generatedAt,
      expiresAt: generatedAt.addingTimeInterval(60),
      keyId: "manifest:test",
      signature: "d8fdb5795ec9219c5cb880dd2bee328cb6298e976098008cfe730e7a2b71be48",
      tickets: [
        TixkitOfflineTicket(
          ticketId: "tkt_b",
          ticketTypeId: "tt_vip",
          eventOccurrenceId: "occ_1",
          attendeeName: "Grace Hopper",
          qrHash: "hash_b",
          status: "valid"
        ),
        TixkitOfflineTicket(
          ticketId: "tkt_a",
          ticketTypeId: "tt_ga",
          attendeeName: "",
          qrHash: "hash_a",
          status: "issued"
        ),
      ]
    )
    let client = TixkitScannerClient(
      deviceId: "sd_public_1",
      deviceSecret: "scanner-secret",
      manifestSigningKey: "manifest-secret"
    )

    XCTAssertEqual(manifest.tickets.first?.eventOccurrenceId, "occ_1")
    XCTAssertTrue(client.verifyManifestSignature(manifest))
  }

  func testRejectsRevokedOfflineTickets() {
    let manifest = signedManifest(ticketStatus: "refunded", payload: "signed-ticket-payload")
    let client = TixkitScannerClient(
      deviceId: "sd_public_1",
      deviceSecret: "scanner-secret",
      manifestSigningKey: manifestSigningKey
    )
    client.setManifest(manifest)

    let result = client.scanOffline("signed-ticket-payload", now: scanDate)
    XCTAssertEqual(result.outcome, .revoked)
  }

  func testPersistsScannerCredentialsInStorage() throws {
    let storage = TixkitMemorySecureStorage()
    let credentials = TixkitScannerCredentials(
      deviceId: "sd_public_1",
      deviceSecret: "scanner-secret",
      manifestSigningKey: manifestSigningKey
    )

    try TixkitScannerCredentialStore.save(credentials, in: storage)
    XCTAssertEqual(try TixkitScannerCredentialStore.load(from: storage), credentials)
    try TixkitScannerCredentialStore.clear(from: storage)
    XCTAssertNil(try TixkitScannerCredentialStore.load(from: storage))
  }

  func testRestoresOfflineScansFromStorage() throws {
    let storage = TixkitMemorySecureStorage()
    let manifest = signedManifest(ticketStatus: "valid", payload: "signed-ticket-payload")
    let client = TixkitScannerClient(
      deviceId: "sd_public_1",
      deviceSecret: "scanner-secret",
      manifestSigningKey: manifestSigningKey,
      storage: storage
    )
    client.setManifest(manifest)
    XCTAssertEqual(client.scanOffline("signed-ticket-payload", now: scanDate).outcome, .accepted)

    let restored = TixkitScannerClient(
      deviceId: "sd_public_1",
      deviceSecret: "scanner-secret",
      manifestSigningKey: manifestSigningKey,
      storage: storage
    )
    try restored.restoreOfflineScans()
    XCTAssertEqual(restored.offlineScanCount, 1)
  }

  func testSyncReportsConflictsAndKeepsDuplicateScansPending() async throws {
    let storage = TixkitMemorySecureStorage()
    let payload = "signed-ticket-payload"
    let manifest = signedManifest(ticketStatus: "valid", payload: payload)
    let conflicts = ConflictRecorder()
    let duplicateHash = tixkitQRHash(forPayload: payload)
    URLProtocolStub.handler = { request in
      XCTAssertEqual(request.url?.path, "/v1/check-ins/sync")
      let responseBody = try JSONSerialization.data(withJSONObject: [
        "accepted": 0,
        "duplicates": 1,
        "invalid": 0,
        "results": [["qrHash": duplicateHash, "outcome": "duplicate"]],
      ])
      return (
        HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!,
        responseBody
      )
    }
    defer { URLProtocolStub.handler = nil }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [URLProtocolStub.self]
    let session = URLSession(configuration: configuration)
    let client = TixkitScannerClient(
      deviceId: "sd_public_1",
      deviceSecret: "scanner-secret",
      manifestSigningKey: manifestSigningKey,
      storage: storage,
      onSyncConflict: { qrHash, outcome in conflicts.append("\(qrHash):\(outcome)") },
      urlSession: session
    )

    client.setManifest(manifest)
    XCTAssertEqual(client.scanOffline(payload, now: scanDate).outcome, .accepted)

    let result = try await client.syncScans()

    XCTAssertEqual(result.duplicates, 1)
    XCTAssertEqual(conflicts.values.count, 1)
    XCTAssertTrue(conflicts.values[0].hasSuffix(":duplicate"))
    XCTAssertEqual(client.offlineScanCount, 1)
  }

  private let manifestSigningKey = "manifest-signing-key"
  private let generatedAt = Date(timeIntervalSince1970: 1_780_272_000)
  private let expiresAt = Date(timeIntervalSince1970: 1_811_808_000)
  private let scanDate = Date(timeIntervalSince1970: 1_780_358_400)

  private func signedManifest(ticketStatus: String, payload: String) -> TixkitOfflineManifest {
    let ticket = TixkitOfflineTicket(
      ticketId: "tkt_1",
      ticketTypeId: "tt_1",
      attendeeName: "Ada Lovelace",
      qrHash: tixkitQRHash(forPayload: payload),
      status: ticketStatus
    )
    let unsigned = TixkitOfflineManifest(
      eventId: "evt_1",
      checkInListId: "cil_1",
      generatedAt: generatedAt,
      expiresAt: expiresAt,
      keyId: "manifest:v1",
      signature: "",
      tickets: [ticket]
    )
    let signature = TixkitScannerClient(
      deviceId: "sd_public_1",
      deviceSecret: "scanner-secret",
      manifestSigningKey: manifestSigningKey
    ).testSignature(for: unsigned)
    return TixkitOfflineManifest(
      eventId: unsigned.eventId,
      checkInListId: unsigned.checkInListId,
      generatedAt: unsigned.generatedAt,
      expiresAt: unsigned.expiresAt,
      keyId: unsigned.keyId,
      signature: signature,
      tickets: unsigned.tickets
    )
  }
}

private final class ConflictRecorder: @unchecked Sendable {
  private let lock = NSLock()
  private var storage: [String] = []

  var values: [String] {
    lock.withLock { storage }
  }

  func append(_ value: String) {
    lock.withLock { storage.append(value) }
  }
}

private final class URLProtocolStub: URLProtocol {
  static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

  override class func canInit(with request: URLRequest) -> Bool {
    true
  }

  override class func canonicalRequest(for request: URLRequest) -> URLRequest {
    request
  }

  override func startLoading() {
    do {
      let handler = try XCTUnwrap(URLProtocolStub.handler)
      let (response, data) = try handler(request)
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: data)
      client?.urlProtocolDidFinishLoading(self)
    } catch {
      client?.urlProtocol(self, didFailWithError: error)
    }
  }

  override func stopLoading() {}
}

extension TixkitScannerClient {
  fileprivate func testSignature(for manifest: TixkitOfflineManifest) -> String {
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .custom { date, encoder in
      var container = encoder.singleValueContainer()
      let formatter = ISO8601DateFormatter()
      formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
      formatter.timeZone = TimeZone(secondsFromGMT: 0)
      try container.encode(formatter.string(from: date))
    }
    let unsigned = """
      {"eventId":"\(manifest.eventId)","checkInListId":"\(manifest.checkInListId)","generatedAt":"2026-06-01T00:00:00.000Z","expiresAt":"2027-06-01T00:00:00.000Z","keyId":"\(manifest.keyId)","tickets":[{"ticketId":"tkt_1","ticketTypeId":"tt_1","attendeeName":"Ada Lovelace","qrHash":"\(manifest.tickets[0].qrHash)","status":"\(manifest.tickets[0].status)"}]}
      """
    let key = SymmetricKey(data: Data(manifestSigningKey.utf8))
    return HMAC<SHA256>.authenticationCode(for: Data(unsigned.utf8), using: key)
      .map { String(format: "%02x", $0) }
      .joined()
  }
}
