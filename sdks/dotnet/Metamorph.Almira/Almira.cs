using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Metamorph.Almira;

public static class AlmiraContract
{
    public const string Version = "0.1.0-dev.59";
}

public class AlmiraClientException(string code) : Exception(code)
{
    public string Code { get; } = code;
}

public sealed class AlmiraApiException(string code, string requestId, HttpStatusCode status, int? retryAfterSeconds)
    : AlmiraClientException(code)
{
    public string RequestId { get; } = requestId;
    public HttpStatusCode Status { get; } = status;
    public int? RetryAfterSeconds { get; } = retryAfterSeconds;
}

public sealed record CollectionReference(string TenantId, string ProjectId, string EnvironmentId, string CollectionInstanceId);
public sealed record FileReference(string TenantId, string ProjectId, string EnvironmentId, string CollectionInstanceId, string EntryId);
public sealed record GenerationReference(string TenantId, string ProjectId, string EnvironmentId, string CollectionInstanceId, string EntryId, string GenerationId);
public sealed record DerivativeReference(string TenantId, string ProjectId, string EnvironmentId, string CollectionInstanceId, string EntryId, string GenerationId, string VariantKey);
public sealed record ProjectReference(string TenantId, string ProjectId);
public sealed record RetryPolicy(int MaxAttempts = 1, TimeSpan? BaseDelay = null, TimeSpan? MaximumDelay = null)
{
    internal TimeSpan Base => BaseDelay ?? TimeSpan.FromMilliseconds(100);
    internal TimeSpan Maximum => MaximumDelay ?? TimeSpan.FromSeconds(5);
}

public sealed class AlmiraBinaryResponse(HttpResponseMessage response) : IAsyncDisposable, IDisposable
{
    public HttpStatusCode Status => response.StatusCode;
    public HttpResponseHeaders Headers => response.Headers;
    public Stream Body { get; } = response.Content.ReadAsStream();
    public void Dispose() { Body.Dispose(); response.Dispose(); }
    public async ValueTask DisposeAsync() { await Body.DisposeAsync(); response.Dispose(); }
}

internal static partial class Validation
{
    [GeneratedRegex("^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")]
    private static partial Regex UuidPattern();
    [GeneratedRegex("^(?:alm_cap_v1|alm_local_v1)\\.[A-Za-z0-9_-]{43,4096}$")]
    private static partial Regex CapabilityPattern();
    [GeneratedRegex("^alm_share_v1\\.[A-Za-z0-9_-]{43,4096}$")]
    private static partial Regex SharePattern();

    internal static string Uuid(string value) => UuidPattern().IsMatch(value ?? "") ? value! : throw Input();
    internal static string Capability(string value) => CapabilityPattern().IsMatch(value ?? "") ? value! : throw Input();
    internal static string Share(string value) => SharePattern().IsMatch(value ?? "") ? value! : throw Input();
    internal static AlmiraClientException Input() => new("ALMIRA_CLIENT_INPUT_INVALID");
    internal static AlmiraClientException Response() => new("ALMIRA_CLIENT_RESPONSE_INVALID");
    internal static Uri BaseUri(string value)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) || (uri.Scheme != "http" && uri.Scheme != "https") || !string.IsNullOrEmpty(uri.UserInfo) || !string.IsNullOrEmpty(uri.Query) || !string.IsNullOrEmpty(uri.Fragment) || uri.AbsolutePath != "/") throw Input();
        return new Uri(value.TrimEnd('/') + "/", UriKind.Absolute);
    }
    internal static string Variant(string value)
    {
        if (string.IsNullOrEmpty(value) || value.Length > 160) throw Input();
        var segments = value.Split('/');
        if (segments.Any(segment => segment is "" or "." or ".." || !Regex.IsMatch(segment, "^[A-Za-z0-9._~-]+$"))) throw Input();
        return string.Join('/', segments.Select(Uri.EscapeDataString));
    }
}

public sealed class AlmiraDataClient
{
    private static readonly HashSet<HttpStatusCode> Retryable = [HttpStatusCode.TooManyRequests, HttpStatusCode.BadGateway, HttpStatusCode.ServiceUnavailable, HttpStatusCode.GatewayTimeout];
    private readonly Uri _baseUrl;
    private readonly Func<CancellationToken, ValueTask<string>>? _capability;
    private readonly string? _origin;
    private readonly HttpClient _http;
    private readonly RetryPolicy _retry;

