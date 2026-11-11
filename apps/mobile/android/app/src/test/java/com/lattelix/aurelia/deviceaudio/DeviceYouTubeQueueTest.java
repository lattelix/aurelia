package com.lattelix.aurelia.deviceaudio;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.Test;

public class DeviceYouTubeQueueTest {
    @Test
    public void youtubeRequiresFeatureGateAndExternalIdentityIsSeparateFromTrackIdentity() throws Exception {
        Map<String, Object> input = youtubeRequest();
        assertEquals(DeviceAudioException.SOURCE_UNVERIFIED,
            assertThrows(DeviceAudioException.class, () -> DeviceAudioValidator.loadRequest(input)).code());
        DeviceQueueEntry entry = DeviceAudioValidator.loadRequest(input, true).tracks().get(0);
        assertEquals("youtube", entry.provider());
        assertEquals("d624349f-75c9-4e85-97d1-843fa35e2572", entry.trackId());
        assertEquals("aqz-KE-bpKQ", entry.externalId());
        // The old constructor is still the exact Studio contract.
        assertEquals("studio", new DeviceQueueEntry(entry.entryId(), "studio:afterglow-1", "1", "", "").provider());
    }

    @Test
    public void rejectsUrlsPathsUnknownFieldsAndMalformedYouTubeIds() {
        for (String id : new String[] { "short", "aqz-KE-bpKQ?", "https://youtube.test/id", "../abcdefgh", "a/bcdefghij" }) {
            Map<String, Object> input = youtubeRequest();
            row(input).put("externalId", id);
            assertInvalid(input);
        }
        for (String key : new String[] { "trackId", "title", "artist" }) {
            Map<String, Object> input = youtubeRequest();
            row(input).put(key, "https://example.test/signed?token=private");
            assertInvalid(input);
        }
        Map<String, Object> extra = youtubeRequest();
        row(extra).put("headers", new LinkedHashMap<>());
        assertInvalid(extra);
        Map<String, Object> unknown = youtubeRequest();
        row(unknown).put("provider", "filesystem");
        assertEquals(DeviceAudioException.UNAVAILABLE,
            assertThrows(DeviceAudioException.class, () -> DeviceAudioValidator.loadRequest(unknown, true)).code());
    }

    @Test
    public void supportsMixedProvidersButPreservesStudioCanonicalMappingAndGlobal500Limit() throws Exception {
        Map<String, Object> input = youtubeRequest();
        List<Object> tracks = new ArrayList<>();
        tracks.add(row(input));
        for (int index = 1; index < 500; index++) {
            Map<String, Object> studio = new LinkedHashMap<>(row(DeviceAudioValidatorTest.validRequest()));
            studio.put("entryId", String.format(java.util.Locale.ROOT, "22222222-2222-4222-8222-%012d", index));
            tracks.add(studio);
        }
        input.put("tracks", tracks);
        assertEquals(500, DeviceAudioValidator.loadRequest(input, true).tracks().size());
        tracks.add(new LinkedHashMap<>(row(DeviceAudioValidatorTest.validRequest())));
        assertInvalid(input);
        Map<String, Object> badStudio = DeviceAudioValidatorTest.validRequest();
        row(badStudio).put("trackId", "opaque-track");
        assertInvalid(badStudio);
    }

    @Test
    public void pausedRestoreRetainsIdsAndPositionWithoutPlaybackIntentOrLeaseFields() throws Exception {
        Map<String, Object> input = youtubeRequest();
        input.put("playing", true);
        DeviceAudioState state = new DeviceAudioState();
        state.restorePaused(DeviceAudioValidator.loadRequest(input, true), "restore:new-owner-revision");
        DeviceQueueRequest restored = state.restoreRequest();
        assertFalse(restored.playing());
        assertEquals(12.5, restored.position(), 0);
        assertEquals("paused", state.snapshot().status());
        assertEquals("youtube", restored.tracks().get(0).provider());
        assertEquals("aqz-KE-bpKQ", restored.tracks().get(0).externalId());
        assertEquals(6, restored.tracks().get(0).toMap().size());
        String encoded = state.snapshot().toMap().toString();
        assertFalse(encoded.contains("://"));
        assertFalse(encoded.contains("headers"));
        assertFalse(encoded.contains("lease"));
        assertEquals(DeviceAudioException.STALE_REVISION,
            assertThrows(DeviceAudioException.class, () -> state.play("revision:1")).code());
    }

    @Test
    public void errorsContainOnlyFixedContractCodes() throws Exception {
        String sensitive = "https://example.test/audio?token=private";
        DeviceAudioException exception = new DeviceAudioException(sensitive);
        assertEquals(DeviceAudioException.UNAVAILABLE, exception.getMessage());
        DeviceAudioState state = new DeviceAudioState();
        state.replace(DeviceAudioValidator.loadRequest(youtubeRequest(), true));
        state.fail(sensitive);
        assertEquals(DeviceAudioException.PLAYBACK_FAILED, state.snapshot().error());
        assertFalse(state.snapshot().toMap().toString().contains(sensitive));
    }

    static Map<String, Object> youtubeRequest() {
        Map<String, Object> input = DeviceAudioValidatorTest.validRequest();
        row(input).put("provider", "youtube");
        row(input).put("trackId", "d624349f-75c9-4e85-97d1-843fa35e2572");
        row(input).put("externalId", "aqz-KE-bpKQ");
        return input;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> row(Map<String, Object> input) {
        return (Map<String, Object>) ((List<?>) input.get("tracks")).get(0);
    }

    private static void assertInvalid(Map<String, Object> input) {
        assertEquals(DeviceAudioException.INVALID_REQUEST,
            assertThrows(DeviceAudioException.class, () -> DeviceAudioValidator.loadRequest(input, true)).code());
    }
}
