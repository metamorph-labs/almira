import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { AlmiraClient } from "@metamorph-labs/almira-sdk";

import { createAlmiraMcpServer } from "../dist/server.js";

const projectId = "018f0000-0000-7000-8000-000000000003";
const tenantId = "018f0000-0000-7000-8000-000000000002";
const requestId = "018f0000-0000-7000-8000-000000000008";

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function connected(fetch) {
  const server = createAlmiraMcpServer(
    new AlmiraClient({
      baseUrl: "https://almira.test",
      credential: "mm_sak_v1.test",
      fetch,
    }),
  );
  const client = new Client({ name: "almira-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

test("MCP package version matches the promoted API", async () => {
  const contract = JSON.parse(await readFile(new URL("../../../contracts/openapi.v1.json", import.meta.url)));
  const packageManifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url)));
  assert.equal(packageManifest.version, contract.info.version);
});

test("tool catalog is closed and marks destructive behavior accurately", async (context) => {
  const connection = await connected(async () => assert.fail("no API request"));
  context.after(async () => {
    await connection.client.close();
    await connection.server.close();
  });
  const response = await connection.client.listTools();
  assert.deepEqual(
    response.tools.map((tool) => tool.name).sort(),
    [
      "almira_browser_origins_get",
      "almira_browser_origins_replace",
      "almira_collection_create",
      "almira_collection_extraction_get",
      "almira_collection_extraction_replace",
      "almira_collection_get",
      "almira_collection_list",
      "almira_collection_media_get",
      "almira_collection_media_replace",
      "almira_collection_protection_get",
      "almira_collection_protection_replace",
      "almira_configuration_apply",
      "almira_configuration_preview",
      "almira_delivery_get",
      "almira_delivery_replace",
      "almira_environment_create",
      "almira_environment_delete",
      "almira_environment_list",
      "almira_environment_update",
      "almira_file_customer_metadata_get",
      "almira_file_customer_metadata_replace",
      "almira_file_delete",
      "almira_file_derivatives_list",
      "almira_file_extracted_content_get",
      "almira_file_extraction_get",
      "almira_file_generation_restore",
      "almira_file_list",
      "almira_file_metadata_get",
      "almira_file_rename",
      "almira_file_restore",
      "almira_file_search",
      "almira_file_versions_list",
      "almira_local_issuer_list",
      "almira_local_issuer_register",
      "almira_local_issuer_revoke",
      "almira_local_issuer_rotate",
      "almira_local_issuer_signing_configuration_get",
      "almira_policy_get",
      "almira_policy_replace",
      "almira_policy_simulate",
      "almira_processing_job_cancel",
      "almira_processing_job_retry",
      "almira_processing_jobs_list",
      "almira_project_bootstrap",
      "almira_protection_cases_list",
      "almira_protection_rescan",
      "almira_protection_review_create",
      "almira_share_create",
      "almira_share_revoke",
      "almira_storage_capabilities_get",
      "almira_storage_migration_get",
      "almira_storage_migration_start",
    ],
  );
  assert.equal(
    response.tools.find((tool) => tool.name === "almira_file_delete").annotations.destructiveHint,
    true,
  );
  assert.equal(
    response.tools.find((tool) => tool.name === "almira_environment_delete").annotations.destructiveHint,
    true,
  );
  assert.equal(
    response.tools.find((tool) => tool.name === "almira_environment_list").annotations.readOnlyHint,
    true,
  );
  assert.equal(
    response.tools.find((tool) => tool.name === "almira_file_versions_list").annotations.readOnlyHint,
    true,
  );
  assert.equal(
    response.tools.find((tool) => tool.name === "almira_file_restore").annotations.destructiveHint,
    false,
  );
  assert.equal(
    response.tools.find((tool) => tool.name === "almira_share_revoke").annotations.destructiveHint,
    true,
  );
});

