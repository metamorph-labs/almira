# Almira CLI

The first-party `almira` CLI exposes Almira's composable management operations over the same public
contract and TypeScript client used by applications and agents. Output is JSON by default and
diagnostics use stable codes and exit statuses.

```sh
export ALMIRA_BASE_URL=https://almira.example/platform/almira
export METAMORPH_TOKEN=...

almira project bootstrap --project 018f0000-0000-7000-8000-000000000003
almira environment list --project 018f0000-0000-7000-8000-000000000003
almira collection create \
  --project 018f0000-0000-7000-8000-000000000003 \
  --environment 018f0000-0000-7000-8000-000000000004 \
  --key assets --display Assets --scan required
```

The CLI accepts credentials only through `METAMORPH_TOKEN`, never a command-line flag. A future
managed-development sign-in flow can supply the same short-lived evidence without changing command
semantics. For a mutation, retain the emitted `operation_id`; retries after an ambiguous outcome
must use that value with `--operation-id`.

Exit codes are stable: `0` success, `2` usage, `3` authentication/authorization, `4` not found,
`5` conflict, `6` retryable service response, `7` other API response, `8` local/network failure,
and `9` unexpected internal failure.
