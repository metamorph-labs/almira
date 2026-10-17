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

Run `cargo test` in this directory, or `pnpm check` at the public repository root.
