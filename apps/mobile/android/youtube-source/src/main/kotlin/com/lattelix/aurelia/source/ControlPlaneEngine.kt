package com.lattelix.aurelia.source

import io.ktor.client.engine.HttpClientEngine
import io.ktor.client.engine.HttpClientEngineBase
import io.ktor.client.engine.HttpClientEngineCapability
import io.ktor.client.engine.HttpClientEngineConfig
import io.ktor.client.request.HttpRequestData
import io.ktor.client.request.HttpResponseData
import io.ktor.http.Headers
import io.ktor.http.HttpHeaders
import io.ktor.utils.io.ByteReadChannel
import io.ktor.utils.io.InternalAPI
import io.ktor.utils.io.attachWriterJob
import io.ktor.utils.io.readAvailable
import io.ktor.utils.io.writeFully
import io.ktor.utils.io.writer
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.job
import java.net.CookieHandler

/** Engine-level policy also covers InnerTubeX's fresh child HttpClient(engine) instances. */
@OptIn(InternalAPI::class)
internal class ControlPlaneEngine(
    private val delegate: HttpClientEngine,
    private val budget: ControlBudget,
    private val traceChanged: () -> Unit = {},
) : HttpClientEngineBase("source-probe-budget") {
    override val config: HttpClientEngineConfig get() = delegate.config
    override val dispatcher: CoroutineDispatcher get() = delegate.dispatcher
    override val supportedCapabilities: Set<HttpClientEngineCapability<*>> get() = delegate.supportedCapabilities

    override suspend fun execute(data: HttpRequestData): HttpResponseData {
        budget.request()
        val host = data.url.host.lowercase()
        val hostCategory = when {
            host == "googlevideo.com" || host.endsWith(".googlevideo.com") -> "MEDIA"
            host == "youtubei.googleapis.com" -> "YOUTUBE_API"
            host == "youtube.com" || host.endsWith(".youtube.com") -> "YOUTUBE"
            else -> "OTHER"
        }
        val pathKind = when {
            data.url.encodedPath == "/robots.txt" -> "ROBOTS"
            data.url.encodedPath == "/videoplayback" -> "MEDIA"
            data.url.encodedPath.endsWith("/youtubei/v1/player") -> "PLAYER_API"
            data.url.encodedPath.startsWith("/youtubei/v1/") -> "INNERTUBE_API"
            data.url.encodedPath.startsWith("/s/player/") -> "PLAYER_JS"
            data.url.encodedPath == "/watch" -> "WATCH"
            data.url.encodedPath == "/iframe_api" -> "IFRAME_API"
            data.url.encodedPath == "/" -> "ROOT"
            else -> "OTHER"
        }
        val method = data.method.value.takeIf { it in setOf("GET", "POST", "HEAD") } ?: "OTHER"
        val attempt = budget.beginAttempt(method, hostCategory, pathKind)
        fun publish() { try { traceChanged() } catch (_: Exception) { /* Never replace the transport failure. */ } }
        publish()
        val outgoing = try {
            SourcePolicy.validateUrl(data.url)
            if (CookieHandler.getDefault() != null) throw SourceFailure("AMBIENT_COOKIE_HANDLER")
            val headers = SourcePolicy.anonymousHeaders(
                data.headers.entries().flatMap { (name, values) -> values.map { name to it } },
            )
            SourcePolicy.validateNoCredentials(headers)
            // Android merges body-owned headers too; reject credentials there while preserving the original body.
            SourcePolicy.validateNoCredentials(data.body.headers.entries().flatMap { (name, values) -> values.map { name to it } })
            HttpRequestData(
                url = data.url,
                method = data.method,
                headers = Headers.build { headers.forEach { (name, value) -> append(name, value) } },
                body = data.body,
                executionContext = data.executionContext,
                attributes = data.attributes,
            )
        } catch (failure: SourceFailure) {
            budget.trace(attempt, "policy_rejected", failure = failure); publish(); budget.fail(failure.code)
        }
        if (data.method.value !in setOf("GET", "POST", "HEAD")) budget.fail("METHOD_POLICY")
        val response = try { delegate.execute(outgoing) }
        catch (failure: CancellationException) {
            budget.trace(attempt, "delegate_cancelled", failure = failure); publish(); throw failure
        }
        catch (failure: SourceFailure) {
            budget.trace(attempt, "delegate_policy_failure", failure = failure); publish(); budget.fail(failure.code)
        }
        catch (failure: Exception) {
            budget.trace(attempt, "delegate_failed", failure = failure); publish(); budget.fail("NETWORK_TRANSPORT_FAILURE")
        }
        budget.status(response.statusCode.value)
        budget.trace(attempt, "headers_received", response.statusCode.value); publish()
        val raw = response.body as? ByteReadChannel ?: budget.fail("BODY_TYPE_UNSUPPORTED")
        val media = data.url.encodedPath == "/videoplayback"
        val bodyLimit = SourcePolicy.CONTROL_BODY_CAP
        fun reject(code: String): Nothing {
            budget.trace(attempt, "response_rejected", failure = SourceFailure(code)); publish()
            val cancellation = CancellationException(code)
            raw.cancel(cancellation)
            response.callContext.job.cancel(cancellation)
            budget.fail(code)
        }
        if (response.statusCode.value in setOf(401, 403, 429)) reject("ACCESS_${response.statusCode.value}")
        if (response.statusCode.value in 300..399) reject("CONTROL_REDIRECT_UNSUPPORTED")
        val encoding = response.headers[HttpHeaders.ContentEncoding]
        if (encoding != null && !encoding.equals("identity", true)) reject("CONTENT_ENCODING_UNSUPPORTED")
        val declared = response.headers[HttpHeaders.ContentLength]?.toLongOrNull()
        budget.declaredLength(attempt, declared, method == "HEAD"); publish()
        if (method != "HEAD" && declared != null && (declared < 0 || declared > bodyLimit)) reject("RESPONSE_BODY_CAP")
        val output = CoroutineScope(response.callContext).writer(autoFlush = true) {
            val buffer = ByteArray(8192)
            var bodyRead = 0L
            var forwarded = 0L
            var eof = false
            try {
                budget.bodyTrace(attempt, bodyRead, forwarded, eof, "body_started"); publish()
                while (true) {
                    // Observe EOF without consuming an unbudgeted sentinel byte at an exact cap.
                    budget.bodyTrace(attempt, bodyRead, forwarded, eof, "body_awaiting_content")
                    if (!raw.awaitContent()) { eof = true; break }
                    if (bodyRead >= bodyLimit) reject("RESPONSE_BODY_CAP")
                    val reservation = budget.reserve(minOf(buffer.size.toLong(), bodyLimit - bodyRead).toInt())
                    val count = try { raw.readAvailable(buffer, 0, reservation) }
                    catch (failure: Throwable) { budget.settle(reservation, 0, media); throw failure }
                    budget.settle(reservation, maxOf(count, 0), media)
                    if (count < 0) { eof = true; break }
                    if (count == 0) continue
                    bodyRead += count
                    budget.bodyTrace(attempt, bodyRead, forwarded, eof, "body_forwarding")
                    if (declared != null && bodyRead >= declared) publish()
                    channel.writeFully(buffer, 0, count)
                    forwarded += count
                    budget.bodyTrace(attempt, bodyRead, forwarded, eof, "body_forwarded")
                    if (declared != null && bodyRead >= declared) publish()
                }
                budget.bodyTrace(attempt, bodyRead, forwarded, eof, "body_completed")
                budget.trace(attempt, "body_completed"); publish()
            } catch (failure: CancellationException) {
                budget.trace(attempt, "body_cancelled", failure = failure); publish(); throw failure
            } catch (failure: SourceFailure) {
                budget.trace(attempt, "body_policy_failure", failure = failure); publish(); budget.fail(failure.code)
            } catch (failure: Exception) {
                budget.trace(attempt, "body_failed", failure = failure); publish(); budget.fail("NETWORK_BODY_FAILURE")
            } finally { raw.cancel(null) }
        }
        // Cancellation before the writer's first dispatch never enters its finally.
        // Bind the delegate body to the output job as well as the running-body cleanup.
        raw.attachWriterJob(output)
        return HttpResponseData(response.statusCode, response.requestTime, response.headers,
            response.version, output.channel, response.callContext)
    }

    fun abort() {
        budget.aborted.set(true)
        coroutineContext.cancel(CancellationException("PROBE_CANCELLED"))
        delegate.coroutineContext.cancel(CancellationException("PROBE_CANCELLED"))
        close()
    }
    override fun close() { super.close(); delegate.close() }
}
