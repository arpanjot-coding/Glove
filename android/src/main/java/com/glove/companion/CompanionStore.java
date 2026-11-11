package com.glove.companion;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Collections;
import java.util.Set;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;

final class CompanionStore {
    static final String PAIR = "pair";
    static final String APPS = "allowedApps";
    static final String PAUSED = "paused";
    private static final String KEY_ALIAS = "glove-companion-pair";
    private static final String CIPHER = "AES/GCM/NoPadding";
    final SharedPreferences preferences;

    static final class Pair {
        final PeerConnection peer;
        final String ticket;

        Pair(PeerConnection peer, String ticket) {
            this.peer = peer;
            this.ticket = PeerConnection.credential(ticket);
        }
    }

    CompanionStore(Context context) {
        preferences = context.getSharedPreferences("glove", Context.MODE_PRIVATE);
    }

    Pair pair() {
        String record = preferences.getString(PAIR, null);
        if (record == null) return null;
        try {
            String[] parts = record.split(":", 2);
            Cipher cipher = Cipher.getInstance(CIPHER);
            byte[] iv = Base64.decode(parts[0], Base64.NO_WRAP);
            cipher.init(Cipher.DECRYPT_MODE, secretKey(), new GCMParameterSpec(128, iv));
            byte[] data = cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP));
            JSONObject value = new JSONObject(new String(data, StandardCharsets.UTF_8));
            return new Pair(new PeerConnection(value.getString("url"), value.getString("pin")),
                value.getString("ticket"));
        } catch (Exception error) {
            return null;
        }
    }

    void pair(Pair pair) throws Exception {
        JSONObject value = new JSONObject()
            .put("url", pair.peer.origin)
            .put("pin", pair.peer.fingerprint)
            .put("ticket", pair.ticket);
        Cipher cipher = Cipher.getInstance(CIPHER);
        cipher.init(Cipher.ENCRYPT_MODE, secretKey());
        byte[] ciphertext = cipher.doFinal(value.toString().getBytes(StandardCharsets.UTF_8));
        String record = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP)
            + ":" + Base64.encodeToString(ciphertext, Base64.NO_WRAP);
        if (!preferences.edit().putString(PAIR, record).remove(APPS).remove(PAUSED).commit()) {
            forget();
            throw new IllegalStateException("Unable to save the PC pairing");
        }
    }

    boolean matches(Pair expected) {
        Pair current = pair();
        return current != null && current.ticket.equals(expected.ticket)
            && current.peer.origin.equals(expected.peer.origin);
    }

    void forget() {
        preferences.edit().remove(PAIR).remove(APPS).remove(PAUSED).apply();
    }

    boolean paused() {
        return preferences.getBoolean(PAUSED, false);
    }

    void pause(boolean paused) {
        preferences.edit().putBoolean(PAUSED, paused).apply();
    }

    Set<String> apps() {
        return preferences.getStringSet(APPS, Collections.emptySet());
    }

    void apps(Set<String> packages) {
        preferences.edit().putStringSet(APPS, packages).apply();
    }

    private SecretKey secretKey() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        SecretKey key = (SecretKey) store.getKey(KEY_ALIAS, null);
        if (key != null) return key;
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .build());
        return generator.generateKey();
    }
}
