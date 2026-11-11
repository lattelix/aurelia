package com.lattelix.aurelia.deviceaudio;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/** Pure Java ownership and snapshot state. Android code serializes all calls on the main looper. */
public final class DeviceAudioState {
    private final DeviceVolumePolicy volumePolicy;
    private String ownerId;
    private String revision = "unowned";
    private List<DeviceQueueEntry> queue = Collections.emptyList();
    private Integer index;
    private double position;
    private double duration;
    private String status = "idle";
    private String repeat = "off";
    private boolean shuffle;
    private double volume = 0.75;
    private String error;
    private long sequence;

    public DeviceAudioState() { this(false); }

    public DeviceAudioState(boolean silentQa) {
        volumePolicy = new DeviceVolumePolicy(silentQa);
        volume = volumePolicy.clamp(volume);
    }

    public DeviceAudioSnapshot snapshot() {
        return new DeviceAudioSnapshot(
            ownerId,
            revision,
            sequence,
            index,
            queue,
            position,
            duration,
            status,
            repeat,
            shuffle,
            volume,
            error
        );
    }

    public void replace(DeviceQueueRequest request) {
        ownerId = request.ownerId();
        revision = request.revision();
        queue = Collections.unmodifiableList(new ArrayList<>(request.tracks()));
        index = queue.isEmpty() ? null : request.index();
        position = queue.isEmpty() ? 0 : request.position();
        duration = 0;
        repeat = request.repeat();
        shuffle = request.shuffle();
        volume = volumePolicy.clamp(request.volume());
        error = null;
        status = queue.isEmpty() ? "idle" : request.playing() ? "loading" : "paused";
        changed();
    }

    public void restorePaused(DeviceQueueRequest request, String replacementRevision) throws DeviceAudioException {
        DeviceAudioValidator.revision(replacementRevision);
        replace(request.pausedWithRevision(replacementRevision));
        if (!queue.isEmpty()) status = "paused";
    }

    public void requireRevision(String expected) throws DeviceAudioException {
        DeviceAudioValidator.revision(expected);
        if (!expected.equals(revision) || ownerId == null) {
            throw new DeviceAudioException(DeviceAudioException.STALE_REVISION);
        }
    }

    public void requireStopRevision(String expected) throws DeviceAudioException {
        DeviceAudioValidator.revision(expected);
        if (!expected.equals(revision)) {
            throw new DeviceAudioException(DeviceAudioException.STALE_REVISION);
        }
    }

    public void validateMutation(DeviceQueueMutation mutation) throws DeviceAudioException {
        requireRevision(mutation.expectedRevision());
        if (!ownerId.equals(mutation.ownerId())) throw new DeviceAudioException(DeviceAudioException.STALE_REVISION);
        DeviceAudioValidator.revision(mutation.revision());
        if (revision.equals(mutation.revision())) throw new DeviceAudioException(DeviceAudioException.INVALID_REQUEST);
        // Existing occurrence IDs may update display metadata, never change source identity.
        for (DeviceQueueEntry next : mutation.tracks()) {
            for (DeviceQueueEntry old : queue) {
                if (old.entryId().equals(next.entryId()) &&
                    (!old.trackId().equals(next.trackId()) || !old.provider().equals(next.provider()) ||
                        !old.externalId().equals(next.externalId())))
                    throw new DeviceAudioException(DeviceAudioException.INVALID_REQUEST);
            }
        }
    }

    public void mutate(DeviceQueueMutation mutation) throws DeviceAudioException {
        validateMutation(mutation);
        String current = snapshot().entryId();
        int previousIndex = index == null ? 0 : index;
        queue = Collections.unmodifiableList(new ArrayList<>(mutation.tracks()));
        revision = mutation.revision();
        index = null;
        for (int i = 0; i < queue.size(); i++)
            if (queue.get(i).entryId().toString().equals(current)) index = i;
        if (index == null) {
            index = queue.isEmpty() ? null : Math.min(previousIndex, queue.size() - 1);
            position = 0;
            duration = 0;
            if (queue.isEmpty()) { status = "idle"; error = null; }
        }
        changed();
    }

    public void play(String expectedRevision) throws DeviceAudioException {
        requireRevision(expectedRevision);
        if (queue.isEmpty()) return;
        if ("ended".equals(status)) position = 0;
        error = null;
        // This is a validated play intent; only a player event can confirm actual playback.
        status = "loading";
        changed();
    }

    public void pause(String expectedRevision) throws DeviceAudioException {
        requireRevision(expectedRevision);
        if (queue.isEmpty()) return;
        if ("failed".equals(status)) return;
        error = null;
        status = "paused";
        changed();
    }

