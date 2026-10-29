using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Metamorph.Almira;
using Xunit;

namespace Metamorph.Almira.Tests;

public sealed class ClientTests
{
    private const string Tenant = "018f0000-0000-7000-8000-000000000002";
    private const string Project = "018f0000-0000-7000-8000-000000000003";
    private const string Environment = "018f0000-0000-7000-8000-000000000004";
    private const string Collection = "018f0000-0000-7000-8000-000000000005";
    private const string Entry = "018f0000-0000-7000-8000-000000000006";
    private const string Capability = "alm_cap_v1.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    [Fact]
    public async Task DataClientScopesCapabilityAndKeepsSharesAnonymous()
    {
        Assert.Throws<AlmiraClientException>(() => new AlmiraDataClient("https://almira.test", _ => ValueTask.FromResult(Capability), "https://app.example/"));
        var handler = new RecordingHandler();
        var client = new AlmiraDataClient("https://almira.test", _ => ValueTask.FromResult(Capability), "https://app.example", new HttpClient(handler));
        var collection = new CollectionReference(Tenant, Project, Environment, Collection);
        await client.ListFilesWithCapability(collection, new Dictionary<string, object?> { ["limit"] = 25 });
        await client.SearchFilesWithCapability(collection, new JsonObject { ["query"] = "portrait" });
        await using var share = await client.ReadShare("alm_share_v1.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
        await Assert.ThrowsAsync<AlmiraClientException>(() => client.ReadShare("alm_share_v1.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "bytes=unsafe"));
        Assert.Equal(3, handler.Requests.Count);
        Assert.Equal("Bearer " + Capability, handler.Requests[0].Authorization);
        Assert.Null(handler.Requests[2].Authorization);
        Assert.EndsWith($"/v1/shares/alm_share_v1.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", handler.Requests[2].Path);
    }

    [Fact]
    public async Task ServerClientUsesOnlyWorkloadEvidenceAndIdempotency()
    {
        var handler = new RecordingHandler(HttpStatusCode.Created);
        var client = new AlmiraServerClient("https://almira.test", _ => ValueTask.FromResult("workload_evidence"), new HttpClient(handler));
        var reference = new CollectionReference(Tenant, Project, Environment, Collection);
        await client.CreateUpload(reference, new JsonObject { ["path"] = "avatar.png" }, "018f0000-0000-7000-8000-000000000008");
        Assert.Equal("MetamorphWorkload workload_evidence", handler.Requests.Single().Authorization);
        Assert.Equal(Tenant, handler.Requests.Single().Tenant);
    }

    [Fact]
    public async Task DirectTransferReturnsOnlyFinalizeEvidence()
    {
        var handler = new RecordingHandler();
        var bytes = Encoding.UTF8.GetBytes("hello");
        var descriptor = new JsonObject
        {
            ["descriptor_id"] = "018f0000-0000-7000-8000-000000000008", ["protocol"] = "single_put",
            ["expected_size_bytes"] = 5, ["content_sha256"] = "sha256:" + Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes)).ToLowerInvariant(),
            ["one_use"] = true, ["expires_at"] = "2099-01-01T00:00:00Z", ["part_size_bytes"] = null, ["part_count"] = 1,
            ["requests"] = new JsonArray(new JsonObject { ["part_number"] = 1, ["offset_bytes"] = 0, ["length_bytes"] = 5, ["method"] = "PUT", ["url"] = "https://storage.test/secret", ["headers"] = new JsonArray(), ["one_use"] = true }),
        };
        var result = await DirectTransfer.UploadDirectAsync(descriptor, new MemoryStream(bytes), httpClient: new HttpClient(handler));
        Assert.Equal("\"v1\"", result["etag"]!.GetValue<string>());
        Assert.DoesNotContain("storage.test", result.ToJsonString());
    }

    [Fact]
    public void VerifiesTheCommonWebhookVectorAndRejectsTampering()
    {
        var body = Encoding.UTF8.GetBytes("{\"event\":\"almira.file.available.v1\"}");
        var headers = new Dictionary<string, string>
        {
            ["metamorph-webhook-delivery-id"] = "018f0000-0000-7000-8000-000000000011",
            ["metamorph-webhook-event-id"] = "018f0000-0000-7000-8000-000000000012",
            ["metamorph-webhook-attempt"] = "2",
            ["metamorph-webhook-timestamp"] = "2026-10-17T12:00:00.000000Z",
            ["metamorph-webhook-signature"] = "v1=PHaG4k_rjkr4itoseS10o0_znK6FR9aoArs7pPV2klI",
        };
        var verified = WebhookVerifier.VerifyWebhookSignature(Encoding.UTF8.GetBytes("topsecret"), body, headers, DateTimeOffset.Parse("2026-10-17T12:00:30Z"));
        Assert.NotNull(verified);
        Assert.Equal(2, verified.Attempt);
        headers["metamorph-webhook-signature"] = "v1=AHaG4k_rjkr4itoseS10o0_znK6FR9aoArs7pPV2klI";
        Assert.Null(WebhookVerifier.VerifyWebhookSignature(Encoding.UTF8.GetBytes("topsecret"), body, headers, DateTimeOffset.Parse("2026-10-17T12:00:30Z")));
    }

    [Fact]
    public void VerifiesTheCommonBehaviorReceiptVectorAndRejectsSubstitution()
    {
        var path = Path.Combine(FindRepositoryRoot(), "conformance", "application-sdk.v1.json");
        var root = JsonNode.Parse(File.ReadAllText(path))!;
        var vector = root["behavior_receipt"]!;
        var expected = vector["expected"]!;
        var expectation = new VerificationReceiptExpectation(
            expected["tenant_id"]!.GetValue<string>(), expected["project_id"]!.GetValue<string>(),
            expected["environment_id"]!.GetValue<string>(), expected["collection_instance_id"]!.GetValue<string>(),
            expected["entry_id"]!.GetValue<string>(), expected["generation_id"]!.GetValue<string>(),
            expected["expected_size_bytes"]!.GetValue<long>(), expected["content_sha256"]!.GetValue<string>(),
            expected["verification_id"]!.GetValue<string>());
        Assert.True(VerificationReceiptVerifier.Verify(vector["signed"], vector["key_set"], expectation));
        var substituted = expectation with { GenerationId = vector["substitution"]!["generation_id"]!.GetValue<string>() };
        Assert.False(VerificationReceiptVerifier.Verify(vector["signed"], vector["key_set"], substituted));
        var tampered = vector["signed"]!.DeepClone();
        tampered["receipt"]!["generation_id"] = substituted.GenerationId;
        Assert.False(VerificationReceiptVerifier.Verify(tampered, vector["key_set"]));
    }

    [Fact]
    public async Task CommonManagedDevelopmentPositiveRefusalRetryAndCleanupJourney()
    {
        var root = JsonNode.Parse(File.ReadAllText(Path.Combine(FindRepositoryRoot(), "conformance", "application-sdk.v1.json")))!;
        var journey = root["managed_development"]!;
        var ids = journey["reference"]!;
        var reference = new FileReference(
            ids["tenant_id"]!.GetValue<string>(), ids["project_id"]!.GetValue<string>(),
            ids["environment_id"]!.GetValue<string>(), ids["collection_instance_id"]!.GetValue<string>(),
            ids["entry_id"]!.GetValue<string>());
        var positiveHandler = new ConformanceHandler((_, _) => Response(HttpStatusCode.OK, journey["positive"]!["response"]!));
        var positive = new AlmiraDataClient(
            journey["base_url"]!.GetValue<string>(), _ => ValueTask.FromResult(journey["positive"]!["capability"]!.GetValue<string>()),
            journey["origin"]!.GetValue<string>(), new HttpClient(positiveHandler));
        Assert.Equal(reference.EntryId, (await positive.GetFileMetadataWithCapability(reference))["entry_id"]!.GetValue<string>());
        Assert.Equal("Bearer " + journey["positive"]!["capability"]!.GetValue<string>(), positiveHandler.Authorities.Single());

        var refusalHandler = new ConformanceHandler((_, _) => Response(HttpStatusCode.OK, journey["positive"]!["response"]!));
        var refused = new AlmiraDataClient(
            journey["base_url"]!.GetValue<string>(), _ => ValueTask.FromResult(journey["refusal"]!["credential"]!.GetValue<string>()),
            httpClient: new HttpClient(refusalHandler));
        var refusal = await Assert.ThrowsAsync<AlmiraClientException>(() => refused.GetFileMetadataWithCapability(reference));
        Assert.Equal(journey["refusal"]!["client_code"]!.GetValue<string>(), refusal.Code);
        Assert.Empty(refusalHandler.Authorities);

        var credentials = journey["retry"]!["capabilities"]!.AsArray().Select(value => value!.GetValue<string>()).ToArray();
        var credentialAttempt = 0;
        var retryHandler = new ConformanceHandler((attempt, _) => attempt == 0
            ? Response((HttpStatusCode)journey["retry"]!["first_status"]!.GetValue<int>(), journey["retry"]!["first_error"]!, "0")
            : Response((HttpStatusCode)journey["retry"]!["final_status"]!.GetValue<int>(), journey["positive"]!["response"]!));
        var retrying = new AlmiraDataClient(
            journey["base_url"]!.GetValue<string>(), _ => ValueTask.FromResult(credentials[credentialAttempt++]),
            httpClient: new HttpClient(retryHandler), retry: new RetryPolicy(2, TimeSpan.Zero, TimeSpan.Zero));
        Assert.Equal(reference.EntryId, (await retrying.GetFileMetadataWithCapability(reference))["entry_id"]!.GetValue<string>());
        Assert.Equal(credentials.Select(value => "Bearer " + value), retryHandler.Authorities);
        Assert.False(journey["cleanup"]!["applicable"]!.GetValue<bool>());
        Assert.Equal("read_only_journey", journey["cleanup"]!["reason"]!.GetValue<string>());
    }

    private static HttpResponseMessage Response(HttpStatusCode status, JsonNode body, string? retryAfter = null)
    {
        var response = new HttpResponseMessage(status) { Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json") };
        if (retryAfter is not null) response.Headers.TryAddWithoutValidation("Retry-After", retryAfter);
        return response;
    }

    private static string FindRepositoryRoot()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
            if (File.Exists(Path.Combine(directory.FullName, "conformance", "application-sdk.v1.json"))) return directory.FullName;
        throw new DirectoryNotFoundException("repository root");
    }

    private sealed record Recorded(string Path, string? Authorization, string? Tenant);
    private sealed class RecordingHandler(HttpStatusCode status = HttpStatusCode.OK) : HttpMessageHandler
    {
        public List<Recorded> Requests { get; } = [];
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Requests.Add(new Recorded(request.RequestUri!.AbsolutePath, request.Headers.Authorization?.ToString(), request.Headers.TryGetValues("x-almira-tenant-id", out var values) ? values.Single() : null));
            var isStorage = request.RequestUri.Host == "storage.test";
            var body = request.RequestUri.AbsolutePath.Contains("shares") ? "hello" : "{}";
            var response = new HttpResponseMessage(status) { Content = new StringContent(body, Encoding.UTF8, request.RequestUri.AbsolutePath.Contains("shares") ? "application/octet-stream" : "application/json") };
            if (isStorage) response.Headers.ETag = new System.Net.Http.Headers.EntityTagHeaderValue("\"v1\"");
            return Task.FromResult(response);
        }
    }

    private sealed class ConformanceHandler(Func<int, HttpRequestMessage, HttpResponseMessage> response) : HttpMessageHandler
    {
        public List<string> Authorities { get; } = [];
        private int _attempt;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Authorities.Add(request.Headers.Authorization?.ToString() ?? "");
            return Task.FromResult(response(_attempt++, request));
        }
    }
}
