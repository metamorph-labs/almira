import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const releasePackage = JSON.parse(await readFile("clients/mcp/package.json", "utf8"));
const packageSpec = `${releasePackage.name}@${releasePackage.version}`;
const metamorphPackageSpec = "@metamorph-labs/metamorph-tools@0.1.0-dev.0";

const codexRoot = "plugins/codex/almira";
const claudeRoot = "plugins/claude-code/almira";

const codexManifest = await readJson(`${codexRoot}/.codex-plugin/plugin.json`);
const codexMcp = await readJson(`${codexRoot}/.mcp.json`);
const claudeManifest = await readJson(`${claudeRoot}/.claude-plugin/plugin.json`);
const claudeMcp = await readJson(`${claudeRoot}/.mcp.json`);

for (const manifest of [codexManifest, claudeManifest]) {
  assert.equal(manifest.name, "almira");
  assert.equal(manifest.version, releasePackage.version);
  assert.equal(manifest.license, "Apache-2.0");
  assert.equal(manifest.author?.name, "Metamorph Labs");
}

assert.deepEqual(codexMcp.mcpServers?.almira?.args, ["--yes", packageSpec]);
assert.deepEqual(codexMcp.mcpServers?.almira?.env_vars, ["ALMIRA_BASE_URL", "METAMORPH_TOKEN"]);
assert.deepEqual(codexMcp.mcpServers?.metamorph?.args, ["--yes", metamorphPackageSpec]);
assert.deepEqual(codexMcp.mcpServers?.metamorph?.env_vars, ["METAMORPH_BASE_URL"]);
assert.deepEqual(claudeMcp.mcpServers?.almira?.args, ["--yes", packageSpec]);
assert.deepEqual(claudeMcp.mcpServers?.almira?.env, {
  ALMIRA_BASE_URL: "${ALMIRA_BASE_URL}",
  METAMORPH_TOKEN: "${METAMORPH_TOKEN}",
});
assert.deepEqual(claudeMcp.mcpServers?.metamorph?.args, ["--yes", metamorphPackageSpec]);
assert.deepEqual(claudeMcp.mcpServers?.metamorph?.env, {
  METAMORPH_BASE_URL: "${METAMORPH_BASE_URL}",
});

const codexSkill = await readFile(`${codexRoot}/skills/build-with-almira/SKILL.md`, "utf8");
const claudeSkill = await readFile(`${claudeRoot}/skills/build-with-almira/SKILL.md`, "utf8");
assert.equal(claudeSkill, codexSkill, "Codex and Claude Code integration guidance must not drift");

for (const contents of [
  JSON.stringify(codexManifest),
  JSON.stringify(codexMcp),
  JSON.stringify(claudeManifest),
  JSON.stringify(claudeMcp),
  codexSkill,
]) {
  assert.equal(contents.includes("[TODO:"), false, "plugin assets must not contain scaffold placeholders");
}

console.log(`Almira agent plugins are valid and use ${packageSpec}.`);

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
