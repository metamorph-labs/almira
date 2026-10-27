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
}
