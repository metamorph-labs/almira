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
const expressRealization = capabilities.realizations.find(
  ({ storage_class }) => storage_class === "express",
);
if (expressRealization === undefined) throw new Error("express storage is unavailable");

const enrolled = await almira.createStorageEnrollment(
  { tenantId, projectId },
  {
    binding_label: "customer-media",
    storage_class: "normal",
    provider_configuration: {
      provider: "aws_s3",
      partition: "aws",
      account_id: "123456789012",
      region: "us-east-1",
      bucket: "customer-media-prod",
      expected_bucket_owner: "123456789012",
      role_arn: "arn:aws:iam::123456789012:role/almira-fileservice",
      encryption: "aws_sse_kms",
      encryption_key: "arn:aws:kms:us-east-1:123456789012:key/example",
    },
  },
  { operationId: enrollmentOperationId },
);

// After getStorageEnrollment reports this normal enrollment as active, an empty production or
// additional environment can adopt it explicitly. Development always remains managed.
const production = environments.find(({ environment_key }) => environment_key === "production")!;
const adopted = await almira.adoptCustomerStorage(
  { tenantId, projectId, environmentId: production.environment_id },
  {
    enrollment_operation_id: enrolled.enrollment.operation_id,
    expected_revision: production.revision,
  },
  { operationId: adoptionOperationId },
);

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
  {
    target_storage_class: "express",
    target_realization_generation: expressRealization.realization_generation,
    expected_collection_revision: collection.collection.revision,
  },
  { operationId: migrationOperationId },
);

const migrationStatus = await almira.getStorageMigration({
  tenantId,
  projectId,
  environmentId: environments[0].environment_id,
  collectionInstanceId: collection.collection.collection_instance_id,
  migrationId: migration.migration.migration_id,
});

const exported = await almira.startCollectionExport(
  {
    tenantId,
    projectId,
    environmentId: environments[0].environment_id,
    collectionInstanceId: collection.collection.collection_instance_id,
  },
  { expected_collection_revision: collection.collection.revision },
  { operationId: exportOperationId },
);

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

`createStorageEnrollment` starts durable FileService proof for a customer-owned S3, GCS, or Azure
Blob target. Supply only provider coordinates and its workload-federation identity; static cloud
keys and secrets are outside the contract and are rejected. Use `listStorageEnrollments` after a
reload and `getStorageEnrollment` with the original operation ID to reconcile proof, health, and
opaque realization state. Provider coordinates are used only for the owner call and are not
returned or persisted in Almira's enrollment ledger.

`adoptCustomerStorage` switches one empty managed environment to hosted customer-owned storage
only after the selected `normal` enrollment is active and matches a fresh authenticated
FileService catalog. The protected development environment stays managed, and an environment with
collections is refused until the separate governed migration is available. Reusing the operation
ID after a completed request returns the durable receipt without another owner read.

`startStorageMigration` changes the logical `normal`/`express` class and binds the exact opaque
realization generation selected from the fresh capability catalog or an active enrollment receipt.
FileService owns inventory, copy, verification, cutover and cleanup.
Uploads to that collection pause while the receipt is non-terminal; reads remain bound to their
stored generations. Poll `getStorageMigration` to `succeeded` or `failed` and reuse the original
operation ID if the start outcome is ambiguous; the same operation exactly replays while the
collection reports `migrating`.

Direct transfer URLs and headers are sensitive, one-use capabilities. A single-put descriptor
contains its only request. A multipart descriptor contains only bounded part geometry;
`uploadDirect` hashes each exact slice and invokes its `createPart` callback to obtain a fresh
checksum-bound request through `createUploadPart`. The SDK never logs or persists those grants and
never forwards an Almira credential to the object provider.

Application data reads and read-only search can opt into bounded retries with `retry` on
`AlmiraDataClient`. Retries are off by default, honor a bounded numeric `Retry-After`, cover only
network failures and 429/502/503/504 responses, and resolve the capability provider again for every
attempt. A response body already returned to the caller is never replayed mid-stream.

On the builder backend, `createCapabilityDataClient` exchanges the current `workloadSession` for
one audience- and resource-bounded capability session and returns a ready capability-only data
client. The workload evidence is never copied into that client, and the sensitive grant remains an
in-memory return value for the builder to deliver through its own authenticated application flow.

After a bounded canary upload (at most 8 MiB), retain its transfer ID, completion evidence and
finalize operation ID and call `createVerificationReceipt` with a distinct environment as the
refusal target. Almira replays finalization, hashes the exact private read, requires the
cross-environment refusal and checks the configured malware gate before issuing an Ed25519-signed
receipt. `verifyReceiptWithClient` fetches the public key set without credentials and verifies both
the signature and an explicit expected resource binding. Never treat a valid receipt for another
resource as proof for the current journey.

