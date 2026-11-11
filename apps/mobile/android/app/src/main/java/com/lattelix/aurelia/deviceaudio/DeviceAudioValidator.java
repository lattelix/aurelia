package com.lattelix.aurelia.deviceaudio;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;

public final class DeviceAudioValidator {
    private static final Pattern REVISION = Pattern.compile("^[A-Za-z0-9:_-]{1,128}$");
    private static final Pattern YOUTUBE_ID = Pattern.compile("^[A-Za-z0-9_-]{11}$");
    private static final Pattern UUID_TEXT = Pattern.compile(
        "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
    );
    private static final Set<String> LOAD_KEYS = keys(
        "ownerId", "revision", "tracks", "index", "position", "playing", "repeat", "shuffle", "volume"
    );
    private static final Set<String> ENTRY_KEYS = keys(
        "entryId", "trackId", "provider", "externalId", "title", "artist"
    );
    private static final Set<String> REPEAT_MODES = keys("off", "all", "one");

    private DeviceAudioValidator() {}

    public static DeviceQueueRequest loadRequest(Map<String, Object> value) throws DeviceAudioException {
        return loadRequest(value, false);
    }

    public static DeviceQueueRequest loadRequest(Map<String, Object> value, boolean youtubeEnabled) throws DeviceAudioException {
        exactKeys(value, LOAD_KEYS);
        String ownerId = boundedString(value.get("ownerId"), 1, 160);
        if (looksLikeLocation(ownerId)) invalid();
        String revision = revision(value.get("revision"));
        Object rowsValue = value.get("tracks");
        if (!(rowsValue instanceof List<?>)) invalid();
        List<?> rows = (List<?>) rowsValue;
        if (rows.size() > 500) invalid();

        List<DeviceQueueEntry> tracks = new ArrayList<>(rows.size());
        Set<UUID> entryIds = new HashSet<>();
        for (Object rowValue : rows) {
            if (!(rowValue instanceof Map<?, ?>)) invalid();
            Map<String, Object> row = stringKeyMap((Map<?, ?>) rowValue);
            exactKeys(row, ENTRY_KEYS);
            String entryIdText = boundedString(row.get("entryId"), 36, 36);
            if (!UUID_TEXT.matcher(entryIdText).matches()) invalid();
            UUID entryId;
            try {
                entryId = UUID.fromString(entryIdText);
            } catch (IllegalArgumentException error) {
                throw new DeviceAudioException(DeviceAudioException.INVALID_REQUEST);
            }
            if (!entryIds.add(entryId)) invalid();

            String provider = boundedString(row.get("provider"), 1, 32);
            boolean youtube = "youtube".equals(provider);
            if (!"studio".equals(provider) && !(youtube && youtubeEnabled)) {
                throw new DeviceAudioException(
                    "youtube".equals(provider)
                        ? DeviceAudioException.SOURCE_UNVERIFIED
                        : DeviceAudioException.UNAVAILABLE
                );
            }
            String externalId = boundedString(row.get("externalId"), 1, youtube ? 11 : 2);
            String trackId = boundedString(row.get("trackId"), 1, 160);
            String title = boundedString(row.get("title"), 0, 500);
            String artist = boundedString(row.get("artist"), 0, 500);
            if (
                !(youtube ? YOUTUBE_ID.matcher(externalId).matches() : StudioCatalogue.matches(externalId, trackId))
                    || looksLikeLocation(externalId)
                    || looksLikeLocation(trackId)
                    || looksLikeLocation(title)
                    || looksLikeLocation(artist)
            ) invalid();
            tracks.add(new DeviceQueueEntry(entryId, trackId, provider, externalId, title, artist));
        }

        int index = integer(value.get("index"));
        if ((tracks.isEmpty() && index != 0) || (!tracks.isEmpty() && (index < 0 || index >= tracks.size()))) invalid();
        double position = boundedFinite(value.get("position"), 0, 86400);
        boolean playing = bool(value.get("playing"));
        String repeat = boundedString(value.get("repeat"), 3, 3);
        if (!REPEAT_MODES.contains(repeat)) invalid();
        boolean shuffle = bool(value.get("shuffle"));
        double volume = boundedFinite(value.get("volume"), 0, 1);
        return new DeviceQueueRequest(ownerId, revision, tracks, index, position, playing, repeat, shuffle, volume);
    }

