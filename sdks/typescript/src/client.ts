import { AlmiraApiError, AlmiraClientError } from "./errors.js";
import type {
  AccessDecision,
  AdoptCustomerStorageRequest,
  AccessPolicy,
  AccessPolicyMutationOutcome,
  AccessSimulation,
  BootstrapOutcome,
  BootstrapProjectRequest,
  BrowserOriginPolicy,
  BuilderSubject,
  CapabilitySessionGrant,
  CapabilitySessionReference,
  Collection,
  CollectionExtractionConfig,
  CollectionLifecycleOutcome,
  CollectionMediaConfig,
  CollectionProtectionConfig,
  CollectionPage,
  CollectionReference,
  CreateCollectionOutcome,
  CreateCollectionRequest,
  CreateMultipartPartGrantRequest,
  CreateProtectionReviewRequest,
  CreateCapabilitySessionRequest,
  CreateEnvironmentRequest,
  CreateFileVersionRequest,
  CreateUploadOutcome,
  CreateUploadRequest,
  CreateVerificationReceiptRequest,
  CreateShareRequest,
  DeleteFileOutcome,
  DirectUploadPart,
  DeliveryConfigDetails,
  DeliveryConfigOutcome,
  DeliveryPurgeDiagnostic,
  EnvironmentList,
  EnvironmentMutationOutcome,
  EnvironmentReference,
  EntryMetadata,
  ExtractedContent,
  ExtractedContentReference,
  ExtractionConfigOutcome,
  FileEntry,
  FileBatchOutcome,
  FileBatchRequest,
  CopyFileRequest,
  FileCopyOutcome,
  FileEntryPage,
  FileGeneration,
  FileGenerationPage,
  FileMutationOutcome,
  FilePageOptions,
  FileReference,
  FinalizeUploadRequest,
  GenerationExtraction,
  GenerationExtractionReference,
  GenerationReference,
  JobMutationOutcome,
  LocalIssuer,
  LocalIssuerMutationOutcome,
  LocalIssuerReference,
  LocalIssuerSigningConfiguration,
  MetadataMutationOutcome,
  MediaConfigOutcome,
  MediaDerivative,
  MutationOptions,
  MutateProcessingJobRequest,
  PageOptions,
  PortabilityJob,
  PortabilityJobOutcome,
  PortabilityJobPage,
  PortabilityJobPageOptions,
  PortabilityJobReference,
  PortableDownloadDescriptor,
  PrivateFileResponse,
  ProcessingJobPage,
  ProcessingJobReference,
  ProtectionCasePage,
  ProtectionCasePageOptions,
  ProtectionConfigOutcome,
  ProtectionReviewOutcome,
  ProtectionScanOutcome,
  ProjectReference,
  ReadPrivateFileOptions,
  RegisterLocalIssuerRequest,
  ReplaceAccessPolicyRequest,
  ReplaceBrowserOriginsOutcome,
  ReplaceBrowserOriginsRequest,
  ReplaceDeliveryConfigRequest,
  ReplaceCollectionExtractionRequest,
  ReplaceCollectionLifecycleRequest,
  ReplaceCollectionMediaRequest,
  ReplaceCollectionProtectionRequest,
  ReplaceEntryMetadataRequest,
  RenameFileRequest,
  RestoreManagedStorageRequest,
  RestoreFileGenerationRequest,
  RestoreFileRequest,
  RotateLocalIssuerKeyRequest,
  SearchInput,
  SearchPage,
  ShareGrant,
  ShareReference,
  StorageRealizationCatalog,
  StartStorageEnrollmentOutcome,
  StartStorageEnrollmentRequest,
  StartStorageMigrationOutcome,
  StartStorageMigrationRequest,
  StartCollectionExportRequest,
  StartCollectionImportRequest,
  StorageEnrollment,
  StorageEnrollmentList,
  StorageEnrollmentReference,
  StorageMigration,
  StorageMigrationReference,
  SignedVerificationReceipt,
  SubjectReadOptions,
  SubjectBindingOutcome,
  SubjectBindingPage,
  SubjectLifecycleKind,
  SubjectLifecycleOutcome,
  SubjectLifecyclePage,
  SubjectReference,
  TokenMutationDisposition,
  UpdateEnvironmentRequest,
  UuidV7,
  VerificationPublicKeySet,
} from "./types.js";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const API_ERROR = /^ALMIRA_[A-Z0-9_]{1,120}$/u;
const BYTE_RANGE = /^bytes=[0-9]+-[0-9]*$/u;
const LOGICAL_PATH = /^(?![.]{1,2}(?:\/|$))(?!.+\/[.]{1,2}(?:\/|$))[A-Za-z0-9._~-]{1,255}(?:\/[A-Za-z0-9._~-]{1,255})*$/u;
const MAXIMUM_JSON_RESPONSE_BYTES = 2 * 1024 * 1024;

type EvidenceProvider = () => string | Promise<string>;

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
  credential?: string | EvidenceProvider;
  workloadSession?: string | EvidenceProvider;
  productSelection?: string;
  fetch?: typeof globalThis.fetch;
}

interface JsonRequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
  method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
  signal?: AbortSignal | undefined;
}

