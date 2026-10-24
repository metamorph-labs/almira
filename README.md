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

[`contracts/apps`](contracts/apps/) contains Almira's reviewed and admitted `APP-01`
product-surface contribution: exact operation/event schemas, stable-ID ceilings, separately
disclosed byte and external-processing permissions, and refusal vectors. Almira exposes all 17
operations as one complete app-authenticated plane; admission, installation authentication,
suspension, uninstall and webhook delivery remain owned by the common Metamorph Apps capability.

Declarative setup uses the closed [`almira.yaml`](examples/almira.yaml) v1 format. Preview is
read-only and additive; apply preserves unlisted resources and executes the same scoped operations
available individually through the SDK, CLI, MCP server, and console. A class-only collection
change starts the same governed, resumable storage migration exposed by those surfaces.
Collection malware policy is equally declarative: changing it affects new generations only, while
an exact-generation rescan immediately gates delivery until FileService returns a clean verdict.
The same operation is replayed with current authority to refresh queued, retrying, cleanup or
terminal FileService state; no Almira client or worker stores caller credentials for polling.

Projects may also enroll customer-owned AWS S3, Google Cloud Storage, or Azure Blob targets. The
enrollment request contains provider coordinates and a workload-federation identity, never a cloud
access key, client secret, or service-account key. FileService owns proof and health checks and
returns an opaque realization generation. An administrator can explicitly bind an active `normal`
enrollment to a non-development environment; development always stays managed. An empty
environment adopts immediately, while a non-empty environment first migrates each collection to
the exact enrolled realization and adopts only after every binding is ready. Project-scoped list
and status operations expose durable safe receipts while keeping provider coordinates private.
The reverse transition is equally explicit: every collection first migrates to a current managed
realization, then one revision-bound operation atomically restores the environment's managed model.

The dependency-light TypeScript client is in [`sdks/typescript`](sdks/typescript). It covers every
operation in the promoted contract and supports same-origin browser sessions, PATs, SAKs and
short-lived workload evidence through the standard Fetch API. Its separate `AlmiraDataClient`
accepts only end-user capability tokens and exposes capability-backed metadata, immutable CDN
generation reads, and share reads without admitting management credentials. The server-side
capability helper exchanges current workload evidence for that isolated data client in one call.
Run `pnpm check` for the complete local repository gate, including no-waiver RustSec and npm
advisory checks over the locked client dependency graphs.

The Python 3.11+ application data SDK is in [`sdks/python`](sdks/python). It covers the promoted
capability-only data-plane contract exactly, streams immutable generation and derivative responses,
keeps share reads credential-free, and has no runtime dependency outside the Python standard
library. Its server client adds only the workload-to-capability exchange and explicit revocation.
It also exposes the ordinary durable create/finalize upload ceremony with redacted transfer
descriptors.

The dependency-free Go 1.23+ application data SDK is in [`sdks/go`](sdks/go). It provides typed
metadata and search results, complete structured filtering, safe capability providers and closable
streaming bodies while preserving the same capability-only and credential-free-share boundaries;
its distinct server client performs workload-to-capability exchange without credential crossover.
The server client also preserves exact create/finalize upload evidence without provider keys.

The async Rust application data SDK is in [`sdks/rust`](sdks/rust). It provides contract-shaped
types, per-request capability refresh, bounded JSON/error handling and owned streaming responses;
its distinct server client performs the same bounded workload exchange, and its dependency graph is
locked and checked with formatting, tests and strict Clippy. Typed server upload creation and
finalization retain the same one-use descriptor boundary.

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
authorization. Every extraction configuration also publishes the exact V1 accepted media types,
input/output ceilings and wall times; unsupported or oversized files are refused before processor
dispatch.

Governed collection imports use only an opaque FileService source binding and a bounded safe
manifest—never cloud credentials, buckets, endpoints, or target coordinates. Portable exports
contain retained generations and derivatives that remain available and safety-admitted. Their
one-use download bearer is consumed only by the SDK transfer helper, CLI, or MCP process; CLI/MCP
return a verified local-file receipt without placing the bearer in model context.

The stdio MCP server is in [`clients/mcp`](clients/mcp). It presents the same bounded management
slice to external coding agents, leaves approvals with the MCP host and deliberately keeps
one-use transfer capabilities and file bytes out of model context. Its export-download tool
streams and verifies bytes into a new local file and refuses to overwrite an existing path.

Collection CDN controls include provider-neutral configuration, custom-domain lifecycle,
collection-wide replay-safe cache purge and bounded asynchronous diagnostics. The console, SDK,
CLI, MCP server and coding-agent plugins all use the same public management operation; none exposes
CDN credentials or raw provider receipts.

The installable agent integrations are in [`plugins/codex`](plugins/codex) and
[`plugins/claude-code`](plugins/claude-code). Both use the public MCP package and the same
application-integration guidance; they do not gain embedded-agent privileges or create another
approval layer.

[`examples/node-upload`](examples/node-upload) exercises the complete SDK upload path: create a
transfer, choose single-put or multipart from the returned descriptor, obtain each checksum-bound
multipart part grant only when needed, PUT bytes without an Almira credential, and finalize the
resulting generation.
