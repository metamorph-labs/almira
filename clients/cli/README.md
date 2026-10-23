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
almira storage enroll \
  --tenant 018f0000-0000-7000-8000-000000000002 \
  --project 018f0000-0000-7000-8000-000000000003 \
  --input ./storage-enrollment.json
almira storage enrollments \
  --tenant 018f0000-0000-7000-8000-000000000002 \
  --project 018f0000-0000-7000-8000-000000000003
almira storage adopt \
  --tenant 018f0000-0000-7000-8000-000000000002 \
  --project 018f0000-0000-7000-8000-000000000003 \
  --environment 018f0000-0000-7000-8000-000000000005 \
  --enrollment 018f0000-0000-7000-8000-000000000020 \
  --revision 1
almira enrollment get \
  --tenant 018f0000-0000-7000-8000-000000000002 \
  --project 018f0000-0000-7000-8000-000000000003 \
  --enrollment 018f0000-0000-7000-8000-000000000020
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
  --class express --realization-generation 7 --revision 1
almira lifecycle set \
  --tenant 018f0000-0000-7000-8000-000000000002 \
  --project 018f0000-0000-7000-8000-000000000003 \
  --environment 018f0000-0000-7000-8000-000000000004 \
  --collection 018f0000-0000-7000-8000-000000000012 \
  --days 90 --revision 2
almira migration get \
  --tenant 018f0000-0000-7000-8000-000000000002 \
  --project 018f0000-0000-7000-8000-000000000003 \
  --environment 018f0000-0000-7000-8000-000000000004 \
  --collection 018f0000-0000-7000-8000-000000000012 \
  --migration 018f0000-0000-7000-8000-000000000013
almira import start \
  --tenant 018f0000-0000-7000-8000-000000000002 \
  --project 018f0000-0000-7000-8000-000000000003 \
  --environment 018f0000-0000-7000-8000-000000000004 \
  --collection 018f0000-0000-7000-8000-000000000012 \
  --input ./import.json
almira export start \
  --tenant 018f0000-0000-7000-8000-000000000002 \
  --project 018f0000-0000-7000-8000-000000000003 \
  --environment 018f0000-0000-7000-8000-000000000004 \
  --collection 018f0000-0000-7000-8000-000000000012 \
  --revision 4
almira portability list \
  --tenant 018f0000-0000-7000-8000-000000000002 \
  --project 018f0000-0000-7000-8000-000000000003 \
  --environment 018f0000-0000-7000-8000-000000000004 \
  --collection 018f0000-0000-7000-8000-000000000012
almira protection set \
  --tenant 018f0000-0000-7000-8000-000000000002 \
  --project 018f0000-0000-7000-8000-000000000003 \
  --environment 018f0000-0000-7000-8000-000000000004 \
  --collection 018f0000-0000-7000-8000-000000000012 \
  --scan required --revision 2
almira scan list \
  --tenant 018f0000-0000-7000-8000-000000000002 \
  --project 018f0000-0000-7000-8000-000000000003 \
  --environment 018f0000-0000-7000-8000-000000000004 \
  --state blocked
