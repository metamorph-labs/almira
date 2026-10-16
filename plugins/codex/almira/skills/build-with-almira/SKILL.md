---
name: build-with-almira
description: Configure, integrate, debug, or verify Almira file storage in an application using its MCP tools, CLI, and TypeScript SDK. Use when adding uploads, private reads, collections, browser origins, or baseline storage setup to a user's application.
---

# Build With Almira

Add storage to the user's application; do not treat Almira as an application builder, deployment system, or end-user product. The coding agent owns edits and its host owns approvals. Almira only authorizes each management request with the user's scoped Metamorph PAT or SAK.

## Set Up Resources

1. Inspect the application, its framework, and its existing authentication before changing code.
2. Select or create the shared Metamorph project with the host's Metamorph tooling. Do not fabricate a project ID. Almira consumes that project; it does not create a second project model.
3. Call `almira_project_bootstrap` for the selected project. This converges the managed `development` and `production` environments and is safe to retry with the same `operation_id` after an ambiguous outcome.
4. Call `almira_environment_list` and use the managed `development` environment unless the user explicitly requests another environment. A project may contain up to ten environments.
5. Call `almira_collection_list`. Reuse a suitable collection or call `almira_collection_create` with an explicit `malware_scan_required` choice. Never infer that scanning exists when it is not configured.
6. For browser-to-storage transfers, read the current policy with `almira_browser_origins_get`, preserve its revision, and replace it with `almira_browser_origins_replace`. Add only exact application origins.

Reuse the returned `operation_id` when retrying any mutation whose result was not received. Let the host request approval normally; do not introduce a second plan or approval protocol.

## Integrate The Application

Use `@metamorph-labs/almira-sdk` instead of hand-written HTTP calls. Instantiate `AlmiraClient`, create a transfer with `createUpload`, send bytes with `uploadDirect`, and commit the generation with `finalizeUpload`. Use `readPrivateFile` for authorized reads. Follow the SDK README and the Node upload example when available in the checked-out Almira repository.

Keep `ALMIRA_BASE_URL` and `METAMORPH_TOKEN` in the local environment. Never write a PAT, SAK, workload credential, one-use upload URL, or upload header into source, logs, prompts, or generated documentation. Deployed applications must use short-lived customer-workload evidence from Metamorph Identity, not a developer PAT or SAK.

Do not provision S3, GCS, or Azure credentials in application code. Almira owns provider placement, delivery, safety processing, metadata extraction, and CDN behavior behind its API.

## Verify The Journey

Write the application code and automated tests first. Then exercise the application-level upload and read journey, including a refused unauthorized request, an idempotent retry, and the configured malware-scan behavior. Resource creation alone is not success. Report exactly what was tested and any check that could not run; do not claim deployment or compliance certification.
