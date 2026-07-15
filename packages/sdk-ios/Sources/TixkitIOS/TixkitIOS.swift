import CryptoKit
import Foundation
import SwiftUI

#if canImport(Security)
import Security
#endif

public let TixkitAPIVersion = "2026-07-29"

public enum TixkitScanOutcome: String, Codable, Equatable, Sendable {
  case accepted
  case duplicate
  case invalid
  case revoked
  case notFound = "not_found"
  case wrongEvent = "wrong_event"
  case wrongList = "wrong_list"
}

public enum TixkitScannerMode: Sendable {
  case online
  case offline
  case automatic
}

public struct TixkitScanResult: Codable, Equatable, Sendable {
  public init(outcome: TixkitScanOutcome, message: String, ticketId: String? = nil) {
    self.outcome = outcome
    self.message = message
    self.ticketId = ticketId
  }

  public let outcome: TixkitScanOutcome
  public let message: String
  public let ticketId: String?
}

public struct TixkitOfflineTicket: Codable, Equatable, Sendable {
  public init(
    ticketId: String,
    ticketTypeId: String? = nil,
    eventOccurrenceId: String? = nil,
    attendeeName: String? = nil,
    qrHash: String,
    status: String
  ) {
    self.ticketId = ticketId
    self.ticketTypeId = ticketTypeId
    self.eventOccurrenceId = eventOccurrenceId
    self.attendeeName = attendeeName
    self.qrHash = qrHash
    self.status = status
  }

  public let ticketId: String
  public let ticketTypeId: String?
  public let eventOccurrenceId: String?
  public let attendeeName: String?
  public let qrHash: String
  public let status: String
}

public struct TixkitOfflineManifest: Equatable, Sendable {
  public init(
    eventId: String,
    checkInListId: String,
    generatedAt: Date,
    expiresAt: Date,
    keyId: String,
    signature: String,
    tickets: [TixkitOfflineTicket]
  ) {
    self.eventId = eventId
    self.checkInListId = checkInListId
    self.generatedAt = generatedAt
    self.expiresAt = expiresAt
    self.keyId = keyId
    self.signature = signature
    self.tickets = tickets
  }

  public let eventId: String
  public let checkInListId: String
  public let generatedAt: Date
  public let expiresAt: Date
  public let keyId: String
  public let signature: String
  public let tickets: [TixkitOfflineTicket]
}

extension TixkitOfflineManifest: Codable {
  private enum CodingKeys: String, CodingKey {
    case eventId
    case checkInListId
    case generatedAt
    case expiresAt
    case keyId
    case signature
    case tickets
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    self.eventId = try container.decode(String.self, forKey: .eventId)
    self.checkInListId = try container.decode(String.self, forKey: .checkInListId)
    self.generatedAt = try TixkitISO8601.parse(container.decode(String.self, forKey: .generatedAt))
    self.expiresAt = try TixkitISO8601.parse(container.decode(String.self, forKey: .expiresAt))
    self.keyId = try container.decode(String.self, forKey: .keyId)
    self.signature = try container.decode(String.self, forKey: .signature)
    self.tickets = try container.decode([TixkitOfflineTicket].self, forKey: .tickets)
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(eventId, forKey: .eventId)
    try container.encode(checkInListId, forKey: .checkInListId)
    try container.encode(TixkitISO8601.format(generatedAt), forKey: .generatedAt)
    try container.encode(TixkitISO8601.format(expiresAt), forKey: .expiresAt)
    try container.encode(keyId, forKey: .keyId)
    try container.encode(signature, forKey: .signature)
    try container.encode(tickets, forKey: .tickets)
  }
}

public struct TixkitSyncResult: Codable, Equatable, Sendable {
  public init(accepted: Int, duplicates: Int, invalid: Int, results: [[String: String]]) {
    self.accepted = accepted
    self.duplicates = duplicates
    self.invalid = invalid
    self.results = results
  }

  public let accepted: Int
  public let duplicates: Int
  public let invalid: Int
  public let results: [[String: String]]
}

public protocol TixkitSecureStoring: Sendable {
  func getItem(_ key: String) throws -> String?
  func setItem(_ key: String, value: String) throws
  func removeItem(_ key: String) throws
}

public final class TixkitMemorySecureStorage: TixkitSecureStoring, @unchecked Sendable {
  public init(values: [String: String] = [:]) {
    self.values = values
  }

  private var values: [String: String]
  private let lock = NSLock()

  public func getItem(_ key: String) throws -> String? {
    lock.withLock { values[key] }
  }

  public func setItem(_ key: String, value: String) throws {
    lock.withLock {
      values[key] = value
    }
  }

  public func removeItem(_ key: String) throws {
    _ = lock.withLock {
      values.removeValue(forKey: key)
    }
  }
}

public enum TixkitKeychainStorageError: Error, Equatable {
  case unavailable
  case unhandledStatus(Int32)
}

public final class TixkitKeychainStorage: TixkitSecureStoring, @unchecked Sendable {
  public init(service: String = "com.tixkit.sdk-ios") {
    self.service = service
  }

