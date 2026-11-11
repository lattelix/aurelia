package com.lattelix.aurelia.deviceaudio;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.Test;

public class DeviceAudioStateTest {
    @Test
    public void rejectsStaleRevisionWithoutMutation() throws Exception {
        DeviceAudioState state = loadedState();
        DeviceAudioSnapshot before = state.snapshot();
        DeviceAudioException error = assertThrows(
            DeviceAudioException.class,
            () -> state.seek("revision:stale", 40)
        );
        assertEquals(DeviceAudioException.STALE_REVISION, error.code());
        assertEquals(before.sequence(), state.snapshot().sequence());
        assertEquals(before.position(), state.snapshot().position(), 0);
    }

    @Test
    public void invalidReplacementLeavesCurrentOwnershipAtomic() throws Exception {
        DeviceAudioState state = loadedState();
        DeviceAudioSnapshot before = state.snapshot();
        Map<String, Object> invalid = DeviceAudioValidatorTest.validRequest();
        invalid.put("revision", "replacement");
        ((Map<String, Object>) ((List<?>) invalid.get("tracks")).get(0)).put("externalId", "12");

        assertThrows(DeviceAudioException.class, () -> DeviceAudioValidator.loadRequest(invalid));
        DeviceAudioSnapshot after = state.snapshot();
        assertEquals(before.revision(), after.revision());
        assertEquals(before.entryId(), after.entryId());
        assertEquals(before.sequence(), after.sequence());
    }

    @Test
    public void restoreIsPausedAndRotatesRevision() throws Exception {
        DeviceQueueRequest original = DeviceAudioValidator.loadRequest(DeviceAudioValidatorTest.validRequest());
        DeviceAudioState state = new DeviceAudioState();
        state.restorePaused(original, "restore-22222222-2222-4222-8222-222222222222");

        DeviceAudioSnapshot snapshot = state.snapshot();
        assertEquals("paused", snapshot.status());
        assertFalse(snapshot.playing());
        assertNotEquals(original.revision(), snapshot.revision());
        assertEquals(original.ownerId(), snapshot.ownerId());
        assertEquals(original.tracks().get(0).entryId().toString(), snapshot.entryId());
    }

    @Test
    public void failureRemainsStableAcrossLatePlayerEvents() throws Exception {
        DeviceAudioState state = loadedState();
        state.fail(DeviceAudioException.PLAYBACK_FAILED);
        long failedSequence = state.snapshot().sequence();
        state.synchronize(0, 42, 72, "playing");
        state.pause("revision:1");

        DeviceAudioSnapshot snapshot = state.snapshot();
        assertEquals("failed", snapshot.status());
        assertEquals(DeviceAudioException.PLAYBACK_FAILED, snapshot.error());
        assertEquals(failedSequence, snapshot.sequence());
    }

    @Test
    public void validRetryClearsFailureButWaitsForPlayerConfirmation() throws Exception {
        DeviceAudioState state = loadedState();
        state.fail(DeviceAudioException.PLAYBACK_FAILED);
        state.play("revision:1");
        assertEquals("loading", state.snapshot().status());
        assertFalse(state.snapshot().playing());
        assertNull(state.snapshot().error());
        state.synchronize(0, 12, 72, "playing");
        assertEquals("playing", state.snapshot().status());
    }

    @Test
    public void staleRetryCannotClearFailureOrChangePosition() throws Exception {
        DeviceAudioState state = loadedState();
        state.fail(DeviceAudioException.PLAYBACK_FAILED);
        long sequence = state.snapshot().sequence();
        assertThrows(DeviceAudioException.class, () -> state.play("stale"));
        assertEquals("failed", state.snapshot().status());
        assertEquals(sequence, state.snapshot().sequence());
    }

    @Test
    public void replayAfterEndStartsAtZeroAndWaitsForPlayer() throws Exception {
        DeviceAudioState state = loadedState();
        state.synchronize(0, 72, 72, "ended");
        state.play("revision:1");
        assertEquals(0, state.snapshot().position(), 0);
        assertEquals("loading", state.snapshot().status());
    }

    @Test
    public void queueTransitionsRespectEndsAndRepeatAll() throws Exception {
        DeviceAudioState state = multiTrackState();
        state.next("revision:queue");
        assertEquals(1, state.snapshot().index().intValue());
        state.next("revision:queue");
        assertEquals("ended", state.snapshot().status());
        assertEquals(1, state.snapshot().index().intValue());

        state.setRepeat("revision:queue", "all");
        state.next("revision:queue");
        assertEquals(0, state.snapshot().index().intValue());
        state.previous("revision:queue");
        assertEquals(1, state.snapshot().index().intValue());
    }

    @Test
    public void stopInvalidatesOldCommandsAndClearsIdentity() throws Exception {
        DeviceAudioState state = loadedState();
        state.stop("superseded-1");
        DeviceAudioSnapshot snapshot = state.snapshot();
        assertNull(snapshot.ownerId());
        assertNull(snapshot.index());
        assertEquals("idle", snapshot.status());
        assertEquals(0, snapshot.queue().size());
        assertThrows(DeviceAudioException.class, () -> state.play("revision:1"));
    }

    @Test
    public void unownedSnapshotCanBeStoppedIdempotentlyButCannotPlay() throws Exception {
        DeviceAudioState state = new DeviceAudioState();
        assertEquals("unowned", state.snapshot().revision());
        state.requireStopRevision("unowned");
        state.stop("superseded-empty");
        assertThrows(DeviceAudioException.class, () -> state.play("superseded-empty"));
    }

    private static DeviceAudioState loadedState() throws Exception {
        DeviceAudioState state = new DeviceAudioState();
        state.replace(DeviceAudioValidator.loadRequest(DeviceAudioValidatorTest.validRequest()));
        return state;
    }

    @SuppressWarnings("unchecked")
    private static DeviceAudioState multiTrackState() throws Exception {
        Map<String, Object> request = DeviceAudioValidatorTest.validRequest();
        request.put("revision", "revision:queue");
        List<Object> rows = new ArrayList<>((List<Object>) request.get("tracks"));
        Map<String, Object> second = new LinkedHashMap<>((Map<String, Object>) rows.get(0));
        second.put("entryId", "22222222-2222-4222-8222-222222222222");
        second.put("trackId", "studio:afterglow-2");
        second.put("externalId", "2");
        second.put("title", "Weightless");
        rows.add(second);
        request.put("tracks", rows);
        DeviceAudioState state = new DeviceAudioState();
        state.replace(DeviceAudioValidator.loadRequest(request));
        return state;
    }
}
