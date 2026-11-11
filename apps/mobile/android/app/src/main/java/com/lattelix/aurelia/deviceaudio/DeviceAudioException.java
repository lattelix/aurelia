package com.lattelix.aurelia.deviceaudio;

/** A sanitized contract failure. Messages never include caller-controlled values. */
public final class DeviceAudioException extends Exception {
    public static final String INVALID_REQUEST = "invalid-request";
    public static final String SOURCE_UNVERIFIED = "source-unverified";
    public static final String UNAVAILABLE = "unavailable";
    public static final String STALE_REVISION = "stale-revision";
    public static final String PLAYBACK_FAILED = "playback-failed";

    private final String code;

    public DeviceAudioException(String code) {
        super(sanitize(code));
        this.code = sanitize(code);
    }

    public String code() {
        return code;
    }

    private static String sanitize(String code) {
        if (INVALID_REQUEST.equals(code) || SOURCE_UNVERIFIED.equals(code) || UNAVAILABLE.equals(code)
            || STALE_REVISION.equals(code) || PLAYBACK_FAILED.equals(code)) return code;
        return UNAVAILABLE;
    }
}