test("metadata and extraction tools keep safe status separate from protected content", async (context) => {
  const environmentId = "018f0000-0000-7000-8000-000000000004";
  const collectionId = "018f0000-0000-7000-8000-000000000005";
  const entryId = "018f0000-0000-7000-8000-000000000006";
  const generationId = "018f0000-0000-7000-8000-000000000009";
  const operationId = "018f0000-0000-7000-8000-000000000007";
  const requests = [];
  const connection = await connected(async (input, init) => {
    requests.push({ input, init });
    return json(init.method === "PUT" ? { disposition: "applied" } : {});
  });
  context.after(async () => {
    await connection.client.close();
    await connection.server.close();
  });
  const scope = {
    tenant_id: tenantId,
    project_id: projectId,
    environment_id: environmentId,
    collection_instance_id: collectionId,
  };
  await connection.client.callTool({
    name: "almira_collection_extraction_replace",
    arguments: {
      ...scope, expected_revision: 2, content: true, ocr: false, transcription: false,
      vector_indexing: true, operation_id: operationId,
    },
  });
  await connection.client.callTool({
    name: "almira_file_customer_metadata_replace",
    arguments: {
      ...scope, entry_id: entryId, expected_revision: 3, operation_id: operationId,
      metadata: { tags: ["invoice"], custom: { account_id: "acme" } },
    },
  });
  await connection.client.callTool({
    name: "almira_file_extraction_get",
    arguments: { ...scope, entry_id: entryId, generation_id: generationId, kind: "content" },
  });
  await connection.client.callTool({
    name: "almira_file_extracted_content_get",
    arguments: { ...scope, entry_id: entryId, generation_id: generationId, kind: "content" },
  });

  const base = `https://almira.test/v1/projects/${projectId}/environments/${environmentId}/collections/${collectionId}`;
  const fileBase = `${base}/files/${entryId}`;
  assert.deepEqual(requests.map(({ input, init }) => ({
    input,
    method: init.method,
    operationId: init.headers.get("idempotency-key"),
    body: init.body === undefined ? undefined : JSON.parse(init.body),
  })), [
    {
      input: `${base}/extraction`, method: "PUT", operationId,
      body: {
        expected_revision: 2,
        config: { content: true, ocr: false, transcription: false, vector_indexing: true },
      },
    },
    {
      input: `${fileBase}/metadata`, method: "PUT", operationId,
      body: { expected_revision: 3, metadata: { tags: ["invoice"], custom: { account_id: "acme" } } },
    },
    { input: `${fileBase}/versions/${generationId}/extractions/content`, method: "GET", operationId: null, body: undefined },
    { input: `${fileBase}/versions/${generationId}/extracted-content/content`, method: "GET", operationId: null, body: undefined },
  ]);
});

test("media tools preserve configuration, job, and immutable generation scope", async (context) => {
  const environmentId = "018f0000-0000-7000-8000-000000000004";
  const collectionId = "018f0000-0000-7000-8000-000000000005";
  const entryId = "018f0000-0000-7000-8000-000000000006";
  const operationId = "018f0000-0000-7000-8000-000000000007";
  const generationId = "018f0000-0000-7000-8000-000000000009";
  const jobId = "018f0000-0000-7000-8000-000000000010";
  const requests = [];
  const connection = await connected(async (input, init) => {
    requests.push({ input, init });
    return json(input.endsWith("/derivatives") ? [] : init.method === "GET" ? {} : { disposition: "applied" });
  });
  context.after(async () => {
    await connection.client.close();
    await connection.server.close();
  });
  const scope = {
    tenant_id: tenantId,
    project_id: projectId,
    environment_id: environmentId,
    collection_instance_id: collectionId,
  };
  await connection.client.callTool({ name: "almira_collection_media_get", arguments: scope });
  await connection.client.callTool({
    name: "almira_collection_media_replace",
    arguments: {
      ...scope,
      expected_revision: 2,
      operation_id: operationId,
      config: {
        image_presets: {
          card: { widths: [320, 640], height: null, fit: "inside", formats: ["avif", "webp"], without_enlargement: true },
        },
        document_previews: true,
        video_profile: null,
      },
    },
  });
  await connection.client.callTool({ name: "almira_processing_jobs_list", arguments: { ...scope, limit: 25 } });
  await connection.client.callTool({
    name: "almira_processing_job_retry",
    arguments: { ...scope, job_id: jobId, expected_revision: 3, operation_id: operationId },
  });
  await connection.client.callTool({
    name: "almira_processing_job_cancel",
    arguments: { ...scope, job_id: jobId, expected_revision: 4, operation_id: operationId },
  });
  await connection.client.callTool({
    name: "almira_file_derivatives_list",
    arguments: { ...scope, entry_id: entryId, generation_id: generationId },
  });

  const base = `https://almira.test/v1/projects/${projectId}/environments/${environmentId}/collections/${collectionId}`;
  assert.deepEqual(requests.map(({ input, init }) => [init.method, input]), [
    ["GET", `${base}/media`],
    ["PUT", `${base}/media`],
    ["GET", `${base}/processing-jobs?limit=25`],
    ["POST", `${base}/processing-jobs/${jobId}/retry`],
    ["POST", `${base}/processing-jobs/${jobId}/cancel`],
    ["GET", `${base}/files/${entryId}/versions/${generationId}/derivatives`],
  ]);
});

