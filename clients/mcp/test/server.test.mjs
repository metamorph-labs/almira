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
      "almira_environment_list",
      "almira_file_delete",
      "almira_file_list",
      "almira_file_metadata_get",
      "almira_project_bootstrap",
    ],
  );
  assert.equal(
    response.tools.find((tool) => tool.name === "almira_file_delete").annotations.destructiveHint,
    true,
  );
  assert.equal(
    response.tools.find((tool) => tool.name === "almira_environment_list").annotations.readOnlyHint,
    true,
  );
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
