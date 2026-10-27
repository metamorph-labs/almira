import Almira
import CryptoKit
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct ProjectReference: Sendable {
    public let tenantId: String
    public let projectId: String
    public init(tenantId: String, projectId: String) { self.tenantId = tenantId; self.projectId = projectId }
}

public actor AlmiraServerClient {
    private let baseURL: URL
    private let workloadSession: @Sendable () async throws -> String
    private let transport: any AlmiraTransport

    public init(baseURL: String, workloadSession: @escaping @Sendable () async throws -> String, transport: any AlmiraTransport = URLSessionTransport()) throws {
        self.baseURL = try Wire.baseURL(baseURL); self.workloadSession = workloadSession; self.transport = transport
    }

    public func createCapabilitySession(_ reference: CollectionReference, request: JSONValue, operationId: String) async throws -> JSONValue {
        try await send("POST", path: collection(reference, "/capability-sessions"), tenantId: reference.tenantId, operationId: operationId, body: request, statuses: [201])
    }
    public func createUpload(_ reference: CollectionReference, request: JSONValue, operationId: String) async throws -> JSONValue {
        try await send("POST", path: collection(reference, "/uploads"), tenantId: reference.tenantId, operationId: operationId, body: request, statuses: [201])
    }
    public func createUploadPart(_ reference: CollectionReference, transferSessionId: String, request: JSONValue, operationId: String) async throws -> JSONValue {
        try await send("POST", path: collection(reference, "/uploads/\(try Wire.uuid(transferSessionId))/parts"), tenantId: reference.tenantId, operationId: operationId, body: request, statuses: [201])
    }
    public func finalizeUpload(_ reference: CollectionReference, transferSessionId: String, request: JSONValue, operationId: String) async throws -> JSONValue {
        try await send("POST", path: collection(reference, "/uploads/\(try Wire.uuid(transferSessionId))/finalize"), tenantId: reference.tenantId, operationId: operationId, body: request, statuses: [200])
    }
    public func bindSubject(_ reference: CollectionReference, entryId: String, subject: JSONValue, operationId: String) async throws -> JSONValue {
        try await send("POST", path: collection(reference, "/files/\(try Wire.uuid(entryId))/subject-bindings"), tenantId: reference.tenantId, operationId: operationId, body: subject, statuses: [201])
    }
    public func listSubjectBindings(_ reference: ProjectReference, request: JSONValue) async throws -> JSONValue {
        try await send("POST", path: "/v1/projects/\(try Wire.uuid(reference.projectId))/subject-bindings/search", tenantId: reference.tenantId, operationId: nil, body: request, statuses: [200])
    }
    public func startSubjectLifecycleOperation(_ reference: ProjectReference, request: JSONValue, operationId: String) async throws -> JSONValue {
        try await send("POST", path: "/v1/projects/\(try Wire.uuid(reference.projectId))/subject-lifecycle-operations", tenantId: reference.tenantId, operationId: operationId, body: request, statuses: [201, 202])
    }
    public func readSubjectLifecycleOperation(_ reference: ProjectReference, request: JSONValue) async throws -> JSONValue {
        try await send("POST", path: "/v1/projects/\(try Wire.uuid(reference.projectId))/subject-lifecycle-operations/search", tenantId: reference.tenantId, operationId: nil, body: request, statuses: [200])
    }
    public func createSubjectExportDownload(_ reference: ProjectReference, lifecycleOperationId: String, request: JSONValue, operationId: String) async throws -> JSONValue {
        try await send("POST", path: "/v1/projects/\(try Wire.uuid(reference.projectId))/subject-lifecycle-operations/\(try Wire.uuid(lifecycleOperationId))/download", tenantId: reference.tenantId, operationId: operationId, body: request, statuses: [201])
    }
    public func revokeCapabilitySession(_ reference: CollectionReference, sessionId: String, operationId: String) async throws -> String {
        let value = try await send("DELETE", path: collection(reference, "/capability-sessions/\(try Wire.uuid(sessionId))"), tenantId: reference.tenantId, operationId: operationId, body: nil, statuses: [200])
        guard case let .string(result) = value, ["applied", "exact_replay"].contains(result) else { throw Wire.response }
        return result
    }

    private func send(_ method: String, path: String, tenantId: String, operationId: String?, body: JSONValue?, statuses: Set<Int>) async throws -> JSONValue {
        _ = try Wire.uuid(tenantId)
        if let operationId { _ = try Wire.uuid(operationId) }
        let evidence: String
        do { evidence = try await workloadSession() } catch { throw AlmiraClientError("ALMIRA_CLIENT_CREDENTIAL_UNAVAILABLE") }
        guard (2...49152).contains(evidence.count), evidence.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil else { throw Wire.input }
        var request = URLRequest(url: baseURL.appending(path: path.drop(while: { $0 == "/" })))
        request.httpMethod = method; request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("MetamorphWorkload \(evidence)", forHTTPHeaderField: "Authorization")
        request.setValue(tenantId, forHTTPHeaderField: "x-almira-tenant-id")
        if let operationId { request.setValue(operationId, forHTTPHeaderField: "idempotency-key") }
        if let body { request.httpBody = try JSONEncoder().encode(body); request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let response: WireResponse
        do { response = try await transport.send(request) } catch { throw AlmiraClientError("ALMIRA_CLIENT_NETWORK") }
        guard statuses.contains(response.status) else { throw try await Wire.apiError(response) }
        guard response.headers["content-type"]?.split(separator: ";").first == "application/json" else { throw Wire.response }
        return try JSONDecoder().decode(JSONValue.self, from: await Wire.collect(response.body, limit: 2 * 1024 * 1024))
    }

    private func collection(_ reference: CollectionReference, _ suffix: String) throws -> String {
        try "/v1/projects/\(Wire.uuid(reference.projectId))/environments/\(Wire.uuid(reference.environmentId))/collections/\(Wire.uuid(reference.collectionInstanceId))\(suffix)"
    }
}

public struct VerifiedWebhook: Equatable, Sendable {
    public let deliveryId: String; public let eventId: String; public let attempt: Int; public let timestamp: String
}

public func verifyWebhookSignature(secret: Data, body: Data, headers: [String: String], now: Date = Date(), tolerance: TimeInterval = 300) -> VerifiedWebhook? {
    guard !secret.isEmpty, body.count <= 272 * 1024, tolerance >= 0 else { return nil }
    func header(_ name: String) -> String? {
        let values = headers.filter { $0.key.caseInsensitiveCompare(name) == .orderedSame }.map(\.value)
        return values.count == 1 && !values[0].contains(",") ? values[0] : nil
    }
    guard let delivery = header("metamorph-webhook-delivery-id"), let event = header("metamorph-webhook-event-id"), let attemptValue = header("metamorph-webhook-attempt"), let attempt = Int(attemptValue), (1...8).contains(attempt), let timestamp = header("metamorph-webhook-timestamp"), timestamp.range(of: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{6}Z$", options: .regularExpression) != nil, let signature = header("metamorph-webhook-signature"), signature.range(of: "^v1=[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil else { return nil }
    guard (try? Wire.uuid(delivery)) != nil, (try? Wire.uuid(event)) != nil else { return nil }
    let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.timeZone = TimeZone(secondsFromGMT: 0); formatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSSSSS'Z'"; formatter.isLenient = false
    guard let occurred = formatter.date(from: timestamp), abs(now.timeIntervalSince(occurred)) <= tolerance else { return nil }
    let bodyDigest = "sha256:" + SHA256.hash(data: body).map { String(format: "%02x", $0) }.joined()
    let transcript = ["metamorph-webhook-v1", delivery, event, attemptValue, timestamp, bodyDigest].joined(separator: "\n")
    let expected = Data(HMAC<SHA256>.authenticationCode(for: Data(transcript.utf8), using: SymmetricKey(data: secret))).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    guard Data(expected.utf8).constantTimeEquals(Data(signature.dropFirst(3).utf8)) else { return nil }
    return VerifiedWebhook(deliveryId: delivery, eventId: event, attempt: attempt, timestamp: timestamp)
}

private extension Data {
    func constantTimeEquals(_ other: Data) -> Bool {
        guard count == other.count else { return false }
        return zip(self, other).reduce(UInt8(0)) { $0 | ($1.0 ^ $1.1) } == 0
    }
}