test("protection tools expose policy, cases, rescan, and review but no verdict override", async (context) => {
  const environmentId = "018f0000-0000-7000-8000-000000000004";
  const collectionId = "018f0000-0000-7000-8000-000000000005";
  const entryId = "018f0000-0000-7000-8000-000000000006";
  const operationId = "018f0000-0000-7000-8000-000000000007";
  const generationId = "018f0000-0000-7000-8000-000000000009";
  const requests = [];
  const connection = await connected(async (input, init) => {
    requests.push({ input, init });
    if (input.includes("/protection/cases")) return json({ cases: [], next_cursor: null });
    if (input.endsWith("/protection-rescans")) return json({ disposition: "applied", job: {} }, 201);
    if (input.endsWith("/protection-reviews")) return json({ disposition: "applied", review: {} }, 201);
    return json(init.method === "GET" ? {} : { disposition: "applied", config: {} });
  });
  context.after(async () => {
    await connection.client.close();
    await connection.server.close();
  });
  const collectionScope = {
    tenant_id: tenantId,
    project_id: projectId,
    environment_id: environmentId,
    collection_instance_id: collectionId,
  };
  await connection.client.callTool({
    name: "almira_collection_protection_get",
    arguments: collectionScope,
  });
  await connection.client.callTool({
    name: "almira_collection_protection_replace",
    arguments: {
      ...collectionScope,
      expected_revision: 2,
      malware_scan_required: true,
      operation_id: operationId,
    },
  });
  await connection.client.callTool({
    name: "almira_protection_cases_list",
    arguments: {
      tenant_id: tenantId,
      project_id: projectId,
      environment_id: environmentId,
      collection_instance_id: collectionId,
      safety_state: "blocked",
      limit: 25,
      cursor: "next page",
    },
  });
  await connection.client.callTool({
    name: "almira_protection_rescan",
    arguments: {
      ...collectionScope,
      entry_id: entryId,
      generation_id: generationId,
      expected_revision: 4,
      operation_id: operationId,
    },
  });
  await connection.client.callTool({
    name: "almira_protection_review_create",
    arguments: {
      ...collectionScope,
      entry_id: entryId,
      generation_id: generationId,
      expected_revision: 5,
      decision: "suspected_false_positive",
      reason: "Escalated for an independent scanner review.",
      operation_id: operationId,
    },
  });

  const base = `https://almira.test/v1/projects/${projectId}/environments/${environmentId}`;
  const collectionBase = `${base}/collections/${collectionId}`;
  const generationBase = `${collectionBase}/files/${entryId}/versions/${generationId}`;
  assert.deepEqual(requests.map(({ input, init }) => ({
    input,
    method: init.method,
    body: init.body === undefined ? undefined : JSON.parse(init.body),
  })), [
    { input: `${collectionBase}/protection`, method: "GET", body: undefined },
    {
      input: `${collectionBase}/protection`, method: "PUT",
      body: { expected_revision: 2, config: { malware_scan_required: true } },
    },
    {
      input: `${base}/protection/cases?limit=25&cursor=next+page&collection_instance_id=${collectionId}&safety_state=blocked`,
      method: "GET", body: undefined,
    },
    {
      input: `${generationBase}/protection-rescans`, method: "POST",
      body: { expected_revision: 4 },
    },
    {
      input: `${generationBase}/protection-reviews`, method: "POST",
      body: {
        expected_revision: 5,
        review: {
          decision: "suspected_false_positive",
          reason: "Escalated for an independent scanner review.",
        },
      },
    },
  ]);

  const tools = await connection.client.listTools();
  assert.equal(tools.tools.some((tool) => /release/iu.test(tool.name)), false);
});

