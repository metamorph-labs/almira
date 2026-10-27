# Almira Swift SDK

The Swift 6 package targets Apple application development against promoted Almira contract
`0.1.0-dev.59`.

- Import `Almira` in iOS, macOS, tvOS or watchOS applications for capability-backed metadata,
  search, immutable-generation, derivative and share reads. Response bodies are asynchronous
  streams, rotating capabilities resolve per attempt, and share reads forward no credential.
- Import `AlmiraServer` only in a trusted server process for workload-to-capability exchange,
  upload creation/finalization, subject lifecycle operations and APP-01 webhook verification.

Neither module contains management operations. Run `swift test --package-path sdks/swift` from the
repository root.
