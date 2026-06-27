import CryptoKit
import Foundation
import TixkitIOS

let payload = "demo-signed-ticket-payload"
let signingKey = "offline-manifest-signing-key"
let qrHash = tixkitQRHash(forPayload: payload)
let unsignedManifestJSON = """
{"eventId":"evt_demo","checkInListId":"cil_demo","generatedAt":"2026-06-01T00:00:00.000Z","expiresAt":"2027-06-01T00:00:00.000Z","keyId":"manifest:demo","tickets":[{"ticketId":"tkt_demo_001","ticketTypeId":"tt_general","attendeeName":"Ada Lovelace","qrHash":"\(qrHash)","status":"valid"}]}
"""
let signature = HMAC<SHA256>
  .authenticationCode(for: Data(unsignedManifestJSON.utf8), using: SymmetricKey(data: Data(signingKey.utf8)))
  .map { String(format: "%02x", $0) }
  .joined()
let manifestJSON = unsignedManifestJSON.dropLast() + #","signature":"\#(signature)"}"#
let manifest = try JSONDecoder().decode(TixkitOfflineManifest.self, from: Data(manifestJSON.utf8))
let storage = TixkitMemorySecureStorage()
let client = TixkitScannerClient(
  deviceId: "sd_public_demo",
  deviceSecret: "scanner-secret",
  manifestSigningKey: signingKey,
  storage: storage
)

guard client.verifyManifestSignature(manifest) else {
  fatalError("Demo manifest signature failed verification")
}

client.setManifest(manifest)
let checkoutURL = tixkitCheckoutHandoffURL(
  TixkitCheckoutHandoffOptions(
    eventId: "evt_demo",
    checkoutBaseURL: URL(string: "https://checkout.example.test")!,
    brandId: "brd_demo",
    items: [TixkitCheckoutHandoffItem(ticketTypeId: "tt_general", quantity: 2)],
    successURL: "tixkit-demo://checkout/success",
    cancelURL: "tixkit-demo://checkout/cancel"
  )
)
let result = client.scanOffline(payload)

guard result.outcome == .accepted, result.ticketId == "tkt_demo_001" else {
  fatalError("Expected accepted demo scan, got \(result.outcome.rawValue)")
}

try TixkitScannerCredentialStore.save(
  TixkitScannerCredentials(deviceId: client.deviceId, deviceSecret: client.deviceSecret, manifestSigningKey: signingKey),
  in: storage
)

print("checkout:\(checkoutURL.absoluteString)")
print("scan:\(result.outcome.rawValue):\(result.ticketId ?? "")")
