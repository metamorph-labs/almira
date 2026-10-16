# Almira public contract bundle

This directory is the canonical Almira public contract bundle. It is authored in
`metamorph-labs/almira-core` and promoted byte-for-byte to `metamorph-labs/almira`.
`manifest.json` is generated deterministically from every other file in this directory.

The API bundle contains:

- `openapi.v1.json`: the provider-neutral management and trusted builder-backend contract;
- `data-openapi.v1.json`: the browser/mobile capability, immutable delivery and bearer-share
  contract, deliberately isolated from management credentials;
- `configuration/almira.v1.schema.json`: the closed additive `almira.yaml` v1 contract;
- `errors.v1.json`: stable, redacted public error/status mappings; and
- `conformance/vectors.v1.json`: executable closed-schema and error vectors.

Direct-transfer descriptors, capability tokens and share URLs are bearer material. Clients must
never log or forward them beyond their declared use. Capability tokens cannot be used on the
management surface, and PATs, SAKs and product sessions cannot be used on the browser data surface.
The APIs never accept a provider, bucket, endpoint or object key from ordinary callers.

The optional asymmetric local-issuer flow returns only public protocol/configuration material. A
builder workload caches the signing configuration and signs canonical claims with its own
protected Ed25519 key; Almira never accepts or returns that private key. A stale-token refusal is
the signal to refresh revisions, so ordinary file access still remains one data-plane call.

In `almira-core`, run `pnpm contracts:generate` after changing a public artifact and `pnpm check`
before review. Export a promotion candidate into a new empty directory with:

```sh
pnpm contracts:export /absolute/path/to/empty-directory
```

In `almira`, accept that directory with `pnpm contracts:accept /absolute/path/to/candidate` and run
`pnpm check`. Nothing under `contracts/internal`, `registrations`, deployment assets, private
fixtures or qualification evidence belongs in this bundle.
