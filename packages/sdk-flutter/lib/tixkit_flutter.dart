library tixkit_flutter;

import 'dart:async';
import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:flutter/widgets.dart';
import 'package:http/http.dart' as http;

const String tixkitApiVersion = '2026-07-18';

enum TixkitScanOutcome {
  accepted,
  duplicate,
  invalid,
  revoked,
  notFound,
  wrongEvent,
  wrongList,
}

enum TixkitScannerMode { online, offline, auto }

String _outcomeToWire(TixkitScanOutcome outcome) {
  return switch (outcome) {
    TixkitScanOutcome.accepted => 'accepted',
    TixkitScanOutcome.duplicate => 'duplicate',
    TixkitScanOutcome.invalid => 'invalid',
    TixkitScanOutcome.revoked => 'revoked',
    TixkitScanOutcome.notFound => 'not_found',
    TixkitScanOutcome.wrongEvent => 'wrong_event',
    TixkitScanOutcome.wrongList => 'wrong_list',
  };
}

TixkitScanOutcome _outcomeFromWire(String outcome) {
  return switch (outcome) {
    'accepted' => TixkitScanOutcome.accepted,
    'duplicate' => TixkitScanOutcome.duplicate,
    'revoked' => TixkitScanOutcome.revoked,
    'not_found' => TixkitScanOutcome.notFound,
    'wrong_event' => TixkitScanOutcome.wrongEvent,
    'wrong_list' => TixkitScanOutcome.wrongList,
    _ => TixkitScanOutcome.invalid,
  };
}

String tixkitQrHashForPayload(String qrPayload) {
  return sha256.convert(utf8.encode(qrPayload)).toString();
}

class TixkitScanResult {
  const TixkitScanResult({
    required this.outcome,
    required this.message,
    this.ticketId,
  });

  factory TixkitScanResult.fromJson(Map<String, Object?> json) {
    return TixkitScanResult(
      outcome: _outcomeFromWire(json['outcome'] as String? ?? 'invalid'),
      message: json['message'] as String? ?? '',
      ticketId: json['ticketId'] as String?,
    );
  }

  final TixkitScanOutcome outcome;
  final String message;
  final String? ticketId;

  Map<String, Object?> toJson() {
    return {
      'outcome': _outcomeToWire(outcome),
      'message': message,
      if (ticketId != null) 'ticketId': ticketId,
    };
  }
}

class TixkitOfflineTicket {
  const TixkitOfflineTicket({
    required this.ticketId,
    required this.ticketTypeId,
    this.eventOccurrenceId,
    required this.attendeeName,
    required this.qrHash,
    required this.status,
  });

  factory TixkitOfflineTicket.fromJson(Map<String, Object?> json) {
    return TixkitOfflineTicket(
      ticketId: json['ticketId'] as String,
      ticketTypeId: json['ticketTypeId'] as String,
      eventOccurrenceId: json['eventOccurrenceId'] as String?,
      attendeeName: json['attendeeName'] as String? ?? '',
      qrHash: json['qrHash'] as String,
      status: json['status'] as String,
    );
  }

  final String ticketId;
  final String ticketTypeId;
  final String? eventOccurrenceId;
  final String attendeeName;
  final String qrHash;
  final String status;

  Map<String, Object?> toJson() {
    return {
      'ticketId': ticketId,
      'ticketTypeId': ticketTypeId,
      if (eventOccurrenceId != null) 'eventOccurrenceId': eventOccurrenceId,
      'attendeeName': attendeeName,
      'qrHash': qrHash,
      'status': status,
    };
  }
}

class TixkitOfflineManifest {
  const TixkitOfflineManifest({
    required this.eventId,
    required this.checkInListId,
    required this.generatedAt,
    required this.expiresAt,
    required this.keyId,
    required this.signature,
    required this.tickets,
  });

  factory TixkitOfflineManifest.fromJson(Map<String, Object?> json) {
    final rawTickets = json['tickets'];
    return TixkitOfflineManifest(
      eventId: json['eventId'] as String,
      checkInListId: json['checkInListId'] as String,
      generatedAt: DateTime.parse(json['generatedAt'] as String),
      expiresAt: DateTime.parse(json['expiresAt'] as String),
      keyId: json['keyId'] as String,
      signature: json['signature'] as String,
      tickets: rawTickets is List
          ? rawTickets
              .whereType<Map<String, Object?>>()
              .map(TixkitOfflineTicket.fromJson)
              .toList(growable: false)
          : const [],
    );
  }

  final String eventId;
  final String checkInListId;
  final DateTime generatedAt;
  final DateTime expiresAt;
  final String keyId;
  final String signature;
  final List<TixkitOfflineTicket> tickets;

  Map<String, Object?> toUnsignedJson() {
    return {
      'eventId': eventId,
      'checkInListId': checkInListId,
      'generatedAt': generatedAt.toUtc().toIso8601String(),
      'expiresAt': expiresAt.toUtc().toIso8601String(),
      'keyId': keyId,
      'tickets': tickets.map((ticket) => ticket.toJson()).toList(growable: false),
    };
  }

