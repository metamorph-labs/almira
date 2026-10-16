import assert from "node:assert/strict";
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
