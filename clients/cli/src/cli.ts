import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { link, readFile, unlink } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parse as parseYaml } from "yaml";

import {
  AlmiraApiError,
  AlmiraClient,
  AlmiraClientError,
  AlmiraConfigurationError,
  AlmiraTransferError,
  applyConfiguration,
  createOperationId,
  openPortableExport,
  previewConfiguration,
  type AccessSimulation,
  type CreateShareRequest,
  type CreateProtectionReviewRequest,
  type FileBatchRequest,
  type CopyFileRequest,
  type RegisterLocalIssuerRequest,
  type ReplaceAccessPolicyRequest,
  type ReplaceCollectionExtractionRequest,
  type ReplaceCollectionMediaRequest,
  type ReplaceDeliveryConfigRequest,
  type ReplaceEntryMetadataRequest,
  type RotateLocalIssuerKeyRequest,
  type SearchInput,
  type StartCollectionImportRequest,
  type PortableExportStream,
  type TenancyProjectGetResponse,
} from "@metamorph-labs/almira-sdk";

export interface CliEnvironment {
  ALMIRA_BASE_URL?: string;
  METAMORPH_TOKEN?: string;
}

export interface CliIo {
  stderr: { write(value: string): unknown };
  stdout: { write(value: string): unknown };
}

export interface CliDependencies {
  environment: CliEnvironment;
  fetch?: typeof globalThis.fetch;
  io: CliIo;
}

type Values = Record<string, boolean | string | string[] | undefined>;

const HELP = `Usage: almira <noun> <verb> [options]

Commands:
  project bootstrap       Converge the Almira project and default environments
  environment list       List all project environments
  environment create     Create an additional managed environment
  environment update     Rename an environment
  environment delete     Mark an additional environment for deletion
  origin get              Read an environment's browser-origin policy
  origin set              Replace an environment's browser-origin policy
  storage capabilities    Discover storage realizations available to an environment
  config preview          Preview additive almira.yaml changes
  config apply            Apply an almira.yaml configuration
  collection list         List collections in an environment
  collection create       Create a private normal or express collection
  collection get          Read one collection
  collection migrate      Migrate a collection to another storage class
  migration get           Read durable storage-migration progress
  import start            Start an import from a FileService-issued source manifest
  export start            Build a retained-generation portable export
  export download         Stream and verify a completed export to --output
  portability list        List collection import and export jobs
  portability get         Read one import or export job
  extraction get          Read collection extraction controls
  extraction set          Replace collection extraction controls from --input JSON
  extraction status       Read safe exact-generation extraction status
  extraction content      Read separately protected extracted content
  media get               Read collection image/document/video processing controls
  media set               Replace collection media controls from --input JSON
  protection get          Read future-generation malware scanning policy
  protection set          Require or disable scanning for future generations
  scan list               List environment-wide scan-gated generations
  scan rescan             Queue an exact-generation FileService rescan
  scan review             Record a content-free review from --input JSON
  job list                List collection media-processing jobs
  job retry               Retry a failed or cancelled media-processing job
  job cancel              Cancel pending media-processing work
  derivative list         List ready derivatives for one immutable generation
  file list               List and filter authoritative file metadata
  file search             Search current files with lexical, semantic, or hybrid retrieval
  file get                Read one file's metadata
  file batch              Apply an atomic lifecycle batch from --input JSON
  file copy               Copy an exact generation with --entry --generation --path --revision
  metadata get            Read bounded customer metadata for one file
  metadata set            Replace bounded customer metadata from --input JSON
  file versions           List immutable generations
  file rename             Rename or move a stable file identity
  file select-version     Make one retained generation current
  file delete             Move one file into its recycle window
  file restore            Restore one file from its recycle window
  policy get              Read a collection access policy
  policy set              Replace a collection access policy from --input JSON
  policy simulate         Evaluate an access decision from --input JSON
  delivery get            Read a collection CDN/delivery configuration
  delivery set            Replace CDN/delivery configuration from --input JSON
  share create            Create a revocable share from --input JSON
  share revoke            Revoke a share
  issuer list             List registered local capability issuers
  issuer register         Register an issuer from --input JSON
  issuer rotate           Rotate an issuer key from --input JSON
  issuer revoke           Revoke an issuer
  issuer signing-config   Read public local-signing configuration

Connection:
  --base-url URL          Almira API base; or set ALMIRA_BASE_URL
  METAMORPH_TOKEN         PAT or SAK, read only from the environment

Common identifiers:
  --tenant UUID           Metamorph tenant UUIDv7
  --project UUID          Metamorph project UUIDv7
  --environment UUID      Almira environment UUIDv7
  --collection UUID       Almira collection-instance UUIDv7
  --migration UUID        Almira storage-migration UUIDv7
  --portability-job UUID  Almira import/export job UUIDv7
  --entry UUID            Almira file-entry UUIDv7
  --generation UUID       Almira immutable generation UUIDv7
  --kind KIND             technical, content, ocr, or transcription
  --share UUID            Almira share UUIDv7
  --issuer UUID           Almira local-issuer UUIDv7
  --job UUID              Almira media-processing job UUIDv7
  --input PATH            Exact JSON request body for structured operations
  --output PATH           New local file for a verified portable export
  --path PATH             Canonical logical file path
  --include-deleted       Include entries still inside their recycle window
  --file PATH             almira.yaml path for config preview/apply

Collection creation:
  --class CLASS           normal (default) or express
  --scan POLICY           required or optional

Mutations accept --operation-id UUID. If omitted, the CLI creates one and includes it in output.
Project bootstrap also requires --tenancy-project FILE containing the exact project.get response.
All stdout is JSON. Diagnostics are stable JSON on stderr; credentials are never accepted as flags.
`;

