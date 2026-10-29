# Framework examples

These small executable applications exercise the same capability-only metadata read in the
frameworks Almira application developers commonly use. They intentionally remain application
examples, not management clients. For a write path, use the complete create/direct-transfer/finalize
ceremony in [`../node-upload`](../node-upload/) with the equivalent server SDK methods.

All examples use an `alm_local_v1` or `alm_cap_v1` capability. During managed development, set
`ALMIRA_CAPABILITY` to a short-lived local-issuer token. A deployed backend should obtain a bounded
capability through its SDK's workload client; mobile applications should obtain one from their own
authorized backend. Never substitute a PAT, SAK, browser bearer token, or long-lived application
secret.

Set these common values before running an example:

```sh
export ALMIRA_BASE_URL=https://almira.example
export ALMIRA_CAPABILITY=alm_local_v1...
export ALMIRA_TENANT_ID=018f...
export ALMIRA_PROJECT_ID=018f...
export ALMIRA_ENVIRONMENT_ID=018f...
export ALMIRA_COLLECTION_ID=018f...
export ALMIRA_ENTRY_ID=018f...
```

The backend examples also require `X-App-User: an-application-user` on the request, representing
the application's existing authenticated session. They reject the call before Almira access when
that application authorization is absent.

| Framework | Run from its directory |
| --- | --- |
| Spring Boot | `gradle bootRun` |
| Ktor | `gradle run` |
| ASP.NET | `dotnet run` |
| FastAPI | `python -m uvicorn fastapi_app:app --port 8080` |
| Django | `python manage.py runserver 8080` |
| Laravel components | `composer install && php -S 127.0.0.1:8080 -t public` |
| Rails | `bundle install && bundle exec rackup -p 8080` |
| SwiftUI (macOS) | `swift run` |
| Flutter | Copy `almira.example.json` to ignored `almira.json`, fill it, then run `flutter run --dart-define-from-file=almira.json` |

The HTTP examples expose `GET /files/{entry-id}` (or `/files/:entry_id`). The SwiftUI and Flutter
examples render the configured entry's logical path and lifecycle. Refusal and retry behavior for
every underlying runtime is exercised from the shared
[`../../conformance/application-sdk.v1.json`](../../conformance/application-sdk.v1.json) vector in
the SDK test suites.
