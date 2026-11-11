package com.lattelix.aurelia.cloudsession;

import static org.junit.Assert.*;
import java.io.ByteArrayInputStream;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStream;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.Test;

public class CloudTokenFileTest {
    @Test public void delegatesToRecoveryAwareOpenerWithoutTestingTheBasePath() throws Exception {
        // The base path may be absent while AtomicFile.openRead can restore .bak.
        // No Android/Keystore dependency is needed to enforce the opener contract.
        AtomicBoolean opened = new AtomicBoolean(), closed = new AtomicBoolean();
        byte[] recovered = {1, 12, 3, 4};
        byte[] actual = CloudTokenFile.read(() -> {
            opened.set(true);
            return new ByteArrayInputStream(recovered) {
                @Override public void close() throws IOException { closed.set(true); super.close(); }
            };
        });
        assertTrue(opened.get()); assertTrue(closed.get()); assertArrayEquals(recovered, actual);
    }
    @Test public void missingFileIsAnonymousButOtherReadFailuresRemainFailures() throws Exception {
        assertNull(CloudTokenFile.read(() -> { throw new FileNotFoundException(); }));
        try { CloudTokenFile.read(() -> { throw new IOException("synthetic read failure"); }); fail(); }
        catch (IOException expected) { assertEquals("synthetic read failure", expected.getMessage()); }
    }
    @Test public void exactCapIsAcceptedAndOnlyOneExtraByteIsRead() throws Exception {
        assertEquals(CredentialCipher.FILE_CAP, CloudTokenFile.read(() -> new ByteArrayInputStream(new byte[CredentialCipher.FILE_CAP])).length);
        final int[] read = {0}; final boolean[] closed = {false};
        InputStream oversized = new InputStream() {
            @Override public int read() { read[0]++; return 0; }
            @Override public void close() { closed[0] = true; }
        };
        try { CloudTokenFile.read(() -> oversized); fail(); }
        catch (CloudFailure expected) { assertEquals("cloud-storage-failed", expected.code); }
        assertEquals(CredentialCipher.FILE_CAP + 1, read[0]); assertTrue(closed[0]);
    }
}