const options = {
  "base-url": { type: "string" },
  class: { type: "string" },
  collection: { type: "string" },
  cursor: { type: "string" },
  display: { type: "string" },
  entry: { type: "string" },
  environment: { type: "string" },
  file: { type: "string" },
  generation: { type: "string" },
  help: { type: "boolean", short: "h" },
  input: { type: "string" },
  "include-deleted": { type: "boolean" },
  issuer: { type: "string" },
  job: { type: "string" },
  key: { type: "string" },
  kind: { type: "string" },
  limit: { type: "string" },
  mode: { type: "string" },
  facet: { type: "string", multiple: true },
  "page-size": { type: "string" },
  query: { type: "string" },
  "maximum-size": { type: "string" },
  "metadata-key": { type: "string" },
  "metadata-value": { type: "string" },
  "media-type": { type: "string" },
  "minimum-size": { type: "string" },
  migration: { type: "string" },
  output: { type: "string" },
  "operation-id": { type: "string" },
  origin: { type: "string", multiple: true },
  "path-prefix": { type: "string" },
  path: { type: "string" },
  project: { type: "string" },
  "portability-job": { type: "string" },
  revision: { type: "string" },
  scan: { type: "string" },
  state: { type: "string" },
  "created-after": { type: "string" },
  "created-before": { type: "string" },
  "extraction-kind": { type: "string" },
  "extraction-state": { type: "string" },
  share: { type: "string" },
  tag: { type: "string" },
  tenant: { type: "string" },
  "tenancy-project": { type: "string" },
} as const;

