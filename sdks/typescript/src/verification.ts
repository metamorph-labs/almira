import { AlmiraClientError } from "./errors.js";
import type {
  SignedVerificationReceipt,
  VerificationCheckName,
  VerificationPublicKeySet,
  VerificationReceipt,
} from "./types.js";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CONTENT_SHA256 = /^sha256:[0-9a-f]{64}$/u;
const KEY_ID = /^[a-z][a-z0-9._-]{0,63}$/u;
const BASE64URL_SIGNATURE = /^[A-Za-z0-9_-]{86}$/u;
const BASE64URL_PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/u;
const CHECKS: readonly VerificationCheckName[] = [
  "finalization_idempotency",
  "private_read_integrity",
  "cross_scope_refusal",
  "malware_safety",
];

export interface VerificationReceiptExpectation {
  verificationId?: string;
  tenantId: string;
  projectId: string;
  environmentId: string;
  collectionInstanceId: string;
  entryId: string;
  generationId: string;
  expectedSizeBytes: number;
  contentSha256: string;
}

/** Verifies a receipt against an explicitly trusted key set fetched from Almira's origin. */
export async function verifyVerificationReceipt(
  signed: SignedVerificationReceipt,
  keySet: VerificationPublicKeySet,
  expected?: VerificationReceiptExpectation,
): Promise<boolean> {
  if (!exactKeys(signed, ["algorithm", "receipt", "signature"]) ||
      !validReceipt(signed.receipt) || signed.algorithm !== "ed25519" ||
      !BASE64URL_SIGNATURE.test(signed.signature) ||
      !exactKeys(keySet, ["format_version", "keys"]) || keySet.format_version !== 1 ||
      !Array.isArray(keySet.keys) || keySet.keys.length < 1 || keySet.keys.length > 4 ||
      keySet.keys.some((key) => !exactKeys(key, ["algorithm", "key_id", "public_key"])) ||
      (expected !== undefined && !matchesExpectation(signed.receipt, expected))) {
    return false;
  }
  const keys = keySet.keys.filter((key) => key.key_id === signed.receipt.signing_key_id);
  if (keys.length !== 1 || keys[0]?.algorithm !== "ed25519" ||
      !BASE64URL_PUBLIC_KEY.test(keys[0].public_key)) return false;
  try {
    const publicKey = await globalThis.crypto.subtle.importKey(
      "raw",
      decodeBase64Url(keys[0].public_key),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await globalThis.crypto.subtle.verify(
      { name: "Ed25519" },
      publicKey,
      decodeBase64Url(signed.signature),
      new TextEncoder().encode(JSON.stringify(canonicalJson(signed.receipt))),
    );
  } catch {
    return false;
  }
}

/** Fetches public keys from the same client origin and verifies one signed receipt. */
export async function verifyReceiptWithClient(
  client: { getVerificationPublicKeys(options?: { signal?: AbortSignal }): Promise<VerificationPublicKeySet> },
  signed: SignedVerificationReceipt,
  options: { signal?: AbortSignal; expected?: VerificationReceiptExpectation } = {},
): Promise<boolean> {
  return verifyVerificationReceipt(
    signed,
    await client.getVerificationPublicKeys(options),
    options.expected,
  );
}

function matchesExpectation(
  receipt: VerificationReceipt,
  expected: VerificationReceiptExpectation,
): boolean {
  return (expected.verificationId === undefined || receipt.verification_id === expected.verificationId) &&
    receipt.tenant_id === expected.tenantId &&
    receipt.project_id === expected.projectId &&
    receipt.environment_id === expected.environmentId &&
    receipt.collection_instance_id === expected.collectionInstanceId &&
    receipt.entry_id === expected.entryId &&
    receipt.generation_id === expected.generationId &&
    receipt.expected_size_bytes === expected.expectedSizeBytes &&
    receipt.content_sha256 === expected.contentSha256;
}

function validReceipt(receipt: VerificationReceipt): boolean {
  if (typeof receipt !== "object" || receipt === null ||
      !exactKeys(receipt, [
        "checks", "collection_instance_id", "content_sha256", "contract_version", "entry_id",
        "environment_id", "expected_size_bytes", "generation_id", "project_id", "realm_id",
        "receipt_version", "safety_state", "signing_key_id", "tenant_id", "verification_id",
      ]) ||
      receipt.receipt_version !== "almira.verification.v1" ||
      receipt.contract_version !== "0.1.0-dev.34" ||
      !KEY_ID.test(receipt.signing_key_id) ||
      !CONTENT_SHA256.test(receipt.content_sha256) ||
      !Number.isSafeInteger(receipt.expected_size_bytes) ||
      receipt.expected_size_bytes < 1 || receipt.expected_size_bytes > 8 * 1024 * 1024 ||
      !["not_required", "clean"].includes(receipt.safety_state)) return false;
  for (const value of [
    receipt.verification_id,
    receipt.realm_id,
    receipt.tenant_id,
    receipt.project_id,
    receipt.environment_id,
    receipt.collection_instance_id,
    receipt.entry_id,
    receipt.generation_id,
  ]) if (!UUID_V7.test(value)) return false;
  return Array.isArray(receipt.checks) && receipt.checks.length === CHECKS.length &&
    CHECKS.every((name, index) =>
      exactKeys(receipt.checks[index], ["name", "result"]) &&
      receipt.checks[index]?.name === name && receipt.checks[index]?.result === "passed");
}

function exactKeys(value: unknown, expected: readonly string[]): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => [key, canonicalJson(child)]),
  );
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/") +
      "=".repeat((4 - value.length % 4) % 4);
    const binary = globalThis.atob(base64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (encodeBase64Url(bytes) !== value) throw new Error("non-canonical base64url");
    return bytes;
  } catch {
    throw new AlmiraClientError("ALMIRA_CLIENT_RESPONSE_INVALID");
  }
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
