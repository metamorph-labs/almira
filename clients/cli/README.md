# Almira CLI

The first-party `almira` CLI exposes Almira's composable management operations over the same public
contract and TypeScript client used by applications and agents. Output is JSON by default and
diagnostics use stable codes and exit statuses.

```sh
export ALMIRA_BASE_URL=https://almira.example
export METAMORPH_TOKEN=mm_pat_v1...

almira project bootstrap \
  --tenant 018f0000-0000-7000-8000-000000000002 \
  --project 018f0000-0000-7000-8000-000000000003 \
  --tenancy-project ./tenancy-project.json
almira environment list \
  --tenant 018f0000-0000-7000-8000-000000000002 \
  --project 018f0000-0000-7000-8000-000000000003
almira environment create \
  --tenant 018f0000-0000-7000-8000-000000000002 \
  --project 018f0000-0000-7000-8000-000000000003 \
  --key preview-one --display "Preview one"
almira storage capabilities \
  --tenant 018f0000-0000-7000-8000-000000000002 \
  --project 018f0000-0000-7000-8000-000000000003 \
  --environment 018f0000-0000-7000-8000-000000000004
almira config preview \
  --tenant 018f0000-0000-7000-8000-000000000002 \
  --project 018f0000-0000-7000-8000-000000000003 \
  --file ./almira.yaml
almira config apply \
  --tenant 018f0000-0000-7000-8000-000000000002 \
  --project 018f0000-0000-7000-8000-000000000003 \
  --file ./almira.yaml
almira collection create \
  --tenant 018f0000-0000-7000-8000-000000000002 \
  --project 018f0000-0000-7000-8000-000000000003 \
  --environment 018f0000-0000-7000-8000-000000000004 \
  --key assets --display Assets --scan required --class normal
almira collection migrate \
  --tenant 018f0000-0000-7000-8000-000000000002 \
  --project 018f0000-0000-7000-8000-000000000003 \
  --environment 018f0000-0000-7000-8000-000000000004 \
  --collection 018f0000-0000-7000-8000-000000000012 \
  --class express --revision 1
almira migration get \
  --tenant 018f0000-0000-7000-8000-000000000002 \
  --project 018f0000-0000-7000-8000-000000000003 \
  --environment 018f0000-0000-7000-8000-000000000004 \
  --collection 018f0000-0000-7000-8000-000000000012 \
  --migration 018f0000-0000-7000-8000-000000000013
```

`tenancy-project.json` is the exact successful Tenancy `project.get` result for the selected
project; Almira validates and reauthorizes that snapshot rather than creating another project
model. The CLI accepts only an `mm_pat_v1.` PAT or `mm_sak_v1.` SAK through `METAMORPH_TOKEN`, never
a command-line flag. For a mutation, retain the emitted `operation_id`; retries after an ambiguous
outcome must use that value with `--operation-id`.

`environment update` requires `--environment`, `--display` and the current `--revision`.
`environment delete` requires `--environment` and `--revision`; the managed `development` and
`production` environments cannot be deleted.

`storage capabilities` reads the fresh FileService realization catalog for the selected active
environment. Provider family, location, health and supported `normal`/`express` classes are safe
planning inputs; realization IDs are opaque and provider coordinates or credentials are never
returned.

`collection create` defaults `--class` to `normal`. Select `express` only when the environment's
fresh storage-capability result advertises it.

`collection migrate` starts a governed class change using the current collection `--revision`;
the provider target remains opaque. Uploads pause while that collection is migrating. Retain the
emitted operation ID after an ambiguous start and use `migration get` until the durable receipt is
`succeeded` or `failed`; retrying the start with that same ID exactly replays even after the
collection reports `migrating`.

`config preview` reads current state without mutation and returns a digest-bound deterministic
diff. `config apply` is additive: omitted environments, origins, and collections are preserved.
It returns a root `operation_id` plus deterministic child operation IDs; reuse the root ID after an
ambiguous outcome. A class-only collection change starts the same governed migration; other
unsupported existing collection changes are conflicts, never silent no-ops.

File lifecycle commands are `file list|get|versions|rename|select-version|delete|restore`.
Renaming changes only the stable entry path; versions remain immutable. `file delete` immediately
removes read access and starts the bounded recycle window. Use `file list --include-deleted` to
find recyclable entries and `file restore` before expiry. Rename, generation selection, delete,
and restore all require the current `--revision`.

Collection extraction controls use `extraction get|set`; safe technical extraction is mandatory,
while content, OCR, transcription, and vector indexing are collection-level opt-ins. Vector
indexing requires content extraction. Exact-generation safe status
uses `extraction status`; separately protected text uses `extraction content`. Bounded customer
tags and typed scalar fields use `metadata get|set`. `file list` also accepts exact tag, metadata,
verified media type, size, creation-time and extraction-state filters; paired filter fields must
be provided together.

`file search --query TEXT` performs lexical search by default. Pass `--mode semantic` or
`--mode hybrid` only for a vector-enabled collection, repeat `--facet` for returned-page facets,
and use `--page-size`/`--cursor` for bounded continuation. The command accepts the same metadata,
media, size, time, extraction-state, and path-prefix filters as authoritative listing.

Collection access, CDN delivery, shares, and local capability issuers use the same noun/verb
shape: `policy get|set|simulate`, `delivery get|set`, `share create|revoke`, and
`issuer list|register|rotate|revoke|signing-config`. Structured request bodies are passed through
`--input FILE` as exact JSON so shell quoting cannot silently change a policy or key ceiling.
Mutations retain the same `--operation-id` replay contract; issuer revocation also requires the
current `--revision`.

Exit codes are stable: `0` success, `2` usage, `3` authentication/authorization, `4` not found,
`5` conflict, `6` retryable service response, `7` other API response, `8` local/network failure,
and `9` unexpected internal failure.
