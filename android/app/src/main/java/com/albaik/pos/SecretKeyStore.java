package com.albaik.pos;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Log;

import java.io.File;
import java.security.KeyStore;
import java.security.SecureRandom;
import java.util.Arrays;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * The 32-byte key the backend uses to seal the master PIN, JWT secret and
 * Google Drive tokens. It is stored wrapped by a non-exportable Android
 * Keystore key, so a copy of the app's files is useless on another device.
 */
final class SecretKeyStore {
    private static final String TAG = "AlBaikSecrets";
    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String ALIAS = "albaik_pos_secret_wrap";
    private static final int IV_BYTES = 12;

    private SecretKeyStore() {}

    static synchronized byte[] loadOrCreate(Context context) throws Exception {
        File file = new File(context.getNoBackupFilesDir(), "secret-key.bin");
        SecretKey wrappingKey = wrappingKey();
        if (file.exists()) {
            try {
                byte[] blob = IoUtil.readFile(file);
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.DECRYPT_MODE, wrappingKey, new GCMParameterSpec(128, Arrays.copyOfRange(blob, 0, IV_BYTES)));
                byte[] key = cipher.doFinal(blob, IV_BYTES, blob.length - IV_BYTES);
                if (key.length == 32) return key;
            } catch (Exception e) {
                Log.e(TAG, "Stored secret key is unreadable; keeping it aside and creating a new one", e);
            }
            //noinspection ResultOfMethodCallIgnored
            file.renameTo(new File(file.getPath() + ".unreadable-" + System.currentTimeMillis()));
        }
        byte[] key = new byte[32];
        new SecureRandom().nextBytes(key);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, wrappingKey);
        byte[] sealed = cipher.doFinal(key);
        byte[] iv = cipher.getIV();
        byte[] blob = new byte[iv.length + sealed.length];
        System.arraycopy(iv, 0, blob, 0, iv.length);
        System.arraycopy(sealed, 0, blob, iv.length, sealed.length);
        IoUtil.writeFileAtomically(file, blob);
        return key;
    }

    private static SecretKey wrappingKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance(KEYSTORE);
        keyStore.load(null);
        if (keyStore.containsAlias(ALIAS)) return (SecretKey) keyStore.getKey(ALIAS, null);
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build());
        return generator.generateKey();
    }
}
