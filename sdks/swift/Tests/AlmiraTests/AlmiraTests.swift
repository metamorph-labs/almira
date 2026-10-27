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
