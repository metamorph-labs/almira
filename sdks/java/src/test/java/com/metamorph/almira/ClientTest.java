package com.metamorph.almira;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayInputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.io.TempDir;

import static org.junit.jupiter.api.Assertions.*;

final class ClientTest {
    @TempDir Path temporary;
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String TENANT = "018f0000-0000-7000-8000-000000000002";
    private static final String PROJECT = "018f0000-0000-7000-8000-000000000003";
    private static final String ENVIRONMENT = "018f0000-0000-7000-8000-000000000004";
    private static final String COLLECTION = "018f0000-0000-7000-8000-000000000005";
    private static final String OPERATION = "018f0000-0000-7000-8000-000000000008";
    private static final String CAPABILITY = "alm_cap_v1.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    @Test void dataAndServerCredentialBoundariesAreExact() {
        assertThrows(ClientException.class, () -> new AlmiraDataClient("https://almira.test", () -> CAPABILITY, "https://app.example/"));
        var transport = new RecordingTransport();
        var reference = new AlmiraDataClient.CollectionReference(TENANT, PROJECT, ENVIRONMENT, COLLECTION);
        var client = new AlmiraDataClient("https://almira.test", () -> CAPABILITY, "https://app.example", transport);
        client.listFilesWithCapability(reference, Map.of("limit", 25));
        try (var ignored = client.readShare("alm_share_v1.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", null, null)) {} catch (Exception error) { fail(error); }
        assertThrows(ClientException.class, () -> client.readShare("alm_share_v1.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "bytes=unsafe", null));
        assertEquals("Bearer " + CAPABILITY, transport.calls.get(0).headers.get("authorization"));
        assertFalse(transport.calls.get(1).headers.containsKey("authorization"));

        var server = new AlmiraServerClient("https://almira.test", () -> "workload_evidence", transport);
        server.createUpload(reference, JSON.createObjectNode().put("path", "avatar.png"), OPERATION);
        assertEquals("MetamorphWorkload workload_evidence", transport.calls.get(2).headers.get("authorization"));
        assertEquals(TENANT, transport.calls.get(2).headers.get("x-almira-tenant-id"));
        assertEquals(Wire.CONTRACT_VERSION, AlmiraDataClient.CONTRACT_VERSION);
    }

    @Test void directTransferReturnsOnlyFinalizeEvidence() throws Exception {
        Path source = temporary.resolve("source.bin"); Files.writeString(source, "hello");
        String digest = "sha256:" + java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest("hello".getBytes()));
        var descriptor = JSON.createObjectNode()
            .put("descriptor_id", OPERATION).put("protocol", "single_put").put("expected_size_bytes", 5)
            .put("content_sha256", digest).put("one_use", true).put("expires_at", "2099-01-01T00:00:00Z")
            .putNull("part_size_bytes").put("part_count", 1);
        var part = JSON.createObjectNode().put("part_number", 1).put("offset_bytes", 0).put("length_bytes", 5).put("method", "PUT").put("url", "https://storage.test/secret").put("one_use", true);
        part.set("headers", JSON.createArrayNode());
        descriptor.putArray("requests").add(part);
        var result = DirectTransfer.uploadDirect(descriptor, source, null, (uploadPart, ignored) -> new DirectTransfer.UploadResponse(200, Map.of("etag", "\"v1\"")));
        assertEquals("\"v1\"", result.path("etag").asText());
        assertFalse(result.toString().contains("storage.test"));
    }

    @Test void verifiesTheCommonWebhookVectorAndRejectsTampering() {
        byte[] body = "{\"event\":\"almira.file.available.v1\"}".getBytes(StandardCharsets.UTF_8);
        var headers = new LinkedHashMap<>(Map.of(
            "metamorph-webhook-delivery-id", "018f0000-0000-7000-8000-000000000011",
            "metamorph-webhook-event-id", "018f0000-0000-7000-8000-000000000012",
            "metamorph-webhook-attempt", "2",
            "metamorph-webhook-timestamp", "2026-10-17T12:00:00.000000Z",
            "metamorph-webhook-signature", "v1=PHaG4k_rjkr4itoseS10o0_znK6FR9aoArs7pPV2klI"
        ));
        var verified = WebhookVerifier.verifyWebhookSignature("topsecret".getBytes(StandardCharsets.UTF_8), body, headers, Instant.parse("2026-10-17T12:00:30Z"), Duration.ofMinutes(5));
        assertNotNull(verified);
        assertEquals(2, verified.attempt());
        headers.put("metamorph-webhook-signature", "v1=AHaG4k_rjkr4itoseS10o0_znK6FR9aoArs7pPV2klI");
        assertNull(WebhookVerifier.verifyWebhookSignature("topsecret".getBytes(StandardCharsets.UTF_8), body, headers, Instant.parse("2026-10-17T12:00:30Z"), Duration.ofMinutes(5)));
    }

