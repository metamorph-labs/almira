import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';
import 'dart:io';

import 'package:metamorph_almira/almira.dart';
import 'package:metamorph_almira/almira_server.dart';
import 'package:test/test.dart';

const tenant = '018f0000-0000-7000-8000-000000000002';
const project = '018f0000-0000-7000-8000-000000000003';
const environment = '018f0000-0000-7000-8000-000000000004';
const collection = '018f0000-0000-7000-8000-000000000005';
const operation = '018f0000-0000-7000-8000-000000000008';
const capability = 'alm_cap_v1.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

class RecordingTransport implements AlmiraTransport {
  final calls = <({
    String method,
    Uri url,
    Map<String, String> headers,
    Uint8List? body
  })>[];
  @override
  Future<WireResponse> send(String method, Uri url, Map<String, String> headers,
      Uint8List? body) async {
    calls.add((method: method, url: url, headers: Map.of(headers), body: body));
    final share = url.path.contains('/shares/');
    final upload = url.path.contains('/uploads');
    return WireResponse(
        status: upload ? 201 : 200,
        headers: {
          'content-type':
              share ? 'application/octet-stream' : 'application/json'
        },
        body: Stream.value(utf8.encode(share ? 'hello' : '{}')));
  }
}

class UploadRecorder implements DirectUploadTransport {
  @override
  Future<UploadResponse> put(Map<String, Object?> part, File source) async =>
      const UploadResponse(200, {'etag': '"v1"'});
}

class JourneyTransport implements AlmiraTransport {
  JourneyTransport(this.responses);
  final List<({int status, Object body, Map<String, String> headers})>
      responses;
  final authorities = <String?>[];
  @override
  Future<WireResponse> send(String method, Uri url, Map<String, String> headers,
      Uint8List? body) async {
    authorities.add(headers['authorization']);
    final response = responses.removeAt(0);
    return WireResponse(
        status: response.status,
        headers: {'content-type': 'application/json', ...response.headers},
        body: Stream.value(utf8.encode(jsonEncode(response.body))));
  }
}

