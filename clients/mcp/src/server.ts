import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { link, unlink } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { McpServer } from "@modelcontextprotocol/server";
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
  type PortableExportStream,
  type SearchInput,
  type StartCollectionImportRequest,
} from "@metamorph-labs/almira-sdk";
import * as z from "zod/v4";

const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
const operationId = uuid.optional().describe("UUIDv7 to reuse after an ambiguous mutation outcome");
const scope = { tenant_id: uuid, project_id: uuid };
const tenancyProject = z
  .object({
    schema_version: z.literal(1),
    operation_id: uuid,
    operation: z.literal("project.get"),
    disposition: z.enum(["succeeded", "exact_replay"]),
    result: z.object({
      project: z.object({
        tenant_id: uuid,
        project_id: uuid,
        space_id: uuid,
        product_id: z.literal("almira"),
        product_section_id: z.null(),
        project_kind_id: z.literal("almira.storage"),
        owner_region_id: z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/u),
        name: z.string().min(1).max(200),
        visibility: z.enum(["private", "public"]),
        lifecycle: z.literal("active"),
        route_epoch: z.number().int().min(1),
        revision: z.number().int().min(3),
        restrictive_revision: z.number().int().min(1),
        activated_at: z.string().min(1).max(64),
      }).strict(),
    }).strict(),
  })
  .strict();
const page = {
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.number().int().min(1).max(100).optional(),
};
const environmentKey = z.string().regex(/^[a-z][a-z0-9-]{0,46}[a-z0-9]$/u);
const environmentDisplayName = z.string().refine((value) =>
  [...value].length >= 1 &&
  [...value].length <= 80 &&
  value === value.trim() &&
  !/[\u0000-\u001f\u007f]/u.test(value),
);
const imagePreset = z.object({
  widths: z.array(z.number().int().min(1).max(8192)).min(1).max(8)
    .refine((values) => values.every((value, index) => index === 0 || values[index - 1] < value), {
      message: "widths must be strictly increasing",
    }),
  height: z.number().int().min(1).max(8192).nullable(),
  fit: z.enum(["contain", "cover", "inside"]),
  formats: z.array(z.enum(["avif", "webp", "jpeg", "png"])).min(1).max(4)
    .refine((values) => new Set(values).size === values.length),
  without_enlargement: z.boolean(),
}).strict();
const imagePresets = z.record(
  z.string().regex(/^[a-z]([a-z0-9._-]{0,62}[a-z0-9])?$/u),
  imagePreset,
).refine((presets) =>
  Object.keys(presets).length <= 16 &&
  Object.values(presets).reduce((count, preset) => count + preset.widths.length * preset.formats.length, 0) <= 64,
  { message: "media preset output fan-out exceeds 64" },
);
const collectionMediaInput = z.object({
  image_presets: imagePresets.optional(),
  document_previews: z.boolean().optional(),
  video_profile: z.literal("web_hls_v1").nullable().optional(),
}).strict();
const configurationCollection = z.object({
  key: z.string().regex(/^[a-z]([a-z0-9_-]{0,62}[a-z0-9])?$/u),
  display_name: environmentDisplayName,
  malware_scan_required: z.boolean(),
  storage_class: z.enum(["normal", "express"]).optional(),
  recycle_retention_days: z.number().int().min(1).max(3650).optional(),
  extraction: z.object({
    content: z.boolean(),
    ocr: z.boolean(),
    transcription: z.boolean(),
    vector_indexing: z.boolean(),
  }).strict().refine((value) => !value.vector_indexing || value.content, {
    message: "vector_indexing requires content extraction",
  }).optional(),
  media: collectionMediaInput.optional(),
}).strict();
const configuration = z.object({
  api_version: z.literal("almira/v1"),
  environments: z.array(z.object({
    key: environmentKey,
    display_name: environmentDisplayName,
    browser_origins: z.array(z.string().min(1).max(255)).max(32).optional(),
    collections: z.array(configurationCollection),
  }).strict()).max(10),
}).strict();
const collectionScope = {
  ...scope,
  environment_id: uuid,
  collection_instance_id: uuid,
};
const metadataComponent = z.string().regex(/^[a-z]([a-z0-9._-]{0,62}[a-z0-9])?$/u);
const customMetadataValue = z.union([
  z.boolean(),
  z.number().int().safe(),
  z.string().min(1).max(512).refine((value) => !/[\u0000-\u001f\u007f]/u.test(value)),
]);
const extractionKind = z.enum(["technical", "content", "ocr", "transcription"]);
const protectedExtractionKind = z.enum(["content", "ocr", "transcription"]);
const extractionState = z.enum(["pending", "running", "succeeded", "failed", "unsupported"]);
const fileMetadataFilter = z.object({
  tag: metadataComponent.optional(),
  metadata_key: metadataComponent.optional(),
  metadata_value: customMetadataValue.optional(),
  verified_media_type: z.string().min(3).max(127).optional(),
  minimum_size_bytes: z.number().int().min(1).max(10_737_418_240).optional(),
  maximum_size_bytes: z.number().int().min(1).max(10_737_418_240).optional(),
  created_after: z.string().datetime({ offset: true }).optional(),
  created_before: z.string().datetime({ offset: true }).optional(),
  extraction_kind: extractionKind.optional(),
  extraction_state: extractionState.optional(),
}).strict()
  .refine((value) => (value.metadata_key === undefined) === (value.metadata_value === undefined), {
    message: "metadata_key and metadata_value must be supplied together",
  })
  .refine((value) => (value.extraction_kind === undefined) === (value.extraction_state === undefined), {
    message: "extraction_kind and extraction_state must be supplied together",
  })
  .refine((value) => value.minimum_size_bytes === undefined || value.maximum_size_bytes === undefined || value.minimum_size_bytes <= value.maximum_size_bytes, {
    message: "minimum_size_bytes cannot exceed maximum_size_bytes",
  });
