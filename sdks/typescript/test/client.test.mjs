import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  AlmiraApiError,
  AlmiraClient,
  AlmiraClientError,
  createOperationId,
} from "../dist/index.js";

const projectId = "018f0000-0000-7000-8000-000000000003";
const tenantId = "018f0000-0000-7000-8000-000000000002";
const environmentId = "018f0000-0000-7000-8000-000000000004";
const collectionInstanceId = "018f0000-0000-7000-8000-000000000005";
const entryId = "018f0000-0000-7000-8000-000000000006";
const operationId = "018f0000-0000-7000-8000-000000000007";
const requestId = "018f0000-0000-7000-8000-000000000008";
const generationId = "018f0000-0000-7000-8000-000000000009";

test("operation IDs are UUIDv7 values with the requested timestamp", () => {
  const operationId = createOperationId(1_729_080_000_000);
  assert.match(operationId, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.equal(BigInt(`0x${operationId.replaceAll("-", "").slice(0, 12)}`), 1_729_080_000_000n);
});

test("SDK version and methods cover the promoted contract exactly", async () => {
  const contract = JSON.parse(await readFile(new URL("../../../contracts/openapi.v1.json", import.meta.url)));
  const packageManifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url)));
  const operations = Object.values(contract.paths)
    .flatMap((path) => Object.values(path))
    .filter((operation) => !Array.isArray(operation) && typeof operation?.operationId === "string")
    .map((operation) => operation.operationId)
    .sort();
  const methods = Object.getOwnPropertyNames(AlmiraClient.prototype)
    .filter((name) => name !== "constructor")
    .sort();
  assert.equal(packageManifest.version, contract.info.version);
  assert.deepEqual(methods, operations);
});

function json(value, init = {}) {
  return new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

test("bearer management request is exact and omits browser credentials", async () => {
  const calls = [];
  const client = new AlmiraClient({
    baseUrl: "https://almira.test/",
    credential: async () => "mm_sak_v1.test",
    fetch: async (input, init) => {
      calls.push({ input, init });
      return json({
        disposition: "applied",
        collection: { collection_instance_id: collectionInstanceId },
      }, { status: 201 });
    },
  });

  await client.createCollection(
    { tenantId, projectId, environmentId },
    {
      collection_key: "assets",
      display_name: "Assets",
      malware_scan_required: true,
      storage_class: "express",
    },
    { operationId },
  );

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].input,
    `https://almira.test/v1/projects/${projectId}/environments/${environmentId}/collections`,
  );
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.credentials, "omit");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.headers.get("authorization"), "Bearer mm_sak_v1.test");
  assert.equal(calls[0].init.headers.get("x-almira-tenant-id"), tenantId);
  assert.equal(calls[0].init.headers.get("idempotency-key"), operationId);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    collection_key: "assets",
    display_name: "Assets",
    malware_scan_required: true,
    storage_class: "express",
  });
});

test("environment mutations use the canonical methods, paths, and concurrency headers", async () => {
  const calls = [];
  const client = new AlmiraClient({
    credential: "mm_pat_v1.test",
    fetch: async (input, init) => {
      calls.push({ input, init });
      return json({ disposition: "applied", environment: {} }, { status: init.method === "POST" ? 201 : 200 });
    },
  });

  await client.createEnvironment(
    { tenantId, projectId },
    { environment_key: "preview-one", display_name: "Preview one" },
    { operationId },
  );
  await client.updateEnvironment(
    { tenantId, projectId, environmentId },
    { display_name: "Preview renamed", expected_revision: 2 },
    { operationId },
  );
  await client.deleteEnvironment(
    { tenantId, projectId, environmentId },
    3,
    { operationId },
  );

  assert.deepEqual(calls.map(({ input, init }) => ({
    input,
    method: init.method,
    revision: init.headers.get("if-match"),
    body: init.body === undefined ? undefined : JSON.parse(init.body),
  })), [
    {
      input: `/v1/projects/${projectId}/environments`,
      method: "POST",
      revision: null,
      body: { environment_key: "preview-one", display_name: "Preview one" },
    },
    {
      input: `/v1/projects/${projectId}/environments/${environmentId}`,
      method: "PATCH",
      revision: null,
      body: { display_name: "Preview renamed", expected_revision: 2 },
    },
    {
      input: `/v1/projects/${projectId}/environments/${environmentId}`,
      method: "DELETE",
      revision: "3",
      body: undefined,
    },
  ]);
  assert.ok(calls.every(({ init }) => init.headers.get("idempotency-key") === operationId));
});

