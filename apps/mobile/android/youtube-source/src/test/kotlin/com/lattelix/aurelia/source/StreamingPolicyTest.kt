package com.lattelix.aurelia.source

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import okhttp3.Authenticator
import okhttp3.CookieJar
import okhttp3.HttpUrl.Companion.toHttpUrl
import java.net.CookieHandler
import java.net.CookieManager
import java.net.HttpCookie
import java.net.URI
import java.util.concurrent.atomic.AtomicInteger

class StreamingPolicyTest {
    @Test fun ambientCapacitorCookieHandlerCannotSupplyCookiesToNativeMediaClient() {
        val previous = CookieHandler.getDefault()
        val ambient = CookieManager()
        ambient.cookieStore.add(URI("https://unit.googlevideo.com"), HttpCookie("synthetic", "fixture"))
        CookieHandler.setDefault(ambient)
        try {
            val client = StreamingPolicy.anonymousClientBuilder().build()
            assertSame(ambient, CookieHandler.getDefault())
            assertSame(CookieJar.NO_COOKIES, client.cookieJar)
            assertTrue(client.cookieJar.loadForRequest("https://unit.googlevideo.com/videoplayback".toHttpUrl()).isEmpty())
            assertSame(Authenticator.NONE, client.authenticator)
            assertSame(Authenticator.NONE, client.proxyAuthenticator)
            assertFalse(client.followRedirects)
            assertFalse(client.retryOnConnectionFailure)
            assertEquals(0, client.callTimeoutMillis)
        } finally { CookieHandler.setDefault(previous) }
    }
    private fun fails(code: String, action: () -> Unit) {
        try {
            action()
            throw AssertionError("Expected fixed failure")
        } catch (failure: SourceFailure) {
            assertEquals(code, failure.code)
            assertEquals(code, failure.message)
            assertNull(failure.cause)
        }
    }

    private fun headers(length: Long, range: String? = null, etag: String? = null) =
        linkedMapOf("Content-Length" to listOf(length.toString()), "Content-Type" to listOf("audio/webm")).apply {
            if (range != null) put("Content-Range", listOf(range))
            if (etag != null) put("ETag", listOf(etag))
        }

    @Test fun wholeAndSeekRangesHaveExactExpectedLengthsWithoutSampleCap() {
        val total = 300L * 1024 * 1024
        val whole = StreamingPolicy.range(total, 0, -1)
        assertNull(whole.rangeHeader)
        assertEquals(total, whole.length)
        assertEquals(total - 1, whole.end)
        val tail = StreamingPolicy.range(total, total - 1234, -1)
        assertEquals(1234L, tail.length)
        assertEquals("bytes=${total - 1234}-", tail.rangeHeader)
        val bounded = StreamingPolicy.range(total, 1024, 4096)
        assertEquals("bytes=1024-5119", bounded.rangeHeader)
        assertEquals(0L, StreamingPolicy.range(total, total, -1).length)
    }

    @Test fun rangeArithmeticRejectsOverflowAndOutsideContent() {
        fails("RANGE_INVALID") { StreamingPolicy.range(100, 101, -1) }
        fails("RANGE_INVALID") { StreamingPolicy.range(100, 99, 2) }
        fails("RANGE_INVALID") { StreamingPolicy.range(Long.MAX_VALUE, 1, Long.MAX_VALUE) }
        fails("RANGE_INVALID") { StreamingPolicy.range(100, 0, 0) }
        fails("RANGE_INVALID") { StreamingPolicy.range(100, -1, -1) }
    }

    @Test fun icyAdaptationAcceptsOnlyItsExactValueAndDoesNotForwardIt() {
        assertTrue(StreamingPolicy.requestHeaders(mapOf("iCy-MeTaDaTa" to "1"), null).isEmpty())
        fails("HEADER_POLICY") { StreamingPolicy.requestHeaders(mapOf("Icy-MetaData" to "01"), null) }
        fails("HEADER_POLICY") { StreamingPolicy.requestHeaders(mapOf("Icy-MetaData" to "1", "icy-metadata" to "1"), null) }
        fails("HEADER_POLICY") { StreamingPolicy.requestHeaders(mapOf("Authorization" to "anything"), null) }
    }

