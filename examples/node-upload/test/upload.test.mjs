import assert from "node:assert/strict";
import test from "node:test";

import { AlmiraClient } from "@metamorph-labs/almira-sdk";

import { uploadAndVerifyFile, uploadFile } from "../dist/upload.js";
import { createNextUploadRoute } from "../dist/next-route-handler.js";

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

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, canonical(child)]));
}

test("example obtains and verifies the canonical positive, retry, refusal, and safety receipt", async () => {
  const refusalEnvironmentId = "018f0000-0000-7000-8000-000000000010";
  const verificationId = "018f0000-0000-7000-8000-000000000011";
  const realmId = "018f0000-0000-7000-8000-000000000012";
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicKey = Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey)).toString("base64url");
  const calls = [];
  const client = new AlmiraClient({
    baseUrl: "https://almira.test",
    credential: "mm_sak_v1.test",
    fetch: async (input, init) => {
      calls.push({ input, init });
      if (input.endsWith("/.well-known/almira-verification-keys.json")) {
        return json({
          format_version: 1,
          keys: [{ key_id: "key-1", algorithm: "ed25519", public_key: publicKey }],
        });
      }
      if (input.endsWith("/uploads")) {
        return json({
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
              headers: [],
              one_use: true,
            }],
            expected_size_bytes: 4,
            content_sha256: "sha256:9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",
            one_use: true,
            expires_at: "2030-01-01T00:00:00Z",
          },
        }, 201);
      }
      if (input.endsWith("/finalize")) {
        return json({ entry_id: entryId, generation_id: generationId, safety_state: "clean" });
      }
      const receipt = {
        receipt_version: "almira.verification.v1",
        contract_version: "0.1.0-dev.34",
        verification_id: verificationId,
        realm_id: realmId,
        tenant_id: tenantId,
        project_id: projectId,
        environment_id: environmentId,
        collection_instance_id: collectionInstanceId,
        entry_id: entryId,
        generation_id: generationId,
        expected_size_bytes: 4,
        content_sha256: "sha256:9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",
        safety_state: "clean",
        checks: [
          { name: "finalization_idempotency", result: "passed" },
          { name: "private_read_integrity", result: "passed" },
          { name: "cross_scope_refusal", result: "passed" },
          { name: "malware_safety", result: "passed" },
        ],
        signing_key_id: "key-1",
      };
      const signature = Buffer.from(await crypto.subtle.sign(
        { name: "Ed25519" },
        pair.privateKey,
        new TextEncoder().encode(JSON.stringify(canonical(receipt))),
      )).toString("base64url");
      return json({ receipt, algorithm: "ed25519", signature });
    },
  });
  const result = await uploadAndVerifyFile({
    client,
    tenantId,
    projectId,
    environmentId,
    collectionInstanceId,
    refusalEnvironmentId,
    bytes: new Uint8Array([1, 2, 3, 4]),
    path: "avatars/user.bin",
    mediaType: "application/octet-stream",
    directFetch: async () => new Response(null, { status: 200, headers: { etag: "opaque-etag" } }),
  });
  assert.equal(result.generation.generation_id, generationId);
  assert.equal(result.receipt.receipt.checks.length, 4);
  assert.equal(calls.length, 4);
  const finalizeOperation = calls[1].init.headers.get("idempotency-key");
  const verificationRequest = JSON.parse(calls[2].init.body);
  assert.equal(verificationRequest.finalize_operation_id, finalizeOperation);
  assert.equal(verificationRequest.refusal_environment_id, refusalEnvironmentId);
  assert.equal(calls[3].init.credentials, "omit");
});

test("Next.js-compatible route delegates app authorization before storage work", async () => {
  let authorized = false;
  const route = createNextUploadRoute({
    client: {},
    tenantId,
    projectId,
    environmentId,
    collectionInstanceId,
    refusalEnvironmentId: "018f0000-0000-7000-8000-000000000010",
    authorize: () => authorized,
    pathFor: (kind, name) => `${kind}/${name}`,
  });
  const refused = await route(new Request("https://app.test/api/files", { method: "POST" }));
  assert.equal(refused.status, 403);
  assert.deepEqual(await refused.json(), { code: "ALMIRA_EXAMPLE_FORBIDDEN" });
  authorized = true;
  const invalid = await route(new Request("https://app.test/api/files", {
    method: "POST",
    body: new FormData(),
  }));
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { code: "ALMIRA_EXAMPLE_INPUT_INVALID" });
});
