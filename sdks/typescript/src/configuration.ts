import { AlmiraClientError } from "./errors.js";
import type { AlmiraClient } from "./client.js";
import type { Collection, Environment, ProjectReference, UuidV7 } from "./types.js";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ENVIRONMENT_KEY = /^[a-z][a-z0-9-]{0,46}[a-z0-9]$/u;
const COLLECTION_KEY = /^[a-z]([a-z0-9_-]{0,62}[a-z0-9])?$/u;

export interface AlmiraConfigurationCollectionV1 {
  readonly key: string;
  readonly display_name: string;
  readonly malware_scan_required: boolean;
  readonly storage_class: "normal" | "express";
}

export interface AlmiraConfigurationEnvironmentV1 {
  readonly key: string;
  readonly display_name: string;
  readonly browser_origins?: readonly string[];
  readonly collections: readonly AlmiraConfigurationCollectionV1[];
}

export interface AlmiraConfigurationV1 {
  readonly api_version: "almira/v1";
  readonly environments: readonly AlmiraConfigurationEnvironmentV1[];
}

export type AlmiraConfigurationAction =
  | {
      readonly action_id: string;
      readonly operation: "environment.create";
      readonly environment_id: null;
      readonly environment_key: string;
      readonly display_name: string;
    }
  | {
      readonly action_id: string;
      readonly operation: "environment.update";
      readonly environment_id: UuidV7;
      readonly environment_key: string;
      readonly display_name: string;
      readonly expected_revision: number;
    }
  | {
      readonly action_id: string;
      readonly operation: "browser_origins.replace";
      readonly environment_id: UuidV7 | null;
      readonly environment_key: string;
      readonly origins: readonly string[];
      readonly expected_revision: number | null;
    }
  | {
      readonly action_id: string;
      readonly operation: "storage_migration.start";
      readonly environment_id: UuidV7;
      readonly environment_key: string;
      readonly collection_instance_id: UuidV7;
      readonly collection_key: string;
      readonly target_storage_class: "normal" | "express";
      readonly expected_collection_revision: number;
    }
  | {
      readonly action_id: string;
      readonly operation: "collection.create";
      readonly environment_id: UuidV7 | null;
      readonly environment_key: string;
      readonly collection_key: string;
      readonly display_name: string;
      readonly malware_scan_required: boolean;
      readonly storage_class: "normal" | "express";
      readonly capability: "verified" | "check_on_apply";
    };

export interface AlmiraConfigurationConflict {
  readonly code:
    | "ALMIRA_CONFIGURATION_COLLECTION_CHANGE_UNSUPPORTED"
    | "ALMIRA_CONFIGURATION_ENVIRONMENT_LIMIT_EXCEEDED"
    | "ALMIRA_CONFIGURATION_ENVIRONMENT_NOT_ACTIVE"
    | "ALMIRA_CONFIGURATION_ENVIRONMENT_NOT_MANAGED"
    | "ALMIRA_CONFIGURATION_COLLECTION_NOT_READY"
    | "ALMIRA_CONFIGURATION_STORAGE_CLASS_UNAVAILABLE";
  readonly environment_key: string;
  readonly collection_key: string | null;
}

export interface AlmiraConfigurationPlan {
  readonly api_version: "almira.configuration-plan/v1";
  readonly plan_digest: `sha256:${string}`;
  readonly configuration: AlmiraConfigurationV1;
  readonly actions: readonly AlmiraConfigurationAction[];
  readonly conflicts: readonly AlmiraConfigurationConflict[];
  readonly preserves_unlisted_resources: true;
}

export interface AlmiraConfigurationApplyReceipt {
  readonly api_version: "almira.configuration-apply-receipt/v1";
  readonly operation_id: UuidV7;
  readonly plan_digest: `sha256:${string}`;
  readonly disposition: "applied" | "converged";
  readonly actions: readonly {
    readonly action_id: string;
    readonly operation_id: UuidV7;
    readonly disposition: string;
  }[];
}

export class AlmiraConfigurationError extends Error {
  readonly code:
    | "ALMIRA_CONFIGURATION_CONFLICT"
    | "ALMIRA_CONFIGURATION_INPUT_INVALID"
    | "ALMIRA_CONFIGURATION_STORAGE_CLASS_UNAVAILABLE";
  readonly plan: AlmiraConfigurationPlan | null;

