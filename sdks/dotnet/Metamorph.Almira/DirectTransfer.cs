using System.Net;
using System.Security.Cryptography;
using System.Text.Json.Nodes;

namespace Metamorph.Almira;

public sealed class AlmiraTransferException(string code, int? partNumber = null, int? status = null) : Exception(code)
{
    public string Code { get; } = code;
    public int? PartNumber { get; } = partNumber;
    public int? Status { get; } = status;
}

public static class DirectTransfer
{
    public static async Task<JsonObject> UploadDirectAsync(
        JsonNode descriptor,
        Stream source,
        Func<JsonObject, CancellationToken, Task<JsonNode>>? grantPart = null,
        HttpClient? httpClient = null,
        CancellationToken cancellationToken = default)
    {
        var client = httpClient ?? new HttpClient(new HttpClientHandler { AllowAutoRedirect = false }) { Timeout = TimeSpan.FromSeconds(30) };
        try
        {
            if (descriptor is not JsonObject value || !source.CanRead || !source.CanSeek) throw Invalid();
            var descriptorId = Validation.Uuid(Text(value, "descriptor_id"));
            var protocol = Text(value, "protocol");
            if (protocol is not ("single_put" or "multipart") || value["one_use"]?.GetValue<bool>() != true) throw Invalid();
            var expectedSize = Integer(value, "expected_size_bytes");
            if (expectedSize is < 1 or > 10_737_418_240 || source.Length != expectedSize) throw Invalid();
            var contentSha256 = Text(value, "content_sha256");
            if (!System.Text.RegularExpressions.Regex.IsMatch(contentSha256, "^sha256:[0-9a-f]{64}$")) throw Invalid();
            if (!DateTimeOffset.TryParse(Text(value, "expires_at"), out var expiresAt) || expiresAt <= DateTimeOffset.UtcNow) throw new AlmiraTransferException("ALMIRA_TRANSFER_DESCRIPTOR_EXPIRED");
            if (value["requests"] is not JsonArray requests) throw Invalid();
            var count = Integer(value, "part_count");
            if (count is < 1 or > 10_000) throw Invalid();
            var partCount = (int)count;
            long partSize;
            if (protocol == "single_put")
            {
                if (requests.Count != 1 || value["part_size_bytes"] is not null || partCount != 1) throw Invalid();
                partSize = expectedSize;
            }
            else
            {
                if (requests.Count != 0 || value["part_size_bytes"] is null) throw Invalid();
                partSize = Integer(value, "part_size_bytes");
                if (partSize < 1 || checked(partSize * (partCount - 1L)) >= expectedSize || checked(partSize * partCount) < expectedSize) throw Invalid();
            }
            var completions = new JsonArray();
            string? objectEtag = null;
            string? providerVersion = null;
            for (var number = 1; number <= partCount; number++)
            {
                var offset = (number - 1L) * partSize;
                var length = Math.Min(partSize, expectedSize - offset);
                if (length <= 0) throw Invalid();
                JsonNode part;
                if (protocol == "single_put")
                {
                    part = requests[0] ?? throw Invalid();
                }
                else
                {
                    if (grantPart is null) throw Invalid();
                    part = await grantPart(new JsonObject { ["part_number"] = number, ["content_sha256"] = await HashPart(source, offset, length, cancellationToken) }, cancellationToken);
                }
                ValidatePart(part, number, offset, length);
                if (expiresAt <= DateTimeOffset.UtcNow) throw new AlmiraTransferException("ALMIRA_TRANSFER_DESCRIPTOR_EXPIRED");
                using var request = new HttpRequestMessage(HttpMethod.Put, Text(part, "url"));
                source.Position = offset;
                request.Content = new StreamContent(new SegmentStream(source, length, leaveOpen: true));
                foreach (var header in part["headers"]?.AsArray() ?? [])
                {
                    var name = Text(header!, "name"); var headerValue = Text(header!, "value");
                    if (!request.Headers.TryAddWithoutValidation(name, headerValue) && !request.Content.Headers.TryAddWithoutValidation(name, headerValue)) throw Invalid();
                }
                request.Content.Headers.ContentLength = length;
                HttpResponseMessage response;
                try { response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken); }
                catch { throw new AlmiraTransferException("ALMIRA_TRANSFER_OUTCOME_UNKNOWN", number); }
                using (response)
                {
                    if (!response.IsSuccessStatusCode) throw new AlmiraTransferException("ALMIRA_TRANSFER_PART_REFUSED", number, (int)response.StatusCode);
                    var etag = response.Headers.ETag?.ToString();
                    if (etag is null || etag.Length is < 1 or > 256 || etag.Any(character => character is < '!' or > '~')) throw new AlmiraTransferException("ALMIRA_TRANSFER_RESPONSE_INVALID", number);
                    completions.Add(new JsonObject { ["part_number"] = number, ["etag"] = etag });
                    if (protocol == "single_put")
                    {
                        objectEtag = etag;
                        foreach (var name in new[] { "x-amz-version-id", "x-goog-generation", "x-ms-version-id" })
                        {
                            if (!response.Headers.TryGetValues(name, out var versions)) continue;
                            var values = versions.ToArray();
                            if (values.Length != 1) throw new AlmiraTransferException("ALMIRA_TRANSFER_RESPONSE_INVALID", number);
                            var version = values[0];
                            if (version.Length is < 1 or > 256 || version.IndexOfAny(['/','?','#','\\']) >= 0 || providerVersion is not null && providerVersion != version) throw new AlmiraTransferException("ALMIRA_TRANSFER_RESPONSE_INVALID", number);
                            providerVersion = version;
                        }
                    }
                }
            }
            return new JsonObject { ["descriptor_id"] = descriptorId, ["protocol"] = protocol, ["etag"] = objectEtag, ["provider_version"] = providerVersion, ["parts"] = completions, ["size_bytes"] = expectedSize, ["content_sha256"] = contentSha256 };
        }
        catch (AlmiraTransferException) { throw; }
        catch { throw Invalid(); }
    }

    private static void ValidatePart(JsonNode part, int number, long offset, long length)
    {
        if (part is not JsonObject value || Integer(value, "part_number") != number || Integer(value, "offset_bytes") != offset || Integer(value, "length_bytes") != length || Text(value, "method") != "PUT" || value["one_use"]?.GetValue<bool>() != true) throw Invalid();
        var encodedUrl = Text(value, "url");
        if (encodedUrl.Length > 8192 || encodedUrl.Any(character => character <= ' ' || character == '\u007f' || character == '\\') || !Uri.TryCreate(encodedUrl, UriKind.Absolute, out var url) || url.Scheme != "https" || string.IsNullOrEmpty(url.Host) || !string.IsNullOrEmpty(url.UserInfo) || !string.IsNullOrEmpty(url.Fragment) || value["headers"] is not JsonArray { Count: <= 32 } headers) throw Invalid();
        var names = new HashSet<string>();
        foreach (var header in headers)
        {
            if (header is not JsonObject objectValue) throw Invalid();
            var name = Text(objectValue, "name"); var headerValue = Text(objectValue, "value");
            if (!System.Text.RegularExpressions.Regex.IsMatch(name, "^[A-Za-z0-9_-]{1,128}$") || headerValue.Length is < 1 or > 4096 || headerValue.Any(character => char.IsControl(character)) || !names.Add(name)) throw Invalid();
        }
    }
    private static async Task<string> HashPart(Stream source, long offset, long length, CancellationToken cancellationToken)
    {
        source.Position = offset; using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256); var buffer = new byte[64 * 1024]; var remaining = length;
        while (remaining > 0) { var read = await source.ReadAsync(buffer.AsMemory(0, (int)Math.Min(buffer.Length, remaining)), cancellationToken); if (read == 0) throw Invalid(); hash.AppendData(buffer, 0, read); remaining -= read; }
        return "sha256:" + Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
    }
    private static string Text(JsonNode value, string name) => value[name]?.GetValue<string>() ?? throw Invalid();
    private static long Integer(JsonNode value, string name)
    {
        if (value[name] is not JsonValue encoded) throw Invalid();
        if (encoded.TryGetValue<long>(out var longValue) && longValue >= 0) return longValue;
        if (encoded.TryGetValue<int>(out var intValue) && intValue >= 0) return intValue;
        throw Invalid();
    }
    private static AlmiraTransferException Invalid() => new("ALMIRA_TRANSFER_DESCRIPTOR_INVALID");

    private sealed class SegmentStream(Stream inner, long remaining, bool leaveOpen) : Stream
    {
        public override bool CanRead => true; public override bool CanSeek => false; public override bool CanWrite => false; public override long Length => throw new NotSupportedException(); public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override int Read(byte[] buffer, int offset, int count) { if (remaining == 0) return 0; var read = inner.Read(buffer, offset, (int)Math.Min(count, remaining)); remaining -= read; return read; }
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) { if (remaining == 0) return 0; var read = await inner.ReadAsync(buffer[..(int)Math.Min(buffer.Length, remaining)], cancellationToken); remaining -= read; return read; }
        public override void Flush() { } public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException(); public override void SetLength(long value) => throw new NotSupportedException(); public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        protected override void Dispose(bool disposing) { if (disposing && !leaveOpen) inner.Dispose(); base.Dispose(disposing); }
    }
}
