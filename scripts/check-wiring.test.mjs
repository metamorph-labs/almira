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
    managementOperations: 83,
    dataOperations: 7,
    workloadOperations: 10,
    externalAgentOperations: 70,
    publicLanguages: 11,
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
    javaData,
    javaServer,
    javaTransfer,
    javaWebhook,
    javaWire,
    kotlin,
    dotnetData,
    dotnetServer,
    dotnetTransfer,
    dotnetWebhook,
    swiftData,
    swiftServer,
    swiftTransfer,
    php,
    dartData,
    dartServer,
    ruby,
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
    read("sdks/java/src/main/java/com/metamorph/almira/AlmiraDataClient.java"),
    read("sdks/java/src/main/java/com/metamorph/almira/AlmiraServerClient.java"),
    read("sdks/java/src/main/java/com/metamorph/almira/DirectTransfer.java"),
    read("sdks/java/src/main/java/com/metamorph/almira/WebhookVerifier.java"),
    read("sdks/java/src/main/java/com/metamorph/almira/Wire.java"),
    read("sdks/kotlin/src/main/kotlin/com/metamorph/almira/kotlin/Almira.kt"),
    read("sdks/dotnet/Metamorph.Almira/Almira.cs"),
    read("sdks/dotnet/Metamorph.Almira/AlmiraServerClient.cs"),
    read("sdks/dotnet/Metamorph.Almira/DirectTransfer.cs"),
    read("sdks/dotnet/Metamorph.Almira/WebhookVerifier.cs"),
    read("sdks/swift/Sources/Almira/Almira.swift"),
    read("sdks/swift/Sources/AlmiraServer/AlmiraServerClient.swift"),
    read("sdks/swift/Sources/Almira/DirectTransfer.swift"),
    read("sdks/php/src/Almira.php"),
    read("sdks/dart/lib/almira.dart"),
    read("sdks/dart/lib/almira_server.dart"),
    read("sdks/ruby/lib/almira.rb"),
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
    javaData: `${javaData}\n${javaTransfer}\n${javaWire}`,
    javaServer: `${javaServer}\n${javaWebhook}`,
    kotlinData: kotlin,
    kotlinServer: kotlin,
    dotnetData: `${dotnetData}\n${dotnetTransfer}`,
    dotnetServer: `${dotnetServer}\n${dotnetWebhook}`,
    swiftData: `${swiftData}\n${swiftTransfer}`,
    swiftServer,
    phpData: php,
    phpServer: php,
    dartData,
    dartServer,
    rubyData: ruby,
    rubyServer: ruby,
  };
}
