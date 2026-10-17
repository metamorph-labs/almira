import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../dist/cli.js";

const projectId = "018f0000-0000-7000-8000-000000000003";
const tenantId = "018f0000-0000-7000-8000-000000000002";
const environmentId = "018f0000-0000-7000-8000-000000000004";
const operationId = "018f0000-0000-7000-8000-000000000007";
const requestId = "018f0000-0000-7000-8000-000000000008";

function io() {
  const stdout = [];
  const stderr = [];
  return {
    output: { stdout, stderr },
    value: {
      stdout: { write: (value) => stdout.push(value) },
      stderr: { write: (value) => stderr.push(value) },
    },
  };
}

const environment = {
  ALMIRA_BASE_URL: "https://almira.test",
  METAMORPH_TOKEN: "mm_pat_v1.test",
};

const tenancyProject = {
  schema_version: 1,
  operation_id: "018f0000-0000-7000-8000-000000000010",
  operation: "project.get",
  disposition: "succeeded",
  result: { project: {
    tenant_id: tenantId,
    project_id: projectId,
    space_id: "018f0000-0000-7000-8000-000000000011",
    product_id: "almira",
    product_section_id: null,
    project_kind_id: "almira.storage",
    owner_region_id: "region.one",
    name: "Files",
    visibility: "private",
    lifecycle: "active",
    route_epoch: 1,
    revision: 3,
    restrictive_revision: 1,
    activated_at: "2026-10-17T00:00:00Z",
  } },
};

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

test("CLI package version matches the promoted API", async () => {
  const contract = JSON.parse(await readFile(new URL("../../../contracts/openapi.v1.json", import.meta.url)));
  const packageManifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url)));
  assert.equal(packageManifest.version, contract.info.version);
});

