# Almira Go SDK

The official dependency-free Go 1.23+ application data SDK for Almira. The package implements the
complete promoted capability-only data contract with typed metadata/search results and streaming
immutable-generation, derivative, and share responses.

```go
client, err := almira.NewClient(almira.ClientOptions{
	BaseURL:    "https://almira.example",
	Capability: capability,
	Origin:     "https://app.example",
})
if err != nil {
	return err
}

response, err := client.ReadImmutableGeneration(ctx, generation, almira.ReadOptions{})
if err != nil {
	return err
}
defer response.Body.Close()
_, err = io.Copy(destination, response.Body)
```

The client accepts only `alm_cap_v1` and managed-development `alm_local_v1` capability tokens.
Share reads never forward the configured capability or origin. It refuses redirects, bounds JSON
responses and errors, and returns stable redacted `ClientError` or `APIError` values. Management
and provisioning remain in the Almira CLI, MCP server, and management SDK.

Set `ClientOptions.Retry` to opt safe reads and read-only search into at most five attempts. The
client re-resolves capability providers per attempt, retries only network failures and
429/502/503/504 responses, bounds numeric `Retry-After`, and never replays a stream after returning
its body.

`ServerClient` accepts only short-lived `MetamorphWorkload` session evidence. Its
`CreateCapabilityDataClient` exchange returns the bounded sensitive grant and a ready data client;
the workload evidence is never copied into capability requests. Revocation retains an explicit
operation identity and is never retried implicitly.
`CreateUpload` and `FinalizeUpload` expose the ordinary durable upload ceremony without admitting a
provider credential; one-use descriptor URLs, signed headers and capability tokens are redacted
from SDK formatting.
`UploadDirect` streams exact descriptor slices from an `io.ReaderAt` directly to the object
provider, adds no Almira credential, refuses redirects and automatic retries, and returns the typed
evidence accepted by `FinalizeUpload`.

Run `go test ./...` in this directory, or `pnpm check` at the public repository root.
