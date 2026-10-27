import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public let almiraContractVersion = "0.1.0-dev.59"

public enum JSONValue: Codable, Equatable, Sendable {
    case object([String: JSONValue])
    case array([JSONValue])
    case string(String)
    case number(Double)
    case bool(Bool)
    case null

    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() { self = .null }
        else if let decoded = try? value.decode(Bool.self) { self = .bool(decoded) }
        else if let decoded = try? value.decode(Double.self) { self = .number(decoded) }
        else if let decoded = try? value.decode(String.self) { self = .string(decoded) }
        else if let decoded = try? value.decode([JSONValue].self) { self = .array(decoded) }
        else { self = .object(try value.decode([String: JSONValue].self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self {
        case let .object(decoded): try value.encode(decoded)
        case let .array(decoded): try value.encode(decoded)
        case let .string(decoded): try value.encode(decoded)
        case let .number(decoded): try value.encode(decoded)
        case let .bool(decoded): try value.encode(decoded)
        case .null: try value.encodeNil()
        }
    }
}

public struct CollectionReference: Sendable {
    public let tenantId: String
    public let projectId: String
    public let environmentId: String
    public let collectionInstanceId: String
    public init(tenantId: String, projectId: String, environmentId: String, collectionInstanceId: String) {
        self.tenantId = tenantId; self.projectId = projectId; self.environmentId = environmentId; self.collectionInstanceId = collectionInstanceId
    }
}

public struct FileReference: Sendable {
    public let tenantId: String; public let projectId: String; public let environmentId: String; public let collectionInstanceId: String; public let entryId: String
    public init(tenantId: String, projectId: String, environmentId: String, collectionInstanceId: String, entryId: String) {
        self.tenantId = tenantId; self.projectId = projectId; self.environmentId = environmentId; self.collectionInstanceId = collectionInstanceId; self.entryId = entryId
    }
}

public struct GenerationReference: Sendable {
    public let tenantId: String; public let projectId: String; public let environmentId: String; public let collectionInstanceId: String; public let entryId: String; public let generationId: String
    public init(tenantId: String, projectId: String, environmentId: String, collectionInstanceId: String, entryId: String, generationId: String) {
        self.tenantId = tenantId; self.projectId = projectId; self.environmentId = environmentId; self.collectionInstanceId = collectionInstanceId; self.entryId = entryId; self.generationId = generationId
    }
}

public struct DerivativeReference: Sendable {
    public let tenantId: String; public let projectId: String; public let environmentId: String; public let collectionInstanceId: String; public let entryId: String; public let generationId: String; public let variantKey: String
    public init(tenantId: String, projectId: String, environmentId: String, collectionInstanceId: String, entryId: String, generationId: String, variantKey: String) {
        self.tenantId = tenantId; self.projectId = projectId; self.environmentId = environmentId; self.collectionInstanceId = collectionInstanceId; self.entryId = entryId; self.generationId = generationId; self.variantKey = variantKey
    }
}

public struct BinaryResponse: Sendable {
    public let status: Int
    public let headers: [String: String]
    public let body: AsyncThrowingStream<Data, Error>
}

public struct AlmiraClientError: Error, Equatable, Sendable {
    public let code: String
    public init(_ code: String) { self.code = code }
}

public struct AlmiraAPIError: Error, Equatable, Sendable {
    public let code: String; public let requestId: String; public let status: Int; public let retryAfterSeconds: Int?
}

public struct WireResponse: Sendable {
    public let status: Int; public let headers: [String: String]; public let body: AsyncThrowingStream<Data, Error>
    public init(status: Int, headers: [String: String], body: AsyncThrowingStream<Data, Error>) {
        self.status = status; self.headers = Dictionary(uniqueKeysWithValues: headers.map { ($0.key.lowercased(), $0.value) }); self.body = body
    }
}

public protocol AlmiraTransport: Sendable {
    func send(_ request: URLRequest) async throws -> WireResponse
}

public struct URLSessionTransport: AlmiraTransport {
    private let session: URLSession
    public init() {
        self.session = URLSession(configuration: .ephemeral, delegate: AlmiraNoRedirectDelegate(), delegateQueue: nil)
    }
    public init(session: URLSession) { self.session = session }
    public func send(_ request: URLRequest) async throws -> WireResponse {
        let (bytes, response) = try await session.bytes(for: request)
        guard let response = response as? HTTPURLResponse else { throw AlmiraClientError("ALMIRA_CLIENT_RESPONSE_INVALID") }
        let stream = AsyncThrowingStream<Data, Error> { continuation in
            Task {
                do {
                    var iterator = bytes.makeAsyncIterator()
                    var chunk = Data(); chunk.reserveCapacity(64 * 1024)
                    while let byte = try await iterator.next() {
                        chunk.append(byte)
                        if chunk.count == 64 * 1024 { continuation.yield(chunk); chunk.removeAll(keepingCapacity: true) }
                    }
                    if !chunk.isEmpty { continuation.yield(chunk) }
                    continuation.finish()
                } catch { continuation.finish(throwing: error) }
            }
        }
        return WireResponse(status: response.statusCode, headers: response.allHeaderFields.reduce(into: [:]) { result, item in
            if let key = item.key as? String, let value = item.value as? String { result[key] = value }
        }, body: stream)
    }
}

private final class AlmiraNoRedirectDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

public struct RetryPolicy: Sendable {
    public let maxAttempts: Int
    public let baseDelay: Duration
    public let maximumDelay: Duration
    public init(maxAttempts: Int = 1, baseDelay: Duration = .milliseconds(100), maximumDelay: Duration = .seconds(5)) {
        self.maxAttempts = maxAttempts; self.baseDelay = baseDelay; self.maximumDelay = maximumDelay
    }
}

public actor AlmiraDataClient {
    private let baseURL: URL
    private let capability: @Sendable () async throws -> String
    private let origin: String?
    private let transport: any AlmiraTransport
    private let retry: RetryPolicy

    public init(baseURL: String, capability: @escaping @Sendable () async throws -> String, origin: String? = nil, transport: any AlmiraTransport = URLSessionTransport(), retry: RetryPolicy = RetryPolicy()) throws {
        self.baseURL = try Wire.baseURL(baseURL)
        if let origin { _ = try Wire.origin(origin) }
        guard (1...5).contains(retry.maxAttempts), retry.baseDelay >= .zero, retry.maximumDelay >= retry.baseDelay, retry.maximumDelay <= .seconds(60) else { throw Wire.input }
        self.capability = capability; self.origin = origin; self.transport = transport; self.retry = retry
    }

    public func listFilesWithCapability(_ reference: CollectionReference, filters: [String: String] = [:]) async throws -> JSONValue {
        try await json("GET", path: Wire.collection(reference, "/files") + Wire.query(filters), body: nil)
    }
    public func searchFilesWithCapability(_ reference: CollectionReference, request: JSONValue) async throws -> JSONValue {
        guard case .object = request else { throw Wire.input }
        return try await json("POST", path: Wire.collection(reference, "/search"), body: request)
    }
    public func getFileMetadataWithCapability(_ reference: FileReference) async throws -> JSONValue {
        try await json("GET", path: Wire.collection(reference, "/files/\(try Wire.uuid(reference.entryId))"), body: nil)
    }
    public func listDerivativesWithCapability(_ reference: GenerationReference) async throws -> JSONValue {
        try await json("GET", path: Wire.collection(reference, "/files/\(try Wire.uuid(reference.entryId))/versions/\(try Wire.uuid(reference.generationId))/derivatives"), body: nil)
    }
    public func readImmutableGeneration(_ reference: GenerationReference, range: String? = nil, ifNoneMatch: String? = nil) async throws -> BinaryResponse {
        try await binary("/v1/delivery/\(try Wire.scope(reference))/\(try Wire.uuid(reference.entryId))/\(try Wire.uuid(reference.generationId))", range: range, ifNoneMatch: ifNoneMatch, share: false)
    }
    public func readDerivative(_ reference: DerivativeReference, range: String? = nil, ifNoneMatch: String? = nil) async throws -> BinaryResponse {
        try await binary("/v1/delivery/\(try Wire.scope(reference))/\(try Wire.uuid(reference.entryId))/\(try Wire.uuid(reference.generationId))/variants/\(try Wire.variant(reference.variantKey))", range: range, ifNoneMatch: ifNoneMatch, share: false)
    }
    public func readShare(_ shareToken: String, range: String? = nil, ifNoneMatch: String? = nil) async throws -> BinaryResponse {
        guard shareToken.range(of: "^alm_share_v1\\.[A-Za-z0-9_-]{43,4096}$", options: .regularExpression) != nil else { throw Wire.input }
        return try await binary("/v1/shares/\(Wire.encode(shareToken))", range: range, ifNoneMatch: ifNoneMatch, share: true)
    }

    private func json(_ method: String, path: String, body: JSONValue?) async throws -> JSONValue {
        let response = try await send(method, path: path, body: body, share: false, range: nil, ifNoneMatch: nil)
        guard (200..<300).contains(response.status), response.headers["content-type"]?.split(separator: ";").first == "application/json" else {
            if !(200..<300).contains(response.status) { throw try await Wire.apiError(response) }
            throw Wire.response
        }
        return try JSONDecoder().decode(JSONValue.self, from: await Wire.collect(response.body, limit: 2 * 1024 * 1024))
    }

    private func binary(_ path: String, range: String?, ifNoneMatch: String?, share: Bool) async throws -> BinaryResponse {
        if let range, range.count > 64 || range.range(of: "^bytes=[0-9]+-[0-9]*$", options: .regularExpression) == nil { throw Wire.input }
        if let ifNoneMatch, ifNoneMatch.isEmpty || ifNoneMatch.count > 512 || ifNoneMatch.contains("\r") || ifNoneMatch.contains("\n") { throw Wire.input }
        let response = try await send("GET", path: path, body: nil, share: share, range: range, ifNoneMatch: ifNoneMatch)
        guard [200, 206, 304].contains(response.status) else { throw try await Wire.apiError(response) }
        return BinaryResponse(status: response.status, headers: response.headers, body: response.body)
    }

    private func send(_ method: String, path: String, body: JSONValue?, share: Bool, range: String?, ifNoneMatch: String?) async throws -> WireResponse {
        for attempt in 1...retry.maxAttempts {
            var request = URLRequest(url: baseURL.appending(path: path.drop(while: { $0 == "/" })))
            request.httpMethod = method; request.setValue(body == nil ? "*/*" : "application/json", forHTTPHeaderField: "Accept")
            if !share {
                let token: String
                do { token = try await capability() } catch { throw AlmiraClientError("ALMIRA_CLIENT_CREDENTIAL_UNAVAILABLE") }
                guard token.range(of: "^(?:alm_cap_v1|alm_local_v1)\\.[A-Za-z0-9_-]{43,4096}$", options: .regularExpression) != nil else { throw Wire.input }
                request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
                if let origin { request.setValue(origin, forHTTPHeaderField: "Origin") }
            }
            if let range { request.setValue(range, forHTTPHeaderField: "Range") }
            if let ifNoneMatch { request.setValue(ifNoneMatch, forHTTPHeaderField: "If-None-Match") }
            if let body { request.httpBody = try JSONEncoder().encode(body); request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
            do {
                let response = try await transport.send(request)
                if ![429, 502, 503, 504].contains(response.status) || attempt == retry.maxAttempts { return response }
            } catch where attempt == retry.maxAttempts { throw AlmiraClientError("ALMIRA_CLIENT_NETWORK") }
            try await Task.sleep(for: min(retry.maximumDelay, retry.baseDelay * (1 << (attempt - 1))))
        }
        throw AlmiraClientError("ALMIRA_CLIENT_NETWORK")
    }
}

package enum Wire {
    package static let input = AlmiraClientError("ALMIRA_CLIENT_INPUT_INVALID")
    package static let response = AlmiraClientError("ALMIRA_CLIENT_RESPONSE_INVALID")
    package static func uuid(_ value: String) throws -> String {
        guard value.range(of: "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", options: .regularExpression) != nil else { throw input }
        return value
    }
    package static func baseURL(_ value: String) throws -> URL {
        guard let url = URL(string: value), ["http", "https"].contains(url.scheme), url.host != nil, url.user == nil, url.password == nil, url.query == nil, url.fragment == nil, url.path.isEmpty || url.path == "/" else { throw input }
        return URL(string: value.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/")!
    }
    package static func origin(_ value: String) throws -> String {
        guard !value.hasSuffix("/") else { throw input }
        _ = try baseURL(value)
        return value
    }
    package static func encode(_ value: String) -> String { value.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~")))! }
    package static func query(_ values: [String: String]) -> String { values.isEmpty ? "" : "?" + values.sorted(by: { $0.key < $1.key }).map { "\(encode($0.key))=\(encode($0.value))" }.joined(separator: "&") }
    package static func variant(_ value: String) throws -> String {
        let segments = value.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard !segments.isEmpty, value.count <= 160, segments.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." && $0.range(of: "^[A-Za-z0-9._~-]+$", options: .regularExpression) != nil }) else { throw input }
        return segments.map(encode).joined(separator: "/")
    }
    package static func scope(_ reference: CollectionReference) throws -> String { try "\(uuid(reference.tenantId))/\(uuid(reference.projectId))/\(uuid(reference.environmentId))/\(uuid(reference.collectionInstanceId))" }
    package static func scope(_ reference: FileReference) throws -> String { try "\(uuid(reference.tenantId))/\(uuid(reference.projectId))/\(uuid(reference.environmentId))/\(uuid(reference.collectionInstanceId))" }
    package static func scope(_ reference: GenerationReference) throws -> String { try "\(uuid(reference.tenantId))/\(uuid(reference.projectId))/\(uuid(reference.environmentId))/\(uuid(reference.collectionInstanceId))" }
    package static func scope(_ reference: DerivativeReference) throws -> String { try "\(uuid(reference.tenantId))/\(uuid(reference.projectId))/\(uuid(reference.environmentId))/\(uuid(reference.collectionInstanceId))" }
    package static func collection(_ reference: CollectionReference, _ suffix: String) throws -> String { try "/v1/data/\(scope(reference))\(suffix)" }
    package static func collection(_ reference: FileReference, _ suffix: String) throws -> String { try "/v1/data/\(scope(reference))\(suffix)" }
    package static func collection(_ reference: GenerationReference, _ suffix: String) throws -> String { try "/v1/data/\(scope(reference))\(suffix)" }
    package static func collect(_ stream: AsyncThrowingStream<Data, Error>, limit: Int) async throws -> Data {
        var result = Data()
        for try await chunk in stream { guard result.count + chunk.count <= limit else { throw response }; result.append(chunk) }
        return result
    }
    package static func apiError(_ responseValue: WireResponse) async throws -> AlmiraAPIError {
        let value = try JSONDecoder().decode(JSONValue.self, from: await collect(responseValue.body, limit: 64 * 1024))
        guard case let .object(object) = value, case let .string(code)? = object["code"], case let .string(requestId)? = object["request_id"], code.range(of: "^ALMIRA_[A-Z0-9_]{1,127}$", options: .regularExpression) != nil else { throw response }
        _ = try uuid(requestId)
        return AlmiraAPIError(code: code, requestId: requestId, status: responseValue.status, retryAfterSeconds: responseValue.headers["retry-after"].flatMap(Int.init))
    }
}
