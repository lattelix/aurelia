package com.lattelix.aurelia.source

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.HttpRequestTimeoutException
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.prepareGet
import io.ktor.client.request.HttpResponseData
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsChannel
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.Headers
import io.ktor.http.content.OutgoingContent
import io.ktor.http.headersOf
import io.ktor.util.AttributeKey
import io.ktor.utils.io.ByteChannel
import io.ktor.utils.io.ByteReadChannel
import io.ktor.utils.io.InternalAPI
import io.ktor.utils.io.readAvailable
import io.ktor.utils.io.writeFully
import io.ktor.utils.io.writer
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.supervisorScope
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.atomic.AtomicInteger

/** Real Ktor client/statement/body lifecycle, with no Android or network transport. */
class ControlPlaneEngineTest {
    @OptIn(InternalAPI::class)
    @Test(timeout = 15_000)
    fun requestTimeoutUnwindsStreamingStatementAndProbeCleanup() = runBlocking {
        val producerStopped = CompletableDeferred<Unit>()
        val budget = ControlBudget()
        val mock = MockEngine {
            val template = respond("")
            val producer = CoroutineScope(template.callContext).writer(autoFlush = true) {
                try {
                    channel.writeFully(ByteArray(1_024), 0, 1_024)
                    while (true) delay(1_000)
                } finally { producerStopped.complete(Unit) }
            }
            HttpResponseData(template.statusCode, template.requestTime, template.headers,
                template.version, producer.channel, template.callContext)
        }
        val guard = ControlPlaneEngine(mock, budget)
        val client = HttpClient(guard) { install(HttpTimeout) { requestTimeoutMillis = 150 } }
        var consumerFinally = false
        var probeFinally = false
        val started = System.nanoTime()
        val failure = runCatching {
            withTimeout(3_000) {
                try {
                    client.prepareGet(WATCH).execute { response ->
                        val channel = response.bodyAsChannel()
                        try {
                            val buffer = ByteArray(1_024)
                            while (channel.readAvailable(buffer, 0, buffer.size) >= 0) { }
                        } finally { consumerFinally = true; channel.cancel(null) }
                    }
                } finally {
                    client.close()
                    guard.abort()
                    probeFinally = true
                }
            }
        }.exceptionOrNull()
        try {
            assertTrue("Expected the configured request timeout", hasRequestTimeout(failure))
            assertFalse("The outer deadline must not hide a stuck cleanup", failure is TimeoutCancellationException)
            assertTrue(consumerFinally)
            assertTrue(probeFinally)
            withTimeout(1_000) { producerStopped.await() }
            assertTrue((System.nanoTime() - started) / 1_000_000 < 3_000)
            assertTrue((budget.snapshot()["responseBodyBytes"] as Long) <= 1_024L)
        } finally { client.close(); guard.abort() }
    }

    @OptIn(InternalAPI::class)
    @Test(timeout = 15_000)
    fun requestTimeoutCanWaitForNonCooperativeResponseProducerCleanup() = runBlocking {
        val producerStopped = CompletableDeferred<Unit>()
        val budget = ControlBudget()
        val mock = MockEngine {
            val template = respond("")
            val producer = CoroutineScope(template.callContext + Dispatchers.IO).writer(autoFlush = true) {
                try {
                    channel.writeFully(ByteArray(1_024), 0, 1_024)
                    // Model a bounded blocking socket read/close which does not observe Job cancellation.
                    Thread.sleep(600)
                } finally { producerStopped.complete(Unit) }
            }
            HttpResponseData(template.statusCode, template.requestTime, template.headers,
                template.version, producer.channel, template.callContext)
        }
        val guard = ControlPlaneEngine(mock, budget)
        val client = HttpClient(guard) { install(HttpTimeout) { requestTimeoutMillis = 100 } }
        val started = System.nanoTime()
        val failure = runCatching {
            withTimeout(3_000) {
                try {
                    client.prepareGet(WATCH).execute { response ->
                        val channel = response.bodyAsChannel()
                        try { channel.readAvailable(ByteArray(1_024), 0, 1_024); channel.readAvailable(ByteArray(1), 0, 1) }
                        finally { channel.cancel(null) }
                    }
                } finally { client.close(); guard.abort() }
            }
        }.exceptionOrNull()
        try {
            val elapsedMs = (System.nanoTime() - started) / 1_000_000
            assertTrue("Expected the configured request timeout", hasRequestTimeout(failure))
            assertFalse(failure is TimeoutCancellationException)
            assertTrue("Statement cleanup waits for its non-cooperative child", elapsedMs >= 450)
            assertTrue(elapsedMs < 3_000)
            assertTrue(producerStopped.isCompleted)
        } finally { client.close(); guard.abort() }
    }