const fileBatchAction = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("rename"),
    entry_id: uuid,
    logical_path: z.string().min(1).max(1024),
    expected_revision: z.number().int().min(1),
  }).strict(),
  z.object({
    action: z.literal("select_generation"),
    entry_id: uuid,
    generation_id: uuid,
    expected_revision: z.number().int().min(1),
  }).strict(),
  z.object({
    action: z.literal("delete"),
    entry_id: uuid,
    expected_revision: z.number().int().min(1),
  }).strict(),
  z.object({
    action: z.literal("restore"),
    entry_id: uuid,
    expected_revision: z.number().int().min(1),
  }).strict(),
]);
const fileBatchActions = z.array(fileBatchAction).min(1).max(100).refine(
  (actions) => new Set(actions.map((action) => action.entry_id)).size === actions.length,
  { message: "an entry may occur only once in an atomic batch" },
);
const searchFacet = z.string().regex(/^(?:tags|verified_media_type|custom\.[a-z](?:[a-z0-9._-]{0,62}[a-z0-9])?)$/u);
const searchInput = z.object({
  query: z.string().min(1).max(1024).refine((value) => value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value)),
  mode: z.enum(["lexical", "semantic", "hybrid"]).optional(),
  path_prefix: z.string().min(1).max(1024).optional(),
  filter: fileMetadataFilter.optional(),
  facets: z.array(searchFacet).max(8).refine((values) => new Set(values).size === values.length).optional(),
  page_size: z.number().int().min(1).max(50).optional(),
  cursor: z.string().min(1).max(8192).optional(),
}).strict();
const customerMetadata = z.object({
  tags: z.array(metadataComponent).max(32).refine((tags) => new Set(tags).size === tags.length),
  custom: z.record(metadataComponent, customMetadataValue),
}).strict().refine((value) =>
  Object.keys(value.custom).length <= 32 &&
  new TextEncoder().encode(JSON.stringify(value)).length <= 16_384,
);
const builderSubject = z.object({
  subject_id: z.string().min(1).max(255),
  organization_id: z.string().min(1).max(255).nullable().optional(),
  roles: z.array(z.string().regex(/^[a-z][a-z0-9._:-]{0,63}$/u)).max(16).optional(),
  attributes: z.record(z.string().regex(/^[a-z][a-z0-9._:-]{0,63}$/u), z.string().min(1).max(255)).optional(),
}).strict();
const accessOperation = z.enum(["list", "metadata_read", "content_read", "search", "upload", "delete", "share"]);
const readAccessOperation = z.enum(["list", "metadata_read", "content_read", "search"]);
const accessResource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("collection") }).strict(),
  z.object({ kind: z.literal("prefix"), path_prefix: z.string().min(1).max(1024) }).strict(),
  z.object({ kind: z.literal("entry"), entry_id: uuid }).strict(),
]);
const accessSubject = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("public") }).strict(),
  z.object({ kind: z.literal("server") }).strict(),
  z.object({ kind: z.literal("authenticated") }).strict(),
  z.object({ kind: z.literal("subject"), subject_id: z.string().min(1).max(255) }).strict(),
  z.object({ kind: z.literal("organization"), organization_id: z.string().min(1).max(255) }).strict(),
  z.object({ kind: z.literal("role"), role: z.string().regex(/^[a-z][a-z0-9._:-]{0,63}$/u) }).strict(),
  z.object({
    kind: z.literal("attribute"),
    key: z.string().regex(/^[a-z][a-z0-9._:-]{0,63}$/u),
    value: z.string().min(1).max(255),
  }).strict(),
]);
const accessPolicyDocument = z.object({
  template: z.enum(["server_only", "private", "public_read"]),
  rules: z.array(z.object({
    rule_id: z.string().regex(/^[a-z][a-z0-9._:-]{0,63}$/u),
    effect: z.enum(["allow", "deny"]),
    subject: accessSubject,
    operations: z.array(accessOperation).min(1).max(7),
    resource: accessResource,
  }).strict()).max(64),
}).strict();
const accessSimulation = z.object({
  principal: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("public") }).strict(),
    z.object({ kind: z.literal("server") }).strict(),
    z.object({ kind: z.literal("end_user"), subject: builderSubject }).strict(),
  ]),
  operation: accessOperation,
  target: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("collection") }).strict(),
    z.object({ kind: z.literal("entry"), entry_id: uuid, logical_path: z.string().min(1).max(1024) }).strict(),
  ]),
}).strict();
const deliveryConfig = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("off"), cache_preset: z.literal("no_store"),
    logical_aliases: z.literal(false), direct_provider_private_downloads: z.literal(false),
  }).strict(),
  z.object({
    mode: z.literal("public"), cache_preset: z.literal("revalidate"),
    logical_aliases: z.literal(false), direct_provider_private_downloads: z.literal(false),
  }).strict(),
  z.object({
    mode: z.literal("private"), cache_preset: z.enum(["no_store", "private_session"]),
    logical_aliases: z.literal(false), direct_provider_private_downloads: z.literal(false),
  }).strict(),
]);
const localIssuerCeiling = z.object({
  operations: z.array(readAccessOperation).min(1).max(4),
  resource: accessResource,
  audiences: z.array(z.url().max(2048)).min(1).max(16),
  maximum_lifetime_seconds: z.number().int().min(60).max(900),
}).strict();
const protectionReviewReason = z.string().refine((value) => {
  const bytes = new TextEncoder().encode(value).length;
  return bytes >= 12 && bytes <= 1000 && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
}, { message: "reason must be 12-1000 UTF-8 bytes without surrounding whitespace or controls" });
const contentSha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const providerReceipt = z.string().min(1).max(256).regex(/^[!-~]+$/u);
const directUploadPartCompletion = z.object({
  part_number: z.number().int().min(1).max(256),
  etag: providerReceipt,
}).strict();
const directUploadCompletion = z.discriminatedUnion("protocol", [
  z.object({
    descriptor_id: uuid,
    protocol: z.literal("single_put"),
    etag: providerReceipt,
    provider_version: providerReceipt.nullable(),
    parts: z.array(directUploadPartCompletion).length(1),
    size_bytes: z.number().int().min(1).max(8 * 1024 * 1024),
    content_sha256: contentSha256,
  }).strict().refine((value) => value.parts[0]?.part_number === 1 && value.parts[0]?.etag === value.etag, {
    message: "single_put completion must bind part one to the aggregate etag",
  }),
  z.object({
    descriptor_id: uuid,
    protocol: z.literal("multipart"),
    etag: z.null(),
    provider_version: z.null(),
    parts: z.array(directUploadPartCompletion).min(2).max(256)
      .refine((parts) => parts.every((part, index) => part.part_number === index + 1)),
    size_bytes: z.number().int().min(1).max(8 * 1024 * 1024),
    content_sha256: contentSha256,
  }).strict(),
]);
const logicalPath = z.string().regex(/^[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/u).max(1024);
const importSource = z.object({
  source_binding_id: uuid,
  source_binding_generation: z.number().int().min(1),
  manifest_sha256: contentSha256,
  objects_total: z.number().int().min(1).max(100),
  bytes_total: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
}).strict();
const importObject = z.object({
  source_object_id: uuid,
  logical_path: logicalPath,
  expected_size_bytes: z.number().int().min(1).max(10_737_418_240),
  content_sha256: contentSha256,
  declared_media_type: z.string().regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u).max(127),
}).strict();
const importRequest = z.object({
  expected_collection_revision: z.number().int().min(1),
  source: importSource,
  objects: z.array(importObject).min(1).max(100),
  destination_prefix: logicalPath.optional(),
}).strict()
  .refine((value) => value.objects.length === value.source.objects_total, {
    message: "source objects_total must equal objects length",
  })
  .refine((value) => value.objects.reduce((total, object) => total + object.expected_size_bytes, 0) === value.source.bytes_total, {
    message: "source bytes_total must equal object sizes",
  })
  .refine((value) => new Set(value.objects.map((object) => object.source_object_id)).size === value.objects.length, {
    message: "source_object_id values must be unique",
  })
  .refine((value) => new Set(value.objects.map((object) => object.logical_path)).size === value.objects.length, {
    message: "logical_path values must be unique",
  });
const outputPath = z.string().min(1).max(4096).refine((value) => !/[\u0000\r\n]/u.test(value));

const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const mutationAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const deleteAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const transferAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const outputSchema = z
  .object({
    operation_id: uuid.optional(),
    result: z.unknown(),
  })
  .strict();

export interface AlmiraMcpDependencies {
  fetch?: typeof globalThis.fetch;
}

