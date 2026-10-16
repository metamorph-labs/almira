import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import { AlmiraClient } from "@metamorph-labs/almira-sdk";

import { uploadFile } from "./upload.js";

const [filePath, projectId, environmentId, collectionInstanceId, logicalPath] = process.argv.slice(2);
const baseUrl = process.env.ALMIRA_BASE_URL;
const credential = process.env.METAMORPH_TOKEN;

if (
  filePath === undefined ||
  projectId === undefined ||
  environmentId === undefined ||
  collectionInstanceId === undefined ||
  baseUrl === undefined ||
  credential === undefined
) {
  console.error(
    "usage: node dist/main.js <file> <project-id> <environment-id> <collection-id> [logical-path]",
  );
  process.exitCode = 2;
} else {
  try {
    const bytes = await readFile(filePath);
    const entry = await uploadFile({
      client: new AlmiraClient({ baseUrl, credential }),
      projectId,
      environmentId,
      collectionInstanceId,
      bytes,
      path: logicalPath ?? basename(filePath),
      mediaType: "application/octet-stream",
    });
    process.stdout.write(`${JSON.stringify(entry)}\n`);
  } catch {
    console.error(JSON.stringify({ code: "ALMIRA_EXAMPLE_UPLOAD_FAILED" }));
    process.exitCode = 1;
  }
}
