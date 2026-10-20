# Almira app integration surface

This directory publishes Almira's product-owned contribution to Metamorph `APP-01`.
It defines exact operation schemas, permissions, actor modes, safe events and conformance
vectors for project-scoped GitHub-style apps.

The contribution is the product-authored input admitted by Apps through the digest-bound platform
catalog process. Almira exposes the complete operation plane at
`POST /v1/projects/{project_id}/app-operations/{operation_id}`; it never mounts a partial subset.
The request carries `x-almira-tenant-id` and a canonical, unpadded base64url sender proof as
`Authorization: Metamorph-App-Proof <proof>`. Almira binds that proof to the exact operation,
stable-ID target digest and canonical request-body digest, then sends it through the common
access-decision route. Apps remains installation, principal, grant, actor-mode and lifecycle
authority. Almira does not parse Apps tokens or implement a parallel installation system.

Stable project, environment, collection, file and generation IDs form resource ceilings.
Paths, tags, metadata values and search queries are filters only. App metadata is written to a
namespace derived from the verified installation; callers cannot choose another namespace.
File-byte access and external processing require their own disclosed permission. Direct transfers
return a complete `single_put` or `multipart` request descriptor and finalization requires exact
descriptor/protocol/provider/part/size/checksum evidence. Mutation operation IDs are durable
idempotency keys; exact retries return the retained result and `almira.integration.operation.get`
reports a terminal, pending or outcome-unknown receipt without replaying an effect.

Installation suspension or uninstall is owned by Apps and stops new effects through the local
restrictive fence. Uninstall removes only installation-owned metadata, cancels nonterminal
installation jobs, revokes its active delivery grants and closes pending operation receipts;
customer files remain. Expired jobs and retained receipts are terminalized and pruned by the
ordinary fenced maintenance worker.

Almira meters storage, delivery and processing through its ordinary plan-defined meters with the
verified installation recorded as attribution; the app surface creates no pricing or spending
mechanism. Every successful operation emits its exact registered Audit event with app-installation
actor, route and optional placement evidence. Product resource events continue through APP-01's
separate subscription/webhook path; operation Audit events are not treated as customer webhooks.