  private let service: String

  public func getItem(_ key: String) throws -> String? {
    #if canImport(Security)
    var query = baseQuery(key)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess else { throw TixkitKeychainStorageError.unhandledStatus(status) }
    guard let data = result as? Data else { return nil }
    return String(data: data, encoding: .utf8)
    #else
    throw TixkitKeychainStorageError.unavailable
    #endif
  }

  public func setItem(_ key: String, value: String) throws {
    #if canImport(Security)
    let data = Data(value.utf8)
    var query = baseQuery(key)
    let update = [kSecValueData as String: data]
    let updateStatus = SecItemUpdate(query as CFDictionary, update as CFDictionary)
    if updateStatus == errSecSuccess { return }
    guard updateStatus == errSecItemNotFound else { throw TixkitKeychainStorageError.unhandledStatus(updateStatus) }
    query[kSecValueData as String] = data
    let addStatus = SecItemAdd(query as CFDictionary, nil)
    guard addStatus == errSecSuccess else { throw TixkitKeychainStorageError.unhandledStatus(addStatus) }
    #else
    throw TixkitKeychainStorageError.unavailable
    #endif
  }

  public func removeItem(_ key: String) throws {
    #if canImport(Security)
    let status = SecItemDelete(baseQuery(key) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw TixkitKeychainStorageError.unhandledStatus(status)
    }
    #else
    throw TixkitKeychainStorageError.unavailable
    #endif
  }

  #if canImport(Security)
  private func baseQuery(_ key: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: key,
    ]
  }
  #endif
}

public struct TixkitScannerCredentials: Codable, Equatable, Sendable {
  public init(deviceId: String, deviceSecret: String, manifestSigningKey: String) {
    self.deviceId = deviceId
    self.deviceSecret = deviceSecret
    self.manifestSigningKey = manifestSigningKey
  }

  public let deviceId: String
  public let deviceSecret: String
  public let manifestSigningKey: String
}

public enum TixkitScannerCredentialStore {
  public static func save(_ credentials: TixkitScannerCredentials, in storage: TixkitSecureStoring, key: String = "tixkit:scanner:credentials") throws {
    let data = try JSONEncoder().encode(credentials)
    guard let encoded = String(data: data, encoding: .utf8) else { return }
    try storage.setItem(key, value: encoded)
  }

  public static func load(from storage: TixkitSecureStoring, key: String = "tixkit:scanner:credentials") throws -> TixkitScannerCredentials? {
    guard let raw = try storage.getItem(key), let data = raw.data(using: .utf8) else { return nil }
    return try JSONDecoder().decode(TixkitScannerCredentials.self, from: data)
  }

  public static func clear(from storage: TixkitSecureStoring, key: String = "tixkit:scanner:credentials") throws {
    try storage.removeItem(key)
  }
}

public struct TixkitCheckoutHandoffItem: Equatable, Sendable {
  public init(ticketTypeId: String? = nil, productId: String? = nil, resaleListingId: String? = nil, quantity: Int) {
    self.ticketTypeId = ticketTypeId
    self.productId = productId
    self.resaleListingId = resaleListingId
    self.quantity = quantity
  }

  public let ticketTypeId: String?
  public let productId: String?
  public let resaleListingId: String?
  public let quantity: Int
}

public struct TixkitCheckoutHandoffOptions: Equatable, Sendable {
  public init(
    eventId: String,
    checkoutBaseURL: URL = URL(string: "https://checkout.tixkit.com")!,
    brandId: String? = nil,
    items: [TixkitCheckoutHandoffItem] = [],
    products: [String] = [],
    discountCode: String? = nil,
    accessCode: String? = nil,
    trackingId: String? = nil,
    affiliateCode: String? = nil,
    locale: String? = nil,
    theme: String? = nil,
    mode: String? = nil,
    successURL: String? = nil,
    cancelURL: String? = nil
  ) {
    self.eventId = eventId
    self.checkoutBaseURL = checkoutBaseURL
    self.brandId = brandId
    self.items = items
    self.products = products
    self.discountCode = discountCode
    self.accessCode = accessCode
    self.trackingId = trackingId
    self.affiliateCode = affiliateCode
    self.locale = locale
    self.theme = theme
    self.mode = mode
    self.successURL = successURL
    self.cancelURL = cancelURL
  }

  public let eventId: String
  public let checkoutBaseURL: URL
  public let brandId: String?
  public let items: [TixkitCheckoutHandoffItem]
  public let products: [String]
  public let discountCode: String?
  public let accessCode: String?
  public let trackingId: String?
  public let affiliateCode: String?
  public let locale: String?
  public let theme: String?
  public let mode: String?
  public let successURL: String?
  public let cancelURL: String?
}

