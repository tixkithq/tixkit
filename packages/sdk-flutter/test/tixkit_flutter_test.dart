import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tixkit_flutter/tixkit_flutter.dart';

void main() {
  test('builds checkout handoff URLs', () {
    final uri = tixkitCheckoutHandoffUri(
      const TixkitCheckoutHandoffOptions(
        checkoutBaseUrl: 'https://checkout.example.test',
        eventId: 'evt_1',
        brandId: 'brd_1',
        items: [
          TixkitCheckoutHandoffItem(ticketTypeId: 'tt_1', quantity: 2),
          TixkitCheckoutHandoffItem(productId: 'prod_1', quantity: 1),
        ],
        products: ['prod_2'],
        discountCode: 'SAVE20',
        accessCode: 'VIP',
        trackingId: 'campaign_1',
        affiliateCode: 'AFF1',
        locale: 'en',
        theme: 'dark',
        mode: 'redirect',
        successUrl: 'myapp://checkout/success',
        cancelUrl: 'myapp://checkout/cancel',
      ),
    );

    expect(
      uri.toString(),
      'https://checkout.example.test/checkout?eventId=evt_1&brand=brd_1&items=tt_1%3D2%2Cprod_1%3D1&products=prod_2&discount=SAVE20&accessCode=VIP&tracking=campaign_1&affiliate=AFF1&locale=en&theme=dark&mode=redirect&successUrl=myapp%3A%2F%2Fcheckout%2Fsuccess&cancelUrl=myapp%3A%2F%2Fcheckout%2Fcancel',
    );
  });

  test('hashes QR payloads with SHA-256', () {
    const payload = 'signed-ticket-payload';
    expect(tixkitQrHashForPayload(payload), sha256.convert(utf8.encode(payload)).toString());
  });

  test('verifies signed offline manifests', () {
    const key = 'manifest-signing-key';
    final unsigned = {
      'eventId': 'evt_1',
      'checkInListId': 'cil_1',
      'generatedAt': '2026-06-01T00:00:00.000Z',
      'expiresAt': '2027-06-01T00:00:00.000Z',
      'keyId': 'manifest:v1',
      'tickets': [
        {
          'ticketId': 'tkt_1',
          'ticketTypeId': 'tt_1',
          'attendeeName': 'Ada Lovelace',
          'qrHash': tixkitQrHashForPayload('signed-ticket-payload'),
          'status': 'valid',
        },
      ],
    };
    final signature = Hmac(sha256, utf8.encode(key)).convert(utf8.encode(jsonEncode(unsigned))).toString();
    final manifest = TixkitOfflineManifest.fromJson({...unsigned, 'signature': signature});
    final client = TixkitScannerClient(
      deviceId: 'sd_public_1',
      deviceSecret: 'scanner-secret',
      manifestSigningKey: key,
      storage: TixkitMemoryScannerStorage(),
    );

    expect(client.verifyManifestSignature(manifest), isTrue);
  });
}