/** Runs one CLI invocation and returns its stable process exit code. */
export async function runCli(arguments_: string[], dependencies: CliDependencies): Promise<number> {
  let operationId: string | null = null;
  try {
    const parsed = parseArgs({ args: arguments_, allowPositionals: true, options, strict: true });
    if (parsed.values.help === true || parsed.positionals.length === 0) {
      dependencies.io.stdout.write(HELP);
      return 0;
    }
    if (parsed.positionals.length !== 2) throw new CliUsageError();
    const values = parsed.values as Values;
    const [noun, verb] = parsed.positionals;
    assertCommandOptions(noun, verb, values);
    const baseUrl = stringValue(values, "base-url") ?? dependencies.environment.ALMIRA_BASE_URL;
    const credential = dependencies.environment.METAMORPH_TOKEN;
    if (baseUrl === undefined) throw new CliConfigError("ALMIRA_CLI_BASE_URL_REQUIRED");
    if (credential === undefined || credential.length === 0) {
      throw new CliConfigError("ALMIRA_CLI_TOKEN_REQUIRED");
    }
    const client = new AlmiraClient({
      baseUrl,
      credential,
      ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
    });
    const projectId = required(values, "project");
    const tenantId = required(values, "tenant");
    const reference = { tenantId, projectId };
    let result: unknown;
    let mutation = false;

    if (noun === "project" && verb === "bootstrap") {
      operationId = mutationId(values);
      mutation = true;
      const tenancyProject = await readTenancyProject(required(values, "tenancy-project"));
      result = await client.bootstrapProject(reference, { tenancy_project: tenancyProject }, { operationId });
    } else if (noun === "environment" && verb === "list") {
      result = await client.listEnvironments(reference);
    } else if (noun === "environment" && verb === "create") {
      operationId = mutationId(values);
      mutation = true;
      result = await client.createEnvironment(
        reference,
        { environment_key: required(values, "key"), display_name: required(values, "display") },
        { operationId },
      );
    } else if (noun === "environment" && verb === "update") {
      operationId = mutationId(values);
      mutation = true;
      result = await client.updateEnvironment(
        { ...reference, environmentId: required(values, "environment") },
        { display_name: required(values, "display"), expected_revision: positiveInteger(values, "revision") },
        { operationId },
      );
    } else if (noun === "environment" && verb === "delete") {
      operationId = mutationId(values);
      mutation = true;
      result = await client.deleteEnvironment(
        { ...reference, environmentId: required(values, "environment") },
        positiveInteger(values, "revision"),
        { operationId },
      );
    } else if (noun === "origin" && verb === "get") {
      result = await client.getBrowserOrigins({ ...reference, environmentId: required(values, "environment") });
    } else if (noun === "origin" && verb === "set") {
      operationId = mutationId(values);
      mutation = true;
      result = await client.replaceBrowserOrigins(
        { ...reference, environmentId: required(values, "environment") },
        {
          expected_revision: positiveInteger(values, "revision"),
          origins: stringValues(values, "origin"),
        },
        { operationId },
      );
    } else if (noun === "storage" && verb === "capabilities") {
      result = await client.getStorageCapabilities({
        ...reference,
        environmentId: required(values, "environment"),
      });
    } else if (noun === "config" && verb === "preview") {
      result = await previewConfiguration(client, reference, await readConfiguration(required(values, "file")));
    } else if (noun === "config" && verb === "apply") {
      operationId = mutationId(values);
      mutation = true;
      result = await applyConfiguration(
        client,
        reference,
        await readConfiguration(required(values, "file")),
        { operationId },
      );
    } else if (noun === "collection" && verb === "list") {
      result = await client.listCollections(
        { ...reference, environmentId: required(values, "environment") },
        page(values),
      );
    } else if (noun === "collection" && verb === "create") {
      operationId = mutationId(values);
      mutation = true;
      const scan = required(values, "scan");
      if (scan !== "required" && scan !== "optional") throw new CliUsageError();
      const storageClass = stringValue(values, "class") ?? "normal";
      if (storageClass !== "normal" && storageClass !== "express") throw new CliUsageError();
      result = await client.createCollection(
        { ...reference, environmentId: required(values, "environment") },
        {
          collection_key: required(values, "key"),
          display_name: required(values, "display"),
          malware_scan_required: scan === "required",
          storage_class: storageClass,
        },
        { operationId },
      );
    } else if (noun === "collection" && verb === "get") {
      result = await client.getCollection(collectionReference(values, tenantId, projectId));
    } else if (noun === "collection" && verb === "migrate") {
      operationId = mutationId(values);
      mutation = true;
      const targetStorageClass = required(values, "class");
      if (targetStorageClass !== "normal" && targetStorageClass !== "express") throw new CliUsageError();
      result = await client.startStorageMigration(
        collectionReference(values, tenantId, projectId),
        {
          target_storage_class: targetStorageClass,
          expected_collection_revision: positiveInteger(values, "revision"),
        },
        { operationId },
      );
    } else if (noun === "migration" && verb === "get") {
      result = await client.getStorageMigration({
        ...collectionReference(values, tenantId, projectId),
        migrationId: required(values, "migration"),
      });
    } else if (noun === "import" && verb === "start") {
      operationId = mutationId(values);
      mutation = true;
      result = await client.startCollectionImport(
        collectionReference(values, tenantId, projectId),
        await readJson<StartCollectionImportRequest>(required(values, "input")),
        { operationId },
      );
    } else if (noun === "export" && verb === "start") {
      operationId = mutationId(values);
      mutation = true;
      result = await client.startCollectionExport(
        collectionReference(values, tenantId, projectId),
        { expected_collection_revision: positiveInteger(values, "revision") },
        { operationId },
      );
    } else if (noun === "portability" && verb === "list") {
      const kind = stringValue(values, "kind");
      if (kind !== undefined && kind !== "import" && kind !== "export") throw new CliUsageError();
      result = await client.listPortabilityJobs(
        collectionReference(values, tenantId, projectId),
        { ...page(values), ...(kind === undefined ? {} : { kind }) },
      );
    } else if (noun === "portability" && verb === "get") {
      result = await client.getPortabilityJob({
        ...collectionReference(values, tenantId, projectId),
        jobId: required(values, "portability-job"),
      });
    } else if (noun === "export" && verb === "download") {
      operationId = mutationId(values);
      mutation = true;
      const reference = {
        ...collectionReference(values, tenantId, projectId),
        jobId: required(values, "portability-job"),
      };
      const descriptor = await client.createPortabilityExportDownload(reference, { operationId });
      const stream = await openPortableExport(descriptor, {
        ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
      });
      const output = required(values, "output");
      await savePortableExport(output, descriptor.descriptor_id, stream);
      result = {
        job_id: reference.jobId,
        output,
        size_bytes: stream.sizeBytes,
        content_sha256: stream.contentSha256,
      };
    } else if (noun === "extraction" && verb === "get") {
      result = await client.getCollectionExtraction(collectionReference(values, tenantId, projectId));
    } else if (noun === "extraction" && verb === "set") {
      operationId = mutationId(values);
      mutation = true;
      result = await client.replaceCollectionExtraction(
        collectionReference(values, tenantId, projectId),
        await readJson<ReplaceCollectionExtractionRequest>(required(values, "input")),
        { operationId },
      );
    } else if (noun === "extraction" && verb === "status") {
      result = await client.getGenerationExtraction({
        ...fileReference(values, tenantId, projectId),
        generationId: required(values, "generation"),
        kind: extractionKind(values),
      });
    } else if (noun === "extraction" && verb === "content") {
      const kind = extractionKind(values);
      if (kind === "technical") throw new CliUsageError();
      result = await client.getExtractedContent({
        ...fileReference(values, tenantId, projectId),
        generationId: required(values, "generation"),
        kind,
      });
    } else if (noun === "media" && verb === "get") {
      result = await client.getCollectionMedia(collectionReference(values, tenantId, projectId));
    } else if (noun === "media" && verb === "set") {
      operationId = mutationId(values);
      mutation = true;
      result = await client.replaceCollectionMedia(
        collectionReference(values, tenantId, projectId),
        await readJson<ReplaceCollectionMediaRequest>(required(values, "input")),
        { operationId },
      );
    } else if (noun === "protection" && verb === "get") {
      result = await client.getCollectionProtection(collectionReference(values, tenantId, projectId));
    } else if (noun === "protection" && verb === "set") {
      operationId = mutationId(values);
      mutation = true;
      const scan = required(values, "scan");
      if (scan !== "required" && scan !== "optional") throw new CliUsageError();
      result = await client.replaceCollectionProtection(
        collectionReference(values, tenantId, projectId),
        {
          expected_revision: positiveInteger(values, "revision"),
          config: { malware_scan_required: scan === "required" },
        },
        { operationId },
      );
    } else if (noun === "scan" && verb === "list") {
      const safetyState = stringValue(values, "state");
      if (safetyState !== undefined && !["scan_pending", "clean", "blocked"].includes(safetyState)) {
        throw new CliUsageError();
      }
      const collectionInstanceId = stringValue(values, "collection");
      result = await client.listProtectionCases(
        { ...reference, environmentId: required(values, "environment") },
        {
          ...page(values),
          ...(collectionInstanceId === undefined ? {} : { collectionInstanceId }),
          ...(safetyState === undefined ? {} : {
            safetyState: safetyState as "scan_pending" | "clean" | "blocked",
          }),
        },
      );
    } else if (noun === "scan" && verb === "rescan") {
      operationId = mutationId(values);
      mutation = true;
      result = await client.requestProtectionRescan(
        {
          ...fileReference(values, tenantId, projectId),
          generationId: required(values, "generation"),
        },
        { expected_revision: positiveInteger(values, "revision") },
        { operationId },
      );
    } else if (noun === "scan" && verb === "review") {
      operationId = mutationId(values);
      mutation = true;
      result = await client.createProtectionReview(
        {
          ...fileReference(values, tenantId, projectId),
          generationId: required(values, "generation"),
        },
        await readJson<CreateProtectionReviewRequest>(required(values, "input")),
        { operationId },
      );
    } else if (noun === "job" && verb === "list") {
      result = await client.listProcessingJobs(
        collectionReference(values, tenantId, projectId),
        page(values),
      );
    } else if (noun === "job" && verb === "retry") {
      operationId = mutationId(values);
      mutation = true;
      result = await client.retryProcessingJob(
        { ...collectionReference(values, tenantId, projectId), jobId: required(values, "job") },
        { expected_revision: positiveInteger(values, "revision") },
        { operationId },
      );
    } else if (noun === "job" && verb === "cancel") {
      operationId = mutationId(values);
      mutation = true;
      result = await client.cancelProcessingJob(
        { ...collectionReference(values, tenantId, projectId), jobId: required(values, "job") },
        { expected_revision: positiveInteger(values, "revision") },
        { operationId },
      );
    } else if (noun === "derivative" && verb === "list") {
      result = await client.listGenerationDerivatives({
        ...fileReference(values, tenantId, projectId),
        generationId: required(values, "generation"),
      });
    } else if (noun === "file" && verb === "list") {
      const pathPrefix = stringValue(values, "path-prefix");
      const metadataKey = stringValue(values, "metadata-key");
      const metadataValue = optionalMetadataValue(values);
      const extractionKindFilter = optionalExtractionKind(values, "extraction-kind");
      const extractionState = stringValue(values, "extraction-state");
      if ((metadataKey === undefined) !== (metadataValue === undefined)) throw new CliUsageError();
      if ((extractionKindFilter === undefined) !== (extractionState === undefined)) throw new CliUsageError();
      if (extractionState !== undefined && !["pending", "running", "succeeded", "failed", "unsupported"].includes(extractionState)) {
        throw new CliUsageError();
      }
      result = await client.listFiles(collectionReference(values, tenantId, projectId), {
        ...page(values),
        ...(values["include-deleted"] === true ? { includeDeleted: true } : {}),
        ...(pathPrefix === undefined ? {} : { pathPrefix }),
        ...optionalNamedValue(values, "tag", "tag"),
        ...(metadataKey === undefined ? {} : { metadataKey }),
        ...(metadataValue === undefined ? {} : { metadataValue }),
        ...optionalNamedValue(values, "media-type", "verifiedMediaType"),
        ...optionalNamedInteger(values, "minimum-size", "minimumSizeBytes"),
        ...optionalNamedInteger(values, "maximum-size", "maximumSizeBytes"),
        ...optionalNamedValue(values, "created-after", "createdAfter"),
        ...optionalNamedValue(values, "created-before", "createdBefore"),
        ...(extractionKindFilter === undefined ? {} : { extractionKind: extractionKindFilter }),
        ...(extractionState === undefined ? {} : { extractionState: extractionState as "pending" | "running" | "succeeded" | "failed" | "unsupported" }),
      });
    } else if (noun === "file" && verb === "search") {
      const mode = stringValue(values, "mode") ?? "lexical";
      if (mode !== "lexical" && mode !== "semantic" && mode !== "hybrid") throw new CliUsageError();
      const metadataKey = stringValue(values, "metadata-key");
      const metadataValue = optionalMetadataValue(values);
      const extractionKindFilter = optionalExtractionKind(values, "extraction-kind");
      const extractionState = stringValue(values, "extraction-state");
      if ((metadataKey === undefined) !== (metadataValue === undefined)) throw new CliUsageError();
      if ((extractionKindFilter === undefined) !== (extractionState === undefined)) throw new CliUsageError();
      if (extractionState !== undefined && !["pending", "running", "succeeded", "failed", "unsupported"].includes(extractionState)) {
        throw new CliUsageError();
      }
      const filter: NonNullable<SearchInput["filter"]> = {
        ...optionalNamedValue(values, "tag", "tag"),
        ...(metadataKey === undefined ? {} : { metadata_key: metadataKey }),
        ...(metadataValue === undefined ? {} : { metadata_value: metadataValue }),
        ...optionalNamedValue(values, "media-type", "verified_media_type"),
        ...optionalNamedInteger(values, "minimum-size", "minimum_size_bytes"),
        ...optionalNamedInteger(values, "maximum-size", "maximum_size_bytes"),
        ...optionalNamedValue(values, "created-after", "created_after"),
        ...optionalNamedValue(values, "created-before", "created_before"),
        ...(extractionKindFilter === undefined ? {} : { extraction_kind: extractionKindFilter }),
        ...(extractionState === undefined ? {} : { extraction_state: extractionState as "pending" | "running" | "succeeded" | "failed" | "unsupported" }),
      };
      const facets = stringValues(values, "facet");
      const pageSize = optionalBoundedInteger(values, "page-size", 50);
      const cursor = stringValue(values, "cursor");
      const pathPrefix = stringValue(values, "path-prefix");
      result = await client.searchFiles(collectionReference(values, tenantId, projectId), {
        query: required(values, "query"),
        mode,
        ...(pathPrefix === undefined ? {} : { path_prefix: pathPrefix }),
        ...(Object.keys(filter).length === 0 ? {} : { filter }),
        ...(facets.length === 0 ? {} : { facets: facets as NonNullable<SearchInput["facets"]> }),
        ...(pageSize === undefined ? {} : { page_size: pageSize }),
        ...(cursor === undefined ? {} : { cursor }),
      });
    } else if (noun === "file" && verb === "get") {
      result = await client.getFileMetadata(fileReference(values, tenantId, projectId));
    } else if (noun === "file" && verb === "batch") {
      operationId = mutationId(values);
      mutation = true;
      result = await client.mutateFilesBatch(
        collectionReference(values, tenantId, projectId),
        await readJson<FileBatchRequest>(required(values, "input")),
        { operationId },
      );
    } else if (noun === "file" && verb === "copy") {
      operationId = mutationId(values);
      mutation = true;
      const request: CopyFileRequest = {
        source_entry_id: required(values, "entry"),
        source_generation_id: required(values, "generation"),
        destination_path: required(values, "path"),
        expected_source_revision: positiveInteger(values, "revision"),
      };
      result = await client.copyFile(
        collectionReference(values, tenantId, projectId),
        request,
        { operationId },
      );
    } else if (noun === "metadata" && verb === "get") {
      result = await client.getEntryMetadata(fileReference(values, tenantId, projectId));
    } else if (noun === "metadata" && verb === "set") {
      operationId = mutationId(values);
      mutation = true;
      result = await client.replaceEntryMetadata(
        fileReference(values, tenantId, projectId),
        await readJson<ReplaceEntryMetadataRequest>(required(values, "input")),
        { operationId },
      );
    } else if (noun === "file" && verb === "versions") {
      result = await client.listFileGenerations(fileReference(values, tenantId, projectId), page(values));
    } else if (noun === "file" && verb === "rename") {
      operationId = mutationId(values);
      mutation = true;
      result = await client.renameFile(
        fileReference(values, tenantId, projectId),
        { logical_path: required(values, "path"), expected_revision: positiveInteger(values, "revision") },
        { operationId },
      );
    } else if (noun === "file" && verb === "select-version") {
      operationId = mutationId(values);
      mutation = true;
      result = await client.restoreFileGeneration(
        fileReference(values, tenantId, projectId),
        { generation_id: required(values, "generation"), expected_revision: positiveInteger(values, "revision") },
        { operationId },
      );
    } else if (noun === "file" && verb === "delete") {
      operationId = mutationId(values);
      mutation = true;
      result = await client.deleteFile(
        fileReference(values, tenantId, projectId),
        positiveInteger(values, "revision"),
        { operationId },
      );
    } else if (noun === "file" && verb === "restore") {
      operationId = mutationId(values);
      mutation = true;
      result = await client.restoreFile(
        fileReference(values, tenantId, projectId),
        { expected_revision: positiveInteger(values, "revision") },
        { operationId },
      );
    } else if (noun === "policy" && verb === "get") {
      result = await client.getCollectionPolicy(collectionReference(values, tenantId, projectId));
    } else if (noun === "policy" && verb === "set") {
      operationId = mutationId(values);
      mutation = true;
      result = await client.replaceCollectionPolicy(
        collectionReference(values, tenantId, projectId),
        await readJson<ReplaceAccessPolicyRequest>(required(values, "input")),
        { operationId },
      );
    } else if (noun === "policy" && verb === "simulate") {
      operationId = mutationId(values);
      mutation = true;
      result = await client.simulateCollectionPolicy(
        collectionReference(values, tenantId, projectId),
        await readJson<AccessSimulation>(required(values, "input")),
        { operationId },
      );
    } else if (noun === "delivery" && verb === "get") {
      result = await client.getDeliveryConfig(collectionReference(values, tenantId, projectId));
    } else if (noun === "delivery" && verb === "set") {
      operationId = mutationId(values);
      mutation = true;
      result = await client.replaceDeliveryConfig(
        collectionReference(values, tenantId, projectId),
        await readJson<ReplaceDeliveryConfigRequest>(required(values, "input")),
        { operationId },
      );
    } else if (noun === "share" && verb === "create") {
      operationId = mutationId(values);
      mutation = true;
      result = await client.createShare(
        collectionReference(values, tenantId, projectId),
        await readJson<CreateShareRequest>(required(values, "input")),
        { operationId },
      );
    } else if (noun === "share" && verb === "revoke") {
      operationId = mutationId(values);
      mutation = true;
      result = await client.revokeShare(
        { ...collectionReference(values, tenantId, projectId), shareId: required(values, "share") },
        { operationId },
      );
    } else if (noun === "issuer" && verb === "list") {
      result = await client.listLocalIssuers(collectionReference(values, tenantId, projectId));
    } else if (noun === "issuer" && verb === "register") {
      operationId = mutationId(values);
      mutation = true;
      result = await client.registerLocalIssuer(
        collectionReference(values, tenantId, projectId),
        await readJson<RegisterLocalIssuerRequest>(required(values, "input")),
        { operationId },
      );
    } else if (noun === "issuer" && verb === "rotate") {
      operationId = mutationId(values);
      mutation = true;
      result = await client.rotateLocalIssuerKey(
        localIssuerReference(values, tenantId, projectId),
        await readJson<RotateLocalIssuerKeyRequest>(required(values, "input")),
        { operationId },
      );
    } else if (noun === "issuer" && verb === "revoke") {
      operationId = mutationId(values);
      mutation = true;
      result = await client.revokeLocalIssuer(
        localIssuerReference(values, tenantId, projectId),
        positiveInteger(values, "revision"),
        { operationId },
      );
    } else if (noun === "issuer" && verb === "signing-config") {
      result = await client.getLocalIssuerSigningConfiguration(
        localIssuerReference(values, tenantId, projectId),
      );
    } else {
      throw new CliUsageError();
    }
    writeJson(dependencies.io.stdout, mutation ? { operation_id: operationId, result } : result);
    return 0;
  } catch (error) {
    return report(error, operationId, dependencies.io.stderr);
  }
}

