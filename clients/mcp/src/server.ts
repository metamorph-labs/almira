import { McpServer } from "@modelcontextprotocol/server";
import {
  AlmiraApiError,
  AlmiraClient,
  AlmiraClientError,
  createOperationId,
} from "@metamorph-labs/almira-sdk";
import * as z from "zod/v4";

const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
const operationId = uuid.optional().describe("UUIDv7 to reuse after an ambiguous mutation outcome");
const page = {
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.number().int().min(1).max(100).optional(),
};

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
  const server = new McpServer({ name: "almira", version: "0.1.0-dev.6" });

  server.registerTool(
    "almira_project_bootstrap",
    {
      title: "Bootstrap Almira project",
      description: "Converge Almira's default development and production environments for one existing Metamorph project.",
      inputSchema: z.object({ project_id: uuid, operation_id: operationId }).strict(),
      outputSchema,
      annotations: mutationAnnotations,
    },
    async ({ project_id, operation_id }) => {
      const id = operation_id ?? createOperationId();
      return execute(() => client.bootstrapProject({ projectId: project_id }, { operationId: id }), id);
    },
  );

  server.registerTool(
    "almira_environment_list",
    {
      title: "List Almira environments",
      description: "List the complete bounded environment set for one Almira project.",
      inputSchema: z.object({ project_id: uuid }).strict(),
      outputSchema,
      annotations: readAnnotations,
    },
    async ({ project_id }) => execute(() => client.listEnvironments({ projectId: project_id })),
  );

  server.registerTool(
    "almira_browser_origins_get",
    {
      title: "Get browser origins",
      description: "Read the canonical browser-origin policy for one environment.",
      inputSchema: z.object({ project_id: uuid, environment_id: uuid }).strict(),
      outputSchema,
      annotations: readAnnotations,
    },
    async ({ project_id, environment_id }) =>
      execute(() => client.getBrowserOrigins({ projectId: project_id, environmentId: environment_id })),
  );

  server.registerTool(
    "almira_browser_origins_replace",
    {
      title: "Replace browser origins",
      description: "Replace an environment's complete browser-origin policy using optimistic revision control.",
      inputSchema: z
        .object({
          project_id: uuid,
          environment_id: uuid,
          expected_revision: z.number().int().min(1),
          origins: z.array(z.string().min(1).max(255)).max(32),
          operation_id: operationId,
        })
        .strict(),
      outputSchema,
      annotations: mutationAnnotations,
    },
    async ({ project_id, environment_id, expected_revision, origins, operation_id }) => {
      const id = operation_id ?? createOperationId();
      return execute(
        () =>
          client.replaceBrowserOrigins(
            { projectId: project_id, environmentId: environment_id },
            { expected_revision, origins },
            { operationId: id },
          ),
        id,
      );
    },
  );

  server.registerTool(
    "almira_collection_list",
    {
      title: "List Almira collections",
      description: "List a deterministic page of collections in one environment.",
      inputSchema: z.object({ project_id: uuid, environment_id: uuid, ...page }).strict(),
      outputSchema,
      annotations: readAnnotations,
    },
    async ({ project_id, environment_id, limit, cursor }) =>
      execute(() =>
        client.listCollections(
          { projectId: project_id, environmentId: environment_id },
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
      description: "Create one private normal collection with explicit malware-scanning policy.",
      inputSchema: z
        .object({
          project_id: uuid,
          environment_id: uuid,
          collection_key: z.string().min(1).max(64),
          display_name: z.string().min(1).max(80),
          malware_scan_required: z.boolean(),
          operation_id: operationId,
        })
        .strict(),
      outputSchema,
      annotations: mutationAnnotations,
    },
    async ({
      project_id,
      environment_id,
      collection_key,
      display_name,
      malware_scan_required,
      operation_id,
    }) => {
      const id = operation_id ?? createOperationId();
      return execute(
        () =>
          client.createCollection(
            { projectId: project_id, environmentId: environment_id },
            { collection_key, display_name, malware_scan_required },
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
        .object({ project_id: uuid, environment_id: uuid, collection_instance_id: uuid })
        .strict(),
      outputSchema,
      annotations: readAnnotations,
    },
    async ({ project_id, environment_id, collection_instance_id }) =>
      execute(() =>
        client.getCollection({
          projectId: project_id,
          environmentId: environment_id,
          collectionInstanceId: collection_instance_id,
        }),
      ),
  );

  server.registerTool(
    "almira_file_list",
    {
      title: "List Almira files",
      description: "List a deterministic metadata page in one collection; no file bytes or transfer secrets are returned.",
      inputSchema: z
        .object({
          project_id: uuid,
          environment_id: uuid,
          collection_instance_id: uuid,
          path_prefix: z.string().min(1).max(1024).optional(),
          ...page,
        })
        .strict(),
      outputSchema,
      annotations: readAnnotations,
    },
    async ({ project_id, environment_id, collection_instance_id, path_prefix, limit, cursor }) =>
      execute(() =>
        client.listFiles(
          {
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
          project_id: uuid,
          environment_id: uuid,
          collection_instance_id: uuid,
          entry_id: uuid,
        })
        .strict(),
      outputSchema,
      annotations: readAnnotations,
    },
    async ({ project_id, environment_id, collection_instance_id, entry_id }) =>
      execute(() =>
        client.getFileMetadata({
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
          project_id: uuid,
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
  return {
    code: "ALMIRA_MCP_INTERNAL",
    ...(operationId === undefined ? {} : { operation_id: operationId }),
  };
}
