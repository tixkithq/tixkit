package com.tixkit.sdk

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.view.View
import android.widget.LinearLayout
import android.widget.TextView
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import java.security.MessageDigest
import java.time.Clock
import java.time.Instant
import java.time.format.DateTimeFormatterBuilder
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.Mac
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import org.json.JSONArray
import org.json.JSONObject

enum class TixkitScanOutcome(val wireValue: String) {
  ACCEPTED("accepted"),
  DUPLICATE("duplicate"),
  INVALID("invalid"),
  REVOKED("revoked"),
  NOT_FOUND("not_found"),
  WRONG_EVENT("wrong_event"),
  WRONG_LIST("wrong_list");

  companion object {
    fun fromWire(value: String?): TixkitScanOutcome =
      entries.firstOrNull { it.wireValue == value } ?: INVALID
  }
}

enum class TixkitScannerMode {
  ONLINE,
  OFFLINE,
  AUTOMATIC,
}

data class TixkitScanResult(
  val outcome: TixkitScanOutcome,
  val message: String,
  val ticketId: String? = null,
)

data class TixkitOfflineTicket(
  val ticketId: String,
  val ticketTypeId: String? = null,
  val eventOccurrenceId: String? = null,
  val attendeeName: String? = null,
  val qrHash: String,
  val status: String,
)

data class TixkitOfflineManifest(
  val eventId: String,
  val checkInListId: String,
  val generatedAt: Instant,
  val expiresAt: Instant,
  val keyId: String,
  val signature: String,
  val tickets: List<TixkitOfflineTicket>,
)

data class TixkitSyncResult(
  val accepted: Int,
  val duplicates: Int,
  val invalid: Int,
  val results: List<Map<String, String>>,
)

data class TixkitScannerCredentials(
  val apiKey: String,
  val deviceId: String,
  val organizationId: String,
  val eventId: String,
  val checkInListId: String,
) {
  internal fun toStorageString(): String =
    listOf(apiKey, deviceId, organizationId, eventId, checkInListId).joinToString("\t") { base64UrlEncode(it) }

  companion object {
    internal fun fromStorageString(raw: String): TixkitScannerCredentials? {
      val parts = raw.split("\t")
      if (parts.size != 5) return null
      return runCatching {
        TixkitScannerCredentials(
          apiKey = base64UrlDecode(parts[0]),
          deviceId = base64UrlDecode(parts[1]),
          organizationId = base64UrlDecode(parts[2]),
          eventId = base64UrlDecode(parts[3]),
          checkInListId = base64UrlDecode(parts[4]),
        )
      }.getOrNull()
    }
  }
}

data class TixkitCheckoutOptions(
  val checkoutBaseUrl: String,
  val eventId: String,
  val organizationId: String,
  val successUrl: String,
  val cancelUrl: String,
  val ticketTypes: Map<String, Int> = emptyMap(),
  val resaleListingId: String? = null,
  val attendeeEmail: String? = null,
  val promoCode: String? = null,
  val tracking: String? = null,
)

data class TixkitPublicContentPage(
  val document: TixkitPublicContentDocument,
  val version: TixkitPublicContentVersion,
  val page: TixkitPublicEventPage,
)

data class TixkitPublicContentDocument(
  val eventId: String,
  val channel: String,
  val key: String,
  val name: String,
  val locale: String,
  val updatedAt: String,
)

data class TixkitPublicContentVersion(
  val versionNumber: Int,
  val subject: String? = null,
  val previewText: String? = null,
  val publishedAt: String? = null,
)

data class TixkitPublicEventPage(
  val provider: String,
  val puckData: TixkitPuckData,
  val settings: Map<String, Any?> = emptyMap(),
  val discovery: TixkitPublicEventDiscoveryCard,
)

data class TixkitEventPageDocumentV2(
  val schemaVersion: Int,
  val editor: TixkitEventPageDocumentEditor,
  val settings: Map<String, Any?> = emptyMap(),
)

data class TixkitEventPageDocumentEditor(
  val provider: String,
  val data: TixkitPuckData,
)

data class TixkitPuckData(
  val content: List<TixkitPuckComponentData>,
  val root: TixkitPuckRootData,
  val zones: Map<String, List<TixkitPuckComponentData>> = emptyMap(),
)

data class TixkitPuckRootData(
  val props: Map<String, Any?> = emptyMap(),
)

data class TixkitPuckComponentData(
  val type: String,
  val props: Map<String, Any?> = emptyMap(),
)

data class TixkitPublicEventDiscoveryCard(
  val title: String,
  val summary: String,
  val tags: List<String>,
  val category: String? = null,
  val imageUrl: String? = null,
  val startsAt: String? = null,
  val venueName: String? = null,
  val publicPath: String? = null,
)

