package com.lattelix.aurelia.cloudsession;

import java.io.ByteArrayOutputStream;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStream;

/** Android-free bounded reader; the supplied AtomicFile opener performs recovery. */
final class CloudTokenFile {
    interface Reader { InputStream open() throws IOException; }

    static byte[] read(Reader reader) throws IOException, CloudFailure {
        try (InputStream input = reader.open()) {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream(1024);
            byte[] buffer = new byte[1024];
            while (true) {
                // One extra byte distinguishes exact EOF from an oversized file.
                int remaining = CredentialCipher.FILE_CAP + 1 - bytes.size();
                int count = input.read(buffer, 0, Math.min(buffer.length, remaining));
                if (count == -1) return bytes.toByteArray();
                if (count == 0) {
                    int value = input.read();
                    if (value == -1) return bytes.toByteArray();
                    bytes.write(value);
                } else { bytes.write(buffer, 0, count); }
                if (bytes.size() > CredentialCipher.FILE_CAP) throw new CloudFailure("cloud-storage-failed");
            }
        } catch (FileNotFoundException missing) { return null; }
    }
}