test("file lifecycle tools preserve stable entry scope, revisions, and operation identity", async (context) => {
  const environmentId = "018f0000-0000-7000-8000-000000000004";
  const collectionId = "018f0000-0000-7000-8000-000000000005";
  const entryId = "018f0000-0000-7000-8000-000000000006";
  const generationId = "018f0000-0000-7000-8000-000000000009";
  const operationId = "018f0000-0000-7000-8000-000000000007";
  const requests = [];
  const connection = await connected(async (input, init) => {
    requests.push({ input, init });
    return json(init.method === "GET" ? { generations: [], entries: [], next_cursor: null } : { disposition: "applied" });
  });
  context.after(async () => {
    await connection.client.close();
    await connection.server.close();
  });
  const scope = {
    tenant_id: tenantId,
    project_id: projectId,
    environment_id: environmentId,
    collection_instance_id: collectionId,
  };
  await connection.client.callTool({
    name: "almira_file_list",
    arguments: { ...scope, include_deleted: true },
  });
  await connection.client.callTool({
    name: "almira_file_search",
    arguments: {
      ...scope, query: "quarterly report", mode: "hybrid",
      filter: { tag: "finance" }, facets: ["tags"], page_size: 20,
    },
  });
  await connection.client.callTool({
    name: "almira_file_versions_list",
    arguments: { ...scope, entry_id: entryId, limit: 25 },
  });
  await connection.client.callTool({
    name: "almira_file_rename",
    arguments: { ...scope, entry_id: entryId, logical_path: "archive/file.txt", expected_revision: 3, operation_id: operationId },
  });
  await connection.client.callTool({
    name: "almira_file_generation_restore",
    arguments: { ...scope, entry_id: entryId, generation_id: generationId, expected_revision: 4, operation_id: operationId },
  });
  await connection.client.callTool({
    name: "almira_file_restore",
    arguments: { ...scope, entry_id: entryId, expected_revision: 5, operation_id: operationId },
  });

  const base = `https://almira.test/v1/projects/${projectId}/environments/${environmentId}/collections/${collectionId}/files`;
  assert.deepEqual(requests.map(({ input, init }) => ({
    input,
    method: init.method,
    operationId: init.headers.get("idempotency-key"),
    body: init.body === undefined ? undefined : JSON.parse(init.body),
  })), [
    { input: `${base}?include_deleted=true`, method: "GET", operationId: null, body: undefined },
    {
      input: `${base.replace(/\/files$/u, "")}/search`, method: "POST", operationId: null,
      body: {
        query: "quarterly report", mode: "hybrid", filter: { tag: "finance" },
        facets: ["tags"], page_size: 20,
      },
    },
    { input: `${base}/${entryId}/versions?limit=25`, method: "GET", operationId: null, body: undefined },
    { input: `${base}/${entryId}`, method: "PATCH", operationId, body: { logical_path: "archive/file.txt", expected_revision: 3 } },
    { input: `${base}/${entryId}/current-generation`, method: "PUT", operationId, body: { generation_id: generationId, expected_revision: 4 } },
    { input: `${base}/${entryId}/restore`, method: "POST", operationId, body: { expected_revision: 5 } },
  ]);
});