data class TixkitTicketListingPage(
  val items: List<TixkitTicketListing>,
  val hasMore: Boolean = false,
  val nextCursor: String? = null,
)

data class TixkitPublicTicketListingPage(
  val items: List<TixkitPublicTicketListing>,
  val hasMore: Boolean = false,
  val nextCursor: String? = null,
)

data class TixkitPublicTicketListing(
  val id: String,
  val eventId: String,
  val ticketTypeId: String? = null,
  val ticketTypeName: String? = null,
  val status: String,
  val priceCents: Int,
  val currency: String,
  val faceValueCents: Int,
  val expiresAt: String? = null,
  val createdAt: String? = null,
  val updatedAt: String? = null,
)

data class TixkitTicketListing(
  val id: String,
  val eventId: String,
  val ticketId: String,
  val sellerId: String? = null,
  val status: String,
  val priceCents: Int,
  val currency: String,
  val faceValueCents: Int? = null,
  val soldToId: String? = null,
)

data class TixkitResaleCompletion(
  val listing: TixkitTicketListing,
  val buyerTicketId: String? = null,
  val buyerAttendeeId: String? = null,
)

fun interface TixkitPublicEventPageTransport {
  fun get(url: String, headers: Map<String, String>): String
}

fun interface TixkitResaleTransport {
  fun request(method: String, url: String, headers: Map<String, String>, body: String?): String
}

class TixkitHttpUrlConnectionTransport : TixkitPublicEventPageTransport {
  override fun get(url: String, headers: Map<String, String>): String {
    val connection = URL(url).openConnection() as HttpURLConnection
    connection.requestMethod = "GET"
    headers.forEach { (key, value) -> connection.setRequestProperty(key, value) }
    val status = connection.responseCode
    val stream = if (status in 200..299) connection.inputStream else connection.errorStream
    val body = stream?.bufferedReader(StandardCharsets.UTF_8)?.use { it.readText() }.orEmpty()
    if (status !in 200..299) error("Tixkit API request failed with HTTP $status")
    return body
  }
}

class TixkitHttpUrlConnectionResaleTransport : TixkitResaleTransport {
  override fun request(method: String, url: String, headers: Map<String, String>, body: String?): String {
    val connection = URL(url).openConnection() as HttpURLConnection
    connection.requestMethod = method
    headers.forEach { (key, value) -> connection.setRequestProperty(key, value) }
    if (body != null) {
      connection.doOutput = true
      connection.outputStream.use { it.write(body.toByteArray(StandardCharsets.UTF_8)) }
    }
    val status = connection.responseCode
    val stream = if (status in 200..299) connection.inputStream else connection.errorStream
    val responseBody = stream?.bufferedReader(StandardCharsets.UTF_8)?.use { it.readText() }.orEmpty()
    if (status !in 200..299) error("Tixkit API request failed with HTTP $status")
    return responseBody
  }
}

class TixkitPublicEventPageClient(
  private val apiBaseUrl: String = "https://api.tixkit.com",
  private val transport: TixkitPublicEventPageTransport = TixkitHttpUrlConnectionTransport(),
) {
  fun getEventPage(eventId: String, locale: String? = null): TixkitPublicContentPage =
    getPage("/public/events/$eventId/page", locale = locale)

  fun getContentPage(eventId: String, locale: String? = null): TixkitPublicContentPage =
    getPage("/public/events/$eventId/content-page", locale = locale)

  fun getEventPageBySlug(slug: String, host: String, locale: String? = null): TixkitPublicContentPage =
    getPage("/public/events/by-slug/$slug/page", host = host, locale = locale)

  fun getEventDiscoveryCard(eventId: String, locale: String? = null): TixkitPublicEventDiscoveryCard =
    parseDiscovery(JSONObject(transport.get(apiUrl("/public/events/$eventId/discovery-card", locale = locale), publicHeaders)))

  fun listResaleListings(eventId: String, cursor: String? = null, limit: Int? = null): TixkitPublicTicketListingPage =
    parsePublicListingPage(JSONObject(transport.get(apiUrl("/public/events/$eventId/resale-listings", cursor = cursor, limit = limit), publicHeaders)))

  private fun getPage(path: String, host: String? = null, locale: String? = null): TixkitPublicContentPage =
    parsePage(JSONObject(transport.get(apiUrl(path, host = host, locale = locale), publicHeaders)))

  private val publicHeaders: Map<String, String>
    get() = mapOf("X-Tixkit-Version" to TixkitAndroid.API_VERSION)

  private fun apiUrl(path: String, host: String? = null, locale: String? = null, cursor: String? = null, limit: Int? = null): String {
    val base = apiBaseUrl.trimEnd('/')
    val query = buildList {
      if (!host.isNullOrBlank()) add("host" to host)
      if (!locale.isNullOrBlank()) add("locale" to locale)
      if (!cursor.isNullOrBlank()) add("cursor" to cursor)
      if (limit != null) add("limit" to limit.toString())
    }.joinToString("&") { (key, value) -> "${encode(key)}=${encode(value)}" }
    return "$base/v1$path${if (query.isEmpty()) "" else "?$query"}"
  }
}

