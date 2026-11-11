package com.glove.companion;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Proxy;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;
import org.json.JSONException;
import org.json.JSONObject;

final class PeerConnection {
    private static final ExecutorService REVOCATIONS = Executors.newSingleThreadExecutor();

    static final class StatusException extends IOException {
        final int status;

        StatusException(int status) {
            super("PC returned " + status);
            this.status = status;
        }
    }

    static final class Invitation {
        final PeerConnection peer;
        final String token;

        private Invitation(PeerConnection peer, String token) {
            this.peer = peer;
            this.token = token;
        }

        static Invitation parse(String text) throws Exception {
            if (text.length() > 512) throw new IllegalArgumentException("Pairing code is too long");
            JSONObject value = new JSONObject(text);
            if (value.getInt("v") != 1) throw new IllegalArgumentException("Unknown pairing version");
            PeerConnection peer = new PeerConnection(value.getString("url"), value.getString("fingerprint"));
            return new Invitation(peer, credential(value.getString("token")));
        }
    }

    final String origin;
    final String fingerprint;
    final String address;
    private final SSLSocketFactory sockets;

    PeerConnection(String origin, String fingerprint) throws GeneralSecurityException {
        URI uri = URI.create(origin);
        String host = uri.getHost();
        if (host == null || !origin.equals("https://" + host + ":43873") || !isLocalIpv4(host)) {
            throw new IllegalArgumentException("Expected the Glove PC's local IPv4 address");
        }
        if (!fingerprint.matches("[a-f0-9]{64}")) throw new IllegalArgumentException("Invalid certificate pin");
        this.origin = origin;
        this.fingerprint = fingerprint;
        this.address = host;

        byte[] expected = new byte[32];
        for (int i = 0; i < expected.length; i++) {
            expected[i] = (byte) Integer.parseInt(fingerprint.substring(i * 2, i * 2 + 2), 16);
        }
        SSLContext tls = SSLContext.getInstance("TLS");
        tls.init(null, new TrustManager[] {new PinnedCertificate(expected)}, null);
        sockets = tls.getSocketFactory();
    }

    private static boolean isLocalIpv4(String host) {
        String[] parts = host.split("\\.", -1);
        if (parts.length != 4) return false;
        int[] bytes = new int[4];
        for (int i = 0; i < bytes.length; i++) {
            if (!parts[i].matches("0|[1-9][0-9]{0,2}")) return false;
            bytes[i] = Integer.parseInt(parts[i]);
            if (bytes[i] > 255) return false;
        }
        return bytes[0] == 10
            || (bytes[0] == 172 && bytes[1] >= 16 && bytes[1] <= 31)
            || (bytes[0] == 192 && bytes[1] == 168)
            || (bytes[0] == 169 && bytes[1] == 254);
    }

    static String credential(String value) {
        if (!value.matches("[A-Za-z0-9_-]{20,128}")) throw new IllegalArgumentException("Invalid pairing credential");
        return value;
    }

    JSONObject post(String path, String token, JSONObject body) throws IOException, JSONException {
        URL url = URI.create(origin + path).toURL();
        HttpsURLConnection connection = (HttpsURLConnection) url.openConnection(Proxy.NO_PROXY);
        try {
            connection.setSSLSocketFactory(sockets);
            // The leaf authenticated by PinnedCertificate is the exact certificate in the QR code.
            connection.setHostnameVerifier((host, session) -> address.equals(host));
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(4_000);
            connection.setReadTimeout(4_000);
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);
            connection.setRequestProperty("Authorization", "Bearer " + token);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            byte[] content = body.toString().getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(content.length);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(content);
            }
            int status = connection.getResponseCode();
            if (status != 200) throw new StatusException(status);
            try (InputStream input = connection.getInputStream()) {
                ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                byte[] chunk = new byte[2048];
                int count;
                while ((count = input.read(chunk)) != -1) {
                    if (bytes.size() + count > 16_384) throw new IOException("Glove response is too large");
                    bytes.write(chunk, 0, count);
                }
                return new JSONObject(bytes.toString("UTF-8"));
            }
        } finally {
            connection.disconnect();
        }
    }

    void revoke(String ticket) {
        REVOCATIONS.execute(() -> {
            try {
                post("/v1/pair/revoke", ticket, new JSONObject());
            } catch (IOException | JSONException ignored) {
                // Local cancellation is immediate, including when the PC is offline.
            }
        });
    }

    private static final class PinnedCertificate implements X509TrustManager {
        private final byte[] expected;

        PinnedCertificate(byte[] expected) {
            this.expected = expected;
        }

        @Override public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
            throw new CertificateException("Client certificates are unavailable");
        }

        @Override public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
            if (chain == null || chain.length == 0) throw new CertificateException("Missing Glove certificate");
            chain[0].checkValidity();
            try {
                byte[] received = MessageDigest.getInstance("SHA-256").digest(chain[0].getEncoded());
                if (!MessageDigest.isEqual(expected, received)) throw new CertificateException("Glove certificate changed");
            } catch (GeneralSecurityException error) {
                throw new CertificateException("Glove certificate could not be authenticated", error);
            }
        }

        @Override public X509Certificate[] getAcceptedIssuers() {
            return new X509Certificate[0];
        }
    }
}