  constructor(code: AlmiraConfigurationError["code"], plan: AlmiraConfigurationPlan | null = null) {
    super(code);
    this.name = "AlmiraConfigurationError";
    this.code = code;
    this.plan = plan;
  }
}

export function normalizeConfiguration(value: unknown): AlmiraConfigurationV1 {
  const root = exactRecord(value, ["api_version", "environments"]);
  if (root.api_version !== "almira/v1" || !Array.isArray(root.environments) || root.environments.length > 10) {
    invalidConfiguration();
  }
  const environments = root.environments.map(normalizeEnvironment);
  environments.sort((left, right) => compareAscii(left.key, right.key));
  requireUnique(environments.map((environment) => environment.key));
  return { api_version: "almira/v1", environments };
}

export async function previewConfiguration(
  client: AlmiraClient,
  reference: ProjectReference,
  value: unknown,
  options: { signal?: AbortSignal } = {},
): Promise<AlmiraConfigurationPlan> {
  const configuration = normalizeConfiguration(value);
  const current = await client.listEnvironments(reference, options);
  const environmentByKey = new Map(current.environments.map((environment) => [environment.environment_key, environment]));
  const actions: AlmiraConfigurationAction[] = [];
  const conflicts: AlmiraConfigurationConflict[] = [];
  const missingEnvironmentKeys = configuration.environments
    .filter((environment) => !environmentByKey.has(environment.key))
    .map((environment) => environment.key);
  const environmentLimitExceeded = current.environments.length + missingEnvironmentKeys.length > 10;

  for (const desired of configuration.environments) {
    const environment = environmentByKey.get(desired.key);
    if (environment === undefined) {
      if (environmentLimitExceeded) {
        conflicts.push(conflict("ALMIRA_CONFIGURATION_ENVIRONMENT_LIMIT_EXCEEDED", desired.key));
        continue;
      }
      actions.push({
        action_id: `environment.create:${desired.key}`,
        operation: "environment.create",
        environment_id: null,
        environment_key: desired.key,
        display_name: desired.display_name,
      });
      if (desired.browser_origins !== undefined && desired.browser_origins.length > 0) {
        actions.push(originAction(desired, null, null));
      }
      for (const collection of desired.collections) {
        actions.push(collectionAction(desired.key, null, collection, "check_on_apply"));
      }
      continue;
    }
    if (environment.lifecycle !== "active") {
      conflicts.push(conflict("ALMIRA_CONFIGURATION_ENVIRONMENT_NOT_ACTIVE", desired.key));
      continue;
    }
    if (environment.operating_model !== "managed") {
      conflicts.push(conflict("ALMIRA_CONFIGURATION_ENVIRONMENT_NOT_MANAGED", desired.key));
      continue;
    }
    if (environment.display_name !== desired.display_name) {
      actions.push({
        action_id: `environment.update:${desired.key}`,
        operation: "environment.update",
        environment_id: environment.environment_id,
        environment_key: desired.key,
        display_name: desired.display_name,
        expected_revision: environment.revision,
      });
    }
    if (desired.browser_origins !== undefined) {
      const policy = await client.getBrowserOrigins(environmentReference(reference, environment), options);
      if (!sameStrings(policy.origins, desired.browser_origins)) {
        actions.push(originAction(desired, environment.environment_id, policy.revision));
      }
    }

    const collections = await listAllCollections(client, reference, environment, options.signal);
    const collectionByKey = new Map(collections.map((collection) => [collection.collection_key, collection]));
    const requiresCapabilities = desired.collections.some((collection) => {
      const existing = collectionByKey.get(collection.key);
      return existing === undefined || existing.storage_class !== collection.storage_class;
    });
    const capabilities = !requiresCapabilities
      ? null
      : await client.getStorageCapabilities(environmentReference(reference, environment), options);
    for (const collection of desired.collections) {
      const existing = collectionByKey.get(collection.key);
      if (existing !== undefined) {
        if (!collectionSettingsMatch(existing, collection)) {
          conflicts.push(conflict(
            "ALMIRA_CONFIGURATION_COLLECTION_CHANGE_UNSUPPORTED",
            desired.key,
            collection.key,
          ));
        } else if (existing.storage_class !== collection.storage_class) {
          if (existing.storage_binding_state !== "ready" && existing.storage_binding_state !== "migrating") {
            conflicts.push(conflict(
              "ALMIRA_CONFIGURATION_COLLECTION_NOT_READY",
              desired.key,
              collection.key,
            ));
          } else if (!classAvailable(capabilities, collection.storage_class)) {
            conflicts.push(conflict(
              "ALMIRA_CONFIGURATION_STORAGE_CLASS_UNAVAILABLE",
              desired.key,
              collection.key,
            ));
          } else {
            actions.push({
              action_id: `storage_migration.start:${desired.key}:${collection.key}`,
              operation: "storage_migration.start",
              environment_id: environment.environment_id,
              environment_key: desired.key,
              collection_instance_id: existing.collection_instance_id,
              collection_key: collection.key,
              target_storage_class: collection.storage_class,
              expected_collection_revision: existing.revision,
            });
          }
        }
        continue;
      }
      if (!classAvailable(capabilities, collection.storage_class)) {
        conflicts.push(conflict(
          "ALMIRA_CONFIGURATION_STORAGE_CLASS_UNAVAILABLE",
          desired.key,
          collection.key,
        ));
        continue;
      }
      actions.push(collectionAction(
        desired.key,
        environment.environment_id,
        collection,
        "verified",
      ));
    }
  }

  const digestInput = {
    api_version: "almira.configuration-plan/v1",
    configuration,
    actions,
    conflicts,
    preserves_unlisted_resources: true,
  } as const;
  return {
    ...digestInput,
    plan_digest: await sha256(JSON.stringify(digestInput)),
  };
}

