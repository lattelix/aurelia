package com.lattelix.aurelia.source

/** Native memory/own-UID IPC only. Never attach this value to a queue or event. */
internal data class NativeSourceLease(
    val videoId: String,
    val audioUrl: String,
    val headers: Map<String, String>,
    val mimeType: String,
    val itag: Int,
    val contentLength: Long,
    val expiresAtMs: Long,
) {
    fun expired(nowMs: Long = System.currentTimeMillis()): Boolean = expiresAtMs - nowMs <= 5_000
    override fun toString(): String = "NativeSourceLease(redacted)"
}
