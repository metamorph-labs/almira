package com.metamorph.almira;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.function.Function;

public final class DirectTransfer {
    private static final ObjectMapper JSON = new ObjectMapper();
    private DirectTransfer() {}

    public static final class TransferException extends RuntimeException {
        private final String code;
        private final Integer partNumber;
        TransferException(String code, Integer partNumber) { super(code); this.code = code; this.partNumber = partNumber; }
        public String code() { return code; }
        public Integer partNumber() { return partNumber; }
    }

    public record UploadResponse(int status, Map<String, String> headers) {}
    @FunctionalInterface public interface UploadTransport { UploadResponse put(JsonNode part, Path source) throws Exception; }

    public static ObjectNode uploadDirect(JsonNode descriptor, Path source, Function<ObjectNode, JsonNode> grantPart) {
        return uploadDirect(descriptor, source, grantPart, DirectTransfer::putHttps);
    }

    public static ObjectNode uploadDirect(JsonNode descriptor, Path source, Function<ObjectNode, JsonNode> grantPart, UploadTransport transport) {
        try {
            requireObject(descriptor);
            String descriptorId = Wire.uuid(text(descriptor, "descriptor_id"));
            String protocol = text(descriptor, "protocol");
            if (!(protocol.equals("single_put") || protocol.equals("multipart")) || !descriptor.path("one_use").asBoolean(false)) throw invalid();
            long expectedSize = positiveLong(descriptor, "expected_size_bytes");
            if (expectedSize > 10_737_418_240L) throw invalid();
            if (Files.size(source) != expectedSize) throw invalid();
            String digest = text(descriptor, "content_sha256");
            if (!digest.matches("sha256:[0-9a-f]{64}")) throw invalid();
            Instant expiry = Instant.parse(text(descriptor, "expires_at"));
            if (!expiry.isAfter(Instant.now())) throw new TransferException("ALMIRA_TRANSFER_DESCRIPTOR_EXPIRED", null);
            JsonNode requests = descriptor.get("requests");
            if (requests == null || !requests.isArray()) throw invalid();
            int partCount = descriptor.path("part_count").asInt(-1);
            if (partCount < 1 || partCount > 10_000) throw invalid();
            long partSize;
            if (protocol.equals("single_put")) {
                if (requests.size() != 1 || !descriptor.path("part_size_bytes").isNull() || partCount != 1) throw invalid();
                partSize = expectedSize;
            } else {
                if (!requests.isEmpty() || !descriptor.path("part_size_bytes").isIntegralNumber()) throw invalid();
                partSize = descriptor.path("part_size_bytes").asLong();
                if (partSize < 1 || Math.multiplyExact(partSize, partCount - 1L) >= expectedSize || Math.multiplyExact(partSize, (long) partCount) < expectedSize) throw invalid();
            }
            ArrayNode completions = JSON.createArrayNode();
            String objectEtag = null;
            String providerVersion = null;
            for (int partNumber = 1; partNumber <= partCount; partNumber++) {
                long offset = (long) (partNumber - 1) * partSize;
                long length = Math.min(partSize, expectedSize - offset);
                if (length <= 0) throw invalid();
                JsonNode part;
                if (protocol.equals("single_put")) {
                    part = requests.get(0);
                } else {
                    if (grantPart == null) throw invalid();
                    ObjectNode request = JSON.createObjectNode().put("part_number", partNumber).put("content_sha256", hashPart(source, offset, length));
                    part = grantPart.apply(request);
                }
                validatePart(part, partNumber, offset, length);
                if (!expiry.isAfter(Instant.now())) throw new TransferException("ALMIRA_TRANSFER_DESCRIPTOR_EXPIRED", null);
                UploadResponse response;
                try { response = transport.put(part, source); }
                catch (TransferException error) { throw error; }
                catch (Exception error) { throw new TransferException("ALMIRA_TRANSFER_OUTCOME_UNKNOWN", partNumber); }
                if (response == null || response.status < 100 || response.status > 599) throw new TransferException("ALMIRA_TRANSFER_RESPONSE_INVALID", partNumber);
                if (response.status < 200 || response.status >= 300) throw new TransferException("ALMIRA_TRANSFER_PART_REFUSED", partNumber);
                Map<String, String> headers = normalize(response.headers);
                String etag = headers.get("etag");
                if (etag == null || !etag.matches("[!-~]{1,256}")) throw new TransferException("ALMIRA_TRANSFER_RESPONSE_INVALID", partNumber);
                completions.add(JSON.createObjectNode().put("part_number", partNumber).put("etag", etag));
                if (protocol.equals("single_put")) {
                    objectEtag = etag;
                    for (String name : new String[] {"x-amz-version-id", "x-goog-generation", "x-ms-version-id"}) {
                        String value = headers.get(name);
                        if (value != null) {
                            if (!value.matches("[!-~]{1,256}") || value.matches(".*[/\\\\?#].*")) throw new TransferException("ALMIRA_TRANSFER_RESPONSE_INVALID", partNumber);
                            if (providerVersion != null && !providerVersion.equals(value)) throw new TransferException("ALMIRA_TRANSFER_RESPONSE_INVALID", partNumber);
                            providerVersion = value;
                        }
                    }
                }
            }
            ObjectNode result = JSON.createObjectNode().put("descriptor_id", descriptorId).put("protocol", protocol).put("size_bytes", expectedSize).put("content_sha256", digest);
            if (objectEtag == null) result.putNull("etag"); else result.put("etag", objectEtag);
            if (providerVersion == null) result.putNull("provider_version"); else result.put("provider_version", providerVersion);
            result.set("parts", completions);
            return result;
        } catch (TransferException error) { throw error; }
        catch (Exception error) { throw invalid(); }
    }