export async function applyConfiguration(
  client: AlmiraClient,
  reference: ProjectReference,
  value: unknown,
  options: { operationId: UuidV7; signal?: AbortSignal },
): Promise<AlmiraConfigurationApplyReceipt> {
  if (!UUID_V7.test(options.operationId)) invalidConfiguration();
  const signalOptions = options.signal === undefined ? {} : { signal: options.signal };
  const plan = await previewConfiguration(client, reference, value, signalOptions);
  if (plan.conflicts.length > 0) throw new AlmiraConfigurationError("ALMIRA_CONFIGURATION_CONFLICT", plan);
  const environmentIds = new Map<string, UuidV7>();
  for (const action of plan.actions) {
    if (action.environment_id !== null) environmentIds.set(action.environment_key, action.environment_id);
  }
  const receipts: Array<{ action_id: string; operation_id: UuidV7; disposition: string }> = [];
  for (const action of plan.actions) {
    const operationId = await deriveOperationId(options.operationId, action.action_id);
    if (action.operation === "environment.create") {
      const outcome = await client.createEnvironment(
        reference,
        { environment_key: action.environment_key, display_name: action.display_name },
        { operationId, ...signalOptions },
      );
      environmentIds.set(action.environment_key, outcome.environment.environment_id);
      receipts.push(receipt(action, operationId, outcome.disposition));
      continue;
    }
    const environmentId = environmentIds.get(action.environment_key);
    if (environmentId === undefined) throw new AlmiraClientError("ALMIRA_CLIENT_RESPONSE_INVALID");
    const environment = { ...reference, environmentId };
    if (action.operation === "environment.update") {
      const outcome = await client.updateEnvironment(
        environment,
        { display_name: action.display_name, expected_revision: action.expected_revision },
        { operationId, ...signalOptions },
      );
      receipts.push(receipt(action, operationId, outcome.disposition));
    } else if (action.operation === "browser_origins.replace") {
      const policy = action.expected_revision === null
        ? await client.getBrowserOrigins(environment, signalOptions)
        : null;
      const outcome = await client.replaceBrowserOrigins(
        environment,
        {
          expected_revision: action.expected_revision ?? policy?.revision ?? 1,
          origins: [...action.origins],
        },
        { operationId, ...signalOptions },
      );
      receipts.push(receipt(action, operationId, outcome.disposition));
    } else if (action.operation === "storage_migration.start") {
      const outcome = await client.startStorageMigration(
        { ...environment, collectionInstanceId: action.collection_instance_id },
        {
          target_storage_class: action.target_storage_class,
          expected_collection_revision: action.expected_collection_revision,
        },
        { operationId, ...signalOptions },
      );
      receipts.push(receipt(action, operationId, outcome.disposition));
    } else {
      const capabilities = await client.getStorageCapabilities(environment, signalOptions);
      if (!classAvailable(capabilities, action.storage_class)) {
        throw new AlmiraConfigurationError("ALMIRA_CONFIGURATION_STORAGE_CLASS_UNAVAILABLE", plan);
      }
      const outcome = await client.createCollection(
        environment,
        {
          collection_key: action.collection_key,
          display_name: action.display_name,
          malware_scan_required: action.malware_scan_required,
          storage_class: action.storage_class,
        },
        { operationId, ...signalOptions },
      );
      receipts.push(receipt(action, operationId, outcome.disposition));
    }
  }
  return {
    api_version: "almira.configuration-apply-receipt/v1",
    operation_id: options.operationId,
    plan_digest: plan.plan_digest,
    disposition: receipts.length === 0 ? "converged" : "applied",
    actions: receipts,
  };
}

