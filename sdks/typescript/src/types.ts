export type UuidV7 = string;
export type Timestamp = string;
export type ContentSha256 = `sha256:${string}`;

export interface Environment {
  environment_id: UuidV7;
  environment_key: string;
  display_name: string;
  system_key: "development" | "production" | null;
  revision: number;
  created_at: Timestamp;
}

export interface BootstrapOutcome {
  disposition: "applied" | "converged" | "exact_replay";
  project_revision: number;
  environments: Environment[];
}

export interface EnvironmentList {
  environments: Environment[];
}

export interface BrowserOriginPolicy {
  environment_id: UuidV7;
  origins: string[];
  revision: number;
}

export interface ReplaceBrowserOriginsRequest {
  expected_revision: number;
  origins: string[];
}

export interface ReplaceBrowserOriginsOutcome {
  disposition: "applied" | "exact_replay";
  policy: BrowserOriginPolicy;
}

export interface CreateCollectionRequest {
  collection_key: string;
  display_name: string;
  malware_scan_required: boolean;
}

export interface Collection {
  collection_id: UuidV7;
  collection_instance_id: UuidV7;
  environment_id: UuidV7;
  collection_key: string;
  display_name: string;
  access_template: "private";
  storage_class: "normal";
  storage_binding_state: "pending" | "ready" | "migrating" | "failed";
  technical_metadata_extraction: true;
  malware_scan_required: boolean;
  content_extraction: false;
  vector_indexing: false;
  delivery_mode: "off";
  revision: number;
  created_at: Timestamp;
}

export interface CreateCollectionOutcome {
  disposition: "applied" | "exact_replay";
  collection: Collection;
}

export interface CollectionPage {
  collections: Collection[];
  next_cursor: string | null;
}

export interface CreateUploadRequest {
  path: string;
  expected_size_bytes: number;
  content_sha256: ContentSha256;
  declared_media_type: string;
  browser_origin?: string | null;
}

export interface DirectUploadHeader {
  name: string;
  value: string;
}

export interface DirectUploadPart {
  part_number: number;
  offset_bytes: number;
  length_bytes: number;
  method: "PUT";
  url: string;
  headers: DirectUploadHeader[];
  one_use: true;
}

export interface DirectUploadDescriptor {
  descriptor_id: UuidV7;
  protocol: "single_put" | "multipart";
  requests: DirectUploadPart[];
  expected_size_bytes: number;
  content_sha256: ContentSha256;
  one_use: true;
  expires_at: Timestamp;
}

export interface CreateUploadOutcome {
  transfer_session_id: UuidV7;
  entry_id: UuidV7;
  generation_id: UuidV7;
  descriptor: DirectUploadDescriptor;
}

export interface DirectUploadPartCompletion {
  part_number: number;
  etag: string;
}

export interface FinalizeUploadRequest {
  descriptor_id: UuidV7;
  protocol: "single_put" | "multipart";
  etag: string | null;
  provider_version: string | null;
  parts: DirectUploadPartCompletion[];
  size_bytes: number;
  content_sha256: ContentSha256;
}

export interface FileGeneration {
  entry_id: UuidV7;
  generation_id: UuidV7;
  generation_number: number;
  state: "pending_transfer" | "aborted" | "safety_pending" | "available" | "unavailable";
  expected_size_bytes: number;
  content_sha256: ContentSha256;
  declared_media_type: string;
  malware_scan_requirement: "not_required" | "required";
  safety_state: "not_required" | "scan_pending" | "clean" | "blocked";
  revision: number;
  created_at: Timestamp;
}

export interface FileEntry {
  entry_id: UuidV7;
  logical_path: string;
  lifecycle: "active" | "restricted" | "deleted";
  revision: number;
  latest_generation: FileGeneration;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface FileEntryPage {
  entries: FileEntry[];
  next_cursor: string | null;
}

export interface DeleteFileOutcome {
  disposition: "applied" | "exact_replay";
  entry: FileEntry;
}

export interface ProjectReference {
  projectId: UuidV7;
}

export interface EnvironmentReference extends ProjectReference {
  environmentId: UuidV7;
}

export interface CollectionReference extends EnvironmentReference {
  collectionInstanceId: UuidV7;
}

export interface FileReference extends CollectionReference {
  entryId: UuidV7;
}

export interface MutationOptions {
  operationId: UuidV7;
  signal?: AbortSignal;
}

export interface PageOptions {
  limit?: number;
  cursor?: string;
  signal?: AbortSignal;
}

export interface ReadPrivateFileOptions extends FileReference {
  generationId?: UuidV7;
  range?: string;
  signal?: AbortSignal;
}

export interface PrivateFileResponse {
  body: ReadableStream<Uint8Array> | null;
  contentLength: number | null;
  contentRange: string | null;
  contentType: string | null;
  etag: string | null;
  status: 200 | 206;
}
