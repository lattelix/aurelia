package com.lattelix.aurelia.source

import android.net.Uri
import androidx.media3.common.C
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.TransferListener
import androidx.media3.datasource.okhttp.OkHttpDataSource
import okhttp3.Authenticator
import okhttp3.Call
import okhttp3.CookieJar
import okhttp3.OkHttpClient
import okhttp3.Request
import java.net.Proxy
import java.util.Locale
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/** One native queue entry. Every open has its own cancellation and network resources. */
internal class StreamingYouTubeDataSource(
    private val videoId: String,
    private val syntheticUri: Uri,
    private val factoryCancellation: CancellationToken,
    private val resolver: (String, CancellationToken) -> NativeSourceLease,
    private val dispatchCleanup: (() -> Unit) -> Unit,
) : DataSource {
    private val lock = Any()
    private val listeners = CopyOnWriteArrayList<TransferListener>()
    private var current: Opening? = null
    private var lease: NativeSourceLease? = null
    private var strongEtag: String? = null

    init { SourcePolicy.validateVideoId(videoId) }

    override fun addTransferListener(transferListener: TransferListener) {
        listeners.addIfAbsent(transferListener)
    }

    override fun open(dataSpec: DataSpec): Long {
        factoryCancellation.check()
        if (dataSpec.uri != syntheticUri || dataSpec.httpMethod != DataSpec.HTTP_METHOD_GET ||
            dataSpec.httpBody != null || dataSpec.isFlagSet(DataSpec.FLAG_ALLOW_GZIP))
            throw SourceFailure("INVALID_REQUEST")
        val opening = synchronized(lock) {
            factoryCancellation.check()
            if (current != null) throw SourceFailure("SOURCE_BUSY")
            Opening(dataSpec).also { current = it }
        }
        try {
            opening.cancellationRegistration = opening.token.onCancel { opening.cleanup() }
            opening.check()
            listeners.forEach { it.onTransferInitializing(this, dataSpec, true) }
            val selected = selectLease(opening)
            val priorEtag = synchronized(lock) { strongEtag }
            val extraHeaders = StreamingPolicy.requestHeaders(dataSpec.httpRequestHeaders, priorEtag)
            val plan = StreamingPolicy.range(selected.contentLength, dataSpec.position, dataSpec.length)
            opening.expectedBytes = plan.length
            if (plan.length == 0L) {
                opening.startTransfer()
                return 0
            }
            val redirects = StreamingRedirectPolicy(selected, videoId, opening::check)
            val fixedHeaders = selected.headers.entries.associate { it.key.lowercase(Locale.ROOT) to it.value }
                .filterKeys { it != "accept-encoding" } +
                mapOf("user-agent" to (selected.headers.entries.firstOrNull {
                    it.key.equals("user-agent", true)
                }?.value ?: "AureliaNativeSource/1.0"))
            val http = opening.createClient {
                redirects.client(fixedHeaders, plan, extraHeaders["If-Range"], priorEtag,
                    finalResponse = { validated ->
                        synchronized(lock) {
                            opening.check()
                            if (validated.strongEtag != null) strongEtag = validated.strongEtag
                            opening.responseHeaders = validated.headers
                        }
                    }, failed = { call, response, error ->
                        opening.failure.compareAndSet(null, failureCode(error, "NETWORK_TRANSPORT_FAILURE"))
                        // OkHttpDataSource enqueues calls. This is its network worker, never Main.
                        // Cancel before close so neither rejection nor cleanup drains an error body.
                        try { call.cancel() } catch (_: Exception) { }
                        try { response?.close() } catch (_: Exception) { }
                        opening.cleanup()
                        throw SourceFailure(opening.failure.get() ?: "IO_FAILURE")
                    })
            }
            val callFactory = object : Call.Factory {
                override fun newCall(request: Request): Call {
                    return opening.createCall { http.newCall(request) }
                }
            }
            val delegate = opening.createDelegate { OkHttpDataSource.Factory(callFactory)
                .setDefaultRequestProperties(fixedHeaders).createDataSource() }
            val nativeSpec = dataSpec.buildUpon().setUri(selected.audioUrl)
                .setHttpRequestHeaders(extraHeaders).build()
            val opened = delegate.open(nativeSpec)
            opening.check()
            if (opened != plan.length) throw SourceFailure("RANGE_INVALID")
            opening.startTransfer()
            return opened
        } catch (error: Exception) {
            val code = opening.failureCode(error, "NETWORK_TRANSPORT_FAILURE")
            abandon(opening)
            throw SourceFailure(code)
        } finally {
            opening.openFinished.countDown()
        }
    }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        if (offset < 0 || length < 0 || offset > buffer.size - length)
            throw SourceFailure("INVALID_REQUEST")
        if (length == 0) return 0
        val opening = synchronized(lock) { current } ?: throw SourceFailure("CANCELLED")
        try {
            opening.check()
            if (opening.readBytes == opening.expectedBytes) return C.RESULT_END_OF_INPUT
            val delegate = opening.delegate.get() ?: throw SourceFailure("MEDIA_DELEGATE_UNAVAILABLE")
            val count = delegate.read(buffer, offset, minOf(length.toLong(),
                opening.expectedBytes - opening.readBytes).toInt())
            opening.check()
            if (count == C.RESULT_END_OF_INPUT) throw SourceFailure("NETWORK_BODY_FAILURE")
            if (count > 0) {
                opening.readBytes += count
                synchronized(opening.transferLock) {
                    opening.check()
                    listeners.forEach { it.onBytesTransferred(this, opening.original, true, count) }
                }
            }
            return count
        } catch (error: Exception) {
            val code = opening.failureCode(error, "NETWORK_BODY_FAILURE")
            abandon(opening)
            throw SourceFailure(code)
        }
    }

    override fun getUri(): Uri = syntheticUri

    override fun getResponseHeaders(): Map<String, List<String>> =
        synchronized(lock) { current?.responseHeaders ?: emptyMap() }

    override fun close() {
        val opening = synchronized(lock) { current.also { current = null } } ?: return
        opening.token.cancel()
        opening.unregister()
        opening.endTransfer()
    }

    private fun selectLease(opening: Opening): NativeSourceLease {
        var selected = synchronized(lock) { lease }
        if (selected == null) selected = resolver(videoId, opening.token).also { opening.check() }
        SourcePolicy.validateLease(selected, videoId, requireFresh = false)
        if (selected.expired()) {
            val previous = selected
            selected = resolver(videoId, opening.token).also { opening.check() }
            SourcePolicy.validateLease(selected, videoId)
            StreamingPolicy.requireSameStream(previous, selected)
        } else SourcePolicy.validateLease(selected, videoId)
        synchronized(lock) {
            opening.check()
            lease = selected
        }
        return selected
    }

    private fun abandon(opening: Opening) {
        synchronized(lock) { if (current === opening) current = null }
        opening.token.cancel()
        opening.unregister()
        opening.endTransfer()
    }

    private inner class Opening(val original: DataSpec) {
        private val cancellation = StreamingOpenCancellation(factoryCancellation)
        val token = cancellation.token
        val failure = AtomicReference<String?>()
        val call = AtomicReference<Call?>()
        val delegate = AtomicReference<DataSource?>()
        val client = AtomicReference<OkHttpClient?>()
        private val resourceLock = Any()
        val transferLock = Any()
        val openFinished = CountDownLatch(1)
        private val started = AtomicBoolean(false)
        private val ended = AtomicBoolean(false)
        var cancellationRegistration: AutoCloseable? = null
        @Volatile var responseHeaders: Map<String, List<String>> = emptyMap()
        var expectedBytes = 0L
        var readBytes = 0L

        fun check() {
            factoryCancellation.check()
            token.check()
            synchronized(lock) { if (current !== this) throw SourceFailure("CANCELLED") }
        }

        fun createClient(create: () -> OkHttpClient): OkHttpClient = attach(client, create)
        fun createCall(create: () -> Call): Call = attach(call, create)
        fun createDelegate(create: () -> DataSource): DataSource = attach(delegate, create)

        private fun <T : Any> attach(reference: AtomicReference<T?>, create: () -> T): T =
            synchronized(resourceLock) {
                check()
                create().also { reference.set(it); check() }
            }

        fun startTransfer() = synchronized(transferLock) {
            check()
            started.set(true)
            listeners.forEach { it.onTransferStart(this@StreamingYouTubeDataSource, original, true) }
        }

        fun endTransfer() = synchronized(transferLock) {
            if (started.get() && ended.compareAndSet(false, true)) {
                // Listener failures must not prevent network-resource cleanup or a later seek.
                listeners.forEach { try { it.onTransferEnd(this@StreamingYouTubeDataSource, original, true) }
                    catch (_: Exception) { } }
            }
        }

        fun unregister() {
            cancellationRegistration?.close()
            cancellation.close()
        }

        fun failureCode(error: Exception, fallback: String): String =
            if (token.isCancelled() || factoryCancellation.isCancelled()) "CANCELLED"
            else failure.get() ?: this@StreamingYouTubeDataSource.failureCode(error, fallback)

        fun cleanup() = synchronized(resourceLock) {
            // Register resources and submit cleanup under one lock. Factory cancel() then shutdown()
            // can drain deterministically; no resource can attach after its cancellation callback.
            val oldCall = call.getAndSet(null)
            val oldDelegate = delegate.getAndSet(null)
            val oldClient = client.getAndSet(null)
            if (oldCall != null || oldDelegate != null || oldClient != null) {
                dispatchCleanup {
                    try { oldCall?.cancel() } catch (_: Exception) { }
                    // Cancellation may race with delegate.open assigning its Response. Wait only on
                    // the cleanup worker, after cancelling the call, then close that final response.
                    var interrupted = false
                    while (true) {
                        try { openFinished.await(); break }
                        catch (_: InterruptedException) { interrupted = true }
                    }
                    try { oldDelegate?.close() } catch (_: Exception) { }
                    try { oldClient?.connectionPool?.evictAll() } catch (_: Exception) { }
                    try { oldClient?.dispatcher?.executorService?.shutdown() } catch (_: Exception) { }
                    if (interrupted) Thread.currentThread().interrupt()
                }
            }
        }
    }

    private fun failureCode(error: Exception, fallback: String): String =
        if (error is SourceFailure) error.code else fallback
}