  Map<String, Object?> toJson() {
    return {
      ...toUnsignedJson(),
      'signature': signature,
    };
  }
}

class TixkitSyncResult {
  const TixkitSyncResult({
    required this.accepted,
    required this.duplicates,
    required this.invalid,
    required this.results,
  });

  factory TixkitSyncResult.fromJson(Map<String, Object?> json) {
    final rawResults = json['results'];
    return TixkitSyncResult(
      accepted: json['accepted'] as int? ?? 0,
      duplicates: json['duplicates'] as int? ?? 0,
      invalid: json['invalid'] as int? ?? 0,
      results: rawResults is List
          ? rawResults
              .whereType<Map<String, Object?>>()
              .map((item) => {
                    'qrHash': item['qrHash'] as String? ?? '',
                    'outcome': item['outcome'] as String? ?? 'invalid',
                  })
              .toList(growable: false)
          : const [],
    );
  }

  final int accepted;
  final int duplicates;
  final int invalid;
  final List<Map<String, String>> results;
}

abstract class TixkitScannerStorage {
  Future<String?> getItem(String key);
  Future<void> setItem(String key, String value);
  Future<void> removeItem(String key);
}

class TixkitMemoryScannerStorage implements TixkitScannerStorage {
  final Map<String, String> _values = <String, String>{};

  @override
  Future<String?> getItem(String key) async => _values[key];

  @override
  Future<void> setItem(String key, String value) async {
    _values[key] = value;
  }

  @override
  Future<void> removeItem(String key) async {
    _values.remove(key);
  }
}

class TixkitCheckoutHandoffItem {
  const TixkitCheckoutHandoffItem({
    this.ticketTypeId,
    this.productId,
    this.resaleListingId,
    required this.quantity,
  });

  final String? ticketTypeId;
  final String? productId;
  final String? resaleListingId;
  final int quantity;
}

class TixkitCheckoutHandoffOptions {
  const TixkitCheckoutHandoffOptions({
    required this.eventId,
    this.checkoutBaseUrl = 'https://checkout.tixkit.com',
    this.brandId,
    this.items = const [],
    this.products = const [],
    this.discountCode,
    this.accessCode,
    this.trackingId,
    this.affiliateCode,
    this.locale,
    this.theme,
    this.mode,
    this.successUrl,
    this.cancelUrl,
  });

  final String eventId;
  final String checkoutBaseUrl;
  final String? brandId;
  final List<TixkitCheckoutHandoffItem> items;
  final List<String> products;
  final String? discountCode;
  final String? accessCode;
  final String? trackingId;
  final String? affiliateCode;
  final String? locale;
  final String? theme;
  final String? mode;
  final String? successUrl;
  final String? cancelUrl;
}

Uri tixkitCheckoutHandoffUri(TixkitCheckoutHandoffOptions options) {
  final uri = Uri.parse(options.checkoutBaseUrl).replace(path: '/checkout');
  final query = <String, String>{'eventId': options.eventId};
  if (options.brandId != null) query['brand'] = options.brandId!;
  String? resaleListingId;
  for (final item in options.items) {
    final id = item.resaleListingId;
    if (id != null && id.isNotEmpty) {
      resaleListingId = id;
      break;
    }
  }
  if (resaleListingId != null) query['resaleListing'] = resaleListingId;
  final items = options.items
      .map((item) {
        if (item.resaleListingId != null) return null;
        final id = item.ticketTypeId ?? item.productId;
        if (id == null || item.quantity <= 0) return null;
        return '$id=${item.quantity}';
      })
      .whereType<String>()
      .join(',');
  if (items.isNotEmpty) query['items'] = items;
  if (options.products.isNotEmpty) query['products'] = options.products.join(',');
  if (options.discountCode != null) query['discount'] = options.discountCode!;
  if (options.accessCode != null) query['accessCode'] = options.accessCode!;
  if (options.trackingId != null) query['tracking'] = options.trackingId!;
  if (options.affiliateCode != null) query['affiliate'] = options.affiliateCode!;
  if (options.locale != null) query['locale'] = options.locale!;
  if (options.theme != null) query['theme'] = options.theme!;
  if (options.mode != null) query['mode'] = options.mode!;
  if (options.successUrl != null) query['successUrl'] = options.successUrl!;
  if (options.cancelUrl != null) query['cancelUrl'] = options.cancelUrl!;
  return uri.replace(queryParameters: query);
}

class TixkitPublicContentPage {
  const TixkitPublicContentPage({
    required this.document,
    required this.version,
    required this.page,
  });

  factory TixkitPublicContentPage.fromJson(Map<String, Object?> json) {
    return TixkitPublicContentPage(
      document: TixkitPublicContentDocument.fromJson(
        json['document'] as Map<String, Object?>? ?? const {},
      ),
      version: TixkitPublicContentVersion.fromJson(
        json['version'] as Map<String, Object?>? ?? const {},
      ),
      page: TixkitPublicEventPage.fromJson(
        json['page'] as Map<String, Object?>? ?? const {},
      ),
    );
  }

