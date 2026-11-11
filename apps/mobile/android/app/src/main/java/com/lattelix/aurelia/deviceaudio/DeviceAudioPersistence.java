package com.lattelix.aurelia.deviceaudio;

import android.content.Context;
import android.content.SharedPreferences;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import org.json.JSONObject;

/** Private, bounded IDs/metadata-only resume state; source URLs/leases never enter it. */
public final class DeviceAudioPersistence {
    private static final String PREFERENCES = "aurelia-device-audio";
    private static final String SNAPSHOT = "paused-snapshot-v1";
    // Fits 500 entries even when every 500-character title/artist needs JSON escaping.
    private static final int MAX_BYTES = 4 * 1024 * 1024;
    private final SharedPreferences preferences;

    public DeviceAudioPersistence(Context context) {
        preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }

    public DeviceQueueRequest restore() {
        String encoded = preferences.getString(SNAPSHOT, null);
        if (encoded == null) return null;
        if (exceedsLimit(encoded)) {
            clear();
            return null;
        }
        try {
            Map<String, Object> value = DeviceAudioBundleCodec.jsonObjectToMap(new JSONObject(encoded));
            return DeviceAudioValidator.loadRequest(value, NativeFeaturePolicy.youtubeEnabled());
        } catch (Exception error) {
            clear();
            return null;
        }
    }

    public void save(DeviceQueueRequest request) {
        if (request == null || request.tracks().isEmpty()) {
            clear();
            return;
        }
        String encoded = DeviceAudioBundleCodec.requestToJson(request);
        if (exceedsLimit(encoded)) {
            clear();
            return;
        }
        preferences.edit().putString(SNAPSHOT, encoded).apply();
    }

    public void clear() {
        preferences.edit().remove(SNAPSHOT).apply();
    }

    private static boolean exceedsLimit(String encoded) {
        return encoded.length() > MAX_BYTES || encoded.getBytes(StandardCharsets.UTF_8).length > MAX_BYTES;
    }
}
