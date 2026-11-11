package com.lattelix.aurelia.source

import io.ktor.http.Url
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.io.IOException
import java.util.Locale

internal class SourceFailure(code: String) : IOException(SourcePolicy.safeFailureCode(code)) {
    val code: String = SourcePolicy.safeFailureCode(code)
}

internal object SourcePolicy {
    const val BYTE_CAP = 20L * 1024 * 1024
    const val CONTROL_BODY_CAP = 8L * 1024 * 1024
    const val REQUEST_CAP = 32
    const val RESOLUTION_MS = 45_000L
    const val HARD_RESOLUTION_MS = 55_000L
    private val videoId = Regex("^[A-Za-z0-9_-]{11}$")
    private val errors = setOf(
        "CANCELLED", "SOURCE_EXPIRED", "SOURCE_IDENTITY_MISMATCH", "HEADER_POLICY", "RANGE_UNSUPPORTED",
        "RANGE_INVALID", "ACCESS_DENIED", "RATE_LIMITED", "NETWORK", "IO_FAILURE", "INVALID_REQUEST",
        "SOURCE_UNAVAILABLE", "SOURCE_BUSY", "RESOLUTION_TIMEOUT", "CONTROL_LIMIT", "HOST_POLICY",
        "CONTROL_SOURCE_UNAVAILABLE", "MEDIA_HTTP_400", "MEDIA_HTTP_404", "MEDIA_HTTP_410",
        "MEDIA_HTTP_500", "MEDIA_HTTP_502", "MEDIA_HTTP_503", "MEDIA_HTTP_504", "MEDIA_HTTP_OTHER",
        "RESOLVER_BIND_REJECTED", "RESOLVER_BIND_SECURITY", "RESOLVER_BIND_STATE", "RESOLVER_BIND_FAILURE",
        "MEDIA_DELEGATE_UNAVAILABLE",
        "FORMAT_UNSUPPORTED", "CONTENT_ENCODING_UNSUPPORTED", "BODY_BYTE_CAP", "REQUEST_CAP",
        "RESPONSE_BODY_CAP", "REDIRECT_UNSUPPORTED", "CONTROL_REDIRECT_UNSUPPORTED", "MEDIA_REDIRECT_UNSUPPORTED",
        "AMBIENT_COOKIE_HANDLER", "NETWORK_BODY_FAILURE",
        "NETWORK_TRANSPORT_FAILURE", "METHOD_POLICY", "BODY_TYPE_UNSUPPORTED", "LENGTH_UNKNOWN",
        "SOURCE_PROCESS_DIED", "IPC_FAILURE", "MEDIA_LENGTH_INVALID", "SOURCE_UNVERIFIED",
        "ACCESS_401", "ACCESS_403", "ACCESS_429",
    )
    fun safeFailureCode(code: String): String = code.takeIf { it in errors } ?: "IO_FAILURE"
    fun ownsResolverProcess(uid: Int, applicationUid: Int, processName: String?, packageName: String): Boolean =
        uid == applicationUid && packageName.isNotBlank() && processName == "$packageName:youtube_source"
    fun validateVideoId(value: String) {
        if (!videoId.matches(value)) throw SourceFailure("INVALID_REQUEST")
    }
    fun validateControlUrl(url: Url) {
        val host = url.host.lowercase(Locale.ROOT)
        if (url.protocol.name != "https" || url.port != 443 || url.user != null || url.password != null ||
            url.fragment.isNotEmpty() || !(host == "youtube.com" || host.endsWith(".youtube.com") ||
                host == "googlevideo.com" || host.endsWith(".googlevideo.com") || host == "youtubei.googleapis.com"))
            throw SourceFailure("HOST_POLICY")
    }
    // Alias used by the already verified shared Ktor transport guard.
    fun validateUrl(url: Url) = validateControlUrl(url)
    fun validateMediaUrl(value: String): HttpUrl {
        if (value.length !in 1..16_384) throw SourceFailure("HOST_POLICY")
        val parsed = value.toHttpUrlOrNull() ?: throw SourceFailure("HOST_POLICY")
        validateControlUrl(Url(value))
        if (!(parsed.host == "googlevideo.com" || parsed.host.endsWith(".googlevideo.com") ||
                parsed.host == "youtube.com" || parsed.host.endsWith(".youtube.com")) ||
            parsed.encodedPath != "/videoplayback" || parsed.queryParameterNames.any { it.equals("range", true) })
            throw SourceFailure("HOST_POLICY")
        return parsed
    }
    fun anonymousHeaders(headers: Iterable<Pair<String, String>>): List<Pair<String, String>> =
        headers.filterNot { it.first.equals("cookie", true) }
    fun validateNoCredentials(headers: Iterable<Pair<String, String>>) {
        val denied = setOf("authorization", "proxy-authorization", "cookie", "x-youtube-identity-token", "x-goog-authuser")
        for ((name, value) in headers) {
            if (name.lowercase(Locale.ROOT) in denied || !name.matches(Regex("^[A-Za-z0-9-]{1,100}$")) ||
                value.length > 4096 || value.any { it == '\r' || it == '\n' }) throw SourceFailure("HEADER_POLICY")
        }
    }
    fun validateLease(lease: NativeSourceLease, expectedVideoId: String, requireFresh: Boolean = true) {
        validateVideoId(expectedVideoId)
        if (lease.videoId != expectedVideoId) throw SourceFailure("SOURCE_IDENTITY_MISMATCH")
        val url = validateMediaUrl(lease.audioUrl)
        if (lease.mimeType !in setOf("audio/mp4", "audio/webm") || lease.itag !in 1..100_000)
            throw SourceFailure("FORMAT_UNSUPPORTED")
        if (lease.contentLength <= 0) throw SourceFailure("MEDIA_LENGTH_INVALID")
        if (listOf("itag", "clen", "expire").any { url.queryParameterValues(it).size != 1 })
            throw SourceFailure("SOURCE_IDENTITY_MISMATCH")
        val expiry = url.queryParameter("expire")?.toLongOrNull() ?: throw SourceFailure("SOURCE_EXPIRED")
        if (expiry <= 0 || expiry > Long.MAX_VALUE / 1000 || expiry * 1000 != lease.expiresAtMs ||
            url.queryParameter("itag")?.toIntOrNull() != lease.itag ||
            url.queryParameter("clen")?.toLongOrNull() != lease.contentLength) throw SourceFailure("SOURCE_IDENTITY_MISMATCH")
        if (requireFresh && lease.expired()) throw SourceFailure("SOURCE_EXPIRED")
        validateNoCredentials(lease.headers.entries.map { it.key to it.value })
        val permitted = setOf("user-agent", "accept", "accept-language", "origin", "referer", "accept-encoding",
            "x-youtube-client-name", "x-youtube-client-version", "x-goog-visitor-id")
        if (lease.headers.size > 16 || lease.headers.keys.any { it.lowercase(Locale.ROOT) !in permitted } ||
            lease.headers.keys.map { it.lowercase(Locale.ROOT) }.distinct().size != lease.headers.size ||
            lease.headers.entries.any { it.key.equals("accept-encoding", true) && !it.value.equals("identity", true) })
            throw SourceFailure("HEADER_POLICY")
    }
}