`startCollectionImport` accepts only a FileService-issued opaque source binding and a bounded safe
manifest; it does not accept source credentials or provider coordinates. `startCollectionExport`,
`listPortabilityJobs`, and `getPortabilityJob` expose durable transfer and verification progress.
A succeeded export can issue a fresh one-use instruction through
`createPortabilityExportDownload`. Pass that descriptor directly to `openPortableExport`, stream
the returned body, and accept the local artifact only after its exact byte count and SHA-256 match
the returned expectations. The helper never sends the Almira credential to the object endpoint
and never includes its bearer URL or signed headers in an error.

Files have stable entry identities and immutable generations. Use `createFileVersion` to add bytes
to an existing entry, `listFileGenerations` to inspect retained history, `renameFile` to move the
logical path without copying objects, and `restoreFileGeneration` to make a retained generation
current. File-entry responses return that exact `current_generation` separately from the newest
retained `latest_generation`, which can differ after a restore. `deleteFile` immediately refuses
reads and starts the server-defined recycle window;
management callers can use `listFiles({ includeDeleted: true })` and `restoreFile` before expiry.
Builder-subject listing never admits `includeDeleted`.
Use `replaceCollectionLifecycle` to set the collection's 1–3650 day recycle window (30 days by
default). The new setting applies to later deletions only; each already-deleted entry keeps its
captured deadline, and expired entries are neither listed nor restorable.
Use `mutateFilesBatch` when up to 100 independent lifecycle changes must commit or roll back as one
collection-local operation. Each entry may occur once and results preserve request order.
Use `copyFile` with an exact source entry, immutable generation, optimistic source revision and new
collection-local logical path. Almira asks FileService to create a distinct server-side object,
copies the entry's customer metadata snapshot, and applies the collection's current malware policy;
the SDK never downloads or re-uploads the bytes.

Collection malware policy is managed with `getCollectionProtection` and
`replaceCollectionProtection`. A policy replacement applies only to generations created after
the change; it never relabels historical bytes. `listProtectionCases` returns bounded,
environment-wide safe status and scanner provenance. `requestProtectionRescan` targets one exact
generation and immediately removes it from delivery until FileService returns a clean verdict.
`createProtectionReview` records only `confirmed_blocked` or `suspected_false_positive` with a
bounded, content-free reason. Reviews are audit records: they never release content, change the
FileService verdict, or bypass quarantine, and the API deliberately exposes no release method.

Every available generation receives safe technical extraction with immutable source-digest and
extractor provenance. Collection owners use `getCollectionExtraction` and
`replaceCollectionExtraction` to opt into content, OCR, transcription, and collection-level
vector indexing. Vector indexing requires content extraction and is never inferred. Customer tags and typed
scalar fields use `getEntryMetadata` and `replaceEntryMetadata`; `listFiles` accepts exact tag,
metadata, verified-media-type, size, time and extraction-state filters backed by authoritative
PostgreSQL state. `getGenerationExtraction` returns safe status only. Protected content is exposed
only through `getExtractedContent`, which maps to the distinct `extracted_content.read`
authorization operation.

Use `verifyWebhookSignature` at an application webhook endpoint before parsing JSON. Pass the exact
raw request bytes, the APP-01 signing secret and the five `Metamorph-Webhook-*` headers. The helper
checks the common HMAC-SHA256 transcript, UUIDv7 identifiers, attempt bound and five-minute clock
window and returns verified delivery metadata. Store `(deliveryId, attempt)` durably to reject
replays. Verification authenticates APP-01 delivery; it does not authorize file access or make the
payload trusted application input.

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
Use `bindSubject` to persist a namespaced opaque builder-user-to-file lifecycle association and
`listSubjectBindings` to discover retained files for that subject across the project. These
workload-only operations support the builder's privacy workflows; the subject remains lifecycle
metadata and never becomes an Almira authorization identity. Use
`startSubjectLifecycleOperation` for `restrict`, `export`, or `delete`, then page its exact durable
manifest with `readSubjectLifecycleOperation`. Export packaging, shared files and retention
windows remain explicitly pending until their owner work is durably complete; provider URLs never
appear.
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
through the same collection media API. `recycle_retention_days` defaults to 30 and converges
through the lifecycle API. An explicit `malware_scan_required` change converges through the
collection protection API in the same revision-safe lifecycle → protection → extraction → media →
storage-class sequence.