  final TixkitPublicContentDocument document;
  final TixkitPublicContentVersion version;
  final TixkitPublicEventPage page;
}

class TixkitPublicContentDocument {
  const TixkitPublicContentDocument({
    required this.eventId,
    required this.channel,
    required this.key,
    required this.name,
    required this.locale,
    required this.updatedAt,
  });

  factory TixkitPublicContentDocument.fromJson(Map<String, Object?> json) {
    return TixkitPublicContentDocument(
      eventId: json['eventId'] as String? ?? '',
      channel: json['channel'] as String? ?? '',
      key: json['key'] as String? ?? '',
      name: json['name'] as String? ?? '',
      locale: json['locale'] as String? ?? '',
      updatedAt: json['updatedAt'] as String? ?? '',
    );
  }

  final String eventId;
  final String channel;
  final String key;
  final String name;
  final String locale;
  final String updatedAt;
}

class TixkitPublicContentVersion {
  const TixkitPublicContentVersion({
    required this.versionNumber,
    this.subject,
    this.previewText,
    this.publishedAt,
  });

  factory TixkitPublicContentVersion.fromJson(Map<String, Object?> json) {
    return TixkitPublicContentVersion(
      versionNumber: json['versionNumber'] as int? ?? 0,
      subject: json['subject'] as String?,
      previewText: json['previewText'] as String?,
      publishedAt: json['publishedAt'] as String?,
    );
  }

  final int versionNumber;
  final String? subject;
  final String? previewText;
  final String? publishedAt;
}

class TixkitPublicEventPage {
  const TixkitPublicEventPage({
    required this.provider,
    required this.puckData,
    required this.discovery,
    this.settings = const {},
  });

  factory TixkitPublicEventPage.fromJson(Map<String, Object?> json) {
    return TixkitPublicEventPage(
      provider: json['provider'] as String? ?? '',
      puckData: TixkitPuckData.fromJson(json['puckData'] as Map<String, Object?>? ?? const {}),
      settings: _objectMap(json['settings']),
      discovery: TixkitPublicEventDiscoveryCard.fromJson(
        json['discovery'] as Map<String, Object?>? ?? const {},
      ),
    );
  }

  final String provider;
  final TixkitPuckData puckData;
  final Map<String, Object?> settings;
  final TixkitPublicEventDiscoveryCard discovery;
}

class TixkitEventPageDocumentV2 {
  const TixkitEventPageDocumentV2({
    required this.schemaVersion,
    required this.editor,
    this.settings = const {},
  });

  factory TixkitEventPageDocumentV2.fromJson(Map<String, Object?> json) {
    return TixkitEventPageDocumentV2(
      schemaVersion: json['schemaVersion'] as int? ?? 0,
      editor: TixkitEventPageDocumentEditor.fromJson(
        json['editor'] as Map<String, Object?>? ?? const {},
      ),
      settings: _objectMap(json['settings']),
    );
  }

  final int schemaVersion;
  final TixkitEventPageDocumentEditor editor;
  final Map<String, Object?> settings;
}

class TixkitEventPageDocumentEditor {
  const TixkitEventPageDocumentEditor({
    required this.provider,
    required this.data,
  });

  factory TixkitEventPageDocumentEditor.fromJson(Map<String, Object?> json) {
    return TixkitEventPageDocumentEditor(
      provider: json['provider'] as String? ?? '',
      data: TixkitPuckData.fromJson(json['data'] as Map<String, Object?>? ?? const {}),
    );
  }

  final String provider;
  final TixkitPuckData data;
}

class TixkitPuckData {
  const TixkitPuckData({
    required this.content,
    required this.root,
    this.zones = const {},
  });

  factory TixkitPuckData.fromJson(Map<String, Object?> json) {
    return TixkitPuckData(
      content: _puckComponentList(json['content']),
      root: TixkitPuckRootData.fromJson(json['root'] as Map<String, Object?>? ?? const {}),
      zones: _puckZones(json['zones']),
    );
  }

  final List<TixkitPuckComponentData> content;
  final TixkitPuckRootData root;
  final Map<String, List<TixkitPuckComponentData>> zones;
}

class TixkitPuckRootData {
  const TixkitPuckRootData({this.props = const {}});

  factory TixkitPuckRootData.fromJson(Map<String, Object?> json) {
    return TixkitPuckRootData(props: _objectMap(json['props']));
  }

  final Map<String, Object?> props;
}

class TixkitPuckComponentData {
  const TixkitPuckComponentData({
    required this.type,
    this.props = const {},
  });

  factory TixkitPuckComponentData.fromJson(Map<String, Object?> json) {
    return TixkitPuckComponentData(
      type: json['type'] as String? ?? '',
      props: _objectMap(json['props']),
    );
  }

  final String type;
  final Map<String, Object?> props;
}

Map<String, Object?> _objectMap(Object? value) {
  if (value is Map<String, Object?>) return value;
  if (value is Map) return value.map((key, entry) => MapEntry(key.toString(), entry));
  return const {};
}

