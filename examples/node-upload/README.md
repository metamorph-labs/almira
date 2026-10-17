# Node.js direct upload example

This executable example demonstrates the complete application path: create an Almira upload,
execute its one-use provider request without forwarding Metamorph credentials, finalize the
immutable generation, and obtain and cryptographically verify Almira's signed behavior receipt.

```sh
export ALMIRA_BASE_URL=https://almira.example
export METAMORPH_TOKEN=mm_pat_v1...
pnpm build
node dist/main.js ./photo.jpg TENANT_ID PROJECT_ID DEVELOPMENT_ENVIRONMENT_ID COLLECTION_INSTANCE_ID PRODUCTION_ENVIRONMENT_ID images/photo.jpg
```

The small example reads one file into memory to keep the integration clear. Production callers can
pass a `Blob`, `ArrayBuffer` or typed-array view directly to `uploadDirect`; transfer URLs and
headers remain one-use secrets and should never be logged or persisted.

The second environment is a refusal target, not a source or destination. Almira replays the exact
finalize operation, hashes a bounded private read of the immutable generation, requires that the
same resource cannot be read through that other environment, checks the configured malware gate,
and signs a receipt bound to the resource and contract version. The example fetches public keys
from the same Almira origin and verifies the Ed25519 signature offline before reporting success.
Files above 8 MiB should use application-specific verification sampling; the V1 canonical receipt
intentionally refuses them instead of turning verification into an unbounded download.

`src/next-route-handler.ts` is a Next.js App Router-compatible server handler factory for the
representative `avatar`, `private_document`, and `video` flows. Supply the application's own
authorization callback and path mapping, then export the returned function as `POST` from an
`app/api/files/route.ts` module. The injected `AlmiraClient` must obtain short-lived workload
evidence in a deployed application; never put a PAT or SAK in browser code. The handler rejects
unauthorized callers and oversized inputs before creating storage work, returns no transfer
descriptor, and reports success only after the signed receipt verifies.

After the generation becomes available and its configured extraction/indexing work completes, the
same workload-authenticated client can search the collection without provider access:

```ts
const page = await client.searchFiles(collection, {
  query: "quarterly report",
  mode: "hybrid",
  filter: { tag: "finance" },
  facets: ["tags"],
});
```

Use lexical mode when vector indexing is not enabled. Search lag may reduce recall; returned entries
are always checked against current lifecycle, safety, generation, metadata, and authorization state.
