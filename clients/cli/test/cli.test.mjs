import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { runCli } from "../dist/cli.js";

const projectId = "018f0000-0000-7000-8000-000000000003";
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
  ALMIRA_BASE_URL: "https://almira.test/platform/almira",
  METAMORPH_TOKEN: "pat_secret",
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

test("project bootstrap generates a replayable operation ID and JSON only", async () => {
  const stream = io();
  let request;
  const exitCode = await runCli(["project", "bootstrap", "--project", projectId], {
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
  assert.equal(request.init.headers.get("authorization"), "Bearer pat_secret");
});

test("collection creation uses predictable noun/verb arguments", async () => {
  const stream = io();
  const exitCode = await runCli(
    [
      "collection", "create",
      "--project", projectId,
      "--environment", environmentId,
      "--key", "assets",
      "--display", "Assets",
      "--scan", "required",
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
        });
        return json({ disposition: "applied", collection: {} }, 201);
      },
    },
  );
  assert.equal(exitCode, 0);
  assert.equal(JSON.parse(stream.output.stdout.join("")).operation_id, operationId);
});

test("credentials are not accepted as command-line options", async () => {
  const stream = io();
  const exitCode = await runCli(
    ["environment", "list", "--project", projectId, "--token", "secret"],
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
    ["environment", "list", "--project", projectId, "--entry", operationId],
    { environment, io: stream.value, fetch: async () => assert.fail("no request") },
  );
  assert.equal(exitCode, 2);
  assert.equal(JSON.parse(stream.output.stderr.join("")).code, "ALMIRA_CLI_USAGE_INVALID");
});

test("missing connection configuration is actionable and distinct from usage", async () => {
  const stream = io();
  const exitCode = await runCli(["environment", "list", "--project", projectId], {
    environment: { METAMORPH_TOKEN: "pat_secret" },
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
  const exitCode = await runCli(["environment", "list", "--project", projectId], {
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