    @OptIn(InternalAPI::class)
    @Test(timeout = 15_000)
    fun streamingDelegateProducerAndDelayedEofComplete() = runBlocking {
        val completed = CompletableDeferred<Unit>()
        val budget = ControlBudget()
        val mock = MockEngine {
            val template = respond("")
            // Model Android's response producer as a child of its returned callContext.
            val producer = CoroutineScope(template.callContext).writer(autoFlush = true) {
                repeat(174) {
                    channel.writeFully(ByteArray(8_192) { 'x'.code.toByte() }, 0, 8_192)
                }
                delay(25)
                completed.complete(Unit)
            }
            HttpResponseData(template.statusCode, template.requestTime, template.headers,
                template.version, producer.channel, template.callContext)
        }
        withClient(mock, budget) { client, _ ->
            val text = withTimeout(5_000) { client.prepareGet(WATCH).execute { it.bodyAsText() } }
            assertEquals(174 * 8_192, text.length)
            withTimeout(5_000) { completed.await() }
            assertEquals(text.length.toLong(), budget.snapshot()["responseBodyBytes"])
            assertNull(budget.failureCode())
        }
    }

    @Test(timeout = 15_000)
    fun finiteHtmlBodyAndChildClientReachEof() = runBlocking {
        val payload = "x".repeat(1_418_649)
        val budget = ControlBudget()
        val mock = MockEngine { respond(payload) }
        withClient(mock, budget) { parent, guard ->
            // InnerTubeX creates a fresh client from the supplied engine for restricted GETs.
            val child = HttpClient(guard) { install(HttpTimeout) { requestTimeoutMillis = 5_000 } }
            try {
                val text = withTimeout(5_000) {
                    child.prepareGet(WATCH).execute { it.bodyAsText() }
                }
                assertEquals(payload.length, text.length)
                assertTrue(text.all { it == 'x' })
            } finally { child.close() }
            // Closing the child must not make the caller-owned shared engine unusable.
            assertEquals(payload.length, withTimeout(5_000) { parent.get(WATCH).bodyAsText() }.length)
            assertEquals(payload.length * 2L, budget.snapshot()["responseBodyBytes"])
            assertNull(budget.failureCode())
        }
    }

    @Test(timeout = 15_000)
    fun exactGlobalCapAndFollowingEmptyBodyReachEof() = runBlocking {
        val payload = "x".repeat(16_384)
        val calls = AtomicInteger()
        val budget = ControlBudget(maxBytes = payload.length.toLong())
        val mock = MockEngine { respond(if (calls.getAndIncrement() == 0) payload else "") }
        withClient(mock, budget) { client, _ ->
            val text = withTimeout(5_000) { client.prepareGet(WATCH).execute { it.bodyAsText() } }
            assertEquals(payload.length, text.length)
            assertEquals("", withTimeout(5_000) { client.prepareGet(WATCH).execute { it.bodyAsText() } })
            assertEquals(payload.length.toLong(), budget.snapshot()["responseBodyBytes"])
            assertNull(budget.failureCode())
        }
    }

