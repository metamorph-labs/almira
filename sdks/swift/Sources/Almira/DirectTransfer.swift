import CryptoKit
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct AlmiraTransferError: Error, Equatable, Sendable {
    public let code: String
    public let partNumber: Int?
    public let status: Int?
    public init(_ code: String, partNumber: Int? = nil, status: Int? = nil) { self.code = code; self.partNumber = partNumber; self.status = status }
}

public struct DirectUploadResponse: Sendable {
    public let status: Int
    public let headers: [String: String]
    public init(status: Int, headers: [String: String]) { self.status = status; self.headers = headers }
}

public protocol DirectUploadTransport: Sendable {
    func put(part: JSONValue, source: URL) async throws -> DirectUploadResponse
}

public struct URLSessionDirectUploadTransport: DirectUploadTransport {
    public init() {}
    public func put(part: JSONValue, source: URL) async throws -> DirectUploadResponse {
        let object = try part.objectValue()
        guard let url = URL(string: try object.text("url")), url.scheme == "https", url.host != nil, url.user == nil, url.password == nil, url.fragment == nil else { throw Transfer.invalid }
        let offset = try object.integer("offset_bytes"); let length = try object.integer("length_bytes")
        let fileSize = try FileManager.default.attributesOfItem(atPath: source.path)[.size] as? NSNumber
        var uploadURL = source; var temporary: URL?
        if offset != 0 || fileSize?.int64Value != length {
            let candidate = FileManager.default.temporaryDirectory.appendingPathComponent("almira-\(UUID().uuidString)")
            FileManager.default.createFile(atPath: candidate.path, contents: nil)
            let input = try FileHandle(forReadingFrom: source); let output = try FileHandle(forWritingTo: candidate)
            defer { try? input.close(); try? output.close() }
            try input.seek(toOffset: UInt64(offset)); var remaining = length
            while remaining > 0 {
                let data = try input.read(upToCount: Int(min(64 * 1024, remaining))) ?? Data()
                guard !data.isEmpty else { throw Transfer.invalid }
                try output.write(contentsOf: data); remaining -= Int64(data.count)
            }
            uploadURL = candidate; temporary = candidate
        }
        defer { if let temporary { try? FileManager.default.removeItem(at: temporary) } }
        var request = URLRequest(url: url); request.httpMethod = "PUT"; request.setValue(String(length), forHTTPHeaderField: "Content-Length")
        for header in try object.array("headers") { let value = try header.objectValue(); request.setValue(try value.text("value"), forHTTPHeaderField: try value.text("name")) }
        let delegate = NoRedirectDelegate(); let session = URLSession(configuration: .ephemeral, delegate: delegate, delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (_, response) = try await session.upload(for: request, fromFile: uploadURL)
        guard let http = response as? HTTPURLResponse else { throw AlmiraTransferError("ALMIRA_TRANSFER_RESPONSE_INVALID") }
        let headers = http.allHeaderFields.reduce(into: [String: String]()) { result, item in if let name = item.key as? String, let value = item.value as? String { result[name.lowercased()] = value } }
        return DirectUploadResponse(status: http.statusCode, headers: headers)
    }
}

public typealias MultipartPartGrant = @Sendable (JSONValue) async throws -> JSONValue

public func uploadDirect(
    descriptor: JSONValue,
    source: URL,
    grantPart: MultipartPartGrant? = nil,
    transport: any DirectUploadTransport = URLSessionDirectUploadTransport(),
    now: @Sendable () -> Date = Date.init
) async throws -> JSONValue {
    do {
        let object = try descriptor.objectValue(); let descriptorId = try Wire.uuid(object.text("descriptor_id")); let protocolName = try object.text("protocol")
        guard ["single_put", "multipart"].contains(protocolName), object["one_use"] == .bool(true) else { throw Transfer.invalid }
        let expectedSize = try object.integer("expected_size_bytes"); let size = (try FileManager.default.attributesOfItem(atPath: source.path)[.size] as? NSNumber)?.int64Value
        let digest = try object.text("content_sha256")
        guard (1...10_737_418_240).contains(expectedSize), size == expectedSize, digest.range(of: "^sha256:[0-9a-f]{64}$", options: .regularExpression) != nil else { throw Transfer.invalid }
        let expiryFormatter = ISO8601DateFormatter(); expiryFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let expiresAt = expiryFormatter.date(from: try object.text("expires_at")) else { throw Transfer.invalid }
        guard expiresAt > now() else { throw AlmiraTransferError("ALMIRA_TRANSFER_DESCRIPTOR_EXPIRED") }
        let requests = try object.array("requests")
        let partCount = Int(try object.integer("part_count")); guard (1...10_000).contains(partCount) else { throw Transfer.invalid }
        let partSize: Int64
        if protocolName == "single_put" {
            guard requests.count == 1, try object.optionalInteger("part_size_bytes") == nil, partCount == 1 else { throw Transfer.invalid }
            partSize = expectedSize
        } else {
            guard requests.isEmpty, let multipartSize = try object.optionalInteger("part_size_bytes"), multipartSize > 0 else { throw Transfer.invalid }
            let (lower, lowerOverflow) = multipartSize.multipliedReportingOverflow(by: Int64(partCount - 1))
            let (upper, upperOverflow) = multipartSize.multipliedReportingOverflow(by: Int64(partCount))
            guard !lowerOverflow, !upperOverflow, lower < expectedSize, upper >= expectedSize else { throw Transfer.invalid }
            partSize = multipartSize
        }
        var completions: [JSONValue] = []; var objectETag: String?; var providerVersion: String?
        for number in 1...partCount {
            let offset = Int64(number - 1) * partSize; let length = min(partSize, expectedSize - offset); guard length > 0 else { throw Transfer.invalid }
            let part: JSONValue
            if protocolName == "single_put" {
                part = requests[0]
            } else {
                guard let grantPart else { throw Transfer.invalid }
                part = try await grantPart(.object(["part_number": .number(Double(number)), "content_sha256": .string(try hashPart(source, offset: offset, length: length))]))
            }
            let partObject = try part.objectValue()
            try validatePart(partObject, number: number, offset: offset, length: length)
            guard expiresAt > now() else { throw AlmiraTransferError("ALMIRA_TRANSFER_DESCRIPTOR_EXPIRED") }
            let response: DirectUploadResponse
            do { response = try await transport.put(part: part, source: source) }
            catch let error as AlmiraTransferError { throw error }
            catch { throw AlmiraTransferError("ALMIRA_TRANSFER_OUTCOME_UNKNOWN", partNumber: number) }
            guard (100...599).contains(response.status) else { throw AlmiraTransferError("ALMIRA_TRANSFER_RESPONSE_INVALID", partNumber: number) }
            guard (200..<300).contains(response.status) else { throw AlmiraTransferError("ALMIRA_TRANSFER_PART_REFUSED", partNumber: number, status: response.status) }
            var headers: [String: String] = [:]
            for (name, value) in response.headers {
                guard headers.updateValue(value, forKey: name.lowercased()) == nil else { throw AlmiraTransferError("ALMIRA_TRANSFER_RESPONSE_INVALID", partNumber: number) }
            }
            guard let etag = headers["etag"], etag.range(of: "^[!-~]{1,256}$", options: .regularExpression) != nil else { throw AlmiraTransferError("ALMIRA_TRANSFER_RESPONSE_INVALID", partNumber: number) }
            completions.append(.object(["part_number": .number(Double(number)), "etag": .string(etag)]))
            if protocolName == "single_put" {
                objectETag = etag
                for name in ["x-amz-version-id", "x-goog-generation", "x-ms-version-id"] {
                    guard let version = headers[name] else { continue }
                    guard version.range(of: "^[!-~]{1,256}$", options: .regularExpression) != nil, version.rangeOfCharacter(from: CharacterSet(charactersIn: "/\\?#")) == nil, providerVersion == nil || providerVersion == version else { throw AlmiraTransferError("ALMIRA_TRANSFER_RESPONSE_INVALID", partNumber: number) }
                    providerVersion = version
                }
            }
        }
        return .object(["descriptor_id": .string(descriptorId), "protocol": .string(protocolName), "etag": objectETag.map(JSONValue.string) ?? .null, "provider_version": providerVersion.map(JSONValue.string) ?? .null, "parts": .array(completions), "size_bytes": .number(Double(expectedSize)), "content_sha256": .string(digest)])
    } catch let error as AlmiraTransferError { throw error }
    catch { throw Transfer.invalid }
}

private func validatePart(_ part: [String: JSONValue], number: Int, offset: Int64, length: Int64) throws {
    guard try part.integer("part_number") == number,
          try part.integer("offset_bytes") == offset,
          try part.integer("length_bytes") == length,
          try part.text("method") == "PUT",
          part["one_use"] == .bool(true) else { throw Transfer.invalid }
    let encodedURL = try part.text("url")
    guard encodedURL.utf8.count <= 8192,
          !encodedURL.unicodeScalars.contains(where: { $0.value <= 32 || $0.value == 127 || $0 == "\\" }),
          let url = URL(string: encodedURL), url.scheme == "https", url.host != nil, url.user == nil, url.password == nil, url.fragment == nil else { throw Transfer.invalid }
    let headers = try part.array("headers"); guard headers.count <= 32 else { throw Transfer.invalid }
    var names = Set<String>()
    for header in headers {
        let value = try header.objectValue(); let name = try value.text("name"); let headerValue = try value.text("value")
        guard name.range(of: "^[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil,
              (1...4096).contains(headerValue.utf8.count),
              !headerValue.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains),
              names.insert(name).inserted else { throw Transfer.invalid }
    }
}

private func hashPart(_ source: URL, offset: Int64, length: Int64) throws -> String {
    let input = try FileHandle(forReadingFrom: source); defer { try? input.close() }; try input.seek(toOffset: UInt64(offset)); var hasher = SHA256(); var remaining = length
    while remaining > 0 { let data = try input.read(upToCount: Int(min(64 * 1024, remaining))) ?? Data(); guard !data.isEmpty else { throw Transfer.invalid }; hasher.update(data: data); remaining -= Int64(data.count) }
    return "sha256:" + hasher.finalize().map { String(format: "%02x", $0) }.joined()
}

private final class NoRedirectDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

private enum Transfer { static let invalid = AlmiraTransferError("ALMIRA_TRANSFER_DESCRIPTOR_INVALID") }

private extension Dictionary where Key == String, Value == JSONValue {
    func text(_ name: String) throws -> String { guard case let .string(value)? = self[name] else { throw Transfer.invalid }; return value }
    func integer(_ name: String) throws -> Int64 { guard case let .number(value)? = self[name], value >= 0, value.rounded() == value, value <= Double(Int64.max) else { throw Transfer.invalid }; return Int64(value) }
    func optionalInteger(_ name: String) throws -> Int64? { guard let value = self[name], value != .null else { return nil }; guard case let .number(number) = value, number >= 0, number.rounded() == number, number <= Double(Int64.max) else { throw Transfer.invalid }; return Int64(number) }
    func array(_ name: String) throws -> [JSONValue] { guard case let .array(value)? = self[name] else { throw Transfer.invalid }; return value }
}

private extension JSONValue {
    func objectValue() throws -> [String: JSONValue] { guard case let .object(value) = self else { throw Transfer.invalid }; return value }
}
