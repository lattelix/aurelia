package com.lattelix.aurelia.source

import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.SocketException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.io.IOException
import javax.net.ssl.SSLException
import javax.net.ssl.SSLHandshakeException
import javax.net.ssl.SSLPeerUnverifiedException
import kotlinx.coroutines.CancellationException

/** Converts at most eight transient causes into fixed categories/class names, never messages or instances. */
internal object FailureTrace {
    fun describe(failure: Throwable): Map<String, Any> {
        val classes = mutableListOf<String>()
        val categories = mutableListOf<String>()
        var current: Throwable? = failure
        val seen = java.util.IdentityHashMap<Throwable, Boolean>()
        repeat(8) {
            val cause = current ?: return@repeat
            if (seen.put(cause, true) != null) { current = null; return@repeat }
            val name = cause.javaClass.simpleName
                .takeIf { it.matches(Regex("^[A-Za-z_][A-Za-z0-9_$]{0,79}$")) } ?: "OtherThrowable"
            classes.add(name)
            val category = when {
                cause is UnknownHostException -> "DNS"
                cause is SSLPeerUnverifiedException -> "TLS_PEER"
                cause is SSLHandshakeException -> "TLS_HANDSHAKE"
                cause is SSLException -> "TLS"
                name == "ConnectTimeoutException" -> "CONNECT_TIMEOUT"
                cause is SocketTimeoutException || name == "SocketTimeoutException" -> "SOCKET_TIMEOUT"
                name == "HttpRequestTimeoutException" -> "REQUEST_TIMEOUT"
                name == "TimeoutCancellationException" -> "COROUTINE_TIMEOUT"
                cause is NoRouteToHostException -> "NO_ROUTE"
                cause is ConnectException -> "CONNECT"
                cause is SocketException -> "SOCKET"
                cause is CancellationException -> "CANCELLATION"
                cause is SourceFailure -> "POLICY"
                cause is IOException -> "IO"
                cause is IllegalArgumentException -> "ARGUMENT"
                cause is IllegalStateException -> "STATE"
                else -> "OTHER"
            }
            if (category !in categories) categories.add(category)
            current = cause.cause
        }
        return mapOf("causeClasses" to classes.toList(), "causeCategories" to categories.toList())
    }
}
