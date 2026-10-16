import { createHash } from "node:crypto";

import {
  AlmiraClient,
  createOperationId,
  uploadDirect,
  type CollectionReference,
  type FileEntry,
} from "@metamorph-labs/almira-sdk";

export interface UploadFileInput extends CollectionReference {
  bytes: Uint8Array;
  client: AlmiraClient;
  directFetch?: typeof globalThis.fetch;
  mediaType: string;
  path: string;
}

export async function uploadFile(input: UploadFileInput): Promise<FileEntry> {
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
  });
  return input.client.finalizeUpload(
    { ...input, transferSessionId: created.transfer_session_id },
    completion,
    { operationId: createOperationId() },
  );
}