test("project bootstrap generates a replayable operation ID and JSON only", async (context) => {
  const stream = io();
  const directory = await mkdtemp(join(tmpdir(), "almira-cli-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const snapshotPath = join(directory, "project.json");
  await writeFile(snapshotPath, JSON.stringify(tenancyProject));
  let request;
  const exitCode = await runCli([
    "project", "bootstrap",
    "--tenant", tenantId,
    "--project", projectId,
    "--tenancy-project", snapshotPath,
  ], {
    environment,
    io: stream.value,
    fetch: async (input, init) => {
      request = { input, init };
      return json({ disposition: "converged", project_revision: 1, environments: [] });
    },
  });
  assert.equal(exitCode, 0);
  assert.equal(stream.output.stderr.length, 0);
  const output = JSON.parse(stream.output.stdout.join(""));
  assert.match(output.operation_id, /^[0-9a-f]{8}-[0-9a-f]{4}-7/u);
  assert.equal(request.init.headers.get("idempotency-key"), output.operation_id);
  assert.equal(request.init.headers.get("authorization"), "Bearer mm_pat_v1.test");
  assert.equal(request.init.headers.get("x-almira-tenant-id"), tenantId);
  assert.deepEqual(JSON.parse(request.init.body), { tenancy_project: tenancyProject });
});

test("collection creation uses predictable noun/verb arguments", async () => {
  const stream = io();
  const exitCode = await runCli(
    [
      "collection", "create",
      "--tenant", tenantId,
      "--project", projectId,
      "--environment", environmentId,
      "--key", "assets",
      "--display", "Assets",
      "--scan", "required",
      "--class", "express",
      "--operation-id", operationId,
    ],
    {
      environment,
      io: stream.value,
      fetch: async (_input, init) => {
        assert.deepEqual(JSON.parse(init.body), {
          collection_key: "assets",
          display_name: "Assets",
          malware_scan_required: true,
          storage_class: "express",
        });
        return json({ disposition: "applied", collection: {} }, 201);
      },
    },
  );
  assert.equal(exitCode, 0);
  assert.equal(JSON.parse(stream.output.stdout.join("")).operation_id, operationId);
});

test("storage migration start and status preserve exact scope, revision, and operation identity", async () => {
  const collectionId = "018f0000-0000-7000-8000-000000000012";
  const migrationId = "018f0000-0000-7000-8000-000000000013";
  const requests = [];
  const invoke = async (arguments_) => {
    const stream = io();
    const exitCode = await runCli(arguments_, {
      environment,
      io: stream.value,
      fetch: async (input, init) => {
        requests.push({ input, init });
        return json(init.method === "POST"
          ? { disposition: "applied", migration: { migration_id: migrationId } }
          : { migration_id: migrationId }, init.method === "POST" ? 201 : 200);
      },
    });
    assert.equal(exitCode, 0);
    return JSON.parse(stream.output.stdout.join(""));
  };
  const common = [
    "--tenant", tenantId,
    "--project", projectId,
    "--environment", environmentId,
    "--collection", collectionId,
  ];

  const started = await invoke([
    "collection", "migrate", ...common,
    "--class", "express",
    "--revision", "4",
    "--operation-id", operationId,
  ]);
  const status = await invoke(["migration", "get", ...common, "--migration", migrationId]);

  assert.equal(started.operation_id, operationId);
  assert.equal(status.migration_id, migrationId);
  const path = `https://almira.test/v1/projects/${projectId}/environments/${environmentId}/collections/${collectionId}/storage-migrations`;
  assert.deepEqual(requests.map(({ input, init }) => ({
    input,
    method: init.method,
    operationId: init.headers.get("idempotency-key"),
    body: init.body === undefined ? undefined : JSON.parse(init.body),
  })), [
    {
      input: path,
      method: "POST",
      operationId,
      body: { target_storage_class: "express", expected_collection_revision: 4 },
    },
    {
      input: `${path}/${migrationId}`,
      method: "GET",
      operationId: null,
      body: undefined,
    },
  ]);
});

test("portability commands preserve credential-free manifests, scope, and replay identity", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "almira-portability-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const collectionId = "018f0000-0000-7000-8000-000000000012";
  const portabilityJobId = "018f0000-0000-7000-8000-000000000013";
  const sourceObjectId = "018f0000-0000-7000-8000-000000000014";
  const sourceBindingId = "018f0000-0000-7000-8000-000000000015";
  const input = join(directory, "import.json");
  const requestBody = {
    expected_collection_revision: 4,
    source: {
      source_binding_id: sourceBindingId,
      source_binding_generation: 2,
      manifest_sha256: `sha256:${"a".repeat(64)}`,
      objects_total: 1,
      bytes_total: 5,
    },
    objects: [{
      source_object_id: sourceObjectId,
      logical_path: "seed/hello.txt",
      expected_size_bytes: 5,
      content_sha256: `sha256:${"b".repeat(64)}`,
      declared_media_type: "text/plain",
    }],
    destination_prefix: "imported",
  };
  await writeFile(input, JSON.stringify(requestBody));
  const requests = [];
  const invoke = async (arguments_) => {
    const stream = io();
    const exitCode = await runCli(arguments_, {
      environment,
      io: stream.value,
      fetch: async (url, init) => {
        requests.push({ url, init });
        if (init.method === "POST") {
          return json({ disposition: "applied", job: { job_id: portabilityJobId } }, 201);
        }
        return json(url.includes("?")
          ? { jobs: [], next_cursor: null }
          : { job_id: portabilityJobId });
      },
    });
    assert.equal(exitCode, 0, stream.output.stderr.join(""));
    return JSON.parse(stream.output.stdout.join(""));
  };
  const scope = [
    "--tenant", tenantId, "--project", projectId, "--environment", environmentId,
    "--collection", collectionId,
  ];

  const imported = await invoke([
    "import", "start", ...scope, "--input", input, "--operation-id", operationId,
  ]);
  await invoke([
    "export", "start", ...scope, "--revision", "5", "--operation-id", operationId,
  ]);
  await invoke(["portability", "list", ...scope, "--kind", "export", "--limit", "25"]);
  await invoke(["portability", "get", ...scope, "--portability-job", portabilityJobId]);

  assert.equal(imported.operation_id, operationId);
  const base = `https://almira.test/v1/projects/${projectId}/environments/${environmentId}/collections/${collectionId}`;
  assert.deepEqual(requests.map(({ url, init }) => ({
    url,
    method: init.method,
    operationId: init.headers.get("idempotency-key"),
    body: init.body === undefined ? undefined : JSON.parse(init.body),
  })), [
    { url: `${base}/imports`, method: "POST", operationId, body: requestBody },
    {
      url: `${base}/exports`, method: "POST", operationId,
      body: { expected_collection_revision: 5 },
    },
    {
      url: `${base}/portability-jobs?limit=25&kind=export`, method: "GET",
      operationId: null, body: undefined,
    },
    {
      url: `${base}/portability-jobs/${portabilityJobId}`, method: "GET",
      operationId: null, body: undefined,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(requestBody), /credential|secret|token|bucket|account|region/iu);
});

test("portable export download streams, verifies, and never overwrites the target", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "almira-export-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, "archive.tar");
  const collectionId = "018f0000-0000-7000-8000-000000000012";
  const portabilityJobId = "018f0000-0000-7000-8000-000000000013";
  const descriptorId = "018f0000-0000-7000-8000-000000000014";
  const bytes = new TextEncoder().encode("portable archive");
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const providerUrl = "https://objects.example/one-use?signature=sensitive";
  const calls = [];
  const invoke = async () => {
    const stream = io();
    const exitCode = await runCli([
      "export", "download",
      "--tenant", tenantId,
      "--project", projectId,
      "--environment", environmentId,
      "--collection", collectionId,
      "--portability-job", portabilityJobId,
      "--output", output,
      "--operation-id", operationId,
    ], {
      environment,
      io: stream.value,
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (url === providerUrl) {
          return new Response(bytes, { headers: { "content-length": String(bytes.length) } });
        }
        return json({
          descriptor_id: descriptorId,
          method: "GET",
          url: providerUrl,
          headers: [{ name: "x-export-token", value: "sensitive" }],
          expected_size_bytes: bytes.length,
          content_sha256: digest,
          one_use: true,
          expires_at: "2099-01-01T00:00:00Z",
        }, 201);
      },
    });
    return { exitCode, output: stream.output };
  };

  const first = await invoke();
  assert.equal(first.exitCode, 0, first.output.stderr.join(""));
  assert.deepEqual(JSON.parse(first.output.stdout.join("")), {
    operation_id: operationId,
    result: {
      job_id: portabilityJobId,
      output,
      size_bytes: bytes.length,
      content_sha256: digest,
    },
  });
  assert.deepEqual(new Uint8Array(await readFile(output)), bytes);
  assert.equal(calls[0].init.headers.get("authorization"), "Bearer mm_pat_v1.test");
  assert.equal(calls[1].init.headers.get("authorization"), null);
  assert.equal(calls[1].init.headers.get("x-export-token"), "sensitive");

  const second = await invoke();
  assert.equal(second.exitCode, 5);
  assert.deepEqual(JSON.parse(second.output.stderr.join("")), {
    code: "ALMIRA_CLI_OUTPUT_EXISTS",
    operation_id: operationId,
    recovery: "choose a new --output path",
  });
  assert.deepEqual(new Uint8Array(await readFile(output)), bytes);
  assert.doesNotMatch(second.output.stderr.join(""), /signature|sensitive/iu);
});

test("policy replacement accepts an exact JSON document and uses the collection route", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "almira-policy-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, "policy.json");
  const requestBody = { expected_revision: 2, document: { template: "private", rules: [] } };
  await writeFile(input, JSON.stringify(requestBody));
  const collectionId = "018f0000-0000-7000-8000-000000000012";
  const stream = io();
  let request;
  const exitCode = await runCli([
    "policy", "set",
    "--tenant", tenantId,
    "--project", projectId,
    "--environment", environmentId,
    "--collection", collectionId,
    "--input", input,
    "--operation-id", operationId,
  ], {
    environment,
    io: stream.value,
    fetch: async (url, init) => {
      request = { url, init };
      return json({ disposition: "applied", policy: {} });
    },
  });
  assert.equal(exitCode, 0);
  assert.equal(request.url, `https://almira.test/v1/projects/${projectId}/environments/${environmentId}/collections/${collectionId}/policy`);
  assert.equal(request.init.method, "PUT");
  assert.equal(request.init.headers.get("idempotency-key"), operationId);
  assert.deepEqual(JSON.parse(request.init.body), requestBody);
});

