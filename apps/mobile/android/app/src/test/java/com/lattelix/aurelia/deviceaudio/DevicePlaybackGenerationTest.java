package com.lattelix.aurelia.deviceaudio;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.UUID;
import org.junit.Test;

public class DevicePlaybackGenerationTest {
    @Test
    public void repeatedLoadWithIdenticalOwnerRevisionAndEntryDiscardsBothOldEventKinds() throws Exception {
        DeviceQueueRequest request = DeviceAudioValidator.loadRequest(DeviceYouTubeQueueTest.youtubeRequest(), true);
        DevicePlaybackGeneration fence = new DevicePlaybackGeneration();
        DevicePlaybackGeneration.QueueToken first = fence.replace(request);
        DevicePlaybackGeneration.Attempt oldAttempt = fence.beginAttempt(first, request.tracks().get(0).entryId());
        DevicePlaybackGeneration.QueueToken second = fence.replace(request);
        DevicePlaybackGeneration.Attempt current = fence.beginAttempt(second, request.tracks().get(0).entryId());
        assertFalse(fence.accepts(first));
        assertFalse(fence.accepts(oldAttempt));
        assertFalse(fence.acceptsEvent(oldAttempt, current));
        assertTrue(fence.acceptsEvent(current, current));
    }

    @Test
    public void entryRetryAndDifferentEntryCannotDeliverAnOldSuccessOrError() throws Exception {
        DeviceQueueRequest request = DeviceAudioValidator.loadRequest(DeviceYouTubeQueueTest.youtubeRequest(), true);
        DevicePlaybackGeneration fence = new DevicePlaybackGeneration();
        DevicePlaybackGeneration.QueueToken queue = fence.replace(request);
        UUID entry = request.tracks().get(0).entryId();
        DevicePlaybackGeneration.Attempt first = fence.beginAttempt(queue, entry);
        DevicePlaybackGeneration.Attempt retry = fence.beginAttempt(queue, entry);
        DevicePlaybackGeneration.Attempt other = fence.beginAttempt(queue, UUID.randomUUID());
        assertFalse(fence.accepts(first));
        assertTrue(fence.accepts(retry));
        assertFalse(fence.acceptsEvent(other, retry));
        assertFalse(fence.acceptsEvent(first, retry));
    }

    @Test
    public void pauseDuringResolveCannotBecomePlayIntentOnLateCompletion() throws Exception {
        DeviceQueueRequest request = DeviceAudioValidator.loadRequest(DeviceYouTubeQueueTest.youtubeRequest(), true);
        DevicePlaybackGeneration fence = new DevicePlaybackGeneration();
        DevicePlaybackGeneration.QueueToken queue = fence.replace(request);
        DevicePlaybackGeneration.Attempt attempt = fence.beginAttempt(queue, request.tracks().get(0).entryId());
        fence.setPlayRequested(queue, true);
        fence.setPlayRequested(queue, false);
        assertTrue(fence.accepts(attempt));
        assertFalse(fence.playRequested(queue));
        // Observing a valid completion does not change explicit playback intent.
        assertTrue(fence.acceptsEvent(attempt, attempt));
        assertFalse(fence.playRequested(queue));
    }

    @Test
    public void stopDestroyAndOwnerReplacementInvalidateOutstandingAttempts() throws Exception {
        DeviceQueueRequest request = DeviceAudioValidator.loadRequest(DeviceYouTubeQueueTest.youtubeRequest(), true);
        DevicePlaybackGeneration fence = new DevicePlaybackGeneration();
        DevicePlaybackGeneration.QueueToken oldQueue = fence.replace(request);
        DevicePlaybackGeneration.Attempt attempt = fence.beginAttempt(oldQueue, request.tracks().get(0).entryId());
        fence.invalidate();
        fence.setPlayRequested(oldQueue, true);
        assertFalse(fence.accepts(attempt));
        assertFalse(fence.playRequested(oldQueue));
        DeviceQueueRequest nextOwner = new DeviceQueueRequest("owner-2", request.revision(), request.tracks(),
            0, 0, false, "off", false, 1);
        DevicePlaybackGeneration.QueueToken next = fence.replace(nextOwner);
        fence.setPlayRequested(oldQueue, true);
        assertFalse(fence.acceptsEvent(attempt, fence.beginAttempt(next, request.tracks().get(0).entryId())));
        assertFalse(fence.playRequested(next));
    }
}
