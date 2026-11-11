package com.lattelix.aurelia.deviceaudio;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class DeviceAudioSnapshot {
    private final String ownerId;
    private final String revision;
    private final long sequence;
    private final Integer index;
    private final List<DeviceQueueEntry> queue;
    private final double position;
    private final double duration;
    private final String status;
    private final String repeat;
    private final boolean shuffle;
    private final double volume;
    private final String error;

    DeviceAudioSnapshot(
        String ownerId,
        String revision,
        long sequence,
        Integer index,
        List<DeviceQueueEntry> queue,
        double position,
        double duration,
        String status,
        String repeat,
        boolean shuffle,
        double volume,
        String error
    ) {
        this.ownerId = ownerId;
        this.revision = revision;
        this.sequence = sequence;
        this.index = index;
        this.queue = Collections.unmodifiableList(new ArrayList<>(queue));
        this.position = position;
        this.duration = duration;
        this.status = status;
        this.repeat = repeat;
        this.shuffle = shuffle;
        this.volume = volume;
        this.error = error;
    }

    public String ownerId() { return ownerId; }
    public String revision() { return revision; }
    public long sequence() { return sequence; }
    public Integer index() { return index; }
    public List<DeviceQueueEntry> queue() { return queue; }
    public double position() { return position; }
    public double duration() { return duration; }
    public String status() { return status; }
    public boolean playing() { return "playing".equals(status); }
    public String repeat() { return repeat; }
    public boolean shuffle() { return shuffle; }
    public double volume() { return volume; }
    public String error() { return error; }
    public String entryId() { return index == null ? null : queue.get(index).entryId().toString(); }
    public String trackId() { return index == null ? null : queue.get(index).trackId(); }

    public Map<String, Object> toMap() {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("apiVersion", 1);
        result.put("transport", "device");
        result.put("ownerId", ownerId);
        result.put("revision", revision);
        result.put("sequence", sequence);
        result.put("index", index);
        result.put("entryId", entryId());
        result.put("trackId", trackId());
        result.put("position", position);
        result.put("duration", duration);
        result.put("status", status);
        result.put("playing", playing());
        result.put("repeat", repeat);
        result.put("shuffle", shuffle);
        result.put("volume", volume);
        result.put("error", error);
        List<Map<String, Object>> rows = new ArrayList<>(queue.size());
        for (DeviceQueueEntry entry : queue) rows.add(entry.toMap());
        result.put("queue", rows);
        return result;
    }
}
