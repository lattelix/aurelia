package com.lattelix.aurelia.deviceaudio;

/** Build-selected app volume policy; never changes the device's music/ringer volume. */
public final class DeviceVolumePolicy {
    private final boolean silent;

    public DeviceVolumePolicy(boolean silent) { this.silent = silent; }

    public double clamp(double requested) {
        if (silent || !Double.isFinite(requested)) return 0;
        return Math.max(0, Math.min(1, requested));
    }
}
