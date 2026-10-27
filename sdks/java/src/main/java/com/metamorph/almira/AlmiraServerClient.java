package com.metamorph.almira;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.net.URI;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.function.Supplier;

public final class AlmiraServerClient {
    private static final ObjectMapper JSON = new ObjectMapper();
    private final URI baseUrl;
    private final Supplier<String> workloadSession;
    private final Wire.Transport transport;

    public record ProjectReference(String tenantId, String projectId) {
        public ProjectReference { Wire.uuid(tenantId); Wire.uuid(projectId); }
    }

    public AlmiraServerClient(String baseUrl, Supplier<String> workloadSession) {
        this(baseUrl, workloadSession, new Wire.JdkTransport(Duration.ofSeconds(30)));
    }

    public AlmiraServerClient(String baseUrl, Supplier<String> workloadSession, Wire.Transport transport) {
        this.baseUrl = Wire.baseUri(baseUrl);
        this.workloadSession = java.util.Objects.requireNonNull(workloadSession);
        this.transport = java.util.Objects.requireNonNull(transport);
    }

    public JsonNode createCapabilitySession(AlmiraDataClient.CollectionReference reference, JsonNode request, String operationId) {
        return request("POST", collection(reference, "/capability-sessions"), reference.tenantId(), operationId, request, Set.of(201));
    }
    public JsonNode createUpload(AlmiraDataClient.CollectionReference reference, JsonNode request, String operationId) {
        return request("POST", collection(reference, "/uploads"), reference.tenantId(), operationId, request, Set.of(201));
    }
    public JsonNode createUploadPart(AlmiraDataClient.CollectionReference reference, String transferSessionId, JsonNode request, String operationId) {
        return request("POST", collection(reference, "/uploads/" + Wire.uuid(transferSessionId) + "/parts"), reference.tenantId(), operationId, request, Set.of(201));
    }
    public JsonNode finalizeUpload(AlmiraDataClient.CollectionReference reference, String transferSessionId, JsonNode request, String operationId) {
        return request("POST", collection(reference, "/uploads/" + Wire.uuid(transferSessionId) + "/finalize"), reference.tenantId(), operationId, request, Set.of(200));
    }
    public JsonNode bindSubject(AlmiraDataClient.CollectionReference reference, String entryId, JsonNode subject, String operationId) {
        return request("POST", collection(reference, "/files/" + Wire.uuid(entryId) + "/subject-bindings"), reference.tenantId(), operationId, subject, Set.of(201));
    }
    public JsonNode listSubjectBindings(ProjectReference reference, JsonNode request) {
        return request("POST", "/v1/projects/" + reference.projectId() + "/subject-bindings/search", reference.tenantId(), null, request, Set.of(200));
    }
    public JsonNode startSubjectLifecycleOperation(ProjectReference reference, JsonNode request, String operationId) {
        return request("POST", "/v1/projects/" + reference.projectId() + "/subject-lifecycle-operations", reference.tenantId(), operationId, request, Set.of(201, 202));
    }
    public JsonNode readSubjectLifecycleOperation(ProjectReference reference, JsonNode request) {
        return request("POST", "/v1/projects/" + reference.projectId() + "/subject-lifecycle-operations/search", reference.tenantId(), null, request, Set.of(200));
    }
    public JsonNode createSubjectExportDownload(ProjectReference reference, String lifecycleOperationId, JsonNode request, String operationId) {
        return request("POST", "/v1/projects/" + reference.projectId() + "/subject-lifecycle-operations/" + Wire.uuid(lifecycleOperationId) + "/download", reference.tenantId(), operationId, request, Set.of(201));
    }
    public String revokeCapabilitySession(AlmiraDataClient.CollectionReference reference, String sessionId, String operationId) {
        JsonNode value = request("DELETE", collection(reference, "/capability-sessions/" + Wire.uuid(sessionId)), reference.tenantId(), operationId, null, Set.of(200));
        if (!value.isTextual() || !(value.asText().equals("applied") || value.asText().equals("exact_replay"))) throw ClientException.response();
        return value.asText();
    }

    public AlmiraDataClient createCapabilityDataClient(String token, String audience) {
        return new AlmiraDataClient(baseUrl.toString(), Wire.fixedCredential(token), audience);
    }

    private JsonNode request(String method, String path, String tenantId, String operationId, JsonNode request, Set<Integer> expectedStatuses) {
        Wire.uuid(tenantId);
        if (operationId != null) Wire.uuid(operationId);
        String evidence;
        try { evidence = workloadSession.get(); } catch (RuntimeException error) { throw ClientException.credential(); }
        if (evidence == null || evidence.length() < 2 || evidence.length() > 48 * 1024 || !evidence.matches("[A-Za-z0-9_-]+")) throw ClientException.input();
        var headers = new LinkedHashMap<String, String>();
        headers.put("accept", "application/json");
        headers.put("authorization", "MetamorphWorkload " + evidence);
        headers.put("x-almira-tenant-id", tenantId);
        if (operationId != null) headers.put("idempotency-key", operationId);
        byte[] body;
        try { body = request == null ? null : JSON.writeValueAsBytes(request); } catch (Exception error) { throw ClientException.input(); }
        if (body != null) headers.put("content-type", "application/json");
        try (Wire.Response response = transport.send(method, baseUrl.resolve(path), headers, body)) {
            if (!expectedStatuses.contains(response.status())) throw AlmiraDataClient.apiError(response);
            if (!response.headers().getOrDefault("content-type", "").split(";", 2)[0].trim().equals("application/json")) throw ClientException.response();
            JsonNode value = JSON.readTree(AlmiraDataClient.readBounded(response.body(), 2 * 1024 * 1024));
            if (value == null || value.isNull()) throw ClientException.response();
            return value;
        } catch (ClientException error) { throw error; }
        catch (Exception error) { throw ClientException.network(); }
    }

    private static String collection(AlmiraDataClient.CollectionReference reference, String suffix) {
        Wire.CollectionReference wire = reference.wire();
        return Wire.managementCollectionPath(wire, suffix);
    }
}