List<TixkitPuckComponentData> _puckComponentList(Object? value) {
  if (value is! List) return const [];
  return value
      .whereType<Map<String, Object?>>()
      .map(TixkitPuckComponentData.fromJson)
      .toList(growable: false);
}

Map<String, List<TixkitPuckComponentData>> _puckZones(Object? value) {
  final map = _objectMap(value);
  if (map.isEmpty) return const {};
  return map.map((key, entry) => MapEntry(key, _puckComponentList(entry)));
}

class TixkitPublicEventDiscoveryCard {
  const TixkitPublicEventDiscoveryCard({
    required this.title,
    required this.summary,
    required this.tags,
    this.category,
    this.imageUrl,
    this.startsAt,
    this.venueName,
    this.publicPath,
  });

  factory TixkitPublicEventDiscoveryCard.fromJson(Map<String, Object?> json) {
    final rawTags = json['tags'];
    return TixkitPublicEventDiscoveryCard(
      title: json['title'] as String? ?? '',
      summary: json['summary'] as String? ?? '',
      tags: rawTags is List ? rawTags.whereType<String>().toList(growable: false) : const [],
      category: json['category'] as String?,
      imageUrl: json['imageUrl'] as String?,
      startsAt: json['startsAt'] as String?,
      venueName: json['venueName'] as String?,
      publicPath: json['publicPath'] as String?,
    );
  }

  final String title;
  final String summary;
  final List<String> tags;
  final String? category;
  final String? imageUrl;
  final String? startsAt;
  final String? venueName;
  final String? publicPath;
}

class TixkitTicketListingPage {
  const TixkitTicketListingPage({
    required this.items,
    required this.hasMore,
    this.nextCursor,
  });

  factory TixkitTicketListingPage.fromJson(Map<String, Object?> json) {
    final rawItems = json['items'];
    return TixkitTicketListingPage(
      items: rawItems is List
          ? rawItems
              .whereType<Map<String, Object?>>()
              .map(TixkitTicketListing.fromJson)
              .toList(growable: false)
          : const [],
      hasMore: json['hasMore'] as bool? ?? false,
      nextCursor: json['nextCursor'] as String?,
    );
  }

  final List<TixkitTicketListing> items;
  final bool hasMore;
  final String? nextCursor;
}

class TixkitPublicTicketListingPage {
  const TixkitPublicTicketListingPage({
    required this.items,
    this.hasMore = false,
    this.nextCursor,
  });

  factory TixkitPublicTicketListingPage.fromJson(Map<String, Object?> json) {
    final rawItems = json['items'] as List<Object?>? ?? const [];
    return TixkitPublicTicketListingPage(
      items: rawItems
          .whereType<Map<String, Object?>>()
          .map(TixkitPublicTicketListing.fromJson)
          .toList(growable: false),
      hasMore: json['hasMore'] as bool? ?? false,
      nextCursor: json['nextCursor'] as String?,
    );
  }

  final List<TixkitPublicTicketListing> items;
  final bool hasMore;
  final String? nextCursor;
}

class TixkitPublicTicketListing {
  const TixkitPublicTicketListing({
    required this.id,
    required this.eventId,
    required this.status,
    required this.priceCents,
    required this.currency,
    required this.faceValueCents,
    this.ticketTypeId,
    this.ticketTypeName,
    this.expiresAt,
    this.createdAt,
    this.updatedAt,
  });

  factory TixkitPublicTicketListing.fromJson(Map<String, Object?> json) {
    return TixkitPublicTicketListing(
      id: json['id'] as String? ?? '',
      eventId: json['eventId'] as String? ?? '',
      ticketTypeId: json['ticketTypeId'] as String?,
      ticketTypeName: json['ticketTypeName'] as String?,
      status: json['status'] as String? ?? '',
      priceCents: json['priceCents'] as int? ?? 0,
      currency: json['currency'] as String? ?? '',
      faceValueCents: json['faceValueCents'] as int? ?? 0,
      expiresAt: json['expiresAt'] as String?,
      createdAt: json['createdAt'] as String?,
      updatedAt: json['updatedAt'] as String?,
    );
  }

  final String id;
  final String eventId;
  final String? ticketTypeId;
  final String? ticketTypeName;
  final String status;
  final int priceCents;
  final String currency;
  final int faceValueCents;
  final String? expiresAt;
  final String? createdAt;
  final String? updatedAt;
}

class TixkitTicketListing {
  const TixkitTicketListing({
    required this.id,
    required this.eventId,
    required this.ticketId,
    required this.status,
    required this.priceCents,
    required this.currency,
    this.sellerId,
    this.faceValueCents,
    this.soldToId,
  });

  factory TixkitTicketListing.fromJson(Map<String, Object?> json) {
    return TixkitTicketListing(
      id: json['id'] as String? ?? '',
      eventId: json['eventId'] as String? ?? '',
      ticketId: json['ticketId'] as String? ?? '',
      sellerId: json['sellerId'] as String?,
      status: json['status'] as String? ?? '',
      priceCents: json['priceCents'] as int? ?? 0,
      currency: json['currency'] as String? ?? '',
      faceValueCents: json['faceValueCents'] as int?,
      soldToId: json['soldToId'] as String?,
    );
  }

