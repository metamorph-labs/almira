import assert from "node:assert/strict";
import test from "node:test";

import { AlmiraClient } from "@metamorph-labs/almira-sdk";

import { uploadFile } from "../dist/upload.js";

const projectId = "018f0000-0000-7000-8000-000000000003";
const tenantId = "018f0000-0000-7000-8000-000000000002";
const environmentId = "018f0000-0000-7000-8000-000000000004";
const collectionInstanceId = "018f0000-0000-7000-8000-000000000005";
const transferSessionId = "018f0000-0000-7000-8000-000000000006";
const entryId = "018f0000-0000-7000-8000-000000000007";
const generationId = "018f0000-0000-7000-8000-000000000008";
const descriptorId = "018f0000-0000-7000-8000-000000000009";

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("example performs create, direct PUT and finalize without credential crossover", async () => {
  const controlCalls = [];
  const client = new AlmiraClient({
    baseUrl: "https://almira.test",
    credential: "mm_sak_v1.test",
    fetch: async (input, init) => {
      controlCalls.push({ input, init });
      if (controlCalls.length === 1) {
        return json(
          {
            transfer_session_id: transferSessionId,
            entry_id: entryId,
            generation_id: generationId,
            descriptor: {
              descriptor_id: descriptorId,
              protocol: "single_put",
              requests: [{
                part_number: 1,
                offset_bytes: 0,
                length_bytes: 4,
                method: "PUT",
                url: "https://opaque.example/upload?secret=signed",
                headers: [{ name: "x-upload", value: "one-use-secret" }],
                one_use: true,
              }],
              expected_size_bytes: 4,
              content_sha256: `sha256:${"9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a"}`,
              one_use: true,
              expires_at: "2030-01-01T00:00:00.000000Z",
            },
          },
          201,
        );
      }
      const body = JSON.parse(init.body);
      assert.equal(body.etag, "opaque-etag");
      assert.equal(body.provider_version, null);
      return json({ entry_id: entryId, generation_id: generationId });
    },
  });
  let directAuthorization;
  const generation = await uploadFile({
    client,
    tenantId,
    projectId,
    environmentId,
    collectionInstanceId,
    bytes: new Uint8Array([1, 2, 3, 4]),
    path: "sample.bin",
    mediaType: "application/octet-stream",
    directFetch: async (_input, init) => {
      directAuthorization = init.headers.get("authorization");
      assert.equal(init.headers.get("x-upload"), "one-use-secret");
      return new Response(null, { status: 200, headers: { etag: "opaque-etag" } });
    },
  });
  assert.equal(controlCalls.length, 2);
  assert.equal(controlCalls[0].init.headers.get("authorization"), "Bearer mm_sak_v1.test");
  assert.equal(controlCalls[1].init.headers.get("authorization"), "Bearer mm_sak_v1.test");
  assert.equal(controlCalls[0].init.headers.get("x-almira-tenant-id"), tenantId);
  assert.equal(directAuthorization, null);
  assert.equal(generation.entry_id, entryId);
  assert.equal(generation.generation_id, generationId);
});
