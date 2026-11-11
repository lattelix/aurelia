package com.lattelix.aurelia.source

import android.app.ActivityManager
import android.app.Application
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Message
import android.os.Messenger
import android.os.Process
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** Private same-UID bounded resolver. It never receives or persists account credentials. */
class YouTubeResolverService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val cleanup = Executors.newSingleThreadExecutor { Thread(it, "AureliaSourceCleanup").apply { isDaemon = true } }
    private val watchdog = Executors.newSingleThreadScheduledExecutor { Thread(it, "AureliaSourceDeadline").apply { isDaemon = true } }
    private val attempts = ConcurrentHashMap<String, Attempt>()
    private val destroyed = AtomicBoolean(false)
    private val endpoint = Messenger(object : Handler(Looper.getMainLooper()) {
        override fun handleMessage(message: Message) {
            if (message.sendingUid != Process.myUid() || !isOwnProcess()) return
            try {
                val request = message.data
                val id = request.getString("id") ?: return
                if (!id.matches(Regex("^[a-f0-9-]{36}$"))) return
                when (message.what) {
                    LeaseIpc.RESOLVE -> {
                        if (request.keySet() != setOf("id", "videoId")) return
                        val reply = message.replyTo ?: return
                        val videoId = request.getString("videoId") ?: return
                        SourcePolicy.validateVideoId(videoId)
                        start(id, videoId, reply)
                    }
                    LeaseIpc.CANCEL -> if (request.keySet() == setOf("id")) attempts[id]?.cancel()
                }
            } catch (_: Exception) { /* Ignore malformed own-UID messages without values/logs. */ }
        }
    })

    override fun onBind(intent: Intent): IBinder = endpoint.binder

    private inner class Attempt(val id: String, val reply: Messenger) {
        val resolver = ControlResolver()
        val cancelled = AtomicBoolean(false)
        @Volatile var job: Job? = null
        @Volatile var deadline: ScheduledFuture<*>? = null
        fun cancel() {
            cancelled.set(true)
            try { cleanup.execute {
                job?.cancel(CancellationException("CANCELLED"))
                try { resolver.abort() } catch (_: Exception) { }
            } } catch (_: Exception) { }
        }
    }

    private fun start(id: String, videoId: String, reply: Messenger) {
        if (destroyed.get() || attempts.size >= 2 || attempts.containsKey(id)) {
            send(reply, id, error = "SOURCE_BUSY"); return
        }
        val attempt = Attempt(id, reply)
        attempts[id] = attempt
        attempt.deadline = watchdog.schedule({
            // This executor is independent of Main and of a synchronous JS compiler/coroutine.
            if (attempts[id] === attempt && isOwnProcess()) Process.killProcess(Process.myPid())
        }, SourcePolicy.HARD_RESOLUTION_MS, TimeUnit.MILLISECONDS)
        attempt.job = scope.launch {
            try {
                val lease = attempt.resolver.resolve(videoId)
                if (!attempt.cancelled.get()) send(reply, id, lease)
            } catch (_: TimeoutCancellationException) {
                if (!attempt.cancelled.get()) send(reply, id, error = "RESOLUTION_TIMEOUT")
            } catch (_: CancellationException) {
                send(reply, id, error = "CANCELLED")
            } catch (failure: SourceFailure) {
                if (!attempt.cancelled.get()) send(reply, id, error = failure.code)
            } catch (_: Exception) {
                if (!attempt.cancelled.get()) send(reply, id, error = "CONTROL_SOURCE_UNAVAILABLE")
            } finally {
                // Retain the process deadline through socket cleanup, which must never run on Main.
                try { attempt.resolver.abort() } catch (_: Exception) { }
                attempts.remove(id, attempt)
                attempt.deadline?.cancel(false)
                if (destroyed.get() && attempts.isEmpty()) watchdog.shutdown()
            }
        }
    }

    private fun send(reply: Messenger, id: String, lease: NativeSourceLease? = null, error: String? = null) {
        try {
            val message = Message.obtain(null, LeaseIpc.RESULT)
            message.data = Bundle().apply {
                putString("id", id)
                if (lease != null) putBundle("lease", LeaseIpc.encode(lease))
                else putString("error", SourcePolicy.safeFailureCode(error ?: "SOURCE_UNAVAILABLE"))
            }
            reply.send(message)
        } catch (_: Exception) { /* A cancelled/dead client gets no retry or logging. */ }
    }

    private fun isOwnProcess(): Boolean {
        val name = if (Build.VERSION.SDK_INT >= 28) Application.getProcessName()
        else (getSystemService(ACTIVITY_SERVICE) as ActivityManager).runningAppProcesses
            ?.firstOrNull { it.pid == Process.myPid() && it.uid == Process.myUid() }?.processName
        return SourcePolicy.ownsResolverProcess(Process.myUid(), applicationInfo.uid, name, packageName)
    }

    override fun onDestroy() {
        destroyed.set(true)
        attempts.values.forEach { it.cancel() }
        try { cleanup.execute { scope.cancel() } } catch (_: Exception) { }
        cleanup.shutdown()
        if (attempts.isEmpty()) watchdog.shutdown()
        super.onDestroy()
    }
}
