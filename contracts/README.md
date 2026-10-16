# Almira public contract bundle

This directory is the canonical Almira public contract bundle. It is authored in
`metamorph-labs/almira-core` and promoted byte-for-byte to `metamorph-labs/almira`.
`manifest.json` is generated deterministically from every other file in this directory.

The first API slice contains:

- `openapi.v1.json`: the provider-neutral management and file data contract;
- `configuration/almira.v1.schema.json`: the closed additive `almira.yaml` v1 contract;
- `errors.v1.json`: stable, redacted public error/status mappings; and
- `conformance/vectors.v1.json`: executable closed-schema and error vectors.

Direct-transfer URLs and header values are short-lived bearer material. Clients must never log,
persist or send them anywhere except the exact HTTPS requests in their descriptor. The API never
accepts a provider, bucket, endpoint or object key from ordinary callers.

In `almira-core`, run `pnpm contracts:generate` after changing a public artifact and `pnpm check`
before review. Export a promotion candidate into a new empty directory with:

```sh
pnpm contracts:export /absolute/path/to/empty-directory
```

In `almira`, accept that directory with `pnpm contracts:accept /absolute/path/to/candidate` and run
`pnpm check`. Nothing under `contracts/internal`, `registrations`, deployment assets, private
fixtures or qualification evidence belongs in this bundle.
