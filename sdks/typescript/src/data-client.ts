import { AlmiraApiError, AlmiraClientError } from "./errors.js";
import { validateSearchInput } from "./client.js";
import type {
  CollectionReference,
  FileEntry,
  FileEntryPage,
  FileReference,
  PageOptions,
  PrivateFileResponse,
  SearchInput,
  SearchPage,
  UuidV7,
} from "./types.js";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const API_ERROR = /^ALMIRA_[A-Z0-9_]{1,120}$/u;
const BYTE_RANGE = /^bytes=[0-9]+-[0-9]*$/u;
type CapabilityProvider = () => string | Promise<string>;

export interface AlmiraDataClientOptions {
  baseUrl?: string;
  capability?: string | CapabilityProvider;
  /** Canonical application origin for non-browser runtimes. Browsers supply Origin themselves. */
  origin?: string;
  fetch?: typeof globalThis.fetch;
}

export interface ImmutableGenerationReference extends FileReference {
  generationId: UuidV7;
}

export interface DataReadOptions {
  ifNoneMatch?: string;
  range?: string;
  signal?: AbortSignal;
}

export interface DataFileResponse extends Omit<PrivateFileResponse, "status"> {
  status: 200 | 206 | 304;
}

/** Capability-only application data client; it never accepts management credentials. */
export class AlmiraDataClient {
  readonly #baseUrl: string;
  readonly #capability: CapabilityProvider | null;
  readonly #origin: string | null;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: AlmiraDataClientOptions = {}) {
    const baseUrl = options.baseUrl ?? "";
    if (
      /[?#\\\u0000-\u0020\u007f]/u.test(baseUrl) ||
      (baseUrl.length > 0 && !baseUrl.startsWith("/") && !/^https?:\/\//u.test(baseUrl))
    ) invalidInput();
    if (options.origin !== undefined && !/^https?:\/\/[^/?#]+$/u.test(options.origin)) invalidInput();
    this.#baseUrl = baseUrl === "/" ? "" : baseUrl.replace(/\/+$/u, "");
    this.#capability = options.capability === undefined
      ? null
      : typeof options.capability === "function" ? options.capability : () => options.capability as string;
    this.#origin = options.origin ?? null;
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (typeof this.#fetch !== "function") invalidInput();
  }

  async listFilesWithCapability(
    reference: CollectionReference,
    options: PageOptions & { pathPrefix?: string } = {},
  ): Promise<FileEntryPage> {
    const query = new URLSearchParams();
    if (options.limit !== undefined) {
      if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100) invalidInput();
      query.set("limit", String(options.limit));
    }
    if (options.cursor !== undefined) query.set("cursor", options.cursor);
    if (options.pathPrefix !== undefined) query.set("path_prefix", options.pathPrefix);
    return this.#json(withQuery(dataCollectionPath(reference, "/files"), query), options.signal);
  }

  async getFileMetadataWithCapability(
    reference: FileReference,
    options: { signal?: AbortSignal } = {},
  ): Promise<FileEntry> {
    return this.#json(`${dataCollectionPath(reference, "/files")}/${uuid(reference.entryId)}`, options.signal);
  }

  async searchFilesWithCapability(
    reference: CollectionReference,
    input: SearchInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<SearchPage> {
    validateSearchInput(input);
    return this.#json(dataCollectionPath(reference, "/search"), options.signal, input);
  }

  async readImmutableGeneration(
    reference: ImmutableGenerationReference,
    options: DataReadOptions = {},
  ): Promise<DataFileResponse> {
    const path = `/v1/delivery/${uuid(reference.tenantId)}/${uuid(reference.projectId)}/${uuid(reference.environmentId)}/${uuid(reference.collectionInstanceId)}/${uuid(reference.entryId)}/${uuid(reference.generationId)}`;
    return this.#bytes(path, options, "optional");
  }

  async readShare(
    shareToken: string,
    options: DataReadOptions = {},
  ): Promise<DataFileResponse> {
    if (!/^alm_share_v1\.[A-Za-z0-9_-]{43}$/u.test(shareToken)) invalidInput();
    return this.#bytes(`/v1/shares/${shareToken}`, options, "forbidden");
  }

  async #json<T>(path: string, signal?: AbortSignal, body?: unknown): Promise<T> {
    const headers = new Headers({ accept: "application/json" });
    let encoded: string | undefined;
    if (body !== undefined) {
      headers.set("content-type", "application/json");
      try {
        encoded = JSON.stringify(body);
      } catch {
        invalidInput();
      }
    }
    const response = await this.#request(
      path,
      headers,
      signal,
      "required",
      encoded === undefined ? "GET" : "POST",
      encoded,
    );
    if (!response.ok) await throwApiError(response);
    if (response.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") invalidResponse();
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > 2 * 1024 * 1024) invalidResponse();
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as T;
    } catch {
      return invalidResponse();
    }
  }

  async #bytes(
    path: string,
    options: DataReadOptions,
    capabilityMode: "optional" | "forbidden",
  ): Promise<DataFileResponse> {
    const headers = new Headers({ accept: "application/octet-stream" });
    if (options.range !== undefined) {
      if (options.range.length > 64 || !BYTE_RANGE.test(options.range)) invalidInput();
      headers.set("range", options.range);
    }
    if (options.ifNoneMatch !== undefined) {
      if (options.ifNoneMatch.length === 0 || options.ifNoneMatch.length > 512 || /[\r\n]/u.test(options.ifNoneMatch)) invalidInput();
      headers.set("if-none-match", options.ifNoneMatch);
    }
    const response = await this.#request(path, headers, options.signal, capabilityMode);
    if (response.status !== 200 && response.status !== 206 && response.status !== 304) await throwApiError(response);
    return {
      body: response.body,
      contentLength: safeIntegerHeader(response.headers.get("content-length")),
      contentRange: response.headers.get("content-range"),
      contentType: response.headers.get("content-type"),
      etag: response.headers.get("etag"),
      status: response.status,
    } as DataFileResponse;
  }