    @Test fun ifRangeRequiresPreviouslyObservedIdenticalStrongTag() {
        val tag = "\"stream-v1\""
        assertEquals(mapOf("If-Range" to tag), StreamingPolicy.requestHeaders(mapOf("if-range" to tag), tag))
        fails("HEADER_POLICY") { StreamingPolicy.requestHeaders(mapOf("If-Range" to tag), null) }
        fails("HEADER_POLICY") { StreamingPolicy.requestHeaders(mapOf("If-Range" to "\"other\""), tag) }
        fails("HEADER_POLICY") { StreamingPolicy.requestHeaders(mapOf("If-Range" to "W/$tag"), "W/$tag") }
        fails("HEADER_POLICY") { StreamingPolicy.requestHeaders(mapOf("If-Range" to "Tue, 01 Jan 2030 00:00:00 GMT"), tag) }
    }

    @Test fun wholeResponseIsValidatedAndUnsafeResponseHeadersAreNotExposed() {
        val all = headers(100, etag = "\"stable\"") + mapOf(
            "Set-Cookie" to listOf("not forwarded"), "Location" to listOf("not forwarded"))
        val result = StreamingPolicy.response(200, all, "audio/webm", 100,
            StreamingPolicy.range(100, 0, -1), null)
        assertEquals(setOf("Content-Length", "Content-Type", "ETag"), result.headers.keys)
        assertEquals("\"stable\"", result.strongEtag)
    }

    @Test fun partialResponseRequiresExactStatusLengthAndContentRange() {
        val plan = StreamingPolicy.range(100, 20, 10)
        StreamingPolicy.response(206, headers(10, "bytes 20-29/100"), "audio/webm", 100, plan, null)
        fails("RANGE_UNSUPPORTED") { StreamingPolicy.response(200, headers(100), "audio/webm", 100, plan, null) }
        fails("RANGE_INVALID") { StreamingPolicy.response(206, headers(10, "bytes 21-30/100"), "audio/webm", 100, plan, null) }
        fails("RANGE_INVALID") { StreamingPolicy.response(206, headers(9, "bytes 20-29/100"), "audio/webm", 100, plan, null) }
        fails("RANGE_INVALID") { StreamingPolicy.response(206, headers(10, "bytes 20-29/101"), "audio/webm", 100, plan, null) }
    }

    @Test fun accessAndRedirectFailuresRejectBeforeBodyConsumption() {
        val plan = StreamingPolicy.range(100, 0, -1)
        for ((status, code) in listOf(401 to "ACCESS_401", 403 to "ACCESS_403", 429 to "ACCESS_429",
            302 to "MEDIA_REDIRECT_UNSUPPORTED", 500 to "MEDIA_HTTP_500")) {
            fails(code) { StreamingPolicy.response(status, emptyMap(), "audio/webm", 100, plan, null) }
        }
    }

    @Test fun unexpectedMediaHttpStatusesHaveOnlyFixedPrivateFailureCodes() {
        val plan = StreamingPolicy.range(100, 0, -1)
        val privateHeaders = mapOf("Location" to listOf("https://signed.invalid/private?token=synthetic-private"),
            "X-Private-Fixture" to listOf("synthetic-private"))
        for ((status, code) in listOf(400 to "MEDIA_HTTP_400", 404 to "MEDIA_HTTP_404", 410 to "MEDIA_HTTP_410",
            500 to "MEDIA_HTTP_500", 502 to "MEDIA_HTTP_502", 503 to "MEDIA_HTTP_503", 504 to "MEDIA_HTTP_504",
            201 to "MEDIA_HTTP_OTHER", 418 to "MEDIA_HTTP_OTHER", 505 to "MEDIA_HTTP_OTHER", 599 to "MEDIA_HTTP_OTHER")) {
            fails(code) { StreamingPolicy.response(status, privateHeaders, "audio/webm", 100, plan, null) }
        }
        fails("RANGE_INVALID") { StreamingPolicy.response(416, privateHeaders, "audio/webm", 100, plan, null) }
    }

