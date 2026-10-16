# Almira public repository guidance

This repository contains Almira's open-source developer surface: released public contracts,
SDKs, CLI, MCP server, plugins, examples and the tooling needed to build and test them.

## Read first

1. [`README.md`](README.md) for the public/private boundary.
2. The released manifest under `contracts/` once it exists.
3. The nearest package README and its conformance tests before changing a client.

## Hard rules

- This repository is wire-only. Never import private `almira-core`, `metamorph-saas`, FileService
  implementation code, private platform contracts or deployment configuration.
- Released contract snapshots arrive only through the digest-bound promotion process. Do not
  hand-edit generated contracts or generated transport bindings.
- Keep generated transports separate from handwritten ergonomics such as streaming, retries,
  event verification and framework helpers.
- Public clients use PAT/SAK or short-lived Identity-owned workload evidence. Never add an
  Almira-created long-lived application secret or persist browser bearer tokens.
- The CLI, MCP server and plugins expose the same public management operations. They are not a
  second orchestration authority and contain no privileged endpoints.
- Examples reference credentials through environment variables or configuration files and must
  cover success, refusal, retry and cleanup without committed secrets.
- Do not claim support for an API version until its promoted bundle and common conformance vectors
  pass for that client.
- Add only the package or directory needed by a working slice; do not scaffold future packages.
- Before the first release, replace superseded shapes instead of adding compatibility layers or
  deprecated paths.

## Checks

Run `pnpm check` for the current repository gate. As clients are introduced, run the narrow package
tests first and the full public conformance gate before publishing support.

