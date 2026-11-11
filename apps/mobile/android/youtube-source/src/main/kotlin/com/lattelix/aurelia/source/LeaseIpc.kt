package com.lattelix.aurelia.source

import android.os.Bundle

/** Own-UID native IPC only; no Bundle from this protocol crosses the JS bridge. */
internal object LeaseIpc {
    const val RESOLVE = 1
    const val CANCEL = 2
    const val RESULT = 3
    fun encode(lease: NativeSourceLease): Bundle = Bundle().apply {
        putString("videoId", lease.videoId)
        putString("url", lease.audioUrl)
        putString("mime", lease.mimeType)
        putInt("itag", lease.itag)
        putLong("length", lease.contentLength)
        putLong("expires", lease.expiresAtMs)
        putParcelableArrayList("headers", ArrayList(lease.headers.map { (name, value) ->
            Bundle().apply { putString("name", name); putString("value", value) }
        }))
    }
    @Suppress("DEPRECATION")
    fun decode(bundle: Bundle, expectedVideoId: String): NativeSourceLease {
        if (bundle.keySet() != setOf("videoId", "url", "mime", "itag", "length", "expires", "headers"))
            throw SourceFailure("IPC_FAILURE")
        val rows = bundle.getParcelableArrayList<Bundle>("headers") ?: throw SourceFailure("IPC_FAILURE")
        if (rows.size > 16) throw SourceFailure("HEADER_POLICY")
        val headers = linkedMapOf<String, String>()
        for (row in rows) {
            if (row.keySet() != setOf("name", "value")) throw SourceFailure("IPC_FAILURE")
            val name = row.getString("name") ?: throw SourceFailure("HEADER_POLICY")
            val value = row.getString("value") ?: throw SourceFailure("HEADER_POLICY")
            if (headers.put(name, value) != null) throw SourceFailure("HEADER_POLICY")
        }
        val lease = NativeSourceLease(
            bundle.getString("videoId") ?: throw SourceFailure("IPC_FAILURE"),
            bundle.getString("url") ?: throw SourceFailure("IPC_FAILURE"), headers,
            bundle.getString("mime") ?: throw SourceFailure("IPC_FAILURE"),
            bundle.getInt("itag"), bundle.getLong("length"), bundle.getLong("expires"),
        )
        SourcePolicy.validateLease(lease, expectedVideoId)
        return lease
    }
}