export class AlmiraClient {
  readonly #baseUrl: string;
  readonly #authentication:
    | { readonly kind: "bearer" | "workload"; readonly provider: EvidenceProvider }
    | null;
  readonly #productSelection: string | null;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: AlmiraClientOptions = {}) {
    const baseUrl = options.baseUrl ?? "";
    if (
      /[?#\\\u0000-\u0020\u007f]/u.test(baseUrl) ||
      (baseUrl.length > 0 && !baseUrl.startsWith("/") && !/^https?:\/\//u.test(baseUrl))
    ) {
      throw new AlmiraClientError("ALMIRA_CLIENT_INPUT_INVALID");
    }
    this.#baseUrl = baseUrl === "/" ? "" : baseUrl.replace(/\/+$/u, "");
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (typeof this.#fetch !== "function") {
      throw new AlmiraClientError("ALMIRA_CLIENT_INPUT_INVALID");
    }
    if (options.credential !== undefined && options.workloadSession !== undefined) invalidInput();
    this.#authentication = options.credential !== undefined
      ? { kind: "bearer", provider: evidenceProvider(options.credential) }
      : options.workloadSession !== undefined
        ? { kind: "workload", provider: evidenceProvider(options.workloadSession) }
        : null;
    if (
      options.productSelection !== undefined &&
      (this.#authentication !== null || !validProductSelection(options.productSelection))
    ) invalidInput();
    this.#productSelection = options.productSelection ?? null;
  }

  async getVerificationPublicKeys(
    options: { signal?: AbortSignal } = {},
  ): Promise<VerificationPublicKeySet> {
    return this.#publicJson("/.well-known/almira-verification-keys.json", options.signal);
  }

  async bootstrapProject(
    reference: ProjectReference,
    request: BootstrapProjectRequest,
    options: MutationOptions,
  ): Promise<BootstrapOutcome> {
    return this.#json(projectPath(reference, "/bootstrap"), {
      method: "POST",
      headers: mutationHeaders(options.operationId),
      body: request,
      signal: options.signal,
    }, reference.tenantId);
  }