class CliUsageError extends Error {}

class CliConfigError extends Error {
  readonly code: "ALMIRA_CLI_BASE_URL_REQUIRED" | "ALMIRA_CLI_TOKEN_REQUIRED";

  constructor(code: CliConfigError["code"]) {
    super(code);
    this.code = code;
  }
}

class CliDownloadError extends Error {
  readonly code:
    | "ALMIRA_CLI_OUTPUT_EXISTS"
    | "ALMIRA_CLI_OUTPUT_INVALID"
    | "ALMIRA_CLI_OUTPUT_WRITE_FAILED";

  constructor(code: CliDownloadError["code"]) {
    super(code);
    this.code = code;
  }
}

const commandOptions = new Map<string, ReadonlySet<string>>([
  ["project:bootstrap", new Set(["base-url", "operation-id", "project", "tenant", "tenancy-project"])],
  ["environment:list", new Set(["base-url", "project", "tenant"])],
  ["environment:create", new Set(["base-url", "display", "key", "operation-id", "project", "tenant"])],
  ["environment:update", new Set(["base-url", "display", "environment", "operation-id", "project", "revision", "tenant"])],
  ["environment:delete", new Set(["base-url", "environment", "operation-id", "project", "revision", "tenant"])],
  ["origin:get", new Set(["base-url", "environment", "project", "tenant"])],
  ["origin:set", new Set(["base-url", "environment", "operation-id", "origin", "project", "revision", "tenant"])],
  ["storage:capabilities", new Set(["base-url", "environment", "project", "tenant"])],
  ["config:preview", new Set(["base-url", "file", "project", "tenant"])],
  ["config:apply", new Set(["base-url", "file", "operation-id", "project", "tenant"])],
  ["collection:list", new Set(["base-url", "cursor", "environment", "limit", "project", "tenant"])],
  ["collection:create", new Set(["base-url", "class", "display", "environment", "key", "operation-id", "project", "scan", "tenant"])],
  ["collection:get", new Set(["base-url", "collection", "environment", "project", "tenant"])],
  ["collection:migrate", new Set(["base-url", "class", "collection", "environment", "operation-id", "project", "revision", "tenant"])],
  ["migration:get", new Set(["base-url", "collection", "environment", "migration", "project", "tenant"])],
  ["import:start", collectionCommandOptions("input", "operation-id")],
  ["export:start", collectionCommandOptions("operation-id", "revision")],
  ["export:download", collectionCommandOptions("operation-id", "output", "portability-job")],
  ["portability:list", collectionCommandOptions("cursor", "kind", "limit")],
  ["portability:get", collectionCommandOptions("portability-job")],
  ["extraction:get", collectionCommandOptions()],
  ["extraction:set", collectionCommandOptions("input", "operation-id")],
  ["extraction:status", collectionCommandOptions("entry", "generation", "kind")],
  ["extraction:content", collectionCommandOptions("entry", "generation", "kind")],
  ["media:get", collectionCommandOptions()],
  ["media:set", collectionCommandOptions("input", "operation-id")],
  ["protection:get", collectionCommandOptions()],
  ["protection:set", collectionCommandOptions("operation-id", "revision", "scan")],
  ["scan:list", new Set(["base-url", "collection", "cursor", "environment", "limit", "project", "state", "tenant"])],
  ["scan:rescan", collectionCommandOptions("entry", "generation", "operation-id", "revision")],
  ["scan:review", collectionCommandOptions("entry", "generation", "input", "operation-id")],
  ["job:list", collectionCommandOptions("cursor", "limit")],
  ["job:retry", collectionCommandOptions("job", "operation-id", "revision")],
  ["job:cancel", collectionCommandOptions("job", "operation-id", "revision")],
  ["derivative:list", collectionCommandOptions("entry", "generation")],
  ["file:list", new Set([
    "base-url", "collection", "created-after", "created-before", "cursor", "environment", "extraction-kind",
    "extraction-state", "include-deleted", "limit", "maximum-size", "media-type", "metadata-key",
    "metadata-value", "minimum-size", "path-prefix", "project", "tag", "tenant",
  ])],
  ["file:search", new Set([
    "base-url", "collection", "created-after", "created-before", "cursor", "environment", "extraction-kind",
    "extraction-state", "facet", "maximum-size", "media-type", "metadata-key", "metadata-value", "minimum-size",
    "mode", "page-size", "path-prefix", "project", "query", "tag", "tenant",
  ])],
  ["file:get", new Set(["base-url", "collection", "entry", "environment", "project", "tenant"])],
  ["file:batch", collectionCommandOptions("input", "operation-id")],
  ["file:copy", collectionCommandOptions("entry", "generation", "operation-id", "path", "revision")],
  ["metadata:get", collectionCommandOptions("entry")],
  ["metadata:set", collectionCommandOptions("entry", "input", "operation-id")],
  ["file:versions", new Set(["base-url", "collection", "cursor", "entry", "environment", "limit", "project", "tenant"])],
  ["file:rename", new Set(["base-url", "collection", "entry", "environment", "operation-id", "path", "project", "revision", "tenant"])],
  ["file:select-version", new Set(["base-url", "collection", "entry", "environment", "generation", "operation-id", "project", "revision", "tenant"])],
  ["file:delete", new Set(["base-url", "collection", "entry", "environment", "operation-id", "project", "revision", "tenant"])],
  ["file:restore", new Set(["base-url", "collection", "entry", "environment", "operation-id", "project", "revision", "tenant"])],
  ["policy:get", collectionCommandOptions()],
  ["policy:set", collectionCommandOptions("input", "operation-id")],
  ["policy:simulate", collectionCommandOptions("input", "operation-id")],
  ["delivery:get", collectionCommandOptions()],
  ["delivery:set", collectionCommandOptions("input", "operation-id")],
  ["share:create", collectionCommandOptions("input", "operation-id")],
  ["share:revoke", collectionCommandOptions("share", "operation-id")],
  ["issuer:list", collectionCommandOptions()],
  ["issuer:register", collectionCommandOptions("input", "operation-id")],
  ["issuer:rotate", collectionCommandOptions("input", "issuer", "operation-id")],
  ["issuer:revoke", collectionCommandOptions("issuer", "operation-id", "revision")],
  ["issuer:signing-config", collectionCommandOptions("issuer")],
]);

