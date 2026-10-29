import Almira
import AlmiraServer
import Foundation
import Testing

private let tenant = "018f0000-0000-7000-8000-000000000002"
private let project = "018f0000-0000-7000-8000-000000000003"
private let environment = "018f0000-0000-7000-8000-000000000004"
private let collection = "018f0000-0000-7000-8000-000000000005"
private let capability = "alm_cap_v1.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

private actor Recorder: AlmiraTransport {
    private(set) var requests: [URLRequest] = []
    func send(_ request: URLRequest) async throws -> WireResponse {
        requests.append(request)
        let value = request.url!.path.contains("shares") ? Data("hello".utf8) : Data("{}".utf8)
        return WireResponse(status: 200, headers: ["content-type": request.url!.path.contains("shares") ? "application/octet-stream" : "application/json"], body: AsyncThrowingStream { continuation in continuation.yield(value); continuation.finish() })
    }
    func snapshot() -> [URLRequest] { requests }
}

private actor JourneyTransport: AlmiraTransport {
    private let responses: [(Int, JSONValue, [String: String])]
    private(set) var requests: [URLRequest] = []
    init(_ responses: [(Int, JSONValue, [String: String])]) { self.responses = responses }
    func send(_ request: URLRequest) async throws -> WireResponse {
        let index = requests.count
        requests.append(request)
        let response = responses[min(index, responses.count - 1)]
        var headers = ["content-type": "application/json"]
        headers.merge(response.2) { _, new in new }
        let body = try JSONEncoder().encode(response.1)
        return WireResponse(status: response.0, headers: headers, body: AsyncThrowingStream { continuation in
            continuation.yield(body); continuation.finish()
        })
    }
    func authorities() -> [String?] { requests.map { $0.value(forHTTPHeaderField: "Authorization") } }
}

private actor CapabilitySequence {
    private let values: [String]
    private var index = 0
    init(_ values: [String]) { self.values = values }
    func next() -> String { defer { index += 1 }; return values[index] }
}

@Test func dataClientScopesCapabilityAndKeepsShareAnonymous() async throws {
    #expect(throws: AlmiraClientError.self) {
        _ = try AlmiraDataClient(baseURL: "https://almira.test", capability: { capability }, origin: "https://app.example/")
    }
    let recorder = Recorder()
    let client = try AlmiraDataClient(baseURL: "https://almira.test", capability: { capability }, origin: "https://app.example", transport: recorder)
    let reference = CollectionReference(tenantId: tenant, projectId: project, environmentId: environment, collectionInstanceId: collection)
    _ = try await client.listFilesWithCapability(reference, filters: ["limit": "25"])
    let share = try await client.readShare("alm_share_v1.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
    for try await _ in share.body {}
    await #expect(throws: AlmiraClientError.self) {
        _ = try await client.readShare("alm_share_v1.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", range: "bytes=unsafe")
    }
    let requests = await recorder.snapshot()
    #expect(requests[0].value(forHTTPHeaderField: "Authorization") == "Bearer \(capability)")
    #expect(requests[1].value(forHTTPHeaderField: "Authorization") == nil)
}

@Test func contractVersionIsPinned() {
    #expect(almiraContractVersion == "0.1.0-dev.59")
}

private struct UploadRecorder: DirectUploadTransport {
    func put(part: JSONValue, source: URL) async throws -> DirectUploadResponse {
        DirectUploadResponse(status: 200, headers: ["etag": "\"v1\""])
    }
}

@Test func directTransferReturnsFinalizeEvidenceOnly() async throws {
    let source = FileManager.default.temporaryDirectory.appendingPathComponent("almira-test-\(UUID().uuidString)")
    try Data("hello".utf8).write(to: source); defer { try? FileManager.default.removeItem(at: source) }
    let descriptor: JSONValue = .object([
        "descriptor_id": .string("018f0000-0000-7000-8000-000000000008"), "protocol": .string("single_put"),
        "expected_size_bytes": .number(5), "content_sha256": .string("sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"),
        "one_use": .bool(true), "expires_at": .string("2099-01-01T00:00:00.000000Z"), "part_size_bytes": .null, "part_count": .number(1),
        "requests": .array([.object(["part_number": .number(1), "offset_bytes": .number(0), "length_bytes": .number(5), "method": .string("PUT"), "url": .string("https://storage.test/secret"), "headers": .array([]), "one_use": .bool(true)])]),
    ])
    let result = try await uploadDirect(descriptor: descriptor, source: source, transport: UploadRecorder())
    let encoded = String(data: try JSONEncoder().encode(result), encoding: .utf8)!
    #expect(encoded.contains("v1")); #expect(!encoded.contains("storage.test"))
}


@Test func verifiesTheCommonWebhookVectorAndRejectsTampering() throws {
    let body = Data("{\"event\":\"almira.file.available.v1\"}".utf8)
    var headers = [
        "metamorph-webhook-delivery-id": "018f0000-0000-7000-8000-000000000011",
        "metamorph-webhook-event-id": "018f0000-0000-7000-8000-000000000012",
        "metamorph-webhook-attempt": "2",
        "metamorph-webhook-timestamp": "2026-10-17T12:00:00.000000Z",
        "metamorph-webhook-signature": "v1=PHaG4k_rjkr4itoseS10o0_znK6FR9aoArs7pPV2klI",
    ]
    let now = try #require(ISO8601DateFormatter().date(from: "2026-10-17T12:00:30Z"))
    let verified = verifyWebhookSignature(secret: Data("topsecret".utf8), body: body, headers: headers, now: now)
    #expect(verified?.attempt == 2)
    headers["metamorph-webhook-signature"] = "v1=AHaG4k_rjkr4itoseS10o0_znK6FR9aoArs7pPV2klI"
    #expect(verifyWebhookSignature(secret: Data("topsecret".utf8), body: body, headers: headers, now: now) == nil)
}

