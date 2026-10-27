# Almira Java SDK

The Java 17+ Almira application SDK implements the promoted capability-only data plane and the
short-lived builder-workload operations. It contains no project, environment, collection, CDN,
compliance, billing or other management operations.

`AlmiraDataClient` accepts only rotating `alm_cap_v1` or `alm_local_v1` capabilities. Share reads
send no credential. `AlmiraServerClient` is a separate server-side client that accepts only a
short-lived `MetamorphWorkload` session for capability exchange, upload ceremonies and subject
lifecycle operations. Streaming bodies remain closeable `InputStream` values.

The package targets contract `0.1.0-dev.59`. Run `gradle -p sdks/jvm :java:test` from the
repository root.
