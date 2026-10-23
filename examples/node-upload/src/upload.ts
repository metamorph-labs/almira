import { createHash } from "node:crypto";

import {
  AlmiraClient,
  createOperationId,
  uploadDirect,
  verifyReceiptWithClient,
  type CollectionReference,
  type DeleteFileOutcome,
  type FileGeneration,
  type SignedVerificationReceipt,
} from "@metamorph-labs/almira-sdk";

export interface UploadFileInput extends CollectionReference {
  bytes: Uint8Array;
  client: AlmiraClient;
  directFetch?: typeof globalThis.fetch;
  mediaType: string;
  path: string;
}

export async function uploadFile(input: UploadFileInput): Promise<FileGeneration> {
  const contentSha256 = `sha256:${createHash("sha256").update(input.bytes).digest("hex")}` as const;
  const created = await input.client.createUpload(
    input,
    {
      path: input.path,
      expected_size_bytes: input.bytes.byteLength,
      content_sha256: contentSha256,
      declared_media_type: input.mediaType,
    },
    { operationId: createOperationId() },
  );
  const completion = await uploadDirect(created.descriptor, input.bytes, {
    ...(input.directFetch === undefined ? {} : { fetch: input.directFetch }),
    createPart: (request, signal) => input.client.createUploadPart(
      { ...input, transferSessionId: created.transfer_session_id },
      request,
      { operationId: createOperationId(), ...(signal === undefined ? {} : { signal }) },
    ),
  });
  return input.client.finalizeUpload(
    { ...input, transferSessionId: created.transfer_session_id },
    completion,
    { operationId: createOperationId() },
  );
}

export interface VerifiedUploadFileInput extends UploadFileInput {
  refusalEnvironmentId: string;
}

export interface VerifiedUploadFileResult {
  generation: FileGeneration;
  receipt: SignedVerificationReceipt;
}

export interface CleanedVerifiedUploadFileResult extends VerifiedUploadFileResult {
  cleanup: DeleteFileOutcome;
}

/** Runs the application upload and asks Almira to exercise and sign the required behavior. */
export async function uploadAndVerifyFile(
  input: VerifiedUploadFileInput,
): Promise<VerifiedUploadFileResult> {
  const contentSha256 = `sha256:${createHash("sha256").update(input.bytes).digest("hex")}` as const;
  const created = await input.client.createUpload(
    input,
    {
      path: input.path,
      expected_size_bytes: input.bytes.byteLength,
      content_sha256: contentSha256,
      declared_media_type: input.mediaType,
    },
    { operationId: createOperationId() },
  );
  const completion = await uploadDirect(created.descriptor, input.bytes, {
    ...(input.directFetch === undefined ? {} : { fetch: input.directFetch }),
    createPart: (request, signal) => input.client.createUploadPart(
      { ...input, transferSessionId: created.transfer_session_id },
      request,
      { operationId: createOperationId(), ...(signal === undefined ? {} : { signal }) },
    ),
  });
  const finalizeOperationId = createOperationId();
  const generation = await input.client.finalizeUpload(
    { ...input, transferSessionId: created.transfer_session_id },
    completion,
    { operationId: finalizeOperationId },
  );
  const receipt = await input.client.createVerificationReceipt(
    input,
    {
      transfer_session_id: created.transfer_session_id,
      finalize_operation_id: finalizeOperationId,
      entry_id: created.entry_id,
      generation_id: created.generation_id,
      refusal_environment_id: input.refusalEnvironmentId,
      completion,
    },
  );
  if (!await verifyReceiptWithClient(input.client, receipt, { expected: {
    tenantId: input.tenantId,
    projectId: input.projectId,
    environmentId: input.environmentId,
    collectionInstanceId: input.collectionInstanceId,
    entryId: created.entry_id,
    generationId: created.generation_id,
    expectedSizeBytes: input.bytes.byteLength,
    contentSha256,
  } })) {
    throw new Error("ALMIRA_EXAMPLE_VERIFICATION_FAILED");
  }
  return { generation, receipt };
}

/** Runs the verification canary and immediately moves it into the configured recycle window. */
export async function uploadVerifyAndCleanupFile(
  input: VerifiedUploadFileInput,
): Promise<CleanedVerifiedUploadFileResult> {
  const verified = await uploadAndVerifyFile(input);
  const cleanup = await cleanupVerifiedUpload(input, verified.generation);
  return { ...verified, cleanup };
}

/** Cleans up one verified canary using a fresh authoritative file revision. */
export async function cleanupVerifiedUpload(
  input: Pick<VerifiedUploadFileInput, "client" | "tenantId" | "projectId" | "environmentId" | "collectionInstanceId">,
  generation: FileGeneration,
): Promise<DeleteFileOutcome> {
  const reference = {
    tenantId: input.tenantId,
    projectId: input.projectId,
    environmentId: input.environmentId,
    collectionInstanceId: input.collectionInstanceId,
    entryId: generation.entry_id,
  };
  const entry = await input.client.getFileMetadata(reference);
  return input.client.deleteFile(reference, entry.revision, { operationId: createOperationId() });
}