test("metadata and extraction commands expose exact scoped management operations", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "almira-metadata-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const extractionInput = join(directory, "extraction.json");
  const metadataInput = join(directory, "metadata.json");
  await writeFile(extractionInput, JSON.stringify({
    expected_revision: 2,
    config: { content: true, ocr: false, transcription: false },
  }));
  await writeFile(metadataInput, JSON.stringify({
    expected_revision: 3,
    metadata: { tags: ["invoice"], custom: { account_id: "acme" } },
  }));
  const collectionId = "018f0000-0000-7000-8000-000000000012";
  const entryId = "018f0000-0000-7000-8000-000000000013";
  const generationId = "018f0000-0000-7000-8000-000000000014";
  const requests = [];
  const invoke = async (arguments_) => {
    const stream = io();
    const exitCode = await runCli(arguments_, {
      environment,
      io: stream.value,
      fetch: async (input, init) => {
        requests.push({ input, init });
        return json(init.method === "PUT" ? { disposition: "applied" } : {});
      },
    });
    assert.equal(exitCode, 0, stream.output.stderr.join(""));
  };
  const scope = [
    "--tenant", tenantId, "--project", projectId, "--environment", environmentId,
    "--collection", collectionId,
  ];
  const fileScope = [...scope, "--entry", entryId];
  await invoke(["extraction", "get", ...scope]);
  await invoke(["extraction", "set", ...scope, "--input", extractionInput, "--operation-id", operationId]);
  await invoke(["metadata", "get", ...fileScope]);
  await invoke(["metadata", "set", ...fileScope, "--input", metadataInput, "--operation-id", operationId]);
  await invoke(["extraction", "status", ...fileScope, "--generation", generationId, "--kind", "content"]);
  await invoke(["extraction", "content", ...fileScope, "--generation", generationId, "--kind", "content"]);

  const base = `https://almira.test/v1/projects/${projectId}/environments/${environmentId}/collections/${collectionId}`;
  const fileBase = `${base}/files/${entryId}`;
  assert.deepEqual(requests.map(({ input, init }) => ({
    input,
    method: init.method,
    operationId: init.headers.get("idempotency-key"),
    body: init.body === undefined ? undefined : JSON.parse(init.body),
  })), [
    { input: `${base}/extraction`, method: "GET", operationId: null, body: undefined },
    {
      input: `${base}/extraction`, method: "PUT", operationId,
      body: { expected_revision: 2, config: { content: true, ocr: false, transcription: false } },
    },
    { input: `${fileBase}/metadata`, method: "GET", operationId: null, body: undefined },
    {
      input: `${fileBase}/metadata`, method: "PUT", operationId,
      body: { expected_revision: 3, metadata: { tags: ["invoice"], custom: { account_id: "acme" } } },
    },
    { input: `${fileBase}/versions/${generationId}/extractions/content`, method: "GET", operationId: null, body: undefined },
    { input: `${fileBase}/versions/${generationId}/extracted-content/content`, method: "GET", operationId: null, body: undefined },
  ]);
});

