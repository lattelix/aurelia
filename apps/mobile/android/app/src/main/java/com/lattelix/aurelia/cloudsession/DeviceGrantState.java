package com.lattelix.aurelia.cloudsession;

/** Only the pending, short-lived device grant lives here. Never persisted or returned to JS. */
final class DeviceGrantState {
    interface Clock { long now(); }
    private final Clock clock;
    private long generation, expiresAt, nextPoll, nextSendAt, backoffVersion;
    private int interval = 3;
    private String deviceCode, verifier;
    DeviceGrantState(Clock clock) { this.clock = clock; }
    synchronized long reset() { generation++; deviceCode = null; verifier = null; expiresAt = clock.now() + 600_000; return generation; }
    synchronized boolean current(long value) { return generation == value && clock.now() < expiresAt; }
    synchronized boolean install(long value, String code, String proof) {
        if (!current(value) || clock.now() >= expiresAt) return false;
        deviceCode = code; verifier = proof; interval = 3;
        nextPoll = clock.now() + 3_000; nextSendAt = nextPoll; return true;
    }
    synchronized Poll poll() {
        if (deviceCode == null || clock.now() >= expiresAt) { deviceCode = null; verifier = null; return null; }
        if (clock.now() < nextPoll) return new Poll(generation, null, null, backoffVersion);
        nextPoll = clock.now() + interval * 1000L;
        return new Poll(generation, deviceCode, verifier, backoffVersion);
    }
    synchronized boolean canSend(Poll poll) {
        if (!current(poll.generation) || poll.backoffVersion != backoffVersion ||
            poll.deviceCode == null || deviceCode == null || clock.now() < nextSendAt) return false;
        // JS reservations may accumulate while the serial worker is busy. Enforce
        // the interval at actual send admission as well as at queue admission.
        nextSendAt = clock.now() + interval * 1000L;
        return true;
    }
    synchronized void slowDown(long value) {
        if (current(value)) {
            interval = Math.min(60, interval + 5); nextPoll = clock.now() + interval * 1000L;
            nextSendAt = nextPoll; backoffVersion++;
        }
    }
    static final class Poll {
        final long generation, backoffVersion; final String deviceCode, verifier;
        Poll(long generation, String deviceCode, String verifier, long backoffVersion) {
            this.generation = generation; this.deviceCode = deviceCode; this.verifier = verifier; this.backoffVersion = backoffVersion;
        }
        @Override public String toString() { return "CloudGrant(redacted)"; }
    }
}