test("storage capability discovery is one exact environment-scoped read", async () => {
  let call;
  const catalog = {
    environment_id: environmentId,
    deployment_profile: "hosted",
    catalog_revision: 1,
    catalog_digest: `sha256:${"a".repeat(64)}`,
    expires_at: "2099-10-17T00:00:00Z",
    provider_matrix: {
      hosted: ["aws_s3", "google_cloud_storage", "azure_blob"],
      connected_site: ["aws_s3", "google_cloud_storage", "azure_blob"],
    },
    realizations: [],
  };
  const client = new AlmiraClient({
    credential: "mm_pat_v1.test",
    fetch: async (input, init) => {
      call = { input, init };
      return json(catalog);
    },
  });

  assert.deepEqual(
    await client.getStorageCapabilities({ tenantId, projectId, environmentId }),
    catalog,
  );
  assert.equal(
    call.input,
    `/v1/projects/${projectId}/environments/${environmentId}/storage-capabilities`,
  );
  assert.equal(call.init.method, "GET");
  assert.equal(call.init.headers.get("idempotency-key"), null);
  assert.equal(call.init.headers.get("x-almira-tenant-id"), tenantId);
});

test("storage migration start and status use the collection-scoped contract", async () => {
  const calls = [];
  const migration = {
    migration_id: operationId,
    environment_id: environmentId,
    collection_instance_id: collectionInstanceId,
    phase: "inventory",
  };
  const client = new AlmiraClient({
    credential: "mm_pat_v1.test",
    fetch: async (input, init) => {
      calls.push({ input, init });
      return json(init.method === "POST" ? { disposition: "applied", migration } : migration, {
        status: init.method === "POST" ? 201 : 200,
      });
    },
  });
  const reference = { tenantId, projectId, environmentId, collectionInstanceId };
  await client.startStorageMigration(
    reference,
    { target_storage_class: "express", expected_collection_revision: 3 },
    { operationId },
  );
  await client.getStorageMigration({ ...reference, migrationId: operationId });
  const base = `/v1/projects/${projectId}/environments/${environmentId}/collections/${collectionInstanceId}/storage-migrations`;
  assert.deepEqual(calls.map(({ input, init }) => ({
    input,
    method: init.method,
    operation: init.headers.get("idempotency-key"),
    body: init.body === undefined ? undefined : JSON.parse(init.body),
  })), [
    {
      input: base,
      method: "POST",
      operation: operationId,
      body: { target_storage_class: "express", expected_collection_revision: 3 },
    },
    {
      input: `${base}/${operationId}`,
      method: "GET",
      operation: null,
      body: undefined,
    },
  ]);
});

