import CryptoKit
import Foundation

public struct VerificationReceiptExpectation: Sendable {
    public let verificationId: String?
    public let tenantId: String
    public let projectId: String
    public let environmentId: String
    public let collectionInstanceId: String
    public let entryId: String
    public let generationId: String
    public let expectedSizeBytes: Int
    public let contentSha256: String

    public init(
        verificationId: String? = nil,
        tenantId: String,
        projectId: String,
        environmentId: String,
        collectionInstanceId: String,
        entryId: String,
        generationId: String,
        expectedSizeBytes: Int,
        contentSha256: String
    ) {
        self.verificationId = verificationId; self.tenantId = tenantId; self.projectId = projectId
        self.environmentId = environmentId; self.collectionInstanceId = collectionInstanceId
        self.entryId = entryId; self.generationId = generationId
        self.expectedSizeBytes = expectedSizeBytes; self.contentSha256 = contentSha256
    }
}

/// Verifies the closed V1 receipt shape, exact expected resource and Ed25519 signature.
public func verifyVerificationReceipt(
    signed: JSONValue,
    keySet: JSONValue,
    expected: VerificationReceiptExpectation? = nil
) -> Bool {
    guard case let .object(signedObject) = signed,
          Set(signedObject.keys) == ["algorithm", "receipt", "signature"],
          signedObject["algorithm"] == .string("ed25519"),
          case let .object(receipt) = signedObject["receipt"], validReceipt(receipt),
          case let .string(signatureValue) = signedObject["signature"],
          let signature = decodeBase64URL(signatureValue, size: 64),
          case let .object(keysObject) = keySet,
          Set(keysObject.keys) == ["format_version", "keys"],
          keysObject["format_version"] == .number(1),
          case let .array(keys) = keysObject["keys"], (1...4).contains(keys.count),
          expected == nil || matches(receipt, expected!),
          case let .string(signingKeyId) = receipt["signing_key_id"] else { return false }

    var matching: [String] = []
    for keyValue in keys {
        guard case let .object(key) = keyValue,
              Set(key.keys) == ["algorithm", "key_id", "public_key"],
              key["algorithm"] == .string("ed25519"),
              case let .string(keyId) = key["key_id"], matchesRegex(keyId, "^[a-z][a-z0-9._-]{0,63}$"),
              case let .string(publicKey) = key["public_key"] else { return false }
        if keyId == signingKeyId { matching.append(publicKey) }
    }
    guard matching.count == 1, let publicKeyData = decodeBase64URL(matching[0], size: 32),
          let publicKey = try? Curve25519.Signing.PublicKey(rawRepresentation: publicKeyData),
          let message = try? canonicalJSON(.object(receipt)) else { return false }
    return publicKey.isValidSignature(signature, for: message)
}

private let verificationChecks = [
    "finalization_idempotency", "private_read_integrity", "cross_scope_refusal", "malware_safety",
]

private func validReceipt(_ receipt: [String: JSONValue]) -> Bool {
    let fields: Set<String> = [
        "checks", "collection_instance_id", "content_sha256", "contract_version", "entry_id",
        "environment_id", "expected_size_bytes", "generation_id", "project_id", "realm_id",
        "receipt_version", "safety_state", "signing_key_id", "tenant_id", "verification_id",
    ]
    guard Set(receipt.keys) == fields,
          receipt["receipt_version"] == .string("almira.verification.v1"),
          receipt["contract_version"] == .string(almiraContractVersion),
          case let .string(keyId) = receipt["signing_key_id"], matchesRegex(keyId, "^[a-z][a-z0-9._-]{0,63}$"),
          case let .string(digest) = receipt["content_sha256"], matchesRegex(digest, "^sha256:[0-9a-f]{64}$"),
          case let .number(size) = receipt["expected_size_bytes"], size.rounded() == size,
          size >= 1, size <= 8 * 1024 * 1024,
          receipt["safety_state"] == .string("clean") || receipt["safety_state"] == .string("not_required") else { return false }
    for field in [
        "verification_id", "realm_id", "tenant_id", "project_id", "environment_id",
        "collection_instance_id", "entry_id", "generation_id",
    ] {
        guard case let .string(value) = receipt[field],
              matchesRegex(value, "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$") else { return false }
    }
    guard case let .array(checks) = receipt["checks"], checks.count == verificationChecks.count else { return false }
    for (index, expected) in verificationChecks.enumerated() {
        guard case let .object(check) = checks[index], Set(check.keys) == ["name", "result"],
              check["name"] == .string(expected), check["result"] == .string("passed") else { return false }
    }
    return true
}

private func matches(_ receipt: [String: JSONValue], _ expected: VerificationReceiptExpectation) -> Bool {
    (expected.verificationId == nil || receipt["verification_id"] == .string(expected.verificationId!)) &&
        receipt["tenant_id"] == .string(expected.tenantId) &&
        receipt["project_id"] == .string(expected.projectId) &&
        receipt["environment_id"] == .string(expected.environmentId) &&
        receipt["collection_instance_id"] == .string(expected.collectionInstanceId) &&
        receipt["entry_id"] == .string(expected.entryId) &&
        receipt["generation_id"] == .string(expected.generationId) &&
        receipt["expected_size_bytes"] == .number(Double(expected.expectedSizeBytes)) &&
        receipt["content_sha256"] == .string(expected.contentSha256)
}

private func canonicalJSON(_ value: JSONValue) throws -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return try encoder.encode(value)
}

private func decodeBase64URL(_ value: String, size: Int) -> Data? {
    guard !value.contains("=") else { return nil }
    let base64 = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") +
        String(repeating: "=", count: (4 - value.count % 4) % 4)
    guard let decoded = Data(base64Encoded: base64), decoded.count == size else { return nil }
    return decoded.base64EncodedString().replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") == value ? decoded : nil
}

private func matchesRegex(_ value: String, _ pattern: String) -> Bool {
    value.range(of: pattern, options: .regularExpression) != nil
}
