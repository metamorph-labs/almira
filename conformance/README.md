# Application SDK conformance

`application-sdk.v1.json` is the repository-owned, language-neutral harness for the handwritten
application SDK behavior that is not represented by generated transport bindings. It does not add
or replace a public wire contract. The promoted OpenAPI documents and
`contracts/conformance/vectors.v1.json` remain authoritative.

Every supported runtime consumes this same file for its managed-development journey and behavior
receipt tests. The journey covers a successful `alm_local_v1` read, refusal of a management
credential, retry of a safe read with freshly resolved authority, and the explicit fact that no
cleanup mutation applies to this read-only path. The receipt vector is signed with a public test
key and contains no production credential or private key.
