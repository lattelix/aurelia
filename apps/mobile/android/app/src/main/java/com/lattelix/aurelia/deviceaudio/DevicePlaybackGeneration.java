package com.lattelix.aurelia.deviceaudio;

import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

/** Main-thread identity fence, independent of revisions which callers may reuse. */
public final class DevicePlaybackGeneration {
    private QueueToken active;

    public QueueToken replace(DeviceQueueRequest request) {
        invalidate();
        active = new QueueToken(request.ownerId(), request.revision(), request.playing());
        return active;
    }

    public void invalidate() {
        if (active != null) {
            active.playRequested = false;
            active.attempts.clear();
        }
        active = null;
    }

    public Attempt beginAttempt(QueueToken queue, UUID entryId) {
        if (!accepts(queue)) throw new IllegalStateException("obsolete-playback-generation");
        Attempt attempt = new Attempt(queue, entryId);
        queue.attempts.put(entryId, attempt);
        return attempt;
    }

    public boolean accepts(QueueToken queue) { return queue != null && queue == active; }

    public void mutate(QueueToken queue, DeviceQueueMutation mutation) {
        if (!accepts(queue) || !queue.ownerId.equals(mutation.ownerId()) ||
            !queue.revision.equals(mutation.expectedRevision())) throw new IllegalStateException("obsolete-playback-generation");
        java.util.Set<UUID> retained = new java.util.HashSet<>();
        for (DeviceQueueEntry entry : mutation.tracks()) retained.add(entry.entryId());
        queue.attempts.keySet().retainAll(retained);
        if (mutation.tracks().isEmpty()) queue.playRequested = false;
        queue.revision = mutation.revision();
    }

    public boolean accepts(Attempt attempt) {
        return attempt != null && accepts(attempt.queue)
            && attempt.queue.attempts.get(attempt.entryId) == attempt;
    }

    public boolean acceptsEvent(Attempt event, Attempt current) {
        return event == current && accepts(event);
    }

    public void setPlayRequested(QueueToken queue, boolean playing) {
        if (accepts(queue)) queue.playRequested = playing;
    }

    public boolean playRequested(QueueToken queue) { return accepts(queue) && queue.playRequested; }

    public static final class QueueToken {
        private final String ownerId;
        private String revision;
        private final Map<UUID, Attempt> attempts = new HashMap<>();
        private boolean playRequested;

        private QueueToken(String ownerId, String revision, boolean playing) {
            this.ownerId = ownerId;
            this.revision = revision;
            playRequested = playing;
        }

        public String ownerId() { return ownerId; }
        public String revision() { return revision; }
    }

    public static final class Attempt {
        private final QueueToken queue;
        private final UUID entryId;

        private Attempt(QueueToken queue, UUID entryId) { this.queue = queue; this.entryId = entryId; }
    }
}
