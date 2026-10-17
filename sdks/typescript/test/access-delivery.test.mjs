import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  AlmiraClient,
  AlmiraDataClient,
  createCapabilityDataClient,
} from "../dist/index.js";

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
  await client.listFilesWithCapability(collection, {
    limit: 25,
    cursor: "next page",
    pathPrefix: "avatars",
    tag: "profile.photo",
    metadataKey: "account.tier",
    metadataValue: "pro",
    verifiedMediaType: "image/jpeg",
    minimumSizeBytes: 10,
    maximumSizeBytes: 5000,
    createdAfter: "2026-01-01T00:00:00Z",
    createdBefore: "2026-02-01T00:00:00Z",
    extractionKind: "technical",
    extractionState: "succeeded",
  });
  await client.searchFilesWithCapability(collection, { query: "invoice", mode: "lexical" });
  await client.listDerivativesWithCapability({ ...collection, entryId, generationId });
  await client.readDerivative({ ...collection, entryId, generationId, variantKey: "avatar/256.webp" });
  await client.readImmutableGeneration({ ...collection, entryId, generationId });
  await client.readShare(`alm_share_v1.${"a".repeat(43)}`);
  assert.equal(
    calls[0].input,
    `https://almira.test/v1/data/${tenantId}/${projectId}/${environmentId}/${collectionInstanceId}/files?limit=25&cursor=next+page&path_prefix=avatars&tag=profile.photo&metadata_key=account.tier&metadata_value=%22pro%22&verified_media_type=image%2Fjpeg&minimum_size_bytes=10&maximum_size_bytes=5000&created_after=2026-01-01T00%3A00%3A00Z&created_before=2026-02-01T00%3A00%3A00Z&extraction_kind=technical&extraction_state=succeeded`,
  );
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
  await assert.rejects(
    client.listFilesWithCapability(collection, { pathPrefix: "../secret" }),
    (error) => error.code === "ALMIRA_CLIENT_INPUT_INVALID",
  );
});

test("opt-in data retries re-resolve capability and replay only the safe request", async () => {
  const calls = [];
  let credentialCalls = 0;
  const client = new AlmiraDataClient({
    baseUrl: "https://almira.test",
    capability: () => {
      credentialCalls += 1;
      return `alm_cap_v1.${"a".repeat(42)}${credentialCalls}`;
    },
    retry: { maxAttempts: 3, baseDelayMilliseconds: 0, maximumDelayMilliseconds: 0 },
    fetch: async (input, init) => {
      calls.push({ input, init });
      if (calls.length === 1) {
        return new Response(JSON.stringify({ code: "ALMIRA_TEMPORARILY_UNAVAILABLE", request_id: operationId }), {
          status: 503,
          headers: { "content-type": "application/json", "retry-after": "0" },
        });
      }
      return json({ entries: [], next_cursor: null });
    },
  });
  await client.listFilesWithCapability(collection);
  assert.equal(calls.length, 2);
  assert.equal(credentialCalls, 2);
  assert.equal(calls[0].input, calls[1].input);
  assert.notEqual(
    calls[0].init.headers.get("authorization"),
    calls[1].init.headers.get("authorization"),
  );
});

test("workload exchange returns a capability-only data client without credential crossover", async () => {
  const calls = [];
  const grant = {
    session_id: "018f0000-0000-7000-8000-000000000011",
    token: `alm_cap_v1.${"a".repeat(43)}`,
    operations: ["metadata_read"],
    resource: { kind: "collection" },
    audience: "https://app.example",
    policy_revision: 1,
    issuer_epoch: 1,
    expires_at: "2026-10-17T12:00:00Z",
  };
  const exchangeFetch = async (input, init) => {
    calls.push({ input, init });
    return new Response(JSON.stringify(grant), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  };
  const dataFetch = async (input, init) => {
    calls.push({ input, init });
    return json({ entry_id: entryId });
  };
  const managementClient = new AlmiraClient({
    baseUrl: "https://almira.test",
    workloadSession: "workload_session_evidence",
    fetch: exchangeFetch,
  });
  const session = await createCapabilityDataClient(
    managementClient,
    collection,
    {
      subject: { subject_id: "user_42" },
      operations: ["metadata_read"],
      resource: { kind: "collection" },
      audience: "https://app.example",
      lifetime_seconds: 300,
    },
    { operationId },
    { baseUrl: "https://almira.test", fetch: dataFetch },
  );
  assert.deepEqual(session.grant, grant);
  await session.dataClient.getFileMetadataWithCapability({ ...collection, entryId });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.headers.get("authorization"), "MetamorphWorkload workload_session_evidence");
  assert.equal(calls[1].init.headers.get("authorization"), `Bearer ${grant.token}`);
  assert.equal(calls[1].init.headers.get("origin"), grant.audience);
  assert.equal(calls[1].init.headers.has("x-almira-tenant-id"), false);
});