public func tixkitCheckoutHandoffURL(_ options: TixkitCheckoutHandoffOptions) -> URL {
  var components = URLComponents(url: options.checkoutBaseURL, resolvingAgainstBaseURL: false)!
  components.path = "/checkout"
  var queryItems = [URLQueryItem(name: "eventId", value: options.eventId)]
  if let brandId = options.brandId { queryItems.append(URLQueryItem(name: "brand", value: brandId)) }
  if let resaleListingId = options.items.first(where: { !($0.resaleListingId ?? "").isEmpty })?.resaleListingId {
    queryItems.append(URLQueryItem(name: "resaleListing", value: resaleListingId))
  }
  let encodedItems = options.items.compactMap { item -> String? in
    if item.resaleListingId != nil { return nil }
    guard item.quantity > 0, let id = item.ticketTypeId ?? item.productId else { return nil }
    return "\(id)=\(item.quantity)"
  }.joined(separator: ",")
  if !encodedItems.isEmpty { queryItems.append(URLQueryItem(name: "items", value: encodedItems)) }
  if !options.products.isEmpty { queryItems.append(URLQueryItem(name: "products", value: options.products.joined(separator: ","))) }
  if let discountCode = options.discountCode { queryItems.append(URLQueryItem(name: "discount", value: discountCode)) }
  if let accessCode = options.accessCode { queryItems.append(URLQueryItem(name: "accessCode", value: accessCode)) }
  if let trackingId = options.trackingId { queryItems.append(URLQueryItem(name: "tracking", value: trackingId)) }
  if let affiliateCode = options.affiliateCode { queryItems.append(URLQueryItem(name: "affiliate", value: affiliateCode)) }
  if let locale = options.locale { queryItems.append(URLQueryItem(name: "locale", value: locale)) }
  if let theme = options.theme { queryItems.append(URLQueryItem(name: "theme", value: theme)) }
  if let mode = options.mode { queryItems.append(URLQueryItem(name: "mode", value: mode)) }
  if let successURL = options.successURL { queryItems.append(URLQueryItem(name: "successUrl", value: successURL)) }
  if let cancelURL = options.cancelURL { queryItems.append(URLQueryItem(name: "cancelUrl", value: cancelURL)) }
  components.queryItems = queryItems
  return components.url!
}

public func tixkitQRHash(forPayload payload: String) -> String {
  SHA256.hash(data: Data(payload.utf8)).hexString
}

public struct TixkitPublicContentPage: Codable, Equatable, Sendable {
  public let document: TixkitPublicContentDocument
  public let version: TixkitPublicContentVersion
  public let page: TixkitPublicEventPage
}

public struct TixkitPublicContentDocument: Codable, Equatable, Sendable {
  public let eventId: String
  public let channel: String
  public let key: String
  public let name: String
  public let locale: String
  public let updatedAt: String
}

public struct TixkitPublicContentVersion: Codable, Equatable, Sendable {
  public let versionNumber: Int
  public let subject: String?
  public let previewText: String?
  public let publishedAt: String?
}

public struct TixkitPublicEventPage: Codable, Equatable, Sendable {
  public let provider: String
  public let puckData: TixkitPuckData
  public let settings: [String: TixkitJSONValue]?
  public let discovery: TixkitPublicEventDiscoveryCard
}

public struct TixkitEventPageDocumentV2: Codable, Equatable, Sendable {
  public let schemaVersion: Int
  public let editor: TixkitEventPageDocumentEditor
  public let settings: [String: TixkitJSONValue]?
}

public struct TixkitEventPageDocumentEditor: Codable, Equatable, Sendable {
  public let provider: String
  public let data: TixkitPuckData
}

public struct TixkitPuckData: Codable, Equatable, Sendable {
  public let content: [TixkitPuckComponentData]
  public let root: TixkitPuckRootData
  public let zones: [String: [TixkitPuckComponentData]]?
}

public struct TixkitPuckRootData: Codable, Equatable, Sendable {
  public let props: [String: TixkitJSONValue]
}

public struct TixkitPuckComponentData: Codable, Equatable, Sendable {
  public let type: String
  public let props: [String: TixkitJSONValue]
}

public struct TixkitPublicEventDiscoveryCard: Codable, Equatable, Sendable {
  public let title: String
  public let summary: String
  public let category: String?
  public let tags: [String]
  public let imageUrl: String?
  public let startsAt: String?
  public let venueName: String?
  public let publicPath: String?
}

public struct TixkitPublicTicketListingPage: Codable, Equatable, Sendable {
  public let items: [TixkitPublicTicketListing]
  public let hasMore: Bool
  public let nextCursor: String?
}

public struct TixkitPublicTicketListing: Codable, Equatable, Sendable {
  public let id: String
  public let eventId: String
  public let ticketTypeId: String?
  public let ticketTypeName: String?
  public let status: String
  public let priceCents: Int
  public let currency: String
  public let faceValueCents: Int
  public let expiresAt: String?
  public let createdAt: String?
  public let updatedAt: String?
}

public enum TixkitJSONValue: Codable, Equatable, Sendable {
  case string(String)
  case number(Double)
  case bool(Bool)
  case object([String: TixkitJSONValue])
  case array([TixkitJSONValue])
  case null