test("media, job, and derivative commands expose exact scoped management operations", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "almira-media-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const mediaInput = join(directory, "media.json");
  const mediaRequest = {
    expected_revision: 2,
    config: {
      image_presets: {
        card: { widths: [320, 640], height: null, fit: "inside", formats: ["avif", "webp"], without_enlargement: true },
      },
      document_previews: true,
      video_profile: null,
    },
  };
  await writeFile(mediaInput, JSON.stringify(mediaRequest));
  const collectionId = "018f0000-0000-7000-8000-000000000012";
  const entryId = "018f0000-0000-7000-8000-000000000013";
  const generationId = "018f0000-0000-7000-8000-000000000014";
  const jobId = "018f0000-0000-7000-8000-000000000015";
  const requests = [];
  const invoke = async (arguments_) => {
    const stream = io();
    const exitCode = await runCli(arguments_, {
      environment,
      io: stream.value,
      fetch: async (input, init) => {
        requests.push({ input, init });
        return json(input.endsWith("/derivatives") ? [] : init.method === "GET" ? {} : { disposition: "applied" });
      },
    });
    assert.equal(exitCode, 0, stream.output.stderr.join(""));
  };
  const scope = [
    "--tenant", tenantId, "--project", projectId, "--environment", environmentId,
    "--collection", collectionId,
  ];
  await invoke(["media", "get", ...scope]);
  await invoke(["media", "set", ...scope, "--input", mediaInput, "--operation-id", operationId]);
  await invoke(["job", "list", ...scope, "--limit", "25", "--cursor", "next page"]);
  await invoke(["job", "retry", ...scope, "--job", jobId, "--revision", "3", "--operation-id", operationId]);
  await invoke(["job", "cancel", ...scope, "--job", jobId, "--revision", "4", "--operation-id", operationId]);
  await invoke(["derivative", "list", ...scope, "--entry", entryId, "--generation", generationId]);

  const base = `https://almira.test/v1/projects/${projectId}/environments/${environmentId}/collections/${collectionId}`;
  assert.deepEqual(requests.map(({ input, init }) => ({
    input,
    method: init.method,
    body: init.body === undefined ? undefined : JSON.parse(init.body),
  })), [
    { input: `${base}/media`, method: "GET", body: undefined },
    { input: `${base}/media`, method: "PUT", body: mediaRequest },
    { input: `${base}/processing-jobs?limit=25&cursor=next+page`, method: "GET", body: undefined },
    { input: `${base}/processing-jobs/${jobId}/retry`, method: "POST", body: { expected_revision: 3 } },
    { input: `${base}/processing-jobs/${jobId}/cancel`, method: "POST", body: { expected_revision: 4 } },
    { input: `${base}/files/${entryId}/versions/${generationId}/derivatives`, method: "GET", body: undefined },
  ]);
});