function normalizeEnvironment(value: unknown): AlmiraConfigurationEnvironmentV1 {
  const item = exactRecord(value, ["key", "display_name", "browser_origins", "collections"]);
  if (!validName(item.display_name, 80) || typeof item.key !== "string" || !ENVIRONMENT_KEY.test(item.key)) {
    invalidConfiguration();
  }
  if (!Array.isArray(item.collections)) invalidConfiguration();
  const collections = item.collections.map(normalizeCollection);
  collections.sort((left, right) => compareAscii(left.key, right.key));
  requireUnique(collections.map((collection) => collection.key));
  let browserOrigins: readonly string[] | undefined;
  if (item.browser_origins !== undefined) {
    if (!Array.isArray(item.browser_origins) || item.browser_origins.length > 32) invalidConfiguration();
    const origins = item.browser_origins.map((origin) => {
      if (typeof origin !== "string" || !validOrigin(origin)) invalidConfiguration();
      return origin;
    }).sort();
    requireUnique(origins);
    browserOrigins = origins;
  }
  return {
    key: item.key,
    display_name: item.display_name,
    ...(browserOrigins === undefined ? {} : { browser_origins: browserOrigins }),
    collections,
  };
}

function normalizeCollection(value: unknown): AlmiraConfigurationCollectionV1 {
  const item = exactRecord(value, ["key", "display_name", "malware_scan_required", "storage_class"]);
  const storageClass = item.storage_class ?? "normal";
  if (
    typeof item.key !== "string" ||
    !COLLECTION_KEY.test(item.key) ||
    !validName(item.display_name, 80) ||
    typeof item.malware_scan_required !== "boolean" ||
    (storageClass !== "normal" && storageClass !== "express")
  ) invalidConfiguration();
  return {
    key: item.key,
    display_name: item.display_name,
    malware_scan_required: item.malware_scan_required,
    storage_class: storageClass,
  };
}

function exactRecord(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalidConfiguration();
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !allowed.includes(key))) invalidConfiguration();
  return result;
}

