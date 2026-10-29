# Almira PHP SDK

`metamorph/almira` is the dependency-light PHP 8.2+ application SDK for promoted contract
`0.1.0-dev.59`. It implements the complete capability-data surface and a separate workload client
for capability exchange, uploads and builder-subject lifecycle operations. It has no management
API.

Capabilities are resolved per attempt, share reads send no credential, redirects are disabled,
large binary bodies spool to a closeable stream instead of remaining in PHP memory, and APP-01
webhook verification uses the exact raw body.

`verifyVerificationReceipt` uses `ext-sodium` to validate the closed canonical receipt, its
Ed25519 signature and an optional exact expected binding against a trusted key set.

Run `composer --working-dir=sdks/php test` from the repository root.