/** Creates one stdio-safe MCP server over the canonical Almira SDK client. */
export function createAlmiraMcpServer(
  client: AlmiraClient,
  dependencies: AlmiraMcpDependencies = {},
): McpServer {
  const server = new McpServer({ name: "almira", version: "0.1.0-dev.36" });

  server.registerTool(
    "almira_project_bootstrap",
    {
      title: "Bootstrap Almira project",
      description: "Converge Almira's default development and production environments for one existing Metamorph project.",
      inputSchema: z.object({ ...scope, tenancy_project: tenancyProject, operation_id: operationId }).strict(),
      outputSchema,
      annotations: mutationAnnotations,
    },
    async ({ tenant_id, project_id, tenancy_project, operation_id }) => {
      const id = operation_id ?? createOperationId();
      return execute(
        () => client.bootstrapProject(
          { tenantId: tenant_id, projectId: project_id },
          { tenancy_project },
          { operationId: id },
        ),
        id,
      );
    },
  );

  server.registerTool(
    "almira_environment_list",
    {
      title: "List Almira environments",
      description: "List the complete bounded environment set for one Almira project.",
      inputSchema: z.object(scope).strict(),
      outputSchema,
      annotations: readAnnotations,
    },
    async ({ tenant_id, project_id }) =>
      execute(() => client.listEnvironments({ tenantId: tenant_id, projectId: project_id })),
  );

  server.registerTool(
    "almira_configuration_preview",
    {
      title: "Preview Almira configuration",
      description: "Read current state and return the deterministic additive diff for an almira.yaml v1 document.",
      inputSchema: z.object({ ...scope, configuration }).strict(),
      outputSchema,
      annotations: readAnnotations,
    },
    async ({ tenant_id, project_id, configuration: desired }) =>
      execute(() => previewConfiguration(
        client,
        { tenantId: tenant_id, projectId: project_id },
        desired,
      )),
  );

  server.registerTool(
    "almira_configuration_apply",
    {
      title: "Apply Almira configuration",
      description: "Apply one additive almira.yaml v1 diff through ordinary scoped Almira operations.",
      inputSchema: z.object({ ...scope, configuration, operation_id: operationId }).strict(),
      outputSchema,
      annotations: mutationAnnotations,
    },
    async ({ tenant_id, project_id, configuration: desired, operation_id }) => {
      const id = operation_id ?? createOperationId();
      return execute(() => applyConfiguration(
        client,
        { tenantId: tenant_id, projectId: project_id },
        desired,
        { operationId: id },
      ), id);
    },
  );

  server.registerTool(
    "almira_environment_create",
    {
      title: "Create Almira environment",
      description: "Create one additional managed environment in an Almira project, up to the project ceiling.",
      inputSchema: z.object({
        ...scope,
        environment_key: environmentKey,
        display_name: environmentDisplayName,
        operation_id: operationId,
      }).strict(),
      outputSchema,
      annotations: mutationAnnotations,
    },
    async ({ tenant_id, project_id, environment_key, display_name, operation_id }) => {
      const id = operation_id ?? createOperationId();
      return execute(
        () => client.createEnvironment(
          { tenantId: tenant_id, projectId: project_id },
          { environment_key, display_name },
          { operationId: id },
        ),
        id,
      );
    },
  );

  server.registerTool(
    "almira_environment_update",
    {
      title: "Update Almira environment",
      description: "Rename one environment using optimistic revision control.",
      inputSchema: z.object({
        ...scope,
        environment_id: uuid,
        display_name: environmentDisplayName,
        expected_revision: z.number().int().min(1),
        operation_id: operationId,
      }).strict(),
      outputSchema,
      annotations: mutationAnnotations,
    },
    async ({ tenant_id, project_id, environment_id, display_name, expected_revision, operation_id }) => {
      const id = operation_id ?? createOperationId();
      return execute(
        () => client.updateEnvironment(
          { tenantId: tenant_id, projectId: project_id, environmentId: environment_id },
          { display_name, expected_revision },
          { operationId: id },
        ),
        id,
      );
    },
  );

  server.registerTool(
    "almira_environment_delete",
    {
      title: "Delete Almira environment",
      description: "Mark a non-system environment for deletion using optimistic revision control.",
      inputSchema: z.object({
        ...scope,
        environment_id: uuid,
        expected_revision: z.number().int().min(1),
        operation_id: operationId,
      }).strict(),
      outputSchema,
      annotations: deleteAnnotations,
    },
    async ({ tenant_id, project_id, environment_id, expected_revision, operation_id }) => {
      const id = operation_id ?? createOperationId();
      return execute(
        () => client.deleteEnvironment(
          { tenantId: tenant_id, projectId: project_id, environmentId: environment_id },
          expected_revision,
          { operationId: id },
        ),
        id,
      );
    },
  );

  server.registerTool(
    "almira_browser_origins_get",
    {
      title: "Get browser origins",
      description: "Read the canonical browser-origin policy for one environment.",
      inputSchema: z.object({ ...scope, environment_id: uuid }).strict(),
      outputSchema,
      annotations: readAnnotations,
    },
    async ({ tenant_id, project_id, environment_id }) =>
      execute(() => client.getBrowserOrigins({ tenantId: tenant_id, projectId: project_id, environmentId: environment_id })),
  );

  server.registerTool(
    "almira_browser_origins_replace",
    {
      title: "Replace browser origins",
      description: "Replace an environment's complete browser-origin policy using optimistic revision control.",
      inputSchema: z
        .object({
          ...scope,
          environment_id: uuid,
          expected_revision: z.number().int().min(1),
          origins: z.array(z.string().min(1).max(255)).max(32),
          operation_id: operationId,
        })
        .strict(),
      outputSchema,
      annotations: mutationAnnotations,
    },
    async ({ tenant_id, project_id, environment_id, expected_revision, origins, operation_id }) => {
      const id = operation_id ?? createOperationId();
      return execute(
        () =>
          client.replaceBrowserOrigins(
            { tenantId: tenant_id, projectId: project_id, environmentId: environment_id },
            { expected_revision, origins },
            { operationId: id },
          ),
        id,
      );
    },
  );

  server.registerTool(
    "almira_storage_capabilities_get",
    {
      title: "Get storage capabilities",
      description: "Discover the current provider-neutral storage realizations and classes available to one active environment.",
      inputSchema: z.object({ ...scope, environment_id: uuid }).strict(),
      outputSchema,
      annotations: readAnnotations,
    },
    async ({ tenant_id, project_id, environment_id }) =>
      execute(() =>
        client.getStorageCapabilities({
          tenantId: tenant_id,
          projectId: project_id,
          environmentId: environment_id,
        }),
      ),
  );

  server.registerTool(
    "almira_collection_list",
    {
      title: "List Almira collections",
      description: "List a deterministic page of collections in one environment.",
      inputSchema: z.object({ ...scope, environment_id: uuid, ...page }).strict(),
      outputSchema,
      annotations: readAnnotations,
    },
    async ({ tenant_id, project_id, environment_id, limit, cursor }) =>
      execute(() =>
        client.listCollections(
          { tenantId: tenant_id, projectId: project_id, environmentId: environment_id },
          {
            ...(limit === undefined ? {} : { limit }),
            ...(cursor === undefined ? {} : { cursor }),
          },
        ),
      ),
  );

  server.registerTool(
    "almira_collection_create",
    {
      title: "Create Almira collection",
      description: "Create one private normal or express collection with explicit malware-scanning policy.",
      inputSchema: z
        .object({
          ...scope,
          environment_id: uuid,
          collection_key: z.string().min(1).max(64),
          display_name: z.string().min(1).max(80),
          malware_scan_required: z.boolean(),
          storage_class: z.enum(["normal", "express"]).optional(),
          operation_id: operationId,
        })
        .strict(),
      outputSchema,
      annotations: mutationAnnotations,
    },
    async ({
      project_id,
      tenant_id,
      environment_id,
      collection_key,
      display_name,
      malware_scan_required,
      storage_class,
      operation_id,
    }) => {
      const id = operation_id ?? createOperationId();
      return execute(
        () =>
          client.createCollection(
            { tenantId: tenant_id, projectId: project_id, environmentId: environment_id },
            {
              collection_key,
              display_name,
              malware_scan_required,
              storage_class: storage_class ?? "normal",
            },
            { operationId: id },
          ),
        id,
      );
    },
  );

  server.registerTool(
    "almira_collection_get",
    {
      title: "Get Almira collection",
      description: "Read one exact environment-owned collection instance.",
      inputSchema: z
        .object({ ...scope, environment_id: uuid, collection_instance_id: uuid })
        .strict(),
      outputSchema,
      annotations: readAnnotations,
    },
    async ({ tenant_id, project_id, environment_id, collection_instance_id }) =>
      execute(() =>
        client.getCollection({
          tenantId: tenant_id,
          projectId: project_id,
          environmentId: environment_id,
          collectionInstanceId: collection_instance_id,
        }),
      ),
  );

  server.registerTool(
    "almira_collection_extraction_get",
    {
      title: "Get collection extraction controls",
      description: "Read collection-level content, OCR, transcription, and vector-indexing controls; safe technical metadata is always enabled.",
      inputSchema: z.object(collectionScope).strict(),
      outputSchema,
      annotations: readAnnotations,
    },
    async ({ tenant_id, project_id, environment_id, collection_instance_id }) =>
      execute(() => client.getCollectionExtraction(
        collectionReference(tenant_id, project_id, environment_id, collection_instance_id),
      )),
  );

  server.registerTool(
    "almira_collection_extraction_replace",
    {
      title: "Replace collection extraction controls",
      description: "Replace the collection's opt-in content, OCR, and transcription extraction controls using optimistic revision control.",
      inputSchema: z.object({
        ...collectionScope,
        expected_revision: z.number().int().min(1),
        content: z.boolean(),
        ocr: z.boolean(),
        transcription: z.boolean(),
        vector_indexing: z.boolean().optional(),
        operation_id: operationId,
      }).strict().refine((value) => value.vector_indexing !== true || value.content, {
        message: "vector_indexing requires content extraction",
      }),
      outputSchema,
      annotations: mutationAnnotations,
    },
    async ({ tenant_id, project_id, environment_id, collection_instance_id, expected_revision, content, ocr, transcription, vector_indexing, operation_id }) => {
      const id = operation_id ?? createOperationId();
      return execute(() => client.replaceCollectionExtraction(
        collectionReference(tenant_id, project_id, environment_id, collection_instance_id),
        { expected_revision, config: { content, ocr, transcription, ...(vector_indexing === undefined ? {} : { vector_indexing }) } },
        { operationId: id },
      ), id);
    },
  );

  server.registerTool(
    "almira_collection_media_get",
    {
      title: "Get collection media controls",
      description: "Read collection-level image presets, document previews, and the optional video processing profile.",
      inputSchema: z.object(collectionScope).strict(),
      outputSchema,
      annotations: readAnnotations,
    },
    async ({ tenant_id, project_id, environment_id, collection_instance_id }) =>
      execute(() => client.getCollectionMedia(
        collectionReference(tenant_id, project_id, environment_id, collection_instance_id),
      )),
  );

  server.registerTool(
    "almira_collection_media_replace",
    {
      title: "Replace collection media controls",
      description: "Replace bounded provider-neutral image, document, and video processing controls using optimistic revision control.",
      inputSchema: z.object({
        ...collectionScope,
        expected_revision: z.number().int().min(1),
        config: collectionMediaInput,
        operation_id: operationId,
      }).strict(),
      outputSchema,
      annotations: mutationAnnotations,
    },
    async ({ tenant_id, project_id, environment_id, collection_instance_id, expected_revision, config, operation_id }) => {
      const id = operation_id ?? createOperationId();
      return execute(() => client.replaceCollectionMedia(
        collectionReference(tenant_id, project_id, environment_id, collection_instance_id),
        {
          expected_revision,
          config: {
            ...(config.image_presets === undefined ? {} : { image_presets: config.image_presets }),
            ...(config.document_previews === undefined ? {} : { document_previews: config.document_previews }),
            ...(config.video_profile === undefined ? {} : { video_profile: config.video_profile }),
          },
        },
        { operationId: id },
      ), id);
    },
  );

  server.registerTool(
    "almira_collection_lifecycle_replace",
    {
      title: "Replace collection lifecycle policy",
      description: "Set the collection's recycle retention for future deletions using optimistic revision control; existing recycle deadlines are unchanged.",
      inputSchema: z.object({
        ...collectionScope,
        expected_revision: z.number().int().min(1),
        recycle_retention_days: z.number().int().min(1).max(3650),
        operation_id: operationId,
      }).strict(),
      outputSchema,
      annotations: mutationAnnotations,
    },
    async ({
      tenant_id, project_id, environment_id, collection_instance_id,
      expected_revision, recycle_retention_days, operation_id,
    }) => {
      const id = operation_id ?? createOperationId();
      return execute(() => client.replaceCollectionLifecycle(
        collectionReference(tenant_id, project_id, environment_id, collection_instance_id),
        { expected_revision, config: { recycle_retention_days } },
        { operationId: id },
      ), id);
    },
  );

  server.registerTool(
    "almira_collection_protection_get",
    {
      title: "Get collection protection policy",
      description: "Read whether malware scanning is required for future generations in one collection.",
      inputSchema: z.object(collectionScope).strict(),
      outputSchema,
      annotations: readAnnotations,
    },
    async ({ tenant_id, project_id, environment_id, collection_instance_id }) =>
      execute(() => client.getCollectionProtection(
        collectionReference(tenant_id, project_id, environment_id, collection_instance_id),
      )),
  );

  server.registerTool(
    "almira_collection_protection_replace",
    {
      title: "Replace collection protection policy",
      description: "Require or disable FileService malware scanning for new generations only, using optimistic revision control.",
      inputSchema: z.object({
        ...collectionScope,
        expected_revision: z.number().int().min(1),
        malware_scan_required: z.boolean(),
        operation_id: operationId,
      }).strict(),
      outputSchema,
      annotations: mutationAnnotations,
    },
    async ({
      tenant_id, project_id, environment_id, collection_instance_id,
      expected_revision, malware_scan_required, operation_id,
    }) => {
      const id = operation_id ?? createOperationId();
      return execute(() => client.replaceCollectionProtection(
        collectionReference(tenant_id, project_id, environment_id, collection_instance_id),
        { expected_revision, config: { malware_scan_required } },
        { operationId: id },
      ), id);
    },
  );

  server.registerTool(
    "almira_protection_cases_list",
    {
      title: "List protection cases",
      description: "List scan-gated generations across one environment with optional collection and safety-state filters.",
      inputSchema: z.object({
        ...scope,
        environment_id: uuid,
        collection_instance_id: uuid.optional(),
        safety_state: z.enum(["scan_pending", "clean", "blocked"]).optional(),
        ...page,
      }).strict(),
      outputSchema,
      annotations: readAnnotations,
    },
    async ({
      tenant_id, project_id, environment_id, collection_instance_id,
      safety_state, limit, cursor,
    }) => execute(() => client.listProtectionCases(
      { tenantId: tenant_id, projectId: project_id, environmentId: environment_id },
      {
        ...(collection_instance_id === undefined ? {} : { collectionInstanceId: collection_instance_id }),
        ...(safety_state === undefined ? {} : { safetyState: safety_state }),
        ...(limit === undefined ? {} : { limit }),
        ...(cursor === undefined ? {} : { cursor }),
      },
    )),
  );

  server.registerTool(
    "almira_protection_rescan",
    {
      title: "Request exact-generation protection rescan",
      description: "Immediately gate one generation and ask FileService, the verdict authority, to rescan it.",
      inputSchema: z.object({
        ...collectionScope,
        entry_id: uuid,
        generation_id: uuid,
        expected_revision: z.number().int().min(1),
        operation_id: operationId,
      }).strict(),
      outputSchema,
      annotations: mutationAnnotations,
    },
    async ({
      tenant_id, project_id, environment_id, collection_instance_id,
      entry_id, generation_id, expected_revision, operation_id,
    }) => {
      const id = operation_id ?? createOperationId();
      return execute(() => client.requestProtectionRescan(
        {
          ...fileReference(tenant_id, project_id, environment_id, collection_instance_id, entry_id),
          generationId: generation_id,
        },
        { expected_revision },
        { operationId: id },
      ), id);
    },
  );

  server.registerTool(
    "almira_protection_review_create",
    {
      title: "Record protection review",
      description: "Record a content-free blocked-generation review; reviews never release content or override FileService.",
      inputSchema: z.object({
        ...collectionScope,
        entry_id: uuid,
        generation_id: uuid,
        expected_revision: z.number().int().min(1),
        decision: z.enum(["confirmed_blocked", "suspected_false_positive"]),
        reason: protectionReviewReason,
        operation_id: operationId,
      }).strict(),
      outputSchema,
      annotations: mutationAnnotations,
    },
    async ({
      tenant_id, project_id, environment_id, collection_instance_id, entry_id,
      generation_id, expected_revision, decision, reason, operation_id,
    }) => {
      const id = operation_id ?? createOperationId();
      return execute(() => client.createProtectionReview(
        {
          ...fileReference(tenant_id, project_id, environment_id, collection_instance_id, entry_id),
          generationId: generation_id,
        },
        { expected_revision, review: { decision, reason } },
        { operationId: id },
      ), id);
    },
  );

  server.registerTool(
    "almira_processing_jobs_list",
    {
      title: "List media-processing jobs",
      description: "List bounded job status and pinned processor provenance for one collection.",
      inputSchema: z.object({ ...collectionScope, ...page }).strict(),
      outputSchema,
      annotations: readAnnotations,
    },
    async ({ tenant_id, project_id, environment_id, collection_instance_id, limit, cursor }) =>
      execute(() => client.listProcessingJobs(
        collectionReference(tenant_id, project_id, environment_id, collection_instance_id),
        {
          ...(limit === undefined ? {} : { limit }),
          ...(cursor === undefined ? {} : { cursor }),
        },
      )),
  );

  for (const action of ["retry", "cancel"] as const) {
    server.registerTool(
      `almira_processing_job_${action}`,
      {
        title: `${action === "retry" ? "Retry" : "Cancel"} media-processing job`,
        description: action === "retry"
          ? "Retry one failed or cancelled media-processing job using optimistic revision control."
          : "Cancel one pending media-processing job using optimistic revision control.",
        inputSchema: z.object({
          ...collectionScope,
          job_id: uuid,
          expected_revision: z.number().int().min(1),
          operation_id: operationId,
        }).strict(),
        outputSchema,
        annotations: mutationAnnotations,
      },
      async ({ tenant_id, project_id, environment_id, collection_instance_id, job_id, expected_revision, operation_id }) => {
        const id = operation_id ?? createOperationId();
        const reference = {
          ...collectionReference(tenant_id, project_id, environment_id, collection_instance_id),
          jobId: job_id,
        };
        return execute(
          () => action === "retry"
            ? client.retryProcessingJob(reference, { expected_revision }, { operationId: id })
            : client.cancelProcessingJob(reference, { expected_revision }, { operationId: id }),
          id,
        );
      },
    );
  }

  server.registerTool(
    "almira_storage_migration_start",
    {
      title: "Start storage-class migration",
      description: "Start a governed collection migration to an available normal or express storage class and return its durable receipt.",
      inputSchema: z.object({
        ...scope,
        environment_id: uuid,
        collection_instance_id: uuid,
        target_storage_class: z.enum(["normal", "express"]),
        expected_collection_revision: z.number().int().min(1),
        operation_id: operationId,
      }).strict(),
      outputSchema,
      annotations: mutationAnnotations,
    },
    async ({
      tenant_id,
      project_id,
      environment_id,
      collection_instance_id,
      target_storage_class,
      expected_collection_revision,
      operation_id,
    }) => {
      const id = operation_id ?? createOperationId();
      return execute(
        () => client.startStorageMigration(
          {
            tenantId: tenant_id,
            projectId: project_id,
            environmentId: environment_id,
            collectionInstanceId: collection_instance_id,
          },
          { target_storage_class, expected_collection_revision },
          { operationId: id },
        ),
        id,
      );
    },
  );

  server.registerTool(
    "almira_storage_migration_get",
    {
      title: "Get storage-migration status",
      description: "Read the durable inventory, copy, verification, cutover, cleanup, or terminal migration receipt.",
      inputSchema: z.object({
        ...scope,
        environment_id: uuid,
        collection_instance_id: uuid,
        migration_id: uuid,
      }).strict(),
      outputSchema,
      annotations: readAnnotations,
    },
    async ({ tenant_id, project_id, environment_id, collection_instance_id, migration_id }) =>
      execute(() => client.getStorageMigration({
        tenantId: tenant_id,
        projectId: project_id,
        environmentId: environment_id,
        collectionInstanceId: collection_instance_id,
        migrationId: migration_id,
      })),
  );

  server.registerTool(
    "almira_collection_import_start",
    {
      title: "Start collection import",
      description: "Start a governed import from a FileService-issued opaque source binding and bounded credential-free manifest.",
      inputSchema: z.object({
        ...collectionScope,
        request: importRequest,
        operation_id: operationId,
      }).strict(),
      outputSchema,
      annotations: mutationAnnotations,
    },
    async ({ tenant_id, project_id, environment_id, collection_instance_id, request, operation_id }) => {
      const id = operation_id ?? createOperationId();
      return execute(() => client.startCollectionImport(
        collectionReference(tenant_id, project_id, environment_id, collection_instance_id),
        request as StartCollectionImportRequest,
        { operationId: id },
      ), id);
    },
  );

  server.registerTool(
    "almira_collection_export_start",
    {
      title: "Start collection export",
      description: "Start a portable export containing only retained, available, safety-admitted generations and derivatives.",
      inputSchema: z.object({
        ...collectionScope,
        expected_collection_revision: z.number().int().min(1),
        operation_id: operationId,
      }).strict(),
      outputSchema,
      annotations: mutationAnnotations,
    },
    async ({
      tenant_id,
      project_id,
      environment_id,
      collection_instance_id,
      expected_collection_revision,
      operation_id,
    }) => {
      const id = operation_id ?? createOperationId();
      return execute(() => client.startCollectionExport(
        collectionReference(tenant_id, project_id, environment_id, collection_instance_id),
        { expected_collection_revision },
        { operationId: id },
      ), id);
    },
  );

  server.registerTool(
    "almira_portability_jobs_list",
    {
      title: "List portability jobs",
      description: "List durable collection import and export progress without transfer credentials.",
      inputSchema: z.object({
        ...collectionScope,
        kind: z.enum(["import", "export"]).optional(),
        ...page,
      }).strict(),
      outputSchema,
      annotations: readAnnotations,
    },
    async ({ tenant_id, project_id, environment_id, collection_instance_id, kind, cursor, limit }) =>
      execute(() => client.listPortabilityJobs(
        collectionReference(tenant_id, project_id, environment_id, collection_instance_id),
        {
          ...(kind === undefined ? {} : { kind }),
          ...(cursor === undefined ? {} : { cursor }),
          ...(limit === undefined ? {} : { limit }),
        },
      )),
  );

  server.registerTool(
    "almira_portability_job_get",
    {
      title: "Get portability job",
      description: "Read durable import or export progress and its terminal credential-free receipt.",
      inputSchema: z.object({ ...collectionScope, portability_job_id: uuid }).strict(),
      outputSchema,
      annotations: readAnnotations,
    },
    async ({ tenant_id, project_id, environment_id, collection_instance_id, portability_job_id }) =>
      execute(() => client.getPortabilityJob({
        ...collectionReference(tenant_id, project_id, environment_id, collection_instance_id),
        jobId: portability_job_id,
      })),
  );

  server.registerTool(
    "almira_portability_export_download",
    {
      title: "Download portable export",
      description: "Consume a fresh one-use export instruction, stream and verify it, and create a new local file without returning transfer secrets.",
      inputSchema: z.object({
        ...collectionScope,
        portability_job_id: uuid,
        output_path: outputPath,
        operation_id: operationId,
      }).strict(),
      outputSchema,
      annotations: transferAnnotations,
    },
    async ({
      tenant_id,
      project_id,
      environment_id,
      collection_instance_id,
      portability_job_id,
      output_path,
      operation_id,
    }) => {
      const id = operation_id ?? createOperationId();
      const reference = {
        ...collectionReference(tenant_id, project_id, environment_id, collection_instance_id),
        jobId: portability_job_id,
      };
      return execute(async () => {
        const descriptor = await client.createPortabilityExportDownload(reference, { operationId: id });
        const stream = await openPortableExport(descriptor, {
          ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
        });
        await savePortableExport(output_path, descriptor.descriptor_id, stream);
        return {
          job_id: portability_job_id,
          output_path,
          size_bytes: stream.sizeBytes,
          content_sha256: stream.contentSha256,
        };
      }, id);
    },
  );

  server.registerTool(
    "almira_file_list",
    {
      title: "List Almira files",
      description: "List a deterministic metadata page in one collection; no file bytes or transfer secrets are returned.",
      inputSchema: z
        .object({
          ...scope,
          environment_id: uuid,
          collection_instance_id: uuid,
          path_prefix: z.string().min(1).max(1024).optional(),
          include_deleted: z.boolean().optional(),
          tag: metadataComponent.optional(),
          metadata_key: metadataComponent.optional(),
          metadata_value: customMetadataValue.optional(),
          verified_media_type: z.string().min(3).max(127).optional(),
          minimum_size_bytes: z.number().int().min(1).max(10_737_418_240).optional(),
          maximum_size_bytes: z.number().int().min(1).max(10_737_418_240).optional(),
          created_after: z.string().datetime({ offset: true }).optional(),
          created_before: z.string().datetime({ offset: true }).optional(),
          extraction_kind: extractionKind.optional(),
          extraction_state: extractionState.optional(),
          ...page,
        }).strict()
        .refine((value) => (value.metadata_key === undefined) === (value.metadata_value === undefined), {
          message: "metadata_key and metadata_value must be supplied together",
        })
        .refine((value) => (value.extraction_kind === undefined) === (value.extraction_state === undefined), {
          message: "extraction_kind and extraction_state must be supplied together",
        })
        .refine((value) => value.minimum_size_bytes === undefined || value.maximum_size_bytes === undefined || value.minimum_size_bytes <= value.maximum_size_bytes, {
          message: "minimum_size_bytes cannot exceed maximum_size_bytes",
        }),
      outputSchema,
      annotations: readAnnotations,
    },
    async ({
      tenant_id, project_id, environment_id, collection_instance_id, path_prefix, include_deleted,
      tag, metadata_key, metadata_value, verified_media_type, minimum_size_bytes, maximum_size_bytes,
      created_after, created_before, extraction_kind, extraction_state, limit, cursor,
    }) =>
      execute(() =>
        client.listFiles(
          {
            tenantId: tenant_id,
            projectId: project_id,
            environmentId: environment_id,
            collectionInstanceId: collection_instance_id,
          },
          {
            ...(path_prefix === undefined ? {} : { pathPrefix: path_prefix }),
            ...(include_deleted === undefined ? {} : { includeDeleted: include_deleted }),
            ...(tag === undefined ? {} : { tag }),
            ...(metadata_key === undefined ? {} : { metadataKey: metadata_key }),
            ...(metadata_value === undefined ? {} : { metadataValue: metadata_value }),
            ...(verified_media_type === undefined ? {} : { verifiedMediaType: verified_media_type }),
            ...(minimum_size_bytes === undefined ? {} : { minimumSizeBytes: minimum_size_bytes }),
            ...(maximum_size_bytes === undefined ? {} : { maximumSizeBytes: maximum_size_bytes }),
            ...(created_after === undefined ? {} : { createdAfter: created_after }),
            ...(created_before === undefined ? {} : { createdBefore: created_before }),
            ...(extraction_kind === undefined ? {} : { extractionKind: extraction_kind }),
            ...(extraction_state === undefined ? {} : { extractionState: extraction_state }),
            ...(limit === undefined ? {} : { limit }),
            ...(cursor === undefined ? {} : { cursor }),
          },
        ),
      ),
  );

  server.registerTool(
    "almira_file_search",
    {
      title: "Search Almira files",
      description: "Search one collection using lexical, semantic, or hybrid retrieval; every hit is rechecked against current PostgreSQL lifecycle, safety, generation, metadata, and authorization state.",
      inputSchema: z.object({ ...collectionScope, ...searchInput.shape }).strict(),
      outputSchema,
      annotations: readAnnotations,
    },
    async ({
      tenant_id, project_id, environment_id, collection_instance_id,
      query, mode, path_prefix, filter, facets, page_size, cursor,
    }) => execute(() => client.searchFiles(
      collectionReference(tenant_id, project_id, environment_id, collection_instance_id),
      {
        query,
        ...(mode === undefined ? {} : { mode }),
        ...(path_prefix === undefined ? {} : { path_prefix }),
        ...(filter === undefined ? {} : { filter: filter as NonNullable<SearchInput["filter"]> }),
        ...(facets === undefined ? {} : { facets: facets as NonNullable<SearchInput["facets"]> }),
        ...(page_size === undefined ? {} : { page_size }),
        ...(cursor === undefined ? {} : { cursor }),
      },
    )),
  );

  server.registerTool(
    "almira_file_versions_list",
    {
      title: "List Almira file versions",
      description: "List immutable generations for one stable file entry, newest first.",
      inputSchema: z.object({
        ...collectionScope,
        entry_id: uuid,
        ...page,
      }).strict(),
      outputSchema,
      annotations: readAnnotations,
    },
    async ({ tenant_id, project_id, environment_id, collection_instance_id, entry_id, limit, cursor }) =>
      execute(() => client.listFileGenerations(
        fileReference(tenant_id, project_id, environment_id, collection_instance_id, entry_id),
        {
          ...(limit === undefined ? {} : { limit }),
          ...(cursor === undefined ? {} : { cursor }),
        },
      )),
  );

  server.registerTool(
    "almira_file_metadata_get",
    {
      title: "Get Almira file metadata",
      description: "Read safe metadata for one file entry.",
      inputSchema: z
        .object({
          ...scope,
          environment_id: uuid,
          collection_instance_id: uuid,
          entry_id: uuid,
        })
        .strict(),
      outputSchema,
      annotations: readAnnotations,
    },
    async ({ tenant_id, project_id, environment_id, collection_instance_id, entry_id }) =>
      execute(() =>
        client.getFileMetadata({
          tenantId: tenant_id,
          projectId: project_id,
          environmentId: environment_id,
          collectionInstanceId: collection_instance_id,
          entryId: entry_id,
        }),
      ),
  );

  server.registerTool(
    "almira_file_customer_metadata_get",
    {
      title: "Get customer file metadata",
      description: "Read the bounded customer-owned tags and typed metadata namespace for one stable file entry.",
      inputSchema: z.object({ ...collectionScope, entry_id: uuid }).strict(),
      outputSchema,
      annotations: readAnnotations,
    },
    async ({ tenant_id, project_id, environment_id, collection_instance_id, entry_id }) =>
      execute(() => client.getEntryMetadata(
        fileReference(tenant_id, project_id, environment_id, collection_instance_id, entry_id),
      )),
  );

  server.registerTool(
    "almira_file_customer_metadata_replace",
    {
      title: "Replace customer file metadata",
      description: "Replace bounded tags and typed customer metadata using optimistic revision control.",
      inputSchema: z.object({
        ...collectionScope,
        entry_id: uuid,
        expected_revision: z.number().int().min(1),
        metadata: customerMetadata,
        operation_id: operationId,
      }).strict(),
      outputSchema,
      annotations: mutationAnnotations,
    },
    async ({ tenant_id, project_id, environment_id, collection_instance_id, entry_id, expected_revision, metadata, operation_id }) => {
      const id = operation_id ?? createOperationId();
      return execute(() => client.replaceEntryMetadata(
        fileReference(tenant_id, project_id, environment_id, collection_instance_id, entry_id),
        { expected_revision, metadata },
        { operationId: id },
      ), id);
    },
  );

  server.registerTool(
    "almira_file_extraction_get",
    {
      title: "Get file extraction status",
      description: "Read safe status and provenance for one exact immutable generation and extraction kind; raw content is excluded.",
      inputSchema: z.object({ ...collectionScope, entry_id: uuid, generation_id: uuid, kind: extractionKind }).strict(),
      outputSchema,
      annotations: readAnnotations,
    },
    async ({ tenant_id, project_id, environment_id, collection_instance_id, entry_id, generation_id, kind }) =>
      execute(() => client.getGenerationExtraction({
        ...fileReference(tenant_id, project_id, environment_id, collection_instance_id, entry_id),
        generationId: generation_id,
        kind,
      })),
  );

  server.registerTool(
    "almira_file_extracted_content_get",
    {
      title: "Get protected extracted content",
      description: "Read separately authorized content, OCR, or transcription text for one exact immutable generation.",
      inputSchema: z.object({ ...collectionScope, entry_id: uuid, generation_id: uuid, kind: protectedExtractionKind }).strict(),
      outputSchema,
      annotations: readAnnotations,
    },
    async ({ tenant_id, project_id, environment_id, collection_instance_id, entry_id, generation_id, kind }) =>
      execute(() => client.getExtractedContent({
        ...fileReference(tenant_id, project_id, environment_id, collection_instance_id, entry_id),
        generationId: generation_id,
        kind,
      })),
  );

  server.registerTool(
    "almira_file_derivatives_list",
    {
      title: "List file derivatives",
      description: "List ready, immutable derivative metadata for one exact source generation.",
      inputSchema: z.object({ ...collectionScope, entry_id: uuid, generation_id: uuid }).strict(),
      outputSchema,
      annotations: readAnnotations,
    },
    async ({ tenant_id, project_id, environment_id, collection_instance_id, entry_id, generation_id }) =>
      execute(() => client.listGenerationDerivatives({
        ...fileReference(tenant_id, project_id, environment_id, collection_instance_id, entry_id),
        generationId: generation_id,
      })),
  );

  server.registerTool(
    "almira_file_batch",
    {
      title: "Mutate Almira files atomically",
      description: "Apply up to 100 independent revision-bound rename, version-selection, delete, or restore actions as one atomic collection mutation.",
      inputSchema: z.object({
        ...collectionScope,
        actions: fileBatchActions,
        operation_id: operationId,
      }).strict(),
      outputSchema,
      annotations: deleteAnnotations,
    },
    async ({ tenant_id, project_id, environment_id, collection_instance_id, actions, operation_id }) => {
      const id = operation_id ?? createOperationId();
      return execute(() => client.mutateFilesBatch(
        { tenantId: tenant_id, projectId: project_id, environmentId: environment_id, collectionInstanceId: collection_instance_id },
        { actions },
        { operationId: id },
      ), id);
    },
  );

  server.registerTool(
    "almira_file_copy",
    {
      title: "Copy an Almira file generation",
      description: "Create an independent server-side copy of one exact available retained generation at a new path. No file bytes or provider credentials pass through the agent.",
      inputSchema: z.object({
        ...collectionScope,
        source_entry_id: uuid,
        source_generation_id: uuid,
        destination_path: logicalPath,
        expected_source_revision: z.number().int().min(1),
        operation_id: operationId,
      }).strict(),
      outputSchema,
      annotations: mutationAnnotations,
    },
    async ({ tenant_id, project_id, environment_id, collection_instance_id, source_entry_id, source_generation_id, destination_path, expected_source_revision, operation_id }) => {
      const id = operation_id ?? createOperationId();
      return execute(() => client.copyFile(
        { tenantId: tenant_id, projectId: project_id, environmentId: environment_id, collectionInstanceId: collection_instance_id },
        { source_entry_id, source_generation_id, destination_path, expected_source_revision },
        { operationId: id },
      ), id);
    },
  );

  server.registerTool(
    "almira_verification_receipt_create",
    {
      title: "Verify an Almira file flow",
      description: "Replay finalization, hash the exact private generation, prove cross-environment refusal and safety, then issue a signed contract-bound receipt.",
      inputSchema: z.object({
        ...collectionScope,
        transfer_session_id: uuid,
        finalize_operation_id: uuid,
        entry_id: uuid,
        generation_id: uuid,
        refusal_environment_id: uuid,
        completion: directUploadCompletion,
      }).strict().refine((value) => value.environment_id !== value.refusal_environment_id, {
        message: "refusal_environment_id must differ from environment_id",
      }),
      outputSchema,
      annotations: mutationAnnotations,
    },
    async ({
      tenant_id,
      project_id,
      environment_id,
      collection_instance_id,
      transfer_session_id,
      finalize_operation_id,
      entry_id,
      generation_id,
      refusal_environment_id,
      completion,
    }) => {
      return execute(() => client.createVerificationReceipt(
        collectionReference(tenant_id, project_id, environment_id, collection_instance_id),
        {
          transfer_session_id,
          finalize_operation_id,
          entry_id,
          generation_id,
          refusal_environment_id,
          completion: {
            ...completion,
            content_sha256: completion.content_sha256 as `sha256:${string}`,
          },
        },
      ));
    },
  );

  server.registerTool(
    "almira_file_delete",
    {
      title: "Delete Almira file",
      description: "Soft-delete one file entry using optimistic revision control.",
      inputSchema: z
        .object({
          ...scope,
          environment_id: uuid,
          collection_instance_id: uuid,
          entry_id: uuid,
          expected_revision: z.number().int().min(1),
          operation_id: operationId,
        })
        .strict(),
      outputSchema,
      annotations: deleteAnnotations,
    },
    async ({
      project_id,
      tenant_id,
      environment_id,
      collection_instance_id,
      entry_id,
      expected_revision,
      operation_id,
    }) => {
      const id = operation_id ?? createOperationId();
      return execute(
        () =>
          client.deleteFile(
            {
              tenantId: tenant_id,
              projectId: project_id,
              environmentId: environment_id,
              collectionInstanceId: collection_instance_id,
              entryId: entry_id,
            },
            expected_revision,
            { operationId: id },
          ),
        id,
      );
    },
  );

  server.registerTool(
    "almira_file_rename",
    {
      title: "Rename Almira file",
      description: "Rename or move one stable file identity without copying its generations.",
      inputSchema: z.object({
        ...collectionScope,
        entry_id: uuid,
        logical_path: z.string().min(1).max(1024),
        expected_revision: z.number().int().min(1),
        operation_id: operationId,
      }).strict(),
      outputSchema,
      annotations: mutationAnnotations,
    },
    async ({ tenant_id, project_id, environment_id, collection_instance_id, entry_id, logical_path, expected_revision, operation_id }) => {
      const id = operation_id ?? createOperationId();
      return execute(() => client.renameFile(
        fileReference(tenant_id, project_id, environment_id, collection_instance_id, entry_id),
        { logical_path, expected_revision },
        { operationId: id },
      ), id);
    },
  );

  server.registerTool(
    "almira_file_generation_restore",
    {
      title: "Select Almira file version",
      description: "Make one retained immutable generation current for its stable file identity.",
      inputSchema: z.object({
        ...collectionScope,
        entry_id: uuid,
        generation_id: uuid,
        expected_revision: z.number().int().min(1),
        operation_id: operationId,
      }).strict(),
      outputSchema,
      annotations: mutationAnnotations,
    },
    async ({ tenant_id, project_id, environment_id, collection_instance_id, entry_id, generation_id, expected_revision, operation_id }) => {
      const id = operation_id ?? createOperationId();
      return execute(() => client.restoreFileGeneration(
        fileReference(tenant_id, project_id, environment_id, collection_instance_id, entry_id),
        { generation_id, expected_revision },
        { operationId: id },
      ), id);
    },
  );

  server.registerTool(
    "almira_file_restore",
    {
      title: "Restore Almira file",
      description: "Restore one file entry that is still inside its recycle window.",
      inputSchema: z.object({
        ...collectionScope,
        entry_id: uuid,
        expected_revision: z.number().int().min(1),
        operation_id: operationId,
      }).strict(),
      outputSchema,
      annotations: mutationAnnotations,
    },
    async ({ tenant_id, project_id, environment_id, collection_instance_id, entry_id, expected_revision, operation_id }) => {
      const id = operation_id ?? createOperationId();
      return execute(() => client.restoreFile(
        fileReference(tenant_id, project_id, environment_id, collection_instance_id, entry_id),
        { expected_revision },
        { operationId: id },
      ), id);
    },
  );

  server.registerTool(
    "almira_policy_get",
    {
      title: "Get collection access policy",
      description: "Read the effective versioned access policy for one collection.",
      inputSchema: z.object(collectionScope).strict(),
      outputSchema,
      annotations: readAnnotations,
    },
    async ({ tenant_id, project_id, environment_id, collection_instance_id }) => execute(() =>
      client.getCollectionPolicy(collectionReference(tenant_id, project_id, environment_id, collection_instance_id))),
  );

  server.registerTool(
    "almira_policy_replace",
    {
      title: "Replace collection access policy",
      description: "Replace the complete versioned access policy for one collection.",
      inputSchema: z.object({
        ...collectionScope,
        expected_revision: z.number().int().min(1),
        document: accessPolicyDocument,
        operation_id: operationId,
      }).strict(),
      outputSchema,
      annotations: mutationAnnotations,
    },
    async ({ tenant_id, project_id, environment_id, collection_instance_id, expected_revision, document, operation_id }) => {
      const id = operation_id ?? createOperationId();
      return execute(() => client.replaceCollectionPolicy(
        collectionReference(tenant_id, project_id, environment_id, collection_instance_id),
        { expected_revision, document },
        { operationId: id },
      ), id);
    },
  );

  server.registerTool(
    "almira_policy_simulate",
    {
      title: "Simulate collection access",
      description: "Evaluate one proposed principal, operation, and target against the active policy without changing it.",
      inputSchema: z.object({ ...collectionScope, simulation: accessSimulation, operation_id: operationId }).strict(),
      outputSchema,
      annotations: readAnnotations,
    },
    async ({ tenant_id, project_id, environment_id, collection_instance_id, simulation, operation_id }) => {
      const id = operation_id ?? createOperationId();
      return execute(() => client.simulateCollectionPolicy(
        collectionReference(tenant_id, project_id, environment_id, collection_instance_id),
        simulation,
        { operationId: id },
      ), id);
    },
  );

  server.registerTool(
    "almira_delivery_get",
    {
      title: "Get CDN delivery configuration",
      description: "Read the collection's effective CDN delivery, cache, and domain configuration.",
      inputSchema: z.object(collectionScope).strict(),
      outputSchema,
      annotations: readAnnotations,
    },
    async ({ tenant_id, project_id, environment_id, collection_instance_id }) => execute(() =>
      client.getDeliveryConfig(collectionReference(tenant_id, project_id, environment_id, collection_instance_id))),
  );

  server.registerTool(
    "almira_delivery_replace",
    {
      title: "Replace CDN delivery configuration",
      description: "Replace a collection's governed CDN mode and cache preset.",
      inputSchema: z.object({
        ...collectionScope,
        expected_revision: z.number().int().min(1),
        config: deliveryConfig,
        operation_id: operationId,
      }).strict(),
      outputSchema,
      annotations: mutationAnnotations,
    },
    async ({ tenant_id, project_id, environment_id, collection_instance_id, expected_revision, config, operation_id }) => {
      const id = operation_id ?? createOperationId();
      return execute(() => client.replaceDeliveryConfig(
        collectionReference(tenant_id, project_id, environment_id, collection_instance_id),
        { expected_revision, config },
        { operationId: id },
      ), id);
    },
  );

  server.registerTool(
    "almira_share_create",
    {
      title: "Create file share",
      description: "Create one bounded, revocable URL for an immutable file generation.",
      inputSchema: z.object({
        ...collectionScope,
        entry_id: uuid,
        generation_id: uuid,
        lifetime_seconds: z.number().int().min(60).max(604800),
        subject: builderSubject.nullable().optional(),
        operation_id: operationId,
      }).strict(),
      outputSchema,
      annotations: mutationAnnotations,
    },
    async ({ tenant_id, project_id, environment_id, collection_instance_id, entry_id, generation_id, lifetime_seconds, subject, operation_id }) => {
      const id = operation_id ?? createOperationId();
      return execute(() => client.createShare(
        collectionReference(tenant_id, project_id, environment_id, collection_instance_id),
        { entry_id, generation_id, lifetime_seconds, ...(subject === undefined ? {} : { subject }) },
        { operationId: id },
      ), id);
    },
  );

  server.registerTool(
    "almira_share_revoke",
    {
      title: "Revoke file share",
      description: "Immediately revoke one share URL.",
      inputSchema: z.object({ ...collectionScope, share_id: uuid, operation_id: operationId }).strict(),
      outputSchema,
      annotations: deleteAnnotations,
    },
    async ({ tenant_id, project_id, environment_id, collection_instance_id, share_id, operation_id }) => {
      const id = operation_id ?? createOperationId();
      return execute(() => client.revokeShare({
        ...collectionReference(tenant_id, project_id, environment_id, collection_instance_id),
        shareId: share_id,
      }, { operationId: id }), id);
    },
  );

  server.registerTool(
    "almira_local_issuer_list",
    {
      title: "List local capability issuers",
      description: "List the registered public keys and ceilings for one collection.",
      inputSchema: z.object(collectionScope).strict(),
      outputSchema,
      annotations: readAnnotations,
    },
    async ({ tenant_id, project_id, environment_id, collection_instance_id }) => execute(() =>
      client.listLocalIssuers(collectionReference(tenant_id, project_id, environment_id, collection_instance_id))),
  );

  server.registerTool(
    "almira_local_issuer_register",
    {
      title: "Register local capability issuer",
      description: "Register an Ed25519 public key and bounded capability ceiling; private key material never enters Almira.",
      inputSchema: z.object({
        ...collectionScope,
        issuer_key: z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/u),
        display_name: z.string().min(1).max(120),
        public_key: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
        key_protection: z.enum(["cloud_kms", "hardware_backed"]),
        ceiling: localIssuerCeiling,
        operation_id: operationId,
      }).strict(),
      outputSchema,
      annotations: mutationAnnotations,
    },
    async ({ tenant_id, project_id, environment_id, collection_instance_id, operation_id, ...request }) => {
      const id = operation_id ?? createOperationId();
      return execute(() => client.registerLocalIssuer(
        collectionReference(tenant_id, project_id, environment_id, collection_instance_id),
        request,
        { operationId: id },
      ), id);
    },
  );

  server.registerTool(
    "almira_local_issuer_rotate",
    {
      title: "Rotate local issuer key",
      description: "Replace a local issuer public key using optimistic revision control.",
      inputSchema: z.object({
        ...collectionScope,
        issuer_id: uuid,
        expected_revision: z.number().int().min(1),
        public_key: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
        key_protection: z.enum(["cloud_kms", "hardware_backed"]),
        operation_id: operationId,
      }).strict(),
      outputSchema,
      annotations: mutationAnnotations,
    },
    async ({ tenant_id, project_id, environment_id, collection_instance_id, issuer_id, operation_id, ...request }) => {
      const id = operation_id ?? createOperationId();
      return execute(() => client.rotateLocalIssuerKey({
        ...collectionReference(tenant_id, project_id, environment_id, collection_instance_id), issuerId: issuer_id,
      }, request, { operationId: id }), id);
    },
  );

  server.registerTool(
    "almira_local_issuer_revoke",
    {
      title: "Revoke local capability issuer",
      description: "Revoke a local issuer and all future use of its signing authority.",
      inputSchema: z.object({
        ...collectionScope,
        issuer_id: uuid,
        expected_revision: z.number().int().min(1),
        operation_id: operationId,
      }).strict(),
      outputSchema,
      annotations: deleteAnnotations,
    },
    async ({ tenant_id, project_id, environment_id, collection_instance_id, issuer_id, expected_revision, operation_id }) => {
      const id = operation_id ?? createOperationId();
      return execute(() => client.revokeLocalIssuer({
        ...collectionReference(tenant_id, project_id, environment_id, collection_instance_id), issuerId: issuer_id,
      }, expected_revision, { operationId: id }), id);
    },
  );

  server.registerTool(
    "almira_local_issuer_signing_configuration_get",
    {
      title: "Get local issuer signing configuration",
      description: "Read the non-secret, revision-bound inputs needed to construct local capability claims.",
      inputSchema: z.object({ ...collectionScope, issuer_id: uuid }).strict(),
      outputSchema,
      annotations: readAnnotations,
    },
    async ({ tenant_id, project_id, environment_id, collection_instance_id, issuer_id }) => execute(() =>
      client.getLocalIssuerSigningConfiguration({
        ...collectionReference(tenant_id, project_id, environment_id, collection_instance_id), issuerId: issuer_id,
      })),
  );

  return server;
}

