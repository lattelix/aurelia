package com.lattelix.aurelia.deviceaudio;

import com.lattelix.aurelia.BuildConfig;

/** Compile-time product gates; no persisted or caller-controlled override. */
final class NativeFeaturePolicy {
    private NativeFeaturePolicy() {}

    static boolean youtubeEnabled() { return BuildConfig.AURELIA_YOUTUBE_SOURCE_ENABLED; }
    static boolean silentQa() { return BuildConfig.AURELIA_SILENT_QA; }
}
