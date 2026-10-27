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
}
