# `metamorph-almira`

The official dependency-free Python 3.11+ application data SDK for Almira. This package implements
every operation in the promoted data-plane OpenAPI contract and deliberately accepts only
short-lived `alm_cap_v1` or `alm_local_v1` capability tokens. It cannot accept a Metamorph PAT,
SAK, product cookie, provider credential, or local-issuer private key.

```python
from almira import AlmiraDataClient, ImmutableGenerationReference

client = AlmiraDataClient(
    base_url="https://almira.example",
    capability=lambda: current_capability(),
    origin="https://app.example",
)

reference = ImmutableGenerationReference(
    tenant_id=tenant_id,
    project_id=project_id,
    environment_id=environment_id,
    collection_instance_id=collection_id,
    entry_id=entry_id,
    generation_id=generation_id,
)

with client.read_immutable_generation(reference, byte_range="bytes=0-1048575") as response:
    for chunk in response.iter_bytes():
        consume(chunk)
```

The client exposes capability-backed list, metadata, search, derivative-list, immutable-generation,
derivative, and token-in-path share reads. Share reads never forward the configured capability or
application origin. Binary responses remain streaming file objects and should be closed directly or
with a context manager. API errors expose only the stable error code, request ID, status, and safe
`Retry-After` value.

Pass `retry=RetryPolicy(...)` to opt safe reads and read-only search into bounded retries. Retries
are disabled by default, re-resolve rotating capabilities on each attempt, honor bounded numeric
`Retry-After`, and never retry after a streaming response has been handed to the caller.

`AlmiraServerClient` accepts only short-lived `MetamorphWorkload` session evidence. Its
`create_capability_data_client` exchange returns the sensitive bounded grant and a ready
capability-only client, without copying workload evidence into browser/mobile requests. Revoke the
session with the original explicit operation identity when it is no longer needed.
The same server client creates an upload intent and finalizes exact descriptor/provider evidence;
one-use transfer URLs, signed headers and capability tokens are redacted from SDK representations.
Pass that descriptor and a seekable binary source to `upload_direct`. For multipart, provide a
`grant_part` callback backed by `create_upload_part`; the helper hashes each exact slice before it
requests that checksum-bound one-use grant. It streams only the admitted bytes to the object
provider, never adds an Almira credential or follows a redirect, does not retry an ambiguous write,
and returns the typed evidence for `finalize_upload`.
`bind_subject` and `list_subject_bindings` persist and discover namespaced opaque builder-user
lifecycle associations under workload evidence. They support the builder's privacy workflows;
subjects are lifecycle metadata, never Almira authorization identities, and opaque identifiers are
redacted from SDK representations. `start_subject_lifecycle_operation` and
`read_subject_lifecycle_operation` provide idempotent restrict/export/delete operations and paged
complete/pending manifests. A completed export exposes an immutable archive commitment;
`create_subject_export_download` returns a fresh five-minute, one-use descriptor while redacting
its URL and headers from representations. Provider credentials never appear in the manifest.

Call `verify_webhook_signature` over the exact raw request body and the five
`Metamorph-Webhook-*` headers before parsing an APP-01 webhook. It verifies the common
HMAC-SHA256 transcript, identifiers, attempt bound and default five-minute clock window. Persist
the returned `(delivery_id, attempt)` to reject replays. A verified delivery is not file-read
authority and does not make its JSON payload safe without schema and application validation.

Management and resource provisioning remain in the Almira CLI/MCP or the management client. The
builder application's backend obtains bounded capability sessions under its short-lived Metamorph
customer-workload identity; this data client does not create an authentication system for the
application's users.

Run the package tests from the public repository root:

```sh
PYTHONPATH=sdks/python/src python3 -m unittest discover -s sdks/python/tests -v
```