  public init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    if container.decodeNil() {
      self = .null
    } else if let value = try? container.decode(Bool.self) {
      self = .bool(value)
    } else if let value = try? container.decode(Double.self) {
      self = .number(value)
    } else if let value = try? container.decode(String.self) {
      self = .string(value)
    } else if let value = try? container.decode([TixkitJSONValue].self) {
      self = .array(value)
    } else {
      self = .object(try container.decode([String: TixkitJSONValue].self))
    }
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .string(let value):
      try container.encode(value)
    case .number(let value):
      try container.encode(value)
    case .bool(let value):
      try container.encode(value)
    case .object(let value):
      try container.encode(value)
    case .array(let value):
      try container.encode(value)
    case .null:
      try container.encodeNil()
    }
  }
}

public final class TixkitPublicEventPageClient: Sendable {
  public init(
    apiBaseURL: URL = URL(string: "https://api.tixkit.com")!,
    urlSession: URLSession = .shared
  ) {
    self.apiBaseURL = apiBaseURL
    self.urlSession = urlSession
  }

  public let apiBaseURL: URL
  public let urlSession: URLSession

  public func getEventPage(eventId: String, locale: String? = nil) async throws -> TixkitPublicContentPage {
    try await getPage(path: "/public/events/\(eventId)/page", locale: locale)
  }

  public func getContentPage(eventId: String, locale: String? = nil) async throws -> TixkitPublicContentPage {
    try await getPage(path: "/public/events/\(eventId)/content-page", locale: locale)
  }

  public func getEventPageBySlug(
    slug: String,
    host: String,
    locale: String? = nil
  ) async throws -> TixkitPublicContentPage {
    try await getPage(path: "/public/events/by-slug/\(slug)/page", host: host, locale: locale)
  }

  public func getEventDiscoveryCard(eventId: String, locale: String? = nil) async throws -> TixkitPublicEventDiscoveryCard {
    let (data, response) = try await urlSession.data(for: URLRequest(url: apiURL(path: "/public/events/\(eventId)/discovery-card", locale: locale)))
    try assertSuccess(response)
    return try JSONDecoder().decode(TixkitPublicEventDiscoveryCard.self, from: data)
  }

  public func listResaleListings(eventId: String, cursor: String? = nil, limit: Int? = nil) async throws -> TixkitPublicTicketListingPage {
    let (data, response) = try await urlSession.data(for: URLRequest(url: apiURL(path: "/public/events/\(eventId)/resale-listings", cursor: cursor, limit: limit)))
    try assertSuccess(response)
    return try JSONDecoder().decode(TixkitPublicTicketListingPage.self, from: data)
  }

  private func getPage(path: String, host: String? = nil, locale: String? = nil) async throws -> TixkitPublicContentPage {
    let (data, response) = try await urlSession.data(for: URLRequest(url: apiURL(path: path, host: host, locale: locale)))
    try assertSuccess(response)
    return try JSONDecoder().decode(TixkitPublicContentPage.self, from: data)
  }

  private func apiURL(path: String, host: String? = nil, locale: String? = nil, cursor: String? = nil, limit: Int? = nil) -> URL {
    var components = URLComponents(url: apiBaseURL, resolvingAgainstBaseURL: false)!
    components.path = "/v1\(path)"
    var queryItems: [URLQueryItem] = []
    if let host { queryItems.append(URLQueryItem(name: "host", value: host)) }
    if let locale { queryItems.append(URLQueryItem(name: "locale", value: locale)) }
    if let cursor { queryItems.append(URLQueryItem(name: "cursor", value: cursor)) }
    if let limit { queryItems.append(URLQueryItem(name: "limit", value: String(limit))) }
    components.queryItems = queryItems.isEmpty ? nil : queryItems
    return components.url!
  }

  private func assertSuccess(_ response: URLResponse) throws {
    guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
      throw URLError(.badServerResponse)
    }
  }
}

public struct TixkitTicketListingPage: Codable, Equatable, Sendable {
  public let items: [TixkitTicketListing]
  public let hasMore: Bool
  public let nextCursor: String?
}

public struct TixkitTicketListing: Codable, Equatable, Sendable {
  public let id: String
  public let eventId: String
  public let ticketId: String
  public let sellerId: String?
  public let status: String
  public let priceCents: Int
  public let currency: String
  public let faceValueCents: Int?
  public let soldToId: String?
}

public struct TixkitResaleCompletion: Codable, Equatable, Sendable {
  public let listing: TixkitTicketListing
  public let buyerTicket: TixkitJSONValue?
  public let sellerTicket: TixkitJSONValue?
  public let buyerAttendee: TixkitJSONValue?
}

public final class TixkitResaleClient: Sendable {
  public init(
    apiBaseURL: URL = URL(string: "https://api.tixkit.com")!,
    apiKey: String? = nil,
    urlSession: URLSession = .shared
  ) {
    self.apiBaseURL = apiBaseURL
    self.apiKey = apiKey
    self.urlSession = urlSession
  }

  public let apiBaseURL: URL
  public let apiKey: String?
  public let urlSession: URLSession

