# Contributing to Almira

Almira is under active pre-release development. Contributions to its public SDKs, clients,
plugins, examples and documentation are welcome.

Read [`AGENTS.md`](AGENTS.md) before making a material change. Public wire behavior is defined by
the released contract bundle; server or contract changes must be accepted in the private owner and
promoted through the reviewed digest-bound release process before generated public artifacts are
updated.

Keep changes focused and include the relevant tests. Client behavior should cover successful use,
authorization refusal, retry after an ambiguous outcome, and cleanup where applicable. Never put
credentials, customer data, private endpoints or internal contract material in code, fixtures,
issues or pull requests.

`pnpm check` is the complete repository gate. In addition to the pinned Node, pnpm and Rust
toolchains, it runs the native package suites with Java 17+ and Gradle, .NET 10 SDK (the library
also targets .NET 8), Swift 6, PHP 8.2+ with Composer, Dart 3.5+, and Ruby 3.2+. Run the narrow
`test:jvm`, `test:dotnet`, `test:swift`, `test:php`, `test:dart` or `test:ruby` script while working
on one client, then run the complete gate before handoff.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Suspected
vulnerabilities must follow [SECURITY.md](SECURITY.md), not the public issue tracker.
