package com.lattelix.aurelia.source

import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class SourcePolicyTest {
    private val id = "aqz-KE-bpKQ"
    private fun lease(expires: Long = System.currentTimeMillis() / 1000 + 3600, length: Long = 128L * 1024 * 1024) =
        NativeSourceLease(id, "https://unit.googlevideo.com/videoplayback?itag=251&clen=$length&expire=$expires",
            mapOf("Accept-Encoding" to "identity"), "audio/webm", 251, length, expires * 1000)
    private fun rejects(action: () -> Unit) {
        try { action(); fail("Expected policy rejection") } catch (error: SourceFailure) { assertNull(error.cause) }
    }
    @Test fun wholeSongLeaseHasNoSampleByteLimit() { SourcePolicy.validateLease(lease(), id) }
    @Test fun expiredLeaseRejectedAndRedacted() {
        val value = lease(expires = 1)
        rejects { SourcePolicy.validateLease(value, id) }
        assertEquals("NativeSourceLease(redacted)", value.toString())
    }
    @Test fun exactSourceIdentityAndHttpsAreRequired() {
        val value = lease()
        rejects { SourcePolicy.validateLease(value.copy(videoId = "dQw4w9WgXcQ"), id) }
        rejects { SourcePolicy.validateLease(value.copy(itag = 140), id) }
        rejects { SourcePolicy.validateLease(value.copy(contentLength = 5), id) }
        rejects { SourcePolicy.validateLease(value.copy(audioUrl = value.audioUrl + "&itag=140"), id) }
        rejects { SourcePolicy.validateLease(value.copy(audioUrl = value.audioUrl.replace("https:", "http:")), id) }
        rejects { SourcePolicy.validateLease(value.copy(audioUrl = value.audioUrl.replace("unit.googlevideo.com", "googlevideo.com.invalid")), id) }
    }
    @Test fun credentialHeadersNeverBecomePermittedSourceHeaders() {
        for (name in listOf("Cookie", "Authorization", "Proxy-Authorization", "X-Goog-AuthUser", "X-YouTube-Identity-Token"))
            rejects { SourcePolicy.validateLease(lease().copy(headers = mapOf(name to "synthetic")), id) }
        assertEquals(listOf("Accept" to "audio/*"), SourcePolicy.anonymousHeaders(listOf("cOoKiE" to "synthetic", "Accept" to "audio/*")))
        rejects { SourcePolicy.validateLease(lease().copy(headers = mapOf("Accept" to "a", "accept" to "b")), id) }
    }
    @Test fun cancellationIsIdempotentAndLateRegistrationCannotEscape() {
        val token = CancellationToken(); val calls = AtomicInteger()
        token.onCancel { calls.incrementAndGet() }; token.cancel(); token.cancel()
        token.onCancel { calls.incrementAndGet() }
        assertEquals(2, calls.get())
        rejects { token.check() }
    }
    @Test fun removedRegistrationDoesNotRunAndCallbackFailureDoesNotStrandOthers() {
        val token = CancellationToken(); val calls = AtomicInteger()
        token.onCancel { calls.incrementAndGet() }.close()
        token.onCancel { throw IllegalStateException("synthetic") }
        token.onCancel { calls.incrementAndGet() }
        token.cancel()
        assertEquals(1, calls.get())
    }
    @Test fun concurrentCancellationAndRegistrationRunsOnce() {
        repeat(100) {
            val token = CancellationToken(); val start = CountDownLatch(1); val finished = CountDownLatch(1); val calls = AtomicInteger()
            val thread = Thread { start.await(); token.onCancel { calls.incrementAndGet() }; finished.countDown() }
            thread.start(); start.countDown(); token.cancel()
            assertTrue(finished.await(2, TimeUnit.SECONDS)); thread.join(2000)
            assertEquals(1, calls.get())
        }
    }
    @Test fun untrustedFailureStringCannotReachMediaSession() {
        val failure = SourceFailure("https://signed.invalid/private?token=synthetic")
        assertEquals("IO_FAILURE", failure.message); assertNull(failure.cause)
    }
    @Test fun redirectDiagnosticEnumsPreserveLegacyCompatibilityWithoutAttachingCauses() {
        for (code in listOf("REDIRECT_UNSUPPORTED", "CONTROL_REDIRECT_UNSUPPORTED", "MEDIA_REDIRECT_UNSUPPORTED")) {
            val failure = SourceFailure(code)
            assertEquals(code, failure.code)
            assertEquals(code, failure.message)
            assertNull(failure.cause)
            assertEquals(code, SourceFailureDiagnostics.code(failure))
        }
        assertEquals("IO_FAILURE", SourcePolicy.safeFailureCode("CONTROL_REDIRECT_UNSUPPORTED:https://signed.invalid/private"))
    }
    @Test fun controlAndMediaUnavailableCodesAreFixedWhileLegacyUnavailableRemainsCompatible() {
        for (code in listOf("SOURCE_UNAVAILABLE", "CONTROL_SOURCE_UNAVAILABLE", "MEDIA_HTTP_400", "MEDIA_HTTP_404",
            "MEDIA_HTTP_410", "MEDIA_HTTP_500", "MEDIA_HTTP_502", "MEDIA_HTTP_503", "MEDIA_HTTP_504", "MEDIA_HTTP_OTHER",
            "RESOLVER_BIND_REJECTED", "RESOLVER_BIND_SECURITY", "RESOLVER_BIND_STATE", "RESOLVER_BIND_FAILURE",
            "MEDIA_DELEGATE_UNAVAILABLE")) {
            val failure = SourceFailure(code)
            assertEquals(code, failure.code); assertEquals(code, failure.message); assertNull(failure.cause)
            assertEquals(code, SourceFailureDiagnostics.code(failure))
        }
        assertEquals("IO_FAILURE", SourcePolicy.safeFailureCode("MEDIA_HTTP_599"))
        assertEquals("IO_FAILURE", SourcePolicy.safeFailureCode("CONTROL_SOURCE_UNAVAILABLE:https://signed.invalid/private"))
    }
    @Test fun nullControlExtractionHasANonMessageFailureAndSuccessfulExtractionIsUnchanged() {
        val failure = runCatching { ControlResolver.requireExtractedSource<Any>(null) }.exceptionOrNull()
        assertTrue(failure is SourceFailure)
        assertEquals("CONTROL_SOURCE_UNAVAILABLE", (failure as SourceFailure).code)
        assertEquals("CONTROL_SOURCE_UNAVAILABLE", failure.message); assertNull(failure.cause)
        val extracted = Any()
        assertSame(extracted, ControlResolver.requireExtractedSource(extracted))
    }
    @Test fun processDeadlineCanOnlyTerminateExactOwnResolverProcess() {
        assertTrue(SourcePolicy.ownsResolverProcess(12345, 12345, "com.test:youtube_source", "com.test"))
        assertFalse(SourcePolicy.ownsResolverProcess(12345, 12345, "com.test", "com.test"))
        assertFalse(SourcePolicy.ownsResolverProcess(12345, 12345, "com.test:other", "com.test"))
        assertFalse(SourcePolicy.ownsResolverProcess(12345, 54321, "com.test:youtube_source", "com.test"))
        assertFalse(SourcePolicy.ownsResolverProcess(12345, 12345, null, "com.test"))
    }
}