function collectionReference(
  tenantId: string,
  projectId: string,
  environmentId: string,
  collectionInstanceId: string,
) {
  return { tenantId, projectId, environmentId, collectionInstanceId };
}

function fileReference(
  tenantId: string,
  projectId: string,
  environmentId: string,
  collectionInstanceId: string,
  entryId: string,
) {
  return { tenantId, projectId, environmentId, collectionInstanceId, entryId };
}

class McpDownloadError extends Error {
  readonly code:
    | "ALMIRA_MCP_OUTPUT_EXISTS"
    | "ALMIRA_MCP_OUTPUT_INVALID"
    | "ALMIRA_MCP_OUTPUT_WRITE_FAILED";

  constructor(code: McpDownloadError["code"]) {
    super(code);
    this.code = code;
  }
}

async function savePortableExport(
  output: string,
  descriptorId: string,
  stream: PortableExportStream,
): Promise<void> {
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
      throw new McpDownloadError("ALMIRA_MCP_OUTPUT_INVALID");
    }
    await link(temporary, output);
    await unlink(temporary).catch(() => undefined);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    if (error instanceof McpDownloadError) throw error;
    if (isFileSystemError(error) && error.code === "EEXIST") {
      throw new McpDownloadError("ALMIRA_MCP_OUTPUT_EXISTS");
    }
    throw new McpDownloadError("ALMIRA_MCP_OUTPUT_WRITE_FAILED");
  }
}

