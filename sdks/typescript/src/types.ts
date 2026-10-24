export type UuidV7 = string;
export type Timestamp = string;
export type ContentSha256 = `sha256:${string}`;

export interface Environment {
  environment_id: UuidV7;
  environment_key: string;
  display_name: string;
  system_key: "development" | "production" | null;
  operating_model: "managed" | "hosted_customer_owned" | "connected_site";
  lifecycle: "active" | "deletion_pending";
  revision: number;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface CreateEnvironmentRequest {
  environment_key: string;
  display_name: string;
}

export interface UpdateEnvironmentRequest {
  display_name: string;
  expected_revision: number;
}

export interface AdoptCustomerStorageRequest {
  enrollment_operation_id: UuidV7;
  expected_revision: number;
}

export interface RestoreManagedStorageRequest {
  expected_revision: number;
}

export interface EnvironmentMutationOutcome {
  disposition: "applied" | "exact_replay";
  environment: Environment;
}

export interface BootstrapOutcome {
  disposition: "applied" | "converged" | "exact_replay";
  project_revision: number;
  environments: Environment[];
}

export interface TenancyProject {
  tenant_id: UuidV7;
  project_id: UuidV7;
  space_id: UuidV7;
  product_id: "almira";
  product_section_id: null;
  project_kind_id: "almira.storage";
  owner_region_id: string;
  name: string;
  visibility: "private" | "public";
  lifecycle: "active";
  route_epoch: number;
  revision: number;
  restrictive_revision: number;
  activated_at: Timestamp;
}

export interface TenancyProjectGetResponse {
  schema_version: 1;
  operation_id: UuidV7;
  operation: "project.get";
  disposition: "succeeded" | "exact_replay";
  result: { project: TenancyProject };
}

export interface BootstrapProjectRequest {
  tenancy_project: TenancyProjectGetResponse;
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

export type StorageProviderFamily = "aws_s3" | "gcs" | "azure_blob";
export type StorageTransferCapability =
  | "direct_upload"
  | "multipart_upload"
  | "resumable_upload"
  | "exact_generation_delete"
  | "class_migration";

export interface StorageRealizationCapability {
  realization_generation: number;
  storage_class: "normal" | "express";
  operating_model: Environment["operating_model"];
  provider_family: StorageProviderFamily | null;
  binding_label: string | null;
  maximum_object_bytes: number;
  supported_capabilities: StorageTransferCapability[];
  unavailable_capabilities: StorageTransferCapability[];
}

export interface StorageRealizationCatalog {
  environment_id: UuidV7;
  operating_model: Environment["operating_model"];
  route_epoch: number;
  placement_epoch: number | null;
  authorization_decision_id: UuidV7;
  authorization_fact_set_digest: ContentSha256;
  catalog_epoch: number;
  catalog_release_id: string;
  catalog_bundle_digest: ContentSha256;
  realization_catalog_digest: ContentSha256;
  realizations: StorageRealizationCapability[];
}

export interface CreateCollectionRequest {
  collection_key: string;
  display_name: string;
  malware_scan_required: boolean;
  storage_class?: "normal" | "express";
}

export interface Collection {
  collection_id: UuidV7;
  collection_instance_id: UuidV7;
  environment_id: UuidV7;
  collection_key: string;
  display_name: string;
  access_template: "server_only" | "private" | "public_read";
  storage_class: "normal" | "express";
  storage_binding_state: "pending" | "ready" | "migrating" | "failed";
  technical_metadata_extraction: true;
  malware_scan_required: boolean;
  content_extraction: boolean;
  ocr_extraction: boolean;
  transcription_extraction: boolean;
  vector_indexing: boolean;
  delivery_mode: "off" | "public" | "private";
  recycle_retention_days: number;
  revision: number;
  created_at: Timestamp;
}

export interface CollectionLifecycleInput {
  recycle_retention_days: number;
}

export interface ReplaceCollectionLifecycleRequest {
  expected_revision: number;
  config: CollectionLifecycleInput;
}

export interface CollectionLifecycleOutcome {
  disposition: "applied" | "exact_replay";
  collection: Collection;
}

export interface CreateCollectionOutcome {
  disposition: "applied" | "exact_replay";
  collection: Collection;
}

export interface CollectionExtractionInput {
  content: boolean;
  ocr: boolean;
  transcription: boolean;
  vector_indexing?: boolean;
}

export interface CollectionExtractionConfig extends CollectionExtractionInput {
  collection_instance_id: UuidV7;
  technical_metadata: true;
  vector_indexing: boolean;
  revision: number;
  updated_at: Timestamp;
}

export interface ReplaceCollectionExtractionRequest {
  expected_revision: number;
  config: CollectionExtractionInput;
}

export interface ExtractionConfigOutcome {
  disposition: "applied" | "exact_replay";
  config: CollectionExtractionConfig;
}

export type ImageFormat = "avif" | "webp" | "jpeg" | "png";
export type ImageFit = "contain" | "cover" | "inside";
export type VideoProfile = "web_hls_v1";

export interface ImagePreset {
  widths: number[];
  height: number | null;
  fit: ImageFit;
  formats: ImageFormat[];
  without_enlargement: boolean;
}

export interface CollectionMediaInput {
  image_presets?: Record<string, ImagePreset>;
  document_previews?: boolean;
  video_profile?: VideoProfile | null;
}

export interface CollectionMediaConfig {
  collection_instance_id: UuidV7;
  image_presets: Record<string, ImagePreset>;
  document_previews: boolean;
  video_profile: VideoProfile | null;
  revision: number;
  updated_at: Timestamp;
}

export interface ReplaceCollectionMediaRequest {
  expected_revision: number;
  config: CollectionMediaInput;
}

export interface MediaConfigOutcome {
  disposition: "applied" | "exact_replay";
  config: CollectionMediaConfig;
}

export interface CollectionProtectionInput {
  malware_scan_required: boolean;
}

export interface CollectionProtectionConfig extends CollectionProtectionInput {
  collection_instance_id: UuidV7;
  applies_to_new_generations_only: true;
  revision: number;
  updated_at: Timestamp;
}

export interface ReplaceCollectionProtectionRequest {
  expected_revision: number;
  config: CollectionProtectionInput;
}

export interface ProtectionConfigOutcome {
  disposition: "applied" | "exact_replay";
  config: CollectionProtectionConfig;
}

export type ProtectionReviewDecision = "confirmed_blocked" | "suspected_false_positive";

export interface ProtectionReviewInput {
  decision: ProtectionReviewDecision;
  reason: string;
}

export interface ProtectionReview {
  review_id: UuidV7;
  entry_id: UuidV7;
  generation_id: UuidV7;
  decision: ProtectionReviewDecision;
  reason: string;
  generation_revision: number;
  created_at: Timestamp;
}

export interface ProtectionScanEvidence {
  engine_version: string;
  signature_version: string;
  safe_result_code: string;
}

export type ProtectionScanState =
  | "queued"
  | "running"
  | "retry_wait"
  | "scan_pending"
  | "clean"
  | "blocked"
  | "failed";

export interface ProtectionScanJob {
  job_id: UuidV7;
  entry_id: UuidV7;
  generation_id: UuidV7;
  state: ProtectionScanState;
  source_content_sha256: ContentSha256;
  attempt_count: number;
  failure_code: string | null;
  evidence: ProtectionScanEvidence | null;
  revision: number;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ProtectionScanOutcome {
  disposition: "applied" | "exact_replay";
  job: ProtectionScanJob;
}

export interface ProtectionReviewOutcome {
  disposition: "applied" | "exact_replay";
  review: ProtectionReview;
}

export interface ProtectionCase {
  collection_instance_id: UuidV7;
  entry_id: UuidV7;
  generation_id: UuidV7;
  generation_number: number;
  logical_path: string;
  malware_scan_requirement: "required";
  safety_state: "scan_pending" | "clean" | "blocked";
  generation_revision: number;
  latest_scan_job: ProtectionScanJob | null;
  latest_review: ProtectionReview | null;
  updated_at: Timestamp;
}

export interface ProtectionCasePage {
  cases: ProtectionCase[];
  next_cursor: string | null;
}

export interface ProtectionCasePageOptions extends PageOptions {
  collectionInstanceId?: UuidV7;
  safetyState?: "scan_pending" | "clean" | "blocked";
}

export interface ProtectionMutationRequest {
  expected_revision: number;
}

export interface CreateProtectionReviewRequest extends ProtectionMutationRequest {
  review: ProtectionReviewInput;
}

export type ProcessingKind = "image_variants" | "document_preview" | "video_package";
export type ProcessingState =
  | "pending"
  | "running"
  | "retry_wait"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "superseded";

export interface ProcessingJob {
  job_id: UuidV7;
  entry_id: UuidV7;
  generation_id: UuidV7;
  kind: ProcessingKind;
  state: ProcessingState;
  source_content_sha256: ContentSha256;
  media_config_revision: number;
  processor_id: string;
  processor_version: string;
  runtime_digest: ContentSha256;
  progress_percent: number;
  attempt_count: number;
  failure_code: string | null;
  revision: number;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ProcessingJobPage {
  jobs: ProcessingJob[];
  next_cursor: string | null;
}

export interface MutateProcessingJobRequest {
  expected_revision: number;
}

export interface JobMutationOutcome {
  disposition: "applied" | "exact_replay";
  job: ProcessingJob;
}

export type DerivativeKind =
  | "image_variant"
  | "document_page"
  | "video_mp4"
  | "video_hls_manifest"
  | "video_hls_segment"
  | "video_poster"
  | "video_storyboard"
  | "subtitle";

export interface MediaDerivative {
  derivative_id: UuidV7;
  job_id: UuidV7;
  entry_id: UuidV7;
  generation_id: UuidV7;
  variant_key: string;
  kind: DerivativeKind;
  media_type: string;
  content_sha256: ContentSha256;
  size_bytes: number;
  width_px: number | null;
  height_px: number | null;
  duration_millis: number | null;
  source_content_sha256: ContentSha256;
  media_config_revision: number;
  processor_id: string;
  processor_version: string;
  runtime_digest: ContentSha256;
  revision: number;
  created_at: Timestamp;
}

export type CustomerStorageProviderConfiguration =
  | {
      provider: "aws_s3";
      partition: "aws" | "aws_cn" | "aws_us_gov";
      account_id: string;
      region: string;
      bucket: string;
      expected_bucket_owner: string;
      role_arn: string;
      encryption: "aws_sse_s3" | "aws_sse_kms";
      encryption_key: string | null;
    }
  | {
      provider: "gcs";
      project_id: string;
      project_number: string;
      bucket: string;
      location: string;
      service_account: string;
      encryption: "gcp_managed" | "gcp_cmek";
      encryption_key: string | null;
    }
  | {
      provider: "azure_blob";
      tenant_id: string;
      subscription_id: string;
      account: string;
      container: string;
      location: string;
      client_id: string;
      encryption: "azure_managed" | "azure_encryption_scope";
      encryption_scope: string | null;
    };

export interface StartStorageEnrollmentRequest {
  binding_label: string;
  storage_class: "normal" | "express";
  provider_configuration: CustomerStorageProviderConfiguration;
}

export interface StorageEnrollmentRealization {
  realization_generation: number;
  storage_class: "normal" | "express";
}

export interface StorageEnrollment {
  operation_id: UuidV7;
  enrollment_id: UuidV7 | null;
  binding_label: string;
  provider_family: "aws_s3" | "gcs" | "azure_blob";
  storage_class: "normal" | "express";
  state: "starting" | "proof_pending" | "active" | "blocked" | "retired";
  realization: StorageEnrollmentRealization | null;
  capability_proof_digest: ContentSha256 | null;
  health_evidence_digest: ContentSha256 | null;
  failure_code: string | null;
  owner_revision: number;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface StartStorageEnrollmentOutcome {
  disposition: "applied" | "exact_replay";
  enrollment: StorageEnrollment;
}

export interface StorageEnrollmentList {
  enrollments: StorageEnrollment[];
}

export interface StartStorageMigrationRequest {
  target_storage_class: "normal" | "express";
  target_realization_generation: number;
  expected_collection_revision: number;
}

export interface StorageMigrationBinding {
  realization_binding_digest: ContentSha256;
  realization_generation: number;
}

export interface StorageMigrationProgress {
  objects_total: number;
  bytes_total: number;
  objects_copied: number;
  bytes_copied: number;
  objects_verified: number;
  source_objects_cleaned: number;
}

export interface StorageMigration {
  migration_id: UuidV7;
  environment_id: UuidV7;
  collection_instance_id: UuidV7;
  source_storage_class: "normal" | "express";
  target_storage_class: "normal" | "express";
  source_binding: StorageMigrationBinding;
  target_binding: StorageMigrationBinding;
  inventory_digest: ContentSha256;
  phase: "starting" | "inventory" | "copying" | "verifying" | "cutover" | "cleanup" | "succeeded" | "failed";
  progress: StorageMigrationProgress;
  failure: "target_unavailable" | "source_changed" | "verification_failed" | "owner_failed" | null;
  expected_collection_revision: number;
  revision: number;
  created_at: Timestamp;
  updated_at: Timestamp;
  completed_at: Timestamp | null;
}

export interface StartStorageMigrationOutcome {
  disposition: "applied" | "exact_replay";
  migration: StorageMigration;
}

export interface ImportSourceBinding {
  source_binding_id: UuidV7;
  source_binding_generation: number;
  manifest_sha256: ContentSha256;
  objects_total: number;
  bytes_total: number;
}

export interface ImportManifestObject {
  source_object_id: UuidV7;
  logical_path: string;
  expected_size_bytes: number;
  content_sha256: ContentSha256;
  declared_media_type: string;
}

export interface StartCollectionImportRequest {
  expected_collection_revision: number;
  source: ImportSourceBinding;
  objects: ImportManifestObject[];
  destination_prefix?: string;
}

export interface StartCollectionExportRequest {
  expected_collection_revision: number;
}

export interface PortabilityProgress {
  objects_total: number;
  bytes_total: number;
  objects_transferred: number;
  bytes_transferred: number;
  objects_verified: number;
  objects_rejected: number;
}

export interface PortableExportArtifact {
  artifact_id: UuidV7;
  manifest_sha256: ContentSha256;
  content_sha256: ContentSha256;
  size_bytes: number;
  expires_at: Timestamp;
}

export interface PortabilityJob {
  job_id: UuidV7;
  environment_id: UuidV7;
  collection_instance_id: UuidV7;
  kind: "import" | "export";
  source: ImportSourceBinding | null;
  destination_prefix: string | null;
  inventory_digest: ContentSha256;
  phase: "starting" | "transferring" | "verifying" | "packaging" | "succeeded" | "failed";
  progress: PortabilityProgress;
  failure: "source_unavailable" | "source_changed" | "target_unavailable" | "verification_failed" | "owner_failed" | null;
  artifact: PortableExportArtifact | null;
  expected_collection_revision: number;
  revision: number;
  created_at: Timestamp;
  updated_at: Timestamp;
  completed_at: Timestamp | null;
}

export interface PortabilityJobOutcome {
  disposition: "applied" | "exact_replay";
  job: PortabilityJob;
}

export interface PortabilityJobPage {
  jobs: PortabilityJob[];
  next_cursor: string | null;
}

export interface PortabilityJobPageOptions extends PageOptions {
  kind?: "import" | "export";
}

export interface PortableDownloadHeader {
  name: string;
  value: string;
}

export interface PortableDownloadDescriptor {
  descriptor_id: UuidV7;
  method: "GET";
  url: string;
  headers: PortableDownloadHeader[];
  expected_size_bytes: number;
  content_sha256: ContentSha256;
  one_use: true;
  expires_at: Timestamp;
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
  protocol?: UploadProtocolPreference;
}

export interface CreateFileVersionRequest {
  expected_entry_revision: number;
  expected_size_bytes: number;
  content_sha256: ContentSha256;
  declared_media_type: string;
  browser_origin?: string | null;
  protocol?: UploadProtocolPreference;
}

export type UploadProtocolPreference = "auto" | "single_put" | "multipart";

export interface CreateMultipartPartGrantRequest {
  part_number: number;
  content_sha256: ContentSha256;
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
  part_size_bytes: number | null;
  part_count: number;
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

export interface CreateVerificationReceiptRequest {
  transfer_session_id: UuidV7;
  finalize_operation_id: UuidV7;
  entry_id: UuidV7;
  generation_id: UuidV7;
  refusal_environment_id: UuidV7;
  completion: FinalizeUploadRequest;
}

export type VerificationCheckName =
  | "finalization_idempotency"
  | "private_read_integrity"
  | "cross_scope_refusal"
  | "malware_safety";

export interface VerificationCheck {
  name: VerificationCheckName;
  result: "passed";
}

export interface VerificationReceipt {
  receipt_version: "almira.verification.v1";
  contract_version: "0.1.0-dev.55";
  verification_id: UuidV7;
  realm_id: UuidV7;
  tenant_id: UuidV7;
  project_id: UuidV7;
  environment_id: UuidV7;
  collection_instance_id: UuidV7;
  entry_id: UuidV7;
  generation_id: UuidV7;
  expected_size_bytes: number;
  content_sha256: ContentSha256;
  safety_state: "not_required" | "clean";
  checks: VerificationCheck[];
  signing_key_id: string;
}

export interface SignedVerificationReceipt {
  receipt: VerificationReceipt;
  algorithm: "ed25519";
  signature: string;
}

export interface VerificationPublicKey {
  key_id: string;
  algorithm: "ed25519";
  public_key: string;
}

export interface VerificationPublicKeySet {
  format_version: 1;
  keys: VerificationPublicKey[];
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
  metadata_revision: number;
  tags: string[];
  custom_metadata: Record<string, CustomMetadataValue>;
  current_generation_id: UuidV7 | null;
  current_generation: FileGeneration | null;
  deleted_at: Timestamp | null;
  recycle_until: Timestamp | null;
  latest_generation: FileGeneration;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export type CustomMetadataValue = boolean | number | string;

export interface CustomerMetadataInput {
  tags: string[];
  custom: Record<string, CustomMetadataValue>;
}

export interface EntryMetadata extends CustomerMetadataInput {
  entry_id: UuidV7;
  namespace: "customer";
  revision: number;
  updated_at: Timestamp;
}

export interface ReplaceEntryMetadataRequest {
  expected_revision: number;
  metadata: CustomerMetadataInput;
}

export interface MetadataMutationOutcome {
  disposition: "applied" | "exact_replay";
  metadata: EntryMetadata;
}

export type ExtractionKind = "technical" | "content" | "ocr" | "transcription";
export type ProtectedExtractionKind = Exclude<ExtractionKind, "technical">;
export type ExtractionState = "pending" | "running" | "succeeded" | "failed" | "unsupported";

export interface GenerationExtraction {
  entry_id: UuidV7;
  generation_id: UuidV7;
  kind: ExtractionKind;
  state: ExtractionState;
  source_content_sha256: ContentSha256;
  extractor_name: string;
  extractor_version: string;
  limits: {
    input_bytes: number;
    output_bytes: number;
    wall_time_seconds: number;
  };
  safe_result: Record<string, unknown>;
  failure_code: string | null;
  attempt_count: number;
  revision: number;
  updated_at: Timestamp;
}

export interface ExtractedContent {
  entry_id: UuidV7;
  generation_id: UuidV7;
  kind: ProtectedExtractionKind;
  source_content_sha256: ContentSha256;
  extractor_name: string;
  extractor_version: string;
  media_type: string;
  content: string;
  truncated: boolean;
  revision: number;
}

export interface FileEntryPage {
  entries: FileEntry[];
  next_cursor: string | null;
}

export interface FileMetadataFilter {
  tag?: string;
  metadata_key?: string;
  metadata_value?: CustomMetadataValue;
  verified_media_type?: string;
  minimum_size_bytes?: number;
  maximum_size_bytes?: number;
  created_after?: Timestamp;
  created_before?: Timestamp;
  extraction_kind?: ExtractionKind;
  extraction_state?: ExtractionState;
}

export type SearchMode = "lexical" | "semantic" | "hybrid";
export type SearchFacetField = "tags" | "verified_media_type" | `custom.${string}`;

export interface SearchInput {
  query: string;
  mode?: SearchMode;
  path_prefix?: string;
  filter?: FileMetadataFilter;
  facets?: SearchFacetField[];
  page_size?: number;
  cursor?: string;
}

export interface IndexedRevision {
  project: number;
  environment: number;
  entry: number;
  metadata: number;
  generation: number;
  extraction: number;
  collection: number;
}

export interface SearchHit {
  entry: FileEntry;
  indexed_revision: IndexedRevision;
  score: string | null;
}

export interface SearchFacetValue {
  value: CustomMetadataValue;
  count: number;
}

export interface SearchFacet {
  field: SearchFacetField;
  values: SearchFacetValue[];
}

export interface SearchPage {
  items: SearchHit[];
  facets: SearchFacet[];
  next_cursor: string | null;
  facet_coverage: "returned_page";
  consistency: "eventual_projection_authoritative_recheck";
}

export interface FileGenerationPage {
  generations: FileGeneration[];
  next_cursor: string | null;
}

export interface RenameFileRequest {
  logical_path: string;
  expected_revision: number;
}

export interface RestoreFileGenerationRequest {
  generation_id: UuidV7;
  expected_revision: number;
}

export interface RestoreFileRequest {
  expected_revision: number;
}

export interface FileMutationOutcome {
  disposition: "applied" | "exact_replay";
  entry: FileEntry;
}

export type FileBatchAction =
  | { action: "rename"; entry_id: UuidV7; logical_path: string; expected_revision: number }
  | { action: "select_generation"; entry_id: UuidV7; generation_id: UuidV7; expected_revision: number }
  | { action: "delete"; entry_id: UuidV7; expected_revision: number }
  | { action: "restore"; entry_id: UuidV7; expected_revision: number };

export interface FileBatchRequest {
  actions: FileBatchAction[];
}

export interface FileBatchOutcome {
  disposition: "applied" | "exact_replay";
  /** Entries are returned in the same order as the submitted actions. */
  entries: FileEntry[];
}

export interface CopyFileRequest {
  source_entry_id: UuidV7;
  source_generation_id: UuidV7;
  destination_path: string;
  expected_source_revision: number;
}

export interface FileCopyOutcome {
  disposition: "applied" | "exact_replay";
  entry: FileEntry;
}

export interface DeleteFileOutcome {
  disposition: "applied" | "exact_replay";
  entry: FileEntry;
}

export interface ProjectReference {
  tenantId: UuidV7;
  projectId: UuidV7;
}

export interface EnvironmentReference extends ProjectReference {
  environmentId: UuidV7;
}

export interface CollectionReference extends EnvironmentReference {
  collectionInstanceId: UuidV7;
}

export interface StorageMigrationReference extends CollectionReference {
  migrationId: UuidV7;
}

export interface StorageEnrollmentReference extends ProjectReference {
  operationId: UuidV7;
}

export interface PortabilityJobReference extends CollectionReference {
  jobId: UuidV7;
}

export interface PortabilityImportContentReference extends PortabilityJobReference {
  sourceObjectId: UuidV7;
}

export interface FileReference extends CollectionReference {
  entryId: UuidV7;
}

export interface ProcessingJobReference extends CollectionReference {
  jobId: UuidV7;
}

export interface GenerationReference extends FileReference {
  generationId: UuidV7;
}

export interface GenerationExtractionReference extends FileReference {
  generationId: UuidV7;
  kind: ExtractionKind;
}

export interface ExtractedContentReference extends FileReference {
  generationId: UuidV7;
  kind: ProtectedExtractionKind;
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

export interface FilePageOptions extends PageOptions {
  pathPrefix?: string;
  includeDeleted?: boolean;
  subject?: BuilderSubject;
  tag?: string;
  metadataKey?: string;
  metadataValue?: CustomMetadataValue;
  verifiedMediaType?: string;
  minimumSizeBytes?: number;
  maximumSizeBytes?: number;
  createdAfter?: Timestamp;
  createdBefore?: Timestamp;
  extractionKind?: ExtractionKind;
  extractionState?: ExtractionState;
}

export interface ReadPrivateFileOptions extends FileReference {
  generationId?: UuidV7;
  range?: string;
  subject?: BuilderSubject;
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

export type AccessOperation =
  | "list"
  | "metadata_read"
  | "content_read"
  | "search"
  | "upload"
  | "delete"
  | "share";

export type ReadAccessOperation = "list" | "metadata_read" | "content_read" | "search";

export interface BuilderSubject {
  subject_id: string;
  organization_id?: string | null | undefined;
  roles?: string[] | undefined;
  attributes?: Record<string, string> | undefined;
}

/** Opaque builder-owned lifecycle metadata, distinct from BuilderSubject authorization context. */
export interface SubjectReference {
  namespace: string;
  subject_id: string;
}

export interface SubjectBinding {
  binding_id: UuidV7;
  subject: SubjectReference;
  environment_id: UuidV7;
  collection_instance_id: UuidV7;
  entry_id: UuidV7;
  entry_lifecycle: "active" | "restricted" | "deleted";
  created_at: Timestamp;
}

export interface SubjectBindingOutcome {
  disposition: "applied" | "already_bound" | "exact_replay";
  binding: SubjectBinding;
}

export interface SubjectBindingPage {
  items: SubjectBinding[];
  next_cursor: string | null;
}

export type SubjectLifecycleKind = "restrict" | "export" | "delete";
export type SubjectLifecycleState = "complete" | "pending";
export type SubjectLifecycleItemDisposition =
  | "export_ready"
  | "restricted"
  | "already_restricted"
  | "already_deleted"
  | "deleted_pending_retention"
  | "shared_resource_restricted"
  | "export_pending_bundle"
  | "export_pending_restriction"
  | "export_pending_retention";

export interface SubjectLifecycleOperation {
  operation_id: UuidV7;
  kind: SubjectLifecycleKind;
  state: SubjectLifecycleState;
  subject: SubjectReference;
  matched_entries: number;
  completed_entries: number;
  pending_entries: number;
  manifest_digest: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface SubjectLifecycleOutcome {
  operation: SubjectLifecycleOperation;
}

export interface SubjectLifecycleItem {
  binding_id: UuidV7;
  environment_id: UuidV7;
  collection_instance_id: UuidV7;
  entry_id: UuidV7;
  entry_revision: number;
  disposition: SubjectLifecycleItemDisposition;
  content_path: string | null;
  recycle_until: Timestamp | null;
}

export interface SubjectLifecyclePage {
  operation: SubjectLifecycleOperation;
  items: SubjectLifecycleItem[];
  next_cursor: string | null;
}

export type AccessSubject =
  | { kind: "public" }
  | { kind: "server" }
  | { kind: "authenticated" }
  | { kind: "subject"; subject_id: string }
  | { kind: "organization"; organization_id: string }
  | { kind: "role"; role: string }
  | { kind: "attribute"; key: string; value: string };

export type AccessResource =
  | { kind: "collection" }
  | { kind: "prefix"; path_prefix: string }
  | { kind: "entry"; entry_id: UuidV7 };

export interface AccessRule {
  rule_id: string;
  effect: "allow" | "deny";
  subject: AccessSubject;
  operations: AccessOperation[];
  resource: AccessResource;
}

export interface AccessPolicyDocument {
  template: "server_only" | "private" | "public_read";
  rules: AccessRule[];
}

export interface AccessPolicy {
  collection_instance_id: UuidV7;
  revision: number;
  issuer_epoch: number;
  document: AccessPolicyDocument;
  updated_at: Timestamp;
}

export interface ReplaceAccessPolicyRequest {
  expected_revision: number;
  document: AccessPolicyDocument;
}

export interface AccessPolicyMutationOutcome {
  disposition: "applied" | "exact_replay";
  policy: AccessPolicy;
}

export type SimulationPrincipal =
  | { kind: "public" }
  | { kind: "server" }
  | { kind: "end_user"; subject: BuilderSubject };

export type SimulationTarget =
  | { kind: "collection" }
  | { kind: "entry"; entry_id: UuidV7; logical_path: string };

export interface AccessSimulation {
  principal: SimulationPrincipal;
  operation: AccessOperation;
  target: SimulationTarget;
}

export interface AccessDecision {
  allowed: boolean;
  reason: "allowed_by_rule" | "allowed_by_template" | "denied_by_rule" | "no_matching_allow";
  matched_rule_ids: string[];
  policy_revision: number;
}

export interface CreateCapabilitySessionRequest {
  subject: BuilderSubject;
  operations: ReadAccessOperation[];
  resource: AccessResource;
  audience: string;
  lifetime_seconds: number;
}

export interface CapabilitySessionGrant {
  session_id: UuidV7;
  token: string;
  operations: ReadAccessOperation[];
  resource: AccessResource;
  audience: string;
  policy_revision: number;
  issuer_epoch: number;
  expires_at: Timestamp;
}

export interface CapabilitySessionReference extends CollectionReference {
  sessionId: UuidV7;
}

export type DeliveryConfigInput =
  | { mode: "off"; cache_preset: "no_store"; logical_aliases: false; direct_provider_private_downloads: false; custom_hostname: string | null }
  | { mode: "public"; cache_preset: "revalidate"; logical_aliases: false; direct_provider_private_downloads: false; custom_hostname: string | null }
  | { mode: "private"; cache_preset: "no_store" | "private_session"; logical_aliases: false; direct_provider_private_downloads: false; custom_hostname: string | null };

export interface DeliveryDomain {
  kind: "managed" | "custom";
  hostname: string;
  state: "active" | "pending_dns" | "provisioning_certificate" | "failed" | "removing";
  routing_target: string | null;
  verification_name: string | null;
  verification_value: string | null;
  certificate_expires_at: Timestamp | null;
}

export interface DeliveryConfig {
  collection_instance_id: UuidV7;
  mode: "off" | "public" | "private";
  cache_preset: "no_store" | "revalidate" | "immutable_generation" | "private_session";
  logical_aliases: false;
  direct_provider_private_downloads: false;
  domain: DeliveryDomain;
  revision: number;
  updated_at: Timestamp;
}

interface DeliveryPurgeDiagnosticStatus {
  purge_id: UuidV7;
  state: "pending" | "completed" | "failed";
  attempt_count: number;
  last_error_code: "provider_refused" | "provider_response_invalid" | "provider_unavailable" | null;
  requested_at: Timestamp;
  updated_at: Timestamp;
  completed_at: Timestamp | null;
}

export type DeliveryPurgeDiagnostic = DeliveryPurgeDiagnosticStatus & (
  | { source: "project_lifecycle_changed"; target_kind: "project"; target_id: UuidV7 }
  | { source: "environment_lifecycle_changed"; target_kind: "environment"; target_id: UuidV7 }
  | {
      source:
        | "manual_requested"
        | "collection_lifecycle_changed"
        | "collection_policy_changed"
        | "delivery_configuration_changed";
      target_kind: "collection";
      target_id: UuidV7;
    }
  | {
      source: "entry_deleted" | "entry_restricted" | "entry_restored" | "generation_replaced";
      target_kind: "entry";
      target_id: UuidV7;
    }
  | {
      source: "generation_availability_changed" | "derivative_changed";
      target_kind: "generation";
      target_id: UuidV7;
    }
);

export interface DeliveryDiagnostics {
  recent_purges: DeliveryPurgeDiagnostic[];
  purge_history_truncated: boolean;
}

export interface DeliveryConfigDetails {
  config: DeliveryConfig;
  diagnostics: DeliveryDiagnostics;
}

export interface ReplaceDeliveryConfigRequest {
  expected_revision: number;
  config: DeliveryConfigInput;
}

export interface DeliveryConfigOutcome {
  disposition: "applied" | "exact_replay";
  config: DeliveryConfig;
}

export interface CreateShareRequest {
  entry_id: UuidV7;
  generation_id: UuidV7;
  lifetime_seconds: number;
  subject?: BuilderSubject | null | undefined;
}

export interface ShareGrant {
  share_id: UuidV7;
  url: string;
  entry_id: UuidV7;
  generation_id: UuidV7;
  state: "active" | "revoked" | "expired";
  policy_revision: number;
  issuer_epoch: number;
  expires_at: Timestamp;
}

export interface ShareReference extends CollectionReference {
  shareId: UuidV7;
}

export type TokenMutationDisposition = "applied" | "exact_replay";

export type IssuerKeyProtection = "cloud_kms" | "hardware_backed";

export interface LocalIssuerCeiling {
  operations: ReadAccessOperation[];
  resource: AccessResource;
  audiences: string[];
  maximum_lifetime_seconds: number;
}

export interface RegisterLocalIssuerRequest {
  issuer_key: string;
  display_name: string;
  public_key: string;
  key_protection: IssuerKeyProtection;
  ceiling: LocalIssuerCeiling;
}

export interface RotateLocalIssuerKeyRequest {
  expected_revision: number;
  public_key: string;
  key_protection: IssuerKeyProtection;
}

export interface LocalIssuer {
  issuer_id: UuidV7;
  issuer_key: string;
  display_name: string;
  public_key: string;
  key_protection: IssuerKeyProtection;
  ceiling: LocalIssuerCeiling;
  state: "active" | "revoked";
  revision: number;
  key_revision: number;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface LocalIssuerMutationOutcome {
  disposition: "applied" | "exact_replay";
  issuer: LocalIssuer;
}

export interface LocalIssuerReference extends CollectionReference {
  issuerId: UuidV7;
}

export interface LocalIssuerSigningConfiguration {
  claims_schema_version: 1;
  token_prefix: "alm_local_v1.";
  signature_context_base64url: "YWxtaXJhOmxvY2FsLWNhcGFiaWxpdHk6djEA";
  maximum_clock_skew_seconds: 30;
  realm_id: UuidV7;
  tenant_id: UuidV7;
  project_id: UuidV7;
  environment_id: UuidV7;
  collection_instance_id: UuidV7;
  issuer_id: UuidV7;
  issuer_revision: number;
  key_revision: number;
  public_key: string;
  ceiling: LocalIssuerCeiling;
  policy_revision: number;
  policy_issuer_epoch: number;
}

export interface SubjectReadOptions {
  subject?: BuilderSubject;
  signal?: AbortSignal;
}