    @Test void verifiesTheCommonBehaviorReceiptVectorAndRejectsSubstitution() throws Exception {
        var vector = JSON.readTree(Files.readString(Path.of("..", "..", "conformance", "application-sdk.v1.json")));
        var receipt = vector.path("behavior_receipt");
        var expected = receipt.path("expected");
        var expectation = new VerificationReceiptVerifier.Expectation(
            expected.path("verification_id").asText(), expected.path("tenant_id").asText(),
            expected.path("project_id").asText(), expected.path("environment_id").asText(),
            expected.path("collection_instance_id").asText(), expected.path("entry_id").asText(),
            expected.path("generation_id").asText(), expected.path("expected_size_bytes").asLong(),
            expected.path("content_sha256").asText()
        );
        assertTrue(VerificationReceiptVerifier.verify(receipt.path("signed"), receipt.path("key_set"), expectation));
        var substitution = new VerificationReceiptVerifier.Expectation(
            expectation.verificationId(), expectation.tenantId(), expectation.projectId(), expectation.environmentId(),
            expectation.collectionInstanceId(), expectation.entryId(), receipt.path("substitution").path("generation_id").asText(),
            expectation.expectedSizeBytes(), expectation.contentSha256()
        );
        assertFalse(VerificationReceiptVerifier.verify(receipt.path("signed"), receipt.path("key_set"), substitution));
        var tampered = receipt.path("signed").deepCopy();
        ((ObjectNode) tampered.path("receipt")).put("generation_id", substitution.generationId());
        assertFalse(VerificationReceiptVerifier.verify(tampered, receipt.path("key_set"), null));
    }

    @Test void commonManagedDevelopmentPositiveRefusalRetryAndCleanupJourney() throws Exception {
        var journey = JSON.readTree(Files.readString(Path.of("..", "..", "conformance", "application-sdk.v1.json")))
            .path("managed_development");
        var ids = journey.path("reference");
        var reference = new AlmiraDataClient.FileReference(
            ids.path("tenant_id").asText(), ids.path("project_id").asText(),
            ids.path("environment_id").asText(), ids.path("collection_instance_id").asText(),
            ids.path("entry_id").asText()
        );
        var authorities = new ArrayList<String>();
        Wire.Transport positiveTransport = (method, uri, headers, body) -> {
            authorities.add(headers.get("authorization"));
            return jsonResponse(200, journey.path("positive").path("response"), Map.of());
        };
        var positive = new AlmiraDataClient(
            journey.path("base_url").asText(), () -> journey.path("positive").path("capability").asText(),
            journey.path("origin").asText(), positiveTransport
        );
        assertEquals(ids.path("entry_id").asText(), positive.getFileMetadataWithCapability(reference).path("entry_id").asText());
        assertEquals(List.of("Bearer " + journey.path("positive").path("capability").asText()), authorities);

        var refusalCalls = new AtomicInteger();
        var refused = new AlmiraDataClient(
            journey.path("base_url").asText(), () -> journey.path("refusal").path("credential").asText(), null,
            (method, uri, headers, body) -> { refusalCalls.incrementAndGet(); return jsonResponse(200, journey.path("positive").path("response"), Map.of()); }
        );
        var refusal = assertThrows(ClientException.class, () -> refused.getFileMetadataWithCapability(reference));
        assertEquals(journey.path("refusal").path("client_code").asText(), refusal.code());
        assertEquals(0, refusalCalls.get());

        var credentialAttempt = new AtomicInteger();
        var transportAttempt = new AtomicInteger();
        authorities.clear();
        Wire.Transport retryTransport = (method, uri, headers, body) -> {
            authorities.add(headers.get("authorization"));
            if (transportAttempt.getAndIncrement() == 0) {
                return jsonResponse(journey.path("retry").path("first_status").asInt(), journey.path("retry").path("first_error"), Map.of("retry-after", "0"));
            }
            return jsonResponse(journey.path("retry").path("final_status").asInt(), journey.path("positive").path("response"), Map.of());
        };
        var retrying = new AlmiraDataClient(
            journey.path("base_url").asText(),
            () -> journey.path("retry").path("capabilities").path(credentialAttempt.getAndIncrement()).asText(),
            null, retryTransport, new AlmiraDataClient.RetryPolicy(2, Duration.ZERO, Duration.ZERO)
        );
        assertEquals(ids.path("entry_id").asText(), retrying.getFileMetadataWithCapability(reference).path("entry_id").asText());
        assertEquals(List.of(
            "Bearer " + journey.path("retry").path("capabilities").path(0).asText(),
            "Bearer " + journey.path("retry").path("capabilities").path(1).asText()
        ), authorities);
        assertFalse(journey.path("cleanup").path("applicable").asBoolean());
        assertEquals("read_only_journey", journey.path("cleanup").path("reason").asText());
    }

    private static Wire.Response jsonResponse(int status, com.fasterxml.jackson.databind.JsonNode body, Map<String, String> headers) throws Exception {
        var responseHeaders = new LinkedHashMap<>(headers);
        responseHeaders.put("content-type", "application/json");
        return new Wire.Response(status, responseHeaders, new ByteArrayInputStream(JSON.writeValueAsBytes(body)));
    }

    private record Call(String method, URI uri, Map<String, String> headers, byte[] body) {}
    private static final class RecordingTransport implements Wire.Transport {
        private final List<Call> calls = new ArrayList<>();
        @Override public Wire.Response send(String method, URI uri, Map<String, String> headers, byte[] body) {
            calls.add(new Call(method, uri, new LinkedHashMap<>(headers), body));
            boolean share = uri.getPath().contains("/shares/");
            boolean upload = uri.getPath().contains("/uploads");
            return new Wire.Response(upload ? 201 : 200, Map.of("content-type", share ? "application/octet-stream" : "application/json"), new ByteArrayInputStream((share ? "hello" : "{}").getBytes()));
        }
    }
}
