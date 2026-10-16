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
parallel project model. The ten initial tools bootstrap a project and inspect or manage environments, browser origins,
collections and file metadata. One-use upload descriptors and file bytes are deliberately not
placed in model context; application integration uses the SDK. Mutating tools accept an optional
`operation_id` and always return the value used so an agent can safely retry an ambiguous outcome.

The server uses the official MCP TypeScript SDK v2 and the 2026-07-28 protocol over stdio. Stdout is
reserved exclusively for MCP; safe startup diagnostics use stderr.
