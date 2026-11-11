package com.lattelix.aurelia.source

import okhttp3.Authenticator
import okhttp3.Call
import okhttp3.Connection
import okhttp3.CookieJar
import okhttp3.Headers
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.*
import org.junit.Test
import java.net.Proxy
import java.util.concurrent.TimeUnit

class StreamingRedirectPolicyTest {
    private val expiry = System.currentTimeMillis() / 1000 + 3600
    private val initial = ("https://r1.googlevideo.com/videoplayback?id=synthetic-stream&itag=251&clen=100&expire=$expiry" +
        "&mime=audio%2Fwebm&lmt=123&source=youtube&sig=initial").toHttpUrl()
    private fun lease(url: HttpUrl = initial) = NativeSourceLease("abcdefghijk", url.toString(), emptyMap(), "audio/webm", 251, 100, expiry * 1000)
    private fun target(host: String = "r2.googlevideo.com") = initial.newBuilder().host(host).setQueryParameter("sig", host).build()
    private fun policy(check: () -> Unit = {}) = StreamingRedirectPolicy(lease(), "abcdefghijk", check)
    private fun fails(code: String, action: () -> Unit) {
        try { action(); fail("Expected fixed rejection") }
        catch (failure: SourceFailure) {
            assertEquals(code, failure.code); assertEquals(code, failure.message); assertNull(failure.cause)
        }
    }
    private fun request(url: HttpUrl, host: String = url.host, range: String = "bytes=20-29", tag: String = "\"stable\""): Request =
        Request.Builder().url(url).header("Host", host).header("Connection", "Keep-Alive")
            .header("Accept-Encoding", "identity").header("User-Agent", "native")
            .header("Range", range).header("If-Range", tag).build()
    private fun client(guard: StreamingRedirectPolicy, finalResponse: (StreamingPolicy.ValidatedResponse) -> Unit = {}): OkHttpClient =
        guard.client(mapOf("user-agent" to "native"), StreamingPolicy.range(100, 20, 10), "\"stable\"", "\"stable\"",
            finalResponse, failed = { call, response, error -> call.cancel(); response?.close(); throw error })
    private fun response(request: Request, status: Int, headers: Headers = Headers.Builder().build()): Response =
        Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(status).message("fixture")
            .headers(headers).body(ByteArray(0).toResponseBody(null)).build()
    private class Exchange(private val request: Request, private val response: Response, private val call: Call) : Interceptor.Chain {
        var proceeded = 0
        override fun request(): Request = request
        override fun call(): Call = call
        override fun connection(): Connection? = null
        override fun proceed(request: Request): Response { proceeded++; return response }
        override fun connectTimeoutMillis(): Int = 10_000
        override fun readTimeoutMillis(): Int = 20_000
        override fun writeTimeoutMillis(): Int = 20_000
        override fun withConnectTimeout(timeout: Int, unit: TimeUnit): Interceptor.Chain = this
        override fun withReadTimeout(timeout: Int, unit: TimeUnit): Interceptor.Chain = this
        override fun withWriteTimeout(timeout: Int, unit: TimeUnit): Interceptor.Chain = this
    }

    @Test fun legitimateCdnHopsRetainContentIdentityAndEveryOutgoingRangeHeader() {
        val guard = policy()
        val fixed = mapOf("user-agent" to "native")
        guard.validateOutgoing(request(initial), fixed, "bytes=20-29", "\"stable\"")
        val second = target()
        assertEquals(second, guard.approve(302, initial, listOf(second.toString())))
        guard.validateOutgoing(request(second), fixed, "bytes=20-29", "\"stable\"")
        val third = target("googlevideo.com")
        assertEquals(third, guard.approve(307, second, listOf(third.toString())))
        guard.validateOutgoing(request(third), fixed, "bytes=20-29", "\"stable\"")
        fails("HOST_POLICY") { guard.validateRequest(initial) }
        fails("HEADER_POLICY") { guard.validateOutgoing(request(third, host = initial.host), fixed, "bytes=20-29", "\"stable\"") }
        fails("HEADER_POLICY") { guard.validateOutgoing(request(third, range = "bytes=0-"), fixed, "bytes=20-29", "\"stable\"") }
        fails("HEADER_POLICY") { guard.validateOutgoing(request(third, tag = "\"changed\""), fixed, "bytes=20-29", "\"stable\"") }
        fails("HEADER_POLICY") { guard.validateOutgoing(request(third).newBuilder().header("Cookie", "synthetic").build(), fixed, "bytes=20-29", "\"stable\"") }
        assertEquals("StreamingRedirectPolicy(redacted)", guard.toString())
    }