```

`tenancy-project.json` is the exact successful Tenancy `project.get` result for the selected
project; Almira validates and reauthorizes that snapshot rather than creating another project
model. The CLI accepts only an `mm_pat_v1.` PAT or `mm_sak_v1.` SAK through `METAMORPH_TOKEN`, never
a command-line flag. For a mutation, retain the emitted `operation_id`; retries after an ambiguous
outcome must use that value with `--operation-id`.

`verification create --input verification.json` submits the bounded existing-upload replay
evidence and a distinct refusal environment, then returns Almira's signed behavior receipt. The
operation does not upload another file or accept provider credentials. Verify the receipt's
Ed25519 signature and exact expected resource binding in the application SDK before treating the
journey as successful.

Named contexts remove repeated routing flags without becoming another credential store. Use
`almira context set --context NAME --base-url URL --tenant UUID --project UUID` with optional
`--environment` and `--collection`, then `almira context use --context NAME`. `context list` and
`context delete` complete the lifecycle. The mode-0600 JSON file defaults to
`~/.config/almira/contexts.json`; `ALMIRA_CONTEXT_FILE` relocates it and `ALMIRA_CONTEXT` selects a
context non-interactively. Explicit flags override context values. Tokens are never written there.

Structured `--input`, `--file`, and `--tenancy-project` values accept `-` for bounded stdin. Every
mutation accepts `--dry-run`: ordinary mutations return the exact method, Almira URL, and JSON body
without sending it or exposing authorization; `config apply --dry-run` performs the existing
server-backed configuration preview. Storage migration and portability start/status commands accept
`--wait` for one final JSON result or `--watch` for revision-deduplicated JSON Lines. Polling defaults
to one second with a ten-minute bound and can be constrained with `--poll-interval` milliseconds and
`--wait-timeout` seconds; timing out never cancels the durable remote operation.

`environment update` requires `--environment`, `--display` and the current `--revision`.
`environment delete` requires `--environment` and `--revision`; the managed `development` and
`production` environments cannot be deleted.

`storage capabilities` reads the fresh FileService realization catalog for the selected active
environment. Provider family, location, health and supported `normal`/`express` classes are safe
planning inputs; realization IDs are opaque and provider coordinates or credentials are never
returned.

`storage enroll --input FILE` starts durable FileService proof for a customer-owned S3, GCS, or
Azure Blob target. The exact JSON body contains a binding label, class, provider coordinates,
workload-federation identity and provider-native encryption choice; static cloud credentials are
not accepted. `storage enrollments` restores the project's safe receipts after a reload and
`enrollment get` reconciles one receipt using its original operation ID. Neither command returns
the submitted provider coordinates.

`storage adopt` explicitly switches one empty managed environment to hosted customer-owned
storage using an active `normal` enrollment and the environment's current revision. The protected
`development` environment always remains managed. A non-empty environment is refused until the
separate governed migration exists. Retain `operation_id` for an exact retry; a completed retry
returns the durable outcome without requiring another FileService catalog read.

`collection create` defaults `--class` to `normal`. Select `express` only when the environment's
fresh storage-capability result advertises it.

`lifecycle set` replaces the collection's 1–3650 day recycle-retention policy using its current
revision. The default is 30 days. The setting is captured by later deletions and never changes an
entry's existing recycle deadline; expired entries are no longer listed or restorable.

`collection migrate` starts a governed class change using the current collection `--revision` and
the exact opaque `--realization-generation` selected from fresh capabilities or an active
enrollment receipt. Uploads pause while that collection is migrating. Retain the
emitted operation ID after an ambiguous start and use `migration get` until the durable receipt is
`succeeded` or `failed`; retrying the start with that same ID exactly replays even after the
collection reports `migrating`.

`import start --input FILE` accepts the exact credential-free import request: current collection
revision, opaque FileService source binding, and at most 100 safe manifest entries. Provider
credentials, bucket names, endpoints, target coordinates, and download bearers do not belong in
that file. `export start` snapshots only retained generations and derivatives that are currently
available and safety-admitted. Follow either job with `portability list|get`. For a succeeded
export, `export download --portability-job UUID --output PATH` obtains and consumes a fresh one-use
descriptor internally, streams into a mode-0600 temporary file, verifies size and SHA-256, and
admits it atomically. It refuses to overwrite `PATH` and its JSON receipt never contains the
descriptor URL or signed headers.

`config preview` reads current state without mutation and returns a digest-bound deterministic
diff. `config apply` is additive: omitted environments, origins, and collections are preserved.
It returns a root `operation_id` plus deterministic child operation IDs; reuse the root ID after an
ambiguous outcome. Recycle retention, malware protection, extraction, media, and class changes use
one revision-safe sequence; a class change starts the same governed migration. Unsupported changes
remain conflicts, never silent no-ops.

Collection malware controls use `protection get|set`. A replacement applies only to new
generations. `scan list` reports bounded environment-wide cases and accepts optional
`--collection`, `--state`, `--page-size`, and `--cursor` filters. `scan rescan` targets one exact
`--entry` and `--generation`, requires its current `--revision`, and gates delivery immediately
until FileService returns clean. `scan review` accepts an exact JSON `--input FILE` containing
`expected_revision` and a `confirmed_blocked` or `suspected_false_positive` review. Reviews are
content-free audit records and never release content or override FileService; no release command
exists.

File lifecycle commands are `file list|get|versions|rename|copy|select-version|delete|restore|batch`.
Renaming changes only the stable entry path; versions remain immutable. `file delete` immediately
removes read access and starts the bounded recycle window. Use `file list --include-deleted` to
find recyclable entries and `file restore` before expiry. Rename, generation selection, delete,
and restore all require the current `--revision`.
`file batch --input batch.json` applies up to 100 independent revision-bound rename,
version-selection, delete, or restore actions atomically; an entry may occur only once.
`file copy --entry <uuid> --generation <uuid> --path <logical-path> --revision <n>` creates an
independently owned server-side copy of one exact generation. Reuse `--operation-id` after an
ambiguous result; no local byte transfer or provider credential is involved.

Collection extraction controls use `extraction get|set`; safe technical extraction is mandatory,
while content, OCR, transcription, and vector indexing are collection-level opt-ins. Vector
indexing requires content extraction. Exact-generation safe status
uses `extraction status`; separately protected text uses `extraction content`. Bounded customer
tags and typed scalar fields use `metadata get|set`. `file list` also accepts exact tag, metadata,
verified media type, size, creation-time and extraction-state filters; paired filter fields must
be provided together.

Collection media controls use `media get|set`. Image presets, document previews and the optional
`web_hls_v1` video profile are collection-scoped and provider-neutral. Use `job list|retry|cancel`
to inspect or operate their asynchronous work and `derivative list` for the ready outputs of one
exact source generation. Structured media replacement uses `--input FILE`; retry and cancel also
require the job's current `--revision`.

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

For `delivery set`, the exact JSON includes nullable `custom_hostname`. Use `null` for Almira's
managed hostname or a lowercase DNS hostname for a deployment-supported custom domain, then read
the returned `routing_target`, ownership challenge and lifecycle state with `delivery get`. The CLI
never accepts CDN credentials or provider coordinates. `delivery get` also returns at most the 20
newest cache invalidations with their trigger, state, attempts, safe error and timestamps; it never
returns a provider resource ID or raw provider receipt.

Exit codes are stable: `0` success, `2` usage, `3` authentication/authorization, `4` not found,
`5` conflict, `6` retryable service response, `7` other API response, `8` local/network failure,
and `9` unexpected internal failure.
