import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  AlmiraApiError,
  AlmiraClient,
  AlmiraClientError,
} from "../dist/index.js";

const projectId = "018f0000-0000-7000-8000-000000000003";
const environmentId = "018f0000-0000-7000-8000-000000000004";
const collectionInstanceId = "018f0000-0000-7000-8000-000000000005";
const entryId = "018f0000-0000-7000-8000-000000000006";
const operationId = "018f0000-0000-7000-8000-000000000007";
const requestId = "018f0000-0000-7000-8000-000000000008";

test("SDK version and methods cover the promoted contract exactly", async () => {
  const contract = JSON.parse(await readFile(new URL("../../../contracts/openapi.v1.json", import.meta.url)));
  const packageManifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url)));
  const operations = Object.values(contract.paths)
    .flatMap((path) => Object.values(path))
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
    baseUrl: "https://almira.test/platform/almira/",
    credential: async () => "sak_secret",
    fetch: async (input, init) => {
      calls.push({ input, init });
      return json({
        disposition: "applied",
        collection: { collection_instance_id: collectionInstanceId },
      }, { status: 201 });
    },
  });

  await client.createCollection(
    { projectId, environmentId },
    { collection_key: "assets", display_name: "Assets", malware_scan_required: true },
    { operationId },
  );

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].input,
    `https://almira.test/platform/almira/v1/projects/${projectId}/environments/${environmentId}/collections`,
  );
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.credentials, "omit");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.headers.get("authorization"), "Bearer sak_secret");
  assert.equal(calls[0].init.headers.get("idempotency-key"), operationId);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    collection_key: "assets",
    display_name: "Assets",
    malware_scan_required: true,
  });
});

test("browser reads are one Almira call and include same-origin credentials", async () => {
  let count = 0;
  const client = new AlmiraClient({
    fetch: async (input, init) => {
      count += 1;
      assert.equal(
        input,
        `/platform/almira/v1/projects/${projectId}/environments/${environmentId}/collections/${collectionInstanceId}/files/${entryId}/content?generation_id=${operationId}`,
      );
      assert.equal(init.credentials, "include");
      assert.equal(init.headers.get("authorization"), null);
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
        `/platform/almira/v1/projects/${projectId}/environments/${environmentId}/collections/${collectionInstanceId}/files?limit=25&cursor=a%26admin%3Dtrue&path_prefix=images%2Fcover.png`,
      );
      return json({ entries: [], next_cursor: null });
    },
  });
  await client.listFiles(
    { projectId, environmentId, collectionInstanceId },
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
    client.listEnvironments({ projectId }),
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
    malformed.listEnvironments({ projectId }),
    (error) => error instanceof AlmiraClientError && error.code === "ALMIRA_CLIENT_RESPONSE_INVALID",
  );

  const client = new AlmiraClient({ fetch: async () => assert.fail("must not call fetch") });
  await assert.rejects(
    client.listEnvironments({ projectId: "not-a-uuid" }),
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
    aborted.listEnvironments({ projectId }, { signal: controller.signal }),
    (error) => error instanceof AlmiraClientError && error.code === "ALMIRA_CLIENT_ABORTED",
  );

  const failed = new AlmiraClient({
    fetch: async () => {
      throw new Error("socket contained a secret");
    },
  });
  await assert.rejects(
    failed.listEnvironments({ projectId }),
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
    client.listEnvironments({ projectId }),
    (error) =>
      error instanceof AlmiraClientError &&
      error.code === "ALMIRA_CLIENT_CREDENTIAL_UNAVAILABLE" &&
      error.message === "ALMIRA_CLIENT_CREDENTIAL_UNAVAILABLE",
  );
});
