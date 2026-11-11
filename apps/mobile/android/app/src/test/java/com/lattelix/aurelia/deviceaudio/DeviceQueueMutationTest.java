package com.lattelix.aurelia.deviceaudio;

import static org.junit.Assert.*;
import java.util.*;
import org.junit.Test;

public class DeviceQueueMutationTest {
    private DeviceQueueEntry entry(int occurrence, int source) {
        String id = String.format(Locale.ROOT, "11111111-1111-4111-8111-%012d", occurrence);
        return new DeviceQueueEntry(UUID.fromString(id), "studio:afterglow-" + source,
            String.valueOf(source), "Title", "Artist");
    }
    private DeviceAudioState state(List<DeviceQueueEntry> tracks, boolean playing) {
        DeviceAudioState state = new DeviceAudioState();
        state.replace(new DeviceQueueRequest("owner", "revision:1", tracks, 0, 22, playing, "off", false, 0.5));
        state.synchronize(0, 22, 72, playing ? "playing" : "paused");
        return state;
    }
    private DeviceQueueMutation mutation(List<DeviceQueueEntry> tracks) {
        return new DeviceQueueMutation("owner", "revision:1", "revision:2", tracks);
    }

    @Test public void editsKeepDistinctDuplicateSourcesWithoutReplacingRetainedOccurrences() {
        DeviceQueueEntry current = entry(1, 1), duplicate = entry(2, 1), other = entry(3, 2), appended = entry(4, 3);
        List<DeviceQueueEntry> actual = new ArrayList<>(Arrays.asList(current, duplicate, other));
        DeviceQueueMutation mutation = mutation(Arrays.asList(other, current, duplicate, appended));
        for (DeviceQueueMutation.Edit edit : mutation.edits(actual)) {
            if (edit.kind.equals("remove")) actual.remove(edit.index);
            else if (edit.kind.equals("move")) actual.add(edit.target, actual.remove(edit.index));
            else actual.add(edit.index, mutation.tracks().get(edit.index));
        }
        assertEquals(mutation.tracks(), actual);
        assertSame(current, actual.get(1));
        assertSame(duplicate, actual.get(2));
        assertEquals(2, mutation.edits(Arrays.asList(current, duplicate, other)).size());
    }

    @Test public void unrelatedRemovalHasOnlyRemoveAndNoInsertionOfCurrentSource() {
        DeviceQueueEntry before = entry(1, 1), current = entry(2, 1), after = entry(3, 2);
        List<DeviceQueueMutation.Edit> edits = mutation(Arrays.asList(current, after)).edits(Arrays.asList(before, current, after));
        assertEquals(1, edits.size());
        assertEquals("remove", edits.get(0).kind);
        assertEquals(0, edits.get(0).index);
    }

    @Test public void playingAndPausedCurrentPositionSurviveMoveAndNativeAdvance() throws Exception {
        for (boolean playing : new boolean[]{false, true}) {
            DeviceQueueEntry a = entry(1, 1), duplicate = entry(2, 1), b = entry(3, 2);
            DeviceAudioState state = state(Arrays.asList(a, duplicate, b), playing);
            // Native can advance while the UI edit is in flight; its actual occurrence wins.
            state.synchronize(1, 22, 72, playing ? "playing" : "paused");
            state.mutate(mutation(Arrays.asList(b, a, duplicate)));
            assertEquals(duplicate.entryId().toString(), state.snapshot().entryId());
            assertEquals(Integer.valueOf(2), state.snapshot().index());
            assertEquals(22, state.snapshot().position(), 0);
            assertEquals(72, state.snapshot().duration(), 0);
            assertEquals(playing, state.snapshot().playing());
            assertEquals("revision:2", state.snapshot().revision());
        }
    }

    @Test public void staleAndDifferentOwnerEditsAreAtomicAndOldCommandsStayStale() throws Exception {
        DeviceQueueEntry a = entry(1, 1), b = entry(2, 2);
        DeviceAudioState state = state(Arrays.asList(a, b), true);
        long sequence = state.snapshot().sequence();
        assertThrows(DeviceAudioException.class, () -> state.mutate(new DeviceQueueMutation("other", "revision:1", "revision:2", Arrays.asList(b, a))));
        assertThrows(DeviceAudioException.class, () -> state.mutate(new DeviceQueueMutation("owner", "stale", "revision:2", Arrays.asList(b, a))));
        assertEquals(sequence, state.snapshot().sequence());
        state.mutate(mutation(Arrays.asList(b, a)));
        assertThrows(DeviceAudioException.class, () -> state.mutate(mutation(Arrays.asList(a, b))));
        assertThrows(DeviceAudioException.class, () -> state.pause("revision:1"));
        assertTrue(state.snapshot().playing());
    }

