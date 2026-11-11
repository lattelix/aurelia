package com.lattelix.aurelia.source

import java.util.concurrent.atomic.AtomicBoolean

/** Registrations must only mark state or dispatch cleanup; cancel() never performs socket IO. */
internal class CancellationToken {
    private val cancelled = AtomicBoolean(false)
    private val callbacks = LinkedHashSet<() -> Unit>()
    fun isCancelled(): Boolean = cancelled.get()
    fun check() { if (isCancelled()) throw SourceFailure("CANCELLED") }
    fun onCancel(action: () -> Unit): AutoCloseable {
        val already = synchronized(callbacks) { if (cancelled.get()) true else { callbacks.add(action); false } }
        if (already) try { action() } catch (_: Exception) { }
        return AutoCloseable { synchronized(callbacks) { callbacks.remove(action) } }
    }
    fun cancel() {
        val pending = synchronized(callbacks) {
            if (!cancelled.compareAndSet(false, true)) return
            callbacks.toList().also { callbacks.clear() }
        }
        pending.forEach { try { it() } catch (_: Exception) { } }
    }
}
