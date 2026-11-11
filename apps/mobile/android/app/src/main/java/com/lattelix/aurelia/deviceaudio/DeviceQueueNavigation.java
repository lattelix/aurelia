package com.lattelix.aurelia.deviceaudio;

/** Queue navigation shared by the ID-only bridge and trusted system transport. */
public final class DeviceQueueNavigation {
    public interface Playback {
        int targetIndex();
        boolean requiresRebuild();
        boolean playRequested();
        void seek();
        void replaceQueue(DeviceQueueRequest request);
        void synchronize();
    }

    private DeviceQueueNavigation() {}

    public static void navigate(DeviceAudioState state, String revision, Playback playback)
        throws DeviceAudioException {
        state.requireRevision(revision);
        if (playback.requiresRebuild()) {
            int target = playback.targetIndex();
            DeviceAudioSnapshot snapshot = state.snapshot();
            if (target < 0 || target >= snapshot.queue().size()) return;
            // A failed/idle Media3 player cannot recover by seeking alone. Move the
            // authoritative snapshot before rebuilding so later Play cannot retry
            // the old item. The Media3-selected index preserves shuffle/repeat.
            DeviceQueueRequest request = new DeviceQueueRequest(snapshot.ownerId(), revision,
                snapshot.queue(), target, 0, playback.playRequested(), snapshot.repeat(),
                snapshot.shuffle(), snapshot.volume());
            state.replace(request);
            playback.replaceQueue(request);
        } else playback.seek();
        playback.synchronize();
    }
}
