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
almira collection create \
  --tenant 018f0000-0000-7000-8000-000000000002 \
  --project 018f0000-0000-7000-8000-000000000003 \
  --environment 018f0000-0000-7000-8000-000000000004 \
  --key assets --display Assets --scan required --class normal
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

Exit codes are stable: `0` success, `2` usage, `3` authentication/authorization, `4` not found,
`5` conflict, `6` retryable service response, `7` other API response, `8` local/network failure,
and `9` unexpected internal failure.
