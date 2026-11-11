package com.lattelix.aurelia.source

import android.content.Context
import android.net.Uri
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.exoplayer.source.MediaSource
import androidx.media3.exoplayer.source.ProgressiveMediaSource
import androidx.media3.exoplayer.upstream.DefaultLoadErrorHandlingPolicy
import androidx.media3.exoplayer.upstream.LoadErrorHandlingPolicy
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/** One queue owns one factory. Construction/create are nonnetwork and never initiate playback. */
@UnstableApi
class AndroidYouTubeSourceFactory(context: Context) : AutoCloseable {
    companion object {
        /** Java-callable safe diagnostic only; never changes source/retry behavior. */
        @JvmStatic
        fun diagnosticFailureCode(error: Throwable?): String = SourceFailureDiagnostics.code(error)
    }

    private val closed = AtomicBoolean(false)
    private val cancellation = CancellationToken()
    private val resolver = ResolverClient(context)
    private val cleanup = Executors.newSingleThreadExecutor { Thread(it, "AureliaQueueSourceCleanup").apply { isDaemon = true } }

    fun create(item: MediaItem, videoId: String): MediaSource {
        if (closed.get() || cancellation.isCancelled()) throw IllegalStateException("source-unavailable")
        try { SourcePolicy.validateVideoId(videoId) }
        catch (_: SourceFailure) { throw IllegalArgumentException("invalid-request") }
        val synthetic = Uri.parse("aurelia-youtube://track/$videoId")
        if (item.localConfiguration?.uri != synthetic) throw IllegalArgumentException("invalid-request")
        val noRetry = object : DefaultLoadErrorHandlingPolicy(0) {
            override fun getRetryDelayMsFor(info: LoadErrorHandlingPolicy.LoadErrorInfo): Long = C.TIME_UNSET
            override fun getMinimumLoadableRetryCount(dataType: Int): Int = 0
        }
        return ProgressiveMediaSource.Factory(DataSource.Factory {
            StreamingYouTubeDataSource(videoId, synthetic, cancellation, resolver::resolve) { action ->
                // Open scopes register resources atomically with cancellation before this executor closes.
                cleanup.execute { try { action() } catch (_: Exception) { } }
            }
        }).setLoadErrorHandlingPolicy(noRetry)
            .createMediaSource(item.buildUpon().setUri(synthetic).build())
    }

    fun cancelAll() {
        cancellation.cancel()
        resolver.cancelAll()
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        cancelAll()
        resolver.close()
        // Drain all cancellation-enqueued socket work; never interrupt/close sockets on Main.
        cleanup.shutdown()
    }
}
