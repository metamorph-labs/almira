package com.metamorph.almira;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.function.Supplier;

public final class AlmiraDataClient {
    public static final String CONTRACT_VERSION = Wire.CONTRACT_VERSION;
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final int MAX_JSON_BYTES = 2 * 1024 * 1024;
    private final URI baseUrl;
    private final Supplier<String> capability;
    private final String origin;
    private final Wire.Transport transport;
    private final RetryPolicy retry;

    public record RetryPolicy(int maxAttempts, Duration baseDelay, Duration maximumDelay) {
        public RetryPolicy {
            if (maxAttempts < 1 || maxAttempts > 5 || baseDelay.isNegative() || maximumDelay.compareTo(baseDelay) < 0 || maximumDelay.compareTo(Duration.ofMinutes(1)) > 0) throw ClientException.input();
        }
        public RetryPolicy() { this(1, Duration.ofMillis(100), Duration.ofSeconds(5)); }
    }

    public record CollectionReference(String tenantId, String projectId, String environmentId, String collectionInstanceId) {
        Wire.CollectionReference wire() { return new Wire.CollectionReference(tenantId, projectId, environmentId, collectionInstanceId); }
    }
    public record FileReference(String tenantId, String projectId, String environmentId, String collectionInstanceId, String entryId) {
        Wire.FileReference wire() { return new Wire.FileReference(tenantId, projectId, environmentId, collectionInstanceId, entryId); }
    }
    public record GenerationReference(String tenantId, String projectId, String environmentId, String collectionInstanceId, String entryId, String generationId) {
        Wire.GenerationReference wire() { return new Wire.GenerationReference(tenantId, projectId, environmentId, collectionInstanceId, entryId, generationId); }
    }
    public record DerivativeReference(String tenantId, String projectId, String environmentId, String collectionInstanceId, String entryId, String generationId, String variantKey) {
        Wire.DerivativeReference wire() { return new Wire.DerivativeReference(tenantId, projectId, environmentId, collectionInstanceId, entryId, generationId, variantKey); }
    }

    public static final class BinaryResponse implements AutoCloseable {
        private final int status;
        private final Map<String, String> headers;
        private final InputStream body;
        BinaryResponse(Wire.Response response) { status = response.status(); headers = response.headers(); body = response.body(); }
        public int status() { return status; }
        public Map<String, String> headers() { return headers; }
        public InputStream body() { return body; }
        @Override public void close() throws IOException { body.close(); }
    }

    public AlmiraDataClient(String baseUrl, Supplier<String> capability, String origin) {
        this(baseUrl, capability, origin, new Wire.JdkTransport(Duration.ofSeconds(30)), new RetryPolicy());
    }

    public AlmiraDataClient(String baseUrl, Supplier<String> capability, String origin, RetryPolicy retry) {
        this(baseUrl, capability, origin, new Wire.JdkTransport(Duration.ofSeconds(30)), retry);
    }

    public AlmiraDataClient(String baseUrl, Supplier<String> capability, String origin, Wire.Transport transport) {
        this(baseUrl, capability, origin, transport, new RetryPolicy());
    }

    AlmiraDataClient(String baseUrl, Supplier<String> capability, String origin, Wire.Transport transport, RetryPolicy retry) {
        this.baseUrl = Wire.baseUri(baseUrl);
        this.capability = capability;
        this.origin = Wire.origin(origin);
        this.transport = java.util.Objects.requireNonNull(transport);
        this.retry = java.util.Objects.requireNonNull(retry);
    }

    public JsonNode listFilesWithCapability(CollectionReference reference, Map<String, ?> filters) {
        return json("GET", Wire.collectionPath(reference.wire(), "/files") + Wire.query(filters), null);
    }

    public JsonNode searchFilesWithCapability(CollectionReference reference, JsonNode request) {
        if (request == null || !request.isObject()) throw ClientException.input();
        return json("POST", Wire.collectionPath(reference.wire(), "/search"), request);
    }

    public JsonNode getFileMetadataWithCapability(FileReference reference) {
        Wire.FileReference value = reference.wire();
        return json("GET", Wire.collectionPath(value.collection(), "/files/" + value.entryId()), null);
    }

    public JsonNode listDerivativesWithCapability(GenerationReference reference) {
        Wire.GenerationReference value = reference.wire();
        return json("GET", Wire.collectionPath(value.collection(), "/files/" + value.entryId() + "/versions/" + value.generationId() + "/derivatives"), null);
    }

    public BinaryResponse readImmutableGeneration(GenerationReference reference, String range, String ifNoneMatch) {
        Wire.GenerationReference value = reference.wire();
        return binary("/v1/delivery/" + value.tenantId() + "/" + value.projectId() + "/" + value.environmentId() + "/" + value.collectionInstanceId() + "/" + value.entryId() + "/" + value.generationId(), range, ifNoneMatch, false);
    }

    public BinaryResponse readDerivative(DerivativeReference reference, String range, String ifNoneMatch) {
        Wire.DerivativeReference value = reference.wire();
        return binary("/v1/delivery/" + value.tenantId() + "/" + value.projectId() + "/" + value.environmentId() + "/" + value.collectionInstanceId() + "/" + value.entryId() + "/" + value.generationId() + "/variants/" + Wire.variantPath(value.variantKey()), range, ifNoneMatch, false);
    }

