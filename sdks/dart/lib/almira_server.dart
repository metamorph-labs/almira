library;

import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';

import 'almira.dart';

typedef WorkloadSessionProvider = FutureOr<String> Function();

class AlmiraServerClient {
  AlmiraServerClient(
      {required String baseUrl,
      required WorkloadSessionProvider workloadSession,
      AlmiraTransport? transport})
      : _baseUrl = _serverBaseUri(baseUrl),
        _workloadSession = workloadSession,
        _transport = transport ?? IoTransport();
  final Uri _baseUrl;
  final WorkloadSessionProvider _workloadSession;
  final AlmiraTransport _transport;

  Future<Object?> createCapabilitySession(CollectionReference reference,
          Map<String, Object?> request, String operationId) =>
      _request('POST', _collection(reference, '/capability-sessions'),
          reference.tenantId, operationId, request, {201});
  Future<Object?> createUpload(CollectionReference reference,
          Map<String, Object?> request, String operationId) =>
      _request('POST', _collection(reference, '/uploads'), reference.tenantId,
          operationId, request, {201});
  Future<Object?> createUploadPart(
          CollectionReference reference,
          String transferSessionId,
          Map<String, Object?> request,
          String operationId) =>
      _request(
          'POST',
          _collection(
              reference, '/uploads/${_serverUuid(transferSessionId)}/parts'),
          reference.tenantId,
          operationId,
          request,
          {201});
  Future<Object?> finalizeUpload(
          CollectionReference reference,
          String transferSessionId,
          Map<String, Object?> request,
          String operationId) =>
      _request(
          'POST',
          _collection(
              reference, '/uploads/${_serverUuid(transferSessionId)}/finalize'),
          reference.tenantId,
          operationId,
          request,
          {200});
  Future<Object?> bindSubject(CollectionReference reference, String entryId,
          Map<String, Object?> subject, String operationId) =>
      _request(
          'POST',
          _collection(
              reference, '/files/${_serverUuid(entryId)}/subject-bindings'),
          reference.tenantId,
          operationId,
          subject,
          {201});
  Future<Object?> listSubjectBindings(
          ProjectReference reference, Map<String, Object?> request) =>
      _request(
          'POST',
          '/v1/projects/${_serverUuid(reference.projectId)}/subject-bindings/search',
          reference.tenantId,
          null,
          request,
          {200});
  Future<Object?> startSubjectLifecycleOperation(ProjectReference reference,
          Map<String, Object?> request, String operationId) =>
      _request(
          'POST',
          '/v1/projects/${_serverUuid(reference.projectId)}/subject-lifecycle-operations',
          reference.tenantId,
          operationId,
          request,
          {201, 202});
  Future<Object?> readSubjectLifecycleOperation(
          ProjectReference reference, Map<String, Object?> request) =>
      _request(
          'POST',
          '/v1/projects/${_serverUuid(reference.projectId)}/subject-lifecycle-operations/search',
          reference.tenantId,
          null,
          request,
          {200});
  Future<Object?> createSubjectExportDownload(
          ProjectReference reference,
          String lifecycleOperationId,
          Map<String, Object?> request,
          String operationId) =>
      _request(
          'POST',
          '/v1/projects/${_serverUuid(reference.projectId)}/subject-lifecycle-operations/${_serverUuid(lifecycleOperationId)}/download',
          reference.tenantId,
          operationId,
          request,
          {201});
  Future<String> revokeCapabilitySession(CollectionReference reference,
      String sessionId, String operationId) async {
    final value = await _request(
        'DELETE',
        _collection(
            reference, '/capability-sessions/${_serverUuid(sessionId)}'),
        reference.tenantId,
        operationId,
        null,
        {200});
    if (value is! String || !['applied', 'exact_replay'].contains(value)) {
      throw const AlmiraClientException('ALMIRA_CLIENT_RESPONSE_INVALID');
    }
    return value;
  }

