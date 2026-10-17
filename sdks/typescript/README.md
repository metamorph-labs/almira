# `@metamorph-labs/almira-sdk`

The official dependency-light TypeScript client for Almira's promoted public API contract. It
works in modern browsers and Node.js 20 or newer using the standard Fetch API.

```ts
import { AlmiraClient } from "@metamorph-labs/almira-sdk";

const almira = new AlmiraClient({
  baseUrl: "https://almira.example",
  credential: () => process.env.METAMORPH_TOKEN!,
});

const { environments } = await almira.listEnvironments({ tenantId, projectId });
const capabilities = await almira.getStorageCapabilities({
  tenantId,
  projectId,
  environmentId: environments[0].environment_id,
});

const collection = await almira.createCollection(
  { tenantId, projectId, environmentId: environments[0].environment_id },
  {
    collection_key: "assets",
    display_name: "Assets",
    malware_scan_required: true,
    storage_class: "normal",
  },
  { operationId },
);

const migration = await almira.startStorageMigration(
  {
    tenantId,
    projectId,
    environmentId: environments[0].environment_id,
    collectionInstanceId: collection.collection.collection_instance_id,
  },
  { target_storage_class: "express", expected_collection_revision: collection.collection.revision },
  { operationId: migrationOperationId },
);

const migrationStatus = await almira.getStorageMigration({
  tenantId,
  projectId,
  environmentId: environments[0].environment_id,
  collectionInstanceId: collection.collection.collection_instance_id,
  migrationId: migration.migration.migration_id,
});

const preview = await almira.createEnvironment(
  { tenantId, projectId },
  { environment_key: "preview-one", display_name: "Preview one" },
  { operationId },
);
```

Omit both `baseUrl` and `credential` in a browser product session; the client uses same-origin
`/v1/*` routes and the exact Metamorph product-session cookie. PATs (`mm_pat_v1.`), SAKs
(`mm_sak_v1.`), and short-lived workload evidence stay in memory and are resolved for each request
so callers can rotate them. Every request carries the tenant routing scope separately from the
project path. Mutation methods require an explicit UUIDv7 operation ID: retain and reuse it when
retrying an ambiguous outcome.

Projects start with protected `development` and `production` environments and may have up to ten
environments. Additional environments can be created, renamed and marked for deletion through the
same scoped client; deleting either protected default is refused.

`getStorageCapabilities` discovers the current FileService-backed AWS S3, Google Cloud Storage and
Azure Blob realizations available to an active environment in one Almira request. It returns only
opaque realization IDs and safe provider, location, health and `normal`/`express` capability
evidence—never provider coordinates or credentials.

`startStorageMigration` changes only the logical `normal`/`express` class. Almira chooses the
opaque compatible target and FileService owns inventory, copy, verification, cutover and cleanup.
Uploads to that collection pause while the receipt is non-terminal; reads remain bound to their
stored generations. Poll `getStorageMigration` to `succeeded` or `failed` and reuse the original
operation ID if the start outcome is ambiguous; the same operation exactly replays while the
collection reports `migrating`.

Direct transfer URLs and headers returned by `createUpload` are sensitive, one-use capabilities.
The SDK returns them only to the caller and never logs or persists them.

Files have stable entry identities and immutable generations. Use `createFileVersion` to add bytes
to an existing entry, `listFileGenerations` to inspect retained history, `renameFile` to move the
logical path without copying objects, and `restoreFileGeneration` to make a retained generation
current. File-entry responses return that exact `current_generation` separately from the newest
retained `latest_generation`, which can differ after a restore. `deleteFile` immediately refuses
reads and starts the server-defined recycle window;
management callers can use `listFiles({ includeDeleted: true })` and `restoreFile` before expiry.
Builder-subject listing never admits `includeDeleted`.

Every available generation receives safe technical extraction with immutable source-digest and
extractor provenance. Collection owners use `getCollectionExtraction` and
`replaceCollectionExtraction` to opt into content, OCR, transcription, and collection-level
vector indexing. Vector indexing requires content extraction and is never inferred. Customer tags and typed
scalar fields use `getEntryMetadata` and `replaceEntryMetadata`; `listFiles` accepts exact tag,
metadata, verified-media-type, size, time and extraction-state filters backed by authoritative
PostgreSQL state. `getGenerationExtraction` returns safe status only. Protected content is exposed
only through `getExtractedContent`, which maps to the distinct `extracted_content.read`
authorization operation.

Use `searchFiles` for lexical, semantic, or hybrid retrieval. Semantic and hybrid modes require the
collection's explicit vector opt-in. Lodestone supplies candidates, but every returned entry and
facet is revision-checked against current PostgreSQL lifecycle, safety, generation, metadata, and
authorization state. `AlmiraDataClient.searchFilesWithCapability` exposes the same behavior to a
builder application's authorized end user without accepting a management credential.

Use `getCollectionMedia` and `replaceCollectionMedia` for bounded collection-level image presets,
document previews and the optional `web_hls_v1` video profile. `listProcessingJobs`,
`retryProcessingJob`, and `cancelProcessingJob` expose durable asynchronous state with pinned
processor provenance. `listGenerationDerivatives` returns ready metadata for one immutable source;
the application-facing `AlmiraDataClient.listDerivativesWithCapability` and `readDerivative`
methods keep every derivative behind the same capability, safety and CDN gates as its source.
Variant keys are opaque Almira names, not provider paths or URLs.

Application backends can pass a normalized `subject` with `listFiles`, `getFileMetadata`, and
`readPrivateFile`; the SDK puts its canonical context on that same workload-authenticated call.
For browser and other end-user data paths, use the deliberately separate `AlmiraDataClient`. It
accepts only `alm_cap_v1` or `alm_local_v1` capabilities, never PATs, SAKs, workload sessions, or
product cookies. Browser runtimes supply `Origin`; non-browser runtimes pass the canonical origin
in the constructor. Public immutable generation reads and token-in-path share reads do not require
an extra Almira call, and share reads never forward a configured capability.

Access policies, simulations, CDN delivery configuration, revocable shares, and public-key-only
local issuer registration are all available through typed management methods. Local private keys
remain in the builder's KMS or hardware-backed signer; `getLocalIssuerSigningConfiguration`
returns only the revision-bound, non-secret inputs needed by a signer.

The SDK also exports `normalizeConfiguration`, `previewConfiguration`, and `applyConfiguration`
for the public `almira.yaml` v1 model. Preview performs reads only. Apply refuses conflicts before
mutation, preserves unlisted resources, checks advertised storage classes, starts governed
class-only migrations, applies explicit collection extraction/vector controls, and returns a
resumable receipt rooted in the caller-supplied operation ID. Optional `media` blocks converge
through the same collection media API.
