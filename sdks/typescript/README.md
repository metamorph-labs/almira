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

The SDK also exports `normalizeConfiguration`, `previewConfiguration`, and `applyConfiguration`
for the public `almira.yaml` v1 model. Preview performs reads only. Apply refuses conflicts before
mutation, preserves unlisted resources, checks advertised storage classes, starts governed
class-only migrations, and returns a resumable receipt rooted in the caller-supplied operation ID.