    @Test fun onlyApprovedRedirectStatusesWithOneBoundedLocationAreAccepted() {
        for (status in listOf(301, 302, 303, 307, 308)) assertEquals(target(), policy().approve(status, initial, listOf(target().toString())))
        for (status in listOf(300, 304, 305, 306, 309, 399))
            fails("MEDIA_REDIRECT_UNSUPPORTED") { policy().approve(status, initial, listOf(target().toString())) }
        for (locations in listOf(emptyList(), listOf(""), listOf(" ${target()}"), listOf("x".repeat(16_385)),
            listOf("${target()}\r\nX-Test: synthetic"), listOf(target().toString(), target().toString())))
            fails("MEDIA_REDIRECT_UNSUPPORTED") { policy().approve(302, initial, locations) }
    }

    @Test fun rejectsUnsafeRedirectAuthorityPathAndFragmentsBeforeApprovingTheNextRequest() {
        for (location in listOf(
            target().toString().replace("https:", "http:"),
            target().newBuilder().port(444).build().toString(),
            target().toString().replace("https://", "https://user:pass@"),
            target().toString().replace("https://", "https://@"),
            "${target()}#", "${target()}#synthetic",
            target("googlevideo.com.evil.invalid").toString(), target("evilgooglevideo.com").toString(),
            target("127.0.0.1").toString(), target("192.168.1.1").toString(), target("[::1]").toString(),
            target("youtube.com").toString(), target().newBuilder().encodedPath("/other").build().toString(),
            target().newBuilder().addQueryParameter("RaNgE", "bytes=0-").build().toString(),
        )) {
            val guard = policy()
            fails("HOST_POLICY") { guard.approve(302, initial, listOf(location)) }
            guard.validateRequest(initial)
            fails("HOST_POLICY") { guard.validateRequest(target()) }
        }
    }

    @Test fun loopAndThirdHopAreTerminalAndRelativeLocationsAreResolvedAgainstTheCurrentUrl() {
        val guard = policy()
        val next = target()
        guard.approve(302, initial, listOf(next.toString()))
        fails("MEDIA_REDIRECT_UNSUPPORTED") { guard.approve(302, next, listOf(initial.toString())) }
        val relative = next.newBuilder().setQueryParameter("route", "next").build()
        assertEquals(relative, guard.approve(308, next, listOf(relative.encodedPath + "?" + relative.encodedQuery)))
        fails("MEDIA_REDIRECT_UNSUPPORTED") { guard.approve(302, relative, listOf(target("r3.googlevideo.com").toString())) }
    }

    @Test fun immutableQueryIdentityCannotBeMissingDuplicatedAddedOrChanged() {
        for (key in listOf("id", "itag", "clen", "expire", "mime", "lmt", "source")) {
            for (changed in listOf(
                target().newBuilder().removeAllQueryParameters(key).build(),
                target().newBuilder().addQueryParameter(key, initial.queryParameter(key)).build(),
                target().newBuilder().setQueryParameter(key, "changed").build(),
                target().newBuilder().setQueryParameter(key, "").build(),
                target().newBuilder().addQueryParameter(key.uppercase(), initial.queryParameter(key)).build(),
            )) fails("SOURCE_IDENTITY_MISMATCH") { policy().approve(302, initial, listOf(changed.toString())) }
        }
        val noOptional = initial.newBuilder().removeAllQueryParameters("mime").removeAllQueryParameters("lmt").removeAllQueryParameters("source").build()
        val guard = StreamingRedirectPolicy(lease(noOptional), "abcdefghijk")
        fails("SOURCE_IDENTITY_MISMATCH") { guard.approve(302, noOptional, listOf(target().toString())) }
        val encodedDuplicate = target().toString() + "&%69d=synthetic-stream"
        fails("SOURCE_IDENTITY_MISMATCH") { policy().approve(302, initial, listOf(encodedDuplicate)) }
    }

    @Test fun cancellationAndLeaseExpiryStillRejectBeforeARequestCanContinue() {
        val cancellation = CancellationToken()
        val guard = policy(cancellation::check)
        val next = guard.approve(302, initial, listOf(target().toString()))
        cancellation.cancel()
        fails("CANCELLED") { guard.validateOutgoing(request(next), mapOf("user-agent" to "native"), "bytes=20-29", "\"stable\"") }
        fails("CANCELLED") { guard.approve(302, next, listOf(target("r3.googlevideo.com").toString())) }
        val expired = lease().copy(expiresAtMs = 1)
        fails("SOURCE_IDENTITY_MISMATCH") { StreamingRedirectPolicy(expired, "abcdefghijk").approve(302, initial, listOf(target().toString())) }
    }