  final String id;
  final String eventId;
  final String ticketId;
  final String? sellerId;
  final String status;
  final int priceCents;
  final String currency;
  final int? faceValueCents;
  final String? soldToId;
}

class TixkitResaleCompletion {
  const TixkitResaleCompletion({
    required this.listing,
    this.buyerTicketId,
    this.buyerAttendeeId,
  });

  factory TixkitResaleCompletion.fromJson(Map<String, Object?> json) {
    final rawBuyerTicket = json['buyerTicket'];
    final rawBuyerAttendee = json['buyerAttendee'];
    return TixkitResaleCompletion(
      listing: TixkitTicketListing.fromJson(json['listing'] as Map<String, Object?>? ?? const {}),
      buyerTicketId:
          rawBuyerTicket is Map<String, Object?> ? rawBuyerTicket['id'] as String? : null,
      buyerAttendeeId:
          rawBuyerAttendee is Map<String, Object?> ? rawBuyerAttendee['id'] as String? : null,
    );
  }

  final TixkitTicketListing listing;
  final String? buyerTicketId;
  final String? buyerAttendeeId;
}

class TixkitPublicEventPageClient {
  TixkitPublicEventPageClient({
    this.apiBaseUrl = 'https://api.tixkit.com',
    http.Client? httpClient,
  }) : httpClient = httpClient ?? http.Client();

  final String apiBaseUrl;
  final http.Client httpClient;

  Future<TixkitPublicContentPage> getEventPage(String eventId, {String? locale}) {
    return _getPage('/public/events/$eventId/page', locale: locale);
  }

  Future<TixkitPublicContentPage> getContentPage(String eventId, {String? locale}) {
    return _getPage('/public/events/$eventId/content-page', locale: locale);
  }

  Future<TixkitPublicContentPage> getEventPageBySlug(
    String slug, {
    required String host,
    String? locale,
  }) {
    return _getPage('/public/events/by-slug/$slug/page', host: host, locale: locale);
  }

  Future<TixkitPublicEventDiscoveryCard> getEventDiscoveryCard(String eventId, {String? locale}) async {
    final response = await httpClient.get(_apiUri('/public/events/$eventId/discovery-card', locale: locale));
    _assertSuccess(response);
    return TixkitPublicEventDiscoveryCard.fromJson(jsonDecode(response.body) as Map<String, Object?>);
  }

  Future<TixkitPublicTicketListingPage> listResaleListings(
    String eventId, {
    String? cursor,
    int? limit,
  }) async {
    final response = await httpClient.get(
      _apiUri('/public/events/$eventId/resale-listings', cursor: cursor, limit: limit),
    );
    _assertSuccess(response);
    return TixkitPublicTicketListingPage.fromJson(jsonDecode(response.body) as Map<String, Object?>);
  }

  Future<TixkitPublicContentPage> _getPage(String path, {String? host, String? locale}) async {
    final response = await httpClient.get(_apiUri(path, host: host, locale: locale));
    _assertSuccess(response);
    return TixkitPublicContentPage.fromJson(jsonDecode(response.body) as Map<String, Object?>);
  }

  Uri _apiUri(String path, {String? host, String? locale, String? cursor, int? limit}) {
    final query = <String, String>{};
    if (host != null) query['host'] = host;
    if (locale != null) query['locale'] = locale;
    if (cursor != null) query['cursor'] = cursor;
    if (limit != null) query['limit'] = '$limit';
    final base = Uri.parse(apiBaseUrl);
    return base.replace(path: '/v1$path', queryParameters: query.isEmpty ? null : query);
  }

  void _assertSuccess(http.Response response) {
    if (response.statusCode >= 200 && response.statusCode < 300) return;
    throw StateError('Tixkit API request failed with HTTP ${response.statusCode}');
  }
}

class TixkitResaleClient {
  TixkitResaleClient({
    this.apiBaseUrl = 'https://api.tixkit.com',
    this.apiKey,
    http.Client? httpClient,
  }) : httpClient = httpClient ?? http.Client();

  final String apiBaseUrl;
  final String? apiKey;
  final http.Client httpClient;

  Future<TixkitTicketListingPage> listResaleListings(
    String eventId, {
    String? cursor,
    int? limit,
  }) async {
    final response = await httpClient.get(
      _apiUri('/events/$eventId/resale-listings', cursor: cursor, limit: limit),
      headers: _headers(),
    );
    _assertSuccess(response);
    return TixkitTicketListingPage.fromJson(jsonDecode(response.body) as Map<String, Object?>);
  }

  Future<TixkitTicketListing> createTicketResaleListing(
    String ticketId, {
    required int priceCents,
    required String idempotencyKey,
    String? expiresAt,
  }) async {
    return _postListing(
      '/tickets/$ticketId/resale-listings',
      idempotencyKey: idempotencyKey,
      body: {
        'priceCents': priceCents,
        if (expiresAt != null) 'expiresAt': expiresAt,
      },
    );
  }