/** Closing a load never permanently cancels the queue's factory token. */
internal class StreamingOpenCancellation(factory: CancellationToken) : AutoCloseable {
    val token = CancellationToken()
    private val registration = factory.onCancel { token.cancel() }
    override fun close() {
        token.cancel()
        registration.close()
    }
}

/** Pure protocol checks; no Android or network access is needed to exercise these seams. */
internal object StreamingPolicy {
    // OkHttp uses its explicit CookieJar, not Capacitor's global java.net.CookieHandler.
    fun anonymousClientBuilder(): OkHttpClient.Builder = OkHttpClient.Builder()
        .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false)
        .cookieJar(CookieJar.NO_COOKIES).authenticator(Authenticator.NONE)
        .proxyAuthenticator(Authenticator.NONE).proxy(Proxy.NO_PROXY).cache(null)
        .connectTimeout(10, TimeUnit.SECONDS).readTimeout(20, TimeUnit.SECONDS)
        .writeTimeout(20, TimeUnit.SECONDS).callTimeout(0, TimeUnit.MILLISECONDS)

    data class Range(val start: Long, val end: Long, val length: Long, val rangeHeader: String?)
    data class ValidatedResponse(val headers: Map<String, List<String>>, val strongEtag: String?)

    fun range(total: Long, position: Long, length: Long): Range {
        if (total <= 0 || position < 0 || position > total || (length != -1L && length <= 0) ||
            (length != -1L && length > total - position)) throw SourceFailure("RANGE_INVALID")
        val count = if (length == -1L) total - position else length
        val header = when {
            position == 0L && length == -1L -> null
            length == -1L -> "bytes=$position-"
            else -> "bytes=$position-${position + count - 1}"
        }
        return Range(position, position + count - 1, count, header)
    }

    fun requestHeaders(headers: Map<String, String>, priorStrongEtag: String?): Map<String, String> {
        val result = LinkedHashMap<String, String>()
        val seen = HashSet<String>()
        for ((name, value) in headers) {
            if (!seen.add(name.lowercase(Locale.ROOT))) throw SourceFailure("HEADER_POLICY")
            when {
                name.equals("Icy-MetaData", true) && value == "1" -> Unit
                name.equals("If-Range", true) && strongTag(priorStrongEtag) != null && value == priorStrongEtag ->
                    result["If-Range"] = value
                else -> throw SourceFailure("HEADER_POLICY")
            }
        }
        return result
    }

    fun validateOutgoing(headers: List<Pair<String, String>>, fixed: Map<String, String>, host: String,
        range: String?, ifRange: String?) {
        SourcePolicy.validateNoCredentials(headers)
        val seen = HashSet<String>()
        for ((raw, value) in headers) {
            val name = raw.lowercase(Locale.ROOT)
            if (!seen.add(name)) throw SourceFailure("HEADER_POLICY")
            val valid = when (name) {
                "host" -> value == host
                "connection" -> value.equals("Keep-Alive", true)
                "accept-encoding" -> value == "identity"
                "range" -> range != null && value == range
                "if-range" -> ifRange != null && value == ifRange
                else -> fixed[name] == value
            }
            if (!valid) throw SourceFailure("HEADER_POLICY")
        }
        if (!seen.containsAll(fixed.keys) || "host" !in seen || "accept-encoding" !in seen ||
            (range != null && "range" !in seen) || (ifRange != null && "if-range" !in seen))
            throw SourceFailure("HEADER_POLICY")
    }

    fun response(status: Int, headers: Map<String, List<String>>, mime: String, total: Long,
        range: Range, priorStrongEtag: String?): ValidatedResponse {
        when (status) {
            401 -> throw SourceFailure("ACCESS_401")
            403 -> throw SourceFailure("ACCESS_403")
            429 -> throw SourceFailure("ACCESS_429")
            in 300..399 -> throw SourceFailure("MEDIA_REDIRECT_UNSUPPORTED")
            416 -> throw SourceFailure("RANGE_INVALID")
            200 -> if (range.rangeHeader != null) throw SourceFailure("RANGE_UNSUPPORTED")
            206 -> Unit
            400 -> throw SourceFailure("MEDIA_HTTP_400")
            404 -> throw SourceFailure("MEDIA_HTTP_404")
            410 -> throw SourceFailure("MEDIA_HTTP_410")
            500 -> throw SourceFailure("MEDIA_HTTP_500")
            502 -> throw SourceFailure("MEDIA_HTTP_502")
            503 -> throw SourceFailure("MEDIA_HTTP_503")
            504 -> throw SourceFailure("MEDIA_HTTP_504")
            else -> throw SourceFailure("MEDIA_HTTP_OTHER")
        }
        fun single(name: String): String? {
            val values = headers.entries.filter { it.key.equals(name, true) }.flatMap { it.value }
            if (values.size > 1 || values.any { it.length > 4096 || it.any { c -> c == '\r' || c == '\n' } })
                throw SourceFailure("HEADER_POLICY")
            return values.singleOrNull()
        }
        val encoding = single("Content-Encoding")
        if (encoding != null && !encoding.equals("identity", true)) throw SourceFailure("CONTENT_ENCODING_UNSUPPORTED")
        if (single("Transfer-Encoding") != null) throw SourceFailure("HEADER_POLICY")
        val lengthText = single("Content-Length") ?: throw SourceFailure("LENGTH_UNKNOWN")
        if (!lengthText.matches(Regex("^[0-9]+$")) || lengthText.toLongOrNull() != range.length)
            throw SourceFailure("RANGE_INVALID")
        val type = single("Content-Type")?.substringBefore(';')?.trim()?.lowercase(Locale.ROOT)
        if (type != mime) throw SourceFailure("FORMAT_UNSUPPORTED")
        val contentRange = single("Content-Range")
        if (status == 206) {
            val parts = contentRange?.let { Regex("^bytes ([0-9]+)-([0-9]+)/([0-9]+)$").matchEntire(it) }
                ?: throw SourceFailure("RANGE_INVALID")
            if (parts.groupValues[1].toLongOrNull() != range.start ||
                parts.groupValues[2].toLongOrNull() != range.end || parts.groupValues[3].toLongOrNull() != total)
                throw SourceFailure("RANGE_INVALID")
        } else if (contentRange != null) throw SourceFailure("RANGE_INVALID")
        val etag = strongTag(single("ETag"))
        if (priorStrongEtag != null && etag != priorStrongEtag)
            throw SourceFailure("SOURCE_IDENTITY_MISMATCH")
        val safe = linkedMapOf("Content-Length" to listOf(range.length.toString()), "Content-Type" to listOf(mime))
        if (contentRange != null) safe["Content-Range"] = listOf(contentRange)
        if (etag != null) safe["ETag"] = listOf(etag)
        if (single("Accept-Ranges") == "bytes") safe["Accept-Ranges"] = listOf("bytes")
        return ValidatedResponse(safe.toMap(), etag)
    }

    fun requireSameStream(previous: NativeSourceLease, renewed: NativeSourceLease) {
        if (previous.videoId != renewed.videoId || previous.itag != renewed.itag ||
            previous.mimeType != renewed.mimeType || previous.contentLength != renewed.contentLength)
            throw SourceFailure("SOURCE_IDENTITY_MISMATCH")
    }

    private fun strongTag(value: String?): String? = value?.takeIf {
        it.length in 2..1024 && it.first() == '"' && it.last() == '"' &&
            it.substring(1, it.length - 1).all { c -> c.code in 0x21..0x7e && c != '"' }
    }
}
