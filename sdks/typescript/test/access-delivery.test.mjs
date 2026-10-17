import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { AlmiraClient, AlmiraDataClient } from "../dist/index.js";

const tenantId = "018f0000-0000-7000-8000-000000000002";
const projectId = "018f0000-0000-7000-8000-000000000003";
const environmentId = "018f0000-0000-7000-8000-000000000004";
const collectionInstanceId = "018f0000-0000-7000-8000-000000000005";
const entryId = "018f0000-0000-7000-8000-000000000006";
const operationId = "018f0000-0000-7000-8000-000000000007";
const issuerId = "018f0000-0000-7000-8000-000000000008";
const shareId = "018f0000-0000-7000-8000-000000000009";
const generationId = "018f0000-0000-7000-8000-000000000010";
const collection = { tenantId, projectId, environmentId, collectionInstanceId };

function json(value = {}) {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}

test("data client methods cover the promoted data-plane contract exactly", async () => {
  const contract = JSON.parse(await readFile(new URL("../../../contracts/data-openapi.v1.json", import.meta.url)));
  const operations = Object.values(contract.paths)
    .flatMap((path) => Object.values(path))
    .filter((operation) => !Array.isArray(operation) && typeof operation?.operationId === "string")
    .map((operation) => operation.operationId)
    .sort();
  const methods = Object.getOwnPropertyNames(AlmiraDataClient.prototype)
    .filter((name) => name !== "constructor")
    .sort();
  assert.deepEqual(methods, operations);
});

test("policy, delivery, share, and issuer methods use exact collection-scoped routes", async () => {
  const calls = [];
  const client = new AlmiraClient({
    credential: "mm_sak_v1.test",
    fetch: async (input, init) => {
      calls.push({ input, init });
      return json([]);
    },
  });
  const mutation = { operationId };
  await client.getCollectionPolicy(collection);
  await client.replaceCollectionPolicy(collection, {
    expected_revision: 1,
    document: { template: "private", rules: [] },
  }, mutation);
  await client.simulateCollectionPolicy(collection, {
    principal: { kind: "server" }, operation: "content_read", target: { kind: "collection" },
  }, mutation);
  await client.getDeliveryConfig(collection);
  await client.replaceDeliveryConfig(collection, {
    expected_revision: 1,
    config: { mode: "public", cache_preset: "revalidate", logical_aliases: false, direct_provider_private_downloads: false },
  }, mutation);
  await client.createShare(collection, { entry_id: entryId, generation_id: generationId, lifetime_seconds: 600 }, mutation);
  await client.revokeShare({ ...collection, shareId }, mutation);
  await client.listLocalIssuers(collection);
  await client.getLocalIssuerSigningConfiguration({ ...collection, issuerId });

  const base = `/v1/projects/${projectId}/environments/${environmentId}/collections/${collectionInstanceId}`;
  assert.deepEqual(calls.map(({ input, init }) => [init.method, input]), [
    ["GET", `${base}/policy`],
    ["PUT", `${base}/policy`],
    ["POST", `${base}/policy/simulations`],
    ["GET", `${base}/delivery`],
    ["PUT", `${base}/delivery`],
    ["POST", `${base}/shares`],
    ["DELETE", `${base}/shares/${shareId}`],
    ["GET", `${base}/local-issuers`],
    ["GET", `${base}/local-issuers/${issuerId}/signing-configuration`],
  ]);
  assert(calls.filter(({ init }) => init.method !== "GET")
    .every(({ init }) => init.headers.get("idempotency-key") === operationId));
});

test("builder subject context is canonical and travels on the same application call", async () => {
  let request;
  const client = new AlmiraClient({
    workloadSession: "workload_session",
    fetch: async (input, init) => {
      request = { input, init };
      return json({ entries: [], next_cursor: null });
    },
  });
  await client.listFiles(collection, {
    subject: {
      subject_id: "customer-42",
      roles: ["member"],
      attributes: { tier: "pro", region: "in" },
    },
  });
  const encoded = request.init.headers.get("x-almira-subject-context");
  assert(encoded);
  assert.equal(
    Buffer.from(encoded, "base64url").toString("utf8"),
    '{"attributes":{"region":"in","tier":"pro"},"roles":["member"],"subject_id":"customer-42"}',
  );
  assert.equal(request.init.headers.get("authorization"), "MetamorphWorkload workload_session");
});

test("data client keeps capabilities off management headers and uses data-plane paths", async () => {
  const calls = [];
  const client = new AlmiraDataClient({
    baseUrl: "https://almira.test",
    capability: "alm_cap_v1.abcdefghijklmnopqrstuvwxyz0123456789",
    origin: "https://app.example",
    fetch: async (input, init) => {
      calls.push({ input, init });
      return input.includes("/v1/data/")
        ? json({ entries: [], next_cursor: null })
        : new Response(new Uint8Array([1, 2]), { headers: { "content-type": "application/octet-stream" } });
    },
  });
  await client.listFilesWithCapability(collection);
  await client.searchFilesWithCapability(collection, { query: "invoice", mode: "lexical" });
  await client.listDerivativesWithCapability({ ...collection, entryId, generationId });
  await client.readDerivative({ ...collection, entryId, generationId, variantKey: "avatar/256.webp" });
  await client.readImmutableGeneration({ ...collection, entryId, generationId });
  await client.readShare(`alm_share_v1.${"a".repeat(43)}`);
  assert.equal(calls[0].input, `https://almira.test/v1/data/${tenantId}/${projectId}/${environmentId}/${collectionInstanceId}/files`);
  assert.equal(calls[1].input, `https://almira.test/v1/data/${tenantId}/${projectId}/${environmentId}/${collectionInstanceId}/search`);
  assert.equal(calls[1].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[1].init.body), { query: "invoice", mode: "lexical" });
  assert.equal(calls[2].input, `https://almira.test/v1/data/${tenantId}/${projectId}/${environmentId}/${collectionInstanceId}/files/${entryId}/versions/${generationId}/derivatives`);
  assert.equal(calls[3].input, `https://almira.test/v1/delivery/${tenantId}/${projectId}/${environmentId}/${collectionInstanceId}/${entryId}/${generationId}/variants/avatar/256.webp`);
  assert.equal(calls[4].input, `https://almira.test/v1/delivery/${tenantId}/${projectId}/${environmentId}/${collectionInstanceId}/${entryId}/${generationId}`);
  assert(calls.every(({ init }) => init.headers.get("x-almira-tenant-id") === null));
  assert(calls.slice(0, 5).every(({ init }) => init.headers.get("origin") === "https://app.example"));
  assert(calls.slice(0, 5).every(({ init }) => init.headers.get("authorization")?.startsWith("Bearer alm_cap_v1.")));
  assert.equal(calls[5].init.headers.get("origin"), null);
  assert.equal(calls[5].init.headers.get("authorization"), null);
});

test("data client refuses path-like derivative variant keys locally", async () => {
  const client = new AlmiraDataClient({
    capability: "alm_cap_v1.abcdefghijklmnopqrstuvwxyz0123456789",
    fetch: async () => assert.fail("invalid variant keys must not call the API"),
  });
  await assert.rejects(
    client.readDerivative({ ...collection, entryId, generationId, variantKey: "hls/../secret" }),
    (error) => error.code === "ALMIRA_CLIENT_INPUT_INVALID",
  );
});
