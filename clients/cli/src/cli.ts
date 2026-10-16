import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";

import {
  AlmiraApiError,
  AlmiraClient,
  AlmiraClientError,
  AlmiraConfigurationError,
  applyConfiguration,
  createOperationId,
  previewConfiguration,
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
  file list               List file metadata
  file get                Read one file's metadata
  file delete             Soft-delete one file

Connection:
  --base-url URL          Almira API base; or set ALMIRA_BASE_URL
  METAMORPH_TOKEN         PAT or SAK, read only from the environment

Common identifiers:
  --tenant UUID           Metamorph tenant UUIDv7
  --project UUID          Metamorph project UUIDv7
  --environment UUID      Almira environment UUIDv7
  --collection UUID       Almira collection-instance UUIDv7
  --entry UUID            Almira file-entry UUIDv7
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
  help: { type: "boolean", short: "h" },
  key: { type: "string" },
  limit: { type: "string" },
  "operation-id": { type: "string" },
  origin: { type: "string", multiple: true },
  "path-prefix": { type: "string" },
  project: { type: "string" },
  revision: { type: "string" },
  scan: { type: "string" },
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
    } else if (noun === "file" && verb === "list") {
      const pathPrefix = stringValue(values, "path-prefix");
      result = await client.listFiles(collectionReference(values, tenantId, projectId), {
        ...page(values),
        ...(pathPrefix === undefined ? {} : { pathPrefix }),
      });
    } else if (noun === "file" && verb === "get") {
      result = await client.getFileMetadata(fileReference(values, tenantId, projectId));
    } else if (noun === "file" && verb === "delete") {
      operationId = mutationId(values);
      mutation = true;
      result = await client.deleteFile(
        fileReference(values, tenantId, projectId),
        positiveInteger(values, "revision"),
        { operationId },
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
  ["file:list", new Set(["base-url", "collection", "cursor", "environment", "limit", "path-prefix", "project", "tenant"])],
  ["file:get", new Set(["base-url", "collection", "entry", "environment", "project", "tenant"])],
  ["file:delete", new Set(["base-url", "collection", "entry", "environment", "operation-id", "project", "revision", "tenant"])],
]);

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

function optionalPageInteger(values: Values): number | undefined {
  const value = stringValue(values, "limit");
  if (value === undefined) return undefined;
  const parsed = positiveInteger(values, "limit");
  if (parsed > 100) throw new CliUsageError();
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
