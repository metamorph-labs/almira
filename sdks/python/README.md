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
Pass that descriptor and a seekable binary source to `upload_direct`; it streams only the exact
declared slices to the object provider, never adds an Almira credential or follows a redirect,
does not retry an ambiguous write, and returns the typed evidence for `finalize_upload`.

Management and resource provisioning remain in the Almira CLI/MCP or the management client. The
builder application's backend obtains bounded capability sessions under its short-lived Metamorph
customer-workload identity; this data client does not create an authentication system for the
application's users.

Run the package tests from the public repository root:

```sh
PYTHONPATH=sdks/python/src python3 -m unittest discover -s sdks/python/tests -v
```
