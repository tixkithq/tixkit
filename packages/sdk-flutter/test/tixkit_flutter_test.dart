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

  test('builds resale checkout handoff URLs', () {
    final uri = tixkitCheckoutHandoffUri(
      const TixkitCheckoutHandoffOptions(
        checkoutBaseUrl: 'https://checkout.example.test',
        eventId: 'evt_1',
        items: [TixkitCheckoutHandoffItem(resaleListingId: 'lst_1', quantity: 1)],
      ),
    );

    expect(uri.toString(), 'https://checkout.example.test/checkout?eventId=evt_1&resaleListing=lst_1');
  });

  test('fetches public event pages and discovery cards', () async {
    final urls = <String>[];
    final client = TixkitPublicEventPageClient(
      apiBaseUrl: 'https://api.test',
      httpClient: MockClient((request) async {
        urls.add(request.url.toString());
        expect(request.headers['X-Device-Id'], isNull);
        expect(request.headers['Authorization'], isNull);
        if (request.url.path.endsWith('/resale-listings')) {
          return http.Response(
            jsonEncode({
              'items': [
                {'id': 'lst_1', 'eventId': 'evt_1', 'status': 'listed', 'priceCents': 5500, 'currency': 'USD', 'faceValueCents': 5000},
              ],
              'hasMore': false,
            }),
            200,
          );
        }
        if (request.url.path.endsWith('/discovery-card')) {
          return http.Response(
            jsonEncode({
              'title': 'All Access',
              'summary': 'Chicago',
              'tags': ['music'],
              'venueName': 'The Salt Shed',
            }),
            200,
          );
        }
        return http.Response(
          jsonEncode({
            'document': {
              'eventId': 'evt_1',
              'channel': 'event_page',
              'key': 'main',
              'name': 'Main event page',
              'locale': 'en',
              'updatedAt': '2026-06-01T00:00:00.000Z',
            },
            'version': {
              'versionNumber': 3,
              'publishedAt': '2026-06-02T00:00:00.000Z',
            },
            'page': {
              'provider': '@puckeditor/core',
              'puckData': {
                'content': [
                  {
                    'type': 'Hero',
                    'props': {'id': 'Hero-hero', 'headline': 'All Access'},
                  },
                ],
                'root': {
                  'props': {'title': 'All Access'},
                },
              },
              'settings': {'locale': 'en'},
              'discovery': {
                'title': 'All Access',
                'summary': 'Chicago',
                'tags': ['music'],
              },
            },
          }),
          200,
        );
      }),
    );

    final page = await client.getContentPage('evt_1', locale: 'en');
    expect(page.document.eventId, 'evt_1');
    expect(page.page.discovery.title, 'All Access');
    expect(page.page.provider, '@puckeditor/core');
    expect(page.page.puckData.content.single.type, 'Hero');
    await client.getEventPage('evt_1', locale: 'en');
    await client.getEventPageBySlug('all-access', host: 'events.example.com', locale: 'en');
    final card = await client.getEventDiscoveryCard('evt_1');
    expect(card.venueName, 'The Salt Shed');
    final listings = await client.listResaleListings('evt_1', cursor: 'lst_0', limit: 25);
    expect(listings.items.single.id, 'lst_1');

    expect(urls, [
      'https://api.test/v1/public/events/evt_1/content-page?locale=en',
      'https://api.test/v1/public/events/evt_1/page?locale=en',
      'https://api.test/v1/public/events/by-slug/all-access/page?host=events.example.com&locale=en',
      'https://api.test/v1/public/events/evt_1/discovery-card',
      'https://api.test/v1/public/events/evt_1/resale-listings?cursor=lst_0&limit=25',
    ]);
  });

  test('routes resale helpers through versioned API requests with required headers', () async {
    final urls = <String>[];
    final methods = <String>[];
    final headers = <Map<String, String>>[];
    const termsJson = <String, Object?>{'accepted': true, 'termsVersion': '2026-07-16', 'settlementModel': 'organizer_managed', 'refundModel': 'manual_coordinated_resolution'};
    final client = TixkitResaleClient(
      apiBaseUrl: 'https://api.test',
      apiKey: 'tk_test_123',
      httpClient: MockClient((request) async {
        urls.add(request.url.toString());
        methods.add(request.method);
        headers.add(request.headers);
        expect(request.headers['X-Tixkit-Version'], tixkitApiVersion);

        if (request.url.path.endsWith('/resale-listings') && request.method == 'GET') {
          expect(request.headers['Authorization'], 'Bearer tk_test_123');
          return http.Response(
            jsonEncode({
              'items': [
                {'id': 'lst_1', 'eventId': 'evt_1', 'ticketId': 'tkt_1', 'status': 'listed', 'priceCents': 5500, 'currency': 'USD'},
              ],
              'hasMore': false,
            }),
            200,
          );
        }
        if (request.url.path.endsWith('/resale-listings')) {
          expect(request.headers['Idempotency-Key'], 'idem_create');
          expect((jsonDecode(request.body) as Map<String, Object?>)['termsAcceptance'], termsJson);
          return http.Response(
            jsonEncode({'id': 'lst_2', 'eventId': 'evt_1', 'ticketId': 'tkt_1', 'status': 'listed', 'priceCents': 5500, 'currency': 'USD'}),
            200,
          );
        }
        if (request.url.path.endsWith('/resale-listing')) {
          expect(request.headers['X-Checkout-Session-Token'], 'client_token');
          expect(request.headers['Idempotency-Key'], 'idem_checkout');
          expect((jsonDecode(request.body) as Map<String, Object?>)['termsAcceptance'], termsJson);
          return http.Response(
            jsonEncode({'id': 'lst_3', 'eventId': 'evt_1', 'ticketId': 'tkt_1', 'status': 'listed', 'priceCents': 5500, 'currency': 'USD'}),
            200,
          );
        }
        if (request.url.path.endsWith('/delist')) {
          expect(request.headers['Idempotency-Key'], 'idem_delist');
          return http.Response(
            jsonEncode({'id': 'lst_2', 'eventId': 'evt_1', 'ticketId': 'tkt_1', 'status': 'delisted', 'priceCents': 5500, 'currency': 'USD'}),
            200,
          );
        }
        if (request.url.path.endsWith('/settlement')) {
          return http.Response(
            jsonEncode({
              'id': 'rst_1', 'listingId': 'lst_2', 'tenantId': 'ten_1', 'organizationId': 'org_1', 'brandId': 'brd_1', 'eventId': 'evt_1',
              'sellerOrderId': 'ord_seller', 'buyerOrderId': 'ord_buyer', 'sellerTicketId': 'tkt_seller', 'buyerTicketId': 'tkt_buyer',
              'currency': 'USD', 'grossCents': 5500, 'feeCents': 500, 'payableCents': 5000, 'paidCents': 0, 'reversedCents': 0,
              'recoveryCents': 0, 'state': 'pending', 'termsVersion': '2026-07-16', 'version': 1,
              'createdAt': '2026-07-16T00:00:00Z', 'updatedAt': '2026-07-16T00:00:00Z',
              'entries': [{'id': 'entry_1', 'kind': 'payable_accrued', 'amountCents': 5000, 'currency': 'USD', 'actorId': 'system', 'method': 'checkout', 'externalReferenceSha256': null, 'reason': null, 'createdAt': '2026-07-16T00:00:00Z'}],
            }),
            200,
          );
        }
        return http.Response('unexpected', 500);
      }),
    );

    final page = await client.listResaleListings('evt_1', cursor: 'lst_0', limit: 25);
    expect(page.items.single.id, 'lst_1');
    const terms = TixkitResaleTermsAcceptance(accepted: true, termsVersion: '2026-07-16', settlementModel: 'organizer_managed', refundModel: 'manual_coordinated_resolution');
    await client.createTicketResaleListing('tkt_1', priceCents: 5500, termsAcceptance: terms, idempotencyKey: 'idem_create');
    await client.createCheckoutTicketResaleListing(
      'cs_1',
      'tkt_1',
      priceCents: 5500,
      sessionToken: 'client_token',
      termsAcceptance: terms,
      idempotencyKey: 'idem_checkout',
    );
    await client.delistResaleListing('lst_2', idempotencyKey: 'idem_delist');
    final settlement = await client.getResaleSettlement('lst_2');
    expect(settlement.id, 'rst_1');
    expect(settlement.tenantId, 'ten_1');
    expect(settlement.entries.single.kind, 'payable_accrued');

    expect(methods, ['GET', 'POST', 'POST', 'POST', 'POST']);
    expect(urls.first, 'https://api.test/v1/events/evt_1/resale-listings?cursor=lst_0&limit=25');
    expect(headers.every((item) => item['Authorization'] == 'Bearer tk_test_123'), isTrue);
  });

  test('hashes QR payloads with SHA-256', () {
    const payload = 'signed-ticket-payload';
    expect(tixkitQrHashForPayload(payload), sha256.convert(utf8.encode(payload)).toString());
  });

  test('online scan sends the caller idempotency key and stable timestamp', () async {
    final client = TixkitScannerClient(
      deviceId: 'dev_1',
      deviceSecret: 'secret',
      manifestSigningKey: 'manifest',
      apiBaseUrl: 'https://api.test',
      httpClient: MockClient((request) async {
        expect(request.method, 'POST');
        expect(request.url.path, '/v1/check-ins/scan');
        expect(request.headers['Idempotency-Key'], 'scan-ticket-1');
        final body = jsonDecode(request.body) as Map<String, Object?>;
        expect(body['checkInListId'], 'cil_1');
        expect(body['qrPayload'], 'signed-ticket-payload');
        expect(body['scannedAt'], '2026-07-16T12:00:00.000Z');
        return http.Response(
          jsonEncode({
            'outcome': 'accepted',
            'ticketId': 'tkt_1',
            'message': 'Check-in successful',
          }),
          200,
        );
      }),
    );

    final result = await client.scanOnline(
      'cil_1',
      'signed-ticket-payload',
      idempotencyKey: 'scan-ticket-1',
      scannedAt: DateTime.parse('2026-07-16T12:00:00.000Z'),
    );

    expect(result.outcome, TixkitScanOutcome.accepted);
    expect(result.ticketId, 'tkt_1');
    expect(result.message, 'Check-in successful');
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

  test('verifies API-signed occurrence scoped offline manifest fixture', () {
    final unsigned = {
      'eventId': 'evt_1',
      'checkInListId': 'cil_1',
      'generatedAt': '2026-06-01T00:00:00.000Z',
      'expiresAt': '2026-06-01T00:01:00.000Z',
      'keyId': 'manifest:test',
      'tickets': [
        {
          'ticketId': 'tkt_b',
          'ticketTypeId': 'tt_vip',
          'eventOccurrenceId': 'occ_1',
          'attendeeName': 'Grace Hopper',
          'qrHash': 'hash_b',
          'status': 'valid',
        },
        {
          'ticketId': 'tkt_a',
          'ticketTypeId': 'tt_ga',
          'attendeeName': '',
          'qrHash': 'hash_a',
          'status': 'issued',
        },
      ],
    };
    final manifest = TixkitOfflineManifest.fromJson({
      ...unsigned,
      'signature': 'd8fdb5795ec9219c5cb880dd2bee328cb6298e976098008cfe730e7a2b71be48',
    });
    final client = TixkitScannerClient(
      deviceId: 'sd_public_1',
      deviceSecret: 'scanner-secret',
      manifestSigningKey: 'manifest-secret',
      storage: TixkitMemoryScannerStorage(),
    );

    expect(manifest.tickets.first.eventOccurrenceId, 'occ_1');
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
