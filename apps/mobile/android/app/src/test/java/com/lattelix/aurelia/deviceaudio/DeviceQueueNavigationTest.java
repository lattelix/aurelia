package com.lattelix.aurelia.deviceaudio;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;
import java.util.UUID;
import org.junit.Test;

public class DeviceQueueNavigationTest {
    private static final String REVISION = "queue:recovery";

    @Test
    public void nextAfterFatalSourceFailureMovesSnapshotBeforeAPlayCanRebuildTheOldItem() throws Exception {
        DeviceAudioState state = state(0);
        state.fail(DeviceAudioException.PLAYBACK_FAILED);
        Playback playback = new Playback(state, 1, true, true);
        DeviceQueueNavigation.navigate(state, REVISION, playback);
        assertEquals(Integer.valueOf(1), state.snapshot().index());
        assertEquals(0, state.snapshot().position(), 0);
        assertNull(state.snapshot().error());
        assertNotNull(playback.replacement);
        assertEquals(1, playback.replacement.index());
        assertEquals(1, state.restoreRequest().index());
        assertTrue(playback.replacement.playing());
        assertFalse(playback.seekCalled);
    }

    @Test
    public void previousAfterAPausedFailureRebuildsThePreviousItemWithoutAutoplay() throws Exception {
        DeviceAudioState state = state(1);
        state.fail(DeviceAudioException.PLAYBACK_FAILED);
        Playback playback = new Playback(state, 0, true, false);
        DeviceQueueNavigation.navigate(state, REVISION, playback);
        assertEquals(Integer.valueOf(0), state.snapshot().index());
        assertEquals("paused", state.snapshot().status());
        assertNotNull(playback.replacement);
        assertFalse(playback.replacement.playing());
        assertEquals(0.4, playback.replacement.volume(), 0);
        assertEquals("all", playback.replacement.repeat());
        assertTrue(playback.replacement.shuffle());
        assertEquals("owner:fixture", playback.replacement.ownerId());
        assertEquals(REVISION, playback.replacement.revision());
    }

    @Test
    public void healthyNavigationRetainsTheExistingPlayerAndUsesItsChosenTarget() throws Exception {
        DeviceAudioState state = state(0);
        Playback playback = new Playback(state, 2, false, true);
        DeviceQueueNavigation.navigate(state, REVISION, playback);
        assertEquals(Integer.valueOf(2), state.snapshot().index());
        assertTrue(playback.seekCalled);
        assertNull(playback.replacement);
    }

    @Test
    public void recoveryUsesTheMedia3ShuffleOrRepeatTargetRatherThanAssumingAnAdjacentIndex() throws Exception {
        DeviceAudioState state = state(0);
        state.fail(DeviceAudioException.PLAYBACK_FAILED);
        Playback playback = new Playback(state, 2, true, true);
        DeviceQueueNavigation.navigate(state, REVISION, playback);
        assertNotNull(playback.replacement);
        assertEquals(2, playback.replacement.index());
        assertEquals(state.snapshot().queue().get(2).entryId(), playback.replacement.tracks().get(2).entryId());
    }

    @Test
    public void idleStoppedNavigationPreservesThePausedIntent() throws Exception {
        DeviceAudioState state = state(0);
        Playback playback = new Playback(state, 1, true, false);
        DeviceQueueNavigation.navigate(state, REVISION, playback);
        assertNotNull(playback.replacement);
        assertFalse(playback.replacement.playing());
        assertEquals("paused", state.snapshot().status());
    }

    @Test
    public void absentNavigationTargetDoesNotRetryTheFailedCurrentItem() throws Exception {
        DeviceAudioState state = state(2);
        state.fail(DeviceAudioException.PLAYBACK_FAILED);
        Playback playback = new Playback(state, -1, true, true);
        DeviceQueueNavigation.navigate(state, REVISION, playback);
        assertEquals(Integer.valueOf(2), state.snapshot().index());
        assertEquals("failed", state.snapshot().status());
        assertNull(playback.replacement);
    }

    @Test
    public void aStaleRevisionCannotSeekOrReplaceTheOwnedQueue() throws Exception {
        DeviceAudioState state = state(0);
        Playback playback = new Playback(state, 1, true, true);
        assertEquals(DeviceAudioException.STALE_REVISION, assertThrows(DeviceAudioException.class,
            () -> DeviceQueueNavigation.navigate(state, "queue:obsolete", playback)).code());
        assertFalse(playback.seekCalled);
        assertNull(playback.replacement);
    }

    private static DeviceAudioState state(int index) {
        DeviceAudioState state = new DeviceAudioState();
        state.replace(new DeviceQueueRequest("owner:fixture", REVISION, Arrays.asList(
            entry("youtube", "abcdefghijk"), entry("studio", "1"), entry("youtube", "other______")
        ), index, 27, true, "all", true, 0.4));
        return state;
    }

    private static DeviceQueueEntry entry(String provider, String externalId) {
        return new DeviceQueueEntry(UUID.randomUUID(), provider + ":" + externalId,
            provider, externalId, "Fixture", "Fixture");
    }

    /** Models the documented Media3 error/idle behavior; seek does not prepare a failed player. */
    private static final class Playback implements DeviceQueueNavigation.Playback {
        private final DeviceAudioState state;
        private final int target;
        private final boolean intent;
        private boolean failedOrIdle;
        private int current;
        boolean seekCalled;
        DeviceQueueRequest replacement;

        Playback(DeviceAudioState state, int target, boolean failedOrIdle, boolean intent) {
            this.state = state; this.target = target; this.failedOrIdle = failedOrIdle; this.intent = intent;
            current = state.snapshot().index();
        }
        public int targetIndex() { return target; }
        public boolean requiresRebuild() { return failedOrIdle; }
        public boolean playRequested() { return intent; }
        public void seek() { seekCalled = true; if (target >= 0) current = target; }
        public void replaceQueue(DeviceQueueRequest request) {
            replacement = request; current = request.index(); failedOrIdle = false;
        }
        public void synchronize() {
            // Mirrors the service's guard: idle/error events cannot erase a decoding failure.
            if (failedOrIdle) return;
            state.synchronize(current, 0, 72, intent ? "loading" : "paused");
        }
    }
}
