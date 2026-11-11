package com.lattelix.aurelia.deviceaudio;

import android.os.Bundle;
import androidx.media3.session.SessionCommand;
import androidx.media3.session.SessionCommands;

public final class DeviceAudioCommands {
    private static final String PREFIX = "com.lattelix.aurelia.deviceaudio.";

    public static final String GET_SNAPSHOT = PREFIX + "GET_SNAPSHOT";
    public static final String LOAD_QUEUE = PREFIX + "LOAD_QUEUE";
    public static final String MUTATE_QUEUE = PREFIX + "MUTATE_QUEUE";
    public static final String PLAY = PREFIX + "PLAY";
    public static final String PAUSE = PREFIX + "PAUSE";
    public static final String SEEK = PREFIX + "SEEK";
    public static final String SET_REPEAT = PREFIX + "SET_REPEAT";
    public static final String SET_SHUFFLE = PREFIX + "SET_SHUFFLE";
    public static final String SET_VOLUME = PREFIX + "SET_VOLUME";
    public static final String STOP = PREFIX + "STOP";
    public static final String NEXT = PREFIX + "NEXT";
    public static final String PREVIOUS = PREFIX + "PREVIOUS";
    public static final String SNAPSHOT_EVENT = PREFIX + "SNAPSHOT_EVENT";

    private DeviceAudioCommands() {}

    public static SessionCommand command(String action) {
        return new SessionCommand(action, Bundle.EMPTY);
    }

    public static SessionCommands ownSessionCommands() {
        SessionCommands.Builder builder = new SessionCommands.Builder();
        builder.add(command(GET_SNAPSHOT));
        builder.add(command(LOAD_QUEUE));
        builder.add(command(MUTATE_QUEUE));
        builder.add(command(PLAY));
        builder.add(command(PAUSE));
        builder.add(command(SEEK));
        builder.add(command(SET_REPEAT));
        builder.add(command(SET_SHUFFLE));
        builder.add(command(SET_VOLUME));
        builder.add(command(STOP));
        builder.add(command(NEXT));
        builder.add(command(PREVIOUS));
        return builder.build();
    }
}
