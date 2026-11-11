package com.lattelix.aurelia.cloudsession;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import java.io.File;
import java.io.FileOutputStream;
import java.security.KeyStore;
import javax.crypto.AEADBadTagException;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;

final class CloudTokenStore {
    private static final String ALIAS = "aurelia.cloud-session.aes-gcm.v1";
    private final AtomicFile file;
    CloudTokenStore(Context context) { file = new AtomicFile(new File(context.getNoBackupFilesDir(), "aurelia-cloud-session.enc")); }
    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (store.containsAlias(ALIAS)) return (SecretKey) store.getKey(ALIAS, null);
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true).setUserAuthenticationRequired(false).build());
        return generator.generateKey();
    }
    synchronized String read() throws CloudFailure {
        try {
            // openRead owns recovery of an interrupted AtomicFile write, including
            // legacy .bak files whose base path may currently be absent.
            byte[] sealed = CloudTokenFile.read(file::openRead);
            if (sealed == null) return null;
            CredentialCipher.Stored stored = CredentialCipher.decrypt(sealed, key());
            if (stored.expiresAt <= System.currentTimeMillis()) { clear(); return null; }
            return stored.token;
        } catch (AEADBadTagException error) { clear(); return null; }
        catch (Exception ignored) { throw new CloudFailure("cloud-storage-failed"); }
    }
    synchronized void save(String token, long expiresIn) throws CloudFailure {
        if (expiresIn < 1 || expiresIn > 366L * 86400) throw new CloudFailure("cloud-invalid-response");
        try {
            byte[] bytes = CredentialCipher.encrypt(token, System.currentTimeMillis() + expiresIn * 1000, key());
            FileOutputStream output = file.startWrite();
            try { output.write(bytes); file.finishWrite(output); }
            catch (Exception error) { file.failWrite(output); throw error; }
        } catch (Exception ignored) { throw new CloudFailure("cloud-storage-failed"); }
    }
    synchronized void clear() { file.delete(); }
}