test("protection and scan commands expose policy, cases, rescan, and review without release", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "almira-protection-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const reviewInput = join(directory, "review.json");
  const reviewRequest = {
    expected_revision: 5,
    review: {
      decision: "suspected_false_positive",
      reason: "Escalated for an independent scanner review.",
    },
  };
  await writeFile(reviewInput, JSON.stringify(reviewRequest));
  const collectionId = "018f0000-0000-7000-8000-000000000012";
  const entryId = "018f0000-0000-7000-8000-000000000013";
  const generationId = "018f0000-0000-7000-8000-000000000014";
  const requests = [];
  const invoke = async (arguments_) => {
    const stream = io();
    const exitCode = await runCli(arguments_, {
      environment,
      io: stream.value,
      fetch: async (input, init) => {
        requests.push({ input, init });
        if (input.includes("/protection/cases")) return json({ cases: [], next_cursor: null });
        if (input.endsWith("/protection-rescans")) return json({ disposition: "applied", job: {} }, 201);
        if (input.endsWith("/protection-reviews")) return json({ disposition: "applied", review: {} }, 201);
        return json(init.method === "GET" ? {} : { disposition: "applied", config: {} });
      },
    });
    assert.equal(exitCode, 0, stream.output.stderr.join(""));
  };
  const environmentScope = [
    "--tenant", tenantId, "--project", projectId, "--environment", environmentId,
  ];
  const collectionScope = [...environmentScope, "--collection", collectionId];
  const generationScope = [
    ...collectionScope, "--entry", entryId, "--generation", generationId,
  ];

  await invoke(["protection", "get", ...collectionScope]);
  await invoke([
    "protection", "set", ...collectionScope,
    "--scan", "required", "--revision", "2", "--operation-id", operationId,
  ]);
  await invoke([
    "scan", "list", ...environmentScope,
    "--collection", collectionId, "--state", "blocked", "--limit", "25", "--cursor", "next page",
  ]);
  await invoke([
    "scan", "rescan", ...generationScope,
    "--revision", "4", "--operation-id", operationId,
  ]);
  await invoke([
    "scan", "review", ...generationScope,
    "--input", reviewInput, "--operation-id", operationId,
  ]);

  const base = `https://almira.test/v1/projects/${projectId}/environments/${environmentId}`;
  const collectionBase = `${base}/collections/${collectionId}`;
  const generationBase = `${collectionBase}/files/${entryId}/versions/${generationId}`;
  assert.deepEqual(requests.map(({ input, init }) => ({
    input,
    method: init.method,
    body: init.body === undefined ? undefined : JSON.parse(init.body),
  })), [
    { input: `${collectionBase}/protection`, method: "GET", body: undefined },
    {
      input: `${collectionBase}/protection`, method: "PUT",
      body: { expected_revision: 2, config: { malware_scan_required: true } },
    },
    {
      input: `${base}/protection/cases?limit=25&cursor=next+page&collection_instance_id=${collectionId}&safety_state=blocked`,
      method: "GET", body: undefined,
    },
    {
      input: `${generationBase}/protection-rescans`, method: "POST",
      body: { expected_revision: 4 },
    },
    {
      input: `${generationBase}/protection-reviews`, method: "POST",
      body: reviewRequest,
    },
  ]);
});

