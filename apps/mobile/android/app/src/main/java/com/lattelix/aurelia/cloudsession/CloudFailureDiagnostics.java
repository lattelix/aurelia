package com.lattelix.aurelia.cloudsession;

import java.io.IOException;
import java.net.ConnectException;
import java.net.NoRouteToHostException;
import java.net.ProtocolException;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;
import java.net.UnknownServiceException;
import java.util.IdentityHashMap;
import java.util.concurrent.TimeoutException;
import javax.net.ssl.SSLException;

/** Bounded typed categories only. Messages, stack traces and transport values are never read. */
final class CloudFailureDiagnostics {
    private static final int MAX_CAUSE_NODES = 8;

    private CloudFailureDiagnostics() {}

    static String code(Throwable error) {
        IdentityHashMap<Throwable, Boolean> seen = new IdentityHashMap<>();
        String specific = null;
        boolean io = false, state = false;
        Throwable current = error;
        for (int depth = 0; depth < MAX_CAUSE_NODES && current != null; depth++) {
            if (seen.put(current, Boolean.TRUE) != null) break;
            // CloudFailure already owns a fixed contract category. Do not infer one
            // from an upstream message or replace a policy/storage failure with IO.
            if (current instanceof CloudFailure) return ((CloudFailure) current).code;
            if (specific == null) {
                if (current instanceof UnknownHostException) specific = "cloud-network-dns";
                else if (current instanceof SSLException) specific = "cloud-network-tls";
                else if (current instanceof SocketTimeoutException || current instanceof TimeoutException)
                    specific = "cloud-network-timeout";
                else if (current instanceof ConnectException || current instanceof NoRouteToHostException)
                    specific = "cloud-network-connect";
                else if (current instanceof ProtocolException || current instanceof UnknownServiceException)
                    specific = "cloud-network-protocol";
            }
            if (current instanceof IOException) io = true;
            if (current instanceof IllegalStateException) state = true;
            if (depth == MAX_CAUSE_NODES - 1) break;
            try { current = current.getCause(); }
            catch (Throwable ignored) { break; }
        }
        if (specific != null) return specific;
        if (io) return "cloud-network-io";
        if (state) return "cloud-client-state";
        return "cloud-client-unexpected";
    }
}
