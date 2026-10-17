# Almira MCP server

`almira-mcp` gives external coding agents the same bounded management operations as the Almira CLI
over Model Context Protocol stdio. It is an adapter over the public TypeScript SDK, not an
orchestration authority: the MCP host owns conversation and approval UX, while Metamorph enforces
the PAT/SAK scope and every current authorization decision.

Configure the process without command-line secrets:

```json
{
  "command": "almira-mcp",
  "env": {
    "ALMIRA_BASE_URL": "https://almira.example",
    "METAMORPH_TOKEN": "${METAMORPH_TOKEN}"
  }
}
```

Every tool takes both `tenant_id` and `project_id`. Bootstrap additionally takes the exact Tenancy
`project.get` result as `tenancy_project`; Almira reauthorizes that snapshot and does not create a
parallel project model. The management tools bootstrap a project and inspect, create, rename or
delete additional environments, discover their current provider-neutral storage capabilities,
manage browser origins and collections, and inspect file metadata. One-use upload
descriptors and file bytes are deliberately not
placed in model context; application integration uses the SDK. Mutating tools accept an optional
`operation_id` and always return the value used so an agent can safely retry an ambiguous outcome.
Collection creation accepts `storage_class` as `normal` (the default) or `express`; agents should
first verify that the selected environment advertises the requested class.

File management tools list retained immutable generations, rename stable entries, select a
retained generation, move an entry into its recycle window, and restore it before expiry. Deleted
entries are visible only when a management caller explicitly requests `include_deleted`; these
tools never turn recycle visibility into application-user access.

The catalog also exposes collection extraction controls, bounded customer tags and typed metadata,
authoritative structured list filters, and safe exact-generation extraction status. Raw extracted
text is never returned by status or list tools; `almira_file_extracted_content_get` is a distinct
read whose Metamorph token must carry the separate protected-content permission.

The same bounded catalog includes policy read/replace/simulation, CDN delivery read/replace,
revocable generation shares, and local issuer registration/rotation/revocation/signing
configuration. The MCP server handles public keys and declared ceilings only; it never accepts a
local issuer private key. Capability sessions and end-user data reads remain application SDK
operations because PAT/SAK-backed coding agents are management principals, not builder workloads
or application users.

`almira_storage_migration_start` changes an existing collection between advertised classes using
its current revision and returns a durable receipt; it never accepts a provider target. Uploads to
that collection pause while migration is active. Retain the returned operation ID after an
ambiguous start and poll `almira_storage_migration_get` until `succeeded` or `failed`.

`almira_configuration_preview` and `almira_configuration_apply` accept the structured form of the
public `almira.yaml` v1 schema. Preview is read-only; apply preserves unlisted resources and uses
deterministic child operation IDs beneath its reusable root `operation_id`. Class-only changes use
the same storage-migration operation.

The server uses the official MCP TypeScript SDK v2 and the 2026-07-28 protocol over stdio. Stdout is
reserved exclusively for MCP; safe startup diagnostics use stderr.