    @Test(timeout = 15_000)
    fun exactControlBodyCapReachesEof() = runBlocking {
        val payload = "x".repeat(SourcePolicy.CONTROL_BODY_CAP.toInt())
        val budget = ControlBudget()
        val mock = MockEngine {
            respond(payload, headers = headersOf(HttpHeaders.ContentLength, payload.length.toString()))
        }
        withClient(mock, budget) { client, _ ->
            assertEquals(payload.length, withTimeout(5_000) {
                client.prepareGet(WATCH).execute { it.bodyAsText() }
            }.length)
            assertEquals(payload.length.toLong(), budget.snapshot()["controlBodyBytes"])
            assertNull(budget.failureCode())
        }
    }

    @Test(timeout = 15_000)
    fun unannouncedOversizedBodyFailsWithinGlobalCap() = runBlocking {
        val budget = ControlBudget(maxBytes = 1_024)
        val mock = MockEngine { respond("x".repeat(2_048)) }
        withClient(mock, budget) { client, _ ->
            expectGuardFailure { client.prepareGet(WATCH).execute { it.bodyAsText() } }
            assertEquals("BODY_BYTE_CAP", budget.failureCode())
            assertTrue((budget.snapshot()["responseBodyBytes"] as Long) <= 1_024L)
        }
    }

    @Test(timeout = 15_000)
    fun concurrentBodiesShareOneDeliveredByteCap() = runBlocking {
        val entered = AtomicInteger()
        val bothEntered = CompletableDeferred<Unit>()
        val budget = ControlBudget(maxBytes = 12_288)
        val mock = MockEngine {
            if (entered.incrementAndGet() == 2) bothEntered.complete(Unit)
            bothEntered.await()
            respond("x".repeat(8_192))
        }
        withClient(mock, budget) { client, _ ->
            val results = withTimeout(5_000) {
                supervisorScope {
                    List(2) { async { runCatching { client.prepareGet(WATCH).execute { it.bodyAsText() } } } }
                        .map { it.await() }
                }
            }
            assertEquals(2, entered.get())
            assertTrue(results.any { it.isFailure })
            assertEquals("BODY_BYTE_CAP", budget.failureCode())
            assertTrue((budget.snapshot()["responseBodyBytes"] as Long) <= 12_288L)
        }
    }

    @Test(timeout = 15_000)
    fun cancellingReaderCancelsPendingDelegateBody() = runBlocking {
        val raw = ByteChannel(autoFlush = true)
        val consuming = CompletableDeferred<Unit>()
        val delegateReading = CompletableDeferred<Unit>()
        val delegateCancelled = CompletableDeferred<Unit>()
        val observedRaw = object : ByteReadChannel by raw {
            override suspend fun awaitContent(min: Int): Boolean {
                delegateReading.complete(Unit)
                return raw.awaitContent(min)
            }
            override fun cancel(cause: Throwable?) {
                raw.cancel(cause)
                delegateCancelled.complete(Unit)
            }
        }
        val mock = MockEngine { respond(observedRaw) }
        withClient(mock, ControlBudget()) { client, _ ->
            val reader = launch {
                client.prepareGet(WATCH).execute { response ->
                    val body = response.bodyAsChannel()
                    val observedBody = object : ByteReadChannel by body {
                        override suspend fun awaitContent(min: Int): Boolean {
                            consuming.complete(Unit)
                            return body.awaitContent(min)
                        }
                    }
                    observedBody.readAvailable(ByteArray(1), 0, 1)
                }
            }
            withTimeout(5_000) {
                consuming.await()
                delegateReading.await()
                reader.cancelAndJoin()
                // The delegate producer is a different job; join of the reader is not its completion barrier.
                delegateCancelled.await()
            }
            assertTrue(raw.isClosedForRead)
        }
    }