    public AlmiraDataClient(string baseUrl, Func<CancellationToken, ValueTask<string>>? capability = null, string? origin = null, HttpClient? httpClient = null, RetryPolicy? retry = null)
    {
        _baseUrl = Validation.BaseUri(baseUrl);
        _capability = capability;
        if (origin is not null)
        {
            if (origin.EndsWith('/')) throw Validation.Input();
            var parsed = Validation.BaseUri(origin);
            _origin = parsed.GetLeftPart(UriPartial.Authority);
            if (_origin != origin) throw Validation.Input();
        }
        _http = httpClient ?? new HttpClient(new HttpClientHandler { AllowAutoRedirect = false }) { Timeout = TimeSpan.FromSeconds(30) };
        _retry = retry ?? new RetryPolicy();
        if (_retry.MaxAttempts is < 1 or > 5 || _retry.Base < TimeSpan.Zero || _retry.Maximum < _retry.Base || _retry.Maximum > TimeSpan.FromMinutes(1)) throw Validation.Input();
    }

    public Task<JsonNode> ListFilesWithCapability(CollectionReference reference, IReadOnlyDictionary<string, object?>? filters = null, CancellationToken cancellationToken = default) =>
        SendJson("GET", CollectionPath(reference, "/files") + Query(filters), null, cancellationToken);

    public Task<JsonNode> SearchFilesWithCapability(CollectionReference reference, JsonNode request, CancellationToken cancellationToken = default) =>
        SendJson("POST", CollectionPath(reference, "/search"), request ?? throw Validation.Input(), cancellationToken);

    public Task<JsonNode> GetFileMetadataWithCapability(FileReference reference, CancellationToken cancellationToken = default) =>
        SendJson("GET", CollectionPath(reference, "/files/" + Validation.Uuid(reference.EntryId)), null, cancellationToken);

    public Task<JsonNode> ListDerivativesWithCapability(GenerationReference reference, CancellationToken cancellationToken = default) =>
        SendJson("GET", CollectionPath(reference, "/files/" + Validation.Uuid(reference.EntryId) + "/versions/" + Validation.Uuid(reference.GenerationId) + "/derivatives"), null, cancellationToken);

    public Task<AlmiraBinaryResponse> ReadImmutableGeneration(GenerationReference reference, string? range = null, string? ifNoneMatch = null, CancellationToken cancellationToken = default) =>
        SendBinary($"/v1/delivery/{UuidScope(reference)}/{Validation.Uuid(reference.EntryId)}/{Validation.Uuid(reference.GenerationId)}", range, ifNoneMatch, false, cancellationToken);

    public Task<AlmiraBinaryResponse> ReadDerivative(DerivativeReference reference, string? range = null, string? ifNoneMatch = null, CancellationToken cancellationToken = default) =>
        SendBinary($"/v1/delivery/{UuidScope(reference)}/{Validation.Uuid(reference.EntryId)}/{Validation.Uuid(reference.GenerationId)}/variants/{Validation.Variant(reference.VariantKey)}", range, ifNoneMatch, false, cancellationToken);

    public Task<AlmiraBinaryResponse> ReadShare(string shareToken, string? range = null, string? ifNoneMatch = null, CancellationToken cancellationToken = default) =>
        SendBinary("/v1/shares/" + Uri.EscapeDataString(Validation.Share(shareToken)), range, ifNoneMatch, true, cancellationToken);

    private async Task<JsonNode> SendJson(string method, string path, JsonNode? body, CancellationToken cancellationToken)
    {
        using var response = await Send(method, path, body, false, null, null, cancellationToken);
        if (!response.IsSuccessStatusCode) throw await ApiError(response, cancellationToken);
        if (response.Content.Headers.ContentType?.MediaType != "application/json") throw Validation.Response();
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        return await JsonNode.ParseAsync(new BoundedStream(stream, 2 * 1024 * 1024), cancellationToken: cancellationToken) ?? throw Validation.Response();
    }

    private async Task<AlmiraBinaryResponse> SendBinary(string path, string? range, string? ifNoneMatch, bool share, CancellationToken cancellationToken)
    {
        if (range is not null && (range.Length > 64 || !Regex.IsMatch(range, "^bytes=[0-9]+-[0-9]*$"))) throw Validation.Input();
        if (ifNoneMatch is not null && (ifNoneMatch.Length is < 1 or > 512 || ifNoneMatch.Contains('\r') || ifNoneMatch.Contains('\n'))) throw Validation.Input();
        var response = await Send("GET", path, null, share, range, ifNoneMatch, cancellationToken);
        if (response.StatusCode is not (HttpStatusCode.OK or HttpStatusCode.PartialContent or HttpStatusCode.NotModified))
        {
            using var _ = response;
            throw await ApiError(response, cancellationToken);
        }
        return new AlmiraBinaryResponse(response);
    }

