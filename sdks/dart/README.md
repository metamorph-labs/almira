# Almira Dart and Flutter SDK

`metamorph_almira` implements promoted Almira contract `0.1.0-dev.59` for Dart and Flutter.

- `package:metamorph_almira/almira.dart` is the mobile-safe capability client. It provides all
  metadata, search, immutable-generation, derivative and share reads as byte streams. Rotating
  capabilities resolve per attempt and share reads forward no credential.
- `package:metamorph_almira/almira_server.dart` is a separate opt-in server library for trusted
  Dart processes. It provides short-lived workload exchange, upload ceremonies, builder-subject
  lifecycle operations and APP-01 webhook verification.

Neither library contains management operations. Run `dart test sdks/dart` from the repository
root.