class TixkitResaleClient(
  private val apiBaseUrl: String = "https://api.tixkit.com",
  private val apiKey: String? = null,
  private val transport: TixkitResaleTransport = TixkitHttpUrlConnectionResaleTransport(),
) {
  fun listResaleListings(eventId: String, cursor: String? = null, limit: Int? = null): TixkitTicketListingPage =
    parseListingPage(JSONObject(transport.request("GET", apiUrl("/events/$eventId/resale-listings", cursor = cursor, limit = limit), headers(), null)))

  fun createTicketResaleListing(ticketId: String, priceCents: Int, idempotencyKey: String, expiresAt: String? = null): TixkitTicketListing =
    postListing(
      path = "/tickets/$ticketId/resale-listings",
      idempotencyKey = idempotencyKey,
      body = JSONObject().put("priceCents", priceCents).putOptional("expiresAt", expiresAt),
    )

  fun createCheckoutTicketResaleListing(
    sessionId: String,
    ticketId: String,
    priceCents: Int,
    sessionToken: String,
    idempotencyKey: String,
    expiresAt: String? = null,
  ): TixkitTicketListing =
    postListing(
      path = "/checkout/sessions/$sessionId/tickets/$ticketId/resale-listing",
      idempotencyKey = idempotencyKey,
      sessionToken = sessionToken,
      body = JSONObject().put("priceCents", priceCents).putOptional("expiresAt", expiresAt),
    )

  fun delistResaleListing(listingId: String, idempotencyKey: String): TixkitTicketListing =
    postListing(
      path = "/ticket-listings/$listingId/delist",
      idempotencyKey = idempotencyKey,
      body = JSONObject(),
    )

  fun completeResaleListing(
    listingId: String,
    buyerId: String,
    buyerEmail: String,
    idempotencyKey: String,
    buyerFirstName: String? = null,
    buyerLastName: String? = null,
    externalPaymentReference: String? = null,
  ): TixkitResaleCompletion {
    val body = JSONObject()
      .put("buyerId", buyerId)
      .put("buyerEmail", buyerEmail)
      .putOptional("buyerFirstName", buyerFirstName)
      .putOptional("buyerLastName", buyerLastName)
      .putOptional("externalPaymentReference", externalPaymentReference)
    val json = JSONObject(
      transport.request(
        "POST",
        apiUrl("/ticket-listings/$listingId/complete"),
        headers(idempotencyKey = idempotencyKey),
        body.toString(),
      ),
    )
    return parseResaleCompletion(json)
  }

  private fun postListing(
    path: String,
    idempotencyKey: String,
    body: JSONObject,
    sessionToken: String? = null,
  ): TixkitTicketListing =
    parseListing(
      JSONObject(
        transport.request(
          "POST",
          apiUrl(path),
          headers(idempotencyKey = idempotencyKey, sessionToken = sessionToken),
          body.toString(),
        ),
      ),
    )

  private fun headers(idempotencyKey: String? = null, sessionToken: String? = null): Map<String, String> =
    buildMap {
      put("X-Tixkit-Version", TixkitAndroid.API_VERSION)
      apiKey?.takeIf { it.isNotBlank() }?.let { put("Authorization", "Bearer $it") }
      idempotencyKey?.let {
        put("Idempotency-Key", it)
        put("Content-Type", "application/json")
      }
      sessionToken?.let {
        put("X-Checkout-Session-Token", it)
        put("Content-Type", "application/json")
      }
    }

  private fun apiUrl(path: String, cursor: String? = null, limit: Int? = null): String {
    val base = apiBaseUrl.trimEnd('/')
    val query = buildList {
      if (!cursor.isNullOrBlank()) add("cursor" to cursor)
      if (limit != null) add("limit" to "$limit")
    }.joinToString("&") { (key, value) -> "${encode(key)}=${encode(value)}" }
    return "$base/v1$path${if (query.isEmpty()) "" else "?$query"}"
  }
}

interface TixkitSecureStorage {
  fun getItem(key: String): String?
  fun setItem(key: String, value: String)
  fun removeItem(key: String)
}