test("configuration tools preview and converge the same structured document", async (context) => {
  const requests = [];
  const connection = await connected(async (input, init) => {
    requests.push({ input, init });
    return json({ environments: [] });
  });
  context.after(async () => {
    await connection.client.close();
    await connection.server.close();
  });
  const configuration = { api_version: "almira/v1", environments: [] };
  const preview = await connection.client.callTool({
    name: "almira_configuration_preview",
    arguments: { tenant_id: tenantId, project_id: projectId, configuration },
  });
  assert.equal(preview.isError, undefined);
  assert.equal(preview.structuredContent.result.preserves_unlisted_resources, true);

  const operationId = "018f0000-0000-7000-8000-000000000007";
  const applied = await connection.client.callTool({
    name: "almira_configuration_apply",
    arguments: { tenant_id: tenantId, project_id: projectId, configuration, operation_id: operationId },
  });
  assert.equal(applied.isError, undefined);
  assert.equal(applied.structuredContent.operation_id, operationId);
  assert.equal(applied.structuredContent.result.disposition, "converged");
  assert.equal(requests.length, 2);
  assert(requests.every(({ init }) => init.method === "GET"));
});

test("storage capability tool performs one exact read without mutation authority", async (context) => {
  let request;
  const environmentId = "018f0000-0000-7000-8000-000000000004";
  const connection = await connected(async (input, init) => {
    request = { input, init };
    return json({ environment_id: environmentId, realizations: [] });
  });
  context.after(async () => {
    await connection.client.close();
    await connection.server.close();
  });

  const response = await connection.client.callTool({
    name: "almira_storage_capabilities_get",
    arguments: { tenant_id: tenantId, project_id: projectId, environment_id: environmentId },
  });
  assert.equal(response.isError, undefined);
  assert.equal(
    request.input,
    `https://almira.test/v1/projects/${projectId}/environments/${environmentId}/storage-capabilities`,
  );
  assert.equal(request.init.method, "GET");
  assert.equal(request.init.headers.get("idempotency-key"), null);
});

test("collection creation forwards the selected storage class", async (context) => {
  let request;
  const environmentId = "018f0000-0000-7000-8000-000000000004";
  const operationId = "018f0000-0000-7000-8000-000000000007";
  const connection = await connected(async (input, init) => {
    request = { input, init };
    return json({ disposition: "applied", collection: {} }, 201);
  });
  context.after(async () => {
    await connection.client.close();
    await connection.server.close();
  });

  const response = await connection.client.callTool({
    name: "almira_collection_create",
    arguments: {
      tenant_id: tenantId,
      project_id: projectId,
      environment_id: environmentId,
      collection_key: "sessions",
      display_name: "Sessions",
      malware_scan_required: false,
      storage_class: "express",
      operation_id: operationId,
    },
  });
  assert.equal(response.isError, undefined);
  assert.equal(request.init.headers.get("idempotency-key"), operationId);
  assert.deepEqual(JSON.parse(request.init.body), {
    collection_key: "sessions",
    display_name: "Sessions",
    malware_scan_required: false,
    storage_class: "express",
  });
});