    public void seek(String expectedRevision, double nextPosition) throws DeviceAudioException {
        requireRevision(expectedRevision);
        if (!Double.isFinite(nextPosition) || nextPosition < 0 || nextPosition > 86400) {
            throw new DeviceAudioException(DeviceAudioException.INVALID_REQUEST);
        }
        if (queue.isEmpty()) return;
        position = nextPosition;
        changed();
    }

    public void setRepeat(String expectedRevision, String mode) throws DeviceAudioException {
        requireRevision(expectedRevision);
        if (!Arrays.asList("off", "all", "one").contains(mode)) {
            throw new DeviceAudioException(DeviceAudioException.INVALID_REQUEST);
        }
        repeat = mode;
        changed();
    }

    public void setShuffle(String expectedRevision, boolean enabled) throws DeviceAudioException {
        requireRevision(expectedRevision);
        shuffle = enabled;
        changed();
    }

    public void setVolume(String expectedRevision, double value) throws DeviceAudioException {
        requireRevision(expectedRevision);
        if (!Double.isFinite(value) || value < 0 || value > 1) {
            throw new DeviceAudioException(DeviceAudioException.INVALID_REQUEST);
        }
        volume = volumePolicy.clamp(value);
        changed();
    }

    public void moveTo(String expectedRevision, int nextIndex, double nextPosition) throws DeviceAudioException {
        requireRevision(expectedRevision);
        if (nextIndex < 0 || nextIndex >= queue.size() || !Double.isFinite(nextPosition)) {
            throw new DeviceAudioException(DeviceAudioException.INVALID_REQUEST);
        }
        index = nextIndex;
        position = clamp(nextPosition);
        duration = 0;
        error = null;
        status = "paused";
        changed();
    }

    public void next(String expectedRevision) throws DeviceAudioException {
        requireRevision(expectedRevision);
        if (queue.isEmpty()) return;
        int next = index + 1;
        if (next >= queue.size()) {
            if (!"all".equals(repeat)) {
                status = "ended";
                position = duration;
                changed();
                return;
            }
            next = 0;
        }
        index = next;
        position = 0;
        duration = 0;
        error = null;
        status = "paused";
        changed();
    }

    public void previous(String expectedRevision) throws DeviceAudioException {
        requireRevision(expectedRevision);
        if (queue.isEmpty()) return;
        int previous = index - 1;
        if (previous < 0) previous = "all".equals(repeat) ? queue.size() - 1 : 0;
        index = previous;
        position = 0;
        duration = 0;
        error = null;
        status = "paused";
        changed();
    }

    public void synchronize(int currentIndex, double currentPosition, double currentDuration, String nextStatus) {
        if ("failed".equals(status)) return;
        if (queue.isEmpty()) {
            index = null;
            position = 0;
            duration = 0;
            status = "idle";
            error = null;
            changed();
            return;
        }
        if (currentIndex < 0 || currentIndex >= queue.size()) return;
        if (!Arrays.asList("loading", "playing", "paused", "ended").contains(nextStatus)) return;
        index = currentIndex;
        position = clamp(currentPosition);
        duration = clamp(currentDuration);
        status = nextStatus;
        error = null;
        changed();
    }

    public void synchronizeControls(String nextRepeat, boolean nextShuffle, double nextVolume) {
        if ("failed".equals(status)) return;
        if (!Arrays.asList("off", "all", "one").contains(nextRepeat)) return;
        if (!Double.isFinite(nextVolume) || nextVolume < 0 || nextVolume > 1) return;
        repeat = nextRepeat;
        shuffle = nextShuffle;
        volume = volumePolicy.clamp(nextVolume);
        changed();
    }

    public void fail(String fixedCode) {
        error = DeviceAudioException.PLAYBACK_FAILED.equals(fixedCode)
            ? fixedCode
            : DeviceAudioException.PLAYBACK_FAILED;
        status = "failed";
        changed();
    }

    public void stop(String replacementRevision) throws DeviceAudioException {
        DeviceAudioValidator.revision(replacementRevision);
        ownerId = null;
        revision = replacementRevision;
        queue = Collections.emptyList();
        index = null;
        position = 0;
        duration = 0;
        status = "idle";
        repeat = "off";
        shuffle = false;
        error = null;
        changed();
    }

    public DeviceQueueRequest restoreRequest() {
        if (ownerId == null || revision.isEmpty()) return null;
        return new DeviceQueueRequest(
            ownerId,
            revision,
            queue,
            index == null ? 0 : index,
            position,
            false,
            repeat,
            shuffle,
            volume
        );
    }

    private void changed() {
        if (sequence < Long.MAX_VALUE) sequence++;
    }

    private static double clamp(double value) {
        if (!Double.isFinite(value) || value < 0) return 0;
        return Math.min(value, 86400);
    }
}
