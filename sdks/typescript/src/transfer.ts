import { AlmiraTransferError } from "./errors.js";
import type {
  DirectUploadDescriptor,
  DirectUploadPart,
  DirectUploadPartCompletion,
  FinalizeUploadRequest,
} from "./types.js";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CONTENT_SHA256 = /^sha256:[0-9a-f]{64}$/u;
const PROVIDER_RECEIPT = /^[!-~]{1,256}$/u;
const PROVIDER_VERSION = /^(?!.*[/?#])(?!.*\\)[!-~]{1,256}$/u;
const HEADER_NAME = /^[a-z0-9-]{1,128}$/u;
const PROVIDER_VERSION_HEADERS = ["x-amz-version-id", "x-goog-generation", "x-ms-version-id"];

export type DirectUploadBody = Blob | ArrayBuffer | ArrayBufferView;

export interface DirectUploadOptions {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  signal?: AbortSignal;
}

/**
 * Executes each one-use provider request and returns the exact evidence accepted by finalizeUpload.
 * URLs, signed headers and provider response bodies are never included in errors or results.
 */
export async function uploadDirect(
  descriptor: DirectUploadDescriptor,
  body: DirectUploadBody,
  options: DirectUploadOptions = {},
): Promise<FinalizeUploadRequest> {
  const size = bodySize(body);
  validateDescriptor(descriptor, size);
  const now = options.now ?? Date.now;
  requireUnexpired(descriptor, now());
  const fetch_ = options.fetch ?? globalThis.fetch;
  if (typeof fetch_ !== "function") invalidDescriptor();

  const parts: DirectUploadPartCompletion[] = [];
  let objectEtag: string | null = null;
  let providerVersion: string | null = null;
  for (const request of descriptor.requests) {
    requireUnexpired(descriptor, now());
    const response = await putPart(fetch_, request, sliceBody(body, request), options.signal);
    const etag = response.headers.get("etag");
    if (etag === null || !PROVIDER_RECEIPT.test(etag)) {
      await discard(response);
      throw new AlmiraTransferError("ALMIRA_TRANSFER_RESPONSE_INVALID", request.part_number);
    }
    let responseProviderVersion: string | null = null;
    try {
      if (descriptor.protocol === "single_put") {
        responseProviderVersion = exactProviderVersion(response, request.part_number);
      }
    } finally {
      await discard(response);
    }
    if (descriptor.protocol === "single_put") {
      objectEtag = etag;
      providerVersion = responseProviderVersion;
    }
    parts.push({ part_number: request.part_number, etag });
  }

  return {
    descriptor_id: descriptor.descriptor_id,
    protocol: descriptor.protocol,
    etag: objectEtag,
    provider_version: descriptor.protocol === "single_put" ? providerVersion : null,
    parts,
    size_bytes: size,
    content_sha256: descriptor.content_sha256,
  };
}

async function putPart(
  fetch_: typeof globalThis.fetch,
  request: DirectUploadPart,
  body: Blob | Uint8Array<ArrayBuffer>,
  signal: AbortSignal | undefined,
): Promise<Response> {
  try {
    const response = await fetch_(request.url, {
      method: "PUT",
      headers: new Headers(
        request.headers.map(({ name, value }): [string, string] => [name, value]),
      ),
      body,
      credentials: "omit",
      redirect: "error",
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) {
      await discard(response);
      throw new AlmiraTransferError(
        "ALMIRA_TRANSFER_PART_REFUSED",
        request.part_number,
        response.status,
      );
    }
    return response;
  } catch (error) {
    if (error instanceof AlmiraTransferError) throw error;
    throw new AlmiraTransferError("ALMIRA_TRANSFER_OUTCOME_UNKNOWN", request.part_number);
  }
}

function validateDescriptor(descriptor: DirectUploadDescriptor, size: number): void {
  if (
    descriptor === null ||
    typeof descriptor !== "object" ||
    !Array.isArray(descriptor.requests) ||
    (descriptor.protocol !== "single_put" && descriptor.protocol !== "multipart") ||
    typeof descriptor.descriptor_id !== "string" ||
    !UUID_V7.test(descriptor.descriptor_id) ||
    typeof descriptor.content_sha256 !== "string" ||
    !CONTENT_SHA256.test(descriptor.content_sha256) ||
    descriptor.one_use !== true ||
    descriptor.expected_size_bytes !== size ||
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > 10_737_418_240 ||
    typeof descriptor.expires_at !== "string" ||
    !Number.isFinite(Date.parse(descriptor.expires_at)) ||
    (descriptor.protocol === "single_put" && descriptor.requests.length !== 1) ||
    (descriptor.protocol === "multipart" &&
      (descriptor.requests.length < 2 || descriptor.requests.length > 256))
  ) {
    invalidDescriptor();
  }
  let offset = 0;
  for (const [index, request] of descriptor.requests.entries()) {
    if (
      request === null ||
      typeof request !== "object" ||
      !Array.isArray(request.headers) ||
      request.part_number !== index + 1 ||
      request.offset_bytes !== offset ||
      !Number.isSafeInteger(request.offset_bytes) ||
      !Number.isSafeInteger(request.length_bytes) ||
      request.length_bytes < 1 ||
      request.method !== "PUT" ||
      request.one_use !== true ||
      !validTransferUrl(request.url) ||
      !validHeaders(request)
    ) {
      invalidDescriptor();
    }
    offset += request.length_bytes;
  }
  if (offset !== size) invalidDescriptor();
}

function validTransferUrl(value: string): boolean {
  if (value.length > 8192 || /[\\\u0000-\u0020\u007f]/u.test(value)) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.hash === "" &&
      url.hostname.length > 0
    );
  } catch {
    return false;
  }
}

function validHeaders(request: DirectUploadPart): boolean {
  if (!Array.isArray(request.headers) || request.headers.length > 32) return false;
  const names = new Set<string>();
  return request.headers.every(({ name, value }) => {
    if (
      !HEADER_NAME.test(name) ||
      value.length < 1 ||
      value.length > 4096 ||
      /[\u0000-\u001f\u007f]/u.test(value) ||
      names.has(name)
    ) {
      return false;
    }
    names.add(name);
    return true;
  });
}

function requireUnexpired(descriptor: DirectUploadDescriptor, now: number): void {
  if (!Number.isFinite(now) || Date.parse(descriptor.expires_at) <= now) {
    throw new AlmiraTransferError("ALMIRA_TRANSFER_DESCRIPTOR_EXPIRED");
  }
}

function bodySize(body: DirectUploadBody): number {
  if (body instanceof Blob) return body.size;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  return invalidDescriptor();
}

function sliceBody(
  body: DirectUploadBody,
  request: DirectUploadPart,
): Blob | Uint8Array<ArrayBuffer> {
  const start = request.offset_bytes;
  const end = start + request.length_bytes;
  if (body instanceof Blob) return body.slice(start, end);
  if (body instanceof ArrayBuffer) return new Uint8Array(body, start, request.length_bytes);
  if (ArrayBuffer.isView(body)) {
    if (!(body.buffer instanceof ArrayBuffer)) invalidDescriptor();
    return new Uint8Array(body.buffer, body.byteOffset + start, request.length_bytes);
  }
  return invalidDescriptor();
}

function exactProviderVersion(response: Response, partNumber: number): string | null {
  const values = PROVIDER_VERSION_HEADERS.flatMap((name) => {
    const value = response.headers.get(name);
    return value === null ? [] : [value];
  });
  if (values.some((value) => !PROVIDER_VERSION.test(value)) || new Set(values).size > 1) {
    throw new AlmiraTransferError("ALMIRA_TRANSFER_RESPONSE_INVALID", partNumber);
  }
  return values[0] ?? null;
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The transfer receipt is already in headers; body cancellation is best-effort cleanup.
  }
}

function invalidDescriptor(): never {
  throw new AlmiraTransferError("ALMIRA_TRANSFER_DESCRIPTOR_INVALID");
}
