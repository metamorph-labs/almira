using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Chaos.NaCl;

namespace Metamorph.Almira;

public sealed record VerificationReceiptExpectation(
    string TenantId,
    string ProjectId,
    string EnvironmentId,
    string CollectionInstanceId,
    string EntryId,
    string GenerationId,
    long ExpectedSizeBytes,
    string ContentSha256,
    string? VerificationId = null);

/// <summary>Closed-shape Ed25519 verification for Almira V1 behavior receipts.</summary>
public static partial class VerificationReceiptVerifier
{
    private static readonly string[] Checks =
    [
        "finalization_idempotency", "private_read_integrity", "cross_scope_refusal", "malware_safety",
    ];

    /// <summary>Verifies a receipt against a trusted key set and optional exact resource binding.</summary>
    public static bool Verify(JsonNode? signed, JsonNode? keySet, VerificationReceiptExpectation? expected = null)
    {
        try
        {
            if (!ExactKeys(signed, "algorithm", "receipt", "signature") ||
                signed!["algorithm"]?.GetValue<string>() != "ed25519" ||
                signed["receipt"] is not JsonObject receipt || !ValidReceipt(receipt) ||
                signed["signature"] is not JsonValue signatureValue || !signatureValue.TryGetValue<string>(out var encodedSignature) ||
                DecodeBase64Url(encodedSignature, 64) is not { } signature ||
                !ExactKeys(keySet, "format_version", "keys") || keySet!["format_version"]?.GetValue<int>() != 1 ||
                keySet["keys"] is not JsonArray keys || keys.Count is < 1 or > 4 ||
                expected is not null && !Matches(receipt, expected)) return false;
            var matching = new List<string>();
            foreach (var value in keys)
            {
                if (!ExactKeys(value, "algorithm", "key_id", "public_key") ||
                    value!["algorithm"]?.GetValue<string>() != "ed25519" ||
                    value["key_id"] is not JsonValue keyIdValue || !keyIdValue.TryGetValue<string>(out var keyId) || !KeyId().IsMatch(keyId) ||
                    value["public_key"] is not JsonValue publicKeyValue || !publicKeyValue.TryGetValue<string>(out var publicKey)) return false;
                if (keyId == receipt["signing_key_id"]!.GetValue<string>()) matching.Add(publicKey);
            }
            if (matching.Count != 1 || DecodeBase64Url(matching[0], 32) is not { } rawPublicKey) return false;
            var message = Encoding.UTF8.GetBytes(Canonical(receipt).ToJsonString(new JsonSerializerOptions { WriteIndented = false }));
            return Ed25519.Verify(signature, message, rawPublicKey);
        }
        catch (Exception)
        {
            return false;
        }
    }

    private static bool ValidReceipt(JsonObject receipt)
    {
        if (!ExactKeys(receipt,
                "checks", "collection_instance_id", "content_sha256", "contract_version", "entry_id",
                "environment_id", "expected_size_bytes", "generation_id", "project_id", "realm_id",
                "receipt_version", "safety_state", "signing_key_id", "tenant_id", "verification_id") ||
            receipt["receipt_version"]?.GetValue<string>() != "almira.verification.v1" ||
            receipt["contract_version"]?.GetValue<string>() != "0.1.0-dev.59" ||
            receipt["signing_key_id"] is not JsonValue keyIdValue || !keyIdValue.TryGetValue<string>(out var keyId) || !KeyId().IsMatch(keyId) ||
            receipt["content_sha256"] is not JsonValue digestValue || !digestValue.TryGetValue<string>(out var digest) || !Digest().IsMatch(digest) ||
            receipt["expected_size_bytes"] is not JsonValue sizeValue || !sizeValue.TryGetValue<long>(out var size) || size is < 1 or > 8 * 1024 * 1024 ||
            receipt["safety_state"]?.GetValue<string>() is not ("not_required" or "clean")) return false;
        foreach (var field in new[]
                 {
                     "verification_id", "realm_id", "tenant_id", "project_id", "environment_id",
                     "collection_instance_id", "entry_id", "generation_id",
                 })
        {
            if (receipt[field] is not JsonValue value || !value.TryGetValue<string>(out var id) || !UuidV7().IsMatch(id)) return false;
        }
        if (receipt["checks"] is not JsonArray checks || checks.Count != Checks.Length) return false;
        for (var index = 0; index < Checks.Length; index++)
        {
            if (!ExactKeys(checks[index], "name", "result") || checks[index]!["name"]?.GetValue<string>() != Checks[index] ||
                checks[index]!["result"]?.GetValue<string>() != "passed") return false;
        }
        return true;
    }

    private static bool Matches(JsonObject receipt, VerificationReceiptExpectation expected) =>
        (expected.VerificationId is null || receipt["verification_id"]?.GetValue<string>() == expected.VerificationId) &&
        receipt["tenant_id"]?.GetValue<string>() == expected.TenantId &&
        receipt["project_id"]?.GetValue<string>() == expected.ProjectId &&
        receipt["environment_id"]?.GetValue<string>() == expected.EnvironmentId &&
        receipt["collection_instance_id"]?.GetValue<string>() == expected.CollectionInstanceId &&
        receipt["entry_id"]?.GetValue<string>() == expected.EntryId &&
        receipt["generation_id"]?.GetValue<string>() == expected.GenerationId &&
        receipt["expected_size_bytes"]?.GetValue<long>() == expected.ExpectedSizeBytes &&
        receipt["content_sha256"]?.GetValue<string>() == expected.ContentSha256;

    private static bool ExactKeys(JsonNode? value, params string[] expected) =>
        value is JsonObject objectValue && objectValue.Select(item => item.Key).Order().SequenceEqual(expected.Order());

    private static JsonNode Canonical(JsonNode value)
    {
        if (value is JsonArray array) return new JsonArray(array.Select(child => child is null ? null : Canonical(child)).ToArray());
        if (value is JsonObject objectValue)
        {
            var result = new JsonObject();
            foreach (var item in objectValue.OrderBy(item => item.Key)) result[item.Key] = item.Value is null ? null : Canonical(item.Value);
            return result;
        }
        return value.DeepClone();
    }

    private static byte[]? DecodeBase64Url(string value, int size)
    {
        if (value.Contains('=') || !Base64Url().IsMatch(value)) return null;
        try
        {
            var decoded = Convert.FromBase64String(value.Replace('-', '+').Replace('_', '/') + new string('=', (4 - value.Length % 4) % 4));
            return decoded.Length == size && Convert.ToBase64String(decoded).TrimEnd('=').Replace('+', '-').Replace('/', '_') == value ? decoded : null;
        }
        catch (FormatException) { return null; }
    }

    [GeneratedRegex("^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")]
    private static partial Regex UuidV7();
    [GeneratedRegex("^sha256:[0-9a-f]{64}$")]
    private static partial Regex Digest();
    [GeneratedRegex("^[a-z][a-z0-9._-]{0,63}$")]
    private static partial Regex KeyId();
    [GeneratedRegex("^[A-Za-z0-9_-]+$")]
    private static partial Regex Base64Url();
}
