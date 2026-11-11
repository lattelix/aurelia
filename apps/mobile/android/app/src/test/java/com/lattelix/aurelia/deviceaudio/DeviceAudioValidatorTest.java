package com.lattelix.aurelia.deviceaudio;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.Test;

public class DeviceAudioValidatorTest {
    @Test
    public void acceptsOnlyExactCanonicalStudioEntries() throws Exception {
        DeviceQueueRequest request = DeviceAudioValidator.loadRequest(validRequest());
        assertEquals("owner-1", request.ownerId());
        assertEquals("revision:1", request.revision());
        assertEquals("studio:afterglow-1", request.tracks().get(0).trackId());
        assertEquals(0, request.index());
    }

    @Test
    public void rejectsUnknownFieldsWrongTypesAndNonFiniteNumbers() {
        Map<String, Object> unknown = validRequest();
        unknown.put("mediaUrl", "asset:///1.mp3");
        assertCode(DeviceAudioException.INVALID_REQUEST, unknown);

        Map<String, Object> wrongType = validRequest();
        wrongType.put("playing", "true");
        assertCode(DeviceAudioException.INVALID_REQUEST, wrongType);

        Map<String, Object> nonFinite = validRequest();
        nonFinite.put("position", Double.NaN);
        assertCode(DeviceAudioException.INVALID_REQUEST, nonFinite);

        Map<String, Object> badBounds = validRequest();
        badBounds.put("volume", 1.01);
        assertCode(DeviceAudioException.INVALID_REQUEST, badBounds);
    }

    @Test
    public void rejectsDuplicatesMismatchesAndLocationSyntax() {
        Map<String, Object> duplicate = validRequest();
        List<Object> duplicateRows = new ArrayList<>((List<?>) duplicate.get("tracks"));
        duplicateRows.add(new LinkedHashMap<>((Map<String, Object>) duplicateRows.get(0)));
        duplicate.put("tracks", duplicateRows);
        assertCode(DeviceAudioException.INVALID_REQUEST, duplicate);

        Map<String, Object> mismatch = validRequest();
        firstRow(mismatch).put("trackId", "studio:parallel-1");
        assertCode(DeviceAudioException.INVALID_REQUEST, mismatch);

        Map<String, Object> path = validRequest();
        firstRow(path).put("title", "../1.mp3");
        assertCode(DeviceAudioException.INVALID_REQUEST, path);

        Map<String, Object> url = validRequest();
        firstRow(url).put("artist", "https://example.test/audio");
        assertCode(DeviceAudioException.INVALID_REQUEST, url);
    }

    @Test
    public void reportsUnsupportedProvidersWithSanitizedCodes() {
        Map<String, Object> youtube = validRequest();
        firstRow(youtube).put("provider", "youtube");
        assertCode(DeviceAudioException.SOURCE_UNVERIFIED, youtube);

        Map<String, Object> other = validRequest();
        firstRow(other).put("provider", "filesystem");
        assertCode(DeviceAudioException.UNAVAILABLE, other);
    }

    @Test
    public void acceptsBoundedQueueAndRejectsOverflowAndInvalidEmptyIndex() throws Exception {
        Map<String, Object> request = validRequest();
        List<Object> rows = new ArrayList<>();
        for (int index = 0; index < 500; index++) {
            Map<String, Object> row = new LinkedHashMap<>(firstRow(validRequest()));
            row.put("entryId", String.format(java.util.Locale.ROOT, "11111111-1111-4111-8111-%012d", index));
            rows.add(row);
        }
        request.put("tracks", rows);
        assertEquals(500, DeviceAudioValidator.loadRequest(request).tracks().size());
        rows.add(new LinkedHashMap<>(firstRow(validRequest())));
        assertCode(DeviceAudioException.INVALID_REQUEST, request);

        request.put("tracks", new ArrayList<>());
        assertEquals(0, DeviceAudioValidator.loadRequest(request).tracks().size());
        request.put("index", 1);
        assertCode(DeviceAudioException.INVALID_REQUEST, request);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> firstRow(Map<String, Object> request) {
        List<Object> rows = new ArrayList<>((List<Object>) request.get("tracks"));
        Map<String, Object> row = new LinkedHashMap<>((Map<String, Object>) rows.get(0));
        rows.set(0, row);
        request.put("tracks", rows);
        return row;
    }

    private static void assertCode(String code, Map<String, Object> value) {
        DeviceAudioException error = assertThrows(
            DeviceAudioException.class,
            () -> DeviceAudioValidator.loadRequest(value)
        );
        assertEquals(code, error.code());
    }

    static Map<String, Object> validRequest() {
        Map<String, Object> entry = new LinkedHashMap<>();
        entry.put("entryId", "11111111-1111-4111-8111-111111111111");
        entry.put("trackId", "studio:afterglow-1");
        entry.put("provider", "studio");
        entry.put("externalId", "1");
        entry.put("title", "Golden Hour");
        entry.put("artist", "Aurelia Studio");

        Map<String, Object> request = new LinkedHashMap<>();
        request.put("ownerId", "owner-1");
        request.put("revision", "revision:1");
        request.put("tracks", new ArrayList<>(List.of(entry)));
        request.put("index", 0);
        request.put("position", 12.5);
        request.put("playing", false);
        request.put("repeat", "off");
        request.put("shuffle", false);
        request.put("volume", 0.75);
        return request;
    }
}
