import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  AlmiraApiError,
  AlmiraClient,
  AlmiraClientError,
  createOperationId,
} from "../dist/index.js";

const projectId = "018f0000-0000-7000-8000-000000000003";
const tenantId = "018f0000-0000-7000-8000-000000000002";
const environmentId = "018f0000-0000-7000-8000-000000000004";
const collectionInstanceId = "018f0000-0000-7000-8000-000000000005";
const entryId = "018f0000-0000-7000-8000-000000000006";
const operationId = "018f0000-0000-7000-8000-000000000007";
const requestId = "018f0000-0000-7000-8000-000000000008";

test("operation IDs are UUIDv7 values with the requested timestamp", () => {
  const operationId = createOperationId(1_729_080_000_000);
  assert.match(operationId, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.equal(BigInt(`0x${operationId.replaceAll("-", "").slice(0, 12)}`), 1_729_080_000_000n);
});

test("SDK version and methods cover the promoted contract exactly", async () => {
  const contract = JSON.parse(await readFile(new URL("../../../contracts/openapi.v1.json", import.meta.url)));
  const packageManifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url)));
  const operations = Object.values(contract.paths)
    .flatMap((path) => Object.values(path))
    .filter((operation) => !Array.isArray(operation) && typeof operation?.operationId === "string")
    .map((operation) => operation.operationId)
    .sort();
  const methods = Object.getOwnPropertyNames(AlmiraClient.prototype)
    .filter((name) => name !== "constructor")
    .sort();
  assert.equal(packageManifest.version, contract.info.version);
  assert.deepEqual(methods, operations);
});

function json(value, init = {}) {
  return new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

test("bearer management request is exact and omits browser credentials", async () => {
  const calls = [];
  const client = new AlmiraClient({
    baseUrl: "https://almira.test/",
    credential: async () => "mm_sak_v1.test",
    fetch: async (input, init) => {
      calls.push({ input, init });
      return json({
        disposition: "applied",
        collection: { collection_instance_id: collectionInstanceId },
      }, { status: 201 });
    },
  });

  await client.createCollection(
    { tenantId, projectId, environmentId },
    {
      collection_key: "assets",
      display_name: "Assets",
      malware_scan_required: true,
      storage_class: "express",
    },
    { operationId },
  );

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].input,
    `https://almira.test/v1/projects/${projectId}/environments/${environmentId}/collections`,
  );
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.credentials, "omit");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.headers.get("authorization"), "Bearer mm_sak_v1.test");
  assert.equal(calls[0].init.headers.get("x-almira-tenant-id"), tenantId);
  assert.equal(calls[0].init.headers.get("idempotency-key"), operationId);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    collection_key: "assets",
    display_name: "Assets",
    malware_scan_required: true,
    storage_class: "express",
  });
});

test("environment mutations use the canonical methods, paths, and concurrency headers", async () => {
  const calls = [];
  const client = new AlmiraClient({
    credential: "mm_pat_v1.test",
    fetch: async (input, init) => {
      calls.push({ input, init });
      return json({ disposition: "applied", environment: {} }, { status: init.method === "POST" ? 201 : 200 });
    },
  });

  await client.createEnvironment(
    { tenantId, projectId },
    { environment_key: "preview-one", display_name: "Preview one" },
    { operationId },
  );
  await client.updateEnvironment(
    { tenantId, projectId, environmentId },
    { display_name: "Preview renamed", expected_revision: 2 },
    { operationId },
  );
  await client.deleteEnvironment(
    { tenantId, projectId, environmentId },
    3,
    { operationId },
  );

  assert.deepEqual(calls.map(({ input, init }) => ({
    input,
    method: init.method,
    revision: init.headers.get("if-match"),
    body: init.body === undefined ? undefined : JSON.parse(init.body),
  })), [
    {
      input: `/v1/projects/${projectId}/environments`,
      method: "POST",
      revision: null,
      body: { environment_key: "preview-one", display_name: "Preview one" },
    },
    {
      input: `/v1/projects/${projectId}/environments/${environmentId}`,
      method: "PATCH",
      revision: null,
      body: { display_name: "Preview renamed", expected_revision: 2 },
    },
    {
      input: `/v1/projects/${projectId}/environments/${environmentId}`,
      method: "DELETE",
      revision: "3",
      body: undefined,
    },
  ]);
  assert.ok(calls.every(({ init }) => init.headers.get("idempotency-key") === operationId));
});