test("file search exposes hybrid retrieval, filters, facets, and paging as one call", async () => {
  const stream = io();
  const collectionId = "018f0000-0000-7000-8000-000000000012";
  let request;
  const exitCode = await runCli([
    "file", "search",
    "--tenant", tenantId,
    "--project", projectId,
    "--environment", environmentId,
    "--collection", collectionId,
    "--query", "quarterly report",
    "--mode", "hybrid",
    "--path-prefix", "reports",
    "--tag", "finance",
    "--facet", "tags",
    "--facet", "custom.account_id",
    "--page-size", "20",
  ], {
    environment,
    io: stream.value,
    fetch: async (input, init) => {
      request = { input, init };
      return json({
        items: [], facets: [], next_cursor: null,
        facet_coverage: "returned_page",
        consistency: "eventual_projection_authoritative_recheck",
      });
    },
  });
  assert.equal(exitCode, 0, stream.output.stderr.join(""));
  assert.equal(
    request.input,
    `https://almira.test/v1/projects/${projectId}/environments/${environmentId}/collections/${collectionId}/search`,
  );
  assert.equal(request.init.method, "POST");
  assert.deepEqual(JSON.parse(request.init.body), {
    query: "quarterly report",
    mode: "hybrid",
    path_prefix: "reports",
    filter: { tag: "finance" },
    facets: ["tags", "custom.account_id"],
    page_size: 20,
  });
});

test("configuration preview and apply consume almira.yaml without a second API", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "almira-config-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const configurationPath = join(directory, "almira.yaml");
  await writeFile(configurationPath, "api_version: almira/v1\nenvironments: []\n");
  const invoke = async (verb) => {
    const stream = io();
    const exitCode = await runCli([
      "config", verb,
      "--tenant", tenantId,
      "--project", projectId,
      "--file", configurationPath,
      ...(verb === "apply" ? ["--operation-id", operationId] : []),
    ], {
      environment,
      io: stream.value,
      fetch: async (input, init) => {
        assert.equal(input, `https://almira.test/v1/projects/${projectId}/environments`);
        assert.equal(init.method, "GET");
        return json({ environments: [] });
      },
    });
    assert.equal(exitCode, 0);
    return JSON.parse(stream.output.stdout.join(""));
  };

  const preview = await invoke("preview");
  assert.equal(preview.preserves_unlisted_resources, true);
  assert.deepEqual(preview.actions, []);
  const applied = await invoke("apply");
  assert.equal(applied.operation_id, operationId);
  assert.equal(applied.result.disposition, "converged");
  assert.equal(applied.result.operation_id, operationId);
});

test("environment lifecycle commands preserve exact body and revision semantics", async () => {
  const requests = [];
  const invoke = async (arguments_) => {
    const stream = io();
    const exitCode = await runCli(arguments_, {
      environment,
      io: stream.value,
      fetch: async (input, init) => {
        requests.push({ input, init });
        return json({ disposition: "applied", environment: {} }, init.method === "POST" ? 201 : 200);
      },
    });
    assert.equal(exitCode, 0);
    assert.equal(JSON.parse(stream.output.stdout.join("")).operation_id, operationId);
  };

  const common = ["--tenant", tenantId, "--project", projectId, "--operation-id", operationId];
  await invoke(["environment", "create", ...common, "--key", "preview-one", "--display", "Preview one"]);
  await invoke(["environment", "update", ...common, "--environment", environmentId, "--display", "Preview renamed", "--revision", "2"]);
  await invoke(["environment", "delete", ...common, "--environment", environmentId, "--revision", "3"]);

  assert.deepEqual(requests.map(({ input, init }) => ({
    input,
    method: init.method,
    ifMatch: init.headers.get("if-match"),
    body: init.body === undefined ? undefined : JSON.parse(init.body),
  })), [
    { input: `https://almira.test/v1/projects/${projectId}/environments`, method: "POST", ifMatch: null, body: { environment_key: "preview-one", display_name: "Preview one" } },
    { input: `https://almira.test/v1/projects/${projectId}/environments/${environmentId}`, method: "PATCH", ifMatch: null, body: { display_name: "Preview renamed", expected_revision: 2 } },
    { input: `https://almira.test/v1/projects/${projectId}/environments/${environmentId}`, method: "DELETE", ifMatch: "3", body: undefined },
  ]);
});

