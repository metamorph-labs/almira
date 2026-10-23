import assert from "node:assert/strict";
import test from "node:test";

import { AlmiraTransferError, openPortableExport, uploadDirect } from "../dist/index.js";

const descriptorId = "018f0000-0000-7000-8000-000000000001";
const digest = `sha256:${"a".repeat(64)}`;

function descriptor(protocol, requests, size = 4, partSize = null, partCount = 1) {
  return {
    descriptor_id: descriptorId,
    protocol,
    requests,
    expected_size_bytes: size,
    content_sha256: digest,
    one_use: true,
    expires_at: "2030-01-01T00:00:00.000000Z",
    part_size_bytes: partSize,
    part_count: partCount,
  };
}

function part(number, offset, length) {
  return {
    part_number: number,
    offset_bytes: offset,
    length_bytes: length,
    method: "PUT",
    url: `https://opaque.example/upload/${number}?signature=secret`,
    headers: [{ name: "x-upload-token", value: `secret-${number}` }],
    one_use: true,
  };
}

test("single PUT omits Almira credentials and returns finalization evidence", async () => {
  let call;
  const completion = await uploadDirect(
    descriptor("single_put", [part(1, 0, 4)]),
    new Uint8Array([1, 2, 3, 4]),
    {
      now: () => 1_800_000_000_000,
      fetch: async (input, init) => {
        call = { input, init };
        return new Response(null, {
          status: 200,
          headers: { etag: '"opaque/etag=="', "x-amz-version-id": "opaque-version" },
        });
      },
    },
  );
  assert.equal(call.init.credentials, "omit");
  assert.equal(call.init.redirect, "error");
  assert.equal(call.init.headers.get("authorization"), null);
  assert.equal(call.init.headers.get("x-upload-token"), "secret-1");
  assert.deepEqual([...call.init.body], [1, 2, 3, 4]);
  assert.deepEqual(completion, {
    descriptor_id: descriptorId,
    protocol: "single_put",
    etag: '"opaque/etag=="',
    provider_version: "opaque-version",
    parts: [{ part_number: 1, etag: '"opaque/etag=="' }],
    size_bytes: 4,
    content_sha256: digest,
  });
});

test("multipart uploads exact slices and does not invent aggregate evidence", async () => {
  const bodies = [];
  const grants = [];
  const completion = await uploadDirect(
    descriptor("multipart", [], 4, 2, 2),
    new Uint8Array([1, 2, 3, 4]),
    {
      now: () => 1_800_000_000_000,
      createPart: async (request) => {
        grants.push(request);
        return part(request.part_number, (request.part_number - 1) * 2, 2);
      },
      fetch: async (_input, init) => {
        bodies.push([...init.body]);
        return new Response(null, {
          status: 200,
          headers: { etag: `part-${bodies.length}`, "x-amz-version-id": "not-an-object-version-yet" },
        });
      },
    },
  );
  assert.deepEqual(grants, [
    { part_number: 1, content_sha256: "sha256:a12871fee210fb8619291eaea194581cbd2531e4b23759d225f6806923f63222" },
    { part_number: 2, content_sha256: "sha256:0ce3940bebf2b22a5d2108ecf0c368a0541c7e3c45703f8540921b4eafc82947" },
  ]);
  assert.deepEqual(bodies, [[1, 2], [3, 4]]);
  assert.equal(completion.etag, null);
  assert.equal(completion.provider_version, null);
  assert.deepEqual(completion.parts, [
    { part_number: 1, etag: "part-1" },
    { part_number: 2, etag: "part-2" },
  ]);
});

test("expired and structurally invalid descriptors fail before transfer", async () => {
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    return new Response();
  };
  await assert.rejects(
    uploadDirect(descriptor("single_put", [part(1, 0, 4)]), new Uint8Array(4), {
      now: () => Date.parse("2031-01-01T00:00:00Z"),
      fetch,
    }),
    (error) =>
      error instanceof AlmiraTransferError &&
      error.code === "ALMIRA_TRANSFER_DESCRIPTOR_EXPIRED",
  );
  await assert.rejects(
    uploadDirect(descriptor("single_put", [part(1, 0, 4)]), new Uint8Array(3), { fetch }),
    (error) =>
      error instanceof AlmiraTransferError &&
      error.code === "ALMIRA_TRANSFER_DESCRIPTOR_INVALID",
  );
  assert.equal(calls, 0);
});

test("ambiguous provider failures expose no URL or signed header", async () => {
  await assert.rejects(
    uploadDirect(descriptor("single_put", [part(1, 0, 4)]), new Uint8Array(4), {
      now: () => 1_800_000_000_000,
      fetch: async () => {
        throw new Error("https://opaque.example secret-1");
      },
    }),
    (error) =>
      error instanceof AlmiraTransferError &&
      error.code === "ALMIRA_TRANSFER_OUTCOME_UNKNOWN" &&
      error.partNumber === 1 &&
      !/opaque|secret/u.test(error.message),
  );
});

test("portable export opens a credential-free verified-size stream", async () => {
  let call;
  const result = await openPortableExport({
    descriptor_id: descriptorId,
    method: "GET",
    url: "https://opaque.example/export?signature=secret",
    headers: [{ name: "X-Export-Token", value: "secret" }],
    expected_size_bytes: 4,
    content_sha256: digest,
    one_use: true,
    expires_at: "2030-01-01T00:00:00Z",
  }, {
    now: () => 1_800_000_000_000,
    fetch: async (input, init) => {
      call = { input, init };
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        headers: { "content-length": "4" },
      });
    },
  });
  assert.equal(call.init.credentials, "omit");
  assert.equal(call.init.redirect, "error");
  assert.equal(call.init.headers.get("authorization"), null);
  assert.equal(call.init.headers.get("x-export-token"), "secret");
  assert.equal(result.sizeBytes, 4);
  assert.equal(result.contentSha256, digest);
  assert.deepEqual(
    new Uint8Array(await new Response(result.body).arrayBuffer()),
    new Uint8Array([1, 2, 3, 4]),
  );
});

test("portable export refuses replayable and length-mismatched descriptors safely", async () => {
  const base = {
    descriptor_id: descriptorId,
    method: "GET",
    url: "https://opaque.example/export?signature=secret",
    headers: [],
    expected_size_bytes: 4,
    content_sha256: digest,
    one_use: true,
    expires_at: "2030-01-01T00:00:00Z",
  };
  await assert.rejects(
    openPortableExport({ ...base, one_use: false }),
    (error) => error instanceof AlmiraTransferError && error.code === "ALMIRA_TRANSFER_DESCRIPTOR_INVALID",
  );
  await assert.rejects(
    openPortableExport(base, {
      now: () => 1_800_000_000_000,
      fetch: async () => new Response(new Uint8Array([1, 2]), { headers: { "content-length": "2" } }),
    }),
    (error) => error instanceof AlmiraTransferError && error.code === "ALMIRA_TRANSFER_RESPONSE_INVALID",
  );
});
