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
      "almira_collection_get",
      "almira_collection_list",
      "almira_configuration_apply",
      "almira_configuration_preview",
      "almira_environment_create",
      "almira_environment_delete",
      "almira_environment_list",
      "almira_environment_update",
      "almira_file_delete",
      "almira_file_list",
      "almira_file_metadata_get",
      "almira_project_bootstrap",
      "almira_storage_capabilities_get",
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
