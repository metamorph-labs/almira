# Almira for Codex

This plugin gives Codex the Almira management MCP server and the `build-with-almira` integration
skill. It is for coding agents working on a user's application; it does not add an application
builder or deployment agent.

Set `ALMIRA_BASE_URL` and a scoped `METAMORPH_TOKEN` in the Codex host environment before enabling
the plugin. The token may be a PAT or SAK for setup work. Application runtimes use short-lived
Metamorph workload evidence instead.

The MCP server package is pinned in `.mcp.json`. One-use direct-transfer capabilities remain in the
application or MCP process and are never returned in model context. Governed imports accept only
opaque FileService bindings and safe manifests; portable-export downloads produce verified new
local files without exposing signed URLs or overwriting existing paths.

The management catalog includes collection protection, safe scan-case inspection, exact-generation
rescan, and content-free review tools. FileService remains authoritative for verdicts and
quarantine; the plugin has no release or verdict-override tool.

CDN setup remains provider-neutral. The catalog can replace collection delivery configuration,
enqueue a replay-safe collection-wide cache purge, and read its bounded diagnostic; it never
exposes CDN credentials or raw provider receipts.

The verification tool accepts only bounded replay evidence for an existing canary upload. Almira
exercises finalize retry, exact private bytes, cross-environment refusal and the safety gate before
issuing an Ed25519-signed receipt. The plugin never treats resource creation alone as success.