  public func listResaleListings(
    eventId: String,
    cursor: String? = nil,
    limit: Int? = nil
  ) async throws -> TixkitTicketListingPage {
    let request = apiRequest(path: "/events/\(eventId)/resale-listings", cursor: cursor, limit: limit)
    let (data, response) = try await urlSession.data(for: request)
    try assertSuccess(response)
    return try JSONDecoder().decode(TixkitTicketListingPage.self, from: data)
  }

  public func createTicketResaleListing(
    ticketId: String,
    priceCents: Int,
    idempotencyKey: String,
    expiresAt: String? = nil
  ) async throws -> TixkitTicketListing {
    try await postListing(
      path: "/tickets/\(ticketId)/resale-listings",
      body: [
        "priceCents": priceCents,
        "expiresAt": expiresAt as Any,
      ],
      idempotencyKey: idempotencyKey
    )
  }

  public func createCheckoutTicketResaleListing(
    sessionId: String,
    ticketId: String,
    priceCents: Int,
    sessionToken: String,
    idempotencyKey: String,
    expiresAt: String? = nil
  ) async throws -> TixkitTicketListing {
    try await postListing(
      path: "/checkout/sessions/\(sessionId)/tickets/\(ticketId)/resale-listing",
      body: [
        "priceCents": priceCents,
        "expiresAt": expiresAt as Any,
      ],
      idempotencyKey: idempotencyKey,
      sessionToken: sessionToken
    )
  }

  public func delistResaleListing(
    listingId: String,
    idempotencyKey: String
  ) async throws -> TixkitTicketListing {
    try await postListing(
      path: "/ticket-listings/\(listingId)/delist",
      body: [:],
      idempotencyKey: idempotencyKey
    )
  }

  public func completeResaleListing(
    listingId: String,
    buyerId: String,
    buyerEmail: String,
    idempotencyKey: String,
    buyerFirstName: String? = nil,
    buyerLastName: String? = nil,
    externalPaymentReference: String? = nil
  ) async throws -> TixkitResaleCompletion {
    var request = apiRequest(path: "/ticket-listings/\(listingId)/complete")
    request.httpMethod = "POST"
    applyWriteHeaders(&request, idempotencyKey: idempotencyKey)
    request.httpBody = try jsonData([
      "buyerId": buyerId,
      "buyerEmail": buyerEmail,
      "buyerFirstName": buyerFirstName as Any,
      "buyerLastName": buyerLastName as Any,
      "externalPaymentReference": externalPaymentReference as Any,
    ])
    let (data, response) = try await urlSession.data(for: request)
    try assertSuccess(response)
    return try JSONDecoder().decode(TixkitResaleCompletion.self, from: data)
  }

  private func postListing(
    path: String,
    body: [String: Any],
    idempotencyKey: String,
    sessionToken: String? = nil
  ) async throws -> TixkitTicketListing {
    var request = apiRequest(path: path)
    request.httpMethod = "POST"
    applyWriteHeaders(&request, idempotencyKey: idempotencyKey, sessionToken: sessionToken)
    request.httpBody = try jsonData(body)
    let (data, response) = try await urlSession.data(for: request)
    try assertSuccess(response)
    return try JSONDecoder().decode(TixkitTicketListing.self, from: data)
  }

  private func apiRequest(
    path: String,
    cursor: String? = nil,
    limit: Int? = nil
  ) -> URLRequest {
    var components = URLComponents(url: apiBaseURL, resolvingAgainstBaseURL: false)!
    components.path = "/v1\(path)"
    var queryItems: [URLQueryItem] = []
    if let cursor { queryItems.append(URLQueryItem(name: "cursor", value: cursor)) }
    if let limit { queryItems.append(URLQueryItem(name: "limit", value: "\(limit)")) }
    components.queryItems = queryItems.isEmpty ? nil : queryItems

    var request = URLRequest(url: components.url!)
    request.setValue(TixkitAPIVersion, forHTTPHeaderField: "X-Tixkit-Version")
    if let apiKey { request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization") }
    return request
  }

  private func applyWriteHeaders(
    _ request: inout URLRequest,
    idempotencyKey: String,
    sessionToken: String? = nil
  ) {
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key")
    if let sessionToken {
      request.setValue(sessionToken, forHTTPHeaderField: "X-Checkout-Session-Token")
    }
  }

  private func jsonData(_ dictionary: [String: Any]) throws -> Data {
    let compact = dictionary.compactMapValues { value -> Any? in
      if case Optional<Any>.none = value { return nil }
      return value
    }
    return try JSONSerialization.data(withJSONObject: compact)
  }

  private func assertSuccess(_ response: URLResponse) throws {
    guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
      throw URLError(.badServerResponse)
    }
  }
}

public final class TixkitScannerClient: @unchecked Sendable {
  public init(
    deviceId: String,
    deviceSecret: String,
    manifestSigningKey: String,
    apiBaseURL: URL = URL(string: "https://api.tixkit.com")!,
    storage: TixkitSecureStoring? = nil,
    storageKey: String? = nil,
    onSyncConflict: (@Sendable (String, String) -> Void)? = nil,
    urlSession: URLSession = .shared
  ) {
    self.deviceId = deviceId
    self.deviceSecret = deviceSecret
    self.manifestSigningKey = manifestSigningKey
    self.apiBaseURL = apiBaseURL
    self.storage = storage
    self.storageKey = storageKey
    self.onSyncConflict = onSyncConflict
    self.urlSession = urlSession
  }

