package com.lattelix.aurelia.source

import java.util.concurrent.atomic.AtomicBoolean

/** Delivered HTTP body bytes, not TLS/header/socket-prefetch traffic. Reservations prevent concurrent overshoot. */
internal class ControlBudget(
    private val maxBytes: Long = SourcePolicy.BYTE_CAP,
    private val maxRequests: Int = SourcePolicy.REQUEST_CAP,
) {
    private var bytes = 0L
    private var reserved = 0L
    private var control = 0L
    private var media = 0L
    private var requests = 0
    private val statuses = mutableListOf<Int>()
    private var failure: String? = null
    private val attempts = mutableListOf<MutableMap<String, Any>>()
    private val attemptStarts = mutableListOf<Long>()
    val aborted = AtomicBoolean(false)

    @Synchronized fun request() {
        failure?.let { throw SourceFailure(it) }
        if (aborted.get()) throw SourceFailure("CANCELLED")
        if (requests >= maxRequests) fail("REQUEST_CAP")
        requests++
    }
    @Synchronized fun reserve(wanted: Int): Int {
        failure?.let { throw SourceFailure(it) }
        if (aborted.get()) throw SourceFailure("CANCELLED")
        val available = maxBytes - bytes - reserved
        if (available <= 0) fail("BODY_BYTE_CAP")
        val size = minOf(wanted.toLong(), available).toInt()
        reserved += size
        return size
    }
    @Synchronized fun settle(reservation: Int, actual: Int, isMedia: Boolean) {
        reserved -= reservation
        if (actual > 0) {
            bytes += actual
            if (isMedia) media += actual else control += actual
        }
    }
    @Synchronized fun fail(code: String): Nothing { failure = failure ?: code; throw SourceFailure(failure!!) }
    @Synchronized fun failureCode(): String? = failure
    @Synchronized fun status(value: Int) { statuses.add(value) }
    @Synchronized fun hasResponse(): Boolean = statuses.isNotEmpty()
    @Synchronized fun beginAttempt(method: String, host: String, path: String): Int {
        attempts.add(mutableMapOf("attempt" to attempts.size + 1, "method" to method,
            "hostCategory" to host, "pathKind" to path, "stage" to "delegate_started", "elapsedMs" to 0L))
        attemptStarts.add(System.nanoTime())
        return attempts.lastIndex
    }
    @Synchronized fun trace(index: Int, stage: String, status: Int? = null, failure: Throwable? = null) {
        val record = attempts.getOrNull(index) ?: return
        record["stage"] = stage
        record["elapsedMs"] = maxOf(0L, (System.nanoTime() - attemptStarts[index]) / 1_000_000)
        if (status != null) record["httpStatus"] = status
        if (failure != null) record.putAll(FailureTrace.describe(failure))
    }
    @Synchronized fun declaredLength(index: Int, value: Long?, head: Boolean) {
        val record = attempts.getOrNull(index) ?: return
        record["declaredLengthKnown"] = value != null
        if (value != null) record["declaredContentLength"] = value
        record["headRequest"] = head
    }
    @Synchronized fun bodyTrace(index: Int, read: Long, forwarded: Long, eof: Boolean, stage: String) {
        val record = attempts.getOrNull(index) ?: return
        record["bodyBytesRead"] = read
        record["bodyBytesForwarded"] = forwarded
        record["eofObserved"] = eof
        record["stage"] = stage
        record["elapsedMs"] = maxOf(0L, (System.nanoTime() - attemptStarts[index]) / 1_000_000)
    }
    @Synchronized fun snapshot(): Map<String, Any> = mapOf(
        "responseBodyBytes" to bytes, "controlBodyBytes" to control, "mediaBodyBytes" to media,
        "requests" to requests, "bodyByteCap" to maxBytes,
        "requestCap" to maxRequests,
        "httpStatuses" to statuses.toList(),
        "attempts" to attempts.map { it.toMap() },
    )
}
