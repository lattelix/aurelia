package com.lattelix.aurelia.deviceaudio;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/** Canonical bundled Studio IDs. No caller-provided URI is ever accepted. */
public final class StudioCatalogue {
    private static final Map<String, String> TRACK_IDS;

    static {
        Map<String, String> ids = new LinkedHashMap<>();
        ids.put("1", "studio:afterglow-1");
        ids.put("2", "studio:afterglow-2");
        ids.put("3", "studio:afterglow-3");
        ids.put("4", "studio:blue-hours-1");
        ids.put("5", "studio:blue-hours-2");
        ids.put("6", "studio:blue-hours-3");
        ids.put("7", "studio:parallel-1");
        ids.put("8", "studio:parallel-2");
        ids.put("9", "studio:parallel-3");
        ids.put("10", "studio:still-life-1");
        ids.put("11", "studio:still-life-2");
        ids.put("12", "studio:still-life-3");
        TRACK_IDS = Collections.unmodifiableMap(ids);
    }

    private StudioCatalogue() {}

    public static Map<String, String> trackIds() {
        return TRACK_IDS;
    }

    public static boolean matches(String externalId, String trackId) {
        return trackId != null && trackId.equals(TRACK_IDS.get(externalId));
    }

    public static String assetUri(String externalId) {
        if (!TRACK_IDS.containsKey(externalId)) {
            throw new IllegalArgumentException("unknown-studio-track");
        }
        return "asset:///" + externalId + ".mp3";
    }
}