    private static UploadResponse putHttps(JsonNode part, Path source) throws Exception {
        URI uri = URI.create(text(part, "url"));
        if (!uri.getScheme().equals("https") || uri.getHost() == null || uri.getUserInfo() != null || uri.getFragment() != null) throw invalid();
        long offset = part.path("offset_bytes").asLong();
        long length = part.path("length_bytes").asLong();
        var headers = new LinkedHashMap<String, String>();
        for (JsonNode header : part.path("headers")) headers.put(text(header, "name"), text(header, "value"));
        headers.putIfAbsent("content-length", Long.toString(length));
        HttpRequest.BodyPublisher body = HttpRequest.BodyPublishers.ofInputStream(() -> {
            try { InputStream input = Files.newInputStream(source); input.skipNBytes(offset); return new BoundedInput(input, length); }
            catch (IOException error) { throw new java.io.UncheckedIOException(error); }
        });
        var builder = HttpRequest.newBuilder(uri).method("PUT", body);
        headers.forEach(builder::header);
        HttpResponse<Void> response = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).build().send(builder.build(), HttpResponse.BodyHandlers.discarding());
        var responseHeaders = new LinkedHashMap<String, String>();
        response.headers().map().forEach((name, values) -> { if (values.size() == 1) responseHeaders.put(name, values.get(0)); });
        return new UploadResponse(response.statusCode(), responseHeaders);
    }

    private static void validatePart(JsonNode part, int number, long offset, long length) {
        requireObject(part);
        if (part.path("part_number").asInt(-1) != number || part.path("offset_bytes").asLong(-1) != offset || part.path("length_bytes").asLong(-1) != length || !text(part, "method").equals("PUT") || !part.path("one_use").asBoolean(false)) throw invalid();
        String url = text(part, "url");
        try {
            URI uri = URI.create(url);
            if (url.length() > 8192 || url.chars().anyMatch(value -> value <= 32 || value == 127 || value == '\\') || !uri.getScheme().equals("https") || uri.getHost() == null || uri.getUserInfo() != null || uri.getFragment() != null) throw invalid();
        } catch (IllegalArgumentException error) { throw invalid(); }
        JsonNode headers = part.get("headers");
        if (headers == null || !headers.isArray() || headers.size() > 32) throw invalid();
        var names = new java.util.HashSet<String>();
        for (JsonNode header : headers) {
            requireObject(header);
            String name = text(header, "name"); String value = text(header, "value");
            if (!name.matches("[A-Za-z0-9_-]{1,128}") || value.isEmpty() || value.length() > 4096 || value.chars().anyMatch(character -> character < 32 || character == 127) || !names.add(name)) throw invalid();
        }
    }

    private static String hashPart(Path source, long offset, long length) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream input = Files.newInputStream(source)) {
            input.skipNBytes(offset); byte[] buffer = new byte[64 * 1024]; long remaining = length;
            while (remaining > 0) { int count = input.read(buffer, 0, (int) Math.min(buffer.length, remaining)); if (count < 1) throw invalid(); digest.update(buffer, 0, count); remaining -= count; }
        }
        return "sha256:" + java.util.HexFormat.of().formatHex(digest.digest());
    }

    private static String text(JsonNode node, String name) { JsonNode value = node.get(name); if (value == null || !value.isTextual()) throw invalid(); return value.asText(); }
    private static long positiveLong(JsonNode node, String name) { JsonNode value = node.get(name); if (value == null || !value.canConvertToLong() || value.asLong() < 1) throw invalid(); return value.asLong(); }
    private static void requireObject(JsonNode node) { if (node == null || !node.isObject()) throw invalid(); }
    private static Map<String, String> normalize(Map<String, String> headers) { if (headers == null) throw new TransferException("ALMIRA_TRANSFER_RESPONSE_INVALID", null); var result = new LinkedHashMap<String, String>(); headers.forEach((key, value) -> { if (key == null || value == null || result.putIfAbsent(key.toLowerCase(Locale.ROOT), value) != null) throw new TransferException("ALMIRA_TRANSFER_RESPONSE_INVALID", null); }); return result; }
    private static TransferException invalid() { return new TransferException("ALMIRA_TRANSFER_DESCRIPTOR_INVALID", null); }

    private static final class BoundedInput extends FilterInputStream {
        private long remaining;
        BoundedInput(InputStream input, long remaining) { super(input); this.remaining = remaining; }
        @Override public int read() throws IOException { if (remaining == 0) return -1; int value = super.read(); if (value >= 0) remaining--; return value; }
        @Override public int read(byte[] bytes, int offset, int length) throws IOException { if (remaining == 0) return -1; int count = super.read(bytes, offset, (int) Math.min(length, remaining)); if (count > 0) remaining -= count; return count; }
    }
}
