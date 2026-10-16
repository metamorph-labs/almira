import { AlmiraApiError, AlmiraClientError } from "./errors.js";
import type {
  BootstrapOutcome,
  BrowserOriginPolicy,
  Collection,
  CollectionPage,
  CollectionReference,
  CreateCollectionOutcome,
  CreateCollectionRequest,
  CreateUploadOutcome,
  CreateUploadRequest,
  DeleteFileOutcome,
  EnvironmentList,
  EnvironmentReference,
  FileEntry,
  FileEntryPage,
  FileReference,
  FinalizeUploadRequest,
  MutationOptions,
  PageOptions,
  PrivateFileResponse,
  ProjectReference,
  ReadPrivateFileOptions,
  ReplaceBrowserOriginsOutcome,
  ReplaceBrowserOriginsRequest,
  UuidV7,
} from "./types.js";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const API_ERROR = /^ALMIRA_[A-Z0-9_]{1,120}$/u;
const BYTE_RANGE = /^bytes=[0-9]+-[0-9]*$/u;
const MAXIMUM_JSON_RESPONSE_BYTES = 2 * 1024 * 1024;

type CredentialProvider = () => string | Promise<string>;

/** Creates a UUIDv7 suitable for one new idempotent Almira mutation. */
export function createOperationId(now = Date.now()): UuidV7 {
  if (!Number.isSafeInteger(now) || now < 0 || now > 281_474_976_710_655) invalidInput();
  const bytes = new Uint8Array(16);
  let milliseconds = BigInt(now);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(milliseconds & 0xffn);
    milliseconds >>= 8n;
  }
  globalThis.crypto.getRandomValues(bytes.subarray(6));
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hexadecimal = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hexadecimal.slice(0, 8)}-${hexadecimal.slice(8, 12)}-${hexadecimal.slice(12, 16)}-${hexadecimal.slice(16, 20)}-${hexadecimal.slice(20)}`;
}

export interface AlmiraClientOptions {
  baseUrl?: string;
  credential?: string | CredentialProvider;
  fetch?: typeof globalThis.fetch;
}

interface JsonRequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
  method: "DELETE" | "GET" | "POST" | "PUT";
  signal?: AbortSignal | undefined;
}

export class AlmiraClient {
  readonly #baseUrl: string;
  readonly #credential: CredentialProvider | null;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: AlmiraClientOptions = {}) {
    const baseUrl = options.baseUrl ?? "/platform/almira";
    if (
      baseUrl.length === 0 ||
      /[?#\\\u0000-\u0020\u007f]/u.test(baseUrl) ||
      (!baseUrl.startsWith("/") && !/^https?:\/\//u.test(baseUrl))
    ) {
      throw new AlmiraClientError("ALMIRA_CLIENT_INPUT_INVALID");
    }
    this.#baseUrl = baseUrl === "/" ? "" : baseUrl.replace(/\/+$/u, "");
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (typeof this.#fetch !== "function") {
      throw new AlmiraClientError("ALMIRA_CLIENT_INPUT_INVALID");
    }
    this.#credential = credentialProvider(options.credential);
  }

  async bootstrapProject(
    reference: ProjectReference,
    options: MutationOptions,
  ): Promise<BootstrapOutcome> {
    return this.#json(projectPath(reference, "/bootstrap"), {
      method: "POST",
      headers: mutationHeaders(options.operationId),
      signal: options.signal,
    });
  }

  async listEnvironments(
    reference: ProjectReference,
    options: { signal?: AbortSignal } = {},
  ): Promise<EnvironmentList> {
    return this.#json(projectPath(reference, "/environments"), {
      method: "GET",
      signal: options.signal,
    });
  }

  async getBrowserOrigins(
    reference: EnvironmentReference,
    options: { signal?: AbortSignal } = {},
  ): Promise<BrowserOriginPolicy> {
    return this.#json(environmentPath(reference, "/browser-origins"), {
      method: "GET",
      signal: options.signal,
    });
  }

  async replaceBrowserOrigins(
    reference: EnvironmentReference,
    request: ReplaceBrowserOriginsRequest,
    options: MutationOptions,
  ): Promise<ReplaceBrowserOriginsOutcome> {
    return this.#json(environmentPath(reference, "/browser-origins"), {
      method: "PUT",
      headers: mutationHeaders(options.operationId),
      body: request,
      signal: options.signal,
    });
  }

  async listCollections(
    reference: EnvironmentReference,
    options: PageOptions = {},
  ): Promise<CollectionPage> {
    return this.#json(withPage(environmentPath(reference, "/collections"), options), {
      method: "GET",
      signal: options.signal,
    });
  }

  async createCollection(
    reference: EnvironmentReference,
    request: CreateCollectionRequest,
    options: MutationOptions,
  ): Promise<CreateCollectionOutcome> {
    return this.#json(environmentPath(reference, "/collections"), {
      method: "POST",
      headers: mutationHeaders(options.operationId),
      body: request,
      signal: options.signal,
    });
  }

  async getCollection(
    reference: CollectionReference,
    options: { signal?: AbortSignal } = {},
  ): Promise<Collection> {
    return this.#json(collectionPath(reference), { method: "GET", signal: options.signal });
  }

  async createUpload(
    reference: CollectionReference,
    request: CreateUploadRequest,
    options: MutationOptions,
  ): Promise<CreateUploadOutcome> {
    return this.#json(collectionPath(reference, "/uploads"), {
      method: "POST",
      headers: mutationHeaders(options.operationId),
      body: request,
      signal: options.signal,
    });
  }

  async finalizeUpload(
    reference: CollectionReference & { transferSessionId: UuidV7 },
    request: FinalizeUploadRequest,
    options: MutationOptions,
  ): Promise<FileEntry> {
    return this.#json(
      collectionPath(reference, `/uploads/${uuid(reference.transferSessionId)}/finalize`),
      {
        method: "POST",
        headers: mutationHeaders(options.operationId),
        body: request,
        signal: options.signal,
      },
    );
  }

  async listFiles(
    reference: CollectionReference,
    options: PageOptions & { pathPrefix?: string } = {},
  ): Promise<FileEntryPage> {
    const query = new URLSearchParams();
    appendPage(query, options);
    if (options.pathPrefix !== undefined) query.set("path_prefix", options.pathPrefix);
    return this.#json(withQuery(collectionPath(reference, "/files"), query), {
      method: "GET",
      signal: options.signal,
    });
  }

  async getFileMetadata(
    reference: FileReference,
    options: { signal?: AbortSignal } = {},
  ): Promise<FileEntry> {
    return this.#json(filePath(reference), { method: "GET", signal: options.signal });
  }

  async deleteFile(
    reference: FileReference,
    expectedRevision: number,
    options: MutationOptions,
  ): Promise<DeleteFileOutcome> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) invalidInput();
    return this.#json(filePath(reference), {
      method: "DELETE",
      headers: {
        ...mutationHeaders(options.operationId),
        "if-match": String(expectedRevision),
      },
      signal: options.signal,
    });
  }

  async readPrivateFile(options: ReadPrivateFileOptions): Promise<PrivateFileResponse> {
    const query = new URLSearchParams();
    if (options.generationId !== undefined) query.set("generation_id", uuid(options.generationId));
    const headers: Record<string, string> = { accept: "application/octet-stream" };
    if (options.range !== undefined) {
      if (options.range.length > 64 || !BYTE_RANGE.test(options.range)) invalidInput();
      headers.range = options.range;
    }
    const response = await this.#request(withQuery(filePath(options, "/content"), query), {
      method: "GET",
      headers,
      signal: options.signal,
    });
    if (response.status !== 200 && response.status !== 206) {
      await throwApiError(response);
    }
    return {
      body: response.body,
      contentLength: safeIntegerHeader(response.headers.get("content-length")),
      contentRange: response.headers.get("content-range"),
      contentType: response.headers.get("content-type"),
      etag: response.headers.get("etag"),
      status: response.status,
    } as PrivateFileResponse;
  }

  async #json<T>(path: string, options: JsonRequestOptions): Promise<T> {
    const response = await this.#request(path, options);
    if (!response.ok) await throwApiError(response);
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
    if (contentType !== "application/json") invalidResponse();
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAXIMUM_JSON_RESPONSE_BYTES) invalidResponse();
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as T;
    } catch {
      return invalidResponse();
    }
  }

  async #request(path: string, options: JsonRequestOptions): Promise<Response> {
    const headers = new Headers(options.headers);
    if (!headers.has("accept")) headers.set("accept", "application/json");
    let body: string | undefined;
    if (options.body !== undefined) {
      headers.set("content-type", "application/json");
      try {
        body = JSON.stringify(options.body);
      } catch {
        invalidInput();
      }
    }
    if (this.#credential !== null) {
      let credential: string;
      try {
        credential = await this.#credential();
      } catch {
        throw new AlmiraClientError("ALMIRA_CLIENT_CREDENTIAL_UNAVAILABLE");
      }
      if (!validCredential(credential)) invalidInput();
      headers.set("authorization", `Bearer ${credential}`);
    }
    try {
      return await this.#fetch(`${this.#baseUrl}${path}`, {
        method: options.method,
        headers,
        ...(body === undefined ? {} : { body }),
        credentials: this.#credential === null ? "include" : "omit",
        redirect: "error",
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error) {
      if (options.signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
        throw new AlmiraClientError("ALMIRA_CLIENT_ABORTED");
      }
      throw new AlmiraClientError("ALMIRA_CLIENT_NETWORK");
    }
  }
}

