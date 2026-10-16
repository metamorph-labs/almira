import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  acceptBundle,
  assertCompatible,
  compareVersions,
  verifyBundle,
} from "./bundle.mjs";

const repositoryContracts = fileURLToPath(new URL("../../contracts/", import.meta.url));

function manifest(version, digest, paths = ["bundle.schema.json", "release.json"]) {
  return {
    formatVersion: 1,
    product: "almira",
    contractVersion: version,
    source: { repository: "metamorph-labs/almira-core", algorithm: "sha256", digest },
    bundle: { algorithm: "sha256", digest },
    files: paths.map((path) => ({ path, size: 1, digest: "a".repeat(64) })),
  };
}

test("semantic version comparison handles prereleases", () => {
  assert.ok(compareVersions("0.1.0-dev.2", "0.1.0-dev.1") > 0);
  assert.ok(compareVersions("0.1.0", "0.1.0-dev.9") > 0);
  assert.ok(compareVersions("1.0.0", "0.99.99") > 0);
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
});

test("content cannot change without a version change", () => {
  assert.throws(
    () => assertCompatible(manifest("0.1.0", "a".repeat(64)), manifest("0.1.0", "b".repeat(64))),
    /without changing contractVersion/u,
  );
});

test("files cannot disappear within a compatibility line", () => {
  assert.throws(
    () =>
      assertCompatible(
        manifest("0.1.0", "a".repeat(64), ["bundle.schema.json", "release.json", "x.json"]),
        manifest("0.1.1", "b".repeat(64)),
      ),
    /removes files within a compatibility line/u,
  );
});

test("a new pre-1.0 minor line may deliberately break", () => {
  assert.doesNotThrow(() =>
    assertCompatible(
      manifest("0.1.9", "a".repeat(64), ["bundle.schema.json", "release.json", "x.json"]),
      manifest("0.2.0", "b".repeat(64)),
    ),
  );
});

test("the installed bundle verifies independently", async () => {
  const verified = await verifyBundle(repositoryContracts);
  assert.equal(verified.source.repository, "metamorph-labs/almira-core");
});

test("tampering with an artifact is rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "almira-public-contract-test-"));
  try {
    await cp(repositoryContracts, root, { recursive: true });
    const releasePath = join(root, "release.json");
    const release = JSON.parse(await readFile(releasePath, "utf8"));
    release.stability = "tampered";
    await writeFile(releasePath, `${JSON.stringify(release)}\n`);
    await assert.rejects(verifyBundle(root), /digest mismatch/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a verified candidate installs without depending on private source", async () => {
  const root = await mkdtemp(join(tmpdir(), "almira-public-contract-accept-"));
  const destination = join(root, "contracts");
  try {
    const accepted = await acceptBundle(repositoryContracts, destination);
    const verified = await verifyBundle(destination);
    assert.equal(accepted.bundle.digest, verified.bundle.digest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unlisted files are rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "almira-public-contract-extra-"));
  try {
    await cp(repositoryContracts, root, { recursive: true });
    await writeFile(join(root, "extra.json"), "{}\n");
    await assert.rejects(verifyBundle(root), /missing or unlisted files/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
