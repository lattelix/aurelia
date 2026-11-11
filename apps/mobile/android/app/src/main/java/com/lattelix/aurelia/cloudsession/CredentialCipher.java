package com.lattelix.aurelia.cloudsession;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** No Android dependency: the device supplies a non-exportable Keystore SecretKey. */
final class CredentialCipher {
    static final int FILE_CAP = 8192;
    static byte[] encrypt(String token, long expiresAt, SecretKey key) throws Exception {
        if (!CloudPolicy.validToken(token) || expiresAt <= 0) throw new CloudFailure("cloud-storage-failed");
        ByteArrayOutputStream plaintext = new ByteArrayOutputStream();
        DataOutputStream fields = new DataOutputStream(plaintext);
        byte[] tokenBytes = token.getBytes(StandardCharsets.US_ASCII);
        fields.writeLong(expiresAt); fields.writeInt(tokenBytes.length); fields.write(tokenBytes);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key);
        byte[] iv = cipher.getIV();
        if (iv.length != 12) throw new CloudFailure("cloud-storage-failed");
        byte[] clear = plaintext.toByteArray();
        byte[] sealed;
        try { sealed = cipher.doFinal(clear); } finally { Arrays.fill(clear, (byte) 0); Arrays.fill(tokenBytes, (byte) 0); }
        ByteArrayOutputStream result = new ByteArrayOutputStream();
        result.write(1); result.write(iv.length); result.write(iv); result.write(sealed);
        return result.toByteArray();
    }
    static Stored decrypt(byte[] sealed, SecretKey key) throws Exception {
        if (sealed.length < 31 || sealed.length > FILE_CAP || sealed[0] != 1 || sealed[1] != 12)
            throw new CloudFailure("cloud-storage-failed");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, Arrays.copyOfRange(sealed, 2, 14)));
        byte[] clear = cipher.doFinal(sealed, 14, sealed.length - 14);
        try {
            DataInputStream fields = new DataInputStream(new ByteArrayInputStream(clear));
            long expires = fields.readLong(); int size = fields.readInt();
            if (size < 16 || size > 4096 || size != fields.available()) throw new CloudFailure("cloud-storage-failed");
            byte[] token = new byte[size]; fields.readFully(token);
            String value = new String(token, StandardCharsets.US_ASCII); Arrays.fill(token, (byte) 0);
            if (!CloudPolicy.validToken(value) || expires <= 0) throw new CloudFailure("cloud-storage-failed");
            return new Stored(value, expires);
        } finally { Arrays.fill(clear, (byte) 0); }
    }
    static final class Stored {
        final String token; final long expiresAt;
        Stored(String token, long expiresAt) { this.token = token; this.expiresAt = expiresAt; }
        @Override public String toString() { return "CloudCredential(redacted)"; }
    }
}
