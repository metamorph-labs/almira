package com.metamorph.almira;

import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.function.Supplier;
import java.util.regex.Pattern;

final class Wire {
    static final String CONTRACT_VERSION = "0.1.0-dev.59";
    static final Pattern UUID_V7 = Pattern.compile("^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$");
    static final Pattern CAPABILITY = Pattern.compile("^(?:alm_cap_v1|alm_local_v1)\\.[A-Za-z0-9_-]{43,4096}$");
    static final Pattern SHARE = Pattern.compile("^alm_share_v1\\.[A-Za-z0-9_-]{43,4096}$");

    private Wire() {}

    record CollectionReference(String tenantId, String projectId, String environmentId, String collectionInstanceId) {
        CollectionReference {
            uuid(tenantId); uuid(projectId); uuid(environmentId); uuid(collectionInstanceId);
        }
    }

    record FileReference(String tenantId, String projectId, String environmentId, String collectionInstanceId, String entryId) {
        FileReference {
            uuid(tenantId); uuid(projectId); uuid(environmentId); uuid(collectionInstanceId); uuid(entryId);
        }

        CollectionReference collection() {
            return new CollectionReference(tenantId, projectId, environmentId, collectionInstanceId);
        }
    }

    record GenerationReference(String tenantId, String projectId, String environmentId, String collectionInstanceId, String entryId, String generationId) {
        GenerationReference {
            uuid(tenantId); uuid(projectId); uuid(environmentId); uuid(collectionInstanceId); uuid(entryId); uuid(generationId);
        }

        CollectionReference collection() {
            return new CollectionReference(tenantId, projectId, environmentId, collectionInstanceId);
        }
    }

    record DerivativeReference(String tenantId, String projectId, String environmentId, String collectionInstanceId, String entryId, String generationId, String variantKey) {
        DerivativeReference {
            new GenerationReference(tenantId, projectId, environmentId, collectionInstanceId, entryId, generationId);
            if (variantKey == null || variantKey.isEmpty() || variantKey.length() > 160) throw ClientException.input();
            for (String segment : variantKey.split("/", -1)) {
                if (segment.isEmpty() || segment.equals(".") || segment.equals("..") || !segment.matches("[A-Za-z0-9._~-]+")) throw ClientException.input();
            }
        }
    }

    @FunctionalInterface
    interface Transport {
        Response send(String method, URI uri, Map<String, String> headers, byte[] body) throws Exception;
    }

    record Response(int status, Map<String, String> headers, InputStream body) implements AutoCloseable {
        Response {
            if (status < 100 || status > 599 || headers == null || body == null) throw ClientException.response();
            var normalized = new LinkedHashMap<String, String>();
            headers.forEach((key, value) -> {
                if (key == null || value == null) throw ClientException.response();
                normalized.put(key.toLowerCase(Locale.ROOT), value);
            });
            headers = Map.copyOf(normalized);
        }

        @Override public void close() throws IOException { body.close(); }
    }

    static final class JdkTransport implements Transport {
        private final HttpClient client;
        private final Duration timeout;

        JdkTransport(Duration timeout) {
            if (timeout.isNegative() || timeout.isZero() || timeout.compareTo(Duration.ofMinutes(5)) > 0) throw ClientException.input();
            this.timeout = timeout;
            this.client = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).connectTimeout(timeout).build();
        }

        @Override public Response send(String method, URI uri, Map<String, String> headers, byte[] body) throws Exception {
            HttpRequest.BodyPublisher publisher = body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofByteArray(body);
            var builder = HttpRequest.newBuilder(uri).timeout(timeout).method(method, publisher);
            headers.forEach(builder::header);
            HttpResponse<InputStream> response = client.send(builder.build(), HttpResponse.BodyHandlers.ofInputStream());
            var resultHeaders = new LinkedHashMap<String, String>();
            response.headers().map().forEach((name, values) -> {
                if (values.size() == 1) resultHeaders.put(name, values.get(0));
            });
            return new Response(response.statusCode(), resultHeaders, response.body());
        }
    }

    static URI baseUri(String baseUrl) {
        try {
            URI value = URI.create(baseUrl);
            if (!(value.getScheme().equals("http") || value.getScheme().equals("https")) || value.getHost() == null || value.getUserInfo() != null || value.getQuery() != null || value.getFragment() != null || !(value.getPath().isEmpty() || value.getPath().equals("/"))) throw ClientException.input();
            return URI.create(baseUrl.endsWith("/") ? baseUrl.substring(0, baseUrl.length() - 1) : baseUrl);
        } catch (RuntimeException error) {
            if (error instanceof ClientException) throw error;
            throw ClientException.input();
        }
    }

    static String origin(String value) {
        if (value == null) return null;
        if (value.endsWith("/")) throw ClientException.input();
        URI origin = baseUri(value);
        if (!origin.getPath().isEmpty()) throw ClientException.input();
        return value;
    }

    static String uuid(String value) {
        if (value == null || !UUID_V7.matcher(value).matches()) throw ClientException.input();
        return value;
    }

    static String encode(String value) {
        return URLEncoder.encode(Objects.requireNonNull(value), StandardCharsets.UTF_8).replace("+", "%20");
    }

    static String collectionPath(CollectionReference reference, String suffix) {
        return "/v1/data/" + reference.tenantId + "/" + reference.projectId + "/" + reference.environmentId + "/" + reference.collectionInstanceId + suffix;
    }

    static String managementCollectionPath(CollectionReference reference, String suffix) {
        return "/v1/projects/" + reference.projectId + "/environments/" + reference.environmentId + "/collections/" + reference.collectionInstanceId + suffix;
    }

    static String query(Map<String, ?> values) {
        if (values == null || values.isEmpty()) return "";
        var parts = new java.util.ArrayList<String>();
        values.forEach((name, value) -> {
            if (value == null) return;
            if (value instanceof Iterable<?> many) {
                many.forEach(item -> parts.add(encode(name) + "=" + encode(String.valueOf(item))));
            } else {
                parts.add(encode(name) + "=" + encode(String.valueOf(value)));
            }
        });
        return parts.isEmpty() ? "" : "?" + String.join("&", parts);
    }

    static String variantPath(String variant) {
        return String.join("/", List.of(variant.split("/", -1)).stream().map(Wire::encode).toList());
    }

    static Supplier<String> fixedCredential(String value) {
        return () -> value;
    }
}
