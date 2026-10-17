import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  AlmiraClient,
  AlmiraConfigurationError,
  applyConfiguration,
  normalizeConfiguration,
  previewConfiguration,
} from "../dist/index.js";

const tenantId = "018f0000-0000-7000-8000-000000000002";
const projectId = "018f0000-0000-7000-8000-000000000003";
const environmentId = "018f0000-0000-7000-8000-000000000004";
const operationId = "018f0000-0000-7000-8000-000000000007";

const configuration = {
  api_version: "almira/v1",
  environments: [{
    key: "development",
    display_name: "Development",
    browser_origins: ["https://app.example"],
    collections: [{
      key: "sessions",
      display_name: "Sessions",
      malware_scan_required: false,
      storage_class: "express",
    }],
  }],
};

function response(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fixture(calls) {
  return new AlmiraClient({
    credential: "mm_sak_v1.test",
    fetch: async (input, init) => {
      calls.push({ input, init });
      if (input.endsWith("/environments")) {
        return response({ environments: [{
          environment_id: environmentId,
          environment_key: "development",
          display_name: "Development",
          system_key: "development",
          operating_model: "managed",
          lifecycle: "active",
          revision: 1,
          created_at: "2026-10-17T00:00:00Z",
          updated_at: "2026-10-17T00:00:00Z",
        }] });
      }
      if (input.endsWith("/browser-origins") && init.method === "GET") {
        return response({ environment_id: environmentId, origins: [], revision: 1 });
      }
      if (input.endsWith("/browser-origins") && init.method === "PUT") {
        return response({ disposition: "applied", policy: { environment_id: environmentId, origins: ["https://app.example"], revision: 2 } });
      }
      if (input.includes("/collections?")) return response({ collections: [], next_cursor: null });
      if (input.endsWith("/storage-capabilities")) {
        return response({
          environment_id: environmentId,
          deployment_profile: "hosted",
          catalog_revision: 1,
          catalog_digest: `sha256:${"a".repeat(64)}`,
          expires_at: "2099-10-17T00:00:00Z",
          provider_matrix: {
            hosted: ["aws_s3", "google_cloud_storage", "azure_blob"],
            connected_site: ["aws_s3", "google_cloud_storage", "azure_blob"],
          },
          realizations: [{
            realization_id: "018f0000-0000-7000-8000-000000000040",
            display_name: "Managed storage",
            provider_family: "aws_s3",
            operating_model: "managed",
            location_id: "region.one",
            storage_classes: ["normal", "express"],
            health: "ready",
            capability_generation: 1,
            evidence_digest: `sha256:${"b".repeat(64)}`,
          }],
        });
      }
      if (input.endsWith("/collections") && init.method === "POST") {
        return response({ disposition: "applied", collection: {} }, 201);
      }
      assert.fail(`unexpected request: ${init.method} ${input}`);
    },
  });
}

test("configuration vectors are admitted or refused by the SDK", async () => {
  const vectors = JSON.parse(await readFile(
    new URL("../../../contracts/configuration/vectors.v1.json", import.meta.url),
  ));
  for (const vector of vectors.vectors) {
    if (vector.expected === "valid") {
      assert.equal(normalizeConfiguration(vector.instance).api_version, "almira/v1", vector.name);
    } else {
      assert.throws(
        () => normalizeConfiguration(vector.instance),
        (error) => error instanceof AlmiraConfigurationError && error.code === "ALMIRA_CONFIGURATION_INPUT_INVALID",
        vector.name,
      );
    }
  }
});

test("preview is deterministic, additive, and capability-aware", async () => {
  const calls = [];
  const client = fixture(calls);
  const first = await previewConfiguration(client, { tenantId, projectId }, configuration);
  const second = await previewConfiguration(client, { tenantId, projectId }, configuration);
  assert.equal(first.plan_digest, second.plan_digest);
  assert.equal(first.preserves_unlisted_resources, true);
  assert.deepEqual(first.conflicts, []);
  assert.deepEqual(first.actions.map((action) => [action.operation, action.action_id]), [
    ["browser_origins.replace", "browser_origins.replace:development"],
    ["collection.create", "collection.create:development:sessions"],
  ]);
  assert.equal(first.actions[1].capability, "verified");
  assert.equal(calls.filter(({ init }) => init.method !== "GET").length, 0);
});

test("configuration ordering does not change the normalized plan", async () => {
  const firstInput = {
    api_version: "almira/v1",
    environments: [
      {
        key: "production",
        display_name: "Production",
        browser_origins: ["https://www.example", "https://app.example"],
        collections: [
          { key: "uploads", display_name: "Uploads", malware_scan_required: true, storage_class: "normal" },
          { key: "assets", display_name: "Assets", malware_scan_required: false, storage_class: "express" },
        ],
      },
      configuration.environments[0],
    ],
  };
  const secondInput = {
    ...firstInput,
    environments: [...firstInput.environments].reverse().map((environment) => ({
      ...environment,
      browser_origins: environment.browser_origins === undefined
        ? undefined
        : [...environment.browser_origins].reverse(),
      collections: [...environment.collections].reverse(),
    })),
  };
  const client = new AlmiraClient({
    credential: "mm_sak_v1.test",
    fetch: async (input, init) => {
      if (input.endsWith("/environments") && init.method === "GET") {
        return response({ environments: [] });
      }
      assert.fail(`unexpected request: ${init.method} ${input}`);
    },
  });
  const first = await previewConfiguration(client, { tenantId, projectId }, firstInput);
  const second = await previewConfiguration(client, { tenantId, projectId }, secondInput);
  assert.deepEqual(first.configuration, second.configuration);
  assert.deepEqual(first.actions, second.actions);
  assert.equal(first.plan_digest, second.plan_digest);
});

test("environment ceiling is rejected during preview without mutations", async () => {
  const calls = [];
  const client = new AlmiraClient({
    credential: "mm_sak_v1.test",
    fetch: async (input, init) => {
      calls.push({ input, init });
      if (input.endsWith("/environments") && init.method === "GET") {
        return response({ environments: Array.from({ length: 10 }, (_, index) => ({
          environment_id: `018f0000-0000-7000-8000-${String(index).padStart(12, "0")}`,
          environment_key: `existing-${index}`,
          display_name: `Existing ${index}`,
          system_key: null,
          operating_model: "managed",
          lifecycle: "active",
          revision: 1,
          created_at: "2026-10-17T00:00:00Z",
          updated_at: "2026-10-17T00:00:00Z",
        })) });
      }
      assert.fail(`unexpected request: ${init.method} ${input}`);
    },
  });
  const value = {
    api_version: "almira/v1",
    environments: [{ key: "new-environment", display_name: "New environment", collections: [] }],
  };
  const plan = await previewConfiguration(client, { tenantId, projectId }, value);
  assert.deepEqual(plan.actions, []);
  assert.deepEqual(plan.conflicts, [{
    code: "ALMIRA_CONFIGURATION_ENVIRONMENT_LIMIT_EXCEEDED",
    environment_key: "new-environment",
    collection_key: null,
  }]);
  await assert.rejects(
    applyConfiguration(client, { tenantId, projectId }, value, { operationId }),
    (error) => error instanceof AlmiraConfigurationError && error.code === "ALMIRA_CONFIGURATION_CONFLICT",
  );
  assert.equal(calls.filter(({ init }) => init.method !== "GET").length, 0);
});

test("apply uses stable child operation IDs and returns a resumable receipt", async () => {
  const calls = [];
  const client = fixture(calls);
  const first = await applyConfiguration(
    client,
    { tenantId, projectId },
    configuration,
    { operationId },
  );
  const second = await applyConfiguration(
    client,
    { tenantId, projectId },
    configuration,
    { operationId },
  );
  assert.equal(first.disposition, "applied");
  assert.equal(first.operation_id, operationId);
  assert.deepEqual(
    first.actions.map((action) => action.operation_id),
    second.actions.map((action) => action.operation_id),
  );
  assert.equal(new Set(first.actions.map((action) => action.operation_id)).size, 2);
  for (const action of first.actions) assert.match(action.operation_id, /^[0-9a-f]{8}-[0-9a-f]{4}-7/u);
  const mutations = calls.filter(({ init }) => init.method !== "GET");
  assert.deepEqual(
    mutations.slice(0, 2).map(({ init }) => init.headers.get("idempotency-key")),
    first.actions.map((action) => action.operation_id),
  );
  assert.deepEqual(JSON.parse(mutations[1].init.body), {
    collection_key: "sessions",
    display_name: "Sessions",
    malware_scan_required: false,
    storage_class: "express",
  });
});

test("apply wires explicit extraction and vector settings after collection creation", async () => {
  const collectionId = "018f0000-0000-7000-8000-000000000050";
  const calls = [];
  const client = new AlmiraClient({
    credential: "mm_sak_v1.test",
    fetch: async (input, init) => {
      calls.push({ input, init });
      if (input.endsWith("/environments") && init.method === "GET") {
        return response({ environments: [{
          environment_id: environmentId,
          environment_key: "development",
          display_name: "Development",
          system_key: "development",
          operating_model: "managed",
          lifecycle: "active",
          revision: 1,
          created_at: "2026-10-17T00:00:00Z",
          updated_at: "2026-10-17T00:00:00Z",
        }] });
      }
      if (input.includes("/collections?")) return response({ collections: [], next_cursor: null });
      if (input.endsWith("/storage-capabilities")) {
        return response({
          environment_id: environmentId,
          deployment_profile: "hosted",
          catalog_revision: 1,
          catalog_digest: `sha256:${"a".repeat(64)}`,
          expires_at: "2099-10-17T00:00:00Z",
          provider_matrix: {
            hosted: ["aws_s3", "google_cloud_storage", "azure_blob"],
            connected_site: ["aws_s3", "google_cloud_storage", "azure_blob"],
          },
          realizations: [{
            realization_id: "018f0000-0000-7000-8000-000000000040",
            display_name: "Managed storage",
            provider_family: "aws_s3",
            operating_model: "managed",
            location_id: "region.one",
            storage_classes: ["normal"],
            health: "ready",
            capability_generation: 1,
            evidence_digest: `sha256:${"b".repeat(64)}`,
          }],
        });
      }
      if (input.endsWith("/collections") && init.method === "POST") {
        return response({
          disposition: "applied",
          collection: { collection_instance_id: collectionId, revision: 1 },
        }, 201);
      }
      if (input.endsWith(`/collections/${collectionId}/extraction`) && init.method === "PUT") {
        return response({ disposition: "applied", config: { revision: 2 } });
      }
      assert.fail(`unexpected request: ${init.method} ${input}`);
    },
  });
  const desired = {
    api_version: "almira/v1",
    environments: [{
      key: "development",
      display_name: "Development",
      collections: [{
        key: "documents",
        display_name: "Documents",
        malware_scan_required: true,
        storage_class: "normal",
        extraction: { content: true, ocr: true, transcription: false, vector_indexing: true },
      }],
    }],
  };
  const receipt = await applyConfiguration(
    client,
    { tenantId, projectId },
    desired,
    { operationId },
  );
  assert.deepEqual(
    receipt.actions.map((action) => action.action_id),
    [
      "collection.create:development:documents",
      "collection_extraction.replace:development:documents",
    ],
  );
  const mutations = calls.filter(({ init }) => init.method !== "GET");
  assert.equal(mutations.length, 2);
  assert.deepEqual(JSON.parse(mutations[1].init.body), {
    expected_revision: 1,
    config: { content: true, ocr: true, transcription: false, vector_indexing: true },
  });
});

test("apply wires bounded media presets after collection creation", async () => {
  const collectionId = "018f0000-0000-7000-8000-000000000052";
  const calls = [];
  const client = new AlmiraClient({
    credential: "mm_sak_v1.test",
    fetch: async (input, init) => {
      calls.push({ input, init });
      if (input.endsWith("/environments") && init.method === "GET") {
        return response({ environments: [{
          environment_id: environmentId,
          environment_key: "development",
          display_name: "Development",
          system_key: "development",
          operating_model: "managed",
          lifecycle: "active",
          revision: 1,
          created_at: "2026-10-17T00:00:00Z",
          updated_at: "2026-10-17T00:00:00Z",
        }] });
      }
      if (input.includes("/collections?")) return response({ collections: [], next_cursor: null });
      if (input.endsWith("/storage-capabilities")) {
        return response({
          environment_id: environmentId,
          deployment_profile: "hosted",
          catalog_revision: 1,
          catalog_digest: `sha256:${"a".repeat(64)}`,
          expires_at: "2099-10-17T00:00:00Z",
          provider_matrix: {
            hosted: ["aws_s3", "google_cloud_storage", "azure_blob"],
            connected_site: ["aws_s3", "google_cloud_storage", "azure_blob"],
          },
          realizations: [{
            realization_id: "018f0000-0000-7000-8000-000000000040",
            display_name: "Managed storage",
            provider_family: "aws_s3",
            operating_model: "managed",
            location_id: "region.one",
            storage_classes: ["normal"],
            health: "ready",
            capability_generation: 1,
            evidence_digest: `sha256:${"b".repeat(64)}`,
          }],
        });
      }
      if (input.endsWith("/collections") && init.method === "POST") {
        return response({ disposition: "applied", collection: { collection_instance_id: collectionId, revision: 1 } }, 201);
      }
      if (input.endsWith(`/collections/${collectionId}/media`) && init.method === "PUT") {
        return response({ disposition: "applied", config: { revision: 2 } });
      }
      assert.fail(`unexpected request: ${init.method} ${input}`);
    },
  });
  const desired = {
    api_version: "almira/v1",
    environments: [{
      key: "development",
      display_name: "Development",
      collections: [{
        key: "assets",
        display_name: "Assets",
        malware_scan_required: true,
        media: {
          image_presets: {
            card: { widths: [320, 640], height: null, fit: "inside", formats: ["webp", "avif"], without_enlargement: true },
          },
          document_previews: true,
        },
      }],
    }],
  };
  const receipt = await applyConfiguration(client, { tenantId, projectId }, desired, { operationId });
  assert.deepEqual(receipt.actions.map((action) => action.action_id), [
    "collection.create:development:assets",
    "collection_media.replace:development:assets",
  ]);
  const mutations = calls.filter(({ init }) => init.method !== "GET");
  assert.deepEqual(JSON.parse(mutations[1].init.body), {
    expected_revision: 1,
    config: {
      image_presets: {
        card: { widths: [320, 640], height: null, fit: "inside", formats: ["avif", "webp"], without_enlargement: true },
      },
      document_previews: true,
      video_profile: null,
    },
  });
});

test("duplicate resource keys fail closed", () => {
  assert.throws(() => normalizeConfiguration({
    api_version: "almira/v1",
    environments: [configuration.environments[0], configuration.environments[0]],
  }), AlmiraConfigurationError);
});

test("existing collection changes are reported as conflicts", async () => {
  const client = new AlmiraClient({
    credential: "mm_sak_v1.test",
    fetch: async (input, init) => {
      if (input.endsWith("/environments") && init.method === "GET") {
        return response({ environments: [{
          environment_id: environmentId,
          environment_key: "development",
          display_name: "Development",
          system_key: "development",
          operating_model: "managed",
          lifecycle: "active",
          revision: 1,
          created_at: "2026-10-17T00:00:00Z",
          updated_at: "2026-10-17T00:00:00Z",
        }] });
      }
      if (input.includes("/collections?") && init.method === "GET") {
        return response({ collections: [{
          collection_id: "018f0000-0000-7000-8000-000000000060",
          environment_id: environmentId,
          collection_key: "sessions",
          display_name: "Old sessions",
          malware_scan_required: false,
          storage_class: "express",
          storage_binding: {
            realization_id: "018f0000-0000-7000-8000-000000000040",
            capability_generation: 1,
          },
          created_at: "2026-10-17T00:00:00Z",
        }], next_cursor: null });
      }
      if (input.endsWith("/browser-origins") && init.method === "GET") {
        return response({ environment_id: environmentId, origins: ["https://app.example"], revision: 1 });
      }
      assert.fail(`unexpected request: ${init.method} ${input}`);
    },
  });
  const plan = await previewConfiguration(client, { tenantId, projectId }, configuration);
  assert.deepEqual(plan.actions, []);
  assert.deepEqual(plan.conflicts, [{
    code: "ALMIRA_CONFIGURATION_COLLECTION_CHANGE_UNSUPPORTED",
    environment_key: "development",
    collection_key: "sessions",
  }]);
});

test("existing collection class changes plan and apply a governed migration", async () => {
  const calls = [];
  let bindingState = "ready";
  const client = new AlmiraClient({
    credential: "mm_sak_v1.test",
    fetch: async (input, init) => {
      calls.push({ input, init });
      if (input.endsWith("/environments") && init.method === "GET") {
        return response({ environments: [{
          environment_id: environmentId,
          environment_key: "development",
          display_name: "Development",
          system_key: "development",
          operating_model: "managed",
          lifecycle: "active",
          revision: 1,
          created_at: "2026-10-17T00:00:00Z",
          updated_at: "2026-10-17T00:00:00Z",
        }] });
      }
      if (input.includes("/collections?") && init.method === "GET") {
        return response({ collections: [{
          collection_id: "018f0000-0000-7000-8000-000000000060",
          collection_instance_id: "018f0000-0000-7000-8000-000000000061",
          environment_id: environmentId,
          collection_key: "sessions",
          display_name: "Sessions",
          access_template: "private",
          storage_class: "normal",
          storage_binding_state: bindingState,
          technical_metadata_extraction: true,
          malware_scan_required: false,
          content_extraction: false,
          vector_indexing: false,
          delivery_mode: "off",
          revision: 4,
          created_at: "2026-10-17T00:00:00Z",
        }], next_cursor: null });
      }
      if (input.endsWith("/browser-origins") && init.method === "GET") {
        return response({ environment_id: environmentId, origins: ["https://app.example"], revision: 1 });
      }
      if (input.endsWith("/storage-capabilities") && init.method === "GET") {
        return response({
          environment_id: environmentId,
          deployment_profile: "hosted",
          catalog_revision: 1,
          catalog_digest: `sha256:${"a".repeat(64)}`,
          expires_at: "2099-10-17T00:00:00Z",
          provider_matrix: {
            hosted: ["aws_s3", "google_cloud_storage", "azure_blob"],
            connected_site: ["aws_s3", "google_cloud_storage", "azure_blob"],
          },
          realizations: [{
            realization_id: "018f0000-0000-7000-8000-000000000040",
            display_name: "Managed storage",
            provider_family: "aws_s3",
            operating_model: "managed",
            location_id: "region.one",
            storage_classes: ["normal", "express"],
            health: "ready",
            capability_generation: 1,
            evidence_digest: `sha256:${"b".repeat(64)}`,
          }],
        });
      }
      if (input.endsWith("/storage-migrations") && init.method === "POST") {
        return response({ disposition: bindingState === "ready" ? "applied" : "exact_replay", migration: { migration_id: operationId } }, 201);
      }
      assert.fail(`unexpected request: ${init.method} ${input}`);
    },
  });
  const plan = await previewConfiguration(client, { tenantId, projectId }, configuration);
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(plan.actions, [{
    action_id: "storage_migration.start:development:sessions",
    operation: "storage_migration.start",
    environment_id: environmentId,
    environment_key: "development",
    collection_instance_id: "018f0000-0000-7000-8000-000000000061",
    collection_key: "sessions",
    target_storage_class: "express",
    expected_collection_revision: 4,
  }]);
  const receipt = await applyConfiguration(
    client,
    { tenantId, projectId },
    configuration,
    { operationId },
  );
  assert.equal(receipt.actions[0].disposition, "applied");
  const mutation = calls.find(({ input, init }) => input.endsWith("/storage-migrations") && init.method === "POST");
  assert.deepEqual(JSON.parse(mutation.init.body), {
    target_storage_class: "express",
    expected_collection_revision: 4,
  });
  assert.equal(mutation.init.headers.get("idempotency-key"), receipt.actions[0].operation_id);

  bindingState = "migrating";
  calls.length = 0;
  const resumed = await applyConfiguration(
    client,
    { tenantId, projectId },
    configuration,
    { operationId },
  );
  assert.equal(resumed.actions[0].disposition, "exact_replay");
  assert.equal(
    calls.find(({ input, init }) => input.endsWith("/storage-migrations") && init.method === "POST")
      .init.headers.get("idempotency-key"),
    receipt.actions[0].operation_id,
  );
});

test("existing collection protection, extraction, media, and class changes share one revision chain", async () => {
  const collectionId = "018f0000-0000-7000-8000-000000000061";
  const calls = [];
  const client = new AlmiraClient({
    credential: "mm_sak_v1.test",
    fetch: async (input, init) => {
      calls.push({ input, init });
      if (input.endsWith("/environments") && init.method === "GET") {
        return response({ environments: [{
          environment_id: environmentId,
          environment_key: "development",
          display_name: "Development",
          system_key: "development",
          operating_model: "managed",
          lifecycle: "active",
          revision: 1,
          created_at: "2026-10-17T00:00:00Z",
          updated_at: "2026-10-17T00:00:00Z",
        }] });
      }
      if (input.includes("/collections?") && init.method === "GET") {
        return response({ collections: [{
          collection_id: "018f0000-0000-7000-8000-000000000060",
          collection_instance_id: collectionId,
          environment_id: environmentId,
          collection_key: "documents",
          display_name: "Documents",
          access_template: "private",
          storage_class: "normal",
          storage_binding_state: "ready",
          technical_metadata_extraction: true,
          malware_scan_required: false,
          content_extraction: false,
          ocr_extraction: false,
          transcription_extraction: false,
          vector_indexing: false,
          delivery_mode: "off",
          revision: 4,
          created_at: "2026-10-17T00:00:00Z",
        }], next_cursor: null });
      }
      if (input.endsWith("/storage-capabilities") && init.method === "GET") {
        return response({
          environment_id: environmentId,
          deployment_profile: "hosted",
          catalog_revision: 1,
          catalog_digest: `sha256:${"a".repeat(64)}`,
          expires_at: "2099-10-17T00:00:00Z",
          provider_matrix: {
            hosted: ["aws_s3", "google_cloud_storage", "azure_blob"],
            connected_site: ["aws_s3", "google_cloud_storage", "azure_blob"],
          },
          realizations: [{
            realization_id: "018f0000-0000-7000-8000-000000000040",
            display_name: "Managed storage",
            provider_family: "aws_s3",
            operating_model: "managed",
            location_id: "region.one",
            storage_classes: ["normal", "express"],
            health: "ready",
            capability_generation: 1,
            evidence_digest: `sha256:${"b".repeat(64)}`,
          }],
        });
      }
      if (input.endsWith(`/collections/${collectionId}/media`) && init.method === "GET") {
        return response({
          collection_instance_id: collectionId,
          image_presets: {},
          document_previews: false,
          video_profile: null,
          revision: 4,
          updated_at: "2026-10-17T00:00:00Z",
        });
      }
      if (input.endsWith(`/collections/${collectionId}/protection`) && init.method === "PUT") {
        return response({ disposition: "applied", config: { revision: 5 } });
      }
      if (input.endsWith(`/collections/${collectionId}/extraction`) && init.method === "PUT") {
        return response({ disposition: "applied", config: { revision: 6 } });
      }
      if (input.endsWith(`/collections/${collectionId}/media`) && init.method === "PUT") {
        return response({ disposition: "applied", config: { revision: 7 } });
      }
      if (input.endsWith(`/collections/${collectionId}/storage-migrations`) && init.method === "POST") {
        return response({ disposition: "applied", migration: { migration_id: operationId } }, 201);
      }
      assert.fail(`unexpected request: ${init.method} ${input}`);
    },
  });
  const desired = {
    api_version: "almira/v1",
    environments: [{
      key: "development",
      display_name: "Development",
      collections: [{
        key: "documents",
        display_name: "Documents",
        malware_scan_required: true,
        storage_class: "express",
        extraction: { content: true, ocr: false, transcription: false, vector_indexing: true },
        media: {
          image_presets: {},
          document_previews: true,
          video_profile: null,
        },
      }],
    }],
  };

  const plan = await previewConfiguration(client, { tenantId, projectId }, desired);
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(plan.actions.map((action) => [action.operation, action.expected_revision]), [
    ["collection_protection.replace", 4],
    ["collection_extraction.replace", 5],
    ["collection_media.replace", 6],
    ["storage_migration.start", undefined],
  ]);
  assert.equal(plan.actions[3].expected_collection_revision, 7);

  const receipt = await applyConfiguration(
    client,
    { tenantId, projectId },
    desired,
    { operationId },
  );
  assert.deepEqual(receipt.actions.map((action) => action.action_id), [
    "collection_protection.replace:development:documents",
    "collection_extraction.replace:development:documents",
    "collection_media.replace:development:documents",
    "storage_migration.start:development:documents",
  ]);
  const mutations = calls.filter(({ init }) => init.method !== "GET");
  assert.deepEqual(mutations.map(({ init }) => JSON.parse(init.body)), [
    { expected_revision: 4, config: { malware_scan_required: true } },
    { expected_revision: 5, config: { content: true, ocr: false, transcription: false, vector_indexing: true } },
    { expected_revision: 6, config: { image_presets: {}, document_previews: true, video_profile: null } },
    { target_storage_class: "express", expected_collection_revision: 7 },
  ]);
});
