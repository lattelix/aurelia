package com.lattelix.aurelia.deviceaudio;

import android.os.Bundle;
import com.getcapacitor.JSObject;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Explicit serialization boundary. It never serializes a URI, path, credential, or signed URL. */
public final class DeviceAudioBundleCodec {
    private DeviceAudioBundleCodec() {}

    public static Map<String, Object> jsonObjectToMap(JSONObject object) throws DeviceAudioException {
        try {
            Map<String, Object> result = new LinkedHashMap<>();
            java.util.Iterator<String> keys = object.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                result.put(key, jsonValue(object.get(key)));
            }
            return result;
        } catch (JSONException error) {
            throw new DeviceAudioException(DeviceAudioException.INVALID_REQUEST);
        }
    }

    public static Map<String, Object> bundleToMap(Bundle bundle) throws DeviceAudioException {
        Map<String, Object> result = new LinkedHashMap<>();
        for (String key : bundle.keySet()) result.put(key, bundleValue(bundle.get(key)));
        return result;
    }

    public static Bundle loadRequestToBundle(DeviceQueueRequest request) {
        Bundle bundle = new Bundle();
        bundle.putString("ownerId", request.ownerId());
        bundle.putString("revision", request.revision());
        ArrayList<Bundle> rows = new ArrayList<>(request.tracks().size());
        for (DeviceQueueEntry entry : request.tracks()) rows.add(entryToBundle(entry));
        bundle.putParcelableArrayList("tracks", rows);
        bundle.putInt("index", request.index());
        bundle.putDouble("position", request.position());
        bundle.putBoolean("playing", request.playing());
        bundle.putString("repeat", request.repeat());
        bundle.putBoolean("shuffle", request.shuffle());
        bundle.putDouble("volume", request.volume());
        return bundle;
    }

    public static Bundle snapshotToBundle(DeviceAudioSnapshot snapshot) {
        Bundle bundle = new Bundle();
        bundle.putInt("apiVersion", 1);
        bundle.putString("transport", "device");
        bundle.putString("ownerId", snapshot.ownerId());
        bundle.putString("revision", snapshot.revision());
        bundle.putLong("sequence", snapshot.sequence());
        if (snapshot.index() == null) bundle.putString("index", null);
        else bundle.putInt("index", snapshot.index());
        bundle.putString("entryId", snapshot.entryId());
        bundle.putString("trackId", snapshot.trackId());
        bundle.putDouble("position", snapshot.position());
        bundle.putDouble("duration", snapshot.duration());
        bundle.putString("status", snapshot.status());
        bundle.putBoolean("playing", snapshot.playing());
        bundle.putString("repeat", snapshot.repeat());
        bundle.putBoolean("shuffle", snapshot.shuffle());
        bundle.putDouble("volume", snapshot.volume());
        bundle.putString("error", snapshot.error());
        ArrayList<Bundle> rows = new ArrayList<>(snapshot.queue().size());
        for (DeviceQueueEntry entry : snapshot.queue()) rows.add(entryToBundle(entry));
        bundle.putParcelableArrayList("queue", rows);
        return bundle;
    }

    public static Bundle mutationToBundle(DeviceQueueMutation mutation) {
        Bundle bundle = new Bundle();
        bundle.putString("ownerId", mutation.ownerId());
        bundle.putString("expectedRevision", mutation.expectedRevision());
        bundle.putString("revision", mutation.revision());
        ArrayList<Bundle> rows = new ArrayList<>();
        for (DeviceQueueEntry entry : mutation.tracks()) rows.add(entryToBundle(entry));
        bundle.putParcelableArrayList("tracks", rows);
        return bundle;
    }

    public static JSObject snapshotBundleToJs(Bundle bundle) throws DeviceAudioException {
        JSObject result = new JSObject();
        for (Map.Entry<String, Object> entry : bundleToMap(bundle).entrySet()) {
            try {
                result.putSafe(entry.getKey(), jsonCompatible(entry.getValue()));
            } catch (JSONException error) {
                throw new DeviceAudioException(DeviceAudioException.INVALID_REQUEST);
            }
        }
        return result;
    }

    public static String requestToJson(DeviceQueueRequest request) {
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("ownerId", request.ownerId());
        value.put("revision", request.revision());
        List<Map<String, Object>> rows = new ArrayList<>(request.tracks().size());
        for (DeviceQueueEntry entry : request.tracks()) rows.add(entry.toMap());
        value.put("tracks", rows);
        value.put("index", request.index());
        value.put("position", request.position());
        value.put("playing", false);
        value.put("repeat", request.repeat());
        value.put("shuffle", request.shuffle());
        value.put("volume", request.volume());
        return new JSONObject(value).toString();
    }

    private static Bundle entryToBundle(DeviceQueueEntry entry) {
        Bundle bundle = new Bundle();
        bundle.putString("entryId", entry.entryId().toString());
        bundle.putString("trackId", entry.trackId());
        bundle.putString("provider", entry.provider());
        bundle.putString("externalId", entry.externalId());
        bundle.putString("title", entry.title());
        bundle.putString("artist", entry.artist());
        return bundle;
    }

    private static Object jsonValue(Object value) throws JSONException, DeviceAudioException {
        if (value == JSONObject.NULL) return null;
        if (value instanceof JSONObject) return jsonObjectToMap((JSONObject) value);
        if (value instanceof JSONArray) {
            JSONArray array = (JSONArray) value;
            List<Object> rows = new ArrayList<>(array.length());
            for (int index = 0; index < array.length(); index++) rows.add(jsonValue(array.get(index)));
            return rows;
        }
        if (value instanceof String || value instanceof Number || value instanceof Boolean) return value;
        throw new DeviceAudioException(DeviceAudioException.INVALID_REQUEST);
    }

    private static Object bundleValue(Object value) throws DeviceAudioException {
        if (value == null) return null;
        if (value instanceof Bundle) return bundleToMap((Bundle) value);
        if (value instanceof List<?>) {
            List<Object> result = new ArrayList<>(((List<?>) value).size());
            for (Object row : (List<?>) value) result.add(bundleValue(row));
            return result;
        }
        if (value instanceof String || value instanceof Number || value instanceof Boolean) return value;
        throw new DeviceAudioException(DeviceAudioException.INVALID_REQUEST);
    }

    private static Object jsonCompatible(Object value) throws JSONException {
        if (value == null) return JSONObject.NULL;
        if (value instanceof Map<?, ?>) {
            JSONObject object = new JSONObject();
            for (Map.Entry<?, ?> entry : ((Map<?, ?>) value).entrySet()) {
                object.put((String) entry.getKey(), jsonCompatible(entry.getValue()));
            }
            return object;
        }
        if (value instanceof List<?>) {
            JSONArray array = new JSONArray();
            for (Object row : (List<?>) value) array.put(jsonCompatible(row));
            return array;
        }
        return value;
    }
}
