package com.lattelix.aurelia.cloudsession;

import static org.junit.Assert.*;
import org.junit.Test;

public class DeviceGrantStateTest {
    private long now;
    @Test public void pollsAreReservedAndSlowDownCannotBeBypassedByQueuedCalls() {
        DeviceGrantState state = new DeviceGrantState(() -> now);
        long generation = state.reset(); assertTrue(state.install(generation, "synthetic-code", "synthetic-verifier"));
        assertNull(state.poll().deviceCode); now = 3000;
        DeviceGrantState.Poll first = state.poll(); assertEquals("synthetic-code", first.deviceCode); assertNull(state.poll().deviceCode);
        now = 6000; DeviceGrantState.Poll queued = state.poll(); assertTrue(state.canSend(queued));
        state.slowDown(generation); assertFalse(state.canSend(queued)); now = 13_999; assertNull(state.poll().deviceCode);
        now = 14_000; assertEquals("synthetic-code", state.poll().deviceCode);
        assertEquals("CloudGrant(redacted)", first.toString());
    }
    @Test public void cancelAndNewStartInvalidateOldApprovalImmediately() {
        DeviceGrantState state = new DeviceGrantState(() -> now);
        long old = state.reset(); assertTrue(state.install(old, "old-code", "proof")); now = 3000;
        DeviceGrantState.Poll pending = state.poll(); state.reset();
        assertFalse(state.current(pending.generation)); assertFalse(state.install(old, "late-code", "proof")); assertNull(state.poll());
    }
    @Test public void queuedPollsCannotBurstWhenTheWorkerBecomesFree() {
        DeviceGrantState state = new DeviceGrantState(() -> now);
        long generation = state.reset(); assertTrue(state.install(generation, "code", "proof"));
        now = 3000; DeviceGrantState.Poll first = state.poll();
        now = 6000; DeviceGrantState.Poll second = state.poll();
        now = 9000; DeviceGrantState.Poll third = state.poll();
        now = 12_000; assertTrue(state.canSend(first));
        assertFalse(state.canSend(second)); assertFalse(state.canSend(third));
        now = 14_999; assertFalse(state.canSend(second));
        now = 15_000; assertTrue(state.canSend(state.poll()));
    }
    @Test public void ttlStartsBeforeNetworkAndExpiresInTenMinutes() {
        DeviceGrantState state = new DeviceGrantState(() -> now); long generation = state.reset(); now = 30_000;
        assertTrue(state.install(generation, "code", "proof")); now = 600_000;
        assertNull(state.poll()); assertFalse(state.current(generation)); assertFalse(state.install(generation, "late", "proof"));
    }
}