void main() {
  test('data client scopes capability and keeps shares anonymous', () async {
    expect(
        () => AlmiraDataClient(
            baseUrl: 'https://almira.test',
            capability: () => capability,
            origin: 'https://app.example/'),
        throwsA(isA<AlmiraClientException>()));
    final transport = RecordingTransport();
    final reference = CollectionReference(
        tenantId: tenant,
        projectId: project,
        environmentId: environment,
        collectionInstanceId: collection);
    final client = AlmiraDataClient(
        baseUrl: 'https://almira.test',
        capability: () => capability,
        origin: 'https://app.example',
        transport: transport);
    await client.listFilesWithCapability(reference, filters: {'limit': 25});
    await client
        .readShare('alm_share_v1.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    expect(
        () => client.readShare(
            'alm_share_v1.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            range: 'bytes=unsafe'),
        throwsA(isA<AlmiraClientException>()));
    expect(transport.calls[0].headers['authorization'], 'Bearer $capability');
    expect(transport.calls[1].headers['authorization'], isNull);
  });
  test('server client uses workload evidence', () async {
    final transport = RecordingTransport();
    final reference = CollectionReference(
        tenantId: tenant,
        projectId: project,
        environmentId: environment,
        collectionInstanceId: collection);
    final client = AlmiraServerClient(
        baseUrl: 'https://almira.test',
        workloadSession: () => 'workload_evidence',
        transport: transport);
    await client.createUpload(reference, {'path': 'avatar.png'}, operation);
    expect(transport.calls.single.headers['authorization'],
        'MetamorphWorkload workload_evidence');
    expect(contractVersion, '0.1.0-dev.59');
  });
  test('direct transfer returns only finalize evidence', () async {
    final directory = await Directory.systemTemp.createTemp('almira-test');
    final source = File('${directory.path}/source.bin');
    await source.writeAsString('hello');
    try {
      final result = await uploadDirect({
        'descriptor_id': operation,
        'protocol': 'single_put',
        'expected_size_bytes': 5,
        'content_sha256':
            'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
        'one_use': true,
        'expires_at': '2099-01-01T00:00:00.000000Z',
        'part_size_bytes': null,
        'part_count': 1,
        'requests': [
          {
            'part_number': 1,
            'offset_bytes': 0,
            'length_bytes': 5,
            'method': 'PUT',
            'url': 'https://storage.test/secret',
            'headers': <Object?>[],
            'one_use': true
          },
        ],
      }, source, transport: UploadRecorder());
      expect(result['etag'], '"v1"');
      expect(jsonEncode(result), isNot(contains('storage.test')));
    } finally {
      await directory.delete(recursive: true);
    }
  });
  test('verifies the common webhook vector and rejects tampering', () {
    final headers = {
      'metamorph-webhook-delivery-id': '018f0000-0000-7000-8000-000000000011',
      'metamorph-webhook-event-id': '018f0000-0000-7000-8000-000000000012',
      'metamorph-webhook-attempt': '2',
      'metamorph-webhook-timestamp': '2026-10-17T12:00:00.000000Z',
      'metamorph-webhook-signature':
          'v1=PHaG4k_rjkr4itoseS10o0_znK6FR9aoArs7pPV2klI',
    };
    final verified = verifyWebhookSignature(
        secret: utf8.encode('topsecret'),
        body: utf8.encode('{"event":"almira.file.available.v1"}'),
        headers: headers,
        now: DateTime.parse('2026-10-17T12:00:30Z'));
    expect(verified?.attempt, 2);
    headers['metamorph-webhook-signature'] =
        'v1=AHaG4k_rjkr4itoseS10o0_znK6FR9aoArs7pPV2klI';
    expect(
        verifyWebhookSignature(
            secret: utf8.encode('topsecret'),
            body: utf8.encode('{"event":"almira.file.available.v1"}'),
            headers: headers,
            now: DateTime.parse('2026-10-17T12:00:30Z')),
        isNull);
  });
  test('verifies common behavior receipt and rejects substitution', () async {
    final common = jsonDecode(
        await File('../../conformance/application-sdk.v1.json')
            .readAsString()) as Map<String, Object?>;
    final vector = common['behavior_receipt'] as Map<String, Object?>;
    final signed = vector['signed'] as Map<String, Object?>;
    final keySet = vector['key_set'] as Map<String, Object?>;
    final expected = vector['expected'] as Map<String, Object?>;
    expect(await verifyVerificationReceipt(signed, keySet, expected: expected),
        isTrue);
    final substituted = Map<String, Object?>.of(expected)
      ..addAll(vector['substitution'] as Map<String, Object?>);
    expect(
        await verifyVerificationReceipt(signed, keySet, expected: substituted),
        isFalse);
    final tampered = jsonDecode(jsonEncode(signed)) as Map<String, Object?>;
    (tampered['receipt'] as Map<String, Object?>)['generation_id'] =
        substituted['generation_id'];
    expect(await verifyVerificationReceipt(tampered, keySet), isFalse);
  });
  test('common managed-development positive refusal retry and cleanup journey',
      () async {
    final common = jsonDecode(
        await File('../../conformance/application-sdk.v1.json')
            .readAsString()) as Map<String, Object?>;
    final journey = common['managed_development'] as Map<String, Object?>;
    final ids = journey['reference'] as Map<String, Object?>;
    final positive = journey['positive'] as Map<String, Object?>;
    final refusal = journey['refusal'] as Map<String, Object?>;
    final retry = journey['retry'] as Map<String, Object?>;
    final reference = FileReference(
        tenantId: ids['tenant_id'] as String,
        projectId: ids['project_id'] as String,
        environmentId: ids['environment_id'] as String,
        collectionInstanceId: ids['collection_instance_id'] as String,
        entryId: ids['entry_id'] as String);
    final positiveTransport = JourneyTransport(
        [(status: 200, body: positive['response']!, headers: const {})]);
    final positiveClient = AlmiraDataClient(
        baseUrl: journey['base_url'] as String,
        capability: () => positive['capability'] as String,
        origin: journey['origin'] as String,
        transport: positiveTransport);
    final entry = await positiveClient.getFileMetadataWithCapability(reference)
        as Map<String, Object?>;
    expect(entry['entry_id'], ids['entry_id']);
    expect(positiveTransport.authorities, ['Bearer ${positive['capability']}']);

    final refusalTransport = JourneyTransport(
        [(status: 200, body: positive['response']!, headers: const {})]);
    final refused = AlmiraDataClient(
        baseUrl: journey['base_url'] as String,
        capability: () => refusal['credential'] as String,
        transport: refusalTransport);
    await expectLater(
        refused.getFileMetadataWithCapability(reference),
        throwsA(isA<AlmiraClientException>()
            .having((error) => error.code, 'code', refusal['client_code'])));
    expect(refusalTransport.authorities, isEmpty);

    final capabilities =
        (retry['capabilities'] as List<Object?>).cast<String>();
    var capabilityAttempt = 0;
    final retryTransport = JourneyTransport([
      (
        status: retry['first_status'] as int,
        body: retry['first_error']!,
        headers: {'retry-after': '${retry['retry_after_seconds']}'}
      ),
      (
        status: retry['final_status'] as int,
        body: positive['response']!,
        headers: const {}
      )
    ]);
    final retrying = AlmiraDataClient(
        baseUrl: journey['base_url'] as String,
        capability: () => capabilities[capabilityAttempt++],
        transport: retryTransport,
        retry: const RetryPolicy(
            maxAttempts: 2,
            baseDelay: Duration.zero,
            maximumDelay: Duration.zero));
    final retried = await retrying.getFileMetadataWithCapability(reference)
        as Map<String, Object?>;
    expect(retried['entry_id'], ids['entry_id']);
    expect(retryTransport.authorities,
        capabilities.map((value) => 'Bearer $value').toList());
    expect(journey['cleanup'],
        {'applicable': false, 'reason': 'read_only_journey'});
  });
}