test("portable import, export, status, and download use exact collection scope", async () => {
  const calls = [];
  const source = {
    source_binding_id: "018f0000-0000-7000-8000-000000000021",
    source_binding_generation: 1,
    manifest_sha256: `sha256:${"a".repeat(64)}`,
    objects_total: 1,
    bytes_total: 12,
  };
  const job = {
    job_id: operationId,
    environment_id: environmentId,
    collection_instance_id: collectionInstanceId,
    kind: "export",
  };
  const descriptor = {
    descriptor_id: "018f0000-0000-7000-8000-000000000022",
    method: "GET",
    url: "https://transfer.example.invalid/export?grant=opaque",
    headers: [],
    expected_size_bytes: 64,
    content_sha256: `sha256:${"b".repeat(64)}`,
    one_use: true,
    expires_at: "2099-10-17T00:00:00Z",
  };
  const client = new AlmiraClient({
    credential: "mm_pat_v1.test",
    fetch: async (input, init) => {
      calls.push({ input, init });
      if (String(input).endsWith("/imports")) return json({ disposition: "applied", job }, { status: 201 });
      if (String(input).endsWith("/exports")) return json({ disposition: "applied", job }, { status: 201 });
      if (String(input).endsWith("/download")) return json(descriptor, { status: 201 });
      if (String(input).includes("/portability-jobs?")) return json({ jobs: [job], next_cursor: null });
      return json(job);
    },
  });
  const reference = { tenantId, projectId, environmentId, collectionInstanceId };
  const importRequest = {
    expected_collection_revision: 3,
    source,
    objects: [{
      source_object_id: "018f0000-0000-7000-8000-000000000023",
      logical_path: "documents/readme.txt",
      expected_size_bytes: 12,
      content_sha256: `sha256:${"c".repeat(64)}`,
      declared_media_type: "text/plain",
    }],
  };
  await client.startCollectionImport(reference, importRequest, { operationId });
  await client.startCollectionExport(reference, { expected_collection_revision: 3 }, { operationId });
  await client.listPortabilityJobs(reference, { kind: "export", limit: 25, cursor: "next" });
  await client.getPortabilityJob({ ...reference, jobId: operationId });
  await client.createPortabilityExportDownload({ ...reference, jobId: operationId }, { operationId });
  const base = `/v1/projects/${projectId}/environments/${environmentId}/collections/${collectionInstanceId}`;
  assert.deepEqual(calls.map(({ input, init }) => ({
    input,
    method: init.method,
    operation: init.headers.get("idempotency-key"),
    body: init.body === undefined ? undefined : JSON.parse(init.body),
  })), [
    { input: `${base}/imports`, method: "POST", operation: operationId, body: importRequest },
    { input: `${base}/exports`, method: "POST", operation: operationId, body: { expected_collection_revision: 3 } },
    { input: `${base}/portability-jobs?limit=25&cursor=next&kind=export`, method: "GET", operation: null, body: undefined },
    { input: `${base}/portability-jobs/${operationId}`, method: "GET", operation: null, body: undefined },
    { input: `${base}/portability-jobs/${operationId}/download`, method: "POST", operation: operationId, body: undefined },
  ]);
});

test("management search sends one bounded collection request with optional subject context", async () => {
  let call;
  const client = new AlmiraClient({
    workloadSession: "workload_session",
    fetch: async (input, init) => {
      call = { input, init };
      return json({
        items: [], facets: [], next_cursor: null,
        facet_coverage: "returned_page",
        consistency: "eventual_projection_authoritative_recheck",
      });
    },
  });
  const input = {
    query: "quarterly report",
    mode: "hybrid",
    path_prefix: "reports",
    filter: { tag: "finance" },
    facets: ["tags", "custom.account_id"],
    page_size: 20,
  };
  await client.searchFiles(
    { tenantId, projectId, environmentId, collectionInstanceId },
    input,
    { subject: { subject_id: "customer-42" } },
  );
  assert.equal(call.input, `/v1/projects/${projectId}/environments/${environmentId}/collections/${collectionInstanceId}/search`);
  assert.equal(call.init.method, "POST");
  assert.deepEqual(JSON.parse(call.init.body), input);
  assert.equal(
    Buffer.from(call.init.headers.get("x-almira-subject-context"), "base64url").toString("utf8"),
    '{"subject_id":"customer-42"}',
  );
  await assert.rejects(
    client.searchFiles(
      { tenantId, projectId, environmentId, collectionInstanceId },
      { query: " report\n" },
    ),
    (error) => error instanceof AlmiraClientError && error.code === "ALMIRA_CLIENT_INPUT_INVALID",
  );
});

