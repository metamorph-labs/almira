import { AlmiraTransferError } from "./errors.js";
import type {
  CreateMultipartPartGrantRequest,
  DirectUploadDescriptor,
  DirectUploadPart,
  DirectUploadPartCompletion,
  FinalizeUploadRequest,
  PortableDownloadDescriptor,
} from "./types.js";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CONTENT_SHA256 = /^sha256:[0-9a-f]{64}$/u;
const PROVIDER_RECEIPT = /^[!-~]{1,256}$/u;
const PROVIDER_VERSION = /^(?!.*[/?#])(?!.*\\)[!-~]{1,256}$/u;
const HEADER_NAME = /^[a-z0-9-]{1,128}$/u;
const PROVIDER_VERSION_HEADERS = ["x-amz-version-id", "x-goog-generation", "x-ms-version-id"];

export type DirectUploadBody = Blob | ArrayBuffer | ArrayBufferView;

export interface DirectUploadOptions {
  createPart?: DirectUploadPartGrant;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  signal?: AbortSignal;
}

export type DirectUploadPartGrant = (
  request: CreateMultipartPartGrantRequest,
  signal?: AbortSignal,
) => Promise<DirectUploadPart>;

export interface PortableExportStream {
  body: ReadableStream<Uint8Array>;
  contentSha256: `sha256:${string}`;
  sizeBytes: number;
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
  for (let partNumber = 1; partNumber <= descriptor.part_count; partNumber += 1) {
    requireUnexpired(descriptor, now());
    const expected = expectedPart(descriptor, partNumber);
    const partBody = sliceBody(body, expected);
    const request = descriptor.protocol === "single_put"
      ? descriptor.requests[0]!
      : await grantMultipartPart(descriptor, expected, partBody, options);
    validateGrantedPart(request, expected);
    const response = await putPart(fetch_, request, partBody, options.signal);
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

/**
 * Opens a one-use portable-export download as a stream without exposing its bearer in errors.
 * Consumers must hash the stream and compare it with `contentSha256` before accepting the file.
 */
export async function openPortableExport(
  descriptor: PortableDownloadDescriptor,
  options: DirectUploadOptions = {},
): Promise<PortableExportStream> {
  validatePortableDescriptor(descriptor);
  const now = options.now ?? Date.now;
  const currentTime = now();
  if (!Number.isFinite(currentTime) || Date.parse(descriptor.expires_at) <= currentTime) {
    throw new AlmiraTransferError("ALMIRA_TRANSFER_DESCRIPTOR_EXPIRED");
  }
  const fetch_ = options.fetch ?? globalThis.fetch;
  if (typeof fetch_ !== "function") invalidDescriptor();
  let response: Response;
  try {
    response = await fetch_(descriptor.url, {
      method: "GET",
      headers: new Headers(
        descriptor.headers.map(({ name, value }): [string, string] => [name, value]),
      ),
      credentials: "omit",
      redirect: "error",
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch {
    throw new AlmiraTransferError("ALMIRA_TRANSFER_OUTCOME_UNKNOWN");
  }
  if (!response.ok) {
    await discard(response);
    throw new AlmiraTransferError("ALMIRA_TRANSFER_PART_REFUSED", null, response.status);
  }
  const contentLength = response.headers.get("content-length");
  if (
    response.body === null ||
    (contentLength !== null && Number(contentLength) !== descriptor.expected_size_bytes)
  ) {
    await discard(response);
    throw new AlmiraTransferError("ALMIRA_TRANSFER_RESPONSE_INVALID");
  }
  return {
    body: response.body,
    contentSha256: descriptor.content_sha256,
    sizeBytes: descriptor.expected_size_bytes,
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
    !Number.isSafeInteger(descriptor.part_count) ||
    descriptor.part_count < 1 ||
    descriptor.part_count > 10_000 ||
    (descriptor.protocol === "single_put" &&
      (descriptor.requests.length !== 1 ||
        descriptor.part_size_bytes !== null ||
        descriptor.part_count !== 1)) ||
    (descriptor.protocol === "multipart" &&
      (descriptor.requests.length !== 0 ||
        !Number.isSafeInteger(descriptor.part_size_bytes) ||
        descriptor.part_size_bytes === null ||
        descriptor.part_size_bytes < 1 ||
        descriptor.part_size_bytes * (descriptor.part_count - 1) >= size ||
        descriptor.part_size_bytes * descriptor.part_count < size))
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
  if (descriptor.protocol === "single_put" && offset !== size) invalidDescriptor();
}

function expectedPart(descriptor: DirectUploadDescriptor, partNumber: number): DirectUploadPart {
  if (descriptor.protocol === "single_put") return descriptor.requests[0]!;
  const partSize = descriptor.part_size_bytes!;
  const offset = (partNumber - 1) * partSize;
  return {
    part_number: partNumber,
    offset_bytes: offset,
    length_bytes: Math.min(partSize, descriptor.expected_size_bytes - offset),
    method: "PUT",
    url: "https://geometry.invalid",
    headers: [],
    one_use: true,
  };
}

async function grantMultipartPart(
  descriptor: DirectUploadDescriptor,
  expected: DirectUploadPart,
  body: Blob | Uint8Array<ArrayBuffer>,
  options: DirectUploadOptions,
): Promise<DirectUploadPart> {
  if (options.createPart === undefined) invalidDescriptor();
  const content_sha256 = await partSha256(body);
  requireUnexpired(descriptor, (options.now ?? Date.now)());
  return options.createPart({ part_number: expected.part_number, content_sha256 }, options.signal);
}

function validateGrantedPart(request: DirectUploadPart, expected: DirectUploadPart): void {
  if (
    request === null ||
    typeof request !== "object" ||
    request.part_number !== expected.part_number ||
    request.offset_bytes !== expected.offset_bytes ||
    request.length_bytes !== expected.length_bytes ||
    request.method !== "PUT" ||
    request.one_use !== true ||
    !validTransferUrl(request.url) ||
    !validHeaders(request)
  ) invalidDescriptor();
}

async function partSha256(body: Blob | Uint8Array<ArrayBuffer>): Promise<`sha256:${string}`> {
  const source = body instanceof Blob ? await body.arrayBuffer() : body;
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) invalidDescriptor();
  const digest = new Uint8Array(await subtle.digest("SHA-256", source));
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function validatePortableDescriptor(descriptor: PortableDownloadDescriptor): void {
  if (
    descriptor === null ||
    typeof descriptor !== "object" ||
    !UUID_V7.test(descriptor.descriptor_id) ||
    descriptor.method !== "GET" ||
    !validTransferUrl(descriptor.url) ||
    !Array.isArray(descriptor.headers) ||
    descriptor.headers.length > 16 ||
    descriptor.headers.some(({ name, value }) =>
      !/^[A-Za-z0-9_-]{1,128}$/u.test(name) ||
      value.length < 1 ||
      value.length > 8192 ||
      /[\u0000-\u001f\u007f]/u.test(value)) ||
    !Number.isSafeInteger(descriptor.expected_size_bytes) ||
    descriptor.expected_size_bytes < 1 ||
    !CONTENT_SHA256.test(descriptor.content_sha256) ||
    descriptor.one_use !== true ||
    !Number.isFinite(Date.parse(descriptor.expires_at))
  ) invalidDescriptor();
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
