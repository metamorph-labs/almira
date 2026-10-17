# Almira

This is the public developer repository for Almira, Metamorph's application file-storage and media
delivery product.

It contains the open-source application SDKs, released schemas, CLI, MCP server, Codex and Claude
Code plugins, and examples. Almira's backend, console, embedded helper, deployment assets, platform
registrations, product architecture and private qualification evidence live in the private
`almira-core` repository and are not mirrored here.

The repository is licensed under [Apache-2.0](LICENSE). Packages are added only with an
independently buildable client or contract slice; empty future SDK/client scaffolding is not kept
here.

Released public contracts are installed under [`contracts/`](contracts/) from a deterministic,
digest-bound bundle produced by `almira-core`. Run `pnpm contracts:verify` to verify the installed
bundle independently; see [`AGENTS.md`](AGENTS.md) before proposing a contract change.

Declarative setup uses the closed [`almira.yaml`](examples/almira.yaml) v1 format. Preview is
read-only and additive; apply preserves unlisted resources and executes the same scoped operations
available individually through the SDK, CLI, MCP server, and console. A class-only collection
change starts the same governed, resumable storage migration exposed by those surfaces.
Collection malware policy is equally declarative: changing it affects new generations only, while
an exact-generation rescan immediately gates delivery until FileService returns a clean verdict.

The dependency-light TypeScript client is in [`sdks/typescript`](sdks/typescript). It covers every
operation in the promoted contract and supports same-origin browser sessions, PATs, SAKs and
short-lived workload evidence through the standard Fetch API. Its separate `AlmiraDataClient`
accepts only end-user capability tokens and exposes capability-backed metadata, immutable CDN
generation reads, and share reads without admitting management credentials. Run `pnpm check` for
the complete local repository gate.

The Python 3.11+ application data SDK is in [`sdks/python`](sdks/python). It covers the promoted
capability-only data-plane contract exactly, streams immutable generation and derivative responses,
keeps share reads credential-free, and has no runtime dependency outside the Python standard
library.

The dependency-free Go 1.23+ application data SDK is in [`sdks/go`](sdks/go). It provides typed
metadata and search results, complete structured filtering, safe capability providers and closable
streaming bodies while preserving the same capability-only and credential-free-share boundaries.

The first management commands are in [`clients/cli`](clients/cli). The CLI uses predictable
noun/verb commands, JSON-only stdout, stable exit codes and environment-backed credentials; it
shares the SDK transport instead of implementing a second API client. Stable file identities can
be listed with their immutable generations, renamed without copying bytes, switched to a retained
generation, moved into a bounded recycle window, and restored while that window remains open.
Each collection has a 1–3650 day recycle-retention policy (30 days by default); a replacement
applies to future deletions and never silently rewrites an existing entry's deadline.
Bounded lifecycle batches apply up to 100 independent rename, generation-selection, recycle, or
restore actions atomically with optimistic revisions and exact replay.
Collections expose mandatory safe technical extraction plus explicit content, OCR and transcription
controls. Collection protection, environment-wide scan cases, exact-generation rescans and
content-free administrative reviews are available across the SDK, CLI, MCP server and console.
FileService remains the scan/quarantine authority; a review cannot release or override content and
there is intentionally no release operation. Bounded customer metadata and exact structured
filters are available across every surface; protected extracted text remains behind its distinct
authorization.

Governed collection imports use only an opaque FileService source binding and a bounded safe
manifest—never cloud credentials, buckets, endpoints, or target coordinates. Portable exports
contain retained generations and derivatives that remain available and safety-admitted. Their
one-use download bearer is consumed only by the SDK transfer helper, CLI, or MCP process; CLI/MCP
return a verified local-file receipt without placing the bearer in model context.

The stdio MCP server is in [`clients/mcp`](clients/mcp). It presents the same bounded management
slice to external coding agents, leaves approvals with the MCP host and deliberately keeps
one-use transfer capabilities and file bytes out of model context. Its export-download tool
streams and verifies bytes into a new local file and refuses to overwrite an existing path.

The installable agent integrations are in [`plugins/codex`](plugins/codex) and
[`plugins/claude-code`](plugins/claude-code). Both use the public MCP package and the same
application-integration guidance; they do not gain embedded-agent privileges or create another
approval layer.

[`examples/node-upload`](examples/node-upload) exercises the complete SDK upload path: create a
transfer, PUT bytes using only the one-use descriptor, and finalize the resulting generation.