  Future<TixkitTicketListing> createCheckoutTicketResaleListing(
    String sessionId,
    String ticketId, {
    required int priceCents,
    required String sessionToken,
    required String idempotencyKey,
    String? expiresAt,
  }) async {
    return _postListing(
      '/checkout/sessions/$sessionId/tickets/$ticketId/resale-listing',
      idempotencyKey: idempotencyKey,
      sessionToken: sessionToken,
      body: {
        'priceCents': priceCents,
        if (expiresAt != null) 'expiresAt': expiresAt,
      },
    );
  }

  Future<TixkitTicketListing> delistResaleListing(
    String listingId, {
    required String idempotencyKey,
  }) {
    return _postListing(
      '/ticket-listings/$listingId/delist',
      idempotencyKey: idempotencyKey,
      body: const {},
    );
  }

  Future<TixkitResaleCompletion> completeResaleListing(
    String listingId, {
    required String buyerId,
    required String buyerEmail,
    required String idempotencyKey,
    String? buyerFirstName,
    String? buyerLastName,
    String? externalPaymentReference,
  }) async {
    final response = await httpClient.post(
      _apiUri('/ticket-listings/$listingId/complete'),
      headers: _headers(idempotencyKey: idempotencyKey),
      body: jsonEncode({
        'buyerId': buyerId,
        'buyerEmail': buyerEmail,
        if (buyerFirstName != null) 'buyerFirstName': buyerFirstName,
        if (buyerLastName != null) 'buyerLastName': buyerLastName,
        if (externalPaymentReference != null)
          'externalPaymentReference': externalPaymentReference,
      }),
    );
    _assertSuccess(response);
    return TixkitResaleCompletion.fromJson(jsonDecode(response.body) as Map<String, Object?>);
  }

  Future<TixkitTicketListing> _postListing(
    String path, {
    required String idempotencyKey,
    required Map<String, Object?> body,
    String? sessionToken,
  }) async {
    final response = await httpClient.post(
      _apiUri(path),
      headers: _headers(idempotencyKey: idempotencyKey, sessionToken: sessionToken),
      body: jsonEncode(body),
    );
    _assertSuccess(response);
    return TixkitTicketListing.fromJson(jsonDecode(response.body) as Map<String, Object?>);
  }

  Uri _apiUri(String path, {String? cursor, int? limit}) {
    final query = <String, String>{};
    if (cursor != null) query['cursor'] = cursor;
    if (limit != null) query['limit'] = '$limit';
    final base = Uri.parse(apiBaseUrl);
    return base.replace(path: '/v1$path', queryParameters: query.isEmpty ? null : query);
  }

  Map<String, String> _headers({String? idempotencyKey, String? sessionToken}) {
    return {
      'X-Tixkit-Version': tixkitApiVersion,
      if (apiKey != null) 'Authorization': 'Bearer $apiKey',
      if (idempotencyKey != null) 'Idempotency-Key': idempotencyKey,
      if (sessionToken != null) 'X-Checkout-Session-Token': sessionToken,
      if (idempotencyKey != null || sessionToken != null) 'Content-Type': 'application/json',
    };
  }

  void _assertSuccess(http.Response response) {
    if (response.statusCode >= 200 && response.statusCode < 300) return;
    throw StateError('Tixkit API request failed with HTTP ${response.statusCode}');
  }
}

typedef TixkitSyncConflictCallback = void Function(String qrHash, String outcome);

class TixkitScannerClient {
  TixkitScannerClient({
    required this.deviceId,
    required this.deviceSecret,
    required this.manifestSigningKey,
    this.apiBaseUrl = 'https://api.tixkit.com',
    this.storage,
    this.storageKey,
    this.onSyncConflict,
    http.Client? httpClient,
  }) : httpClient = httpClient ?? http.Client();

  final String deviceId;
  final String deviceSecret;
  final String manifestSigningKey;
  final String apiBaseUrl;
  final TixkitScannerStorage? storage;
  final String? storageKey;
  final TixkitSyncConflictCallback? onSyncConflict;
  final http.Client httpClient;

  TixkitOfflineManifest? _manifest;
  final Map<String, DateTime> _offlineScans = <String, DateTime>{};

  String get _resolvedStorageKey => storageKey ?? 'tixkit:scanner:$deviceId:offline-scans';

  Map<String, String> get _authHeaders {
    return {
      'Content-Type': 'application/json',
      'X-Device-Id': deviceId,
      'X-Device-Secret': deviceSecret,
    };
  }

  Future<TixkitOfflineManifest> downloadManifest(String eventId, String checkInListId) async {
    final response = await httpClient.get(
      _apiUri('/events/$eventId/check-in-lists/$checkInListId/manifest'),
      headers: _authHeaders,
    );
    _assertSuccess(response);
    final manifest = TixkitOfflineManifest.fromJson(jsonDecode(response.body) as Map<String, Object?>);
    if (!verifyManifestSignature(manifest)) {
      throw StateError('Offline manifest signature verification failed');
    }
    _manifest = manifest;
    _offlineScans.clear();
    await _persistOfflineScans();
    return manifest;
  }