function collectionCommandOptions(...additional: string[]): ReadonlySet<string> {
  return new Set(["base-url", "collection", "environment", "project", "tenant", ...additional]);
}

function assertCommandOptions(noun: string, verb: string, values: Values): void {
  const allowed = commandOptions.get(`${noun}:${verb}`);
  if (allowed === undefined) throw new CliUsageError();
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined && value !== false && name !== "help" && !allowed.has(name)) {
      throw new CliUsageError();
    }
  }
}

function required(values: Values, name: string): string {
  const value = stringValue(values, name);
  if (value === undefined || value.length === 0) throw new CliUsageError();
  return value;
}

function stringValue(values: Values, name: string): string | undefined {
  const value = values[name];
  return typeof value === "string" ? value : undefined;
}

function stringValues(values: Values, name: string): string[] {
  const value = values[name];
  return Array.isArray(value) ? value : value === undefined ? [] : [String(value)];
}

function positiveInteger(values: Values, name: string): number {
  const value = required(values, name);
  if (!/^[1-9][0-9]{0,15}$/u.test(value)) throw new CliUsageError();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new CliUsageError();
  return parsed;
}

function optionalNamedInteger(values: Values, input: string, output: string): Record<string, number> {
  return stringValue(values, input) === undefined ? {} : { [output]: positiveInteger(values, input) };
}