  async #request(
    path: string,
    headersOrAccept: Headers | string,
    signal: AbortSignal | undefined,
    capabilityMode: "required" | "optional" | "forbidden",
    method: "GET" | "POST" = "GET",
    body?: string,
  ): Promise<Response> {
    const headers = headersOrAccept instanceof Headers ? headersOrAccept : new Headers({ accept: headersOrAccept });
    if (capabilityMode !== "forbidden" && this.#origin !== null) headers.set("origin", this.#origin);
    if (capabilityMode !== "forbidden" && this.#capability !== null) {
      let capability: string;
      try {
        capability = await this.#capability();
      } catch {
        throw new AlmiraClientError("ALMIRA_CLIENT_CREDENTIAL_UNAVAILABLE");
      }
      if (!/^alm_(?:cap|local)_v1\.[A-Za-z0-9_.-]{20,24576}$/u.test(capability)) invalidInput();
      headers.set("authorization", `Bearer ${capability}`);
    } else if (capabilityMode === "required") {
      invalidInput();
    }
    try {
      return await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        credentials: "omit",
        redirect: "error",
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
        throw new AlmiraClientError("ALMIRA_CLIENT_ABORTED");
      }
      throw new AlmiraClientError("ALMIRA_CLIENT_NETWORK");
    }
  }
}

function dataCollectionPath(reference: CollectionReference, suffix: string): string {
  return `/v1/data/${uuid(reference.tenantId)}/${uuid(reference.projectId)}/${uuid(reference.environmentId)}/${uuid(reference.collectionInstanceId)}${suffix}`;
}

function uuid(value: string): string {
  if (!UUID_V7.test(value)) invalidInput();
  return value;
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
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalidResponse();
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 ||
    typeof record.code !== "string" ||
    !API_ERROR.test(record.code) ||
    typeof record.request_id !== "string" ||
    !UUID_V7.test(record.request_id)
  ) invalidResponse();
  throw new AlmiraApiError(record.code, record.request_id, response.status, retryAfter(response.headers.get("retry-after")));
}

function retryAfter(value: string | null): number | null {
  if (value === null || !/^[0-9]{1,8}$/u.test(value)) return null;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) ? seconds * 1_000 : null;
}

function safeIntegerHeader(value: string | null): number | null {
  if (value === null || !/^(0|[1-9][0-9]{0,15})$/u.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}