test("workload evidence uses its distinct framing and is resolved for every call", async () => {
  const evidence = ["eyJzY2hlbWFfdmVyc2lvbiI6MX0", "eyJzY2hlbWFfdmVyc2lvbiI6Mn0"];
  let calls = 0;
  const client = new AlmiraClient({
    baseUrl: "https://almira.test",
    workloadSession: () => evidence[calls],
    fetch: async (input, init) => {
      assert.equal(input, `https://almira.test/v1/projects/${projectId}/environments`);
      assert.equal(init.credentials, "omit");
      assert.equal(init.headers.get("authorization"), `MetamorphWorkload ${evidence[calls]}`);
      assert.equal(init.headers.get("x-almira-tenant-id"), tenantId);
      calls += 1;
      return json({ environments: [] });
    },
  });

  await client.listEnvironments({ tenantId, projectId });
  await client.listEnvironments({ tenantId, projectId });
  assert.equal(calls, 2);
});

test("authentication modes and PAT or SAK framing fail closed", async () => {
  assert.throws(
    () => new AlmiraClient({ credential: "mm_pat_v1.test", workloadSession: "e30" }),
    (error) => error instanceof AlmiraClientError && error.code === "ALMIRA_CLIENT_INPUT_INVALID",
  );
  assert.throws(
    () => new AlmiraClient({ credential: "mm_pat_v1.test", productSelection: "selection_reference_1234567890" }),
    (error) => error instanceof AlmiraClientError && error.code === "ALMIRA_CLIENT_INPUT_INVALID",
  );
  for (const credential of ["Bearer secret", "pat_secret", "mm_pat_v2.secret", "mm_sak_v1."]) {
    const client = new AlmiraClient({
      credential,
      fetch: async () => assert.fail("must reject malformed evidence before fetch"),
    });
    await assert.rejects(
      client.listEnvironments({ tenantId, projectId }),
      (error) => error instanceof AlmiraClientError && error.code === "ALMIRA_CLIENT_INPUT_INVALID",
    );
  }
});

test("browser reads are one Almira call and include same-origin credentials", async () => {
  let count = 0;
  const client = new AlmiraClient({
    productSelection: "selection_reference_1234567890",
    fetch: async (input, init) => {
      count += 1;
      assert.equal(
        input,
        `/v1/projects/${projectId}/environments/${environmentId}/collections/${collectionInstanceId}/files/${entryId}/content?generation_id=${operationId}`,
      );
      assert.equal(init.credentials, "include");
      assert.equal(init.headers.get("authorization"), null);
      assert.equal(init.headers.get("x-metamorph-product-selection"), "selection_reference_1234567890");
      assert.equal(init.headers.get("x-almira-tenant-id"), tenantId);
      assert.equal(init.headers.get("range"), "bytes=10-19");
      return new Response(new Uint8Array([1, 2]), {
        status: 206,
        headers: {
          "content-length": "2",
          "content-range": "bytes 10-11/20",
          "content-type": "application/octet-stream",
          etag: "opaque",
        },
      });
    },
  });

  const response = await client.readPrivateFile({
    tenantId,
    projectId,
    environmentId,
    collectionInstanceId,
    entryId,
    generationId: operationId,
    range: "bytes=10-19",
  });
  assert.equal(count, 1);
  assert.equal(response.status, 206);
  assert.equal(response.contentLength, 2);
  assert.deepEqual(new Uint8Array(await new Response(response.body).arrayBuffer()), new Uint8Array([1, 2]));
});

test("list query encoding cannot change the request path", async () => {
  const client = new AlmiraClient({
    fetch: async (input) => {
      assert.equal(
        input,
        `/v1/projects/${projectId}/environments/${environmentId}/collections/${collectionInstanceId}/files?limit=25&cursor=a%26admin%3Dtrue&path_prefix=images%2Fcover.png`,
      );
      return json({ entries: [], next_cursor: null });
    },
  });
  await client.listFiles(
    { tenantId, projectId, environmentId, collectionInstanceId },
    { limit: 25, cursor: "a&admin=true", pathPrefix: "images/cover.png" },
  );
});