    @OptIn(InternalAPI::class)
    @Test(timeout = 15_000)
    fun cancelledCallBeforeWriterStartsStillCancelsDelegateBody() = runBlocking {
        val raw = ByteChannel(autoFlush = true)
        val delegateReads = AtomicInteger()
        val delegateCancelled = CompletableDeferred<Unit>()
        val observedRaw = object : ByteReadChannel by raw {
            override suspend fun awaitContent(min: Int): Boolean {
                delegateReads.incrementAndGet()
                return raw.awaitContent(min)
            }
            override fun cancel(cause: Throwable?) {
                raw.cancel(cause)
                delegateCancelled.complete(Unit)
            }
        }
        val budget = ControlBudget()
        val mock = MockEngine {
            val template = respond("")
            val cancelledCall = Job().apply { cancel() }
            HttpResponseData(template.statusCode, template.requestTime, template.headers,
                template.version, observedRaw, template.callContext + cancelledCall)
        }
        withClient(mock, budget) { client, _ ->
            expectGuardFailure { client.prepareGet(WATCH).execute { it.bodyAsText() } }
            withTimeout(5_000) { delegateCancelled.await() }
            assertTrue(raw.isClosedForRead)
            assertEquals("Writer body must not have reached its first raw read", 0, delegateReads.get())
            assertEquals(0L, budget.snapshot()["responseBodyBytes"])
            assertEquals(1, budget.snapshot()["requests"])
        }
    }

    @Test(timeout = 15_000)
    fun abortCancelsPendingRequestWithoutAnotherTransportCall() = runBlocking {
        val raw = ByteChannel(autoFlush = true)
        val consuming = CompletableDeferred<Unit>()
        val calls = AtomicInteger()
        val budget = ControlBudget()
        val mock = MockEngine {
            calls.incrementAndGet()
            respond(raw)
        }
        withClient(mock, budget) { client, guard ->
            val response = async { runCatching {
                client.prepareGet(WATCH).execute { consuming.complete(Unit); it.bodyAsText() }
            } }
            withTimeout(5_000) { consuming.await() }
            guard.abort()
            assertTrue(withTimeout(5_000) { response.await() }.isFailure)
            assertTrue(raw.isClosedForRead)
            assertTrue(budget.aborted.get())
            assertEquals(1, calls.get())
        }
    }

    @Test(timeout = 15_000)
    fun hostAndCredentialPoliciesRejectBeforeDelegate() = runBlocking {
        for (credential in listOf(false, true)) {
            val calls = AtomicInteger()
            val budget = ControlBudget()
            val mock = MockEngine { calls.incrementAndGet(); respond("must not be reached") }
            withClient(mock, budget) { client, _ ->
                expectGuardFailure {
                    client.get(if (credential) WATCH else "https://example.com/watch") {
                        if (credential) header(HttpHeaders.Authorization, "Bearer synthetic-forbidden")
                    }.bodyAsText()
                }
                assertEquals(if (credential) "HEADER_POLICY" else "HOST_POLICY", budget.failureCode())
                assertEquals(0, calls.get())
            }
        }
    }

    @Test(timeout = 15_000)
    fun parentClientOmitsEveryCookieBeforeDelegate() = runBlocking {
        val seen = AtomicInteger()
        val budget = ControlBudget()
        val mock = MockEngine { data ->
            assertFalse(data.headers.names().any { it.equals("cookie", ignoreCase = true) })
            seen.incrementAndGet()
            respond("anonymous")
        }
        withClient(mock, budget) { client, _ ->
            for (cookie in listOf("PREF=hl=en&gl=US", "SID=synthetic-account-value")) {
                assertEquals("anonymous", withTimeout(5_000) {
                    client.get(WATCH) {
                        header("cOoKiE", cookie)
                        header(HttpHeaders.Cookie, "another=synthetic-value")
                    }.bodyAsText()
                })
            }
            assertEquals(2, seen.get())
            assertNull(budget.failureCode())
        }
    }

