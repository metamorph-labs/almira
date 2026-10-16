import { createHash } from "node:crypto";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const installedBundleRoot = join(repositoryRoot, "contracts");
const digestPattern = /^[a-f0-9]{64}$/u;
const publicPathPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const versionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z.-]+))?$/u;

const forbiddenPathSegments = new Set([
  "deploy",
  "internal",
  "qualification",
  "registrations",
]);

const forbiddenContent = [
  { label: "private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u },
  { label: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u },
  { label: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/u },
  { label: "database URL", pattern: /\bpostgres(?:ql)?:\/\//iu },
  { label: "provider coordinate", pattern: /\b(?:s3|gs|az):\/\//iu },
  {
    label: "provider endpoint",
    pattern: /https:\/\/[^\s"']*(?:\.amazonaws\.com|\.blob\.core\.windows\.net|storage\.googleapis\.com)/iu,
  },
  { label: "internal HTTP route", pattern: /["'`]\/internal\//u },
  { label: "internal extension", pattern: /\bx-metamorph-internal\b/iu },
  {
    label: "credential-bearing field",
    pattern: /(?:^|[\s"'])(?:access_key|client_secret|private_key|provider_credentials|secret_key)["']?\s*[:=]/imu,
  },
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function listFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolutePath = join(current, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`contract bundle cannot contain symlink: ${relative(root, absolutePath)}`);
    }
    if (entry.isDirectory()) {
      files.push(...(await listFiles(root, absolutePath)));
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`contract bundle contains unsupported entry: ${relative(root, absolutePath)}`);
    }
    files.push({
      absolutePath,
      path: relative(root, absolutePath).split(sep).join("/"),
    });
  }
  return files;
}

function parseVersion(value) {
  const match = versionPattern.exec(value ?? "");
  if (!match) {
    throw new Error(`invalid contract version: ${value}`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split(".") ?? [],
  };
}

function compareIdentifiers(left, right) {
  const leftNumeric = /^\d+$/u.test(left);
  const rightNumeric = /^\d+$/u.test(right);
  if (leftNumeric && rightNumeric) {
    return Number(left) - Number(right);
  }
  if (leftNumeric !== rightNumeric) {
    return leftNumeric ? -1 : 1;
  }
  return left.localeCompare(right);
}

export function compareVersions(leftValue, rightValue) {
  const left = parseVersion(leftValue);
  const right = parseVersion(rightValue);
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) {
      return left[key] - right[key];
    }
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === right.prerelease.length
      ? 0
      : left.prerelease.length === 0
        ? 1
        : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) {
      return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1;
    }
    const compared = compareIdentifiers(leftPart, rightPart);
    if (compared !== 0) {
      return compared;
    }
  }
  return 0;
}

function compatibilityLine(version) {
  const parsed = parseVersion(version);
  return parsed.major === 0 ? `0.${parsed.minor}` : `${parsed.major}`;
}

function inspectPath(path) {
  if (path === "manifest.json") {
    throw new Error("manifest.json cannot list itself");
  }
  if (!publicPathPattern.test(path)) {
    throw new Error(`contract path contains unsupported characters: ${path}`);
  }
  if (path.startsWith("/") || path.includes("\\")) {
    throw new Error(`unsafe contract path: ${path}`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`unsafe contract path: ${path}`);
  }
  const forbidden = segments
    .map((segment) => segment.toLowerCase())
    .find((segment) => forbiddenPathSegments.has(segment));
  if (forbidden) {
    throw new Error(`contract path contains forbidden private segment '${forbidden}': ${path}`);
  }
}

function inspectContent(path, bytes) {
  if (bytes.includes(0)) {
    return;
  }
  const text = bytes.toString("utf8");
  for (const rule of forbiddenContent) {
    if (rule.pattern.test(text)) {
      throw new Error(`contract ${path} contains forbidden ${rule.label}`);
    }
  }
}

function validateManifestShape(manifest) {
  if (manifest.formatVersion !== 1 || manifest.product !== "almira") {
    throw new Error("unsupported contract bundle identity or format");
  }
  parseVersion(manifest.contractVersion);
  if (
    manifest.source?.repository !== "metamorph-labs/almira-core" ||
    manifest.source?.algorithm !== "sha256" ||
    !digestPattern.test(manifest.source?.digest ?? "")
  ) {
    throw new Error("invalid or untrusted contract bundle source");
  }
  if (
    manifest.bundle?.algorithm !== "sha256" ||
    !digestPattern.test(manifest.bundle?.digest ?? "")
  ) {
    throw new Error("invalid contract bundle digest declaration");
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error("contract bundle must declare at least one file");
  }
}

export async function verifyBundle(rootArgument = installedBundleRoot) {
  const root = resolve(rootArgument);
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  validateManifestShape(manifest);

  const declaredPaths = [];
  const seen = new Set();
  for (const file of manifest.files) {
    if (
      typeof file?.path !== "string" ||
      !Number.isSafeInteger(file?.size) ||
      file.size < 0 ||
      !digestPattern.test(file?.digest ?? "")
    ) {
      throw new Error("contract manifest contains an invalid file record");
    }
    inspectPath(file.path);
    if (seen.has(file.path)) {
      throw new Error(`contract manifest contains duplicate path: ${file.path}`);
    }
    seen.add(file.path);
    declaredPaths.push(file.path);

    const absolutePath = resolve(root, file.path);
    if (!absolutePath.startsWith(`${root}${sep}`)) {
      throw new Error(`contract path escapes bundle root: ${file.path}`);
    }
    const stats = await lstat(absolutePath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`contract artifact is not a regular file: ${file.path}`);
    }
    const bytes = await readFile(absolutePath);
    inspectContent(file.path, bytes);
    if (bytes.length !== file.size || sha256(bytes) !== file.digest) {
      throw new Error(`contract artifact digest mismatch: ${file.path}`);
    }
  }

  const sortedPaths = [...declaredPaths].sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(declaredPaths) !== JSON.stringify(sortedPaths)) {
    throw new Error("contract manifest file records must be sorted");
  }

  const actualFiles = (await listFiles(root))
    .map((entry) => entry.path)
    .filter((path) => path !== "manifest.json")
    .sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(actualFiles) !== JSON.stringify(sortedPaths)) {
    throw new Error("contract bundle contains missing or unlisted files");
  }

  const digestInput = manifest.files
    .map((file) => `${file.path}\0${file.size}\0${file.digest}\n`)
    .join("");
  const digest = sha256(digestInput);
  if (manifest.bundle.digest !== digest || manifest.source.digest !== digest) {
    throw new Error("contract bundle aggregate digest mismatch");
  }

  const release = JSON.parse(await readFile(join(root, "release.json"), "utf8"));
  if (release.contractVersion !== manifest.contractVersion) {
    throw new Error("release.json and manifest contract versions differ");
  }
  if (!seen.has("bundle.schema.json")) {
    throw new Error("contract bundle is missing its manifest schema");
  }
  return manifest;
}

