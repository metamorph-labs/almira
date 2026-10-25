import assert from "node:assert/strict";
import test from "node:test";

import { verifyVerificationReceipt } from "../dist/index.js";

const id = (suffix) => `018f0000-0000-7000-8000-${suffix.toString().padStart(12, "0")}`;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, canonical(child)]));
}

function base64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

test("signed verification receipts validate offline and fail closed on substitution", async () => {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const receipt = {
    receipt_version: "almira.verification.v1",
    contract_version: "0.1.0-dev.59",
    verification_id: id(1),
    realm_id: id(2),
    tenant_id: id(3),
    project_id: id(4),
    environment_id: id(5),
    collection_instance_id: id(6),
    entry_id: id(7),
    generation_id: id(8),
    expected_size_bytes: 4,
    content_sha256: `sha256:${"a".repeat(64)}`,
    safety_state: "clean",
    checks: [
      { name: "finalization_idempotency", result: "passed" },
      { name: "private_read_integrity", result: "passed" },
      { name: "cross_scope_refusal", result: "passed" },
      { name: "malware_safety", result: "passed" },
    ],
    signing_key_id: "key-1",
  };
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    pair.privateKey,
    new TextEncoder().encode(JSON.stringify(canonical(receipt))),
  );
  const signed = { receipt, algorithm: "ed25519", signature: base64url(signature) };
  const keys = {
    format_version: 1,
    keys: [{ key_id: "key-1", algorithm: "ed25519", public_key: base64url(publicKey) }],
  };
  const expected = {
    verificationId: receipt.verification_id,
    tenantId: receipt.tenant_id,
    projectId: receipt.project_id,
    environmentId: receipt.environment_id,
    collectionInstanceId: receipt.collection_instance_id,
    entryId: receipt.entry_id,
    generationId: receipt.generation_id,
    expectedSizeBytes: receipt.expected_size_bytes,
    contentSha256: receipt.content_sha256,
  };
  assert.equal(await verifyVerificationReceipt(signed, keys, expected), true);
  assert.equal(await verifyVerificationReceipt(signed, keys, {
    ...expected,
    generationId: id(9),
  }), false);
  assert.equal(await verifyVerificationReceipt({
    ...signed,
    receipt: { ...receipt, generation_id: id(9) },
  }, keys), false);
  assert.equal(await verifyVerificationReceipt({
    ...signed,
    receipt: { ...receipt, checks: receipt.checks.slice(0, 3) },
  }, keys), false);
  assert.equal(await verifyVerificationReceipt({ ...signed, extra: true }, keys), false);
  assert.equal(await verifyVerificationReceipt(signed, { ...keys, extra: true }), false);
});