    public static String revisionRequest(Map<String, Object> value) throws DeviceAudioException {
        exactKeys(value, Collections.singleton("revision"));
        return revision(value.get("revision"));
    }

    public static DeviceQueueMutation mutationRequest(Map<String, Object> value, boolean youtubeEnabled) throws DeviceAudioException {
        exactKeys(value, keys("ownerId", "expectedRevision", "revision", "tracks"));
        String expected = revision(value.get("expectedRevision"));
        String replacement = revision(value.get("revision"));
        if (expected.equals(replacement)) invalid();
        Map<String, Object> load = new java.util.LinkedHashMap<>();
        load.put("ownerId", value.get("ownerId"));
        load.put("revision", replacement);
        load.put("tracks", value.get("tracks"));
        load.put("index", 0);
        load.put("position", 0);
        load.put("playing", false);
        load.put("repeat", "off");
        load.put("shuffle", false);
        load.put("volume", 0);
        DeviceQueueRequest parsed = loadRequest(load, youtubeEnabled);
        return new DeviceQueueMutation(parsed.ownerId(), expected, replacement, parsed.tracks());
    }

    public static double seekRequest(Map<String, Object> value) throws DeviceAudioException {
        exactKeys(value, keys("revision", "position"));
        revision(value.get("revision"));
        return boundedFinite(value.get("position"), 0, 86400);
    }

    public static String repeatRequest(Map<String, Object> value) throws DeviceAudioException {
        exactKeys(value, keys("revision", "mode"));
        revision(value.get("revision"));
        String mode = boundedString(value.get("mode"), 3, 3);
        if (!REPEAT_MODES.contains(mode)) invalid();
        return mode;
    }

    public static boolean shuffleRequest(Map<String, Object> value) throws DeviceAudioException {
        exactKeys(value, keys("revision", "enabled"));
        revision(value.get("revision"));
        return bool(value.get("enabled"));
    }

    public static double volumeRequest(Map<String, Object> value) throws DeviceAudioException {
        exactKeys(value, keys("revision", "value"));
        revision(value.get("revision"));
        return boundedFinite(value.get("value"), 0, 1);
    }

    public static String revision(Object value) throws DeviceAudioException {
        String revision = boundedString(value, 1, 128);
        if (!REVISION.matcher(revision).matches()) invalid();
        return revision;
    }

    public static Map<String, Object> stringKeyMap(Map<?, ?> source) throws DeviceAudioException {
        java.util.LinkedHashMap<String, Object> result = new java.util.LinkedHashMap<>();
        for (Map.Entry<?, ?> entry : source.entrySet()) {
            if (!(entry.getKey() instanceof String)) invalid();
            result.put((String) entry.getKey(), entry.getValue());
        }
        return result;
    }

    private static void exactKeys(Map<String, Object> value, Set<String> expected) throws DeviceAudioException {
        if (!value.keySet().equals(expected)) invalid();
    }

    private static Set<String> keys(String... names) {
        return Collections.unmodifiableSet(new HashSet<>(Arrays.asList(names)));
    }

    private static String boundedString(Object value, int min, int max) throws DeviceAudioException {
        if (!(value instanceof String)) invalid();
        String text = (String) value;
        if (text.length() < min || text.length() > max) invalid();
        return text;
    }

    private static boolean bool(Object value) throws DeviceAudioException {
        if (!(value instanceof Boolean)) invalid();
        return (Boolean) value;
    }

    private static int integer(Object value) throws DeviceAudioException {
        if (!(value instanceof Number)) invalid();
        double number = ((Number) value).doubleValue();
        if (!Double.isFinite(number) || number != Math.rint(number) || number < Integer.MIN_VALUE || number > Integer.MAX_VALUE) {
            invalid();
        }
        return (int) number;
    }

    private static double boundedFinite(Object value, double min, double max) throws DeviceAudioException {
        if (!(value instanceof Number)) invalid();
        double number = ((Number) value).doubleValue();
        if (!Double.isFinite(number) || number < min || number > max) invalid();
        return number;
    }

    private static boolean looksLikeLocation(String value) {
        String lower = value.toLowerCase(java.util.Locale.ROOT);
        return lower.contains("://")
            || lower.startsWith("file:")
            || value.startsWith("/")
            || value.startsWith("\\")
            || value.contains("../")
            || value.contains("..\\");
    }

    private static void invalid() throws DeviceAudioException {
        throw new DeviceAudioException(DeviceAudioException.INVALID_REQUEST);
    }
}