export function assertCompatible(current, candidate) {
  if (current.formatVersion !== candidate.formatVersion || current.product !== candidate.product) {
    throw new Error("candidate changes the contract bundle identity or format");
  }
  const order = compareVersions(candidate.contractVersion, current.contractVersion);
  if (order < 0) {
    throw new Error("candidate contract version is older than the installed version");
  }
  if (order === 0 && candidate.bundle.digest !== current.bundle.digest) {
    throw new Error("candidate changes content without changing contractVersion");
  }
  if (
    order > 0 &&
    compatibilityLine(candidate.contractVersion) === compatibilityLine(current.contractVersion)
  ) {
    const candidatePaths = new Set(candidate.files.map((file) => file.path));
    const removed = current.files
      .map((file) => file.path)
      .filter((path) => !candidatePaths.has(path));
    if (removed.length > 0) {
      throw new Error(
        `candidate removes files within a compatibility line: ${removed.join(", ")}`,
      );
    }
  }
}

async function copyBundle(sourceRoot, destinationRoot, manifest) {
  for (const path of [...manifest.files.map((file) => file.path), "manifest.json"]) {
    const destination = join(destinationRoot, path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(sourceRoot, path), destination);
  }
}

export async function acceptBundle(candidateArgument, destinationRoot = installedBundleRoot) {
  if (!candidateArgument) {
    throw new Error("contracts:accept requires a candidate bundle directory");
  }
  const candidateRoot = resolve(candidateArgument);
  const candidate = await verifyBundle(candidateRoot);
  let current;
  if (await exists(destinationRoot)) {
    current = await verifyBundle(destinationRoot);
    assertCompatible(current, candidate);
    if (current.bundle.digest === candidate.bundle.digest) {
      return candidate;
    }
  }

  const parent = dirname(destinationRoot);
  await mkdir(parent, { recursive: true });
  const stage = await mkdtemp(join(parent, ".contracts-stage-"));
  const backup = join(parent, `.contracts-backup-${process.pid}`);
  let movedCurrent = false;
  try {
    await copyBundle(candidateRoot, stage, candidate);
    await verifyBundle(stage);
    if (await exists(destinationRoot)) {
      await rename(destinationRoot, backup);
      movedCurrent = true;
    }
    await rename(stage, destinationRoot);
    if (movedCurrent) {
      await rm(backup, { recursive: true, force: true });
    }
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    if (movedCurrent && !(await exists(destinationRoot))) {
      await rename(backup, destinationRoot);
    }
    throw error;
  }
  return candidate;
}

async function main() {
  const [command, argument] = process.argv.slice(2);
  if (command === "verify") {
    const manifest = await verifyBundle(argument ?? installedBundleRoot);
    console.log(`verified ${manifest.contractVersion} (${manifest.bundle.digest})`);
    return;
  }
  if (command === "accept") {
    const manifest = await acceptBundle(argument);
    console.log(`accepted ${manifest.contractVersion} (${manifest.bundle.digest})`);
    return;
  }
  throw new Error("usage: bundle.mjs <verify [directory]|accept candidate-directory>");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
