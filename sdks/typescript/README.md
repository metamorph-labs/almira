# `@metamorph-labs/almira-sdk`

The official dependency-light TypeScript client for Almira's promoted public API contract. It
works in modern browsers and Node.js 20 or newer using the standard Fetch API.

```ts
import { AlmiraClient } from "@metamorph-labs/almira-sdk";

const almira = new AlmiraClient({
  baseUrl: "https://api.example.com/platform/almira",
  credential: () => process.env.METAMORPH_TOKEN!,
});

const { environments } = await almira.listEnvironments({ projectId });
```

Omit `credential` in a browser product session; the client uses same-origin credentials. PATs,
SAKs and short-lived workload evidence stay in memory and are resolved for each request so callers
can rotate them. Mutation methods require an explicit UUIDv7 operation ID: retain and reuse it when
retrying an ambiguous outcome.

Direct transfer URLs and headers returned by `createUpload` are sensitive, one-use capabilities.
The SDK returns them only to the caller and never logs or persists them.
