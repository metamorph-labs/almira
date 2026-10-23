import { readFile } from "node:fs/promises";

const managementContractPath = "contracts/openapi.v1.json";
const dataContractPath = "contracts/data-openapi.v1.json";

const workloadOperations = new Set([
  "bindSubject",
  "createCapabilitySession",
  "createUpload",
  "createUploadPart",
  "finalizeUpload",
  "listSubjectBindings",
  "readSubjectLifecycleOperation",
  "revokeCapabilitySession",
  "startSubjectLifecycleOperation",
]);

const sdkOnlyManagementOperations = new Set([
  ...workloadOperations,
  "createFileVersion",
  "getVerificationPublicKeys",
  "readPrivateFile",
]);

export function operationIds(document) {
  const result = [];
  for (const pathItem of Object.values(document.paths ?? {})) {
    for (const method of ["get", "post", "put", "patch", "delete", "options"]) {
      const operation = pathItem[method];
      if (operation === undefined) continue;
      if (typeof operation.operationId !== "string" || operation.operationId.length === 0) {
        throw new Error("every public operation must have an operationId");
      }
      result.push(operation.operationId);
    }
  }
  assertUnique(result, "public operationId");
  return result;
}

export function clientCalls(source) {
  return new Set([...source.matchAll(/\bclient\.([A-Za-z][A-Za-z0-9]*)\s*\(/gu)].map((match) => match[1]));
}

export function validatePublicWiring(inputs) {
  const management = operationIds(inputs.managementContract);
  const data = operationIds(inputs.dataContract);
  assertMethods(inputs.typescriptManagement, management, "typescript", "TypeScript management SDK");
  assertMethods(inputs.typescriptData, data, "typescript", "TypeScript data SDK");
  assertMethods(inputs.pythonData, data, "python", "Python data SDK");
  assertMethods(inputs.goData, data, "go", "Go data SDK");
  assertMethods(inputs.rustData, data, "rust", "Rust data SDK");

  const applicationOperations = management.filter((name) => workloadOperations.has(name));
  if (applicationOperations.length !== workloadOperations.size) {
    throw new Error("workload operation classification drifted from the management contract");
  }
  assertMethods(inputs.typescriptManagement, applicationOperations, "typescript", "TypeScript server SDK");
  assertMethods(inputs.pythonServer, applicationOperations, "python", "Python server SDK");
  assertMethods(inputs.goServer, applicationOperations, "go", "Go server SDK");
  assertMethods(inputs.rustServer, applicationOperations, "rust", "Rust server SDK");

  const externalAgentOperations = new Set(
    management.filter((name) => !sdkOnlyManagementOperations.has(name)),
  );
  if (externalAgentOperations.size !== 59) {
    throw new Error(`external-agent operation classification drifted: ${externalAgentOperations.size}`);
  }
  assertSetEqual(clientCalls(inputs.cli), externalAgentOperations, "CLI operations");
  assertSetEqual(clientCalls(inputs.mcp), externalAgentOperations, "MCP operations");

  const mcpVersion = JSON.parse(inputs.mcpPackage).version;
  const releaseVersion = inputs.release.contractVersion;
  if (mcpVersion !== releaseVersion || !inputs.mcp.includes(`version: "${releaseVersion}"`)) {
    throw new Error("MCP runtime version drifted from the promoted release");
  }
  for (const plugin of inputs.plugins) {
    if (!plugin.includes(`@metamorph-labs/almira-mcp@${mcpVersion}`)) {
      throw new Error("an agent plugin is not pinned to the reachable MCP package");
    }
  }
  for (const required of [
    "client.createUpload(",
    "uploadDirect(",
    "client.finalizeUpload(",
    "client.createVerificationReceipt(",
    "client.deleteFile(",
  ]) {
    if (!inputs.example.includes(required)) {
      throw new Error(`the executable example does not reach ${required}`);
    }
  }

  return {
    managementOperations: management.length,
    dataOperations: data.length,
    workloadOperations: applicationOperations.length,
    externalAgentOperations: externalAgentOperations.size,
    publicLanguages: 4,
    plugins: inputs.plugins.length,
  };
}

function assertMethods(source, names, language, label) {
  const missing = names.filter((name) => !methodPattern(name, language).test(source));
  if (missing.length !== 0) throw new Error(`${label} is missing ${missing.sort().join(", ")}`);
}

function methodPattern(name, language) {
  if (language === "typescript") return new RegExp(`\\basync\\s+${name}\\s*\\(`, "u");
  if (language === "python") return new RegExp(`\\bdef\\s+${camelToSnake(name)}\\s*\\(`, "u");
  if (language === "go") return new RegExp(`\\b${upperFirst(name)}\\s*\\(`, "u");
  if (language === "rust") return new RegExp(`\\bfn\\s+${camelToSnake(name)}\\s*\\(`, "u");
  throw new Error(`unknown language ${language}`);
}

function camelToSnake(value) {
  return value.replaceAll(/([a-z0-9])([A-Z])/gu, "$1_$2").toLowerCase();
}

function upperFirst(value) {
  return `${value[0].toUpperCase()}${value.slice(1)}`;
}

function assertUnique(values, label) {
  if (new Set(values).size !== values.length) throw new Error(`${label} is duplicated`);
}

function assertSetEqual(actual, expected, label) {
  const missing = [...expected].filter((value) => !actual.has(value));
  const extra = [...actual].filter((value) => !expected.has(value));
  if (missing.length !== 0 || extra.length !== 0) {
    throw new Error(`${label} drifted; missing=[${missing.sort()}], extra=[${extra.sort()}]`);
  }
}

async function read(path) {
  return readFile(path, "utf8");
}

async function main() {
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
    read(managementContractPath).then(JSON.parse),
    read(dataContractPath).then(JSON.parse),
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
  const result = validatePublicWiring({
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
  });
  console.log(
    `Almira public wiring is closed: ${result.managementOperations} management operations, ` +
      `${result.dataOperations} data operations, ${result.workloadOperations} workload operations, ` +
      `${result.externalAgentOperations} CLI/MCP operations, ${result.publicLanguages} SDK languages, ` +
      `${result.plugins} agent plugins.`,
  );
}

if (process.argv[1]?.endsWith("/scripts/check-wiring.mjs")) await main();
