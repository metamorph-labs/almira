import { McpServer } from "@modelcontextprotocol/server";
import {
  AlmiraApiError,
  AlmiraClient,
  AlmiraClientError,
  AlmiraConfigurationError,
  applyConfiguration,
  createOperationId,
  previewConfiguration,
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
const configurationCollection = z.object({
  key: z.string().regex(/^[a-z]([a-z0-9_-]{0,62}[a-z0-9])?$/u),
  display_name: environmentDisplayName,
  malware_scan_required: z.boolean(),
  storage_class: z.enum(["normal", "express"]).optional(),
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

const outputSchema = z
  .object({
    operation_id: uuid.optional(),
    result: z.unknown(),
  })
  .strict();

/** Creates one stdio-safe MCP server over the canonical Almira SDK client. */
export function createAlmiraMcpServer(client: AlmiraClient): McpServer {
  const server = new McpServer({ name: "almira", version: "0.1.0-dev.17" });

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
          ...page,
        })
        .strict(),
      outputSchema,
      annotations: readAnnotations,
    },
    async ({ tenant_id, project_id, environment_id, collection_instance_id, path_prefix, limit, cursor }) =>
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
            ...(limit === undefined ? {} : { limit }),
            ...(cursor === undefined ? {} : { cursor }),
          },
        ),
      ),
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

  return server;
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
  return {
    code: "ALMIRA_MCP_INTERNAL",
    ...(operationId === undefined ? {} : { operation_id: operationId }),
  };
}