  bool verifyManifestSignature(TixkitOfflineManifest manifest) {
    final hmac = Hmac(sha256, utf8.encode(manifestSigningKey));
    final expected = hmac.convert(utf8.encode(jsonEncode(manifest.toUnsignedJson()))).toString();
    return expected == manifest.signature;
  }

  Future<TixkitScanResult> scanOnline(String checkInListId, String qrPayload) async {
    final response = await httpClient.post(
      _apiUri('/check-ins/scan'),
      headers: _authHeaders,
      body: jsonEncode({
        'checkInListId': checkInListId,
        'qrPayload': qrPayload,
        'scannedAt': DateTime.now().toUtc().toIso8601String(),
        'offline': false,
      }),
    );
    _assertSuccess(response);
    return TixkitScanResult.fromJson(jsonDecode(response.body) as Map<String, Object?>);
  }

  TixkitScanResult scanOffline(String qrPayload, {bool hashed = false}) {
    final manifest = _manifest;
    if (manifest == null) {
      return const TixkitScanResult(outcome: TixkitScanOutcome.invalid, message: 'No manifest downloaded');
    }
    if (manifest.expiresAt.isBefore(DateTime.now().toUtc())) {
      return const TixkitScanResult(outcome: TixkitScanOutcome.invalid, message: 'Manifest expired');
    }

    final qrHash = hashed ? qrPayload : tixkitQrHashForPayload(qrPayload);
    TixkitOfflineTicket? ticket;
    for (final item in manifest.tickets) {
      if (item.qrHash == qrHash) {
        ticket = item;
        break;
      }
    }
    if (ticket == null) {
      return const TixkitScanResult(outcome: TixkitScanOutcome.notFound, message: 'Ticket not in manifest');
    }
    if (ticket.status == 'void' || ticket.status == 'refunded' || ticket.status == 'transferred') {
      return const TixkitScanResult(
        outcome: TixkitScanOutcome.revoked,
        message: 'Ticket is voided, refunded, or transferred',
      );
    }
    if (_offlineScans.containsKey(qrHash)) {
      return TixkitScanResult(
        outcome: TixkitScanOutcome.duplicate,
        message: 'Ticket already checked in',
        ticketId: ticket.ticketId,
      );
    }

    _offlineScans[qrHash] = DateTime.now().toUtc();
    unawaited(_persistOfflineScans());
    return TixkitScanResult(
      outcome: TixkitScanOutcome.accepted,
      message: 'Check-in successful (offline)',
      ticketId: ticket.ticketId,
    );
  }

  Future<TixkitSyncResult> syncScans({String? checkInListId}) async {
    final listId = checkInListId ?? _manifest?.checkInListId;
    if (listId == null || listId.isEmpty) {
      throw ArgumentError('checkInListId is required to sync offline scans');
    }
    if (_offlineScans.isEmpty) {
      return const TixkitSyncResult(accepted: 0, duplicates: 0, invalid: 0, results: []);
    }

    final scans = _offlineScans.entries
        .map((entry) => {
              'qrHash': entry.key,
              'scannedAt': entry.value.toUtc().toIso8601String(),
              'offline': true,
            })
        .toList(growable: false);
    final response = await httpClient.post(
      _apiUri('/check-ins/sync'),
      headers: {
        ..._authHeaders,
        'Idempotency-Key': _syncIdempotencyKey(listId),
      },
      body: jsonEncode({'checkInListId': listId, 'scans': scans}),
    );
    _assertSuccess(response);
    final result = TixkitSyncResult.fromJson(jsonDecode(response.body) as Map<String, Object?>);
    for (final item in result.results) {
      final outcome = item['outcome'] ?? 'invalid';
      final qrHash = item['qrHash'] ?? '';
      if (outcome != 'accepted') onSyncConflict?.call(qrHash, outcome);
      if (outcome == 'accepted') _offlineScans.remove(qrHash);
    }
    await _persistOfflineScans();
    return result;
  }

  Future<void> restoreOfflineScans() async {
    final raw = await storage?.getItem(_resolvedStorageKey);
    if (raw == null || raw.isEmpty) return;
    final parsed = jsonDecode(raw);
    if (parsed is! List) return;
    _offlineScans
      ..clear()
      ..addEntries(
        parsed.whereType<List>().where((entry) => entry.length == 2).map(
              (entry) => MapEntry(
                entry[0] as String,
                DateTime.parse(entry[1] as String),
              ),
            ),
      );
  }

  Future<void> clearOfflineScans() async {
    _offlineScans.clear();
    await storage?.removeItem(_resolvedStorageKey);
  }

  Uri checkoutUri(TixkitCheckoutHandoffOptions options) => tixkitCheckoutHandoffUri(options);

  Uri _apiUri(String path) {
    final base = Uri.parse(apiBaseUrl);
    return base.replace(path: '/v1$path');
  }