  public let deviceId: String
  public let deviceSecret: String
  public let manifestSigningKey: String
  public let apiBaseURL: URL
  public let storage: TixkitSecureStoring?
  public let storageKey: String?
  public let onSyncConflict: (@Sendable (String, String) -> Void)?
  public let urlSession: URLSession

  private var manifest: TixkitOfflineManifest?
  private var offlineScans: [String: Date] = [:]
  private let lock = NSLock()

  public var offlineScanCount: Int {
    lock.withLock { offlineScans.count }
  }

  public func setManifest(_ manifest: TixkitOfflineManifest) {
    lock.withLock {
      self.manifest = manifest
      self.offlineScans.removeAll()
    }
    try? persistOfflineScans()
  }

  public func verifyManifestSignature(_ manifest: TixkitOfflineManifest) -> Bool {
    let key = SymmetricKey(data: Data(manifestSigningKey.utf8))
    let signature = HMAC<SHA256>.authenticationCode(for: manifest.unsignedCanonicalJSONData, using: key).hexString
    return signature == manifest.signature
  }

  public func downloadManifest(eventId: String, checkInListId: String) async throws -> TixkitOfflineManifest {
    var request = URLRequest(url: apiURL(path: "/events/\(eventId)/check-in-lists/\(checkInListId)/manifest"))
    applyAuthHeaders(to: &request)
    let (data, response) = try await urlSession.data(for: request)
    try assertSuccess(response)
    let manifest = try JSONDecoder().decode(TixkitOfflineManifest.self, from: data)
    guard verifyManifestSignature(manifest) else { throw TixkitScannerError.invalidManifestSignature }
    setManifest(manifest)
    return manifest
  }

  public func scanOnline(checkInListId: String, qrPayload: String, scannedAt: Date = Date()) async throws -> TixkitScanResult {
    var request = URLRequest(url: apiURL(path: "/check-ins/scan"))
    request.httpMethod = "POST"
    applyAuthHeaders(to: &request)
    request.httpBody = try JSONSerialization.data(withJSONObject: [
      "checkInListId": checkInListId,
      "qrPayload": qrPayload,
      "scannedAt": TixkitISO8601.format(scannedAt),
      "offline": false,
    ])
    let (data, response) = try await urlSession.data(for: request)
    try assertSuccess(response)
    return try JSONDecoder().decode(TixkitScanResult.self, from: data)
  }

  public func scanOffline(_ qrPayload: String, hashed: Bool = false, now: Date = Date()) -> TixkitScanResult {
    lock.withLock {
      guard let manifest else {
        return TixkitScanResult(outcome: .invalid, message: "No manifest downloaded")
      }
      guard manifest.expiresAt > now else {
        return TixkitScanResult(outcome: .invalid, message: "Manifest expired")
      }
      let qrHash = hashed ? qrPayload : tixkitQRHash(forPayload: qrPayload)
      guard let ticket = manifest.tickets.first(where: { $0.qrHash == qrHash }) else {
        return TixkitScanResult(outcome: .notFound, message: "Ticket not in manifest")
      }
      if ["void", "refunded", "transferred"].contains(ticket.status) {
        return TixkitScanResult(outcome: .revoked, message: "Ticket is voided, refunded, or transferred")
      }
      if offlineScans[qrHash] != nil {
        return TixkitScanResult(outcome: .duplicate, message: "Ticket already checked in", ticketId: ticket.ticketId)
      }
      offlineScans[qrHash] = now
      return TixkitScanResult(outcome: .accepted, message: "Check-in successful (offline)", ticketId: ticket.ticketId)
    }.also {
      try? persistOfflineScans()
    }
  }

  public func syncScans(checkInListId: String? = nil) async throws -> TixkitSyncResult {
    let snapshot = lock.withLock { (manifest?.checkInListId, offlineScans) }
    let listId = checkInListId ?? snapshot.0
    guard let listId, !listId.isEmpty else { throw TixkitScannerError.missingCheckInListId }
    guard !snapshot.1.isEmpty else {
      return TixkitSyncResult(accepted: 0, duplicates: 0, invalid: 0, results: [])
    }

    var request = URLRequest(url: apiURL(path: "/check-ins/sync"))
    request.httpMethod = "POST"
    applyAuthHeaders(to: &request)
    request.addValue(syncIdempotencyKey(checkInListId: listId, scans: snapshot.1), forHTTPHeaderField: "Idempotency-Key")
    request.httpBody = try JSONSerialization.data(withJSONObject: [
      "checkInListId": listId,
      "scans": snapshot.1.map { key, value in
        ["qrHash": key, "scannedAt": TixkitISO8601.format(value), "offline": true] as [String: Any]
      },
    ])
    let (data, response) = try await urlSession.data(for: request)
    try assertSuccess(response)
    let result = try JSONDecoder().decode(TixkitSyncResult.self, from: data)

    lock.withLock {
      for item in result.results {
        let outcome = item["outcome"] ?? "invalid"
        let qrHash = item["qrHash"] ?? ""
        if outcome != "accepted" { onSyncConflict?(qrHash, outcome) }
        if outcome == "accepted" { offlineScans.removeValue(forKey: qrHash) }
      }
    }
    try persistOfflineScans()
    return result
  }

