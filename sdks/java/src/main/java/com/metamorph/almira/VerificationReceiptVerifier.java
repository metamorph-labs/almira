package com.metamorph.almira;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.security.KeyFactory;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Pattern;

/** Closed-shape Ed25519 verification for Almira V1 behavior receipts. */
public final class VerificationReceiptVerifier {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Pattern DIGEST = Pattern.compile("^sha256:[0-9a-f]{64}$");
    private static final Pattern KEY_ID = Pattern.compile("^[a-z][a-z0-9._-]{0,63}$");
    private static final List<String> CHECKS = List.of(
        "finalization_idempotency", "private_read_integrity", "cross_scope_refusal", "malware_safety"
    );
    private static final byte[] ED25519_X509_PREFIX = java.util.HexFormat.of().parseHex("302a300506032b6570032100");

    private VerificationReceiptVerifier() {}

    public record Expectation(
        String verificationId,
        String tenantId,
        String projectId,
        String environmentId,
        String collectionInstanceId,
        String entryId,
        String generationId,
        long expectedSizeBytes,
        String contentSha256
    ) {}

    /** Verifies a receipt against an explicitly trusted key set and optional exact resource binding. */
    public static boolean verify(JsonNode signed, JsonNode keySet, Expectation expected) {
        try {
            if (!exactKeys(signed, Set.of("algorithm", "receipt", "signature")) ||
                !signed.path("algorithm").asText().equals("ed25519") ||
                !validReceipt(signed.path("receipt")) ||
                !exactKeys(keySet, Set.of("format_version", "keys")) ||
                keySet.path("format_version").asInt(-1) != 1 || !keySet.path("keys").isArray() ||
                keySet.path("keys").size() < 1 || keySet.path("keys").size() > 4 ||
                (expected != null && !matches(signed.path("receipt"), expected))) return false;

            byte[] signature = decodeBase64Url(signed.path("signature").asText(), 64);
            if (signature == null) return false;
            String signingKeyId = signed.path("receipt").path("signing_key_id").asText();
            var matches = new ArrayList<JsonNode>();
            for (JsonNode key : keySet.path("keys")) {
                if (!exactKeys(key, Set.of("algorithm", "key_id", "public_key")) ||
                    !key.path("algorithm").asText().equals("ed25519") ||
                    !KEY_ID.matcher(key.path("key_id").asText()).matches()) return false;
                if (key.path("key_id").asText().equals(signingKeyId)) matches.add(key);
            }
            if (matches.size() != 1) return false;
            byte[] rawPublicKey = decodeBase64Url(matches.get(0).path("public_key").asText(), 32);
            if (rawPublicKey == null) return false;
            byte[] encoded = new byte[ED25519_X509_PREFIX.length + rawPublicKey.length];
            System.arraycopy(ED25519_X509_PREFIX, 0, encoded, 0, ED25519_X509_PREFIX.length);
            System.arraycopy(rawPublicKey, 0, encoded, ED25519_X509_PREFIX.length, rawPublicKey.length);
            var verifier = Signature.getInstance("Ed25519");
            verifier.initVerify(KeyFactory.getInstance("Ed25519").generatePublic(new X509EncodedKeySpec(encoded)));
            verifier.update(JSON.writeValueAsBytes(canonical(signed.path("receipt"))));
            return verifier.verify(signature);
        } catch (Exception ignored) {
            return false;
        }
    }

    private static boolean validReceipt(JsonNode receipt) {
        if (!exactKeys(receipt, Set.of(
            "checks", "collection_instance_id", "content_sha256", "contract_version", "entry_id",
            "environment_id", "expected_size_bytes", "generation_id", "project_id", "realm_id",
            "receipt_version", "safety_state", "signing_key_id", "tenant_id", "verification_id"
        )) || !receipt.path("receipt_version").asText().equals("almira.verification.v1") ||
            !receipt.path("contract_version").asText().equals(Wire.CONTRACT_VERSION) ||
            !KEY_ID.matcher(receipt.path("signing_key_id").asText()).matches() ||
            !DIGEST.matcher(receipt.path("content_sha256").asText()).matches() ||
            !receipt.path("expected_size_bytes").isIntegralNumber() ||
            receipt.path("expected_size_bytes").asLong() < 1 ||
            receipt.path("expected_size_bytes").asLong() > 8L * 1024L * 1024L ||
            !(receipt.path("safety_state").asText().equals("clean") ||
              receipt.path("safety_state").asText().equals("not_required"))) return false;
        for (String field : List.of(
            "verification_id", "realm_id", "tenant_id", "project_id", "environment_id",
            "collection_instance_id", "entry_id", "generation_id"
        )) if (!Wire.UUID_V7.matcher(receipt.path(field).asText()).matches()) return false;
        JsonNode checks = receipt.path("checks");
        if (!checks.isArray() || checks.size() != CHECKS.size()) return false;
        for (int index = 0; index < CHECKS.size(); index++) {
            JsonNode check = checks.get(index);
            if (!exactKeys(check, Set.of("name", "result")) ||
                !check.path("name").asText().equals(CHECKS.get(index)) ||
                !check.path("result").asText().equals("passed")) return false;
        }
        return true;
    }

    private static boolean matches(JsonNode receipt, Expectation expected) {
        return (expected.verificationId() == null || receipt.path("verification_id").asText().equals(expected.verificationId())) &&
            receipt.path("tenant_id").asText().equals(expected.tenantId()) &&
            receipt.path("project_id").asText().equals(expected.projectId()) &&
            receipt.path("environment_id").asText().equals(expected.environmentId()) &&
            receipt.path("collection_instance_id").asText().equals(expected.collectionInstanceId()) &&
            receipt.path("entry_id").asText().equals(expected.entryId()) &&
            receipt.path("generation_id").asText().equals(expected.generationId()) &&
            receipt.path("expected_size_bytes").asLong() == expected.expectedSizeBytes() &&
            receipt.path("content_sha256").asText().equals(expected.contentSha256());
    }

    private static boolean exactKeys(JsonNode value, Set<String> expected) {
        if (!value.isObject()) return false;
        var actual = new TreeSet<String>();
        value.fieldNames().forEachRemaining(actual::add);
        return actual.equals(new TreeSet<>(expected));
    }

    private static JsonNode canonical(JsonNode value) {
        if (value.isArray()) {
            ArrayNode result = JSON.createArrayNode();
            value.forEach(child -> result.add(canonical(child)));
            return result;
        }
        if (value.isObject()) {
            ObjectNode result = JSON.createObjectNode();
            var names = new TreeSet<String>();
            value.fieldNames().forEachRemaining(names::add);
            names.forEach(name -> result.set(name, canonical(value.get(name))));
            return result;
        }
        return value;
    }

    private static byte[] decodeBase64Url(String value, int expectedSize) {
        try {
            if (value == null || value.contains("=")) return null;
            byte[] decoded = Base64.getUrlDecoder().decode(value);
            return decoded.length == expectedSize && Base64.getUrlEncoder().withoutPadding().encodeToString(decoded).equals(value)
                ? decoded : null;
        } catch (IllegalArgumentException ignored) {
            return null;
        }
    }
}
