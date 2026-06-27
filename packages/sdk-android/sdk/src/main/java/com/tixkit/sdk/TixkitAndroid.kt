package com.tixkit.sdk

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.view.View
import android.widget.LinearLayout
import android.widget.TextView
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import java.security.MessageDigest
import java.time.Clock
import java.time.Instant
import java.time.format.DateTimeFormatter
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.Mac
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

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
  val attendeeEmail: String? = null,
  val promoCode: String? = null,
  val tracking: String? = null,
)

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
    val acceptedOrDuplicate = result.results
      .filter { it["outcome"] == TixkitScanOutcome.ACCEPTED.wireValue || it["outcome"] == TixkitScanOutcome.DUPLICATE.wireValue }
      .mapNotNull { it["qrHash"] }
      .toSet()
    result.results
      .filter { it["outcome"] == TixkitScanOutcome.DUPLICATE.wireValue || it["outcome"] == TixkitScanOutcome.INVALID.wireValue }
      .forEach { item ->
        val qrHash = item["qrHash"]
        val outcome = item["outcome"]
        if (qrHash != null && outcome != null) onConflict?.invoke(qrHash, outcome)
      }
    offlineScans.removeAll(acceptedOrDuplicate)
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
  const val API_VERSION = "2026-01-01"

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

fun canonicalUnsignedManifestJson(manifest: TixkitOfflineManifest): String {
  val tickets = manifest.tickets.sortedBy { it.ticketId }.joinToString(",", prefix = "[", postfix = "]") { ticket ->
    buildString {
      append("{")
      appendJsonField("attendeeName", ticket.attendeeName ?: "")
      append(",")
      appendJsonField("qrHash", ticket.qrHash)
      append(",")
      appendJsonField("status", ticket.status)
      append(",")
      appendJsonField("ticketId", ticket.ticketId)
      append(",")
      appendJsonField("ticketTypeId", ticket.ticketTypeId ?: "")
      append("}")
    }
  }
  return buildString {
    append("{")
    appendJsonField("checkInListId", manifest.checkInListId)
    append(",")
    appendJsonField("eventId", manifest.eventId)
    append(",")
    appendJsonField("expiresAt", DateTimeFormatter.ISO_INSTANT.format(manifest.expiresAt))
    append(",")
    appendJsonField("generatedAt", DateTimeFormatter.ISO_INSTANT.format(manifest.generatedAt))
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