class TixkitMemorySecureStorage(initialValues: Map<String, String> = emptyMap()) : TixkitSecureStorage {
  private val values = initialValues.toMutableMap()

  @Synchronized
  override fun getItem(key: String): String? = values[key]

  @Synchronized
  override fun setItem(key: String, value: String) {
    values[key] = value
  }

  @Synchronized
  override fun removeItem(key: String) {
    values.remove(key)
  }
}

class TixkitSharedPreferencesStorage(
  private val preferences: SharedPreferences,
) : TixkitSecureStorage {
  override fun getItem(key: String): String? = preferences.getString(key, null)

  override fun setItem(key: String, value: String) {
    preferences.edit().putString(key, value).apply()
  }

  override fun removeItem(key: String) {
    preferences.edit().remove(key).apply()
  }
}

class TixkitKeystoreSharedPreferencesStorage(
  context: Context,
  private val preferencesName: String = "tixkit_secure_storage",
  private val keyAlias: String = "tixkit_scanner_credentials",
) : TixkitSecureStorage {
  private val preferences = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE)

  override fun getItem(key: String): String? {
    val packed = preferences.getString(key, null) ?: return null
    val separator = packed.indexOf(':')
    if (separator <= 0 || separator == packed.lastIndex) return null
    val iv = Base64.decode(packed.substring(0, separator), Base64.NO_WRAP)
    val ciphertext = Base64.decode(packed.substring(separator + 1), Base64.NO_WRAP)
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(GCM_TAG_BITS, iv))
    return String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8)
  }

  override fun setItem(key: String, value: String) {
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.ENCRYPT_MODE, secretKey())
    val ciphertext = cipher.doFinal(value.toByteArray(StandardCharsets.UTF_8))
    val packed = "${Base64.encodeToString(cipher.iv, Base64.NO_WRAP)}:${Base64.encodeToString(ciphertext, Base64.NO_WRAP)}"
    preferences.edit().putString(key, packed).apply()
  }

  override fun removeItem(key: String) {
    preferences.edit().remove(key).apply()
  }

  private fun secretKey(): SecretKey {
    val keyStore = KeyStore.getInstance("AndroidKeyStore").also { it.load(null) }
    (keyStore.getEntry(keyAlias, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
    val keyGenerator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    val spec = KeyGenParameterSpec.Builder(keyAlias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
      .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
      .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
      .setRandomizedEncryptionRequired(true)
      .build()
    keyGenerator.init(spec)
    return keyGenerator.generateKey()
  }

  private companion object {
    const val TRANSFORMATION = "AES/GCM/NoPadding"
    const val GCM_TAG_BITS = 128
  }
}

class TixkitScannerCredentialStore(
  private val storage: TixkitSecureStorage,
  private val storageKey: String = "tixkit.scanner.credentials",
) {
  fun save(credentials: TixkitScannerCredentials) {
    storage.setItem(storageKey, credentials.toStorageString())
  }

  fun load(): TixkitScannerCredentials? {
    val raw = storage.getItem(storageKey) ?: return null
    return TixkitScannerCredentials.fromStorageString(raw)
  }

  fun clear() {
    storage.removeItem(storageKey)
  }
}

class TixkitScannerClient(
  private val storage: TixkitSecureStorage = TixkitMemorySecureStorage(),
  private val clock: Clock = Clock.systemUTC(),
  private val onlineScanner: ((String) -> TixkitScanResult)? = null,
) {
  private val scanStorageKey = "tixkit.offline.scans"
  private val offlineScans = linkedSetOf<String>()

  init {
    restoreOfflineScans()
  }

  fun scan(
    qrPayload: String,
    mode: TixkitScannerMode = TixkitScannerMode.AUTOMATIC,
    manifest: TixkitOfflineManifest? = null,
  ): TixkitScanResult {
    val trimmedPayload = qrPayload.trim()
    if (trimmedPayload.isEmpty()) {
      return TixkitScanResult(TixkitScanOutcome.INVALID, "QR payload is empty")
    }
    if (mode == TixkitScannerMode.ONLINE || mode == TixkitScannerMode.AUTOMATIC) {
      val onlineResult = onlineScanner?.invoke(trimmedPayload)
      if (onlineResult != null || mode == TixkitScannerMode.ONLINE) {
        return onlineResult ?: TixkitScanResult(TixkitScanOutcome.INVALID, "Online scanner is unavailable")
      }
    }
    return scanOffline(trimmedPayload, manifest)
  }

  fun scanOffline(qrPayload: String, manifest: TixkitOfflineManifest?): TixkitScanResult {
    if (manifest == null) {
      return TixkitScanResult(TixkitScanOutcome.INVALID, "Offline manifest is required")
    }
    val now = Instant.now(clock)
    if (manifest.expiresAt.isBefore(now)) {
      return TixkitScanResult(TixkitScanOutcome.INVALID, "Offline manifest is expired")
    }
    val qrHash = tixkitQrHashForPayload(qrPayload)
    val ticket = manifest.tickets.firstOrNull { it.qrHash == qrHash }
      ?: return TixkitScanResult(TixkitScanOutcome.NOT_FOUND, "Ticket is not in the offline manifest")
    if (ticket.status.equals("revoked", ignoreCase = true) || ticket.status.equals("voided", ignoreCase = true)) {
      return TixkitScanResult(TixkitScanOutcome.REVOKED, "Ticket is revoked", ticket.ticketId)
    }
    if (!ticket.status.equals("valid", ignoreCase = true) && !ticket.status.equals("issued", ignoreCase = true)) {
      return TixkitScanResult(TixkitScanOutcome.INVALID, "Ticket is not valid", ticket.ticketId)
    }
    if (!offlineScans.add(qrHash)) {
      return TixkitScanResult(TixkitScanOutcome.DUPLICATE, "Ticket already scanned on this device", ticket.ticketId)
    }
    persistOfflineScans()
    return TixkitScanResult(TixkitScanOutcome.ACCEPTED, "Ticket accepted", ticket.ticketId)
  }

  fun pendingOfflineScanHashes(): List<String> = offlineScans.toList()

  fun restoreOfflineScans(): List<String> {
    offlineScans.clear()
    storage.getItem(scanStorageKey)
      ?.split("\n")
      ?.map { it.trim() }
      ?.filter { it.isNotEmpty() }
      ?.forEach { offlineScans.add(it) }
    return pendingOfflineScanHashes()
  }

  fun clearOfflineScans() {
    offlineScans.clear()
    storage.removeItem(scanStorageKey)
  }

  fun syncScans(
    uploader: (List<String>) -> TixkitSyncResult,
    onConflict: ((String, String) -> Unit)? = null,
  ): TixkitSyncResult {
    val pending = pendingOfflineScanHashes()
    if (pending.isEmpty()) {
      return TixkitSyncResult(accepted = 0, duplicates = 0, invalid = 0, results = emptyList())
    }
    val result = uploader(pending)
    val accepted = result.results
      .filter { it["outcome"] == TixkitScanOutcome.ACCEPTED.wireValue }
      .mapNotNull { it["qrHash"] }
      .toSet()
    result.results
      .filter { it["outcome"] == TixkitScanOutcome.DUPLICATE.wireValue || it["outcome"] == TixkitScanOutcome.INVALID.wireValue }
      .forEach { item ->
        val qrHash = item["qrHash"]
        val outcome = item["outcome"]
        if (qrHash != null && outcome != null) onConflict?.invoke(qrHash, outcome)
      }
    offlineScans.removeAll(accepted)
    persistOfflineScans()
    return result
  }

  private fun persistOfflineScans() {
    if (offlineScans.isEmpty()) {
      storage.removeItem(scanStorageKey)
      return
    }
    storage.setItem(scanStorageKey, offlineScans.joinToString("\n"))
  }
}

class TixkitScannerController(
  private val scannerClient: TixkitScannerClient,
  private val mode: TixkitScannerMode = TixkitScannerMode.AUTOMATIC,
  private val manifestProvider: () -> TixkitOfflineManifest? = { null },
) {
  fun handlePayload(payload: String): TixkitScanResult =
    scannerClient.scan(payload, mode = mode, manifest = manifestProvider())
}

class TixkitTicketDisplayView @JvmOverloads constructor(
  context: Context,
  attrs: android.util.AttributeSet? = null,
) : LinearLayout(context, attrs) {
  private val titleView = TextView(context)
  private val subtitleView = TextView(context)
  private val statusView = TextView(context)

  init {
    orientation = VERTICAL
    addView(titleView)
    addView(subtitleView)
    addView(statusView)
  }

  fun bind(ticket: TixkitOfflineTicket) {
    titleView.text = ticket.attendeeName?.takeIf { it.isNotBlank() } ?: ticket.ticketId
    subtitleView.text = ticket.ticketTypeId.orEmpty()
    subtitleView.visibility = if (ticket.ticketTypeId.isNullOrBlank()) View.GONE else View.VISIBLE
    statusView.text = ticket.status.replaceFirstChar { it.uppercase() }
  }
}

class TixkitScannerStatusView @JvmOverloads constructor(
  context: Context,
  attrs: android.util.AttributeSet? = null,
) : LinearLayout(context, attrs) {
  private val outcomeView = TextView(context)
  private val messageView = TextView(context)
  private val pendingView = TextView(context)

  init {
    orientation = VERTICAL
    addView(outcomeView)
    addView(messageView)
    addView(pendingView)
  }

  fun bind(result: TixkitScanResult, pendingOfflineScans: Int = 0) {
    outcomeView.text = result.outcome.wireValue
    messageView.text = result.message
    pendingView.text = "Pending offline scans: $pendingOfflineScans"
  }
}

object TixkitAndroid {
    const val API_VERSION = "2026-07-24"

  fun checkoutUrl(options: TixkitCheckoutOptions): String {
    val base = options.checkoutBaseUrl.trimEnd('/')
    val query = buildList {
      add("eventId" to options.eventId)
      add("organizationId" to options.organizationId)
      add("successUrl" to options.successUrl)
      add("cancelUrl" to options.cancelUrl)
      if (options.ticketTypes.isNotEmpty()) {
        add("items" to options.ticketTypes.entries.joinToString(",") { "${it.key}=${it.value}" })
      }
      options.resaleListingId?.takeIf { it.isNotBlank() }?.let { add("resaleListing" to it) }
      options.attendeeEmail?.takeIf { it.isNotBlank() }?.let { add("attendeeEmail" to it) }
      options.promoCode?.takeIf { it.isNotBlank() }?.let { add("promoCode" to it) }
      options.tracking?.takeIf { it.isNotBlank() }?.let { add("tracking" to it) }
    }.joinToString("&") { (key, value) -> "${encode(key)}=${encode(value)}" }
    return "$base/checkout?$query"
  }

  fun scannerCredentialStore(storage: TixkitSecureStorage): TixkitScannerCredentialStore =
    TixkitScannerCredentialStore(storage)

  fun scannerClient(
    storage: TixkitSecureStorage = TixkitMemorySecureStorage(),
    clock: Clock = Clock.systemUTC(),
    onlineScanner: ((String) -> TixkitScanResult)? = null,
  ): TixkitScannerClient = TixkitScannerClient(storage = storage, clock = clock, onlineScanner = onlineScanner)

  fun publicEventPageClient(
    apiBaseUrl: String = "https://api.tixkit.com",
    transport: TixkitPublicEventPageTransport = TixkitHttpUrlConnectionTransport(),
  ): TixkitPublicEventPageClient = TixkitPublicEventPageClient(apiBaseUrl = apiBaseUrl, transport = transport)

  fun resaleClient(
    apiBaseUrl: String = "https://api.tixkit.com",
    apiKey: String? = null,
    transport: TixkitResaleTransport = TixkitHttpUrlConnectionResaleTransport(),
  ): TixkitResaleClient = TixkitResaleClient(apiBaseUrl = apiBaseUrl, apiKey = apiKey, transport = transport)
}

fun tixkitQrHashForPayload(qrPayload: String): String =
  sha256Hex(qrPayload.toByteArray(StandardCharsets.UTF_8))

fun signTixkitOfflineManifest(manifest: TixkitOfflineManifest, secret: String): String =
  hmacSha256Hex(secret, canonicalUnsignedManifestJson(manifest))

fun verifyTixkitOfflineManifest(manifest: TixkitOfflineManifest, secret: String, clock: Clock = Clock.systemUTC()): Boolean {
  if (manifest.expiresAt.isBefore(Instant.now(clock))) return false
  val expected = signTixkitOfflineManifest(manifest.copy(signature = ""), secret)
  return constantTimeEquals(expected, manifest.signature)
}

private val apiInstantFormatter = DateTimeFormatterBuilder().appendInstant(3).toFormatter()

fun canonicalUnsignedManifestJson(manifest: TixkitOfflineManifest): String {
  val tickets = manifest.tickets.joinToString(",", prefix = "[", postfix = "]") { ticket ->
    buildString {
      append("{")
      appendJsonField("ticketId", ticket.ticketId)
      append(",")
      appendJsonField("ticketTypeId", ticket.ticketTypeId ?: "")
      if (ticket.eventOccurrenceId != null) {
        append(",")
        appendJsonField("eventOccurrenceId", ticket.eventOccurrenceId)
      }
      append(",")
      appendJsonField("attendeeName", ticket.attendeeName ?: "")
      append(",")
      appendJsonField("qrHash", ticket.qrHash)
      append(",")
      appendJsonField("status", ticket.status)
      append("}")
    }
  }
  return buildString {
    append("{")
    appendJsonField("eventId", manifest.eventId)
    append(",")
    appendJsonField("checkInListId", manifest.checkInListId)
    append(",")
    appendJsonField("generatedAt", apiInstantFormatter.format(manifest.generatedAt))
    append(",")
    appendJsonField("expiresAt", apiInstantFormatter.format(manifest.expiresAt))
    append(",")
    appendJsonField("keyId", manifest.keyId)
    append(",")
    append("\"tickets\":")
    append(tickets)
    append("}")
  }
}

private fun hmacSha256Hex(secret: String, message: String): String {
  val mac = Mac.getInstance("HmacSHA256")
  mac.init(SecretKeySpec(secret.toByteArray(StandardCharsets.UTF_8), "HmacSHA256"))
  return mac.doFinal(message.toByteArray(StandardCharsets.UTF_8)).toHex()
}

private fun parsePage(json: JSONObject): TixkitPublicContentPage =
  TixkitPublicContentPage(
    document = parseDocument(json.getJSONObject("document")),
    version = parseVersion(json.getJSONObject("version")),
    page = parseEventPage(json.getJSONObject("page")),
  )

private fun parseDocument(json: JSONObject): TixkitPublicContentDocument =
  TixkitPublicContentDocument(
    eventId = json.optString("eventId"),
    channel = json.optString("channel"),
    key = json.optString("key"),
    name = json.optString("name"),
    locale = json.optString("locale"),
    updatedAt = json.optString("updatedAt"),
  )

private fun parseVersion(json: JSONObject): TixkitPublicContentVersion =
  TixkitPublicContentVersion(
    versionNumber = json.optInt("versionNumber"),
    subject = json.optNullableString("subject"),
    previewText = json.optNullableString("previewText"),
    publishedAt = json.optNullableString("publishedAt"),
  )

private fun parseEventPage(json: JSONObject): TixkitPublicEventPage =
  TixkitPublicEventPage(
    provider = json.optString("provider"),
    puckData = parsePuckData(json.getJSONObject("puckData")),
    settings = json.optJSONObject("settings").toAnyMap(),
    discovery = parseDiscovery(json.getJSONObject("discovery")),
  )

private fun parseEventPageDocument(json: JSONObject): TixkitEventPageDocumentV2 =
  TixkitEventPageDocumentV2(
    schemaVersion = json.optInt("schemaVersion"),
    editor = parseEventPageDocumentEditor(json.getJSONObject("editor")),
    settings = json.optJSONObject("settings").toAnyMap(),
  )

private fun parseEventPageDocumentEditor(json: JSONObject): TixkitEventPageDocumentEditor =
  TixkitEventPageDocumentEditor(
    provider = json.optString("provider"),
    data = parsePuckData(json.getJSONObject("data")),
  )

private fun parsePuckData(json: JSONObject): TixkitPuckData =
  TixkitPuckData(
    content = json.optJSONArray("content").toObjectList(::parsePuckComponentData),
    root = parsePuckRootData(json.optJSONObject("root") ?: JSONObject()),
    zones = json.optJSONObject("zones").toPuckZones(),
  )

private fun parsePuckRootData(json: JSONObject): TixkitPuckRootData =
  TixkitPuckRootData(props = json.optJSONObject("props").toAnyMap())

private fun parsePuckComponentData(json: JSONObject): TixkitPuckComponentData =
  TixkitPuckComponentData(
    type = json.optString("type"),
    props = json.optJSONObject("props").toAnyMap(),
  )

private fun parseDiscovery(json: JSONObject): TixkitPublicEventDiscoveryCard =
  TixkitPublicEventDiscoveryCard(
    title = json.optString("title"),
    summary = json.optString("summary"),
    tags = json.optJSONArray("tags").toStringList(),
    category = json.optNullableString("category"),
    imageUrl = json.optNullableString("imageUrl"),
    startsAt = json.optNullableString("startsAt"),
    venueName = json.optNullableString("venueName"),
    publicPath = json.optNullableString("publicPath"),
  )

private fun parseListingPage(json: JSONObject): TixkitTicketListingPage =
  TixkitTicketListingPage(
    items = json.optJSONArray("items").toObjectList(::parseListing),
    hasMore = json.optBoolean("hasMore", false),
    nextCursor = json.optNullableString("nextCursor"),
  )

private fun parsePublicListingPage(json: JSONObject): TixkitPublicTicketListingPage =
  TixkitPublicTicketListingPage(
    items = json.optJSONArray("items").toObjectList(::parsePublicListing),
    hasMore = json.optBoolean("hasMore", false),
    nextCursor = json.optNullableString("nextCursor"),
  )

private fun parsePublicListing(json: JSONObject): TixkitPublicTicketListing =
  TixkitPublicTicketListing(
    id = json.optString("id"),
    eventId = json.optString("eventId"),
    ticketTypeId = json.optNullableString("ticketTypeId"),
    ticketTypeName = json.optNullableString("ticketTypeName"),
    status = json.optString("status"),
    priceCents = json.optInt("priceCents"),
    currency = json.optString("currency"),
    faceValueCents = json.optInt("faceValueCents"),
    expiresAt = json.optNullableString("expiresAt"),
    createdAt = json.optNullableString("createdAt"),
    updatedAt = json.optNullableString("updatedAt"),
  )

private fun parseListing(json: JSONObject): TixkitTicketListing =
  TixkitTicketListing(
    id = json.optString("id"),
    eventId = json.optString("eventId"),
    ticketId = json.optString("ticketId"),
    sellerId = json.optNullableString("sellerId"),
    status = json.optString("status"),
    priceCents = json.optInt("priceCents"),
    currency = json.optString("currency"),
    faceValueCents = json.optNullableInt("faceValueCents"),
    soldToId = json.optNullableString("soldToId"),
  )

private fun parseResaleCompletion(json: JSONObject): TixkitResaleCompletion =
  TixkitResaleCompletion(
    listing = parseListing(json.getJSONObject("listing")),
    buyerTicketId = json.optJSONObject("buyerTicket")?.optNullableString("id"),
    buyerAttendeeId = json.optJSONObject("buyerAttendee")?.optNullableString("id"),
  )

private fun JSONObject.putOptional(key: String, value: String?): JSONObject =
  if (value == null) this else put(key, value)

private fun JSONObject.optNullableString(key: String): String? =
  if (has(key) && !isNull(key)) optString(key) else null

private fun JSONObject.optNullableInt(key: String): Int? =
  if (has(key) && !isNull(key)) optInt(key) else null

private fun <T> JSONArray?.toObjectList(mapper: (JSONObject) -> T): List<T> {
  if (this == null) return emptyList()
  return List(length()) { index -> mapper(getJSONObject(index)) }
}

private fun JSONArray?.toStringList(): List<String> {
  if (this == null) return emptyList()
  return List(length()) { index -> getString(index) }
}

private fun JSONArray?.toAnyList(): List<Any?> {
  if (this == null) return emptyList()
  return List(length()) { index -> jsonValueAt(index) }
}

private fun JSONObject?.toAnyMap(): Map<String, Any?> {
  if (this == null) return emptyMap()
  return keys().asSequence().associateWith { key -> jsonValue(key) }
}

private fun JSONObject?.toPuckZones(): Map<String, List<TixkitPuckComponentData>> {
  if (this == null) return emptyMap()
  return keys().asSequence().associateWith { key -> optJSONArray(key).toObjectList(::parsePuckComponentData) }
}

private fun JSONObject.jsonValue(key: String): Any? {
  if (isNull(key)) return null
  return when (val value = get(key)) {
    is JSONObject -> value.toAnyMap()
    is JSONArray -> value.toAnyList()
    else -> value
  }
}

private fun JSONArray.jsonValueAt(index: Int): Any? {
  if (isNull(index)) return null
  return when (val value = get(index)) {
    is JSONObject -> value.toAnyMap()
    is JSONArray -> value.toAnyList()
    else -> value
  }
}

private fun sha256Hex(bytes: ByteArray): String =
  MessageDigest.getInstance("SHA-256").digest(bytes).toHex()

private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }

private fun constantTimeEquals(left: String, right: String): Boolean {
  val leftBytes = left.toByteArray(StandardCharsets.UTF_8)
  val rightBytes = right.toByteArray(StandardCharsets.UTF_8)
  return MessageDigest.isEqual(leftBytes, rightBytes)
}

private fun encode(value: String): String =
  URLEncoder.encode(value, StandardCharsets.UTF_8.toString()).replace("+", "%20")

private fun base64UrlEncode(value: String): String =
  java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(value.toByteArray(StandardCharsets.UTF_8))

private fun base64UrlDecode(value: String): String =
  String(java.util.Base64.getUrlDecoder().decode(value), StandardCharsets.UTF_8)

private fun StringBuilder.appendJsonField(key: String, value: String) {
  append("\"")
  append(escapeJson(key))
  append("\":\"")
  append(escapeJson(value))
  append("\"")
}

private fun escapeJson(value: String): String = buildString {
  value.forEach { char ->
    when (char) {
      '\\' -> append("\\\\")
      '"' -> append("\\\"")
      '\b' -> append("\\b")
      '\u000C' -> append("\\f")
      '\n' -> append("\\n")
      '\r' -> append("\\r")
      '\t' -> append("\\t")
      else -> {
        if (char.code < 0x20) append("\\u%04x".format(char.code)) else append(char)
      }
    }
  }
}