    @Test fun mediaRedirectCodeNeverContainsTheRejectedLocatorOrHeaders() {
        val plan = StreamingPolicy.range(100, 0, -1)
        for (status in listOf(301, 302, 307, 308)) {
            fails("MEDIA_REDIRECT_UNSUPPORTED") {
                StreamingPolicy.response(status,
                    mapOf("Location" to listOf("https://signed.invalid/private?token=synthetic-private")),
                    "audio/webm", 100, plan, null)
            }
        }
    }

    @Test fun responseRejectsAmbiguousEncodingLengthsAndChangedIdentity() {
        val plan = StreamingPolicy.range(100, 0, -1)
        fails("HEADER_POLICY") { StreamingPolicy.response(200, headers(100) +
            mapOf("content-length" to listOf("100")), "audio/webm", 100, plan, null) }
        fails("CONTENT_ENCODING_UNSUPPORTED") { StreamingPolicy.response(200, headers(100) +
            mapOf("Content-Encoding" to listOf("gzip")), "audio/webm", 100, plan, null) }
        fails("FORMAT_UNSUPPORTED") { StreamingPolicy.response(200, headers(100), "audio/mp4", 100, plan, null) }
        fails("SOURCE_IDENTITY_MISMATCH") { StreamingPolicy.response(200, headers(100, etag = "\"new\""),
            "audio/webm", 100, plan, "\"old\"") }
        fails("SOURCE_IDENTITY_MISMATCH") { StreamingPolicy.response(200, headers(100),
            "audio/webm", 100, plan, "\"old\"") }
        fails("SOURCE_IDENTITY_MISMATCH") { StreamingPolicy.response(200, headers(100, etag = "W/\"old\""),
            "audio/webm", 100, plan, "\"old\"") }
    }

    @Test fun outgoingHeadersMustMatchFixedLocatorAndExpectedRange() {
        val fixed = mapOf("user-agent" to "native")
        val accepted = listOf("Host" to "r.googlevideo.com", "Connection" to "Keep-Alive",
            "Accept-Encoding" to "identity", "User-Agent" to "native", "Range" to "bytes=10-")
        StreamingPolicy.validateOutgoing(accepted, fixed, "r.googlevideo.com", "bytes=10-", null)
        fails("HEADER_POLICY") { StreamingPolicy.validateOutgoing(accepted + ("Cookie" to "x"),
            fixed, "r.googlevideo.com", "bytes=10-", null) }
        fails("HEADER_POLICY") { StreamingPolicy.validateOutgoing(accepted, fixed, "other.googlevideo.com", "bytes=10-", null) }
        fails("HEADER_POLICY") { StreamingPolicy.validateOutgoing(accepted + ("Range" to "bytes=10-"),
            fixed, "r.googlevideo.com", "bytes=10-", null) }
    }

    @Test fun renewalPreservesContentIdentityButMayChangeSignedLocator() {
        val original = NativeSourceLease("abcdefghijk", "private-one", emptyMap(), "audio/webm", 251, 100, 0)
        StreamingPolicy.requireSameStream(original, original.copy(audioUrl = "private-two", expiresAtMs = 1000))
        for (changed in listOf(original.copy(videoId = "other______"), original.copy(itag = 140),
            original.copy(mimeType = "audio/mp4"), original.copy(contentLength = 101))) {
            fails("SOURCE_IDENTITY_MISMATCH") { StreamingPolicy.requireSameStream(original, changed) }
        }
    }

    @Test fun closingOneOpenAllowsASeekButFactoryCancellationIsPermanent() {
        val factory = CancellationToken()
        val first = StreamingOpenCancellation(factory)
        val callbacks = AtomicInteger()
        first.token.onCancel { callbacks.incrementAndGet() }
        first.close()
        first.close()
        assertTrue(first.token.isCancelled())
        assertFalse(factory.isCancelled())
        assertEquals(1, callbacks.get())
        val seek = StreamingOpenCancellation(factory)
        assertFalse(seek.token.isCancelled())
        factory.cancel()
        assertTrue(seek.token.isCancelled())
        assertTrue(StreamingOpenCancellation(factory).token.isCancelled())
        fails("CANCELLED") { seek.token.check() }
    }
}