test("storage capability discovery is one exact environment-scoped read", async () => {
  let call;
  const catalog = {
    environment_id: environmentId,
    deployment_profile: "hosted",
    catalog_revision: 1,
    catalog_digest: `sha256:${"a".repeat(64)}`,
    expires_at: "2099-10-17T00:00:00Z",
    provider_matrix: {
      hosted: ["aws_s3", "google_cloud_storage", "azure_blob"],
      connected_site: ["aws_s3", "google_cloud_storage", "azure_blob"],
    },
    realizations: [],
  };
  const client = new AlmiraClient({
    credential: "mm_pat_v1.test",
    fetch: async (input, init) => {
      call = { input, init };
      return json(catalog);
    },
  });

  assert.deepEqual(
    await client.getStorageCapabilities({ tenantId, projectId, environmentId }),
    catalog,
  );
  assert.equal(
    call.input,
    `/v1/projects/${projectId}/environments/${environmentId}/storage-capabilities`,
  );
  assert.equal(call.init.method, "GET");
  assert.equal(call.init.headers.get("idempotency-key"), null);
  assert.equal(call.init.headers.get("x-almira-tenant-id"), tenantId);
});

test("storage migration start and status use the collection-scoped contract", async () => {
  const calls = [];
  const migration = {
    migration_id: operationId,
    environment_id: environmentId,
    collection_instance_id: collectionInstanceId,
    phase: "inventory",
  };
  const client = new AlmiraClient({
    credential: "mm_pat_v1.test",
    fetch: async (input, init) => {
      calls.push({ input, init });
      return json(init.method === "POST" ? { disposition: "applied", migration } : migration, {
        status: init.method === "POST" ? 201 : 200,
      });
    },
  });
  const reference = { tenantId, projectId, environmentId, collectionInstanceId };
  await client.startStorageMigration(
    reference,
    { target_storage_class: "express", expected_collection_revision: 3 },
    { operationId },
  );
  await client.getStorageMigration({ ...reference, migrationId: operationId });
  const base = `/v1/projects/${projectId}/environments/${environmentId}/collections/${collectionInstanceId}/storage-migrations`;
  assert.deepEqual(calls.map(({ input, init }) => ({
    input,
    method: init.method,
    operation: init.headers.get("idempotency-key"),
    body: init.body === undefined ? undefined : JSON.parse(init.body),
  })), [
    {
      input: base,
      method: "POST",
      operation: operationId,
      body: { target_storage_class: "express", expected_collection_revision: 3 },
    },
    {
      input: `${base}/${operationId}`,
      method: "GET",
      operation: null,
      body: undefined,
    },
  ]);
});

test("workload evidence uses its distinct framing and is resolved for every call", async () => {
  const evidence = ["eyJzY2hlbWFfdmVyc2lvbiI6MX0", "eyJzY2hlbWFfdmVyc2lvbiI6Mn0"];
  let calls = 0;
  const client = new AlmiraClient({
    baseUrl: "https://almira.test",
    workloadSession: () => evidence[calls],
    fetch: async (input, init) => {
      assert.equal(input, `https://almira.test/v1/projects/${projectId}/environments`);
      assert.equal(init.credentials, "omit");
      assert.equal(init.headers.get("authorization"), `MetamorphWorkload ${evidence[calls]}`);
      assert.equal(init.headers.get("x-almira-tenant-id"), tenantId);
      calls += 1;
      return json({ environments: [] });
    },
  });

  await client.listEnvironments({ tenantId, projectId });
  await client.listEnvironments({ tenantId, projectId });
  assert.equal(calls, 2);
});

test("authentication modes and PAT or SAK framing fail closed", async () => {
  assert.throws(
    () => new AlmiraClient({ credential: "mm_pat_v1.test", workloadSession: "e30" }),
    (error) => error instanceof AlmiraClientError && error.code === "ALMIRA_CLIENT_INPUT_INVALID",
  );
  assert.throws(
    () => new AlmiraClient({ credential: "mm_pat_v1.test", productSelection: "selection_reference_1234567890" }),
    (error) => error instanceof AlmiraClientError && error.code === "ALMIRA_CLIENT_INPUT_INVALID",
  );
  for (const credential of ["Bearer secret", "pat_secret", "mm_pat_v2.secret", "mm_sak_v1."]) {
    const client = new AlmiraClient({
      credential,
      fetch: async () => assert.fail("must reject malformed evidence before fetch"),
    });
    await assert.rejects(
      client.listEnvironments({ tenantId, projectId }),
      (error) => error instanceof AlmiraClientError && error.code === "ALMIRA_CLIENT_INPUT_INVALID",
    );
  }
});

