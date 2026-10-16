# Almira

This is the public developer repository for Almira, Metamorph's application file-storage and media
delivery product.

It contains the open-source application SDKs and released schemas; the CLI, MCP server, Codex and
Claude Code plugins and examples will land here with their first working slices. Almira's backend,
console, embedded helper, deployment assets, platform registrations, product architecture and
private qualification evidence live in the private `almira-core` repository and are not mirrored
here.

The repository is licensed under [Apache-2.0](LICENSE). Packages are added only with an
independently buildable client or contract slice; empty future SDK/client scaffolding is not kept
here.

Released public contracts are installed under [`contracts/`](contracts/) from a deterministic,
digest-bound bundle produced by `almira-core`. Run `pnpm contracts:verify` to verify the installed
bundle independently; see [`AGENTS.md`](AGENTS.md) before proposing a contract change.

The dependency-light TypeScript client is in [`sdks/typescript`](sdks/typescript). It covers every
operation in the promoted contract and supports same-origin browser sessions, PATs, SAKs and
short-lived workload evidence through the standard Fetch API. Run `pnpm check` for the complete
local repository gate.

The first management commands are in [`clients/cli`](clients/cli). The CLI uses predictable
noun/verb commands, JSON-only stdout, stable exit codes and environment-backed credentials; it
shares the SDK transport instead of implementing a second API client.