test("metadata and extraction methods preserve exact scope, filtering, and separate content access", async () => {
  const calls = [];
  const client = new AlmiraClient({
    credential: "mm_pat_v1.test",
    fetch: async (input, init) => {
      calls.push({ input, init });
      return json(init.method === "PUT" ? { disposition: "applied" } : {});
    },
  });
  const collection = { tenantId, projectId, environmentId, collectionInstanceId };
  const file = { ...collection, entryId };
  await client.getCollectionExtraction(collection);
  await client.replaceCollectionExtraction(collection, {
    expected_revision: 2,
    config: { content: true, ocr: false, transcription: false },
  }, { operationId });
  await client.listFiles(collection, {
    tag: "invoice",
    metadataKey: "account_id",
    metadataValue: "acme",
    verifiedMediaType: "application/pdf",
    minimumSizeBytes: 10,
    maximumSizeBytes: 1000,
    createdAfter: "2026-10-01T00:00:00Z",
    createdBefore: "2026-10-17T00:00:00Z",
    extractionKind: "content",
    extractionState: "succeeded",
  });
  await client.getEntryMetadata(file);
  await client.replaceEntryMetadata(file, {
    expected_revision: 3,
    metadata: { tags: ["invoice"], custom: { account_id: "acme", retention_years: 7 } },
  }, { operationId });
  await client.getGenerationExtraction({ ...file, generationId, kind: "content" });
  await client.getExtractedContent({ ...file, generationId, kind: "content" });

  const collectionBase = `/v1/projects/${projectId}/environments/${environmentId}/collections/${collectionInstanceId}`;
  const fileBase = `${collectionBase}/files/${entryId}`;
  assert.deepEqual(calls.map(({ input, init }) => ({
    input,
    method: init.method,
    operationId: init.headers.get("idempotency-key"),
    body: init.body === undefined ? undefined : JSON.parse(init.body),
  })), [
    { input: `${collectionBase}/extraction`, method: "GET", operationId: null, body: undefined },
    {
      input: `${collectionBase}/extraction`, method: "PUT", operationId,
      body: { expected_revision: 2, config: { content: true, ocr: false, transcription: false } },
    },
    {
      input: `${collectionBase}/files?tag=invoice&metadata_key=account_id&metadata_value=%22acme%22&verified_media_type=application%2Fpdf&minimum_size_bytes=10&maximum_size_bytes=1000&created_after=2026-10-01T00%3A00%3A00Z&created_before=2026-10-17T00%3A00%3A00Z&extraction_kind=content&extraction_state=succeeded`,
      method: "GET", operationId: null, body: undefined,
    },
    { input: `${fileBase}/metadata`, method: "GET", operationId: null, body: undefined },
    {
      input: `${fileBase}/metadata`, method: "PUT", operationId,
      body: { expected_revision: 3, metadata: { tags: ["invoice"], custom: { account_id: "acme", retention_years: 7 } } },
    },
    { input: `${fileBase}/versions/${generationId}/extractions/content`, method: "GET", operationId: null, body: undefined },
    { input: `${fileBase}/versions/${generationId}/extracted-content/content`, method: "GET", operationId: null, body: undefined },
  ]);
});

test("media methods preserve collection and immutable generation scope", async () => {
  const calls = [];
  const client = new AlmiraClient({
    credential: "mm_pat_v1.test",
    fetch: async (input, init) => {
      calls.push({ input, init });
      return json(input.endsWith("/derivatives") ? [] : init.method === "GET" ? { jobs: [], next_cursor: null } : { disposition: "applied" });
    },
  });
  const collection = { tenantId, projectId, environmentId, collectionInstanceId };
  await client.getCollectionMedia(collection);
  await client.replaceCollectionMedia(collection, {
    expected_revision: 2,
    config: {
      image_presets: {
        avatar: { widths: [128, 256], height: 256, fit: "cover", formats: ["avif", "webp"], without_enlargement: true },
      },
      document_previews: true,
      video_profile: "web_hls_v1",
    },
  }, { operationId });
  await client.listProcessingJobs(collection, { limit: 25, cursor: "next page" });
  await client.retryProcessingJob({ ...collection, jobId: generationId }, { expected_revision: 3 }, { operationId });
  await client.cancelProcessingJob({ ...collection, jobId: generationId }, { expected_revision: 4 }, { operationId });
  await client.listGenerationDerivatives({ ...collection, entryId, generationId });

  const base = `/v1/projects/${projectId}/environments/${environmentId}/collections/${collectionInstanceId}`;
  assert.deepEqual(calls.map(({ input, init }) => [init.method, input]), [
    ["GET", `${base}/media`],
    ["PUT", `${base}/media`],
    ["GET", `${base}/processing-jobs?limit=25&cursor=next+page`],
    ["POST", `${base}/processing-jobs/${generationId}/retry`],
    ["POST", `${base}/processing-jobs/${generationId}/cancel`],
    ["GET", `${base}/files/${entryId}/versions/${generationId}/derivatives`],
  ]);
  assert(calls.filter(({ init }) => init.method !== "GET")
    .every(({ init }) => init.headers.get("idempotency-key") === operationId));
});

