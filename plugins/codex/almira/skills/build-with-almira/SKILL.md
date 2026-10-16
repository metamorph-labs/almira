---
name: build-with-almira
description: Configure, integrate, debug, or verify Almira file storage in an application using its MCP tools, CLI, and TypeScript SDK. Use when adding uploads, private reads, collections, browser origins, or baseline storage setup to a user's application.
---

# Build With Almira

Add storage to the user's application; do not treat Almira as an application builder, deployment system, or end-user product. The coding agent owns edits and its host owns approvals. Almira only authorizes each management request with the user's scoped Metamorph PAT or SAK.

## Set Up Resources

1. Inspect the application, its framework, and its existing authentication before changing code.
2. Select or create the shared Metamorph project with the host's Metamorph tooling. Do not fabricate a project ID. Almira consumes that project; it does not create a second project model.
3. Retain the exact successful Tenancy `project.get` result from that creation or selection flow and pass it as `tenancy_project` to `almira_project_bootstrap`, together with `tenant_id` and `project_id`. Almira reauthorizes the snapshot, converges the managed `development` and `production` environments, and is safe to retry with the same `operation_id` after an ambiguous outcome.
4. Call `almira_environment_list` and use the managed `development` environment unless the user explicitly requests another environment. Use `almira_environment_create`, `almira_environment_update`, and `almira_environment_delete` for additional lifecycle needs. A project may contain up to ten environments; the managed `development` and `production` defaults cannot be deleted.
5. Call `almira_storage_capabilities_get` for the selected environment before choosing storage configuration. Treat realization IDs as opaque and select only the advertised `normal` or `express` classes; never request or place provider buckets, endpoints, or credentials in application configuration.
6. Call `almira_collection_list`. Reuse a suitable collection or call `almira_collection_create` with the selected advertised `storage_class` and an explicit `malware_scan_required` choice. Never infer that scanning exists when it is not configured.
7. For browser-to-storage transfers, read the current policy with `almira_browser_origins_get`, preserve its revision, and replace it with `almira_browser_origins_replace`. Add only exact application origins.

For repeatable setup, prefer a checked-in `almira.yaml` v1 document. Call `almira_configuration_preview` first, show its exact additive actions and conflicts through the host's normal approval UX, then call `almira_configuration_apply` with one retained root `operation_id`. Unlisted resources are preserved; do not describe apply as pruning or deployment.

Reuse the returned `operation_id` when retrying any mutation whose result was not received. Let the host request approval normally; do not introduce a second plan or approval protocol.

## Integrate The Application

Use `@metamorph-labs/almira-sdk` instead of hand-written HTTP calls. Instantiate `AlmiraClient`, create a transfer with `createUpload`, send bytes with `uploadDirect`, and commit the generation with `finalizeUpload`. Use `readPrivateFile` for authorized reads. Follow the SDK README and the Node upload example when available in the checked-out Almira repository.

Keep the Almira product origin in `ALMIRA_BASE_URL` (without a `/platform/almira` prefix) and an `mm_pat_v1.` PAT or `mm_sak_v1.` SAK in `METAMORPH_TOKEN`. Never write a PAT, SAK, workload credential, one-use upload URL, or upload header into source, logs, prompts, or generated documentation. Deployed applications must use short-lived customer-workload evidence from Metamorph Identity, not a developer PAT or SAK.

Do not provision S3, GCS, or Azure credentials in application code. Almira owns provider placement, delivery, safety processing, metadata extraction, and CDN behavior behind its API.

## Verify The Journey

Write the application code and automated tests first. Then exercise the application-level upload and read journey, including a refused unauthorized request, an idempotent retry, and the configured malware-scan behavior. Resource creation alone is not success. Report exactly what was tested and any check that could not run; do not claim deployment or compliance certification.
