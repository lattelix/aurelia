package com.lattelix.aurelia.source

import java.io.IOException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.util.IdentityHashMap
import java.util.concurrent.TimeoutException
import javax.net.ssl.SSLException

/** Bounded, message-free classification. Never reads URLs, headers, bodies or stack traces. */
internal object SourceFailureDiagnostics {
    private const val MAX_CHAIN_NODES = 8

    fun code(error: Throwable?): String {
        val seen = IdentityHashMap<Throwable, Boolean>()
        var current = error
        var specific: String? = null
        var generic: String? = null
        fun result(): String = specific ?: generic ?: "DIAGNOSTIC_UNKNOWN"
        for (depth in 0 until MAX_CHAIN_NODES) {
            val candidate = current ?: return result()
            if (seen.put(candidate, true) != null) return result()
            // SourceFailure owns a separately validated enum, never infer one from a message.
            if (candidate is SourceFailure) return SourcePolicy.safeFailureCode(candidate.code)
            when (candidate) {
                is SocketTimeoutException, is TimeoutException ->
                    if (specific == null) specific = "DIAGNOSTIC_TIMEOUT"
                is UnknownHostException ->
                    if (specific == null) specific = "DIAGNOSTIC_DNS"
                is SSLException ->
                    if (specific == null) specific = "DIAGNOSTIC_TLS"
                is IOException -> generic = "DIAGNOSTIC_IO"
                is IllegalStateException ->
                    if (generic == null) generic = "DIAGNOSTIC_STATE"
            }
            if (depth == MAX_CHAIN_NODES - 1) return result()
            current = try { candidate.cause } catch (_: Throwable) { return result() }
        }
        return result()
    }
}
