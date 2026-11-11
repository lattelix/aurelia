package com.lattelix.aurelia.source

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Message
import android.os.Messenger
import android.os.Process
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutionException
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicBoolean

/** Binding is lazy; only resolve() may start the private process, and never from Main. */
internal class ResolverClient(context: Context) : AutoCloseable {
    private val context = context.applicationContext
    private val main = Handler(Looper.getMainLooper())
    private val closed = AtomicBoolean(false)
    private val pending = ConcurrentHashMap<String, Pending>()
    private val admission = Semaphore(1, true)
    private var worker: Messenger? = null
    private var bound = false
    private val reply = Messenger(object : Handler(Looper.getMainLooper()) {
        override fun handleMessage(message: Message) {
            if (message.what != LeaseIpc.RESULT || message.sendingUid != Process.myUid()) return
            try {
                val result = message.data
                val id = result.getString("id") ?: return
                val request = pending[id] ?: return
                if (result.containsKey("error") && result.keySet() == setOf("id", "error")) {
                    request.future.completeExceptionally(SourceFailure(result.getString("error") ?: "IPC_FAILURE"))
                } else if (result.keySet() == setOf("id", "lease")) {
                    val lease = LeaseIpc.decode(result.getBundle("lease") ?: throw SourceFailure("IPC_FAILURE"), request.videoId)
                    request.future.complete(lease)
                } else request.future.completeExceptionally(SourceFailure("IPC_FAILURE"))
            } catch (_: Exception) { failAll("IPC_FAILURE") }
        }
    })
    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName, binder: IBinder) {
            if (closed.get()) { unbind(); return }
            worker = Messenger(binder)
            pending.values.forEach { send(it) }
        }
        override fun onServiceDisconnected(name: ComponentName) { worker = null; failAll("SOURCE_PROCESS_DIED") }
        override fun onBindingDied(name: ComponentName) { worker = null; failAll("SOURCE_PROCESS_DIED"); unbind() }
        override fun onNullBinding(name: ComponentName) { failAll("IPC_FAILURE"); unbind() }
    }
    private class Pending(val id: String, val videoId: String) {
        val future = CompletableFuture<NativeSourceLease>()
        val sent = AtomicBoolean(false)
    }

    fun resolve(videoId: String, cancellation: CancellationToken): NativeSourceLease {
        if (Looper.myLooper() == Looper.getMainLooper()) throw SourceFailure("INVALID_REQUEST")
        SourcePolicy.validateVideoId(videoId)
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(50)
        var admitted = false
        var request: Pending? = null
        var registration: AutoCloseable? = null
        try {
            while (!admitted) {
                checkActive(cancellation)
                if (System.nanoTime() >= deadline) throw SourceFailure("RESOLUTION_TIMEOUT")
                admitted = admission.tryAcquire(100, TimeUnit.MILLISECONDS)
            }
            checkActive(cancellation)
            val next = Pending(UUID.randomUUID().toString(), videoId)
            request = next
            pending[next.id] = next
            registration = cancellation.onCancel {
                next.future.completeExceptionally(SourceFailure("CANCELLED"))
                main.post { cancel(next.id) }
            }
            main.post {
                if (closed.get() || next.future.isDone) return@post
                if (worker != null) send(next)
                else if (!bound) {
                    bound = try { context.bindService(Intent(context, YouTubeResolverService::class.java), connection, Context.BIND_AUTO_CREATE) }
                    catch (_: SecurityException) { failAll("RESOLVER_BIND_SECURITY"); return@post }
                    catch (_: IllegalStateException) { failAll("RESOLVER_BIND_STATE"); return@post }
                    catch (_: Exception) { failAll("RESOLVER_BIND_FAILURE"); return@post }
                    if (!bound) failAll("RESOLVER_BIND_REJECTED")
                }
            }
            val remaining = deadline - System.nanoTime()
            if (remaining <= 0) throw SourceFailure("RESOLUTION_TIMEOUT")
            val lease = next.future.get(remaining, TimeUnit.NANOSECONDS)
            checkActive(cancellation)
            SourcePolicy.validateLease(lease, videoId)
            return lease
        } catch (_: TimeoutException) { throw SourceFailure("RESOLUTION_TIMEOUT") }
        catch (_: InterruptedException) { Thread.currentThread().interrupt(); throw SourceFailure("CANCELLED") }
        catch (failure: ExecutionException) { throw SourceFailure((failure.cause as? SourceFailure)?.code ?: "IPC_FAILURE") }
        finally {
            registration?.close()
            request?.let { next -> pending.remove(next.id, next); main.post { cancel(next.id) } }
            if (admitted) admission.release()
        }
    }

    private fun checkActive(cancellation: CancellationToken) {
        cancellation.check()
        if (closed.get()) throw SourceFailure("CANCELLED")
    }
    private fun send(request: Pending) {
        val service = worker ?: return
        if (closed.get() || request.future.isDone || !request.sent.compareAndSet(false, true)) return
        try {
            service.send(Message.obtain(null, LeaseIpc.RESOLVE).apply {
                replyTo = reply
                data = Bundle().apply { putString("id", request.id); putString("videoId", request.videoId) }
            })
        } catch (_: Exception) { request.future.completeExceptionally(SourceFailure("IPC_FAILURE")) }
    }
    private fun cancel(id: String) {
        try { worker?.send(Message.obtain(null, LeaseIpc.CANCEL).apply { data = Bundle().apply { putString("id", id) } }) }
        catch (_: Exception) { }
    }
    private fun failAll(code: String) { pending.values.forEach { it.future.completeExceptionally(SourceFailure(code)) } }
    private fun unbind() {
        worker = null
        if (bound) { bound = false; try { context.unbindService(connection) } catch (_: Exception) { } }
    }
    fun cancelAll() {
        failAll("CANCELLED")
        main.post { pending.keys.forEach { cancel(it) } }
    }
    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        val ids = pending.keys.toList()
        failAll("CANCELLED")
        main.post { ids.forEach { cancel(it) }; unbind() }
    }
}
