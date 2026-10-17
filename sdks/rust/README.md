# `metamorph-almira`

The official Rust application data SDK for Almira. The crate follows the complete promoted
capability-only data contract, exposes typed list/search/media results and keeps large immutable
generation, derivative and share reads streaming.

```rust,no_run
use metamorph_almira::{Client, ClientOptions, ReadOptions};

# fn current_capability() -> String { unimplemented!() }
# fn consume(_: Vec<u8>) {}
# async fn example(generation: metamorph_almira::ImmutableGenerationReference) -> Result<(), metamorph_almira::Error> {
let client = Client::new(
    ClientOptions::new("https://almira.example")
        .capability(current_capability())
        .origin("https://app.example"),
)?;

let mut response = client
    .read_immutable_generation(&generation, &ReadOptions::default())
    .await?;
while let Some(chunk) = response.chunk().await? {
    consume(chunk);
}
# Ok(())
# }
```

Only `alm_cap_v1` and managed-development `alm_local_v1` capability tokens are accepted. Share
reads never forward a capability or origin. Redirects are refused, JSON and API errors are bounded,
and errors expose only stable safe fields. Management and provisioning remain in the Almira CLI,
MCP server and management SDK.

Use `ClientOptions::retry(RetryPolicy::new(...))` to opt safe reads and read-only search into
bounded retries. Capabilities are resolved again per attempt; only network failures and
429/502/503/504 responses are retried, numeric `Retry-After` is capped, and a response stream is
never replayed after it has been returned.

`ServerClient` accepts only short-lived `MetamorphWorkload` session evidence. Its
`create_capability_data_client` exchange returns the bounded sensitive grant and a ready data
client without copying workload evidence into capability requests. Revocation is explicit and is
never retried implicitly.
`create_upload` and `finalize_upload` expose the durable upload ceremony without accepting a
provider credential; one-use descriptor URLs, signed headers and capability tokens are redacted
from `Debug` output.
`upload_direct_file` streams exact descriptor slices from a file directly to the object provider,
adds no Almira credential, refuses redirects and automatic retries, and returns the typed evidence
accepted by `finalize_upload`.

`bind_subject` and `list_subject_bindings` let the builder workload associate a namespaced opaque
end-user identifier with retained files and discover those bindings for privacy workflows. They use
workload evidence, not browser capabilities; the subject is lifecycle metadata and never becomes
an Almira authorization identity. Opaque subject identifiers are redacted from `Debug` output.

Run `cargo test` in this directory, or `pnpm check` at the public repository root.
