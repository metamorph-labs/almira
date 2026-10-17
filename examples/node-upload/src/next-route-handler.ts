import type { AlmiraClient, CollectionReference } from "@metamorph-labs/almira-sdk";

import { uploadAndVerifyFile } from "./upload.js";

export interface NextUploadRouteOptions extends CollectionReference {
  client: AlmiraClient;
  refusalEnvironmentId: string;
  directFetch?: typeof globalThis.fetch;
  authorize(request: Request): boolean | Promise<boolean>;
  pathFor(kind: UploadKind, fileName: string): string;
}

export type UploadKind = "avatar" | "private_document" | "video";

/** Creates a Next.js-compatible App Router POST handler without embedding developer credentials. */
export function createNextUploadRoute(options: NextUploadRouteOptions) {
  return async function POST(request: Request): Promise<Response> {
    if (!await options.authorize(request)) return safeJson(403, "ALMIRA_EXAMPLE_FORBIDDEN");
    try {
      const form = await request.formData();
      const file = form.get("file");
      const kind = form.get("kind");
      if (!(file instanceof File) || !isUploadKind(kind) || file.size < 1 || file.size > 8 * 1024 * 1024) {
        return safeJson(400, "ALMIRA_EXAMPLE_INPUT_INVALID");
      }
      const result = await uploadAndVerifyFile({
        ...options,
        bytes: new Uint8Array(await file.arrayBuffer()),
        path: options.pathFor(kind, file.name),
        mediaType: file.type || "application/octet-stream",
      });
      return new Response(JSON.stringify({
        entry_id: result.generation.entry_id,
        generation_id: result.generation.generation_id,
        verification: result.receipt,
      }), {
        status: 201,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    } catch {
      return safeJson(502, "ALMIRA_EXAMPLE_STORAGE_FAILED");
    }
  };
}

function isUploadKind(value: FormDataEntryValue | null): value is UploadKind {
  return value === "avatar" || value === "private_document" || value === "video";
}

function safeJson(status: number, code: string): Response {
  return new Response(JSON.stringify({ code }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