function optionalNamedValue(values: Values, input: string, output: string): Record<string, string> {
  const value = stringValue(values, input);
  return value === undefined ? {} : { [output]: value };
}

function optionalMetadataValue(values: Values): boolean | number | string | undefined {
  const value = stringValue(values, "metadata-value");
  if (value === undefined) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed === "boolean" || typeof parsed === "string" || (typeof parsed === "number" && Number.isSafeInteger(parsed))) {
      return parsed;
    }
  } catch {
    // The stable usage error below is deliberately content-free.
  }
  throw new CliUsageError();
}

function optionalExtractionKind(values: Values, name: string): "technical" | "content" | "ocr" | "transcription" | undefined {
  const value = stringValue(values, name);
  if (value === undefined) return undefined;
  if (value === "technical" || value === "content" || value === "ocr" || value === "transcription") return value;
  throw new CliUsageError();
}

function extractionKind(values: Values): "technical" | "content" | "ocr" | "transcription" {
  const value = optionalExtractionKind(values, "kind");
  if (value === undefined) throw new CliUsageError();
  return value;
}

function optionalPageInteger(values: Values): number | undefined {
  const value = stringValue(values, "limit");
  if (value === undefined) return undefined;
  const parsed = positiveInteger(values, "limit");
  if (parsed > 100) throw new CliUsageError();
  return parsed;
}

