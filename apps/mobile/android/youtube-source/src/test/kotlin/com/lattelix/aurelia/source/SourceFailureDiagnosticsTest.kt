package com.lattelix.aurelia.source

import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.lang.reflect.Modifier
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.util.concurrent.TimeoutException
import javax.net.ssl.SSLHandshakeException

class SourceFailureDiagnosticsTest {
    private fun wrapped(error: Throwable, wrappers: Int): Throwable {
        var value = error
        repeat(wrappers) { value = RuntimeException("synthetic wrapper", value) }
        return value
    }

    @Test fun preservesOnlyValidatedSourceFailureCodesThroughWrappers() {
        for (code in listOf("SOURCE_EXPIRED", "ACCESS_403", "NETWORK_BODY_FAILURE", "CANCELLED", "IPC_FAILURE"))
            assertEquals(code, SourceFailureDiagnostics.code(IOException("synthetic wrapper", SourceFailure(code))))
        assertEquals("IO_FAILURE", SourceFailureDiagnostics.code(SourceFailure("https://signed.invalid/?token=synthetic")))
    }

    @Test fun neverInfersAnAllowedCodeFromExceptionMessages() {
        assertEquals("DIAGNOSTIC_UNKNOWN", SourceFailureDiagnostics.code(RuntimeException("ACCESS_403")))
        assertEquals("DIAGNOSTIC_IO", SourceFailureDiagnostics.code(IOException("SOURCE_EXPIRED")))
        val unreadableMessage = object : RuntimeException() {
            override val message: String get() = throw AssertionError("Diagnostic must not inspect message")
            override fun toString(): String = throw AssertionError("Diagnostic must not stringify exceptions")
        }
        assertEquals("DIAGNOSTIC_UNKNOWN", SourceFailureDiagnostics.code(unreadableMessage))
    }

    @Test fun classifiesKnownTypesAndPrefersSpecificCausesOverGenericWrappers() {
        for ((error, expected) in listOf(
            SocketTimeoutException("synthetic") to "DIAGNOSTIC_TIMEOUT",
            TimeoutException("synthetic") to "DIAGNOSTIC_TIMEOUT",
            UnknownHostException("synthetic.invalid") to "DIAGNOSTIC_DNS",
            SSLHandshakeException("synthetic") to "DIAGNOSTIC_TLS",
            IOException("synthetic") to "DIAGNOSTIC_IO",
            IllegalStateException("synthetic") to "DIAGNOSTIC_STATE",
        )) assertEquals(expected, SourceFailureDiagnostics.code(RuntimeException("wrapper", error)))
        assertEquals("DIAGNOSTIC_DNS", SourceFailureDiagnostics.code(IOException("wrapper", UnknownHostException("synthetic"))))
        assertEquals("DIAGNOSTIC_STATE", SourceFailureDiagnostics.code(IllegalStateException("synthetic")))
        assertEquals("SOURCE_EXPIRED", SourceFailureDiagnostics.code(SocketTimeoutException().apply {
            initCause(SourceFailure("SOURCE_EXPIRED"))
        }))
    }

    @Test fun stopsAtEightNodesWithoutReadingTheNinthCause() {
        assertEquals("ACCESS_403", SourceFailureDiagnostics.code(wrapped(SourceFailure("ACCESS_403"), 7)))
        assertEquals("DIAGNOSTIC_UNKNOWN", SourceFailureDiagnostics.code(wrapped(SourceFailure("ACCESS_403"), 8)))
        var reads = 0
        val last = object : RuntimeException() {
            override val cause: Throwable get() { reads++; throw AssertionError("Ninth cause must not be read") }
        }
        assertEquals("DIAGNOSTIC_UNKNOWN", SourceFailureDiagnostics.code(wrapped(last, 7)))
        assertEquals(0, reads)
    }

    @Test fun handlesNullAndCyclesByIdentityWithoutCallingThrowableEquality() {
        assertEquals("DIAGNOSTIC_UNKNOWN", SourceFailureDiagnostics.code(null))
        val selfCycle = object : RuntimeException() {
            override val cause: Throwable get() = this
            override fun equals(other: Any?): Boolean = throw AssertionError("Identity comparison required")
            override fun hashCode(): Int = throw AssertionError("Identity hash required")
        }
        assertEquals("DIAGNOSTIC_UNKNOWN", SourceFailureDiagnostics.code(selfCycle))
        val first = RuntimeException()
        val second = IOException()
        first.initCause(second); second.initCause(first)
        assertEquals("DIAGNOSTIC_IO", SourceFailureDiagnostics.code(first))
        val hostileWrapper = object : RuntimeException() {
            override val cause: Throwable get() = SourceFailure("CANCELLED")
            override fun equals(other: Any?): Boolean = true
            override fun hashCode(): Int = 0
        }
        assertEquals("CANCELLED", SourceFailureDiagnostics.code(hostileWrapper))
    }

    @Test fun safelyHandlesAnUnreadableCause() {
        val error = object : IllegalStateException() {
            override val cause: Throwable get() = throw AssertionError("synthetic getter failure")
        }
        assertEquals("DIAGNOSTIC_STATE", SourceFailureDiagnostics.code(error))
    }

    @Test fun exposesANullSafePublicStaticJavaEntryPoint() {
        val method = AndroidYouTubeSourceFactory::class.java.getDeclaredMethod("diagnosticFailureCode", Throwable::class.java)
        assertTrue(Modifier.isPublic(method.modifiers))
        assertTrue(Modifier.isStatic(method.modifiers))
        assertEquals(String::class.java, method.returnType)
        assertEquals("DIAGNOSTIC_UNKNOWN", method.invoke(null, *arrayOfNulls<Any>(1)))
    }
}
