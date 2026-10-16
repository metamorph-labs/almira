# Almira for Claude Code

This plugin gives Claude Code the Almira management MCP server and the namespaced
`/almira:build-with-almira` integration skill. It is for coding agents working on a user's
application; it does not add an application builder or deployment agent.

Set `ALMIRA_BASE_URL` and a scoped `METAMORPH_TOKEN` before loading the plugin. The token may be a
PAT or SAK for setup work. Application runtimes use short-lived Metamorph workload evidence
instead.

For local development, load this directory with `claude --plugin-dir <path>`. The MCP server package
is pinned in `.mcp.json`; Claude Code prompts before trusting project/plugin MCP configuration.
