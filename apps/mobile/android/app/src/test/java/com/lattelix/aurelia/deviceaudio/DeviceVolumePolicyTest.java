package com.lattelix.aurelia.deviceaudio;

import static org.junit.Assert.assertEquals;
import org.junit.Test;

public class DeviceVolumePolicyTest {
    @Test
    public void silentQaClampsInitialLoadCustomVolumeSystemControlsAndRestoreSnapshots() throws Exception {
        DeviceAudioState state = new DeviceAudioState(true);
        assertEquals(0, state.snapshot().volume(), 0);
        DeviceQueueRequest request = DeviceAudioValidator.loadRequest(DeviceYouTubeQueueTest.youtubeRequest(), true);
        state.replace(request);
        assertEquals(0, state.snapshot().volume(), 0);
        state.setVolume(request.revision(), 1);
        assertEquals(0, state.snapshot().volume(), 0);
        state.synchronizeControls("all", true, 1);
        assertEquals(0, state.snapshot().volume(), 0);
        assertEquals(0, state.restoreRequest().volume(), 0);
        state.restorePaused(request, "restored-silent");
        assertEquals(0, state.snapshot().volume(), 0);
        state.stop("stopped-silent");
        assertEquals(0, state.snapshot().volume(), 0);
    }

    @Test
    public void normalBuildRetainsUserVolumeWithoutAutomaticRestoration() throws Exception {
        DeviceAudioState state = new DeviceAudioState(false);
        DeviceQueueRequest request = DeviceAudioValidator.loadRequest(DeviceAudioValidatorTest.validRequest());
        state.replace(request);
        assertEquals(0.75, state.snapshot().volume(), 0);
        state.setVolume(request.revision(), 0.2);
        assertEquals(0.2, state.restoreRequest().volume(), 0);
        state.synchronizeControls("off", false, 0.4);
        assertEquals(0.4, state.snapshot().volume(), 0);
    }

    @Test
    public void playerBoundaryAlwaysFailsClosedForNonFiniteVolume() {
        DeviceVolumePolicy silent = new DeviceVolumePolicy(true);
        assertEquals(0, silent.clamp(1), 0);
        assertEquals(0, silent.clamp(Double.NaN), 0);
        DeviceVolumePolicy normal = new DeviceVolumePolicy(false);
        assertEquals(0, normal.clamp(Double.POSITIVE_INFINITY), 0);
        assertEquals(1, normal.clamp(2), 0);
        assertEquals(0, normal.clamp(-1), 0);
    }
}