    @Test(timeout = 15_000)
    fun sharedChildClientOmitsEveryCookieBeforeDelegate() = runBlocking {
        val seen = AtomicInteger()
        val budget = ControlBudget()
        val mock = MockEngine { data ->
            assertFalse(data.headers.names().any { it.equals("cookie", ignoreCase = true) })
            seen.incrementAndGet()
            respond("anonymous")
        }
        withClient(mock, budget) { _, guard ->
            val child = HttpClient(guard)
            try {
                for (cookie in listOf("PREF=hl=en&gl=US", "SID=synthetic-account-value")) {
                    assertEquals("anonymous", withTimeout(5_000) {
                        child.get(WATCH) {
                            header("cOoKiE", cookie)
                            header(HttpHeaders.Cookie, "another=synthetic-value")
                        }.bodyAsText()
                    })
                }
            } finally { child.close() }
            assertEquals(2, seen.get())
            assertNull(budget.failureCode())
        }
    }

    @Test(timeout = 15_000)
    fun cookieOmissionDoesNotPermitOtherCredentialHeaders() = runBlocking {
        val forbidden = listOf(
            HttpHeaders.Authorization to "Bearer synthetic-forbidden",
            HttpHeaders.ProxyAuthorization to "Basic synthetic-forbidden",
            "X-YouTube-Identity-Token" to "synthetic-forbidden",
            "X-Goog-AuthUser" to "0",
            "X-Goog-AuthUser" to "1",
        )
        for ((name, value) in forbidden) {
            val seen = AtomicInteger()
            val budget = ControlBudget()
            val mock = MockEngine { seen.incrementAndGet(); respond("must not be reached") }
            withClient(mock, budget) { client, _ ->
                expectGuardFailure {
                    client.get(WATCH) {
                        header(HttpHeaders.Cookie, "PREF=hl=en&gl=US")
                        header(name, value)
                    }.bodyAsText()
                }
                assertEquals("HEADER_POLICY", budget.failureCode())
                assertEquals(0, seen.get())
            }
        }
    }

    @Test(timeout = 15_000)
    fun bodyOwnedCredentialsCannotBypassAnonymousRequestPolicy() = runBlocking {
        for (name in listOf(HttpHeaders.Cookie, HttpHeaders.Authorization)) {
            val body = object : OutgoingContent.ByteArrayContent() {
                override val headers: Headers = headersOf(name, "synthetic-forbidden")
                override fun bytes(): ByteArray = byteArrayOf(1, 2, 3)
            }
            val seen = AtomicInteger()
            val budget = ControlBudget()
            val mock = MockEngine { seen.incrementAndGet(); respond("must not be reached") }
            withClient(mock, budget) { client, _ ->
                expectGuardFailure { client.post(WATCH) { setBody(body) }.bodyAsText() }
                assertEquals("HEADER_POLICY", budget.failureCode())
                assertEquals(0, seen.get())
            }
        }
    }

    @Test(timeout = 15_000)
    fun cookieOmissionPreservesRequestBodyAndAttributes() = runBlocking {
        val marker = AttributeKey<String>("synthetic-marker")
        val body = object : OutgoingContent.ByteArrayContent() {
            override val headers: Headers = headersOf("X-Synthetic-Body", "preserved")
            override fun bytes(): ByteArray = byteArrayOf(1, 2, 3)
        }
        val budget = ControlBudget()
        val mock = MockEngine { data ->
            assertNull(data.headers[HttpHeaders.Cookie])
            assertSame(body, data.body)
            assertEquals("preserved", data.body.headers["X-Synthetic-Body"])
            assertEquals("preserved", data.attributes[marker])
            respond("anonymous")
        }
        withClient(mock, budget) { client, _ ->
            assertEquals("anonymous", withTimeout(5_000) {
                client.post(WATCH) {
                    header(HttpHeaders.Cookie, "SID=synthetic-account-value")
                    attributes.put(marker, "preserved")
                    setBody(body)
                }.bodyAsText()
            })
            assertNull(budget.failureCode())
        }
    }