  String _syncIdempotencyKey(String checkInListId) {
    final timestamps = _offlineScans.values.map((item) => item.toUtc().toIso8601String()).toList()..sort();
    return [
      'scanner-sync',
      deviceId,
      checkInListId,
      _offlineScans.length.toString(),
      timestamps.isEmpty ? 'none' : timestamps.first,
      timestamps.isEmpty ? 'none' : timestamps.last,
    ].join(':');
  }

  Future<void> _persistOfflineScans() async {
    if (storage == null) return;
    if (_offlineScans.isEmpty) {
      await storage!.removeItem(_resolvedStorageKey);
      return;
    }
    await storage!.setItem(
      _resolvedStorageKey,
      jsonEncode(_offlineScans.entries
          .map((entry) => [entry.key, entry.value.toUtc().toIso8601String()])
          .toList(growable: false)),
    );
  }

  void _assertSuccess(http.Response response) {
    if (response.statusCode >= 200 && response.statusCode < 300) return;
    throw StateError('Tixkit API request failed with HTTP ${response.statusCode}');
  }
}

typedef TixkitCameraBuilder = Widget Function(BuildContext context, ValueChanged<String> onPayload);

class TixkitCameraScanner extends StatefulWidget {
  const TixkitCameraScanner({
    super.key,
    required this.client,
    required this.checkInListId,
    required this.cameraBuilder,
    this.mode = TixkitScannerMode.online,
    this.disabled = false,
    this.throttle = const Duration(milliseconds: 1500),
    this.onResult,
    this.onError,
    this.onSync,
  });

  final TixkitScannerClient client;
  final String checkInListId;
  final TixkitCameraBuilder cameraBuilder;
  final TixkitScannerMode mode;
  final bool disabled;
  final Duration throttle;
  final ValueChanged<TixkitScanResult>? onResult;
  final ValueChanged<Object>? onError;
  final Future<TixkitSyncResult> Function()? onSync;

  @override
  State<TixkitCameraScanner> createState() => _TixkitCameraScannerState();
}

class _TixkitCameraScannerState extends State<TixkitCameraScanner> {
  String? _lastPayload;
  DateTime? _lastScanAt;
  bool _inFlight = false;

  Future<void> _handlePayload(String payload) async {
    if (widget.disabled || _inFlight || payload.trim().isEmpty) return;
    final now = DateTime.now().toUtc();
    if (_lastPayload == payload && _lastScanAt != null && now.difference(_lastScanAt!) < widget.throttle) {
      return;
    }
    _lastPayload = payload;
    _lastScanAt = now;
    setState(() {
      _inFlight = true;
    });
    try {
      final result = await _scan(payload);
      widget.onResult?.call(result);
    } catch (error) {
      widget.onError?.call(error);
    } finally {
      if (mounted) {
        setState(() {
          _inFlight = false;
        });
      }
    }
  }

  Future<TixkitScanResult> _scan(String payload) async {
    if (widget.mode == TixkitScannerMode.offline) {
      return widget.client.scanOffline(payload);
    }
    try {
      return await widget.client.scanOnline(widget.checkInListId, payload);
    } catch (error) {
      if (widget.mode != TixkitScannerMode.auto) rethrow;
      return widget.client.scanOffline(payload);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Stack(
      children: [
        widget.cameraBuilder(context, _handlePayload),
        if (_inFlight) const Positioned.fill(child: Center(child: TixkitScannerBusyIndicator())),
      ],
    );
  }
}

class TixkitScannerBusyIndicator extends StatelessWidget {
  const TixkitScannerBusyIndicator({super.key});

  @override
  Widget build(BuildContext context) {
    return const DecoratedBox(
      decoration: BoxDecoration(color: Color(0x33000000)),
      child: Center(child: Text('Checking ticket')),
    );
  }
}

class TixkitTicketCard extends StatelessWidget {
  const TixkitTicketCard({
    super.key,
    required this.ticketId,
    required this.status,
    this.ticketTypeId,
    this.attendeeName,
    this.onTap,
  });

  final String ticketId;
  final String status;
  final String? ticketTypeId;
  final String? attendeeName;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final content = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(attendeeName ?? 'Guest'),
        Text('Ticket $ticketId'),
        if (ticketTypeId != null) Text('Type $ticketTypeId'),
        Text(status),
      ],
    );
    if (onTap == null) return content;
    return GestureDetector(onTap: onTap, child: content);
  }
}

class TixkitScannerStatus extends StatelessWidget {
  const TixkitScannerStatus({
    super.key,
    this.result,
    this.manifest,
    this.offlineScanCount,
    this.onSync,
  });

  final TixkitScanResult? result;
  final TixkitOfflineManifest? manifest;
  final int? offlineScanCount;
  final VoidCallback? onSync;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(result?.message ?? 'Ready to scan'),
        if (manifest != null) Text('List ${manifest!.checkInListId}'),
        if (offlineScanCount != null) Text('Offline scans $offlineScanCount'),
        if (onSync != null) GestureDetector(onTap: onSync, child: const Text('Sync')),
      ],
    );
  }
}