function validName(value: unknown, maximum: number): value is string {
  return typeof value === "string" && [...value].length >= 1 && [...value].length <= maximum && value === value.trim() &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function validOrigin(value: string): boolean {
  if (value.length > 255) return false;
  const match = /^(https?):\/\/([^/:?#@\\]+)(?::([0-9]{1,5}))?$/u.exec(value);
  if (match === null) return false;
  const [, scheme, host, port] = match;
  return /^[a-z0-9.-]+$/u.test(host) && !host.startsWith(".") && !host.endsWith(".") &&
    !host.includes("..") && (scheme === "https" || host === "localhost" || host === "127.0.0.1") &&
    (port === undefined || (Number(port) >= 1 && Number(port) <= 65_535));
}

function requireUnique(values: readonly string[]): void {
  if (new Set(values).size !== values.length) invalidConfiguration();
}

function invalidConfiguration(): never {
  throw new AlmiraConfigurationError("ALMIRA_CONFIGURATION_INPUT_INVALID");
}

function environmentReference(reference: ProjectReference, environment: Environment) {
  return { ...reference, environmentId: environment.environment_id };
}

async function listAllCollections(
  client: AlmiraClient,
  reference: ProjectReference,
  environment: Environment,
  signal?: AbortSignal,
): Promise<Collection[]> {
  const collections: Collection[] = [];
  const seenCursors = new Set<string>();
  const seenKeys = new Set<string>();
  let cursor: string | undefined;
  do {
    if (cursor !== undefined && !seenCursors.add(cursor)) {
      throw new AlmiraClientError("ALMIRA_CLIENT_RESPONSE_INVALID");
    }
    const page = await client.listCollections(environmentReference(reference, environment), {
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
      ...(signal === undefined ? {} : { signal }),
    });
    for (const collection of page.collections) {
      if (!seenKeys.add(collection.collection_key)) {
        throw new AlmiraClientError("ALMIRA_CLIENT_RESPONSE_INVALID");
      }
      collections.push(collection);
    }
    cursor = page.next_cursor ?? undefined;
  } while (cursor !== undefined);
  return collections;
}

function collectionSettingsMatch(existing: Collection, desired: AlmiraConfigurationCollectionV1): boolean {
  return existing.display_name === desired.display_name &&
    existing.malware_scan_required === desired.malware_scan_required;
}

function classAvailable(
  capabilities: Awaited<ReturnType<AlmiraClient["getStorageCapabilities"]>> | null,
  storageClass: "normal" | "express",
): boolean {
  return capabilities?.realizations.some((realization) =>
    realization.health === "ready" && realization.storage_classes.some((value) => value === storageClass),
  ) === true;
}

function originAction(
  environment: AlmiraConfigurationEnvironmentV1,
  environmentId: UuidV7 | null,
  expectedRevision: number | null,
): AlmiraConfigurationAction {
  return {
    action_id: `browser_origins.replace:${environment.key}`,
    operation: "browser_origins.replace",
    environment_id: environmentId,
    environment_key: environment.key,
    origins: environment.browser_origins ?? [],
    expected_revision: expectedRevision,
  };
}

function collectionAction(
  environmentKey: string,
  environmentId: UuidV7 | null,
  collection: AlmiraConfigurationCollectionV1,
  capability: "verified" | "check_on_apply",
): AlmiraConfigurationAction {
  return {
    action_id: `collection.create:${environmentKey}:${collection.key}`,
    operation: "collection.create",
    environment_id: environmentId,
    environment_key: environmentKey,
    collection_key: collection.key,
    display_name: collection.display_name,
    malware_scan_required: collection.malware_scan_required,
    storage_class: collection.storage_class,
    capability,
  };
}

function conflict(
  code: AlmiraConfigurationConflict["code"],
  environmentKey: string,
  collectionKey: string | null = null,
): AlmiraConfigurationConflict {
  return { code, environment_key: environmentKey, collection_key: collectionKey };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function receipt(
  action: AlmiraConfigurationAction,
  operationId: UuidV7,
  disposition: string,
) {
  return { action_id: action.action_id, operation_id: operationId, disposition };
}

async function deriveOperationId(root: UuidV7, actionId: string): Promise<UuidV7> {
  const rootBytes = uuidBytes(root);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`almira:configuration:v1\0${root}\0${actionId}`),
  ));
  const bytes = digest.slice(0, 16);
  bytes.set(rootBytes.slice(0, 6), 0);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return formatUuid(bytes);
}

async function sha256(value: string): Promise<`sha256:${string}`> {
  const bytes = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return `sha256:${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function uuidBytes(value: string): Uint8Array {
  const hexadecimal = value.replaceAll("-", "");
  return Uint8Array.from({ length: 16 }, (_, index) => Number.parseInt(hexadecimal.slice(index * 2, index * 2 + 2), 16));
}

function formatUuid(bytes: Uint8Array): UuidV7 {
  const hexadecimal = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hexadecimal.slice(0, 8)}-${hexadecimal.slice(8, 12)}-${hexadecimal.slice(12, 16)}-${hexadecimal.slice(16, 20)}-${hexadecimal.slice(20)}`;
}
