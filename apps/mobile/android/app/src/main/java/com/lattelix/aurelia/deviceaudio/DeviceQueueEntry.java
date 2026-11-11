package com.lattelix.aurelia.deviceaudio;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;

public final class DeviceQueueEntry {
    private final UUID entryId;
    private final String trackId;
    private final String provider;
    private final String externalId;
    private final String title;
    private final String artist;

    public DeviceQueueEntry(UUID entryId, String trackId, String externalId, String title, String artist) {
        this(entryId, trackId, "studio", externalId, title, artist);
    }

    public DeviceQueueEntry(UUID entryId, String trackId, String provider, String externalId, String title, String artist) {
        this.entryId = Objects.requireNonNull(entryId);
        this.trackId = Objects.requireNonNull(trackId);
        this.provider = Objects.requireNonNull(provider);
        this.externalId = Objects.requireNonNull(externalId);
        this.title = Objects.requireNonNull(title);
        this.artist = Objects.requireNonNull(artist);
    }

    public UUID entryId() { return entryId; }
    public String trackId() { return trackId; }
    public String provider() { return provider; }
    public String externalId() { return externalId; }
    public String title() { return title; }
    public String artist() { return artist; }

    public Map<String, Object> toMap() {
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("entryId", entryId.toString());
        value.put("trackId", trackId);
        value.put("provider", provider());
        value.put("externalId", externalId);
        value.put("title", title);
        value.put("artist", artist);
        return value;
    }
}