test("protection methods preserve environment, collection, and exact-generation scope", async () => {
  const calls = [];
  const client = new AlmiraClient({
    credential: "mm_pat_v1.test",
    fetch: async (input, init) => {
      calls.push({ input, init });
      if (input.includes("/protection/cases")) return json({ cases: [], next_cursor: null });
      if (input.endsWith("/protection-rescans")) return json({ disposition: "applied", job: {} }, { status: 201 });
      if (input.endsWith("/protection-reviews")) return json({ disposition: "applied", review: {} }, { status: 201 });
      return json(init.method === "PUT"
        ? { disposition: "applied", config: {} }
        : {});
    },
  });
  const environment = { tenantId, projectId, environmentId };
  const collection = { ...environment, collectionInstanceId };
  const generation = { ...collection, entryId, generationId };

  await client.getCollectionProtection(collection);
  await client.replaceCollectionProtection(collection, {
    expected_revision: 2,
    config: { malware_scan_required: true },
  }, { operationId });
  await client.listProtectionCases(environment, {
    collectionInstanceId,
    safetyState: "blocked",
    limit: 25,
    cursor: "next page",
  });
  await client.requestProtectionRescan(generation, { expected_revision: 3 }, { operationId });
  await client.createProtectionReview(generation, {
    expected_revision: 4,
    review: {
      decision: "suspected_false_positive",
      reason: "Escalated for an independent scanner review.",
    },
  }, { operationId });

  const collectionBase = `/v1/projects/${projectId}/environments/${environmentId}/collections/${collectionInstanceId}`;
  const generationBase = `${collectionBase}/files/${entryId}/versions/${generationId}`;
  assert.deepEqual(calls.map(({ input, init }) => ({
    input,
    method: init.method,
    operationId: init.headers.get("idempotency-key"),
    body: init.body === undefined ? undefined : JSON.parse(init.body),
  })), [
    { input: `${collectionBase}/protection`, method: "GET", operationId: null, body: undefined },
    {
      input: `${collectionBase}/protection`, method: "PUT", operationId,
      body: { expected_revision: 2, config: { malware_scan_required: true } },
    },
    {
      input: `/v1/projects/${projectId}/environments/${environmentId}/protection/cases?limit=25&cursor=next+page&collection_instance_id=${collectionInstanceId}&safety_state=blocked`,
      method: "GET", operationId: null, body: undefined,
    },
    {
      input: `${generationBase}/protection-rescans`, method: "POST", operationId,
      body: { expected_revision: 3 },
    },
    {
      input: `${generationBase}/protection-reviews`, method: "POST", operationId,
      body: {
        expected_revision: 4,
        review: {
          decision: "suspected_false_positive",
          reason: "Escalated for an independent scanner review.",
        },
      },
    },
  ]);
});