function credentialProvider(
  credential: AlmiraClientOptions["credential"],
): CredentialProvider | null {
  if (credential === undefined) return null;
  return typeof credential === "function" ? credential : () => credential;
}

function validCredential(value: string): boolean {
  return value.length > 0 && value.length <= 16_384 && !/[\u0000-\u0020\u007f]/u.test(value);
}

function mutationHeaders(operationId: UuidV7): Record<string, string> {
  return { "idempotency-key": uuid(operationId) };
}

function uuid(value: string): string {
  if (!UUID_V7.test(value)) invalidInput();
  return value;
}

function projectPath(reference: ProjectReference, suffix = ""): string {
  return `/v1/projects/${uuid(reference.projectId)}${suffix}`;
}

function environmentPath(reference: EnvironmentReference, suffix = ""): string {
  return `${projectPath(reference, "/environments")}/${uuid(reference.environmentId)}${suffix}`;
}

function collectionPath(reference: CollectionReference, suffix = ""): string {
  return `${environmentPath(reference, "/collections")}/${uuid(reference.collectionInstanceId)}${suffix}`;
}

function filePath(reference: FileReference, suffix = ""): string {
  return `${collectionPath(reference, "/files")}/${uuid(reference.entryId)}${suffix}`;
}

function withPage(path: string, options: PageOptions): string {
  const query = new URLSearchParams();
  appendPage(query, options);
  return withQuery(path, query);
}

