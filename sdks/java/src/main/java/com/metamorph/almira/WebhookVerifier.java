package com.metamorph.almira;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.Instant;
import java.time.format.DateTimeFormatter;
import java.util.Base64;
import java.util.Locale;
import java.util.Map;

public final class WebhookVerifier {
    private WebhookVerifier() {}

    public record VerifiedWebhook(String deliveryId, String eventId, int attempt, String timestamp) {}

    public static VerifiedWebhook verifyWebhookSignature(byte[] secret, byte[] body, Map<String, String> headers, Instant now, Duration tolerance) {
        if (secret == null || secret.length == 0 || body == null || body.length > 272 * 1024 || tolerance.isNegative()) return null;
        String delivery = header(headers, "metamorph-webhook-delivery-id");
        String event = header(headers, "metamorph-webhook-event-id");
        String attempt = header(headers, "metamorph-webhook-attempt");
        String timestamp = header(headers, "metamorph-webhook-timestamp");
        String signature = header(headers, "metamorph-webhook-signature");
        if (delivery == null || !Wire.UUID_V7.matcher(delivery).matches() || event == null || !Wire.UUID_V7.matcher(event).matches() || attempt == null || !attempt.matches("[1-8]") || timestamp == null || signature == null || !signature.matches("v1=[A-Za-z0-9_-]{43}")) return null;
        try {
            Instant occurred = Instant.from(DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSSSSS'Z'").withZone(java.time.ZoneOffset.UTC).parse(timestamp));
            if (Duration.between(occurred, now).abs().compareTo(tolerance) > 0) return null;
            String bodyDigest = "sha256:" + java.util.HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(body));
            String transcript = String.join("\n", "metamorph-webhook-v1", delivery, event, attempt, timestamp, bodyDigest);
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret, "HmacSHA256"));
            String expected = Base64.getUrlEncoder().withoutPadding().encodeToString(mac.doFinal(transcript.getBytes(StandardCharsets.UTF_8)));
            byte[] actual = signature.substring(3).getBytes(StandardCharsets.US_ASCII);
            if (!MessageDigest.isEqual(expected.getBytes(StandardCharsets.US_ASCII), actual)) return null;
            return new VerifiedWebhook(delivery, event, Integer.parseInt(attempt), timestamp);
        } catch (Exception error) {
            return null;
        }
    }

    private static String header(Map<String, String> headers, String name) {
        String result = null;
        for (var entry : headers.entrySet()) {
            if (!entry.getKey().toLowerCase(Locale.ROOT).equals(name)) continue;
            if (result != null || entry.getValue().contains(",")) return null;
            result = entry.getValue();
        }
        return result;
    }
}