    @Test public void displayCorrectionIsAllowedButAnExistingIdCannotChangeSource() throws Exception {
        DeviceQueueEntry a = entry(1, 1);
        DeviceAudioState state = state(Collections.singletonList(a), false);
        DeviceQueueEntry changed = new DeviceQueueEntry(a.entryId(), a.trackId(), a.externalId(), "Corrected", "Artist");
        state.mutate(mutation(Collections.singletonList(changed)));
        assertEquals("Corrected", state.snapshot().queue().get(0).title());
        assertFalse(state.snapshot().playing());
        DeviceQueueEntry replaced = new DeviceQueueEntry(a.entryId(), "studio:afterglow-2", "2", "Other", "Artist");
        assertThrows(DeviceAudioException.class, () -> state.mutate(new DeviceQueueMutation("owner", "revision:2", "revision:3", Collections.singletonList(replaced))));
        assertEquals("revision:2", state.snapshot().revision());
    }

    @Test public void queueGenerationRetainsPendingCurrentAttemptButInvalidatesRemovedAttempt() throws Exception {
        DeviceQueueEntry a = entry(1, 1), b = entry(2, 2);
        DevicePlaybackGeneration generations = new DevicePlaybackGeneration();
        DevicePlaybackGeneration.QueueToken token = generations.replace(new DeviceQueueRequest("owner", "revision:1", Arrays.asList(a, b), 0, 22, false, "off", false, 0));
        DevicePlaybackGeneration.Attempt current = generations.beginAttempt(token, a.entryId());
        DevicePlaybackGeneration.Attempt removed = generations.beginAttempt(token, b.entryId());
        generations.mutate(token, mutation(Collections.singletonList(a)));
        assertTrue(generations.accepts(token));
        assertTrue(generations.accepts(current));
        assertFalse(generations.accepts(removed));
        assertFalse(generations.playRequested(token));
        assertEquals("revision:2", token.revision());
        assertThrows(IllegalStateException.class, () -> generations.mutate(token, mutation(Collections.singletonList(a))));
        assertTrue(generations.accepts(current));
    }

    @Test public void strictMutationParsingRejectsExtraFieldsDuplicateIdsAndRevisionReuse() throws Exception {
        Map<String, Object> load = DeviceAudioValidatorTest.validRequest();
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("ownerId", "owner"); value.put("expectedRevision", "revision:1");
        value.put("revision", "revision:2"); value.put("tracks", load.get("tracks"));
        assertEquals(1, DeviceAudioValidator.mutationRequest(value, false).tracks().size());
        value.put("position", 22);
        assertThrows(DeviceAudioException.class, () -> DeviceAudioValidator.mutationRequest(value, false));
        value.remove("position"); value.put("revision", "revision:1");
        assertThrows(DeviceAudioException.class, () -> DeviceAudioValidator.mutationRequest(value, false));
        value.put("revision", "revision:2");
        Object row = ((List<?>)load.get("tracks")).get(0);
        value.put("tracks", Arrays.asList(row, row));
        assertThrows(DeviceAudioException.class, () -> DeviceAudioValidator.mutationRequest(value, false));
        value.put("tracks", Collections.nCopies(501, row));
        assertThrows(DeviceAudioException.class, () -> DeviceAudioValidator.mutationRequest(value, false));
    }

    @Test public void emptyEditCancelsPlayIntentAndLaterAppendCannotRestoreIt() {
        DeviceQueueEntry a = entry(1, 1);
        DevicePlaybackGeneration generations = new DevicePlaybackGeneration();
        DevicePlaybackGeneration.QueueToken token = generations.replace(new DeviceQueueRequest("owner", "revision:1",
            Collections.singletonList(a), 0, 22, true, "off", false, 0.5));
        DevicePlaybackGeneration.Attempt old = generations.beginAttempt(token, a.entryId());
        generations.mutate(token, mutation(Collections.emptyList()));
        assertFalse(generations.playRequested(token));
        assertFalse(generations.accepts(old));
        generations.mutate(token, new DeviceQueueMutation("owner", "revision:2", "revision:3", Collections.singletonList(a)));
        assertFalse(generations.playRequested(token));
        assertTrue(generations.accepts(generations.beginAttempt(token, a.entryId())));
    }
}