  async listEnvironments(
    reference: ProjectReference,
    options: { signal?: AbortSignal } = {},
  ): Promise<EnvironmentList> {
    return this.#json(projectPath(reference, "/environments"), {
      method: "GET",
      signal: options.signal,
    }, reference.tenantId);
  }

  async createEnvironment(
    reference: ProjectReference,
    request: CreateEnvironmentRequest,
    options: MutationOptions,
  ): Promise<EnvironmentMutationOutcome> {
    return this.#json(projectPath(reference, "/environments"), {
      method: "POST",
      headers: mutationHeaders(options.operationId),
      body: request,
      signal: options.signal,
    }, reference.tenantId);
  }

  async updateEnvironment(
    reference: EnvironmentReference,
    request: UpdateEnvironmentRequest,
    options: MutationOptions,
  ): Promise<EnvironmentMutationOutcome> {
    return this.#json(environmentPath(reference), {
      method: "PATCH",
      headers: mutationHeaders(options.operationId),
      body: request,
      signal: options.signal,
    }, reference.tenantId);
  }

  async deleteEnvironment(
    reference: EnvironmentReference,
    expectedRevision: number,
    options: MutationOptions,
  ): Promise<EnvironmentMutationOutcome> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) invalidInput();
    return this.#json(environmentPath(reference), {
      method: "DELETE",
      headers: {
        ...mutationHeaders(options.operationId),
        "if-match": String(expectedRevision),
      },
      signal: options.signal,
    }, reference.tenantId);
  }

  async getBrowserOrigins(
    reference: EnvironmentReference,
    options: { signal?: AbortSignal } = {},
  ): Promise<BrowserOriginPolicy> {
    return this.#json(environmentPath(reference, "/browser-origins"), {
      method: "GET",
      signal: options.signal,
    }, reference.tenantId);
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
    }, reference.tenantId);
  }

  async getStorageCapabilities(
    reference: EnvironmentReference,
    options: { signal?: AbortSignal } = {},
  ): Promise<StorageRealizationCatalog> {
    return this.#json(environmentPath(reference, "/storage-capabilities"), {
      method: "GET",
      signal: options.signal,
    }, reference.tenantId);
  }

  async adoptCustomerStorage(
    reference: EnvironmentReference,
    request: AdoptCustomerStorageRequest,
    options: MutationOptions,
  ): Promise<EnvironmentMutationOutcome> {
    return this.#json(environmentPath(reference, "/storage-binding"), {
      method: "PUT",
      headers: mutationHeaders(options.operationId),
      body: request,
      signal: options.signal,
    }, reference.tenantId);
  }

  async restoreManagedStorage(
    reference: EnvironmentReference,
    request: RestoreManagedStorageRequest,
    options: MutationOptions,
  ): Promise<EnvironmentMutationOutcome> {
    return this.#json(environmentPath(reference, "/managed-storage-binding"), {
      method: "PUT",
      headers: mutationHeaders(options.operationId),
      body: request,
      signal: options.signal,
    }, reference.tenantId);
  }

  async listCollections(
    reference: EnvironmentReference,
    options: PageOptions = {},
  ): Promise<CollectionPage> {
    return this.#json(withPage(environmentPath(reference, "/collections"), options), {
      method: "GET",
      signal: options.signal,
    }, reference.tenantId);
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
    }, reference.tenantId);
  }

  async getCollection(
    reference: CollectionReference,
    options: { signal?: AbortSignal } = {},
  ): Promise<Collection> {
    return this.#json(collectionPath(reference), { method: "GET", signal: options.signal }, reference.tenantId);
  }

  async replaceCollectionLifecycle(
    reference: CollectionReference,
    request: ReplaceCollectionLifecycleRequest,
    options: MutationOptions,
  ): Promise<CollectionLifecycleOutcome> {
    return this.#json(collectionPath(reference, "/lifecycle"), {
      method: "PUT",
      headers: mutationHeaders(options.operationId),
      body: request,
      signal: options.signal,
    }, reference.tenantId);
  }

  async getCollectionExtraction(
    reference: CollectionReference,
    options: { signal?: AbortSignal } = {},
  ): Promise<CollectionExtractionConfig> {
    return this.#json(collectionPath(reference, "/extraction"), {
      method: "GET",
      signal: options.signal,
    }, reference.tenantId);
  }

  async replaceCollectionExtraction(
    reference: CollectionReference,
    request: ReplaceCollectionExtractionRequest,
    options: MutationOptions,
  ): Promise<ExtractionConfigOutcome> {
    return this.#json(collectionPath(reference, "/extraction"), {
      method: "PUT",
      headers: mutationHeaders(options.operationId),
      body: request,
      signal: options.signal,
    }, reference.tenantId);
  }

  async getCollectionMedia(
    reference: CollectionReference,
    options: { signal?: AbortSignal } = {},
  ): Promise<CollectionMediaConfig> {
    return this.#json(collectionPath(reference, "/media"), {
      method: "GET",
      signal: options.signal,
    }, reference.tenantId);
  }

  async replaceCollectionMedia(
    reference: CollectionReference,
    request: ReplaceCollectionMediaRequest,
    options: MutationOptions,
  ): Promise<MediaConfigOutcome> {
    return this.#json(collectionPath(reference, "/media"), {
      method: "PUT",
      headers: mutationHeaders(options.operationId),
      body: request,
      signal: options.signal,
    }, reference.tenantId);
  }

  async getCollectionProtection(
    reference: CollectionReference,
    options: { signal?: AbortSignal } = {},
  ): Promise<CollectionProtectionConfig> {
    return this.#json(collectionPath(reference, "/protection"), {
      method: "GET",
      signal: options.signal,
    }, reference.tenantId);
  }

  async replaceCollectionProtection(
    reference: CollectionReference,
    request: ReplaceCollectionProtectionRequest,
    options: MutationOptions,
  ): Promise<ProtectionConfigOutcome> {
    return this.#json(collectionPath(reference, "/protection"), {
      method: "PUT",
      headers: mutationHeaders(options.operationId),
      body: request,
      signal: options.signal,
    }, reference.tenantId);
  }

  async listProtectionCases(
    reference: EnvironmentReference,
    options: ProtectionCasePageOptions = {},
  ): Promise<ProtectionCasePage> {
    const query = new URLSearchParams();
    appendPage(query, options);
    if (options.collectionInstanceId !== undefined) {
      query.set("collection_instance_id", uuid(options.collectionInstanceId));
    }
    if (options.safetyState !== undefined) {
      if (!["scan_pending", "clean", "blocked"].includes(options.safetyState)) invalidInput();
      query.set("safety_state", options.safetyState);
    }
    return this.#json(withQuery(environmentPath(reference, "/protection/cases"), query), {
      method: "GET",
      signal: options.signal,
    }, reference.tenantId);
  }

  async requestProtectionRescan(
    reference: GenerationReference,
    request: { expected_revision: number },
    options: MutationOptions,
  ): Promise<ProtectionScanOutcome> {
    return this.#json(
      filePath(reference, `/versions/${uuid(reference.generationId)}/protection-rescans`),
      {
        method: "POST",
        headers: mutationHeaders(options.operationId),
        body: request,
        signal: options.signal,
      },
      reference.tenantId,
    );
  }

  async createProtectionReview(
    reference: GenerationReference,
    request: CreateProtectionReviewRequest,
    options: MutationOptions,
  ): Promise<ProtectionReviewOutcome> {
    return this.#json(
      filePath(reference, `/versions/${uuid(reference.generationId)}/protection-reviews`),
      {
        method: "POST",
        headers: mutationHeaders(options.operationId),
        body: request,
        signal: options.signal,
      },
      reference.tenantId,
    );
  }

  async listProcessingJobs(
    reference: CollectionReference,
    options: PageOptions = {},
  ): Promise<ProcessingJobPage> {
    return this.#json(withPage(collectionPath(reference, "/processing-jobs"), options), {
      method: "GET",
      signal: options.signal,
    }, reference.tenantId);
  }

  async retryProcessingJob(
    reference: ProcessingJobReference,
    request: MutateProcessingJobRequest,
    options: MutationOptions,
  ): Promise<JobMutationOutcome> {
    return this.#json(collectionPath(reference, `/processing-jobs/${uuid(reference.jobId)}/retry`), {
      method: "POST",
      headers: mutationHeaders(options.operationId),
      body: request,
      signal: options.signal,
    }, reference.tenantId);
  }

  async cancelProcessingJob(
    reference: ProcessingJobReference,
    request: MutateProcessingJobRequest,
    options: MutationOptions,
  ): Promise<JobMutationOutcome> {
    return this.#json(collectionPath(reference, `/processing-jobs/${uuid(reference.jobId)}/cancel`), {
      method: "POST",
      headers: mutationHeaders(options.operationId),
      body: request,
      signal: options.signal,
    }, reference.tenantId);
  }

  async startStorageMigration(
    reference: CollectionReference,
    request: StartStorageMigrationRequest,
    options: MutationOptions,
  ): Promise<StartStorageMigrationOutcome> {
    return this.#json(collectionPath(reference, "/storage-migrations"), {
      method: "POST",
      headers: mutationHeaders(options.operationId),
      body: request,
      signal: options.signal,
    }, reference.tenantId);
  }

  async listStorageEnrollments(
    reference: ProjectReference,
    options: { signal?: AbortSignal } = {},
  ): Promise<StorageEnrollmentList> {
    return this.#json(projectPath(reference, "/storage-enrollments"), {
      method: "GET",
      signal: options.signal,
    }, reference.tenantId);
  }

  async createStorageEnrollment(
    reference: ProjectReference,
    request: StartStorageEnrollmentRequest,
    options: MutationOptions,
  ): Promise<StartStorageEnrollmentOutcome> {
    return this.#json(projectPath(reference, "/storage-enrollments"), {
      method: "POST",
      headers: mutationHeaders(options.operationId),
      body: request,
      signal: options.signal,
    }, reference.tenantId);
  }

  async getStorageEnrollment(
    reference: StorageEnrollmentReference,
    options: { signal?: AbortSignal } = {},
  ): Promise<StorageEnrollment> {
    return this.#json(
      projectPath(reference, `/storage-enrollments/${uuid(reference.operationId)}`),
      { method: "GET", signal: options.signal },
      reference.tenantId,
    );
  }

  async getStorageMigration(
    reference: StorageMigrationReference,
    options: { signal?: AbortSignal } = {},
  ): Promise<StorageMigration> {
    return this.#json(
      collectionPath(reference, `/storage-migrations/${uuid(reference.migrationId)}`),
      { method: "GET", signal: options.signal },
      reference.tenantId,
    );
  }

  async startCollectionImport(
    reference: CollectionReference,
    request: StartCollectionImportRequest,
    options: MutationOptions,
  ): Promise<PortabilityJobOutcome> {
    return this.#json(collectionPath(reference, "/imports"), {
      method: "POST",
      headers: mutationHeaders(options.operationId),
      body: request,
      signal: options.signal,
    }, reference.tenantId);
  }

  async startCollectionExport(
    reference: CollectionReference,
    request: StartCollectionExportRequest,
    options: MutationOptions,
  ): Promise<PortabilityJobOutcome> {
    return this.#json(collectionPath(reference, "/exports"), {
      method: "POST",
      headers: mutationHeaders(options.operationId),
      body: request,
      signal: options.signal,
    }, reference.tenantId);
  }

  async listPortabilityJobs(
    reference: CollectionReference,
    options: PortabilityJobPageOptions = {},
  ): Promise<PortabilityJobPage> {
    const query = new URLSearchParams();
    appendPage(query, options);
    if (options.kind !== undefined) query.set("kind", options.kind);
    return this.#json(withQuery(collectionPath(reference, "/portability-jobs"), query), {
      method: "GET",
      signal: options.signal,
    }, reference.tenantId);
  }

  async getPortabilityJob(
    reference: PortabilityJobReference,
    options: { signal?: AbortSignal } = {},
  ): Promise<PortabilityJob> {
    return this.#json(
      collectionPath(reference, `/portability-jobs/${uuid(reference.jobId)}`),
      { method: "GET", signal: options.signal },
      reference.tenantId,
    );
  }

  async createPortabilityExportDownload(
    reference: PortabilityJobReference,
    options: MutationOptions,
  ): Promise<PortableDownloadDescriptor> {
    return this.#json(
      collectionPath(reference, `/portability-jobs/${uuid(reference.jobId)}/download`),
      {
        method: "POST",
        headers: mutationHeaders(options.operationId),
        signal: options.signal,
      },
      reference.tenantId,
    );
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
    }, reference.tenantId);
  }

  async createUploadPart(
    reference: CollectionReference & { transferSessionId: UuidV7 },
    request: CreateMultipartPartGrantRequest,
    options: MutationOptions,
  ): Promise<DirectUploadPart> {
    if (
      !Number.isSafeInteger(request.part_number) ||
      request.part_number < 1 ||
      request.part_number > 10_000 ||
      !/^sha256:[0-9a-f]{64}$/u.test(request.content_sha256)
    ) invalidInput();
    return this.#json(
      collectionPath(reference, `/uploads/${uuid(reference.transferSessionId)}/parts`),
      {
        method: "POST",
        headers: mutationHeaders(options.operationId),
        body: request,
        signal: options.signal,
      },
      reference.tenantId,
    );
  }

  async bindSubject(
    reference: FileReference,
    subject: SubjectReference,
    options: MutationOptions,
  ): Promise<SubjectBindingOutcome> {
    validateSubjectReference(subject);
    return this.#json(filePath(reference, "/subject-bindings"), {
      method: "POST",
      headers: mutationHeaders(options.operationId),
      body: subject,
      signal: options.signal,
    }, reference.tenantId);
  }

  async listSubjectBindings(
    reference: ProjectReference,
    subject: SubjectReference,
    options: PageOptions = {},
  ): Promise<SubjectBindingPage> {
    validateSubjectReference(subject);
    const limit = options.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) invalidInput();
    if (options.cursor !== undefined && (options.cursor.length === 0 || options.cursor.length > 2048)) {
      invalidInput();
    }
    return this.#json(projectPath(reference, "/subject-bindings/search"), {
      method: "POST",
      body: {
        subject,
        limit,
        ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      },
      signal: options.signal,
    }, reference.tenantId);
  }

  async startSubjectLifecycleOperation(
    reference: ProjectReference,
    subject: SubjectReference,
    kind: SubjectLifecycleKind,
    options: MutationOptions,
  ): Promise<SubjectLifecycleOutcome> {
    validateSubjectReference(subject);
    if (!(["restrict", "export", "delete"] as const).includes(kind)) invalidInput();
    return this.#json(projectPath(reference, "/subject-lifecycle-operations"), {
      method: "POST",
      headers: mutationHeaders(options.operationId),
      body: { subject, kind },
      signal: options.signal,
    }, reference.tenantId);
  }

  async readSubjectLifecycleOperation(
    reference: ProjectReference,
    lifecycleOperationId: UuidV7,
    options: PageOptions = {},
  ): Promise<SubjectLifecyclePage> {
    const limit = options.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) invalidInput();
    if (options.cursor !== undefined && (options.cursor.length === 0 || options.cursor.length > 2048)) {
      invalidInput();
    }
    return this.#json(projectPath(reference, "/subject-lifecycle-operations/search"), {
      method: "POST",
      body: {
        operation_id: uuid(lifecycleOperationId),
        limit,
        ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      },
      signal: options.signal,
    }, reference.tenantId);
  }

  async finalizeUpload(
    reference: CollectionReference & { transferSessionId: UuidV7 },
    request: FinalizeUploadRequest,
    options: MutationOptions,
  ): Promise<FileGeneration> {
    return this.#json(
      collectionPath(reference, `/uploads/${uuid(reference.transferSessionId)}/finalize`),
      {
        method: "POST",
        headers: mutationHeaders(options.operationId),
        body: request,
        signal: options.signal,
      },
      reference.tenantId,
    );
  }

  async createVerificationReceipt(
    reference: CollectionReference,
    request: CreateVerificationReceiptRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<SignedVerificationReceipt> {
    return this.#json(collectionPath(reference, "/verifications"), {
      method: "POST",
      body: request,
      signal: options.signal,
    }, reference.tenantId);
  }

  async listFiles(
    reference: CollectionReference,
    options: FilePageOptions = {},
  ): Promise<FileEntryPage> {
    const query = new URLSearchParams();
    appendPage(query, options);
    if (options.pathPrefix !== undefined) query.set("path_prefix", options.pathPrefix);
    if (options.includeDeleted === true) {
      if (options.subject !== undefined) invalidInput();
      query.set("include_deleted", "true");
    }
    if (options.tag !== undefined) query.set("tag", options.tag);
    if ((options.metadataKey === undefined) !== (options.metadataValue === undefined)) invalidInput();
    if (options.metadataKey !== undefined && options.metadataValue !== undefined) {
      query.set("metadata_key", options.metadataKey);
      query.set("metadata_value", JSON.stringify(options.metadataValue));
    }
    if (options.verifiedMediaType !== undefined) query.set("verified_media_type", options.verifiedMediaType);
    appendPositiveInteger(query, "minimum_size_bytes", options.minimumSizeBytes, 10_737_418_240);
    appendPositiveInteger(query, "maximum_size_bytes", options.maximumSizeBytes, 10_737_418_240);
    if (
      options.minimumSizeBytes !== undefined &&
      options.maximumSizeBytes !== undefined &&
      options.minimumSizeBytes > options.maximumSizeBytes
    ) invalidInput();
    if (options.createdAfter !== undefined) query.set("created_after", timestamp(options.createdAfter));
    if (options.createdBefore !== undefined) query.set("created_before", timestamp(options.createdBefore));
    if ((options.extractionKind === undefined) !== (options.extractionState === undefined)) invalidInput();
    if (options.extractionKind !== undefined && options.extractionState !== undefined) {
      query.set("extraction_kind", options.extractionKind);
      query.set("extraction_state", options.extractionState);
    }
    const subject = subjectHeaders(options.subject);
    return this.#json(withQuery(collectionPath(reference, "/files"), query), {
      method: "GET",
      ...(subject === undefined ? {} : { headers: subject }),
      signal: options.signal,
    }, reference.tenantId);
  }

  async searchFiles(
    reference: CollectionReference,
    input: SearchInput,
    options: SubjectReadOptions = {},
  ): Promise<SearchPage> {
    validateSearchInput(input);
    const subject = subjectHeaders(options.subject);
    return this.#json(collectionPath(reference, "/search"), {
      method: "POST",
      ...(subject === undefined ? {} : { headers: subject }),
      body: input,
      signal: options.signal,
    }, reference.tenantId);
  }

  async createFileVersion(
    reference: FileReference,
    request: CreateFileVersionRequest,
    options: MutationOptions,
  ): Promise<CreateUploadOutcome> {
    return this.#json(filePath(reference, "/versions"), {
      method: "POST",
      headers: mutationHeaders(options.operationId),
      body: request,
      signal: options.signal,
    }, reference.tenantId);
  }

  async mutateFilesBatch(
    reference: CollectionReference,
    request: FileBatchRequest,
    options: MutationOptions,
  ): Promise<FileBatchOutcome> {
    if (!Array.isArray(request.actions) || request.actions.length < 1 || request.actions.length > 100) {
      invalidInput();
    }
    const entries = new Set<string>();
    for (const action of request.actions) {
      uuid(action.entry_id);
      if (!Number.isSafeInteger(action.expected_revision) || action.expected_revision < 1) invalidInput();
      if (entries.has(action.entry_id)) invalidInput();
      entries.add(action.entry_id);
      if (action.action === "select_generation") uuid(action.generation_id);
      else if (action.action === "rename") {
        if (!LOGICAL_PATH.test(action.logical_path)) invalidInput();
      } else if (action.action !== "delete" && action.action !== "restore") invalidInput();
    }
    return this.#json(collectionPath(reference, "/file-batches"), {
      method: "POST",
      headers: mutationHeaders(options.operationId),
      body: request,
      signal: options.signal,
    }, reference.tenantId);
  }

  async copyFile(
    reference: CollectionReference,
    request: CopyFileRequest,
    options: MutationOptions,
  ): Promise<FileCopyOutcome> {
    uuid(request.source_entry_id);
    uuid(request.source_generation_id);
    if (!LOGICAL_PATH.test(request.destination_path)
      || !Number.isSafeInteger(request.expected_source_revision)
      || request.expected_source_revision < 1) {
      invalidInput();
    }
    return this.#json(collectionPath(reference, "/copies"), {
      method: "POST",
      headers: mutationHeaders(options.operationId),
      body: request,
      signal: options.signal,
    }, reference.tenantId);
  }

  async listFileGenerations(
    reference: FileReference,
    options: PageOptions = {},
  ): Promise<FileGenerationPage> {
    const query = new URLSearchParams();
    appendPage(query, options);
    return this.#json(withQuery(filePath(reference, "/versions"), query), {
      method: "GET",
      signal: options.signal,
    }, reference.tenantId);
  }

  async getFileMetadata(
    reference: FileReference,
    options: SubjectReadOptions = {},
  ): Promise<FileEntry> {
    const subject = subjectHeaders(options.subject);
    return this.#json(filePath(reference), {
      method: "GET",
      ...(subject === undefined ? {} : { headers: subject }),
      signal: options.signal,
    }, reference.tenantId);
  }

  async getEntryMetadata(
    reference: FileReference,
    options: { signal?: AbortSignal } = {},
  ): Promise<EntryMetadata> {
    return this.#json(filePath(reference, "/metadata"), {
      method: "GET",
      signal: options.signal,
    }, reference.tenantId);
  }

  async replaceEntryMetadata(
    reference: FileReference,
    request: ReplaceEntryMetadataRequest,
    options: MutationOptions,
  ): Promise<MetadataMutationOutcome> {
    return this.#json(filePath(reference, "/metadata"), {
      method: "PUT",
      headers: mutationHeaders(options.operationId),
      body: request,
      signal: options.signal,
    }, reference.tenantId);
  }

  async getGenerationExtraction(
    reference: GenerationExtractionReference,
    options: { signal?: AbortSignal } = {},
  ): Promise<GenerationExtraction> {
    return this.#json(
      filePath(reference, `/versions/${uuid(reference.generationId)}/extractions/${reference.kind}`),
      { method: "GET", signal: options.signal },
      reference.tenantId,
    );
  }

  async listGenerationDerivatives(
    reference: GenerationReference,
    options: { signal?: AbortSignal } = {},
  ): Promise<MediaDerivative[]> {
    return this.#json(
      filePath(reference, `/versions/${uuid(reference.generationId)}/derivatives`),
      { method: "GET", signal: options.signal },
      reference.tenantId,
    );
  }

  async getExtractedContent(
    reference: ExtractedContentReference,
    options: { signal?: AbortSignal } = {},
  ): Promise<ExtractedContent> {
    return this.#json(
      filePath(reference, `/versions/${uuid(reference.generationId)}/extracted-content/${reference.kind}`),
      { method: "GET", signal: options.signal },
      reference.tenantId,
    );
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
    }, reference.tenantId);
  }

  async renameFile(
    reference: FileReference,
    request: RenameFileRequest,
    options: MutationOptions,
  ): Promise<FileMutationOutcome> {
    return this.#json(filePath(reference), {
      method: "PATCH",
      headers: mutationHeaders(options.operationId),
      body: request,
      signal: options.signal,
    }, reference.tenantId);
  }

  async restoreFileGeneration(
    reference: FileReference,
    request: RestoreFileGenerationRequest,
    options: MutationOptions,
  ): Promise<FileMutationOutcome> {
    return this.#json(filePath(reference, "/current-generation"), {
      method: "PUT",
      headers: mutationHeaders(options.operationId),
      body: request,
      signal: options.signal,
    }, reference.tenantId);
  }

  async restoreFile(
    reference: FileReference,
    request: RestoreFileRequest,
    options: MutationOptions,
  ): Promise<FileMutationOutcome> {
    return this.#json(filePath(reference, "/restore"), {
      method: "POST",
      headers: mutationHeaders(options.operationId),
      body: request,
      signal: options.signal,
    }, reference.tenantId);
  }

  async readPrivateFile(options: ReadPrivateFileOptions): Promise<PrivateFileResponse> {
    const query = new URLSearchParams();
    if (options.generationId !== undefined) query.set("generation_id", uuid(options.generationId));
    const headers: Record<string, string> = { accept: "application/octet-stream" };
    Object.assign(headers, subjectHeaders(options.subject));
    if (options.range !== undefined) {
      if (options.range.length > 64 || !BYTE_RANGE.test(options.range)) invalidInput();
      headers.range = options.range;
    }
    const response = await this.#request(withQuery(filePath(options, "/content"), query), {
      method: "GET",
      headers,
      signal: options.signal,
    }, options.tenantId);
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

  async getCollectionPolicy(
    reference: CollectionReference,
    options: { signal?: AbortSignal } = {},
  ): Promise<AccessPolicy> {
    return this.#json(collectionPath(reference, "/policy"), {
      method: "GET",
      signal: options.signal,
    }, reference.tenantId);
  }

  async replaceCollectionPolicy(
    reference: CollectionReference,
    request: ReplaceAccessPolicyRequest,
    options: MutationOptions,
  ): Promise<AccessPolicyMutationOutcome> {
    return this.#json(collectionPath(reference, "/policy"), {
      method: "PUT",
      headers: mutationHeaders(options.operationId),
      body: request,
      signal: options.signal,
    }, reference.tenantId);
  }

  async simulateCollectionPolicy(
    reference: CollectionReference,
    request: AccessSimulation,
    options: MutationOptions,
  ): Promise<AccessDecision> {
    return this.#json(collectionPath(reference, "/policy/simulations"), {
      method: "POST",
      headers: mutationHeaders(options.operationId),
      body: request,
      signal: options.signal,
    }, reference.tenantId);
  }

  async getDeliveryConfig(
    reference: CollectionReference,
    options: { signal?: AbortSignal } = {},
  ): Promise<DeliveryConfigDetails> {
    return this.#json(collectionPath(reference, "/delivery"), {
      method: "GET",
      signal: options.signal,
    }, reference.tenantId);
  }

  async replaceDeliveryConfig(
    reference: CollectionReference,
    request: ReplaceDeliveryConfigRequest,
    options: MutationOptions,
  ): Promise<DeliveryConfigOutcome> {
    return this.#json(collectionPath(reference, "/delivery"), {
      method: "PUT",
      headers: mutationHeaders(options.operationId),
      body: request,
      signal: options.signal,
    }, reference.tenantId);
  }

  async createDeliveryPurge(
    reference: CollectionReference,
    options: MutationOptions,
  ): Promise<DeliveryPurgeDiagnostic> {
    return this.#json(collectionPath(reference, "/delivery"), {
      method: "POST",
      headers: mutationHeaders(options.operationId),
      signal: options.signal,
    }, reference.tenantId);
  }

  async createCapabilitySession(
    reference: CollectionReference,
    request: CreateCapabilitySessionRequest,
    options: MutationOptions,
  ): Promise<CapabilitySessionGrant> {
    return this.#json(collectionPath(reference, "/capability-sessions"), {
      method: "POST",
      headers: mutationHeaders(options.operationId),
      body: request,
      signal: options.signal,
    }, reference.tenantId);
  }

  async revokeCapabilitySession(
    reference: CapabilitySessionReference,
    options: MutationOptions,
  ): Promise<TokenMutationDisposition> {
    return this.#json(collectionPath(reference, `/capability-sessions/${uuid(reference.sessionId)}`), {
      method: "DELETE",
      headers: mutationHeaders(options.operationId),
      signal: options.signal,
    }, reference.tenantId);
  }

  async createShare(
    reference: CollectionReference,
    request: CreateShareRequest,
    options: MutationOptions,
  ): Promise<ShareGrant> {
    return this.#json(collectionPath(reference, "/shares"), {
      method: "POST",
      headers: mutationHeaders(options.operationId),
      body: request,
      signal: options.signal,
    }, reference.tenantId);
  }

  async revokeShare(
    reference: ShareReference,
    options: MutationOptions,
  ): Promise<TokenMutationDisposition> {
    return this.#json(collectionPath(reference, `/shares/${uuid(reference.shareId)}`), {
      method: "DELETE",
      headers: mutationHeaders(options.operationId),
      signal: options.signal,
    }, reference.tenantId);
  }

  async listLocalIssuers(
    reference: CollectionReference,
    options: { signal?: AbortSignal } = {},
  ): Promise<LocalIssuer[]> {
    return this.#json(collectionPath(reference, "/local-issuers"), {
      method: "GET",
      signal: options.signal,
    }, reference.tenantId);
  }

  async registerLocalIssuer(
    reference: CollectionReference,
    request: RegisterLocalIssuerRequest,
    options: MutationOptions,
  ): Promise<LocalIssuerMutationOutcome> {
    return this.#json(collectionPath(reference, "/local-issuers"), {
      method: "POST",
      headers: mutationHeaders(options.operationId),
      body: request,
      signal: options.signal,
    }, reference.tenantId);
  }

  async rotateLocalIssuerKey(
    reference: LocalIssuerReference,
    request: RotateLocalIssuerKeyRequest,
    options: MutationOptions,
  ): Promise<LocalIssuerMutationOutcome> {
    return this.#json(collectionPath(reference, `/local-issuers/${uuid(reference.issuerId)}/key`), {
      method: "PUT",
      headers: mutationHeaders(options.operationId),
      body: request,
      signal: options.signal,
    }, reference.tenantId);
  }

  async revokeLocalIssuer(
    reference: LocalIssuerReference,
    expectedRevision: number,
    options: MutationOptions,
  ): Promise<LocalIssuerMutationOutcome> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) invalidInput();
    return this.#json(collectionPath(reference, `/local-issuers/${uuid(reference.issuerId)}`), {
      method: "DELETE",
      headers: {
        ...mutationHeaders(options.operationId),
        "if-match": String(expectedRevision),
      },
      signal: options.signal,
    }, reference.tenantId);
  }

  async getLocalIssuerSigningConfiguration(
    reference: LocalIssuerReference,
    options: { signal?: AbortSignal } = {},
  ): Promise<LocalIssuerSigningConfiguration> {
    return this.#json(
      collectionPath(reference, `/local-issuers/${uuid(reference.issuerId)}/signing-configuration`),
      { method: "GET", signal: options.signal },
      reference.tenantId,
    );
  }

  async #json<T>(path: string, options: JsonRequestOptions, tenantId: UuidV7): Promise<T> {
    const response = await this.#request(path, options, tenantId);
    return this.#decodeJson(response);
  }

  async #publicJson<T>(path: string, signal?: AbortSignal): Promise<T> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method: "GET",
        headers: { accept: "application/json" },
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
    return this.#decodeJson(response);
  }

  async #decodeJson<T>(response: Response): Promise<T> {
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

  async #request(path: string, options: JsonRequestOptions, tenantId: UuidV7): Promise<Response> {
    const headers = new Headers(options.headers);
    if (!headers.has("accept")) headers.set("accept", "application/json");
    headers.set("x-almira-tenant-id", uuid(tenantId));
    let body: string | undefined;
    if (options.body !== undefined) {
      headers.set("content-type", "application/json");
      try {
        body = JSON.stringify(options.body);
      } catch {
        invalidInput();
      }
    }
    if (this.#authentication !== null) {
      let evidence: string;
      try {
        evidence = await this.#authentication.provider();
      } catch {
        throw new AlmiraClientError("ALMIRA_CLIENT_CREDENTIAL_UNAVAILABLE");
      }
      if (this.#authentication.kind === "bearer") {
        if (!validCredential(evidence)) invalidInput();
        headers.set("authorization", `Bearer ${evidence}`);
      } else {
        if (!validWorkloadSession(evidence)) invalidInput();
        headers.set("authorization", `MetamorphWorkload ${evidence}`);
      }
    }
    if (this.#productSelection !== null) {
      headers.set("x-metamorph-product-selection", this.#productSelection);
    }
    try {
      return await this.#fetch(`${this.#baseUrl}${path}`, {
        method: options.method,
        headers,
        ...(body === undefined ? {} : { body }),
        credentials: this.#authentication === null ? "include" : "omit",
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

function evidenceProvider(evidence: string | EvidenceProvider): EvidenceProvider {
  return typeof evidence === "function" ? evidence : () => evidence;
}

function validCredential(value: string): boolean {
  return /^(?:mm_pat_v1|mm_sak_v1)\.[!-~]{1,8176}$/u.test(value);
}

function validWorkloadSession(value: string): boolean {
  return value.length >= 2 && value.length <= 48 * 1024 && /^[A-Za-z0-9_-]+$/u.test(value);
}

function validProductSelection(value: string): boolean {
  return value.length >= 16 && value.length <= 512 && /^[A-Za-z0-9._~-]+$/u.test(value);
}

function mutationHeaders(operationId: UuidV7): Record<string, string> {
  return { "idempotency-key": uuid(operationId) };
}

function subjectHeaders(subject: BuilderSubject | undefined): Record<string, string> | undefined {
  if (subject === undefined) return undefined;
  let encoded: string;
  try {
    const canonical = JSON.stringify(canonicalJson(subject));
    const bytes = new TextEncoder().encode(canonical);
    if (bytes.length === 0 || bytes.length > 4 * 1024) invalidInput();
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    encoded = globalThis.btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  } catch (error) {
    if (error instanceof AlmiraClientError) throw error;
    return invalidInput();
  }
  return { "x-almira-subject-context": encoded };
}

function validateSubjectReference(subject: SubjectReference): void {
  if (
    typeof subject !== "object" ||
    subject === null ||
    !/^[a-z][a-z0-9._:-]{0,127}$/u.test(subject.namespace) ||
    typeof subject.subject_id !== "string" ||
    new TextEncoder().encode(subject.subject_id).length < 1 ||
    new TextEncoder().encode(subject.subject_id).length > 255 ||
    subject.subject_id.trim() !== subject.subject_id ||
    /[\u0000-\u001f\u007f]/u.test(subject.subject_id)
  ) invalidInput();
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => [key, canonicalJson(child)]),
  );
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

function appendPositiveInteger(
  query: URLSearchParams,
  name: string,
  value: number | undefined,
  maximum: number,
): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) invalidInput();
  query.set(name, String(value));
}

