using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json.Nodes;

namespace Metamorph.Almira;

public sealed class AlmiraServerClient
{
    private readonly Uri _baseUrl;
    private readonly Func<CancellationToken, ValueTask<string>> _workloadSession;
    private readonly HttpClient _http;

    public AlmiraServerClient(string baseUrl, Func<CancellationToken, ValueTask<string>> workloadSession, HttpClient? httpClient = null)
    {
        _baseUrl = Validation.BaseUri(baseUrl);
        _workloadSession = workloadSession ?? throw Validation.Input();
        _http = httpClient ?? new HttpClient(new HttpClientHandler { AllowAutoRedirect = false }) { Timeout = TimeSpan.FromSeconds(30) };
    }

    public Task<JsonNode> CreateCapabilitySession(CollectionReference reference, JsonNode request, string operationId, CancellationToken cancellationToken = default) =>
        Send("POST", Collection(reference, "/capability-sessions"), reference.TenantId, operationId, request, [HttpStatusCode.Created], cancellationToken);
    public Task<JsonNode> CreateUpload(CollectionReference reference, JsonNode request, string operationId, CancellationToken cancellationToken = default) =>
        Send("POST", Collection(reference, "/uploads"), reference.TenantId, operationId, request, [HttpStatusCode.Created], cancellationToken);
    public Task<JsonNode> CreateUploadPart(CollectionReference reference, string transferSessionId, JsonNode request, string operationId, CancellationToken cancellationToken = default) =>
        Send("POST", Collection(reference, "/uploads/" + Validation.Uuid(transferSessionId) + "/parts"), reference.TenantId, operationId, request, [HttpStatusCode.Created], cancellationToken);
    public Task<JsonNode> FinalizeUpload(CollectionReference reference, string transferSessionId, JsonNode request, string operationId, CancellationToken cancellationToken = default) =>
        Send("POST", Collection(reference, "/uploads/" + Validation.Uuid(transferSessionId) + "/finalize"), reference.TenantId, operationId, request, [HttpStatusCode.OK], cancellationToken);
    public Task<JsonNode> BindSubject(CollectionReference reference, string entryId, JsonNode subject, string operationId, CancellationToken cancellationToken = default) =>
        Send("POST", Collection(reference, "/files/" + Validation.Uuid(entryId) + "/subject-bindings"), reference.TenantId, operationId, subject, [HttpStatusCode.Created], cancellationToken);
    public Task<JsonNode> ListSubjectBindings(ProjectReference reference, JsonNode request, CancellationToken cancellationToken = default) =>
        Send("POST", $"/v1/projects/{Validation.Uuid(reference.ProjectId)}/subject-bindings/search", reference.TenantId, null, request, [HttpStatusCode.OK], cancellationToken);
    public Task<JsonNode> StartSubjectLifecycleOperation(ProjectReference reference, JsonNode request, string operationId, CancellationToken cancellationToken = default) =>
        Send("POST", $"/v1/projects/{Validation.Uuid(reference.ProjectId)}/subject-lifecycle-operations", reference.TenantId, operationId, request, [HttpStatusCode.Created, HttpStatusCode.Accepted], cancellationToken);
    public Task<JsonNode> ReadSubjectLifecycleOperation(ProjectReference reference, JsonNode request, CancellationToken cancellationToken = default) =>
        Send("POST", $"/v1/projects/{Validation.Uuid(reference.ProjectId)}/subject-lifecycle-operations/search", reference.TenantId, null, request, [HttpStatusCode.OK], cancellationToken);
    public Task<JsonNode> CreateSubjectExportDownload(ProjectReference reference, string lifecycleOperationId, JsonNode request, string operationId, CancellationToken cancellationToken = default) =>
        Send("POST", $"/v1/projects/{Validation.Uuid(reference.ProjectId)}/subject-lifecycle-operations/{Validation.Uuid(lifecycleOperationId)}/download", reference.TenantId, operationId, request, [HttpStatusCode.Created], cancellationToken);
    public async Task<string> RevokeCapabilitySession(CollectionReference reference, string sessionId, string operationId, CancellationToken cancellationToken = default)
    {
        var value = await Send("DELETE", Collection(reference, "/capability-sessions/" + Validation.Uuid(sessionId)), reference.TenantId, operationId, null, [HttpStatusCode.OK], cancellationToken);
        var result = value.GetValue<string>();
        return result is "applied" or "exact_replay" ? result : throw Validation.Response();
    }

    private async Task<JsonNode> Send(string method, string path, string tenantId, string? operationId, JsonNode? body, HttpStatusCode[] statuses, CancellationToken cancellationToken)
    {
        tenantId = Validation.Uuid(tenantId);
        if (operationId is not null) operationId = Validation.Uuid(operationId);
        string evidence;
        try { evidence = await _workloadSession(cancellationToken); }
        catch { throw new AlmiraClientException("ALMIRA_CLIENT_CREDENTIAL_UNAVAILABLE"); }
        if (evidence.Length is < 2 or > 49152 || evidence.Any(character => !(char.IsAsciiLetterOrDigit(character) || character is '_' or '-'))) throw Validation.Input();
        using var request = new HttpRequestMessage(new HttpMethod(method), new Uri(_baseUrl, path.TrimStart('/')));
        request.Headers.Authorization = new AuthenticationHeaderValue("MetamorphWorkload", evidence);
        request.Headers.TryAddWithoutValidation("x-almira-tenant-id", tenantId);
        request.Headers.Accept.ParseAdd("application/json");
        if (operationId is not null) request.Headers.TryAddWithoutValidation("idempotency-key", operationId);
        if (body is not null) request.Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json");
        HttpResponseMessage response;
        try { response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken); }
        catch { throw new AlmiraClientException("ALMIRA_CLIENT_NETWORK"); }
        using (response)
        {
            if (!statuses.Contains(response.StatusCode)) throw await AlmiraDataClient.ApiError(response, cancellationToken);
            if (response.Content.Headers.ContentType?.MediaType != "application/json") throw Validation.Response();
            await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
            return await JsonNode.ParseAsync(new BoundedStream(stream, 2 * 1024 * 1024), cancellationToken: cancellationToken) ?? throw Validation.Response();
        }
    }

    private static string Collection(CollectionReference reference, string suffix) =>
        $"/v1/projects/{Validation.Uuid(reference.ProjectId)}/environments/{Validation.Uuid(reference.EnvironmentId)}/collections/{Validation.Uuid(reference.CollectionInstanceId)}{suffix}";
}
