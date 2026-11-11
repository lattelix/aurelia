package com.lattelix.aurelia.deviceaudio;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/** A compare-and-swap edit of the owned queue, never a new playback intent. */
public final class DeviceQueueMutation {
    private final String ownerId, expectedRevision, revision;
    private final List<DeviceQueueEntry> tracks;

    public DeviceQueueMutation(String ownerId, String expectedRevision, String revision, List<DeviceQueueEntry> tracks) {
        this.ownerId = ownerId;
        this.expectedRevision = expectedRevision;
        this.revision = revision;
        this.tracks = Collections.unmodifiableList(new ArrayList<>(tracks));
    }

    public String ownerId() { return ownerId; }
    public String expectedRevision() { return expectedRevision; }
    public String revision() { return revision; }
    public List<DeviceQueueEntry> tracks() { return tracks; }

    /** Media3 edits preserve retained source objects; equal track IDs are distinct occurrences. */
    public List<Edit> edits(List<DeviceQueueEntry> previous) {
        List<java.util.UUID> working = new ArrayList<>();
        java.util.Set<java.util.UUID> retained = new java.util.HashSet<>();
        for (DeviceQueueEntry entry : previous) working.add(entry.entryId());
        for (DeviceQueueEntry entry : tracks) retained.add(entry.entryId());
        List<Edit> result = new ArrayList<>();
        for (int i = working.size() - 1; i >= 0; i--) if (!retained.contains(working.get(i))) {
            result.add(new Edit("remove", i, -1));
            working.remove(i);
        }
        for (int i = 0; i < tracks.size(); i++) {
            java.util.UUID entry = tracks.get(i).entryId();
            int old = working.indexOf(entry);
            if (old < 0) { working.add(i, entry); result.add(new Edit("insert", i, -1)); }
            else if (old != i) { working.remove(old); working.add(i, entry); result.add(new Edit("move", old, i)); }
        }
        return Collections.unmodifiableList(result);
    }

    public static final class Edit {
        public final String kind;
        public final int index, target;
        private Edit(String kind, int index, int target) { this.kind = kind; this.index = index; this.target = target; }
    }
}
