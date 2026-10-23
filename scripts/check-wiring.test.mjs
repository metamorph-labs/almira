import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { clientCalls, operationIds, validatePublicWiring } from "./check-wiring.mjs";

test("extracts only canonical contract operations and client calls", () => {
  assert.deepEqual(
    operationIds({ paths: { "/v1/example": { get: { operationId: "getExample" } } } }),
    ["getExample"],
  );
  assert.deepEqual([...clientCalls("client.getExample(); other.getIgnored();")], ["getExample"]);
});

test("the promoted public caller graph is completely wired", async () => {
  const inputs = await repositoryInputs();
  assert.deepEqual(validatePublicWiring(inputs), {
    managementOperations: 74,
    dataOperations: 7,
    workloadOperations: 9,
    externalAgentOperations: 62,
    publicLanguages: 4,
    plugins: 2,
  });
});

test("rejects a promoted operation missing from a language client", async () => {
  const inputs = await repositoryInputs();
  inputs.dataContract = structuredClone(inputs.dataContract);
  inputs.dataContract.paths["/v1/missing"] = { get: { operationId: "getMissing" } };
  assert.throws(
    () => validatePublicWiring(inputs),
    /TypeScript data SDK is missing getMissing/u,
  );
});

async function repositoryInputs() {
  const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
  const [
    managementContract,
    dataContract,
    typescriptManagement,
    typescriptData,
    pythonData,
    pythonServer,
    goData,
    goServer,
    rustData,
    rustServer,
    cli,
    mcp,
    mcpPackage,
    release,
    codexPlugin,
    claudePlugin,
    example,
  ] = await Promise.all([
    read("contracts/openapi.v1.json").then(JSON.parse),
    read("contracts/data-openapi.v1.json").then(JSON.parse),
    read("sdks/typescript/src/client.ts"),
    read("sdks/typescript/src/data-client.ts"),
    read("sdks/python/src/almira/client.py"),
    read("sdks/python/src/almira/server.py"),
    read("sdks/go/client.go"),
    read("sdks/go/server.go"),
    read("sdks/rust/src/client.rs"),
    read("sdks/rust/src/server.rs"),
    read("clients/cli/src/cli.ts"),
    read("clients/mcp/src/server.ts"),
    read("clients/mcp/package.json"),
    read("contracts/release.json").then(JSON.parse),
    read("plugins/codex/almira/.mcp.json"),
    read("plugins/claude-code/almira/.mcp.json"),
    read("examples/node-upload/src/upload.ts"),
  ]);
  return {
    managementContract,
    dataContract,
    typescriptManagement,
    typescriptData,
    pythonData,
    pythonServer,
    goData,
    goServer,
    rustData,
    rustServer,
    cli,
    mcp,
    mcpPackage,
    release,
    plugins: [codexPlugin, claudePlugin],
    example,
  };
}