  public func restoreOfflineScans() throws {
    guard let raw = try storage?.getItem(resolvedStorageKey), let data = raw.data(using: .utf8) else { return }
    let decoded = try JSONDecoder.tixkit.decode([PersistedOfflineScan].self, from: data)
    lock.withLock {
      offlineScans = Dictionary(uniqueKeysWithValues: decoded.map { ($0.qrHash, $0.scannedAt) })
    }
  }

  public func clearOfflineScans() throws {
    lock.withLock {
      offlineScans.removeAll()
    }
    try storage?.removeItem(resolvedStorageKey)
  }

  public func checkoutURL(_ options: TixkitCheckoutHandoffOptions) -> URL {
    tixkitCheckoutHandoffURL(options)
  }

  private var resolvedStorageKey: String {
    storageKey ?? "tixkit:scanner:\(deviceId):offline-scans"
  }

  private func persistOfflineScans() throws {
    guard let storage else { return }
    let snapshot = lock.withLock { offlineScans }
    guard !snapshot.isEmpty else {
      try storage.removeItem(resolvedStorageKey)
      return
    }
    let payload = snapshot
      .map { PersistedOfflineScan(qrHash: $0.key, scannedAt: $0.value) }
      .sorted { $0.qrHash < $1.qrHash }
    let data = try JSONEncoder.tixkit.encode(payload)
    guard let raw = String(data: data, encoding: .utf8) else { return }
    try storage.setItem(resolvedStorageKey, value: raw)
  }

  private func apiURL(path: String) -> URL {
    var components = URLComponents(url: apiBaseURL, resolvingAgainstBaseURL: false)!
    components.path = "/v1\(path)"
    return components.url!
  }

  private func applyAuthHeaders(to request: inout URLRequest) {
    request.addValue("application/json", forHTTPHeaderField: "Content-Type")
    request.addValue(deviceId, forHTTPHeaderField: "X-Device-Id")
    request.addValue(deviceSecret, forHTTPHeaderField: "X-Device-Secret")
  }

  private func syncIdempotencyKey(checkInListId: String, scans: [String: Date]) -> String {
    let timestamps = scans.values.map(TixkitISO8601.format).sorted()
    return [
      "scanner-sync",
      deviceId,
      checkInListId,
      String(scans.count),
      timestamps.first ?? "none",
      timestamps.last ?? "none",
    ].joined(separator: ":")
  }

  private func assertSuccess(_ response: URLResponse) throws {
    guard let httpResponse = response as? HTTPURLResponse else { throw TixkitScannerError.invalidResponse }
    guard (200..<300).contains(httpResponse.statusCode) else {
      throw TixkitScannerError.httpStatus(httpResponse.statusCode)
    }
  }
}

public enum TixkitScannerError: Error, Equatable {
  case httpStatus(Int)
  case invalidManifestSignature
  case invalidResponse
  case missingCheckInListId
}

public final class TixkitScannerController: ObservableObject {
  public init(
    client: TixkitScannerClient,
    checkInListId: String,
    mode: TixkitScannerMode = .online,
    throttle: TimeInterval = 1.5,
    onResult: (@MainActor (TixkitScanResult) -> Void)? = nil,
    onError: (@MainActor (Error) -> Void)? = nil
  ) {
    self.client = client
    self.checkInListId = checkInListId
    self.mode = mode
    self.throttle = throttle
    self.onResult = onResult
    self.onError = onError
  }

  @Published public private(set) var lastResult: TixkitScanResult?
  @Published public private(set) var isScanning = false

  public let client: TixkitScannerClient
  public let checkInListId: String
  public let mode: TixkitScannerMode
  public let throttle: TimeInterval

  private let onResult: (@MainActor (TixkitScanResult) -> Void)?
  private let onError: (@MainActor (Error) -> Void)?
  private var lastPayload: String?
  private var lastScanAt: Date?

  @MainActor
  public func handlePayload(_ payload: String) async {
    guard !payload.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !isScanning else { return }
    let now = Date()
    if lastPayload == payload, let lastScanAt, now.timeIntervalSince(lastScanAt) < throttle { return }
    lastPayload = payload
    lastScanAt = now
    isScanning = true
    defer { isScanning = false }
    do {
      let result = try await scan(payload)
      lastResult = result
      onResult?(result)
    } catch {
      onError?(error)
    }
  }

  private func scan(_ payload: String) async throws -> TixkitScanResult {
    switch mode {
    case .offline:
      return client.scanOffline(payload)
    case .online:
      return try await client.scanOnline(checkInListId: checkInListId, qrPayload: payload)
    case .automatic:
      do {
        return try await client.scanOnline(checkInListId: checkInListId, qrPayload: payload)
      } catch {
        return client.scanOffline(payload)
      }
    }
  }
}