  Future<Object?> _request(
      String method,
      String path,
      String tenantId,
      String? operationId,
      Map<String, Object?>? body,
      Set<int> statuses) async {
    _serverUuid(tenantId);
    if (operationId != null) _serverUuid(operationId);
    String evidence;
    try {
      evidence = await _workloadSession();
    } catch (_) {
      throw const AlmiraClientException('ALMIRA_CLIENT_CREDENTIAL_UNAVAILABLE');
    }
    if (evidence.length < 2 ||
        evidence.length > 49152 ||
        !RegExp(r'^[A-Za-z0-9_-]+$').hasMatch(evidence)) {
      throw const AlmiraClientException('ALMIRA_CLIENT_INPUT_INVALID');
    }
    final headers = <String, String>{
      'accept': 'application/json',
      'authorization': 'MetamorphWorkload $evidence',
      'x-almira-tenant-id': tenantId
    };
    if (operationId != null) headers['idempotency-key'] = operationId;
    final encoded =
        body == null ? null : Uint8List.fromList(utf8.encode(jsonEncode(body)));
    if (encoded != null) headers['content-type'] = 'application/json';
    WireResponse response;
    try {
      response = await _transport.send(
          method,
          _baseUrl.resolve(path.replaceFirst(RegExp(r'^/'), '')),
          headers,
          encoded);
    } catch (_) {
      throw const AlmiraClientException('ALMIRA_CLIENT_NETWORK');
    }
    if (!statuses.contains(response.status)) throw await apiError(response);
    if ((response.headers['content-type'] ?? '').split(';').first.trim() !=
        'application/json') {
      throw const AlmiraClientException('ALMIRA_CLIENT_RESPONSE_INVALID');
    }
    try {
      return jsonDecode(
          utf8.decode(await collect(response.body, 2 * 1024 * 1024)));
    } catch (_) {
      throw const AlmiraClientException('ALMIRA_CLIENT_RESPONSE_INVALID');
    }
  }

  String _collection(CollectionReference reference, String suffix) =>
      '/v1/projects/${_serverUuid(reference.projectId)}/environments/${_serverUuid(reference.environmentId)}/collections/${_serverUuid(reference.collectionInstanceId)}$suffix';
}

class VerifiedWebhook {
  const VerifiedWebhook(
      this.deliveryId, this.eventId, this.attempt, this.timestamp);
  final String deliveryId;
  final String eventId;
  final int attempt;
  final String timestamp;
}

VerifiedWebhook? verifyWebhookSignature(
    {required List<int> secret,
    required List<int> body,
    required Map<String, String> headers,
    DateTime? now,
    Duration tolerance = const Duration(minutes: 5)}) {
  if (secret.isEmpty || body.length > 272 * 1024 || tolerance.isNegative) {
    return null;
  }
  String? header(String name) {
    final values = headers.entries
        .where((entry) => entry.key.toLowerCase() == name)
        .map((entry) => entry.value)
        .toList();
    return values.length == 1 && !values.single.contains(',')
        ? values.single
        : null;
  }

  final delivery = header('metamorph-webhook-delivery-id');
  final eventId = header('metamorph-webhook-event-id');
  final attemptValue = header('metamorph-webhook-attempt');
  final timestamp = header('metamorph-webhook-timestamp');
  final signature = header('metamorph-webhook-signature');
  if (delivery == null ||
      eventId == null ||
      attemptValue == null ||
      timestamp == null ||
      signature == null ||
      !RegExp(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$')
          .hasMatch(timestamp) ||
      !RegExp(r'^v1=[A-Za-z0-9_-]{43}$').hasMatch(signature)) {
    return null;
  }
  try {
    _serverUuid(delivery);
    _serverUuid(eventId);
  } catch (_) {
    return null;
  }
  final attempt = int.tryParse(attemptValue);
  final occurred = DateTime.tryParse(timestamp);
  if (attempt == null ||
      attempt < 1 ||
      attempt > 8 ||
      occurred == null ||
      (now ?? DateTime.now().toUtc()).difference(occurred).abs() > tolerance) {
    return null;
  }
  final bodyDigest = 'sha256:${sha256.convert(body)}';
  final transcript = [
    'metamorph-webhook-v1',
    delivery,
    eventId,
    attemptValue,
    timestamp,
    bodyDigest
  ].join('\n');
  final expected = base64Url
      .encode(Hmac(sha256, secret).convert(utf8.encode(transcript)).bytes)
      .replaceAll('=', '');
  final actual = signature.substring(3);
  var mismatch = expected.length ^ actual.length;
  for (var index = 0;
      index < expected.length && index < actual.length;
      index++) {
    mismatch |= expected.codeUnitAt(index) ^ actual.codeUnitAt(index);
  }
  return mismatch == 0
      ? VerifiedWebhook(delivery, eventId, attempt, timestamp)
      : null;
}

String _serverUuid(String value) {
  if (!RegExp(
          r'^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
      .hasMatch(value)) {
    throw const AlmiraClientException('ALMIRA_CLIENT_INPUT_INVALID');
  }
  return value;
}

Uri _serverBaseUri(String value) {
  final uri = Uri.tryParse(value);
  if (uri == null ||
      (uri.scheme != 'http' && uri.scheme != 'https') ||
      uri.host.isEmpty ||
      uri.userInfo.isNotEmpty ||
      uri.hasQuery ||
      uri.hasFragment ||
      (uri.path.isNotEmpty && uri.path != '/')) {
    throw const AlmiraClientException('ALMIRA_CLIENT_INPUT_INVALID');
  }
  return uri.replace(path: '/');
}
