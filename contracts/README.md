# Almira public contract bundle

This directory is the canonical private-repository source for artifacts that may be promoted to
the public `metamorph-labs/almira` repository. `manifest.json` is generated deterministically from
every other file in this directory.

Run `pnpm contracts:generate` after changing a public artifact and `pnpm check` before review. To
prepare a promotion candidate, export into a new empty directory with:

```sh
pnpm contracts:export -- /absolute/path/to/empty-directory
```

The public repository must accept that directory with its own verifier. Nothing under
`contracts/internal`, `registrations`, deployment assets, private fixtures or qualification
evidence belongs in this bundle.

