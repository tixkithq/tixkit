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

  func testHashesQRPayloadsWithSHA256() {
    let payload = "signed-ticket-payload"
    let expected = SHA256.hash(data: Data(payload.utf8)).map { String(format: "%02x", $0) }.joined()
    XCTAssertEqual(tixkitQRHash(forPayload: payload), expected)
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
    XCTAssertEqual(accepted, TixkitScanResult(outcome: .accepted, message: "Check-in successful (offline)", ticketId: "tkt_1"))
    XCTAssertEqual(client.offlineScanCount, 1)

    let duplicate = client.scanOffline(payload, now: scanDate.addingTimeInterval(1))
    XCTAssertEqual(duplicate.outcome, .duplicate)
    XCTAssertEqual(duplicate.ticketId, "tkt_1")
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

private extension TixkitScannerClient {
  func testSignature(for manifest: TixkitOfflineManifest) -> String {
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