    private async Task<HttpResponseMessage> Send(string method, string path, JsonNode? body, bool share, string? range, string? ifNoneMatch, CancellationToken cancellationToken)
    {
        for (var attempt = 1; attempt <= _retry.MaxAttempts; attempt++)
        {
            using var request = new HttpRequestMessage(new HttpMethod(method), new Uri(_baseUrl, path.TrimStart('/')));
            request.Headers.Accept.ParseAdd(body is null ? "*/*" : "application/json");
            if (!share)
            {
                string token;
                try { token = Validation.Capability(await (_capability ?? throw Validation.Input())(cancellationToken)); }
                catch (AlmiraClientException) { throw; }
                catch { throw new AlmiraClientException("ALMIRA_CLIENT_CREDENTIAL_UNAVAILABLE"); }
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
                if (_origin is not null) request.Headers.TryAddWithoutValidation("Origin", _origin);
            }
            if (range is not null) request.Headers.TryAddWithoutValidation("Range", range);
            if (ifNoneMatch is not null) request.Headers.TryAddWithoutValidation("If-None-Match", ifNoneMatch);
            if (body is not null) request.Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json");
            HttpResponseMessage response;
            try { response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken); }
            catch when (attempt < _retry.MaxAttempts) { await Delay(attempt, null, cancellationToken); continue; }
            catch { throw new AlmiraClientException("ALMIRA_CLIENT_NETWORK"); }
            if (!Retryable.Contains(response.StatusCode) || attempt == _retry.MaxAttempts) return response;
            var retryAfter = response.Headers.RetryAfter?.Delta;
            response.Dispose();
            await Delay(attempt, retryAfter, cancellationToken);
        }
        throw new AlmiraClientException("ALMIRA_CLIENT_NETWORK");
    }

    private Task Delay(int attempt, TimeSpan? retryAfter, CancellationToken cancellationToken)
    {
        var delay = retryAfter ?? TimeSpan.FromMilliseconds(_retry.Base.TotalMilliseconds * Math.Pow(2, attempt - 1));
        return Task.Delay(delay > _retry.Maximum ? _retry.Maximum : delay, cancellationToken);
    }

    internal static async Task<AlmiraApiException> ApiError(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        try
        {
            await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
            var value = await JsonNode.ParseAsync(new BoundedStream(stream, 64 * 1024), cancellationToken: cancellationToken) ?? throw Validation.Response();
            var code = value["code"]?.GetValue<string>() ?? throw Validation.Response();
            var requestId = Validation.Uuid(value["request_id"]?.GetValue<string>() ?? "");
            if (!Regex.IsMatch(code, "^ALMIRA_[A-Z0-9_]{1,127}$")) throw Validation.Response();
            return new AlmiraApiException(code, requestId, response.StatusCode, response.Headers.RetryAfter?.Delta is { } delta ? (int)delta.TotalSeconds : null);
        }
        catch (AlmiraClientException) { throw; }
        catch { throw Validation.Response(); }
    }

    private static string CollectionPath(CollectionReference reference, string suffix) => $"/v1/data/{UuidScope(reference)}{suffix}";
    private static string CollectionPath(FileReference reference, string suffix) => $"/v1/data/{UuidScope(reference)}{suffix}";
    private static string CollectionPath(GenerationReference reference, string suffix) => $"/v1/data/{UuidScope(reference)}{suffix}";
    private static string UuidScope(CollectionReference reference) => Scope(reference.TenantId, reference.ProjectId, reference.EnvironmentId, reference.CollectionInstanceId);
    private static string UuidScope(FileReference reference) => Scope(reference.TenantId, reference.ProjectId, reference.EnvironmentId, reference.CollectionInstanceId);
    private static string UuidScope(GenerationReference reference) => Scope(reference.TenantId, reference.ProjectId, reference.EnvironmentId, reference.CollectionInstanceId);
    private static string UuidScope(DerivativeReference reference) => Scope(reference.TenantId, reference.ProjectId, reference.EnvironmentId, reference.CollectionInstanceId);
    private static string Scope(string tenantId, string projectId, string environmentId, string collectionInstanceId) => $"{Validation.Uuid(tenantId)}/{Validation.Uuid(projectId)}/{Validation.Uuid(environmentId)}/{Validation.Uuid(collectionInstanceId)}";
    private static string Query(IReadOnlyDictionary<string, object?>? values) => values is null ? "" : "?" + string.Join('&', values.Where(entry => entry.Value is not null).Select(entry => Uri.EscapeDataString(entry.Key) + "=" + Uri.EscapeDataString(entry.Value!.ToString()!)));
}

internal sealed class BoundedStream(Stream inner, long remaining) : Stream
{
    public override bool CanRead => true; public override bool CanSeek => false; public override bool CanWrite => false;
    public override long Length => throw new NotSupportedException(); public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
    public override int Read(byte[] buffer, int offset, int count) { var read = inner.Read(buffer, offset, count); remaining -= read; if (remaining < 0) throw Validation.Response(); return read; }
    public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) { var read = await inner.ReadAsync(buffer, cancellationToken); remaining -= read; if (remaining < 0) throw Validation.Response(); return read; }
    public override void Flush() { } public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException(); public override void SetLength(long value) => throw new NotSupportedException(); public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    protected override void Dispose(bool disposing) { if (disposing) inner.Dispose(); base.Dispose(disposing); }
    public override async ValueTask DisposeAsync() { await inner.DisposeAsync(); await base.DisposeAsync(); }
}
