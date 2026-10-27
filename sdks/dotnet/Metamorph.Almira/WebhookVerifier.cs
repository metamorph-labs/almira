using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace Metamorph.Almira;

public sealed record VerifiedWebhook(string DeliveryId, string EventId, int Attempt, string Timestamp);

public static partial class WebhookVerifier
{
    [GeneratedRegex("^v1=([A-Za-z0-9_-]{43})$")]
    private static partial Regex SignaturePattern();

    public static VerifiedWebhook? VerifyWebhookSignature(ReadOnlySpan<byte> secret, ReadOnlySpan<byte> body, IReadOnlyDictionary<string, string> headers, DateTimeOffset? now = null, TimeSpan? tolerance = null)
    {
        if (secret.IsEmpty || body.Length > 272 * 1024 || (tolerance ?? TimeSpan.FromMinutes(5)) < TimeSpan.Zero) return null;
        var delivery = Header(headers, "metamorph-webhook-delivery-id");
        var eventId = Header(headers, "metamorph-webhook-event-id");
        var attemptValue = Header(headers, "metamorph-webhook-attempt");
        var timestamp = Header(headers, "metamorph-webhook-timestamp");
        var signature = Header(headers, "metamorph-webhook-signature");
        if (delivery is null || eventId is null || attemptValue is null || timestamp is null || signature is null) return null;
        try { Validation.Uuid(delivery); Validation.Uuid(eventId); } catch { return null; }
        if (!int.TryParse(attemptValue, out var attempt) || attempt is < 1 or > 8 || !DateTimeOffset.TryParseExact(timestamp, "yyyy-MM-dd'T'HH:mm:ss.ffffff'Z'", null, System.Globalization.DateTimeStyles.AssumeUniversal, out var occurred)) return null;
        if (((now ?? DateTimeOffset.UtcNow) - occurred).Duration() > (tolerance ?? TimeSpan.FromMinutes(5))) return null;
        var match = SignaturePattern().Match(signature);
        if (!match.Success) return null;
        var digest = "sha256:" + Convert.ToHexString(SHA256.HashData(body)).ToLowerInvariant();
        var transcript = string.Join('\n', "metamorph-webhook-v1", delivery, eventId, attemptValue, timestamp, digest);
        var expected = Base64Url(HMACSHA256.HashData(secret, Encoding.UTF8.GetBytes(transcript)));
        return CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(expected), Encoding.ASCII.GetBytes(match.Groups[1].Value))
            ? new VerifiedWebhook(delivery, eventId, attempt, timestamp)
            : null;
    }

    private static string? Header(IReadOnlyDictionary<string, string> headers, string name)
    {
        var values = headers.Where(entry => string.Equals(entry.Key, name, StringComparison.OrdinalIgnoreCase)).Select(entry => entry.Value).ToArray();
        return values.Length == 1 && !values[0].Contains(',') ? values[0] : null;
    }

    private static string Base64Url(byte[] value) => Convert.ToBase64String(value).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}