test("file lifecycle commands expose recycle, versions, rename, copy, batch, and generation selection", async (context) => {
  const collectionId = "018f0000-0000-7000-8000-000000000012";
  const entryId = "018f0000-0000-7000-8000-000000000013";
  const generationId = "018f0000-0000-7000-8000-000000000014";
  const directory = await mkdtemp(join(tmpdir(), "almira-cli-batch-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const batchInput = join(directory, "batch.json");
  await writeFile(batchInput, JSON.stringify({
    actions: [{ action: "delete", entry_id: entryId, expected_revision: 6 }],
  }));
  const requests = [];
  const invoke = async (arguments_) => {
    const stream = io();
    const exitCode = await runCli(arguments_, {
      environment,
      io: stream.value,
      fetch: async (input, init) => {
        requests.push({ input, init });
        return json(init.method === "GET"
          ? (input.includes("/versions") ? { generations: [], next_cursor: null } : { entries: [], next_cursor: null })
          : { disposition: "applied" });
      },
    });
    assert.equal(exitCode, 0);
  };
  const common = [
    "--tenant", tenantId,
    "--project", projectId,
    "--environment", environmentId,
    "--collection", collectionId,
  ];
  const file = [...common, "--entry", entryId];
  await invoke(["file", "list", ...common, "--include-deleted"]);
  await invoke(["file", "versions", ...file, "--limit", "20"]);
  await invoke(["file", "rename", ...file, "--path", "archive/file.txt", "--revision", "3", "--operation-id", operationId]);
  await invoke(["file", "select-version", ...file, "--generation", generationId, "--revision", "4", "--operation-id", operationId]);
  await invoke(["file", "restore", ...file, "--revision", "5", "--operation-id", operationId]);
  await invoke(["file", "batch", ...common, "--input", batchInput, "--operation-id", operationId]);
  await invoke(["file", "copy", ...file, "--generation", generationId, "--path", "archive/file-copy.txt", "--revision", "6", "--operation-id", operationId]);

  const base = `https://almira.test/v1/projects/${projectId}/environments/${environmentId}/collections/${collectionId}/files`;
  assert.deepEqual(requests.map(({ input, init }) => ({
    input,
    method: init.method,
    operationId: init.headers.get("idempotency-key"),
    body: init.body === undefined ? undefined : JSON.parse(init.body),
  })), [
    { input: `${base}?include_deleted=true`, method: "GET", operationId: null, body: undefined },
    { input: `${base}/${entryId}/versions?limit=20`, method: "GET", operationId: null, body: undefined },
    { input: `${base}/${entryId}`, method: "PATCH", operationId, body: { logical_path: "archive/file.txt", expected_revision: 3 } },
    { input: `${base}/${entryId}/current-generation`, method: "PUT", operationId, body: { generation_id: generationId, expected_revision: 4 } },
    { input: `${base}/${entryId}/restore`, method: "POST", operationId, body: { expected_revision: 5 } },
    {
      input: `${base.replace(/\/files$/u, "")}/file-batches`,
      method: "POST",
      operationId,
      body: { actions: [{ action: "delete", entry_id: entryId, expected_revision: 6 }] },
    },
    {
      input: `${base.replace(/\/files$/u, "")}/copies`,
      method: "POST",
      operationId,
      body: {
        source_entry_id: entryId,
        source_generation_id: generationId,
        destination_path: "archive/file-copy.txt",
        expected_source_revision: 6,
      },
    },
  ]);
});

test("storage capability discovery uses the selected environment and remains read-only", async () => {
  const stream = io();
  let request;
  const exitCode = await runCli(
    [
      "storage", "capabilities",
      "--tenant", tenantId,
      "--project", projectId,
      "--environment", environmentId,
    ],
    {
      environment,
      io: stream.value,
      fetch: async (input, init) => {
        request = { input, init };
        return json({ environment_id: environmentId, realizations: [] });
      },
    },
  );
  assert.equal(exitCode, 0);
  assert.equal(
    request.input,
    `https://almira.test/v1/projects/${projectId}/environments/${environmentId}/storage-capabilities`,
  );
  assert.equal(request.init.method, "GET");
  assert.equal(request.init.headers.get("idempotency-key"), null);
  assert.deepEqual(JSON.parse(stream.output.stdout.join("")), {
    environment_id: environmentId,
    realizations: [],
  });
});

test("credentials are not accepted as command-line options", async () => {
  const stream = io();
  const exitCode = await runCli(
    ["environment", "list", "--tenant", tenantId, "--project", projectId, "--token", "secret"],
    { environment, io: stream.value, fetch: async () => assert.fail("no request") },
  );
  assert.equal(exitCode, 2);
  assert.equal(stream.output.stdout.length, 0);
  assert.deepEqual(JSON.parse(stream.output.stderr.join("")), {
    code: "ALMIRA_CLI_USAGE_INVALID",
    recovery: "run almira --help",
  });
  assert.doesNotMatch(stream.output.stderr.join(""), /secret/u);
});

test("options from another command are rejected instead of ignored", async () => {
  const stream = io();
  const exitCode = await runCli(
    ["environment", "list", "--tenant", tenantId, "--project", projectId, "--entry", operationId],
    { environment, io: stream.value, fetch: async () => assert.fail("no request") },
  );
  assert.equal(exitCode, 2);
  assert.equal(JSON.parse(stream.output.stderr.join("")).code, "ALMIRA_CLI_USAGE_INVALID");
});

test("missing connection configuration is actionable and distinct from usage", async () => {
  const stream = io();
  const exitCode = await runCli(["environment", "list", "--tenant", tenantId, "--project", projectId], {
    environment: { METAMORPH_TOKEN: "mm_pat_v1.test" },
    io: stream.value,
    fetch: async () => assert.fail("no request"),
  });
  assert.equal(exitCode, 2);
  assert.deepEqual(JSON.parse(stream.output.stderr.join("")), {
    code: "ALMIRA_CLI_BASE_URL_REQUIRED",
    recovery: "pass --base-url or set ALMIRA_BASE_URL",
  });
});

test("API refusal uses stable exit code and safe diagnostics", async () => {
  const stream = io();
  const exitCode = await runCli(["environment", "list", "--tenant", tenantId, "--project", projectId], {
    environment,
    io: stream.value,
    fetch: async () =>
      json(
        { code: "ALMIRA_AUTHORIZATION_REFUSED", request_id: requestId },
        403,
      ),
  });
  assert.equal(exitCode, 3);
  assert.equal(stream.output.stdout.length, 0);
  assert.deepEqual(JSON.parse(stream.output.stderr.join("")), {
    code: "ALMIRA_AUTHORIZATION_REFUSED",
    request_id: requestId,
    status: 403,
    retry_after_milliseconds: null,
    recovery: "inspect token scope and project permission",
  });
});

test("ambiguous mutation diagnostics retain the generated operation ID", async () => {
  const stream = io();
  const exitCode = await runCli(
    [
      "origin", "set",
      "--tenant", tenantId,
      "--project", projectId,
      "--environment", environmentId,
      "--revision", "1",
      "--origin", "https://app.example",
    ],
    {
      environment,
      io: stream.value,
      fetch: async () => {
        throw new Error("socket failed after write: secret");
      },
    },
  );
  assert.equal(exitCode, 8);
  const diagnostic = JSON.parse(stream.output.stderr.join(""));
  assert.equal(diagnostic.code, "ALMIRA_CLIENT_NETWORK");
  assert.match(diagnostic.operation_id, /^[0-9a-f]{8}-[0-9a-f]{4}-7/u);
  assert.doesNotMatch(stream.output.stderr.join(""), /socket|secret/u);
});
