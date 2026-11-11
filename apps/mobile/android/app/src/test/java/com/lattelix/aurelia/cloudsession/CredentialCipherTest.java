package com.lattelix.aurelia.cloudsession;

import static org.junit.Assert.*;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import org.junit.Test;

public class CredentialCipherTest {
    @Test public void credentialIsAuthenticatedEncryptedWithFreshIv() throws Exception {
        KeyGenerator generator = KeyGenerator.getInstance("AES"); generator.init(256); SecretKey key = generator.generateKey();
        String token = "synthetic-test-bearer-value-only";
        byte[] first = CredentialCipher.encrypt(token, 123456789L, key), second = CredentialCipher.encrypt(token, 123456789L, key);
        assertFalse(Arrays.equals(first, second)); assertFalse(new String(first, StandardCharsets.ISO_8859_1).contains(token));
        CredentialCipher.Stored value = CredentialCipher.decrypt(first, key);
        assertEquals(token, value.token); assertEquals(123456789L, value.expiresAt); assertEquals("CloudCredential(redacted)", value.toString());
        first[first.length - 1] ^= 1;
        try { CredentialCipher.decrypt(first, key); fail("Tampered credential should be rejected"); } catch (javax.crypto.AEADBadTagException expected) { /* authenticated */ }
    }
    @Test public void oversizedAndMalformedCredentialsAreRejected() throws Exception {
        KeyGenerator generator = KeyGenerator.getInstance("AES"); generator.init(256); SecretKey key = generator.generateKey();
        for (byte[] bytes : new byte[][]{new byte[0], new byte[32], new byte[8193]}) {
            try { CredentialCipher.decrypt(bytes, key); fail(); } catch (CloudFailure expected) { assertEquals("cloud-storage-failed", expected.code); }
        }
        try { CredentialCipher.encrypt("Bearer\r\ninjected", 10, key); fail(); } catch (CloudFailure expected) { assertEquals("cloud-storage-failed", expected.code); }
    }
}