function timestamp(value: string): string {
  if (value.length > 64 || Number.isNaN(Date.parse(value))) invalidInput();
  return value;
}

export function validateSearchInput(input: SearchInput): void {
  if (
    typeof input.query !== "string" ||
    input.query.length === 0 ||
    new TextEncoder().encode(input.query).length > 1024 ||
    input.query !== input.query.trim() ||
    /[\u0000-\u001f\u007f]/u.test(input.query) ||
    (input.mode !== undefined && !["lexical", "semantic", "hybrid"].includes(input.mode)) ||
    (input.page_size !== undefined &&
      (!Number.isSafeInteger(input.page_size) || input.page_size < 1 || input.page_size > 50)) ||
    (input.cursor !== undefined && (input.cursor.length === 0 || input.cursor.length > 8192)) ||
    (input.facets !== undefined &&
      (input.facets.length > 8 || new Set(input.facets).size !== input.facets.length ||
        input.facets.some((facet) => !/^(?:tags|verified_media_type|custom\.[a-z](?:[a-z0-9._-]{0,62}[a-z0-9])?)$/u.test(facet))))
  ) invalidInput();
  const filter = input.filter;
  if (filter === undefined) return;
  if ((filter.metadata_key === undefined) !== (filter.metadata_value === undefined)) invalidInput();
  if ((filter.extraction_kind === undefined) !== (filter.extraction_state === undefined)) invalidInput();
  if (
    filter.minimum_size_bytes !== undefined &&
    filter.maximum_size_bytes !== undefined &&
    filter.minimum_size_bytes > filter.maximum_size_bytes
  ) invalidInput();
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