public struct TixkitTicketCard: View {
  public init(ticketId: String, status: String, ticketTypeId: String? = nil, attendeeName: String? = nil) {
    self.ticketId = ticketId
    self.status = status
    self.ticketTypeId = ticketTypeId
    self.attendeeName = attendeeName
  }

  public let ticketId: String
  public let status: String
  public let ticketTypeId: String?
  public let attendeeName: String?

  public var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(attendeeName ?? "Guest")
      Text("Ticket \(ticketId)")
      if let ticketTypeId {
        Text("Type \(ticketTypeId)")
      }
      Text(status)
    }
  }
}

public struct TixkitScannerStatusView: View {
  public init(result: TixkitScanResult? = nil, manifest: TixkitOfflineManifest? = nil, offlineScanCount: Int? = nil, onSync: (() -> Void)? = nil) {
    self.result = result
    self.manifest = manifest
    self.offlineScanCount = offlineScanCount
    self.onSync = onSync
  }

  public let result: TixkitScanResult?
  public let manifest: TixkitOfflineManifest?
  public let offlineScanCount: Int?
  public let onSync: (() -> Void)?

  public var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(result?.message ?? "Ready to scan")
      if let manifest {
        Text("List \(manifest.checkInListId)")
      }
      if let offlineScanCount {
        Text("Offline scans \(offlineScanCount)")
      }
      if let onSync {
        Button("Sync", action: onSync)
      }
    }
  }
}

private struct PersistedOfflineScan: Codable, Equatable {
  let qrHash: String
  let scannedAt: Date
}

private enum TixkitISO8601 {
  static func parse(_ value: String) throws -> Date {
    if let date = fractionalFormatter.date(from: value) ?? wholeSecondFormatter.date(from: value) {
      return date
    }
    throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "Invalid ISO8601 date: \(value)"))
  }

  static func format(_ date: Date) -> String {
    fractionalFormatter.string(from: date)
  }

  private static let fractionalFormatter: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    return formatter
  }()

  private static let wholeSecondFormatter: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    return formatter
  }()
}

private extension TixkitOfflineManifest {
  var unsignedCanonicalJSONData: Data {
    let ticketsJSON = tickets.map { ticket in
      var fields = [
        #""ticketId":"\#(ticket.ticketId.jsonEscaped)""#,
        #""ticketTypeId":"\#((ticket.ticketTypeId ?? "").jsonEscaped)""#,
        #""attendeeName":"\#((ticket.attendeeName ?? "").jsonEscaped)""#,
        #""qrHash":"\#(ticket.qrHash.jsonEscaped)""#,
        #""status":"\#(ticket.status.jsonEscaped)""#,
      ]
      if ticket.ticketTypeId == nil {
        fields[1] = #""ticketTypeId":null"#
      }
      if let eventOccurrenceId = ticket.eventOccurrenceId {
        fields.insert(#""eventOccurrenceId":"\#(eventOccurrenceId.jsonEscaped)""#, at: 2)
      }
      if ticket.attendeeName == nil {
        let attendeeNameIndex = ticket.eventOccurrenceId == nil ? 2 : 3
        fields[attendeeNameIndex] = #""attendeeName":null"#
      }
      return "{\(fields.joined(separator: ","))}"
    }.joined(separator: ",")
    let json = """
    {"eventId":"\(eventId.jsonEscaped)","checkInListId":"\(checkInListId.jsonEscaped)","generatedAt":"\(TixkitISO8601.format(generatedAt))","expiresAt":"\(TixkitISO8601.format(expiresAt))","keyId":"\(keyId.jsonEscaped)","tickets":[\(ticketsJSON)]}
    """
    return Data(json.utf8)
  }
}

private extension String {
  var jsonEscaped: String {
    let data = try? JSONEncoder().encode(self)
    let encoded = data.flatMap { String(data: $0, encoding: .utf8) } ?? #""""#
    return String(encoded.dropFirst().dropLast())
  }
}

private extension Digest {
  var hexString: String {
    map { String(format: "%02x", $0) }.joined()
  }
}

private extension HMAC<SHA256>.MAC {
  var hexString: String {
    map { String(format: "%02x", $0) }.joined()
  }
}

private extension JSONEncoder {
  static let tixkit: JSONEncoder = {
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .custom { date, encoder in
      var container = encoder.singleValueContainer()
      try container.encode(TixkitISO8601.format(date))
    }
    return encoder
  }()
}

private extension JSONDecoder {
  static let tixkit: JSONDecoder = {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .custom { decoder in
      let container = try decoder.singleValueContainer()
      return try TixkitISO8601.parse(container.decode(String.self))
    }
    return decoder
  }()
}

private extension NSLock {
  func withLock<T>(_ body: () throws -> T) rethrows -> T {
    lock()
    defer { unlock() }
    return try body()
  }
}

private extension TixkitScanResult {
  func also(_ body: () -> Void) -> TixkitScanResult {
    body()
    return self
  }
}
