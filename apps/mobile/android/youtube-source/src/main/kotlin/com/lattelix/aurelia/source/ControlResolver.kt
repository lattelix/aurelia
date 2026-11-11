package com.lattelix.aurelia.source

import com.metrolist.innertubex.InnerTube
import com.metrolist.innertubex.InnerTubeLogger
import com.metrolist.innertubex.cipher.PlayerConfigRepository
import com.metrolist.innertubex.cipher.RemotePlayerConfigStore
import com.metrolist.innertubex.cipher.YouTubeCipherService
import com.metrolist.innertubex.extraction.AudioQuality
import com.metrolist.innertubex.extraction.ContentHints
import com.metrolist.innertubex.extraction.InnerTubeExtractor
import com.metrolist.innertubex.extraction.YtConfigParserImpl
import io.ktor.client.HttpClient
import io.ktor.client.engine.android.Android
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.plugins.defaultRequest
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.contentType
import io.ktor.serialization.kotlinx.json.json
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import java.net.CookieHandler
import java.util.Locale

/** One finite metadata-only attempt, exclusively inside the private resolver process. */
internal class ControlResolver {
    companion object {
        internal fun <T : Any> requireExtractedSource(source: T?): T =
            source ?: throw SourceFailure("CONTROL_SOURCE_UNAVAILABLE")
    }

    @Volatile private var engine: ControlPlaneEngine? = null
    fun abort() { engine?.abort() }
    suspend fun resolve(videoId: String): NativeSourceLease = withTimeout(SourcePolicy.RESOLUTION_MS) {
        SourcePolicy.validateVideoId(videoId)
        if (CookieHandler.getDefault() != null) throw SourceFailure("AMBIENT_COOKIE_HANDLER")
        val budget = ControlBudget()
        val guarded = ControlPlaneEngine(Android.create {
            connectTimeout = 10_000; socketTimeout = 10_000
            requestConfig = {
                instanceFollowRedirects = false; useCaches = false
                connectTimeout = 10_000; readTimeout = 10_000
                setRequestProperty("Accept-Encoding", "identity")
            }
        }, budget)
        engine = guarded
        val client = HttpClient(guarded) {
            expectSuccess = false; followRedirects = false
            install(HttpTimeout) { requestTimeoutMillis = 30_000; connectTimeoutMillis = 10_000; socketTimeoutMillis = 10_000 }
            install(ContentNegotiation) { json(Json { ignoreUnknownKeys = true; explicitNulls = false; encodeDefaults = true }) }
            defaultRequest { contentType(ContentType.Application.Json); headers.append(HttpHeaders.AcceptEncoding, "identity") }
        }
        // Explicit no-op logger: upstream messages/details may contain native source values.
        val logger = InnerTubeLogger { _ -> }
        val innerTube = InnerTube(httpClient = client, logger = logger)
        try {
            val store = RemotePlayerConfigStore(httpClient = client, repository = PlayerConfigRepository.disabled(), logger = logger)
            val cipher = YouTubeCipherService(httpClient = client, remotePlayerConfigStore = store, logger = logger)
            val extractor = InnerTubeExtractor(
                configParser = YtConfigParserImpl(httpClient = client, innerTube = innerTube,
                    remotePlayerConfigStore = store, cipherService = cipher, logger = logger),
                cipherService = cipher, innerTube = innerTube, logger = logger,
            )
            // No startup work, prewarm, token provider, credentials or unrelated fixture.
            val selected = requireExtractedSource(extractor.extract(videoId = videoId, hints = ContentHints(wantVideo = false)
                .withStreamCapabilities(allowHls = false, allowSabr = false, allowBoundedRange = false),
                audioQuality = AudioQuality.HIGH))
            if (selected.videoUrl != null || selected.sabrBootstrap != null || selected.sabrVideoBootstrap != null ||
                selected.requireBoundedRange || selected.useRangeChunks) throw SourceFailure("FORMAT_UNSUPPORTED")
            val url = SourcePolicy.validateMediaUrl(selected.audioUrl)
            val expiry = url.queryParameter("expire")?.toLongOrNull() ?: throw SourceFailure("SOURCE_EXPIRED")
            if (expiry <= 0 || expiry > Long.MAX_VALUE / 1000) throw SourceFailure("SOURCE_EXPIRED")
            val lease = NativeSourceLease(selected.videoId, selected.audioUrl,
                SourcePolicy.anonymousHeaders(selected.headers.entries.map { it.key to it.value }).toMap(),
                selected.mimeType?.substringBefore(';')?.lowercase(Locale.ROOT) ?: "",
                selected.itag, selected.contentLengthBytes ?: throw SourceFailure("LENGTH_UNKNOWN"), expiry * 1000)
            SourcePolicy.validateLease(lease, videoId)
            lease
        } finally {
            // The service retains its hard process deadline until all cleanup returns.
            innerTube.close(); client.close(); guarded.abort()
            engine = null
        }
    }
}
