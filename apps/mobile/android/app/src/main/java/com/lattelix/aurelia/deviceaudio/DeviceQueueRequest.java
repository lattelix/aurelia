package com.lattelix.aurelia.deviceaudio;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

public final class DeviceQueueRequest {
    private final String ownerId;
    private final String revision;
    private final List<DeviceQueueEntry> tracks;
    private final int index;
    private final double position;
    private final boolean playing;
    private final String repeat;
    private final boolean shuffle;
    private final double volume;

    public DeviceQueueRequest(
        String ownerId,
        String revision,
        List<DeviceQueueEntry> tracks,
        int index,
        double position,
        boolean playing,
        String repeat,
        boolean shuffle,
        double volume
    ) {
        this.ownerId = ownerId;
        this.revision = revision;
        this.tracks = Collections.unmodifiableList(new ArrayList<>(tracks));
        this.index = index;
        this.position = position;
        this.playing = playing;
        this.repeat = repeat;
        this.shuffle = shuffle;
        this.volume = volume;
    }

    public String ownerId() { return ownerId; }
    public String revision() { return revision; }
    public List<DeviceQueueEntry> tracks() { return tracks; }
    public int index() { return index; }
    public double position() { return position; }
    public boolean playing() { return playing; }
    public String repeat() { return repeat; }
    public boolean shuffle() { return shuffle; }
    public double volume() { return volume; }

    public DeviceQueueRequest pausedWithRevision(String replacementRevision) {
        return new DeviceQueueRequest(
            ownerId,
            replacementRevision,
            tracks,
            index,
            position,
            false,
            repeat,
            shuffle,
            volume
        );
    }
}