    public BinaryResponse readShare(String shareToken, String range, String ifNoneMatch) {
        if (shareToken == null || !Wire.SHARE.matcher(shareToken).matches()) throw ClientException.input();
        return binary("/v1/shares/" + Wire.encode(shareToken), range, ifNoneMatch, true);
    }

    private JsonNode json(String method, String path, JsonNode request) {
        byte[] body;
        try { body = request == null ? null : JSON.writeValueAsBytes(request); } catch (IOException error) { throw ClientException.input(); }
        try (Wire.Response response = send(method, path, body, false, null, null)) {
            if (response.status() < 200 || response.status() >= 300) throw apiError(response);
            if (!response.headers().getOrDefault("content-type", "").split(";", 2)[0].trim().equals("application/json")) throw ClientException.response();
            return JSON.readTree(readBounded(response.body(), MAX_JSON_BYTES));
        } catch (ClientException error) { throw error; }
        catch (Exception error) { throw ClientException.network(); }
    }

    private BinaryResponse binary(String path, String range, String ifNoneMatch, boolean share) {
        validateValidators(range, ifNoneMatch);
        try {
            Wire.Response response = send("GET", path, null, share, range, ifNoneMatch);
            if (!Set.of(200, 206, 304).contains(response.status())) {
                try (response) { throw apiError(response); }
            }
            return new BinaryResponse(response);
        } catch (ClientException error) { throw error; }
        catch (Exception error) { throw ClientException.network(); }
    }

    private static void validateValidators(String range, String ifNoneMatch) {
        if (range != null && (range.length() > 64 || !range.matches("bytes=[0-9]+-[0-9]*"))) throw ClientException.input();
        if (ifNoneMatch != null && (ifNoneMatch.isEmpty() || ifNoneMatch.length() > 512 || ifNoneMatch.contains("\r") || ifNoneMatch.contains("\n"))) throw ClientException.input();
    }

    private Wire.Response send(String method, String path, byte[] body, boolean share, String range, String ifNoneMatch) {
        for (int attempt = 1; attempt <= retry.maxAttempts(); attempt++) {
            Map<String, String> headers = headers(share);
            headers.put("accept", body == null ? "*/*" : "application/json");
            if (body != null) headers.put("content-type", "application/json");
            if (range != null) headers.put("range", range);
            if (ifNoneMatch != null) headers.put("if-none-match", ifNoneMatch);
            try {
                Wire.Response response = transport.send(method, baseUrl.resolve(path), headers, body);
                if (!Set.of(429, 502, 503, 504).contains(response.status()) || attempt == retry.maxAttempts()) return response;
                String retryAfter = response.headers().get("retry-after");
                response.close();
                delay(attempt, retryAfter);
            } catch (ClientException error) { throw error; }
            catch (Exception error) {
                if (attempt == retry.maxAttempts()) throw ClientException.network();
                delay(attempt, null);
            }
        }
        throw ClientException.network();
    }

    private void delay(int attempt, String retryAfter) {
        long millis;
        if (retryAfter != null && retryAfter.matches("[0-9]{1,8}")) millis = Long.parseLong(retryAfter) * 1000;
        else millis = Math.multiplyExact(retry.baseDelay().toMillis(), 1L << (attempt - 1));
        millis = Math.min(millis, retry.maximumDelay().toMillis());
        try { Thread.sleep(millis); }
        catch (InterruptedException error) { Thread.currentThread().interrupt(); throw ClientException.network(); }
    }

    private Map<String, String> headers(boolean share) {
        var headers = new LinkedHashMap<String, String>();
        if (share) return headers;
        String token;
        try { token = capability == null ? null : capability.get(); } catch (RuntimeException error) { throw ClientException.credential(); }
        if (token == null || !Wire.CAPABILITY.matcher(token).matches()) throw ClientException.input();
        headers.put("authorization", "Bearer " + token);
        if (origin != null) headers.put("origin", origin);
        return headers;
    }

    static ApiException apiError(Wire.Response response) {
        try {
            JsonNode value = JSON.readTree(readBounded(response.body(), 64 * 1024));
            String code = value.path("code").asText(null);
            String requestId = value.path("request_id").asText(null);
            if (code == null || !code.matches("ALMIRA_[A-Z0-9_]{1,127}") || requestId == null || !Wire.UUID_V7.matcher(requestId).matches()) throw ClientException.response();
            Integer retry = null;
            String retryValue = response.headers().get("retry-after");
            if (retryValue != null && retryValue.matches("[0-9]{1,8}")) retry = Integer.valueOf(retryValue);
            return new ApiException(code, requestId, response.status(), retry);
        } catch (ClientException error) { throw error; }
        catch (Exception error) { throw ClientException.response(); }
    }

    static byte[] readBounded(InputStream stream, int limit) throws IOException {
        var output = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int total = 0;
        while (true) {
            int count = stream.read(buffer);
            if (count == -1) break;
            total += count;
            if (total > limit) throw ClientException.response();
            output.write(buffer, 0, count);
        }
        return output.toByteArray();
    }
}
