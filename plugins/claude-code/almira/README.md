# Almira for Claude Code

This plugin gives Claude Code the Almira management MCP server and the namespaced
`/almira:build-with-almira` integration skill. It is for coding agents working on a user's
application; it does not add an application builder or deployment agent.

Set `ALMIRA_BASE_URL` and a scoped `METAMORPH_TOKEN` before loading the plugin. The token may be a
PAT or SAK for setup work. Application runtimes use short-lived Metamorph workload evidence
instead.

For local development, load this directory with `claude --plugin-dir <path>`. The MCP server package
is pinned in `.mcp.json`; Claude Code prompts before trusting project/plugin MCP configuration.

Governed imports accept only opaque FileService source bindings and bounded safe manifests.
Each declared local object is streamed with the import-upload tool, without returning bytes or
provider grants to model context.
Portable-export downloads consume their one-use bearer inside the MCP process and return a
verified new local-file receipt; signed URLs, headers and bytes never enter model context, and an
existing destination is never overwritten.

The management catalog includes collection protection, safe scan-case inspection, exact-generation
rescan, and content-free review tools. FileService remains authoritative for verdicts and
quarantine; the plugin has no release or verdict-override tool.

CDN setup remains provider-neutral. The catalog can replace collection delivery configuration,
enqueue a replay-safe collection-wide cache purge, and read its bounded diagnostic; it never
exposes CDN credentials or raw provider receipts.

The verification tool accepts only bounded replay evidence for an existing canary upload. Almira
exercises finalize retry, exact private bytes, cross-environment refusal and the safety gate before
issuing an Ed25519-signed receipt. The plugin never treats resource creation alone as success.
