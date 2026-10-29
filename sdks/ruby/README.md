# Almira Ruby SDK

`metamorph-almira` is the Ruby 3.2+ application SDK for promoted Almira contract
`0.1.0-dev.59`. `Almira::DataClient` implements all capability-data operations, while the separate
`Almira::ServerClient` accepts short-lived workload evidence for capability exchange, uploads and
builder-subject lifecycle operations. No management operations are included.

Binary responses use closeable temporary streams, capability providers resolve per retry, share
reads send no credential, redirects are disabled, and APP-01 webhook verification accepts exact raw
bytes.

`Almira.verify_verification_receipt` validates the closed canonical receipt, Ed25519 signature and
an optional exact expected binding against a trusted key set.

Run `ruby sdks/ruby/test/client_test.rb` from the repository root.