test("policy and CDN tools preserve exact collection scope and revision", async (context) => {
  const requests = [];
  const environmentId = "018f0000-0000-7000-8000-000000000004";
  const collectionId = "018f0000-0000-7000-8000-000000000012";
  const operationId = "018f0000-0000-7000-8000-000000000007";
  const connection = await connected(async (input, init) => {
    requests.push({ input, init });
    return json({ disposition: "applied" });
  });
  context.after(async () => {
    await connection.client.close();
    await connection.server.close();
  });
  const common = {
    tenant_id: tenantId,
    project_id: projectId,
    environment_id: environmentId,
    collection_instance_id: collectionId,
    expected_revision: 3,
    operation_id: operationId,
  };
  await connection.client.callTool({
    name: "almira_policy_replace",
    arguments: { ...common, document: { template: "private", rules: [] } },
  });
  await connection.client.callTool({
    name: "almira_delivery_replace",
    arguments: {
      ...common,
      config: {
        mode: "public",
        cache_preset: "revalidate",
        logical_aliases: false,
        direct_provider_private_downloads: false,
      },
    },
  });
  const base = `https://almira.test/v1/projects/${projectId}/environments/${environmentId}/collections/${collectionId}`;
  assert.deepEqual(requests.map(({ input, init }) => ({
    input,
    method: init.method,
    operationId: init.headers.get("idempotency-key"),
    body: JSON.parse(init.body),
  })), [
    {
      input: `${base}/policy`, method: "PUT", operationId,
      body: { expected_revision: 3, document: { template: "private", rules: [] } },
    },
    {
      input: `${base}/delivery`, method: "PUT", operationId,
      body: {
        expected_revision: 3,
        config: {
          mode: "public", cache_preset: "revalidate", logical_aliases: false,
          direct_provider_private_downloads: false,
        },
      },
    },
  ]);
});

test("storage migration tools preserve exact scope, revision, and replay identity", async (context) => {
  const requests = [];
  const environmentId = "018f0000-0000-7000-8000-000000000004";
  const collectionId = "018f0000-0000-7000-8000-000000000012";
  const migrationId = "018f0000-0000-7000-8000-000000000013";
  const operationId = "018f0000-0000-7000-8000-000000000007";
  const connection = await connected(async (input, init) => {
    requests.push({ input, init });
    return json(init.method === "POST"
      ? { disposition: "applied", migration: { migration_id: migrationId } }
      : { migration_id: migrationId }, init.method === "POST" ? 201 : 200);
  });
  context.after(async () => {
    await connection.client.close();
    await connection.server.close();
  });
  const common = {
    tenant_id: tenantId,
    project_id: projectId,
    environment_id: environmentId,
    collection_instance_id: collectionId,
  };

  const started = await connection.client.callTool({
    name: "almira_storage_migration_start",
    arguments: {
      ...common,
      target_storage_class: "express",
      expected_collection_revision: 4,
      operation_id: operationId,
    },
  });
  const status = await connection.client.callTool({
    name: "almira_storage_migration_get",
    arguments: { ...common, migration_id: migrationId },
  });

  assert.equal(started.isError, undefined);
  assert.equal(started.structuredContent.operation_id, operationId);
  assert.equal(status.isError, undefined);
  const path = `https://almira.test/v1/projects/${projectId}/environments/${environmentId}/collections/${collectionId}/storage-migrations`;
  assert.deepEqual(requests.map(({ input, init }) => ({
    input,
    method: init.method,
    operationId: init.headers.get("idempotency-key"),
    body: init.body === undefined ? undefined : JSON.parse(init.body),
  })), [
    {
      input: path,
      method: "POST",
      operationId,
      body: { target_storage_class: "express", expected_collection_revision: 4 },
    },
    {
      input: `${path}/${migrationId}`,
      method: "GET",
      operationId: null,
      body: undefined,
    },
  ]);
});

