package com.lattelix.aurelia.source

import okhttp3.HttpUrl
import okhttp3.Call
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import java.net.URI

/** Per-opening CDN follow-up state. Locators never leave this native policy. */
internal class StreamingRedirectPolicy(
    private val lease: NativeSourceLease,
    private val expectedVideoId: String,
    private val check: () -> Unit = {},
) {
    private val initial = SourcePolicy.validateMediaUrl(lease.audioUrl)
    private var approved = initial
    private val visited = linkedSetOf(initial)
    private var hops = 0
    init { SourcePolicy.validateLease(lease, expectedVideoId) }

    /** Returns a finished client; redirect following is never exposed without its mandatory guard. */
    fun client(fixed: Map<String, String>, range: StreamingPolicy.Range, ifRange: String?,
        priorStrongEtag: String?, finalResponse: (StreamingPolicy.ValidatedResponse) -> Unit,
        failed: (Call, Response?, Exception) -> Nothing): OkHttpClient =
        StreamingPolicy.anonymousClientBuilder().followRedirects(true).followSslRedirects(false)
            .addNetworkInterceptor(Interceptor { chain ->
                var response: Response? = null
                try {
                    val request = chain.request()
                    validateOutgoing(request, fixed, range.rangeHeader, ifRange)
                    if (lease.expired()) throw SourceFailure("SOURCE_EXPIRED")
                    val incoming = chain.proceed(request)
                    response = incoming
                    check()
                    if (incoming.code in 300..399) {
                        approve(incoming.code, request.url, incoming.headers.values("Location"))
                        // OkHttp closes the intermediate body; the application never reads/forwards it.
                    } else finalResponse(StreamingPolicy.response(incoming.code, incoming.headers.toMultimap(),
                        lease.mimeType, lease.contentLength, range, priorStrongEtag))
                    incoming
                } catch (error: Exception) { failed(chain.call(), response, error) }
            }).build()

    @Synchronized fun validateRequest(url: HttpUrl) {
        check()
        if (url != approved) throw SourceFailure("HOST_POLICY")
    }

    fun validateOutgoing(request: Request, fixed: Map<String, String>, range: String?, ifRange: String?) {
        validateRequest(request.url)
        if (request.method != "GET" || request.body != null) throw SourceFailure("HOST_POLICY")
        StreamingPolicy.validateOutgoing(request.headers.toList(), fixed, request.url.host, range, ifRange)
    }

    @Synchronized fun approve(status: Int, from: HttpUrl, locations: List<String>): HttpUrl {
        validateRequest(from)
        if (status !in setOf(301, 302, 303, 307, 308) || hops >= 2 || locations.size != 1)
            throw SourceFailure("MEDIA_REDIRECT_UNSUPPORTED")
        val location = locations.single()
        if (location.isEmpty() || location.length > 16_384 || location != location.trim() ||
            location.any { it <= '\u0020' || it == '\u007f' })
            throw SourceFailure("MEDIA_REDIRECT_UNSUPPORTED")
        val parsed = try { URI(location) } catch (_: Exception) { throw SourceFailure("HOST_POLICY") }
        // Check before HttpUrl canonicalization can erase empty user-info or fragments.
        if (parsed.rawUserInfo != null || parsed.rawFragment != null)
            throw SourceFailure("HOST_POLICY")
        val target = from.resolve(location) ?: throw SourceFailure("HOST_POLICY")
        if (!target.isHttps || target.port != 443 || target.username.isNotEmpty() ||
            target.password.isNotEmpty() || target.fragment != null ||
            !(target.host == "googlevideo.com" || target.host.endsWith(".googlevideo.com")) ||
            target.encodedPath != "/videoplayback" || target.queryParameterNames.any { it.equals("range", true) })
            throw SourceFailure("HOST_POLICY")
        if (target in visited) throw SourceFailure("MEDIA_REDIRECT_UNSUPPORTED")
        // Copy only the locator; expiry/content/headers stay bound to the selected lease.
        if (identity(initial) != identity(target)) throw SourceFailure("SOURCE_IDENTITY_MISMATCH")
        SourcePolicy.validateLease(lease.copy(audioUrl = target.toString()), expectedVideoId)
        hops++
        visited.add(target)
        approved = target
        return target
    }

    private fun identity(url: HttpUrl): Map<String, String?> {
        val required = setOf("id", "itag", "clen", "expire")
        return (required + setOf("mime", "lmt", "source")).associateWith { key ->
            if (url.queryParameterNames.any { it.equals(key, true) && it != key })
                throw SourceFailure("SOURCE_IDENTITY_MISMATCH")
            val values = url.queryParameterValues(key)
            if (values.size > 1 || (key in required && values.size != 1) ||
                (values.size == 1 && values.single().isNullOrEmpty()))
                throw SourceFailure("SOURCE_IDENTITY_MISMATCH")
            values.singleOrNull()
        }
    }

    override fun toString(): String = "StreamingRedirectPolicy(redacted)"
}
