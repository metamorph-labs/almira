# Almira .NET SDK

`Metamorph.Almira` is the .NET 8+ application SDK for promoted Almira contract
`0.1.0-dev.59`. It exposes the complete capability-data plane and a separate
`AlmiraServerClient` for short-lived workload exchange, upload ceremonies and builder-subject
lifecycle operations. It contains no management API.

Binary responses remain streaming and disposable. Capability providers are resolved for every
attempt, share reads forward no credential, redirects are disabled, JSON/error bodies are bounded,
and APP-01 webhook verification operates on exact raw bytes.

Run `dotnet test sdks/dotnet/Metamorph.Almira.Tests` from the repository root.
