import { readFile } from "node:fs/promises";
import { access } from "node:fs/promises";

const required = [
  "AGENTS.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "NOTICE",
  "README.md",
  "SECURITY.md",
  "package.json",
  "pnpm-workspace.yaml",
  "rust-toolchain.toml",
];

await Promise.all(required.map((path) => access(path)));

const packageManifest = JSON.parse(await readFile("package.json", "utf8"));
if (packageManifest.packageManager !== "pnpm@11.0.9") {
  throw new Error("package.json must pin pnpm 11.0.9");
}
if (packageManifest.engines?.node !== "24.19.0") {
  throw new Error("package.json must pin Node.js 24.19.0");
}
if (packageManifest.license !== "Apache-2.0") {
  throw new Error("the public workspace must use Apache-2.0");
}

const toolchain = await readFile("rust-toolchain.toml", "utf8");
if (!toolchain.includes('channel = "1.98.1"')) {
  throw new Error("rust-toolchain.toml must pin Rust 1.98.1");
}

const readme = await readFile("README.md", "utf8");
if (!readme.includes("public developer repository")) {
  throw new Error("README.md must identify the public repository boundary");
}

console.log("Almira public repository foundation is valid.");
