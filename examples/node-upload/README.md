# Node.js direct upload example

This executable example demonstrates the complete application path: create an Almira upload,
execute its one-use provider request without forwarding Metamorph credentials, and finalize the
immutable generation.

```sh
export ALMIRA_BASE_URL=https://almira.example
export METAMORPH_TOKEN=mm_pat_v1...
pnpm build
node dist/main.js ./photo.jpg TENANT_ID PROJECT_ID ENVIRONMENT_ID COLLECTION_INSTANCE_ID images/photo.jpg
```

The small example reads one file into memory to keep the integration clear. Production callers can
pass a `Blob`, `ArrayBuffer` or typed-array view directly to `uploadDirect`; transfer URLs and
headers remain one-use secrets and should never be logged or persisted.

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