    @Test(timeout = 15_000)
    fun sharedChildClientCannotBypassHostPolicy() = runBlocking {
        val calls = AtomicInteger()
        val budget = ControlBudget()
        val mock = MockEngine { calls.incrementAndGet(); respond("must not be reached") }
        withClient(mock, budget) { _, guard ->
            val child = HttpClient(guard)
            try { expectGuardFailure { child.get("https://example.com/watch").bodyAsText() } }
            finally { child.close() }
            assertEquals("HOST_POLICY", budget.failureCode())
            assertEquals(0, calls.get())
        }
    }

    @Test(timeout = 15_000)
    fun accessRejectionIsStickyAndRequestCapDoesNotStartExtraCalls() = runBlocking {
        for (accessError in listOf(false, true)) {
            val calls = AtomicInteger()
            val budget = ControlBudget(maxRequests = 1)
            val mock = MockEngine {
                calls.incrementAndGet()
                respond("", if (accessError) HttpStatusCode.Forbidden else HttpStatusCode.OK)
            }
            withClient(mock, budget) { client, _ ->
                if (accessError) expectGuardFailure { client.get(WATCH).bodyAsText() }
                else assertEquals("", withTimeout(5_000) { client.get(WATCH).bodyAsText() })
                expectGuardFailure { client.get(WATCH).bodyAsText() }
                assertEquals(if (accessError) "ACCESS_403" else "REQUEST_CAP", budget.failureCode())
                assertEquals(1, calls.get())
                assertEquals(1, budget.snapshot()["requests"])
            }
        }
    }

    @Test(timeout = 15_000)
    fun controlRedirectRejectsBeforeBodyAndNeverFollowsOrExposesItsLocation() = runBlocking {
        val raw = ByteChannel(autoFlush = true)
        val calls = AtomicInteger()
        val budget = ControlBudget()
        val mock = MockEngine {
            calls.incrementAndGet()
            respond(raw, HttpStatusCode.Found,
                headersOf(HttpHeaders.Location, "https://signed.invalid/private?token=synthetic-private"))
        }
        withClient(mock, budget) { client, _ ->
            expectGuardFailure { client.prepareGet(WATCH).execute { it.bodyAsText() } }
            assertEquals("CONTROL_REDIRECT_UNSUPPORTED", budget.failureCode())
            assertEquals(1, calls.get())
            assertEquals(1, budget.snapshot()["requests"])
            assertEquals(0L, budget.snapshot()["responseBodyBytes"])
            assertTrue(raw.isClosedForRead)
            assertFalse(budget.snapshot().toString().contains("synthetic-private"))
        }
    }

    private suspend fun withClient(
        mock: MockEngine,
        budget: ControlBudget,
        block: suspend (HttpClient, ControlPlaneEngine) -> Unit,
    ) {
        val guard = ControlPlaneEngine(mock, budget)
        val client = HttpClient(guard) { expectSuccess = false; followRedirects = false }
        try { block(client, guard) }
        finally { client.close(); guard.abort() }
    }

    private suspend fun expectGuardFailure(block: suspend () -> Unit) {
        val failure = runCatching { withTimeout(5_000) { block() } }.exceptionOrNull()
        assertTrue("Expected a policy/body failure", failure != null)
        assertFalse("A timeout must not pass as an intentional guard rejection", failure is TimeoutCancellationException)
    }

    private fun hasRequestTimeout(failure: Throwable?): Boolean {
        var current = failure
        repeat(8) {
            if (current is HttpRequestTimeoutException) return true
            current = current?.cause
        }
        return false
    }

    private companion object {
        const val WATCH = "https://www.youtube.com/watch?v=synthetic00"
    }
}