function appendPage(query: URLSearchParams, options: PageOptions): void {
  if (options.limit !== undefined) {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100) invalidInput();
    query.set("limit", String(options.limit));
  }
  if (options.cursor !== undefined) {
    if (options.cursor.length === 0 || options.cursor.length > 2048) invalidInput();
    query.set("cursor", options.cursor);
  }
}

function withQuery(path: string, query: URLSearchParams): string {
  const encoded = query.toString();
  return encoded.length === 0 ? path : `${path}?${encoded}`;
}

function invalidInput(): never {
  throw new AlmiraClientError("ALMIRA_CLIENT_INPUT_INVALID");
}

function invalidResponse(): never {
  throw new AlmiraClientError("ALMIRA_CLIENT_RESPONSE_INVALID");
}

async function throwApiError(response: Response): Promise<never> {
  let value: unknown;
  try {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > 64 * 1024) invalidResponse();
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof AlmiraClientError) throw error;
    return invalidResponse();
  }
  if (!isApiError(value)) invalidResponse();
  throw new AlmiraApiError(
    value.code,
    value.request_id,
    response.status,
    retryAfterMilliseconds(response.headers.get("retry-after")),
  );
}

function isApiError(value: unknown): value is { code: string; request_id: UuidV7 } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 2 &&
    typeof record.code === "string" &&
    API_ERROR.test(record.code) &&
    typeof record.request_id === "string" &&
    UUID_V7.test(record.request_id)
  );
}

function retryAfterMilliseconds(value: string | null): number | null {
  if (value === null || !/^[0-9]{1,8}$/u.test(value)) return null;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) ? seconds * 1_000 : null;
}

function safeIntegerHeader(value: string | null): number | null {
  if (value === null || !/^(0|[1-9][0-9]{0,15})$/u.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}