function optionalBoundedInteger(values: Values, name: string, maximum: number): number | undefined {
  if (stringValue(values, name) === undefined) return undefined;
  const parsed = positiveInteger(values, name);
  if (parsed > maximum) throw new CliUsageError();
  return parsed;
}

function page(values: Values): { limit?: number; cursor?: string } {
  const limit = optionalPageInteger(values);
  const cursor = stringValue(values, "cursor");
  return {
    ...(limit === undefined ? {} : { limit }),
    ...(cursor === undefined ? {} : { cursor }),
  };
}

function mutationId(values: Values): string {
  return stringValue(values, "operation-id") ?? createOperationId();
}

function collectionReference(values: Values, tenantId: string, projectId: string) {
  return {
    tenantId,
    projectId,
    environmentId: required(values, "environment"),
    collectionInstanceId: required(values, "collection"),
  };
}

function fileReference(values: Values, tenantId: string, projectId: string) {
  return { ...collectionReference(values, tenantId, projectId), entryId: required(values, "entry") };
}

function localIssuerReference(values: Values, tenantId: string, projectId: string) {
  return { ...collectionReference(values, tenantId, projectId), issuerId: required(values, "issuer") };
}

async function readTenancyProject(path: string): Promise<TenancyProjectGetResponse> {
  try {
    const bytes = await readFile(path);
    if (bytes.length === 0 || bytes.length > 256 * 1024) throw new CliUsageError();
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as TenancyProjectGetResponse;
  } catch (error) {
    if (error instanceof CliUsageError) throw error;
    throw new CliUsageError();
  }
}