    @Test fun onlyGuardBoundMediaClientEnablesRedirectsWithoutChangingAnonymousOrRetryPolicies() {
        val client = client(policy())
        val ordinary = StreamingPolicy.anonymousClientBuilder().build()
        assertTrue(client.followRedirects); assertFalse(ordinary.followRedirects)
        assertFalse(client.followSslRedirects); assertFalse(client.retryOnConnectionFailure)
        assertSame(CookieJar.NO_COOKIES, client.cookieJar)
        assertSame(Authenticator.NONE, client.authenticator); assertSame(Authenticator.NONE, client.proxyAuthenticator)
        assertEquals(Proxy.NO_PROXY, client.proxy); assertNull(client.cache)
        assertEquals(1, client.networkInterceptors.size)
    }

    @Test fun mandatoryInterceptorApprovesTwoHopsThenValidatesFinalRangeAndRedactsHeaders() {
        val finals = mutableListOf<StreamingPolicy.ValidatedResponse>()
        val client = client(policy(), finals::add)
        val interceptor = client.networkInterceptors.single()
        val call = client.newCall(request(initial))
        val second = target()
        val third = target("r3.googlevideo.com")
        for ((from, to) in listOf(initial to second, second to third)) {
            val outgoing = request(from)
            val headers = Headers.Builder().add("Location", to.toString()).add("Set-Cookie", "synthetic-private").build()
            val incoming = response(outgoing, 302, headers)
            val exchange = Exchange(outgoing, incoming, call)
            assertSame(incoming, interceptor.intercept(exchange))
            assertEquals(1, exchange.proceeded)
            assertTrue(finals.isEmpty())
            incoming.close()
        }
        val finalRequest = request(third)
        val finalHeaders = Headers.Builder().add("Content-Length", "10").add("Content-Type", "audio/webm")
            .add("Content-Range", "bytes 20-29/100").add("ETag", "\"stable\"")
            .add("Location", "synthetic-private").add("Set-Cookie", "synthetic-private").build()
        val incoming = response(finalRequest, 206, finalHeaders)
        val exchange = Exchange(finalRequest, incoming, call)
        interceptor.intercept(exchange).close()
        assertEquals(1, exchange.proceeded)
        assertFalse(call.isCanceled())
        assertEquals(setOf("Content-Length", "Content-Type", "Content-Range", "ETag"), finals.single().headers.keys)
        assertFalse(finals.single().headers.toString().contains("synthetic-private"))
    }

    @Test fun interceptorRejectsUnapprovedTargetBadRangeAndCancellationBeforeProceedAndCancelsTheSameCall() {
        for (kind in listOf("unapproved", "range", "cancel")) {
            val cancellation = CancellationToken()
            val guard = policy(cancellation::check)
            val client = client(guard)
            val next = target()
            if (kind != "unapproved") guard.approve(302, initial, listOf(next.toString()))
            if (kind == "cancel") cancellation.cancel()
            val outgoing = request(next, range = if (kind == "range") "bytes=0-" else "bytes=20-29")
            val call = client.newCall(outgoing)
            val exchange = Exchange(outgoing, response(outgoing, 206), call)
            val code = when (kind) { "unapproved" -> "HOST_POLICY"; "range" -> "HEADER_POLICY"; else -> "CANCELLED" }
            fails(code) { client.networkInterceptors.single().intercept(exchange) }
            assertEquals(0, exchange.proceeded)
            assertTrue(call.isCanceled())
        }
    }

    @Test fun clientFactoryRequiresAValidFreshLeaseAndMatchingVideoBeforeConstructingANetworkClient() {
        fails("SOURCE_IDENTITY_MISMATCH") { StreamingRedirectPolicy(lease(), "different00") }
        fails("HEADER_POLICY") { StreamingRedirectPolicy(lease().copy(headers = mapOf("Authorization" to "synthetic")), "abcdefghijk") }
        fails("FORMAT_UNSUPPORTED") { StreamingRedirectPolicy(lease().copy(mimeType = "video/mp4"), "abcdefghijk") }
        val expiredUrl = initial.newBuilder().setQueryParameter("expire", "1").build()
        fails("SOURCE_EXPIRED") { StreamingRedirectPolicy(lease(expiredUrl).copy(expiresAtMs = 1000), "abcdefghijk") }
    }
}
