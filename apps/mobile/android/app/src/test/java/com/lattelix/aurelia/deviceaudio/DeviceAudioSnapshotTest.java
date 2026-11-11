package com.lattelix.aurelia.deviceaudio;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.Test;

public class DeviceAudioSnapshotTest {
    @Test
    public void idleMapIncludesExplicitNullIdentityAndErrorFields() {
        assertEmptyMap(new DeviceAudioState().snapshot().toMap(), null, "unowned");
    }

    @Test
    public void emptyQueueMapRetainsOwnerAndIncludesNullCurrentEntryFields() {
        DeviceAudioState state = new DeviceAudioState();
        state.replace(request(Collections.emptyList()));

        assertEmptyMap(state.snapshot().toMap(), "owner-1", "revision:1");
    }

    @Test
    public void stopMapIncludesExplicitNullOwnerCurrentEntryAndErrorFields() throws Exception {
        DeviceAudioState state = new DeviceAudioState();
        state.replace(request(Collections.singletonList(entry())));
        state.fail(DeviceAudioException.PLAYBACK_FAILED);
        state.stop("superseded-1");

        assertEmptyMap(state.snapshot().toMap(), null, "superseded-1");
    }

    @Test
    public void snapshotQueueIsAnImmutableCopyWithIdsOnlyMetadata() {
        List<DeviceQueueEntry> queue = new ArrayList<>();
        DeviceQueueEntry entry = entry();
        queue.add(entry);
        DeviceAudioSnapshot snapshot = new DeviceAudioSnapshot(
            "owner-1", "revision:1", 2, 0, queue, 1, 72,
            "playing", "off", false, 0.75, null
        );
        queue.clear();

        assertEquals(1, snapshot.queue().size());
        assertThrows(UnsupportedOperationException.class, () -> snapshot.queue().clear());
        Map<String, Object> map = snapshot.toMap();
        assertEquals(0, map.get("index"));
        assertEquals(entry.entryId().toString(), map.get("entryId"));
        assertEquals(entry.trackId(), map.get("trackId"));
        assertEquals(Boolean.TRUE, map.get("playing"));
        assertTrue(map.containsKey("error"));
        assertNull(map.get("error"));
        Map<?, ?> row = (Map<?, ?>) ((List<?>) map.get("queue")).get(0);
        assertEquals(new HashSet<>(Arrays.asList(
            "entryId", "trackId", "provider", "externalId", "title", "artist"
        )), row.keySet());
        assertEquals("studio", row.get("provider"));
        assertEquals("1", row.get("externalId"));
    }

    private static void assertEmptyMap(Map<String, Object> map, String ownerId, String revision) {
        assertEquals(new HashSet<>(Arrays.asList(
            "apiVersion", "transport", "ownerId", "revision", "sequence", "index",
            "entryId", "trackId", "position", "duration", "status", "playing",
            "repeat", "shuffle", "volume", "error", "queue"
        )), map.keySet());
        assertTrue(map.containsKey("ownerId"));
        assertEquals(ownerId, map.get("ownerId"));
        assertEquals(revision, map.get("revision"));
        for (String key : Arrays.asList("index", "entryId", "trackId", "error")) {
            assertTrue("Missing required nullable snapshot field: " + key, map.containsKey(key));
            assertNull(map.get(key));
        }
        assertEquals(1, map.get("apiVersion"));
        assertEquals("device", map.get("transport"));
        assertEquals("idle", map.get("status"));
        assertEquals(Boolean.FALSE, map.get("playing"));
        assertEquals(0, ((List<?>) map.get("queue")).size());
        assertEquals(0, ((Number) map.get("position")).doubleValue(), 0);
        assertEquals(0, ((Number) map.get("duration")).doubleValue(), 0);
        assertFalse((Boolean) map.get("shuffle"));
    }

    private static DeviceQueueRequest request(List<DeviceQueueEntry> entries) {
        return new DeviceQueueRequest(
            "owner-1", "revision:1", entries, 0, 0, false, "off", false, 0.75
        );
    }

    private static DeviceQueueEntry entry() {
        return new DeviceQueueEntry(
            UUID.fromString("11111111-1111-4111-8111-111111111111"),
            "studio:afterglow-1", "1", "Golden Hour", "Aurelia Studio"
        );
    }
}