test("browser reads are one Almira call and include same-origin credentials", async () => {
  let count = 0;
  const client = new AlmiraClient({
    productSelection: "selection_reference_1234567890",
    fetch: async (input, init) => {
      count += 1;
      assert.equal(
        input,
        `/v1/projects/${projectId}/environments/${environmentId}/collections/${collectionInstanceId}/files/${entryId}/content?generation_id=${operationId}`,
      );
      assert.equal(init.credentials, "include");
      assert.equal(init.headers.get("authorization"), null);
      assert.equal(init.headers.get("x-metamorph-product-selection"), "selection_reference_1234567890");
      assert.equal(init.headers.get("x-almira-tenant-id"), tenantId);
      assert.equal(init.headers.get("range"), "bytes=10-19");
      return new Response(new Uint8Array([1, 2]), {
        status: 206,
        headers: {
          "content-length": "2",
          "content-range": "bytes 10-11/20",
          "content-type": "application/octet-stream",
          etag: "opaque",
        },
      });
    },
  });

  const response = await client.readPrivateFile({
    tenantId,
    projectId,
    environmentId,
    collectionInstanceId,
    entryId,
    generationId: operationId,
    range: "bytes=10-19",
  });
  assert.equal(count, 1);
  assert.equal(response.status, 206);
  assert.equal(response.contentLength, 2);
  assert.deepEqual(new Uint8Array(await new Response(response.body).arrayBuffer()), new Uint8Array([1, 2]));
});

test("list query encoding cannot change the request path", async () => {
  const client = new AlmiraClient({
    fetch: async (input) => {
      assert.equal(
        input,
        `/v1/projects/${projectId}/environments/${environmentId}/collections/${collectionInstanceId}/files?limit=25&cursor=a%26admin%3Dtrue&path_prefix=images%2Fcover.png`,
      );
      return json({ entries: [], next_cursor: null });
    },
  });
  await client.listFiles(
    { tenantId, projectId, environmentId, collectionInstanceId },
    { limit: 25, cursor: "a&admin=true", pathPrefix: "images/cover.png" },
  );
});

test("typed API errors expose no response body", async () => {
  const client = new AlmiraClient({
    fetch: async () =>
      json(
        { code: "ALMIRA_AUTHORIZATION_REFUSED", request_id: requestId },
        { status: 403, headers: { "retry-after": "7" } },
      ),
  });

  await assert.rejects(
    client.listEnvironments({ tenantId, projectId }),
    (error) => {
      assert.ok(error instanceof AlmiraApiError);
      assert.equal(error.code, "ALMIRA_AUTHORIZATION_REFUSED");
      assert.equal(error.requestId, requestId);
      assert.equal(error.status, 403);
      assert.equal(error.retryAfterMilliseconds, 7_000);
      assert.equal(error.message, "ALMIRA_AUTHORIZATION_REFUSED");
      return true;
    },
  );
});

test("malformed errors and invalid identifiers fail closed", async () => {
  const malformed = new AlmiraClient({
    fetch: async () => json({ code: "forbidden", detail: "secret" }, { status: 403 }),
  });
  await assert.rejects(
    malformed.listEnvironments({ tenantId, projectId }),
    (error) => error instanceof AlmiraClientError && error.code === "ALMIRA_CLIENT_RESPONSE_INVALID",
  );

  const client = new AlmiraClient({ fetch: async () => assert.fail("must not call fetch") });
  await assert.rejects(
    client.listEnvironments({ tenantId, projectId: "not-a-uuid" }),
    (error) => error instanceof AlmiraClientError && error.code === "ALMIRA_CLIENT_INPUT_INVALID",
  );
});

test("abort and network failure have distinct safe client errors", async () => {
  const controller = new AbortController();
  controller.abort();
  const aborted = new AlmiraClient({
    fetch: async () => {
      throw new DOMException("secret", "AbortError");
    },
  });
  await assert.rejects(
    aborted.listEnvironments({ tenantId, projectId }, { signal: controller.signal }),
    (error) => error instanceof AlmiraClientError && error.code === "ALMIRA_CLIENT_ABORTED",
  );

  const failed = new AlmiraClient({
    fetch: async () => {
      throw new Error("socket contained a secret");
    },
  });
  await assert.rejects(
    failed.listEnvironments({ tenantId, projectId }),
    (error) => error instanceof AlmiraClientError && error.code === "ALMIRA_CLIENT_NETWORK",
  );
});

test("credential-provider failures do not expose provider errors", async () => {
  const client = new AlmiraClient({
    credential: async () => {
      throw new Error("secret from vault");
    },
    fetch: async () => assert.fail("must not call fetch"),
  });
  await assert.rejects(
    client.listEnvironments({ tenantId, projectId }),
    (error) =>
      error instanceof AlmiraClientError &&
      error.code === "ALMIRA_CLIENT_CREDENTIAL_UNAVAILABLE" &&
      error.message === "ALMIRA_CLIENT_CREDENTIAL_UNAVAILABLE",
  );
});