async function readConfiguration(path: string): Promise<unknown> {
  try {
    const bytes = await readFile(path);
    if (bytes.length === 0 || bytes.length > 256 * 1024) throw new CliUsageError();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return parseYaml(text, { maxAliasCount: 0, uniqueKeys: true });
  } catch (error) {
    if (error instanceof CliUsageError) throw error;
    throw new CliUsageError();
  }
}

async function readJson<T>(path: string): Promise<T> {
  try {
    const bytes = await readFile(path);
    if (bytes.length === 0 || bytes.length > 256 * 1024) throw new CliUsageError();
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as T;
  } catch (error) {
    if (error instanceof CliUsageError) throw error;
    throw new CliUsageError();
  }
}

async function savePortableExport(
  output: string,
  descriptorId: string,
  stream: PortableExportStream,
): Promise<void> {
  if (output.length === 0 || output.length > 4096 || /[\u0000\r\n]/u.test(output)) {
    throw new CliDownloadError("ALMIRA_CLI_OUTPUT_INVALID");
  }
  const temporary = `${output}.almira-${descriptorId}.partial`;
  const hash = createHash("sha256");
  let size = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(
      Readable.fromWeb(stream.body as Parameters<typeof Readable.fromWeb>[0]),
      meter,
      createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
    );
    if (size !== stream.sizeBytes || `sha256:${hash.digest("hex")}` !== stream.contentSha256) {
      throw new CliDownloadError("ALMIRA_CLI_OUTPUT_INVALID");
    }
    await link(temporary, output);
    await unlink(temporary).catch(() => undefined);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    if (error instanceof CliDownloadError) throw error;
    if (isFileSystemError(error) && error.code === "EEXIST") {
      throw new CliDownloadError("ALMIRA_CLI_OUTPUT_EXISTS");
    }
    throw new CliDownloadError("ALMIRA_CLI_OUTPUT_WRITE_FAILED");
  }
}

function isFileSystemError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function writeJson(output: { write(value: string): unknown }, value: unknown): void {
  output.write(`${JSON.stringify(value)}\n`);
}

function report(
  error: unknown,
  operationId: string | null,
  output: { write(value: string): unknown },
): number {
  if (error instanceof CliUsageError || error instanceof TypeError) {
    writeJson(output, { code: "ALMIRA_CLI_USAGE_INVALID", recovery: "run almira --help" });
    return 2;
  }
  if (error instanceof CliConfigError) {
    writeJson(output, {
      code: error.code,
      recovery:
        error.code === "ALMIRA_CLI_TOKEN_REQUIRED"
          ? "set METAMORPH_TOKEN to a scoped PAT or SAK"
          : "pass --base-url or set ALMIRA_BASE_URL",
    });
    return 2;
  }
  if (error instanceof CliDownloadError) {
    writeJson(output, {
      code: error.code,
      ...(operationId === null ? {} : { operation_id: operationId }),
      recovery: error.code === "ALMIRA_CLI_OUTPUT_EXISTS"
        ? "choose a new --output path"
        : "verify the output path and retry with a fresh download operation",
    });
    return error.code === "ALMIRA_CLI_OUTPUT_EXISTS" ? 5 : 8;
  }
  if (error instanceof AlmiraApiError) {
    const exitCode = apiExitCode(error.status);
    writeJson(output, {
      code: error.code,
      request_id: error.requestId,
      status: error.status,
      retry_after_milliseconds: error.retryAfterMilliseconds,
      ...(operationId === null ? {} : { operation_id: operationId }),
      recovery: recovery(error.status),
    });
    return exitCode;
  }
  if (error instanceof AlmiraClientError) {
    writeJson(output, {
      code: error.code,
      ...(operationId === null ? {} : { operation_id: operationId }),
      recovery: error.code === "ALMIRA_CLIENT_NETWORK" ? "retry with the same operation_id" : "fix local configuration or input",
    });
    return 8;
  }
  if (error instanceof AlmiraTransferError) {
    writeJson(output, {
      code: error.code,
      ...(operationId === null ? {} : { operation_id: operationId }),
      recovery: "request a fresh one-use export download and retry",
    });
    return 8;
  }
  if (error instanceof AlmiraConfigurationError) {
    writeJson(output, {
      code: error.code,
      ...(operationId === null ? {} : { operation_id: operationId }),
      ...(error.plan === null ? {} : { plan: error.plan }),
      recovery: error.code === "ALMIRA_CONFIGURATION_INPUT_INVALID"
        ? "fix almira.yaml and retry"
        : "inspect the configuration conflicts and current capabilities",
    });
    return error.code === "ALMIRA_CONFIGURATION_INPUT_INVALID" ? 2 : 5;
  }
  writeJson(output, {
    code: "ALMIRA_CLI_INTERNAL",
    ...(operationId === null ? {} : { operation_id: operationId }),
    recovery: "retry or report this safe code",
  });
  return 9;
}

function apiExitCode(status: number): number {
  if (status === 401 || status === 403) return 3;
  if (status === 404) return 4;
  if (status === 409) return 5;
  if (status === 429 || status === 503) return 6;
  return 7;
}

function recovery(status: number): string {
  if (status === 401) return "refresh or replace METAMORPH_TOKEN";
  if (status === 403) return "inspect token scope and project permission";
  if (status === 404) return "verify project and resource identifiers";
  if (status === 409) return "refresh state and retry with the same operation_id when appropriate";
  if (status === 429 || status === 503) return "wait retry_after_milliseconds and retry with the same operation_id";
  return "inspect the stable code and request_id";
}

export { HELP };
