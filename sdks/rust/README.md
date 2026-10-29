# `metamorph-almira`

The official Rust application data SDK for Almira. The crate follows the complete promoted
capability-only data contract, exposes typed list/search/media results and keeps large immutable
generation, derivative and share reads streaming.

```rust,no_run
use metamorph_almira::{Client, ClientOptions, ReadOptions};

# fn current_capability() -> String {
#     std::env::var("ALMIRA_CAPABILITY").expect("ALMIRA_CAPABILITY must be set")
# }
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
`upload_direct_file` handles single-put descriptors. For multipart,
`upload_direct_file_with` accepts a part-grant callback: it hashes each exact file slice before the
callback calls `create_upload_part`, then sends the checksum-bound one-use request directly to the
object provider. Neither path adds an Almira credential, follows redirects or retries an ambiguous
write; both return the typed evidence accepted by `finalize_upload`.

`bind_subject` and `list_subject_bindings` let the builder workload associate a namespaced opaque
end-user identifier with retained files and discover those bindings for privacy workflows. They use
workload evidence, not browser capabilities; the subject is lifecycle metadata and never becomes
an Almira authorization identity. Opaque subject identifiers are redacted from `Debug` output. Use
`start_subject_lifecycle_operation` and `read_subject_lifecycle_operation` for idempotent
restrict/export/delete requests and their immutable paged manifests. A completed export can issue
a fresh five-minute, one-use descriptor through `create_subject_export_download`; the descriptor's
URL and headers remain redacted from `Debug` output.

`verify_webhook_signature` verifies APP-01's common HMAC-SHA256 signature over the exact raw body
before JSON parsing. Supply the five original `Metamorph-Webhook-*` header values and a bounded
clock sample; persist the returned delivery ID and attempt to reject replays. A verified delivery
authenticates APP-01 only and never grants file-read authority.

Use `verify_verification_receipt` with a trusted `VerificationPublicKeySet` and an explicit
`VerificationReceiptExpectation`. It validates the closed V1 shape, canonical JSON, Ed25519
signature and exact resource binding.

Run `cargo test` in this directory, or `pnpm check` at the public repository root.