test("environment tools call the exact public lifecycle operations", async (context) => {
  const requests = [];
  const connection = await connected(async (input, init) => {
    requests.push({ input, init });
    return json({ disposition: "applied", environment: {} }, init.method === "POST" ? 201 : 200);
  });
  context.after(async () => {
    await connection.client.close();
    await connection.server.close();
  });
  const common = { tenant_id: tenantId, project_id: projectId, operation_id: "018f0000-0000-7000-8000-000000000007" };
  const environmentId = "018f0000-0000-7000-8000-000000000004";

  await connection.client.callTool({
    name: "almira_environment_create",
    arguments: { ...common, environment_key: "preview-one", display_name: "Preview one" },
  });
  await connection.client.callTool({
    name: "almira_environment_update",
    arguments: { ...common, environment_id: environmentId, display_name: "Preview renamed", expected_revision: 2 },
  });
  await connection.client.callTool({
    name: "almira_environment_delete",
    arguments: { ...common, environment_id: environmentId, expected_revision: 3 },
  });

  assert.deepEqual(requests.map(({ input, init }) => ({
    input,
    method: init.method,
    ifMatch: init.headers.get("if-match"),
    body: init.body === undefined ? undefined : JSON.parse(init.body),
  })), [
    { input: `https://almira.test/v1/projects/${projectId}/environments`, method: "POST", ifMatch: null, body: { environment_key: "preview-one", display_name: "Preview one" } },
    { input: `https://almira.test/v1/projects/${projectId}/environments/${environmentId}`, method: "PATCH", ifMatch: null, body: { display_name: "Preview renamed", expected_revision: 2 } },
    { input: `https://almira.test/v1/projects/${projectId}/environments/${environmentId}`, method: "DELETE", ifMatch: "3", body: undefined },
  ]);
});

test("bootstrap tool uses SDK authorization and returns the generated operation ID", async (context) => {
  let operationId;
  const connection = await connected(async (_input, init) => {
    operationId = init.headers.get("idempotency-key");
    assert.equal(init.headers.get("authorization"), "Bearer mm_sak_v1.test");
    assert.equal(init.headers.get("x-almira-tenant-id"), tenantId);
    return json({ disposition: "converged", project_revision: 1, environments: [] });
  });
  context.after(async () => {
    await connection.client.close();
    await connection.server.close();
  });
  const response = await connection.client.callTool({
    name: "almira_project_bootstrap",
    arguments: {
      tenant_id: tenantId,
      project_id: projectId,
      tenancy_project: {
        schema_version: 1,
        operation_id: "018f0000-0000-7000-8000-000000000010",
        operation: "project.get",
        disposition: "succeeded",
        result: { project: {
          tenant_id: tenantId,
          project_id: projectId,
          space_id: "018f0000-0000-7000-8000-000000000011",
          product_id: "almira",
          product_section_id: null,
          project_kind_id: "almira.storage",
          owner_region_id: "region.one",
          name: "Files",
          visibility: "private",
          lifecycle: "active",
          route_epoch: 1,
          revision: 3,
          restrictive_revision: 1,
          activated_at: "2026-10-17T00:00:00Z",
        } },
      },
    },
  });
  assert.equal(response.isError, undefined);
  assert.match(operationId, /^[0-9a-f]{8}-[0-9a-f]{4}-7/u);
  assert.equal(response.structuredContent.operation_id, operationId);
  assert.deepEqual(JSON.parse(response.content[0].text), response.structuredContent);
});

test("API refusals become safe tool errors without exception detail", async (context) => {
  const connection = await connected(async () =>
    json({ code: "ALMIRA_AUTHORIZATION_REFUSED", request_id: requestId }, 403),
  );
  context.after(async () => {
    await connection.client.close();
    await connection.server.close();
  });
  const response = await connection.client.callTool({
    name: "almira_environment_list",
    arguments: { tenant_id: tenantId, project_id: projectId },
  });
  assert.equal(response.isError, true);
  assert.deepEqual(JSON.parse(response.content[0].text), {
    code: "ALMIRA_AUTHORIZATION_REFUSED",
    request_id: requestId,
    status: 403,
    retry_after_milliseconds: null,
  });
  assert.doesNotMatch(response.content[0].text, /mm_sak_v1[.]test/u);
});

test("invalid tool inputs are refused before any Almira request", async (context) => {
  const connection = await connected(async () => assert.fail("no API request"));
  context.after(async () => {
    await connection.client.close();
    await connection.server.close();
  });
  const response = await connection.client.callTool({
    name: "almira_environment_list",
    arguments: { tenant_id: tenantId, project_id: "wrong", unexpected: true },
  });
  assert.equal(response.isError, true);
});