test("metadata filters fail locally when paired fields or ranges are incoherent", async () => {
  const client = new AlmiraClient({ fetch: async () => assert.fail("invalid filters must not call the API") });
  const reference = { tenantId, projectId, environmentId, collectionInstanceId };
  await assert.rejects(
    client.listFiles(reference, { metadataKey: "account_id" }),
    (error) => error instanceof AlmiraClientError && error.code === "ALMIRA_CLIENT_INPUT_INVALID",
  );
  await assert.rejects(
    client.listFiles(reference, { minimumSizeBytes: 100, maximumSizeBytes: 10 }),
    (error) => error instanceof AlmiraClientError && error.code === "ALMIRA_CLIENT_INPUT_INVALID",
  );
  await assert.rejects(
    client.listFiles(reference, { extractionKind: "content" }),
    (error) => error instanceof AlmiraClientError && error.code === "ALMIRA_CLIENT_INPUT_INVALID",
  );
});

test("file lifecycle methods use stable entry paths and optimistic revisions", async () => {
  const calls = [];
  const client = new AlmiraClient({
    credential: "mm_pat_v1.test",
    fetch: async (input, init) => {
      calls.push({ input, init });
      return json(init.method === "GET"
        ? { generations: [], next_cursor: null }
        : { disposition: "applied" }, { status: init.method === "POST" && input.endsWith("/versions") ? 201 : 200 });
    },
  });
  const reference = { tenantId, projectId, environmentId, collectionInstanceId, entryId };
  await client.createFileVersion(reference, {
    expected_entry_revision: 2,
    expected_size_bytes: 12,
    content_sha256: "b".repeat(64),
    declared_media_type: "text/plain",
  }, { operationId });
  await client.listFileGenerations(reference, { limit: 25, cursor: "next page" });
  await client.renameFile(reference, {
    logical_path: "archive/file.txt",
    expected_revision: 3,
  }, { operationId });
  await client.restoreFileGeneration(reference, {
    generation_id: generationId,
    expected_revision: 4,
  }, { operationId });
  await client.restoreFile(reference, { expected_revision: 5 }, { operationId });
  await client.mutateFilesBatch(
    { tenantId, projectId, environmentId, collectionInstanceId },
    { actions: [
      { action: "rename", entry_id: entryId, logical_path: "archive/final.txt", expected_revision: 6 },
    ] },
    { operationId },
  );
  await client.copyFile(
    { tenantId, projectId, environmentId, collectionInstanceId },
    {
      source_entry_id: entryId,
      source_generation_id: generationId,
      destination_path: "archive/file-copy.txt",
      expected_source_revision: 6,
    },
    { operationId },
  );

  const base = `/v1/projects/${projectId}/environments/${environmentId}/collections/${collectionInstanceId}/files/${entryId}`;
  assert.deepEqual(calls.map(({ input, init }) => ({
    input,
    method: init.method,
    operationId: init.headers.get("idempotency-key"),
    body: init.body === undefined ? undefined : JSON.parse(init.body),
  })), [
    {
      input: `${base}/versions`,
      method: "POST",
      operationId,
      body: {
        expected_entry_revision: 2,
        expected_size_bytes: 12,
        content_sha256: "b".repeat(64),
        declared_media_type: "text/plain",
      },
    },
    { input: `${base}/versions?limit=25&cursor=next+page`, method: "GET", operationId: null, body: undefined },
    { input: base, method: "PATCH", operationId, body: { logical_path: "archive/file.txt", expected_revision: 3 } },
    { input: `${base}/current-generation`, method: "PUT", operationId, body: { generation_id: generationId, expected_revision: 4 } },
    { input: `${base}/restore`, method: "POST", operationId, body: { expected_revision: 5 } },
    {
      input: `/v1/projects/${projectId}/environments/${environmentId}/collections/${collectionInstanceId}/file-batches`,
      method: "POST",
      operationId,
      body: { actions: [{ action: "rename", entry_id: entryId, logical_path: "archive/final.txt", expected_revision: 6 }] },
    },
    {
      input: `/v1/projects/${projectId}/environments/${environmentId}/collections/${collectionInstanceId}/copies`,
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

  await assert.rejects(
    client.mutateFilesBatch(
      { tenantId, projectId, environmentId, collectionInstanceId },
      { actions: [
        { action: "delete", entry_id: entryId, expected_revision: 6 },
        { action: "restore", entry_id: entryId, expected_revision: 7 },
      ] },
      { operationId },
    ),
    (error) => error instanceof AlmiraClientError && error.code === "ALMIRA_CLIENT_INPUT_INVALID",
  );
});

test("recycle listing is management-only", async () => {
  const calls = [];
  const client = new AlmiraClient({
    fetch: async (input) => {
      calls.push(input);
      return json({ entries: [], next_cursor: null });
    },
  });
  const reference = { tenantId, projectId, environmentId, collectionInstanceId };
  await client.listFiles(reference, { includeDeleted: true });
  assert.equal(calls[0], `/v1/projects/${projectId}/environments/${environmentId}/collections/${collectionInstanceId}/files?include_deleted=true`);
  await assert.rejects(
    client.listFiles(reference, { includeDeleted: true, subject: { subject_id: "builder-user" } }),
    (error) => error instanceof AlmiraClientError && error.code === "ALMIRA_CLIENT_INPUT_INVALID",
  );
  assert.equal(calls.length, 1);
});

test("typed API errors expose no response body", async () => {
  const client = new AlmiraClient({
    fetch: async () =>
      json(
        { code: "ALMIRA_AUTHORIZATION_REFUSED", request_id: requestId },
        { status: 403, headers: { "retry-after": "7" } },
      ),
  });

  await assert.rejects(
    client.listEnvironments({ tenantId, projectId }),
    (error) => {
      assert.ok(error instanceof AlmiraApiError);
      assert.equal(error.code, "ALMIRA_AUTHORIZATION_REFUSED");
      assert.equal(error.requestId, requestId);
      assert.equal(error.status, 403);
      assert.equal(error.retryAfterMilliseconds, 7_000);
      assert.equal(error.message, "ALMIRA_AUTHORIZATION_REFUSED");
      return true;
    },
  );
});

test("malformed errors and invalid identifiers fail closed", async () => {
  const malformed = new AlmiraClient({
    fetch: async () => json({ code: "forbidden", detail: "secret" }, { status: 403 }),
  });
  await assert.rejects(
    malformed.listEnvironments({ tenantId, projectId }),
    (error) => error instanceof AlmiraClientError && error.code === "ALMIRA_CLIENT_RESPONSE_INVALID",
  );

  const client = new AlmiraClient({ fetch: async () => assert.fail("must not call fetch") });
  await assert.rejects(
    client.listEnvironments({ tenantId, projectId: "not-a-uuid" }),
    (error) => error instanceof AlmiraClientError && error.code === "ALMIRA_CLIENT_INPUT_INVALID",
  );
});

test("abort and network failure have distinct safe client errors", async () => {
  const controller = new AbortController();
  controller.abort();
  const aborted = new AlmiraClient({
    fetch: async () => {
      throw new DOMException("secret", "AbortError");
    },
  });
  await assert.rejects(
    aborted.listEnvironments({ tenantId, projectId }, { signal: controller.signal }),
    (error) => error instanceof AlmiraClientError && error.code === "ALMIRA_CLIENT_ABORTED",
  );

  const failed = new AlmiraClient({
    fetch: async () => {
      throw new Error("socket contained a secret");
    },
  });
  await assert.rejects(
    failed.listEnvironments({ tenantId, projectId }),
    (error) => error instanceof AlmiraClientError && error.code === "ALMIRA_CLIENT_NETWORK",
  );
});

test("credential-provider failures do not expose provider errors", async () => {
  const client = new AlmiraClient({
    credential: async () => {
      throw new Error("secret from vault");
    },
    fetch: async () => assert.fail("must not call fetch"),
  });
  await assert.rejects(
    client.listEnvironments({ tenantId, projectId }),
    (error) =>
      error instanceof AlmiraClientError &&
      error.code === "ALMIRA_CLIENT_CREDENTIAL_UNAVAILABLE" &&
      error.message === "ALMIRA_CLIENT_CREDENTIAL_UNAVAILABLE",
  );
});
