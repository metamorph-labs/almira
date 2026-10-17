# Almira app integration surface

This directory publishes Almira's product-owned contribution to Metamorph `APP-01`.
It defines exact operation schemas, permissions, actor modes, safe events and conformance
vectors for project-scoped GitHub-style apps.

The contribution is an authoring artifact, not evidence that the surface is admitted or live.
At the pinned platform revision, the common access-decision composition does not dispatch
`app_installation` evidence to Apps and the Apps publication API does not admit an external
product surface. Almira therefore exposes no app-authenticated production route until those
owner seams exist. It does not parse Apps tokens or implement a parallel installation system.

Stable project, environment, collection, file and generation IDs form resource ceilings.
Paths, tags, metadata values and search queries are filters only. App metadata is written to a
namespace derived from the verified installation; callers cannot choose another namespace.
File-byte access and external processing require their own disclosed permission. Installation
suspension or uninstall is owned by Apps and must stop new effects before Almira performs any
reviewed cleanup; customer files are retained by default.

Almira meters storage, delivery and processing through its ordinary plan-defined meters with the
verified installation recorded as attribution; the app surface creates no pricing or spending
mechanism. Apps must deliver a current lifecycle callback before Almira can perform declared
ephemeral-metadata or incomplete-output cleanup after suspension/uninstall.
