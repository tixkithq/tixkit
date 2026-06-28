import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
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

  test('reports sync conflicts and keeps duplicate scans pending for retry', () async {
    const key = 'manifest-signing-key';
    const payload = 'signed-ticket-payload';
    final manifest = signedManifest(
      key: key,
      payload: payload,
      ticketStatus: 'valid',
    );
    final conflicts = <String>[];
    final client = TixkitScannerClient(
      deviceId: 'sd_public_1',
      deviceSecret: 'scanner-secret',
      manifestSigningKey: key,
      storage: TixkitMemoryScannerStorage(),
      onSyncConflict: (qrHash, outcome) => conflicts.add('$qrHash:$outcome'),
      httpClient: MockClient((request) async {
        if (request.url.path.endsWith('/manifest')) {
          return http.Response(jsonEncode(manifest.toJson()), 200);
        }
        if (request.url.path.endsWith('/check-ins/sync')) {
          final body = jsonDecode(request.body) as Map<String, Object?>;
          final scans = body['scans'] as List<Object?>;
          final scan = scans.single as Map<String, Object?>;
          return http.Response(
            jsonEncode({
              'accepted': 0,
              'duplicates': 1,
              'invalid': 0,
              'results': [
                {'qrHash': scan['qrHash'], 'outcome': 'duplicate'},
              ],
            }),
            200,
          );
        }
        return http.Response('not found', 404);
      }),
    );

    await client.downloadManifest('evt_1', 'cil_1');
    expect(client.scanOffline(payload).outcome, TixkitScanOutcome.accepted);

    final result = await client.syncScans();

    expect(result.duplicates, 1);
    expect(conflicts, hasLength(1));
    expect(conflicts.single, endsWith(':duplicate'));
    final replay = await client.syncScans();
    expect(replay.duplicates, 1);
  });
}

TixkitOfflineManifest signedManifest({
  required String key,
  required String payload,
  required String ticketStatus,
}) {
  final unsigned = TixkitOfflineManifest(
    eventId: 'evt_1',
    checkInListId: 'cil_1',
    generatedAt: DateTime.parse('2026-06-01T00:00:00.000Z'),
    expiresAt: DateTime.parse('2027-06-01T00:00:00.000Z'),
    keyId: 'manifest:v1',
    signature: '',
    tickets: [
      TixkitOfflineTicket(
        ticketId: 'tkt_1',
        ticketTypeId: 'tt_1',
        attendeeName: 'Ada Lovelace',
        qrHash: tixkitQrHashForPayload(payload),
        status: ticketStatus,
      ),
    ],
  );
  final signature = Hmac(
    sha256,
    utf8.encode(key),
  ).convert(utf8.encode(jsonEncode(unsigned.toUnsignedJson()))).toString();
  return TixkitOfflineManifest(
    eventId: unsigned.eventId,
    checkInListId: unsigned.checkInListId,
    generatedAt: unsigned.generatedAt,
    expiresAt: unsigned.expiresAt,
    keyId: unsigned.keyId,
    signature: signature,
    tickets: unsigned.tickets,
  );
}