@Test func verifiesTheCommonBehaviorReceiptVectorAndRejectsSubstitution() throws {
    let repository = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    let raw = try Data(contentsOf: repository.appendingPathComponent("conformance/application-sdk.v1.json"))
    guard case let .object(root) = try JSONDecoder().decode(JSONValue.self, from: raw),
          case let .object(vector) = root["behavior_receipt"],
          let signed = vector["signed"], let keySet = vector["key_set"],
          case let .object(expected) = vector["expected"],
          case let .object(substitution) = vector["substitution"],
          case let .string(verificationId) = expected["verification_id"],
          case let .string(tenantId) = expected["tenant_id"],
          case let .string(projectId) = expected["project_id"],
          case let .string(environmentId) = expected["environment_id"],
          case let .string(collectionInstanceId) = expected["collection_instance_id"],
          case let .string(entryId) = expected["entry_id"],
          case let .string(generationId) = expected["generation_id"],
          case let .number(expectedSize) = expected["expected_size_bytes"],
          case let .string(contentSha256) = expected["content_sha256"],
          case let .string(otherGeneration) = substitution["generation_id"] else { throw AlmiraClientError("vector") }
    let expectation = VerificationReceiptExpectation(
        verificationId: verificationId, tenantId: tenantId, projectId: projectId,
        environmentId: environmentId, collectionInstanceId: collectionInstanceId,
        entryId: entryId, generationId: generationId, expectedSizeBytes: Int(expectedSize),
        contentSha256: contentSha256
    )
    #expect(verifyVerificationReceipt(signed: signed, keySet: keySet, expected: expectation))
    let replaced = VerificationReceiptExpectation(
        verificationId: verificationId, tenantId: tenantId, projectId: projectId,
        environmentId: environmentId, collectionInstanceId: collectionInstanceId,
        entryId: entryId, generationId: otherGeneration, expectedSizeBytes: Int(expectedSize),
        contentSha256: contentSha256
    )
    #expect(!verifyVerificationReceipt(signed: signed, keySet: keySet, expected: replaced))
}

@Test func commonManagedDevelopmentPositiveRefusalRetryAndCleanupJourney() async throws {
    let repository = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    let raw = try Data(contentsOf: repository.appendingPathComponent("conformance/application-sdk.v1.json"))
    guard case let .object(root) = try JSONDecoder().decode(JSONValue.self, from: raw),
          case let .object(journey) = root["managed_development"],
          case let .string(baseURL) = journey["base_url"], case let .string(origin) = journey["origin"],
          case let .object(ids) = journey["reference"], case let .string(tenantId) = ids["tenant_id"],
          case let .string(projectId) = ids["project_id"], case let .string(environmentId) = ids["environment_id"],
          case let .string(collectionId) = ids["collection_instance_id"], case let .string(entryId) = ids["entry_id"],
          case let .object(positive) = journey["positive"], case let .string(localCapability) = positive["capability"],
          let positiveResponse = positive["response"], case let .object(refusal) = journey["refusal"],
          case let .string(refusedCredential) = refusal["credential"], case let .string(refusalCode) = refusal["client_code"],
          case let .object(retry) = journey["retry"], case let .array(retryValues) = retry["capabilities"],
          case let .string(firstCapability) = retryValues[0], case let .string(secondCapability) = retryValues[1],
          case let .number(firstStatus) = retry["first_status"], let firstError = retry["first_error"],
          case let .number(finalStatus) = retry["final_status"], case let .object(cleanup) = journey["cleanup"] else {
        throw AlmiraClientError("vector")
    }
    let reference = FileReference(tenantId: tenantId, projectId: projectId, environmentId: environmentId, collectionInstanceId: collectionId, entryId: entryId)
    let positiveTransport = JourneyTransport([(200, positiveResponse, [:])])
    let positiveClient = try AlmiraDataClient(baseURL: baseURL, capability: { localCapability }, origin: origin, transport: positiveTransport)
    guard case let .object(entry) = try await positiveClient.getFileMetadataWithCapability(reference) else { throw AlmiraClientError("positive") }
    #expect(entry["entry_id"] == .string(entryId))
    #expect(await positiveTransport.authorities() == ["Bearer \(localCapability)"])

    let refusalTransport = JourneyTransport([(200, positiveResponse, [:])])
    let refused = try AlmiraDataClient(baseURL: baseURL, capability: { refusedCredential }, transport: refusalTransport)
    do {
        _ = try await refused.getFileMetadataWithCapability(reference)
        Issue.record("management credential was accepted")
    } catch let error as AlmiraClientError {
        #expect(error.code == refusalCode)
    }
    #expect(await refusalTransport.authorities().isEmpty)

    let capabilities = CapabilitySequence([firstCapability, secondCapability])
    let retryTransport = JourneyTransport([
        (Int(firstStatus), firstError, ["retry-after": "0"]),
        (Int(finalStatus), positiveResponse, [:]),
    ])
    let retrying = try AlmiraDataClient(
        baseURL: baseURL, capability: { await capabilities.next() }, transport: retryTransport,
        retry: RetryPolicy(maxAttempts: 2, baseDelay: .zero, maximumDelay: .zero)
    )
    guard case let .object(retriedEntry) = try await retrying.getFileMetadataWithCapability(reference) else { throw AlmiraClientError("retry") }
    #expect(retriedEntry["entry_id"] == .string(entryId))
    #expect(await retryTransport.authorities() == ["Bearer \(firstCapability)", "Bearer \(secondCapability)"])
    #expect(cleanup["applicable"] == .bool(false))
    #expect(cleanup["reason"] == .string("read_only_journey"))
}
