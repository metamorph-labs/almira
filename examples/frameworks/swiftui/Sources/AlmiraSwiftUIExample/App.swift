import Almira
import SwiftUI

@main
struct AlmiraSwiftUIExample: App {
    var body: some Scene { WindowGroup { FileView() } }
}

struct FileView: View {
    @State private var state = "Loading…"

    var body: some View {
        VStack(spacing: 12) {
            Text("Almira managed-development read").font(.headline)
            Text(state).textSelection(.enabled)
            Button("Refresh") { Task { await load() } }
        }
        .padding(24)
        .task { await load() }
    }

    @MainActor
    private func load() async {
        do {
            let client = try AlmiraDataClient(
                baseURL: required("ALMIRA_BASE_URL"),
                capability: { required("ALMIRA_CAPABILITY") },
                retry: RetryPolicy(maxAttempts: 3, baseDelay: .milliseconds(100), maximumDelay: .seconds(2))
            )
            let value = try await client.getFileMetadataWithCapability(FileReference(
                tenantId: required("ALMIRA_TENANT_ID"), projectId: required("ALMIRA_PROJECT_ID"),
                environmentId: required("ALMIRA_ENVIRONMENT_ID"), collectionInstanceId: required("ALMIRA_COLLECTION_ID"),
                entryId: required("ALMIRA_ENTRY_ID")
            ))
            guard case let .object(entry) = value,
                  case let .string(path)? = entry["logical_path"],
                  case let .string(lifecycle)? = entry["lifecycle"] else { throw AlmiraClientError("ALMIRA_CLIENT_RESPONSE_INVALID") }
            state = "\(path) — \(lifecycle)"
        } catch {
            state = "Read refused: \(error)"
        }
    }
}

private func required(_ name: String) -> String {
    guard let value = ProcessInfo.processInfo.environment[name], !value.isEmpty else { fatalError("\(name) is required") }
    return value
}