function isFileSystemError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function execute(call: () => Promise<unknown>, operationId?: string) {
  try {
    const result = await call();
    const structuredContent = {
      ...(operationId === undefined ? {} : { operation_id: operationId }),
      result,
    };
    return {
      content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
      structuredContent,
    };
  } catch (error) {
    const safe = safeError(error, operationId);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(safe) }],
      isError: true,
    };
  }
}

function safeError(error: unknown, operationId?: string): Record<string, unknown> {
  if (error instanceof AlmiraApiError) {
    return {
      code: error.code,
      request_id: error.requestId,
      status: error.status,
      retry_after_milliseconds: error.retryAfterMilliseconds,
      ...(operationId === undefined ? {} : { operation_id: operationId }),
    };
  }
  if (error instanceof AlmiraClientError) {
    return {
      code: error.code,
      ...(operationId === undefined ? {} : { operation_id: operationId }),
    };
  }
  if (error instanceof AlmiraConfigurationError) {
    return {
      code: error.code,
      ...(operationId === undefined ? {} : { operation_id: operationId }),
      ...(error.plan === null ? {} : { plan: error.plan }),
    };
  }
  if (error instanceof AlmiraTransferError) {
    return {
      code: error.code,
      ...(operationId === undefined ? {} : { operation_id: operationId }),
    };
  }
  if (error instanceof McpDownloadError) {
    return {
      code: error.code,
      ...(operationId === undefined ? {} : { operation_id: operationId }),
    };
  }
  return {
    code: "ALMIRA_MCP_INTERNAL",
    ...(operationId === undefined ? {} : { operation_id: operationId }),
  };
}
