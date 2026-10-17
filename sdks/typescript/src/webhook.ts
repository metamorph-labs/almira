const DELIVERY_ID_HEADER = "metamorph-webhook-delivery-id";
const EVENT_ID_HEADER = "metamorph-webhook-event-id";
const ATTEMPT_HEADER = "metamorph-webhook-attempt";
const TIMESTAMP_HEADER = "metamorph-webhook-timestamp";
const SIGNATURE_HEADER = "metamorph-webhook-signature";
const MAX_BODY_BYTES = 272 * 1024;
const DEFAULT_TOLERANCE_SECONDS = 300;

const uuidV7Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const timestampPattern = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$/u;
const signaturePattern = /^v1=([A-Za-z0-9_-]{43})$/u;

export type WebhookHeaders = Headers | Readonly<Record<string, string>>;

export interface WebhookVerificationOptions {
  /** Maximum accepted clock skew in seconds. Defaults to five minutes. */
  toleranceSeconds?: number;
  /** Wall-clock override for deterministic verification and tests. */
  now?: Date;
}

export interface VerifiedWebhook {
  deliveryId: string;
  eventId: string;
  attempt: number;
  timestamp: string;
}

function readHeader(headers: WebhookHeaders, name: string): string | undefined {
  if (headers instanceof Headers) {
    const value = headers.get(name);
    return value === null || value.includes(",") ? undefined : value;
  }
  const matches = Object.entries(headers)
    .filter(([key]) => key.toLowerCase() === name)
    .map(([, value]) => value);
  return matches.length === 1 && !matches[0]?.includes(",") ? matches[0] : undefined;
}

function bytes(value: string | Uint8Array): Uint8Array<ArrayBuffer> {
  return typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
}

function base64url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Verifies an APP-01 signed webhook over the exact raw request body.
 *
 * A successful result authenticates delivery by APP-01 only. The event payload
 * remains untrusted input and never grants file-read or other Almira authority.
 */
export async function verifyWebhookSignature(
  secret: string | Uint8Array,
  body: string | Uint8Array,
  headers: WebhookHeaders,
  options: WebhookVerificationOptions = {},
): Promise<VerifiedWebhook | null> {
  const secretBytes = bytes(secret);
  const bodyBytes = bytes(body);
  if (secretBytes.byteLength === 0 || bodyBytes.byteLength > MAX_BODY_BYTES) return null;

  const deliveryId = readHeader(headers, DELIVERY_ID_HEADER);
  const eventId = readHeader(headers, EVENT_ID_HEADER);
  const attemptValue = readHeader(headers, ATTEMPT_HEADER);
  const timestamp = readHeader(headers, TIMESTAMP_HEADER);
  const signature = readHeader(headers, SIGNATURE_HEADER);
  if (
    deliveryId === undefined || !uuidV7Pattern.test(deliveryId) ||
    eventId === undefined || !uuidV7Pattern.test(eventId) ||
    attemptValue === undefined || !/^[1-8]$/u.test(attemptValue) ||
    timestamp === undefined || !timestampPattern.test(timestamp) ||
    signature === undefined || !signaturePattern.test(signature)
  ) return null;

  const parsedTimestamp = Date.parse(timestamp);
  const canonicalMilliseconds = Number.isFinite(parsedTimestamp)
    ? new Date(parsedTimestamp).toISOString()
    : "";
  const now = options.now?.getTime() ?? Date.now();
  const toleranceSeconds = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (
    !Number.isFinite(parsedTimestamp) ||
    canonicalMilliseconds !== `${timestamp.slice(0, 23)}Z` ||
    !Number.isFinite(now) ||
    !Number.isSafeInteger(toleranceSeconds) || toleranceSeconds < 0 ||
    Math.abs(now - parsedTimestamp) > toleranceSeconds * 1000
  ) return null;

  const bodyDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", bodyBytes));
  const transcript = [
    "metamorph-webhook-v1",
    deliveryId,
    eventId,
    attemptValue,
    timestamp,
    `sha256:${hex(bodyDigest)}`,
  ].join("\n");
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, bytes(transcript))));
  const supplied = signaturePattern.exec(signature)?.[1];
  if (supplied === undefined || expected.length !== supplied.length) return null;

  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ supplied.charCodeAt(index);
  }
  if (difference !== 0) return null;
  return { deliveryId, eventId, attempt: Number(attemptValue), timestamp };
}
